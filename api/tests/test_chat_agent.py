"""
The chat agent: the fallback chain, the two-call turn, and the offline floor.

A hand-rolled fake stands in for `converse_messages` rather than a moto
round-trip, per the house rule and per test_authoring.py's convention — it is
patched into `agent`'s own namespace, so prompt assembly and reply parsing stay
on the path under test rather than being mocked away with the network.
"""

# The chain, the prompts and the offline interviewer are private and probed
# directly: they are the parts that can actually be wrong, and driving them
# through the public path alone would need a Bedrock account.
# pyright: reportPrivateUsage=false
import asyncio
import json
from typing import Any

import pytest

from app.config import get_settings
from app.modules.conversation import agent
from app.modules.conversation.schemas import LyricsMode, SongDraft, Voice
from app.shared.aws import ConverseMessage, ConverseOutcome

HAIKU = "us.anthropic.claude-haiku-4-5-20251001-v1:0"
GEMMA = "google.gemma-3-27b-it"
NOVA = "us.amazon.nova-2-lite-v1:0"
EXTRACTOR = "amazon.nova-micro-v1:0"

_COMPLETE = {
    "prompt": "a rainy late-night drive",
    "genre": "Lo-Fi",
    "mood": "Calm",
    "lyrics_mode": "instrumental",
}


def _history(text: str = "something dreamy") -> list[ConverseMessage]:
    return [{"role": "user", "content": [{"text": text}]}]


class FakeConverse:
    """
    Answers per model id, and records every call.

    `replies` maps a model id to what it returns: a string for a reply, an
    outcome for a refusal. Anything unlisted is FAILED, which is what the two
    dead models at the head of the real chain do today.
    """

    def __init__(self, replies: dict[str, str | ConverseOutcome]) -> None:
        self.replies = replies
        self.calls: list[dict[str, Any]] = []

    async def __call__(self, **kwargs: Any) -> tuple[ConverseOutcome, str | None]:
        self.calls.append(kwargs)
        answer = self.replies.get(str(kwargs["model_id"]))
        # ConverseOutcome is a StrEnum, so the outcome check comes FIRST — an
        # isinstance(answer, str) above it swallows every member of it.
        if isinstance(answer, ConverseOutcome):
            return answer, None
        if isinstance(answer, str):
            return ConverseOutcome.OK, answer
        return ConverseOutcome.FAILED, None

    @property
    def model_ids(self) -> list[str]:
        return [str(call["model_id"]) for call in self.calls]


def _extraction(**values: Any) -> str:
    """What the extractor is meant to reply with."""
    return json.dumps(values)


@pytest.fixture(autouse=True)
def fresh_agent() -> None:
    """
    The winning model is memoised for the life of the PROCESS, which is the
    point of it — so it has to be cleared between tests or the second test in
    this file starts on whatever the first one settled on.
    """
    get_settings.cache_clear()
    agent._preferred_model_id = None


# ── The chain ──────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_the_chain_advances_past_refusals_to_the_model_that_answers(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """
    Haiku is gated behind an Anthropic account form and gemma is deliberately
    absent from the task role's policy, so both refuse structurally in under a
    second. Leading with them is what makes the chain need no code change the
    day either is unblocked.
    """
    fake = FakeConverse({NOVA: "What's the mood?", EXTRACTOR: _extraction()})
    monkeypatch.setattr(agent, "converse_messages", fake)

    result = await agent.run_turn(history=_history(), draft=SongDraft())

    assert result.reply == "What's the mood?"
    assert fake.model_ids[:3] == [HAIKU, GEMMA, NOVA]


@pytest.mark.asyncio
async def test_the_winning_model_is_memoised_for_the_process(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Two dead models re-probed once per restart, not once per turn."""
    fake = FakeConverse({NOVA: "Go on.", EXTRACTOR: _extraction()})
    monkeypatch.setattr(agent, "converse_messages", fake)

    await agent.run_turn(history=_history(), draft=SongDraft())
    first_turn_calls = len(fake.calls)
    await agent.run_turn(history=_history(), draft=SongDraft())

    # Second turn: straight to the winner, then the extractor. No re-probing.
    assert fake.model_ids[first_turn_calls:] == [NOVA, EXTRACTOR]


@pytest.mark.asyncio
async def test_a_timeout_ends_the_chain_rather_than_advancing_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """
    asyncio.wait_for cancels the await, never the boto3 thread underneath
    run_in_threadpool — and anyio's limiter is 40 threads SHARED with
    send_sqs_message on the generate path. Trying the next model would stack a
    second orphan on it, which is a way to stall generation in exchange for one
    more chance at a chat reply.
    """
    monkeypatch.setenv("BEDROCK_CHAT_TIMEOUT_SECONDS", "0.05")
    get_settings.cache_clear()

    calls: list[str] = []

    async def _hang(**kwargs: Any) -> tuple[ConverseOutcome, str | None]:
        calls.append(str(kwargs["model_id"]))
        await asyncio.sleep(5)
        return ConverseOutcome.OK, "never gets here"

    monkeypatch.setattr(agent, "converse_messages", _hang)

    with pytest.raises(Exception) as excinfo:
        await agent.run_turn(history=_history(), draft=SongDraft())

    assert getattr(excinfo.value, "status_code", None) == 503
    assert calls == [HAIKU]  # stopped, did not advance


