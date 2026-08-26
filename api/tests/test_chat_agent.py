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


def _answering(asked: str, said: str) -> list[ConverseMessage]:
    """A two-turn history: the question, and the answer to it.

    The question matters. The tail of the ladder — who sings it, instruments,
    length — is asked once and then moved past, because "surprise me" leaves
    the field null and a ladder that waited for a value would ask forever.
    """
    return [
        {"role": "assistant", "content": [{"text": asked}]},
        {"role": "user", "content": [{"text": said}]},
    ]


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
    history: list[ConverseMessage] = []
    replies: list[str] = []
    for message in (
        "a rainy late-night drive",
        "lo-fi",
        "calm",
        "sung",
        "female",
        "piano and drums",
        "90 seconds",
    ):
        history.append({"role": "user", "content": [{"text": message}]})
        result = await agent.run_turn(history=history, draft=draft)
        history.append({"role": "assistant", "content": [{"text": result.reply}]})
        draft = result.draft
        replies.append(result.reply)

    assert draft.prompt == "a rainy late-night drive"
    assert draft.genre == "Lo-Fi"
    assert draft.mood == "Calm"
    assert draft.lyrics_mode is LyricsMode.WRITE
    assert draft.voice is Voice.FEMALE
    assert set(draft.instruments) == {"piano", "drums"}
    assert draft.length_seconds == 90
    assert result.ready is True
    # Seven different questions, so it is interviewing rather than looping —
    # and the last three are the ones that used to be skipped.
    assert len(set(replies)) == 7


@pytest.mark.asyncio
async def test_the_interview_does_not_stop_at_ready(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """
    Voice, instruments and length are asked AFTER `ready` goes true.

    They all have defaults in the Create form, so none of them gates the
    DraftCard — but "it never asked" is the complaint, and a draft that opens
    Create with nothing in those three is a form the user still has to fill in
    by hand.
    """
    monkeypatch.setattr(
        agent, "converse_messages", FakeConverse({HAIKU: ConverseOutcome.DISABLED})
    )
    sung = SongDraft.model_validate({**_COMPLETE, "lyrics_mode": "write"})

    voice = await agent.run_turn(history=_history("sung"), draft=sung)
    assert voice.ready is True
    assert "sing it" in voice.reply

    instruments = await agent.run_turn(
        history=_answering(voice.reply, "female"), draft=voice.draft
    )
    assert "instruments" in instruments.reply

    length = await agent.run_turn(
        history=_answering(instruments.reply, "piano"), draft=instruments.draft
    )
    assert "How long" in length.reply

    done = await agent.run_turn(
        history=_answering(length.reply, "two minutes"), draft=length.draft
    )
    assert done.draft.length_seconds == 120
    assert done.suggestions == []


@pytest.mark.asyncio
async def test_a_question_nobody_answers_is_not_asked_twice(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """
    "Surprise me" is an answer. It just isn't a VALUE — voice stays null — so
    the ladder has to advance on having asked, or that one question is the only
    thing that ever happens again.
    """
    monkeypatch.setattr(
        agent, "converse_messages", FakeConverse({HAIKU: ConverseOutcome.DISABLED})
    )
    sung = SongDraft.model_validate({**_COMPLETE, "lyrics_mode": "write"})

    asked = agent._OFFLINE_QUESTIONS["voice"]
    result = await agent.run_turn(history=_answering(asked, "surprise me"), draft=sung)

    assert result.draft.voice is None
    assert result.reply != asked
    assert "instruments" in result.reply


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
    # An instrumental with the required four still has two questions to go.
    complete = SongDraft.model_validate(_COMPLETE)
    assert agent._suggestions(complete) == ["Piano", "Guitar", "Whatever fits"]
    with_instruments = complete.merged_with(
        SongDraft.model_validate({"instruments": ["piano"]})
    )
    assert agent._suggestions(with_instruments) == [
        "30 seconds",
        "1 minute",
        "2 minutes",
    ]


def test_a_sung_song_is_asked_who_sings_it() -> None:
    sung = SongDraft.model_validate({**_COMPLETE, "lyrics_mode": "write"})

    assert agent._suggestions(sung) == ["Female", "Male", "Surprise me"]


def test_the_chips_follow_the_question_that_was_actually_asked() -> None:
    """
    The model writes its own prose and does not always take the ladder's next
    step. Chips for a question nobody asked are worse than no chips at all, so
    the reply is read first and the draft is only the fallback.
    """
    partial = SongDraft.model_validate({"prompt": "a drive"})

    asked_mood = agent._suggestions(partial, "Lovely. What mood are you after?")
    assert asked_mood == ["Calm", "Energetic", "Dark"]
    # Nothing recognisable in the reply: back to the first missing field.
    assert agent._suggestions(partial, "Tell me more.") == ["Lo-Fi", "EDM", "Cinematic"]


def test_every_chip_is_a_phrase_the_offline_parse_understands() -> None:
    """
    Tapping a chip has to move the draft on with Bedrock switched off, or the
    whole feature is undevelopable without AWS. The two deliberate exceptions
    are the brush-offs, which advance by having been asked instead.
    """
    empty = SongDraft()
    assert agent._offline_delta(user_text="Lo-Fi", draft=empty).genre == "Lo-Fi"
    assert agent._offline_delta(user_text="Calm", draft=empty).mood == "Calm"
    assert agent._offline_delta(user_text="Piano", draft=empty).instruments == ["piano"]
    assert agent._offline_delta(user_text="Guitar", draft=empty).instruments == [
        "guitar"
    ]
    for chip, seconds in (("30 seconds", 30), ("1 minute", 60), ("2 minutes", 120)):
        assert agent._offline_delta(user_text=chip, draft=empty).length_seconds == (
            seconds
        )


def test_a_duration_is_read_the_several_ways_people_write_one() -> None:
    assert agent._offline_length("90 seconds") == 90
    assert agent._offline_length("about 45s") == 45
    assert agent._offline_length("2 min") == 120
    assert agent._offline_length("1.5 minutes") == 90
    assert agent._offline_length("two minutes") == 120
    assert agent._offline_length("half a minute") == 30
    # A bare number only when it is the whole message: one inside a sentence is
    # as likely to be a year or a BPM.
    assert agent._offline_length("120") == 120
    assert agent._offline_length("something like a 1997 record") is None


def test_an_instrument_is_not_recorded_twice_under_two_names() -> None:
    """Longest first, so "rhodes piano" does not also land as "piano"."""
    assert agent._offline_instruments("rhodes piano and upright bass") == [
        "rhodes piano",
        "upright bass",
    ]


# ── The system prompt ──────────────────────────────────────────────────────


def test_the_known_block_states_only_what_has_been_established() -> None:
    assert "start of the conversation" in agent._known_block(SongDraft())

    known = agent._known_block(SongDraft.model_validate(_COMPLETE))
    assert "Genre: Lo-Fi" in known
    assert "Instrumental" in known
    assert "Tempo" not in known  # never established, so never stated
