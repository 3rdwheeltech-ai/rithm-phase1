import { describe, expect, it } from "vitest";
import {
  COLD_START_THRESHOLD_SECONDS,
  LYRIC_PHASE_SECONDS,
  fmtElapsed,
  jobLabel,
  type JobLabelArgs,
} from "./jobLabel";

const args = (over: Partial<JobLabelArgs> = {}): JobLabelArgs => ({
  phase: "running",
  writesLyrics: false,
  runningSeconds: 0,
  ...over,
});

describe("jobLabel", () => {
  it("says nothing for a phase that carries no status", () => {
    // `idle` deliberately still speaks — see the doc comment — so the only
    // silent case is a phase outside the union.
    expect(jobLabel(args({ phase: "unknown" as never }))).toBeNull();
  });

  it("covers the gap between submit and the first frame", () => {
    expect(jobLabel(args({ phase: "idle" }))?.label).toBe("Starting…");
  });

  it("calls a long queue a cold start", () => {
    expect(
      jobLabel(args({ phase: "queued", estimatedStartSeconds: COLD_START_THRESHOLD_SECONDS + 1 })),
    ).toMatchObject({ label: "Warming up…", tone: "amber" });
  });

  it("treats a short or absent estimate as an ordinary queue", () => {
    expect(jobLabel(args({ phase: "queued" }))?.label).toBe("Queued…");
    expect(
      jobLabel(args({ phase: "queued", estimatedStartSeconds: COLD_START_THRESHOLD_SECONDS }))?.label,
    ).toBe("Queued…");
  });

  it("announces the lyric phase only when the model is writing the words", () => {
    expect(jobLabel(args({ writesLyrics: true, runningSeconds: 0 }))?.label).toBe(
      "Generating lyrics…",
    );
    // The edge that is easy to get wrong: supplied lyrics, or an instrumental,
    // must never claim the model is writing any.
    expect(jobLabel(args({ writesLyrics: false, runningSeconds: 0 }))?.label).toBe(
      "Composing the song…",
    );
  });

  it("hands over to composing once the lyric window closes", () => {
    const at = (runningSeconds: number) =>
      jobLabel(args({ writesLyrics: true, runningSeconds }))?.label;
    expect(at(LYRIC_PHASE_SECONDS - 1)).toBe("Generating lyrics…");
    expect(at(LYRIC_PHASE_SECONDS)).toBe("Composing the song…");
    expect(at(LYRIC_PHASE_SECONDS + 120)).toBe("Composing the song…");
  });

  it("marks the terminal phases so the pill stops the clock", () => {
    expect(jobLabel(args({ phase: "completed" }))).toMatchObject({
      label: "Ready",
      tone: "signal",
      terminal: true,
    });
    expect(jobLabel(args({ phase: "failed" }))).toMatchObject({
      tone: "danger",
      terminal: true,
    });
    expect(jobLabel(args({ phase: "lost" }))).toMatchObject({
      label: "We lost track of this one",
      tone: "amber",
      terminal: true,
    });
  });

  it("leaves the in-flight phases non-terminal", () => {
    for (const phase of ["idle", "queued", "running"] as const) {
      expect(jobLabel(args({ phase }))?.terminal).toBe(false);
    }
  });
});

describe("fmtElapsed", () => {
  it("pads seconds and rolls over at a minute", () => {
    expect(fmtElapsed(0)).toBe("0:00");
    expect(fmtElapsed(7)).toBe("0:07");
    expect(fmtElapsed(59)).toBe("0:59");
    expect(fmtElapsed(60)).toBe("1:00");
    expect(fmtElapsed(185)).toBe("3:05");
  });
});
