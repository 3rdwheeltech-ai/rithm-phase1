#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["httpx>=0.27"]
# ///
"""
RITHM load test — the parent plan's "10 concurrent generations", as a script.

    uv run ops/scripts/load-test.py \
      --base-url https://d4s6mh5qrrnql.cloudfront.net \
      --email you@example.com --password '...' \
      --n 10 --check-queues

    # measure the known rate-limit race instead (use a THROWAWAY account):
    uv run ops/scripts/load-test.py --base-url ... --email ... --password ... \
      --probe-rate-limit

Dependencies are declared inline (PEP 723) and resolved by `uv run`. A load-test
dependency has no business in the API's or worker's dependency graph, and this way the
script stays runnable from a clean checkout with nothing installed.

WHAT IT ASSERTS (non-zero exit on any failure)

  1. Every job reaches a terminal state inside the deadline.
  2. GET /tracks total delta == number of completions.  <- this is Gate C6, the
     duplicate-track check, in production shape and under real concurrency. A
     worker that claims a job twice shows up here and essentially nowhere else.
  3. Every track_id is distinct and each job_id maps to exactly one track.
  4. With --check-queues, both DLQ depths are unchanged across the run.

WHAT TO EXPECT

  Serialization, not parallelism. One always-on GPU serves one job at a time and the
  worker long-polls with MaxMessages=1, so ten 30-second jobs at ~15s each finish over
  roughly 150s, with the last user waiting longest. That TAIL number is the real
  answer to "is the wait acceptable", and it is what stuck_queued_seconds must clear.

RATE LIMIT ARITHMETIC

  20 per rolling 24h per user (api/app/config.py:69), counted over
  QUEUED|RUNNING|COMPLETED. So: two 10-job runs per user per day. The script prints the
  remaining budget after each run so the second one is not a surprise.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import statistics
import subprocess
import sys
import time
from dataclasses import dataclass, field
from typing import Any

import httpx

DLQ_NAMES = ("rithm-generation-jobs-dlq", "rithm-sns-completions-dlq")
TERMINAL = {"completed", "failed"}

# The server emits keepalives as a NAMED event (`event: keepalive`), not an SSE comment.
# Day 4 changed this deliberately: comments fire no JavaScript event, so an EventSource
# client cannot tell "the queue is quiet" from "this stream is dead". Older builds used
# `: keepalive`; both are ignored here so the script works against either.
IGNORED_EVENTS = {"keepalive", "ping"}


# --------------------------------------------------------------------------- results


@dataclass
class JobRun:
    index: int
    job_id: str | None = None
    submitted_at: float = 0.0
    first_running_at: float | None = None
    terminal_at: float | None = None
    terminal_event: str | None = None
    track_id: str | None = None
    error: str | None = None
    events: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return self.terminal_event == "completed"

    @property
    def wait_seconds(self) -> float | None:
        """Submit -> first `running` frame. How long the user stared at a queue."""
        if self.first_running_at is None:
            return None
        return self.first_running_at - self.submitted_at

    @property
    def render_seconds(self) -> float | None:
        """First `running` -> terminal. How long the GPU actually took."""
        if self.first_running_at is None or self.terminal_at is None:
            return None
        return self.terminal_at - self.first_running_at

    @property
    def total_seconds(self) -> float | None:
        if self.terminal_at is None:
            return None
        return self.terminal_at - self.submitted_at


def pct(values: list[float], p: float) -> float:
    """Nearest-rank percentile. n is 10, so interpolation would be false precision."""
    if not values:
        return float("nan")
    ordered = sorted(values)
    k = max(0, min(len(ordered) - 1, int(round(p / 100.0 * len(ordered) + 0.5)) - 1))
    return ordered[k]


# ------------------------------------------------------------------------------- api


class Rithm:
    def __init__(self, base_url: str, verify: bool = True) -> None:
        self.base_url = base_url.rstrip("/")
        self.token: str | None = None
        self._client = httpx.AsyncClient(
            base_url=self.base_url,
            # Generous connect/write, bounded read. Every non-SSE call here is fast; a
            # slow one means CloudFront or the ALB is the problem, not the GPU.
            timeout=httpx.Timeout(connect=10.0, read=30.0, write=10.0, pool=10.0),
            verify=verify,
            follow_redirects=True,
        )

    async def __aenter__(self) -> Rithm:
        return self

    async def __aexit__(self, *_: object) -> None:
        await self._client.aclose()

    @property
    def auth(self) -> dict[str, str]:
        if not self.token:
            raise RuntimeError("not logged in")
        return {"Authorization": f"Bearer {self.token}"}

    async def login(self, email: str, password: str) -> None:
        r = await self._client.post(
            "/api/v1/auth/login", json={"email": email, "password": password}
        )
        if r.status_code != 200:
            raise SystemExit(f"login failed: {r.status_code} {r.text[:400]}")
        self.token = r.json()["id_token"]

    async def track_total(self) -> int:
        """X-Total-Count is every non-deleted track the user owns, not the page size."""
        r = await self._client.get(
            "/api/v1/tracks", headers=self.auth, params={"limit": 1}
        )
        r.raise_for_status()
        return int(r.headers.get("X-Total-Count", "0"))

    async def all_track_ids(self) -> set[str]:
        ids: set[str] = set()
        cursor: str | None = None
        while True:
            params: dict[str, Any] = {"limit": 100}
            if cursor:
                params["cursor"] = cursor
            r = await self._client.get(
                "/api/v1/tracks", headers=self.auth, params=params
            )
            r.raise_for_status()
            ids.update(t["id"] for t in r.json())
            cursor = r.headers.get("X-Next-Cursor")
            if not cursor:
                return ids

    async def generate(self, payload: dict[str, Any]) -> httpx.Response:
        return await self._client.post(
            "/api/v1/tracks/generate", headers=self.auth, json=payload
        )

    async def job_status(self, job_id: str) -> dict[str, Any] | None:
        r = await self._client.get(f"/api/v1/jobs/{job_id}", headers=self.auth)
        return r.json() if r.status_code == 200 else None

    async def consume_sse(self, run: JobRun, sse_url: str, deadline: float) -> None:
        """
        Follow one job's SSE stream to a terminal frame.

        The server replays current state from generation.jobs on connect, so a single
        pass is enough: even if the job finished before this connects, the first frame
        carries the terminal state.
        """
        url = sse_url if sse_url.startswith("http") else f"{self.base_url}{sse_url}"
        event: str | None = None

        # read=None: a healthy stream can be silent between keepalives, and a read
        # timeout here would look exactly like a stalled job. The overall deadline is
        # enforced by the caller instead, where it can be reported properly.
        timeout = httpx.Timeout(connect=10.0, read=None, write=10.0, pool=10.0)
        headers = {**self.auth, "Accept": "text/event-stream"}

        async with self._client.stream(
            "GET", url, headers=headers, timeout=timeout
        ) as resp:
            if resp.status_code != 200:
                body = (await resp.aread()).decode(errors="replace")[:300]
                run.error = f"SSE {resp.status_code}: {body}"
                run.terminal_event = "failed"
                run.terminal_at = time.monotonic()
                return

            async for raw in resp.aiter_lines():
                if time.monotonic() > deadline:
                    run.error = "deadline exceeded while streaming"
                    return

                line = raw.rstrip("\r")
                if not line or line.startswith(":"):
                    continue  # blank separator, or a legacy `: keepalive` comment
                if line.startswith("event:"):
                    event = line[6:].strip()
                    continue
                if not line.startswith("data:"):
                    continue

                name = event or "message"
                event = None
                if name in IGNORED_EVENTS:
                    continue

                try:
                    data = json.loads(line[5:].strip())
                except json.JSONDecodeError:
                    continue

                run.events.append(name)
                now = time.monotonic()

                if name == "running" and run.first_running_at is None:
                    run.first_running_at = now
                elif name in TERMINAL:
                    run.terminal_event = name
                    run.terminal_at = now
                    run.track_id = data.get("track_id")
                    run.error = data.get("error")
                    # A terminal replay frame can arrive without ever showing `running`
                    # (service.py:_job_to_event replays state, it does not replay
                    # history). Attribute the whole span to render rather than leaving
                    # the percentile buckets with a hole in them.
                    if run.first_running_at is None:
                        run.first_running_at = run.submitted_at
                    return


# ------------------------------------------------------------------------------ sqs


def dlq_depths() -> dict[str, int]:
    """Read DLQ depths via the aws CLI — no boto3 dependency for two numbers."""
    region = os.environ.get("AWS_REGION", "us-east-1")
    account = os.environ.get("AWS_ACCOUNT_ID", "685448855132")
    out: dict[str, int] = {}
    for name in DLQ_NAMES:
        try:
            depth = subprocess.run(
                [
                    "aws",
                    "sqs",
                    "get-queue-attributes",
                    "--queue-url",
                    f"https://sqs.{region}.amazonaws.com/{account}/{name}",
                    "--attribute-names",
                    "ApproximateNumberOfMessages",
                    "--query",
                    "Attributes.ApproximateNumberOfMessages",
                    "--output",
                    "text",
                ],
                capture_output=True,
                text=True,
                check=True,
                timeout=30,
            ).stdout.strip()
            out[name] = int(depth)
        except (subprocess.SubprocessError, ValueError) as exc:
            print(f"  WARN: could not read {name}: {exc}", file=sys.stderr)
    return out


# ----------------------------------------------------------------------- the load run


async def run_load(args: argparse.Namespace) -> int:
    payload = {
        "prompt": args.prompt,
        "genre": args.genre,
        "mood": args.mood,
        "bpm_min": args.bpm_min,
        "bpm_max": args.bpm_max,
        "instruments": [],
        "vocal": False,
        "length_seconds": args.length,
    }

    async with Rithm(args.base_url) as api:
        await api.login(args.email, args.password)
        print(f"logged in as {args.email}")

        before_total = await api.track_total()
        before_ids = await api.all_track_ids()
        before_dlq = dlq_depths() if args.check_queues else {}
        print(f"tracks before : {before_total}")
        if before_dlq:
            print(f"DLQ before    : {before_dlq}")
        print(f"firing        : {args.n} concurrent x {args.length}s\n")

        runs = [JobRun(index=i) for i in range(args.n)]
        t0 = time.monotonic()

        async def submit(run: JobRun) -> None:
            run.submitted_at = time.monotonic()
            r = await api.generate(payload)
            if r.status_code == 429:
                body = r.json()
                run.error = (
                    f"429 rate limited (used={body.get('used')} "
                    f"limit={body.get('limit')} "
                    f"retry_after={body.get('retry_after_seconds')}s)"
                )
                run.terminal_event = "rate_limited"
                run.terminal_at = time.monotonic()
                return
            if r.status_code != 202:
                run.error = f"submit {r.status_code}: {r.text[:300]}"
                run.terminal_event = "submit_failed"
                run.terminal_at = time.monotonic()
                return
            body = r.json()
            run.job_id = body["job_id"]
            run._sse_url = body["sse_url"]  # type: ignore[attr-defined]

        await asyncio.gather(*(submit(r) for r in runs))

        accepted = [r for r in runs if r.job_id]
        print(f"accepted      : {len(accepted)}/{args.n}")
        for r in runs:
            if not r.job_id:
                print(f"  job {r.index}: {r.error}")
        if not accepted:
            print("\nFAIL: nothing was accepted.")
            return 1

        deadline = t0 + args.deadline

        async def follow(run: JobRun) -> None:
            try:
                await asyncio.wait_for(
                    api.consume_sse(run, run._sse_url, deadline),  # type: ignore[attr-defined]
                    timeout=max(1.0, deadline - time.monotonic()),
                )
            except TimeoutError:
                run.error = run.error or f"no terminal event within {args.deadline}s"
            except httpx.HTTPError as exc:
                run.error = run.error or f"stream error: {type(exc).__name__}: {exc}"

        await asyncio.gather(*(follow(r) for r in accepted))

        # A stream can drop while the job itself succeeds — exactly the deploy race
        # useJobStream falls back to polling for. Reconcile against the DB before
        # calling anything a failure, or the test reports a client bug as a server one.
        for run in accepted:
            if run.terminal_event is None and run.job_id:
                status = await api.job_status(run.job_id)
                if status and status.get("status") in {"COMPLETED", "FAILED"}:
                    run.terminal_event = status["status"].lower()
                    run.terminal_at = time.monotonic()
                    run.track_id = status.get("track_id")
                    run.error = status.get("error")
                    run.events.append("(recovered by poll)")

        wall = time.monotonic() - t0
        after_total = await api.track_total()
        after_ids = await api.all_track_ids()
        after_dlq = dlq_depths() if args.check_queues else {}

    return report(
        runs,
        accepted,
        before_total,
        after_total,
        before_ids,
        after_ids,
        before_dlq,
        after_dlq,
        wall,
        args,
    )


def report(
    runs: list[JobRun],
    accepted: list[JobRun],
    before_total: int,
    after_total: int,
    before_ids: set[str],
    after_ids: set[str],
    before_dlq: dict[str, int],
    after_dlq: dict[str, int],
    wall: float,
    args: argparse.Namespace,
) -> int:
    print("\n--- per job " + "-" * 56)
    for r in sorted(runs, key=lambda x: x.total_seconds or 1e9):
        wait = f"{r.wait_seconds:6.1f}" if r.wait_seconds is not None else "     -"
        render = (
            f"{r.render_seconds:6.1f}" if r.render_seconds is not None else "     -"
        )
        total = f"{r.total_seconds:6.1f}" if r.total_seconds is not None else "     -"
        state = r.terminal_event or "NO TERMINAL EVENT"
        print(
            f"  #{r.index:<3} wait {wait}s  render {render}s  total {total}s  {state}"
        )
        if r.error:
            print(f"        {r.error}")

    completed = [r for r in accepted if r.ok]
    waits = [r.wait_seconds for r in completed if r.wait_seconds is not None]
    renders = [r.render_seconds for r in completed if r.render_seconds is not None]
    totals = [r.total_seconds for r in completed if r.total_seconds is not None]

    print("\n--- latency " + "-" * 56)
    if totals:
        for label, vals in (
            ("queued->running", waits),
            ("running->done  ", renders),
            ("end to end     ", totals),
        ):
            if vals:
                print(
                    f"  {label}  p50 {pct(vals, 50):6.1f}s   "
                    f"p95 {pct(vals, 95):6.1f}s   max {max(vals):6.1f}s"
                )
        print(f"  median {statistics.median(totals):.1f}s   wall clock {wall:.1f}s")
        print(
            f"\n  TAIL: the last user waited {max(totals):.1f}s. That is the "
            f"number\n        that sets Day-6 expectations, and it must clear "
            f"stuck_queued_seconds."
        )
    else:
        print("  no completions to measure")

    new_ids = after_ids - before_ids
    reported = {r.track_id for r in completed if r.track_id}

    print("\n--- assertions " + "-" * 53)
    failures: list[str] = []

    def check(ok: bool, label: str, detail: str) -> None:
        print(f"  [{'PASS' if ok else 'FAIL'}] {label}: {detail}")
        if not ok:
            failures.append(label)

    stuck = [r for r in accepted if r.terminal_event is None]
    check(
        not stuck,
        "all jobs terminal",
        "all reached a terminal state"
        if not stuck
        else f"{len(stuck)} never did: {[r.job_id for r in stuck]}",
    )

    delta = after_total - before_total
    check(
        delta == len(completed),
        "no duplicate tracks (C6)",
        f"{len(completed)} completions -> {delta} new tracks"
        + (
            ""
            if delta == len(completed)
            else "  <-- EXTRA TRACKS: a job was claimed twice"
        ),
    )

    check(
        len(new_ids) == len(completed),
        "distinct track ids",
        f"{len(new_ids)} distinct new ids for {len(completed)} completions",
    )

    if reported:
        check(
            reported <= after_ids,
            "every reported track is listable",
            f"{len(reported)} track_ids from SSE, all present in GET /tracks"
            if reported <= after_ids
            else f"missing from catalog: {sorted(reported - after_ids)}",
        )

    if before_dlq and after_dlq:
        grew = {
            k: (before_dlq.get(k), after_dlq.get(k))
            for k in before_dlq
            if after_dlq.get(k, 0) > before_dlq.get(k, 0)
        }
        check(
            not grew, "DLQs unchanged", f"{after_dlq}" if not grew else f"GREW: {grew}"
        )

    failed = [r for r in accepted if r.terminal_event == "failed"]
    if failed:
        print(
            f"\n  NOTE: {len(failed)} job(s) reported `failed` by the server. Not "
            "counted as a\n        harness failure — the pipeline worked, the "
            "generation did not:"
        )
        for r in failed:
            print(f"          {r.job_id}: {r.error}")

    used = len(accepted)
    print(
        f"\n  rate-limit budget: this run used {used} of {args.rate_limit} per 24h. "
        f"~{max(0, args.rate_limit - used) // max(1, args.n)} more run(s) of this "
        f"size today."
    )

    print()
    if failures:
        print(f"FAIL — {len(failures)} assertion(s): {', '.join(failures)}")
        return 1
    print("PASS — every assertion green.")
    return 0


# ------------------------------------------------------------- the rate-limit probe


async def probe_rate_limit(args: argparse.Namespace) -> int:
    """
    Measure the known rate-limit race rather than assuming its size.

    api/app/modules/generation/service.py:278-285 documents it: the limit is enforced
    inside the INSERT (`INSERT ... SELECT ... WHERE (SELECT count(*) ...) < :limit`), so
    there is no count-then-insert gap — but under READ COMMITTED two concurrent
    transactions can both observe 19 and both commit. A concurrent burst is exactly the
    shape that trips it. The fix (pg_advisory_xact_lock) is deferred to Phase 2; this
    turns "a known race" into a number you can decide about.

    Use a THROWAWAY account. This deliberately exhausts its 24h budget.
    """
    n = args.rate_limit + args.overshoot
    print(
        f"probing with {n} concurrent submissions against a limit of {args.rate_limit}"
    )
    print("(use a throwaway account — this burns its whole 24h budget)\n")

    payload = {
        "prompt": args.prompt,
        "genre": None,
        "mood": None,
        "bpm_min": None,
        "bpm_max": None,
        "instruments": [],
        "vocal": False,
        "length_seconds": 10,
    }

    async with Rithm(args.base_url) as api:
        await api.login(args.email, args.password)
        before = await api.track_total()
        print(f"tracks before: {before}")

        results: list[httpx.Response] = await asyncio.gather(
            *(api.generate(payload) for _ in range(n))
        )

    accepted = [r for r in results if r.status_code == 202]
    limited = [r for r in results if r.status_code == 429]
    other = [r for r in results if r.status_code not in (202, 429)]

    print(f"\n  202 accepted : {len(accepted)}")
    print(f"  429 limited  : {len(limited)}")
    if other:
        print(f"  unexpected   : {[(r.status_code, r.text[:120]) for r in other]}")

    failures: list[str] = []
    if not limited:
        failures.append("no 429 was ever returned — the limiter did not engage")
    else:
        sample = limited[0]
        body = sample.json()
        retry_after = sample.headers.get("Retry-After")
        print(f"\n  Retry-After header : {retry_after}")
        print(f"  problem type       : {body.get('type')}")
        print(f"  detail             : {body.get('detail')}")
        print(
            f"  extras             : used={body.get('used')} limit={body.get('limit')} "
            f"retry_after_seconds={body.get('retry_after_seconds')}"
        )

        if not retry_after:
            failures.append("429 carried no Retry-After header")
        for key in ("retry_after_seconds", "used", "limit"):
            if not isinstance(body.get(key), int):
                failures.append(f"429 body: {key} is not an integer")

    overshoot = len(accepted) - args.rate_limit
    print(f"\n  OVERSHOOT: {overshoot} request(s) past the limit of {args.rate_limit}.")
    if overshoot > 0:
        print(
            "  This is the measured size of the documented READ COMMITTED race\n"
            "  (service.py:278-285). Record it in the launch notes as a number.\n"
            "  >1 means pg_advisory_xact_lock should move up the Phase-2 list."
        )
    else:
        print("  The limiter held exactly under a concurrent burst.")

    print()
    if failures:
        for f in failures:
            print(f"FAIL: {f}")
        return 1
    print("PASS — the limiter engaged with a well-formed 429.")
    return 0


# ------------------------------------------------------------------------------ main


def main() -> int:
    p = argparse.ArgumentParser(
        description="RITHM concurrent generation load test",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    p.add_argument(
        "--base-url",
        required=True,
        help="e.g. https://d4s6mh5qrrnql.cloudfront.net — use the CloudFront "
        "URL, not the ALB, so the test exercises the path users take",
    )
    p.add_argument("--email", required=True)
    p.add_argument("--password", required=True)
    p.add_argument(
        "--n", type=int, default=10, help="concurrent generations (default 10)"
    )
    p.add_argument("--length", type=int, default=30, help="length_seconds (default 30)")
    p.add_argument("--prompt", default="load test: warm analog pad, steady pulse")
    p.add_argument("--genre", default="Ambient")
    p.add_argument("--mood", default="Calm")
    p.add_argument("--bpm-min", type=int, default=80)
    p.add_argument("--bpm-max", type=int, default=90)
    p.add_argument(
        "--deadline",
        type=float,
        default=900.0,
        help="seconds to wait for all jobs (default 900). Ten serialized 30s "
        "jobs need ~150s; the default leaves room for a cold ACE-Step.",
    )
    p.add_argument(
        "--rate-limit",
        type=int,
        default=20,
        help="the server's per-24h limit (default 20, = RATE_LIMIT_PER_24H)",
    )
    p.add_argument(
        "--overshoot",
        type=int,
        default=5,
        help="--probe-rate-limit: extra requests past the limit (default 5)",
    )
    p.add_argument(
        "--check-queues",
        action="store_true",
        help="read DLQ depths before/after via the aws CLI",
    )
    p.add_argument(
        "--probe-rate-limit",
        action="store_true",
        help="measure the rate limiter instead of running a load test",
    )
    args = p.parse_args()

    if args.n < 1:
        p.error("--n must be >= 1")
    if not 10 <= args.length <= 180:
        p.error("--length must be between 10 and 180")

    coro = probe_rate_limit(args) if args.probe_rate_limit else run_load(args)
    try:
        return asyncio.run(coro)
    except KeyboardInterrupt:
        print("\ninterrupted", file=sys.stderr)
        return 130


if __name__ == "__main__":
    sys.exit(main())