@pytest.mark.asyncio
async def test_every_model_refusing_is_a_503_not_an_empty_reply(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(agent, "converse_messages", FakeConverse({}))

    with pytest.raises(Exception) as excinfo:
        await agent.run_turn(history=_history(), draft=SongDraft())

    assert getattr(excinfo.value, "status_code", None) == 503
    assert getattr(excinfo.value, "problem_type", "") == (
        "https://rithm.dev/errors/assistant-unavailable"
    )


# ── Two calls, and only the first is on the chain ──────────────────────────


@pytest.mark.asyncio
async def test_extraction_runs_on_the_extractor_at_temperature_zero(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """
    The single most important departure from the obvious design. The chat model
    converses at 0.7; a model chosen for structured output emits the JSON at 0.
    Putting both jobs on nova-2-lite is how the DraftCard silently never
    appears.
    """
    fake = FakeConverse({NOVA: "Sounds great.", EXTRACTOR: _extraction(genre="EDM")})
    monkeypatch.setattr(agent, "converse_messages", fake)

    await agent.run_turn(history=_history(), draft=SongDraft())

    prose = next(c for c in fake.calls if c["model_id"] == NOVA)
    extract = next(c for c in fake.calls if c["model_id"] == EXTRACTOR)
    assert prose["temperature"] == 0.7
    assert extract["temperature"] == 0.0
    assert extract["model_id"] != prose["model_id"]


@pytest.mark.asyncio
async def test_only_the_extractor_is_asked_for_json(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """
    The conversation must not leak the machinery it is feeding: the chat model
    is told never to mention JSON, and is never asked to produce any. The
    extractor is asked for nothing else.
    """
    fake = FakeConverse({NOVA: "Tell me more.", EXTRACTOR: _extraction()})
    monkeypatch.setattr(agent, "converse_messages", fake)

    await agent.run_turn(history=_history(), draft=SongDraft())

    prose = str(next(c for c in fake.calls if c["model_id"] == NOVA)["system"])
    extract = str(next(c for c in fake.calls if c["model_id"] == EXTRACTOR)["system"])
    assert "Never mention JSON" in prose
    assert "ONE JSON object" in extract


@pytest.mark.asyncio
async def test_a_non_json_extraction_leaves_the_draft_untouched_and_still_replies(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A model that forgets the JSON must not also cost the user their turn."""
    fake = FakeConverse({NOVA: "Nice one.", EXTRACTOR: "Sure! Here's what I found."})
    monkeypatch.setattr(agent, "converse_messages", fake)

    before = SongDraft.model_validate({"prompt": "rainy drive", "genre": "Lo-Fi"})
    result = await agent.run_turn(history=_history(), draft=before)

    assert result.reply == "Nice one."
    assert result.draft == before


@pytest.mark.asyncio
async def test_a_fenced_extraction_is_still_read(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Small models fence their JSON however firmly the prompt says not to."""
    fenced = '```json\n{"genre": "EDM"}\n```'
    fake = FakeConverse({NOVA: "Got it.", EXTRACTOR: fenced})
    monkeypatch.setattr(agent, "converse_messages", fake)

    result = await agent.run_turn(history=_history(), draft=SongDraft())

    assert result.draft.genre == "EDM"


@pytest.mark.asyncio
async def test_an_out_of_vocabulary_genre_is_dropped_on_the_way_in(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake = FakeConverse(
        {NOVA: "Ok.", EXTRACTOR: _extraction(genre="Synthwave", mood="Dark")}
    )
    monkeypatch.setattr(agent, "converse_messages", fake)

    result = await agent.run_turn(history=_history(), draft=SongDraft())

    assert result.draft.genre is None
    assert result.draft.mood == "Dark"


@pytest.mark.asyncio
async def test_instrumental_clears_voice_and_lyrics_on_the_way_in(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake = FakeConverse(
        {
            NOVA: "Instrumental it is.",
            EXTRACTOR: _extraction(
                lyrics_mode="instrumental", voice="female", lyrics="[verse]\nrain"
            ),
        }
    )
    monkeypatch.setattr(agent, "converse_messages", fake)

    result = await agent.run_turn(history=_history(), draft=SongDraft())

    assert result.draft.lyrics_mode is LyricsMode.INSTRUMENTAL
    assert result.draft.voice is Voice.AUTO
    assert result.draft.lyrics is None


@pytest.mark.asyncio
async def test_a_half_bpm_range_is_normalised_rather_than_raised(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A 422 at Create would read as "the chatbot broke Create"."""
    fake = FakeConverse({NOVA: "Ok.", EXTRACTOR: _extraction(bpm_min=90)})
    monkeypatch.setattr(agent, "converse_messages", fake)

    result = await agent.run_turn(history=_history(), draft=SongDraft())

    assert result.draft.bpm_min is None
    assert result.draft.bpm_max is None


@pytest.mark.asyncio
async def test_ready_is_derived_server_side_and_ignores_a_model_set_flag(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """
    A model that declares itself finished is reporting a mood, not a fact — and
    a DraftCard over an empty form is the one failure the user cannot recover
    from without starting over.
    """
    claims_done = FakeConverse(
        {NOVA: "All set!", EXTRACTOR: _extraction(prompt="a drive", ready=True)}
    )
    monkeypatch.setattr(agent, "converse_messages", claims_done)
    assert (await agent.run_turn(history=_history(), draft=SongDraft())).ready is False

    agent._preferred_model_id = None
    actually_done = FakeConverse(
        {NOVA: "All set!", EXTRACTOR: _extraction(**_COMPLETE, ready=False)}
    )
    monkeypatch.setattr(agent, "converse_messages", actually_done)
    assert (await agent.run_turn(history=_history(), draft=SongDraft())).ready is True


@pytest.mark.asyncio
async def test_the_delta_is_returned_separately_from_the_merge(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """It is written to messages.tool_calls, which is what that column is for."""
    fake = FakeConverse({NOVA: "Ok.", EXTRACTOR: _extraction(mood="Dark")})
    monkeypatch.setattr(agent, "converse_messages", fake)

    before = SongDraft.model_validate({"prompt": "a drive"})
    result = await agent.run_turn(history=_history(), draft=before)

    assert result.delta.mood == "Dark"
    assert result.delta.prompt is None
    assert result.draft.prompt == "a drive"


# ── The offline interviewer ────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_bedrock_disabled_routes_to_the_offline_interviewer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """
    BEDROCK_ENABLED defaults to False, so this is what local, CI and the tests
    all run. A naive port gives them a chatbot that says "assistant
    unavailable" forever and no way to build the UI without AWS credentials.
    """
    fake = FakeConverse({model: ConverseOutcome.DISABLED for model in (HAIKU,)})
    monkeypatch.setattr(agent, "converse_messages", fake)

    result = await agent.run_turn(history=_history("a rainy drive"), draft=SongDraft())

    assert result.offline is True
    assert result.reply
    assert result.draft.prompt == "a rainy drive"
    # One call, and no extraction: DISABLED is a property of the process, not
    # of a model id, so asking the other two is three identical answers.
    assert fake.model_ids == [HAIKU]


@pytest.mark.asyncio
async def test_the_offline_interviewer_holds_a_whole_conversation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """
    Gate M3, in a test. If this cannot reach `ready`, the feature is not
    buildable without AWS credentials — and everything downstream depends on
    being able to develop and demo the UI.
    """
    monkeypatch.setattr(
        agent, "converse_messages", FakeConverse({HAIKU: ConverseOutcome.DISABLED})
    )

    draft = SongDraft()
    replies: list[str] = []
    for message in ("a rainy late-night drive", "lo-fi", "calm", "instrumental"):
        result = await agent.run_turn(history=_history(message), draft=draft)
        draft = result.draft
        replies.append(result.reply)

    assert draft.prompt == "a rainy late-night drive"
    assert draft.genre == "Lo-Fi"
    assert draft.mood == "Calm"
    assert draft.lyrics_mode is LyricsMode.INSTRUMENTAL
    assert result.ready is True
    # Four different questions, so it is interviewing rather than looping.
    assert len(set(replies)) == 4


@pytest.mark.asyncio
async def test_the_offline_interviewer_does_not_overwrite_the_prompt(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """
    Every message after the first is an ANSWER. Treating "energetic" as the
    whole description would throw away what they actually asked for.
    """
    monkeypatch.setattr(
        agent, "converse_messages", FakeConverse({HAIKU: ConverseOutcome.DISABLED})
    )

    draft = SongDraft.model_validate({"prompt": "a rainy drive"})
    result = await agent.run_turn(history=_history("energetic"), draft=draft)

    assert result.draft.prompt == "a rainy drive"
    assert result.draft.mood == "Energetic"


# ── Suggestions ────────────────────────────────────────────────────────────


def test_suggestions_track_the_first_missing_field() -> None:
    """
    Derived from the draft rather than asked of the model: a second
    structured-output contract for three chips is three more things that can
    come back malformed.
    """
    assert agent._suggestions(SongDraft()) == []
    partial = SongDraft.model_validate({"prompt": "a drive"})
    assert agent._suggestions(partial) == ["Lo-Fi", "EDM", "Cinematic"]
    assert agent._suggestions(SongDraft.model_validate(_COMPLETE)) == []


def test_a_sung_song_is_asked_who_sings_it() -> None:
    sung = SongDraft.model_validate({**_COMPLETE, "lyrics_mode": "write"})

    assert agent._suggestions(sung) == ["Female", "Male", "Surprise me"]


# ── The system prompt ──────────────────────────────────────────────────────


def test_the_known_block_states_only_what_has_been_established() -> None:
    assert "start of the conversation" in agent._known_block(SongDraft())

    known = agent._known_block(SongDraft.model_validate(_COMPLETE))
    assert "Genre: Lo-Fi" in known
    assert "Instrumental" in known
    assert "Tempo" not in known  # never established, so never stated
