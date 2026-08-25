"""
The chat assistant's model layer: one interviewer turn, and the draft it moved.

Lives inside the conversation module rather than in shared/ for the reason
generation/authoring.py does: the prompts below are product copy about THIS
module's domain — how RITHM interviews someone about a song, what its genre and
mood vocabularies are, what the Create form can accept. It imports only
app.config, app.shared.aws, app.shared.exceptions and its own schemas, so the
import-linter independence contract is untouched.

THREE RULES GOVERN EVERYTHING HERE
----------------------------------
1. The chatbot never generates a track. It fills in a draft; the user presses
   Create. There is no call to the generation module from this file and there
   never should be.

2. Never trust the model's JSON. Every extracted field is re-validated against
   the real vocabularies and the exact GenerateRequest bounds — in
   `SongDraft._coerce`, on write. The draft is echoed back into the system
   prompt on every subsequent turn, so it is a persistent injection surface as
   well as a wire DTO.

3. Never log message text, only lengths, counts, flags and model ids. This is
   authoring.py's rule, and a chat transcript is more sensitive than a lyric.
"""

import asyncio
import json
from dataclasses import dataclass, field

import structlog
from pydantic import ValidationError

from app.config import get_settings
from app.modules.conversation.schemas import (
    GENRES,
    LENGTH_MAX_SECONDS,
    LENGTH_MIN_SECONDS,
    MOODS,
    LyricsMode,
    SongDraft,
    Voice,
    draft_is_ready,
)
from app.shared.aws import ConverseMessage, ConverseOutcome, converse_messages
from app.shared.exceptions import AssistantUnavailableException

logger = structlog.get_logger()


@dataclass(frozen=True, slots=True)
class TurnResult:
    """One assistant turn: what it said, and what it learned."""

    reply: str
    # The delta this turn extracted, kept separately from the merge so it can be
    # written to `messages.tool_calls` — which is what makes "why did the draft
    # end up like this?" answerable from a SELECT.
    delta: SongDraft
    draft: SongDraft
    ready: bool
    suggestions: list[str] = field(default_factory=list[str])
    # True when the scripted interviewer answered instead of a model. Logged,
    # never returned on the wire: the user does not need to know which of the
    # two is talking, and the SPA has nothing to do differently.
    offline: bool = False


# ── The chain ──────────────────────────────────────────────────────────────

# The model that last answered, remembered for the life of the process so the
# two dead models at the head of the chain are re-probed once per restart
# rather than once per turn. Nothing persists it: a restart is exactly when
# "has the Anthropic account gate cleared yet?" deserves asking again.
_preferred_model_id: str | None = None


async def _run_chain(
    *, history: list[ConverseMessage], system: str
) -> tuple[ConverseOutcome, str | None, str | None]:
    """
    Walk the fallback chain once. Returns (outcome, model_id, text).

    The refusals this exists for are structural — AccessDeniedException (gemma
    is deliberately absent from the task role's policy) and
    ResourceNotFoundException (the per-account Anthropic use-case form has not
    cleared). Both are permanent until somebody changes something and both come
    back in a couple of hundred milliseconds, which is what makes leading with
    two dead models cost ~350ms rather than a timeout. It does NOT branch on
    the error class: throttling and a malformed reply are transient and equally
    worth advancing on, and converse_messages has already logged which it was.

    DISABLED short-circuits on the first model: Bedrock being switched off is a
    property of the process, not of a model id, so asking the other two would
    be three identical answers and a slower route to the offline interviewer.
    """
    global _preferred_model_id
    settings = get_settings()

    model_ids = list(settings.chat_model_ids)
    if _preferred_model_id in model_ids:
        model_ids.remove(_preferred_model_id)
        model_ids.insert(0, _preferred_model_id)

    for attempt, model_id in enumerate(model_ids):
        outcome, text = await converse_messages(
            model_id=model_id,
            system=system,
            messages=history,
            max_tokens=400,
            temperature=0.7,
            read_timeout=settings.bedrock_chat_read_timeout_seconds,
        )
        if outcome is ConverseOutcome.DISABLED:
            return outcome, None, None
        if outcome is ConverseOutcome.OK and text and text.strip():
            _preferred_model_id = model_id
            logger.info("chat_model_selected", model_id=model_id, attempt=attempt)
            return outcome, model_id, text
        logger.info("chat_model_skipped", model_id=model_id, attempt=attempt)

    return ConverseOutcome.FAILED, None, None


# ── The interviewer ────────────────────────────────────────────────────────

_CHAT_SYSTEM = """\
You are RITHM's studio assistant. RITHM turns a description into a piece of
music. Your ONE job is to interview the person about the song they want, until
you have enough for RITHM's Create form to be filled in. You do not write the
song, you do not generate anything, and you never claim to be making music
right now.

HOW YOU TALK
- Short. Two or three sentences, then a question. This is a 245px-wide panel on
  the side of a screen, not a chat window.
- ONE question at a time, two at the very most, and only when they are the same
  question ("Sung or instrumental — and if sung, whose voice?").
- Never dump the whole form at them. Never present a numbered list of fields.
- Warm and specific. "Nice — a rainy late-night drive. Is that sung or
  instrumental?" beats "Please specify vocal preference."
- Acknowledge what they just told you before asking the next thing.
- If they have already answered something, do not ask again. What is known is
  listed for you below.
- If they say they are done, or say "surprise me", accept it and fill in the
  rest yourself with sensible choices. Do not interrogate.

WHAT YOU ARE COLLECTING, in rough priority order
1. What the song is — a sentence describing the music. Everything else is
   optional next to this.
2. Genre. It must be one of: {genres}
3. Mood. It must be one of: {moods}
4. Sung or instrumental. If sung: a female or male lead, or let RITHM pick.
5. Optional extras, only if the conversation naturally reaches them:
   instruments, length in seconds ({length_min}-{length_max}), a tempo range in
   BPM (20-300), a title.

RULES YOU CANNOT BREAK
- Genre and mood must come from the two lists above, exactly. If they say
  "synthwave", offer the nearest one on the list ("EDM works for that — shall I
  use it?"); do not invent a genre.
- Never mention JSON, fields, forms, schemas, parameters or "the draft". You
  are having a conversation, not filling in a record in front of them.
- Never write lyrics unless they ask you to, and if they do, keep it to a few
  lines and say RITHM will write the rest.
- Never promise a track, a download, or a time.

WHAT YOU ALREADY KNOW ABOUT THIS SONG
{known}"""


def _known_block(draft: SongDraft) -> str:
    """
    The running draft, in prose, for the system prompt.

    Prose rather than a JSON dump on purpose: a model shown JSON starts
    answering in JSON, and this call's entire contract is that it never
    mentions the machinery. `_coerce` has already narrowed every value here
    onto the real vocabularies, which is what makes echoing user-influenced
    text back into a system prompt safe to do at all.
    """
    lines: list[str] = []
    if draft.prompt:
        lines.append(f"- The song: {draft.prompt}")
    if draft.genre:
        lines.append(f"- Genre: {draft.genre}")
    if draft.mood:
        lines.append(f"- Mood: {draft.mood}")
    if draft.lyrics_mode is LyricsMode.INSTRUMENTAL:
        lines.append("- Instrumental — no vocals")
    elif draft.lyrics_mode is not None:
        voice = {
            Voice.FEMALE: "a female lead",
            Voice.MALE: "a male lead",
            Voice.AUTO: "RITHM picks the voice",
        }.get(draft.voice or Voice.AUTO, "RITHM picks the voice")
        lines.append(f"- Sung, with {voice}")
    if draft.instruments:
        lines.append(f"- Instruments: {', '.join(draft.instruments)}")
    if draft.length_seconds is not None:
        lines.append(f"- Length: {draft.length_seconds} seconds")
    if draft.bpm_min is not None and draft.bpm_max is not None:
        lines.append(f"- Tempo: {draft.bpm_min}-{draft.bpm_max} BPM")
    if draft.title:
        lines.append(f"- Title: {draft.title}")
    if not lines:
        return "Nothing yet — this is the start of the conversation."
    return "\n".join(lines)


def _chat_system(draft: SongDraft) -> str:
    return _CHAT_SYSTEM.format(
        genres=", ".join(GENRES),
        moods=", ".join(MOODS),
        length_min=LENGTH_MIN_SECONDS,
        length_max=LENGTH_MAX_SECONDS,
        known=_known_block(draft),
    )


# ── Extraction — a second call, and NOT on the chain ───────────────────────

_EXTRACT_SYSTEM = """\
You extract structured data from a conversation about a song. You reply with
ONE JSON object and absolutely nothing else — no prose, no explanation, no code
fence.

The object has exactly these keys:
  prompt          string | null   one sentence describing the music
  title           string | null   the song's name, only if one was chosen
  genre           string | null   EXACTLY one of: {genres}
  mood            string | null   EXACTLY one of: {moods}
  instruments     array of strings, [] if none were named
  length_seconds  integer | null  {length_min}-{length_max}
  bpm_min         integer | null  20-300
  bpm_max         integer | null  20-300
  lyrics_mode     "write" | "prompt" | "instrumental" | null
  voice           "auto" | "female" | "male" | null
  lyrics          string | null   only words the USER supplied
  lyrics_prompt   string | null   what the song should be about, in prose

RULES
- null means "not established". Guessing is worse than leaving it null: a
  wrong value is invisible to the user until the form opens with it in.
- genre and mood must match the lists above character for character, including
  capitalisation. If nothing matches, use null.
- lyrics_mode is "instrumental" when they said no vocals, "write" when they
  supplied words, "prompt" when they described what it should be about, null
  when vocals have not come up at all.
- instruments is the FULL current list every time, not what changed. An empty
  array means none are established.
- bpm_min and bpm_max are both present or both null.
- Carry forward everything in "known so far" unless this exchange changed it."""


def _extract_user_turn(*, draft: SongDraft, user_text: str, reply: str) -> str:
    known = json.dumps(draft.model_dump(mode="json"), ensure_ascii=False)
    return "\n".join(
        [
            "Known so far:",
            known,
            "",
            "They said:",
            user_text,
            "",
            "The assistant replied:",
            reply,
            "",
            "JSON:",
        ]
    )


def _json_block(text: str) -> str | None:
    """
    The outermost JSON object in a reply, or None.

    Small models fence their JSON, or prefix it with "Here you go:", however
    firmly the prompt says not to. Slicing between the first `{` and the last
    `}` handles both without a regex that would have to understand nesting.
    """
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end <= start:
        return None
    return text[start : end + 1]


async def _extract(*, draft: SongDraft, user_text: str, reply: str) -> SongDraft:
    """
    Turn the exchange into a draft delta. Never raises; an empty draft means
    "nothing learned this turn", which is a normal outcome.

    A SECOND call, on a DIFFERENT model, and this is the single most important
    departure from the obvious one-call design. Asking the chat model to append
    a fenced JSON block puts "hold a conversation" and "emit strict JSON" on the
    same model — and the model serving 100% of chat traffic today is
    nova-2-lite, which drops a required JSON tail more often than a large model
    does. The failure is SILENT: six turns in, the DraftCard is still empty, the
    user has answered everything, and nothing anywhere says why.

    So the structured-output job goes to a model chosen for it, at temperature
    0, and the miss rate becomes a number you can grep for.

    The reply goes STRAIGHT into `SongDraft.model_validate_json`, never into a
    `dict` first: `json.loads()` returns `Any`, and under pyright strict every
    downstream touch of an `Any` is a fresh error against a baseline that fails
    at one more than it has.
    """
    settings = get_settings()
    try:
        outcome, text = await asyncio.wait_for(
            converse_messages(
                model_id=settings.bedrock_extract_model_id,
                system=_EXTRACT_SYSTEM.format(
                    genres=", ".join(GENRES),
                    moods=", ".join(MOODS),
                    length_min=LENGTH_MIN_SECONDS,
                    length_max=LENGTH_MAX_SECONDS,
                ),
                messages=[
                    {
                        "role": "user",
                        "content": [
                            {
                                "text": _extract_user_turn(
                                    draft=draft, user_text=user_text, reply=reply
                                )
                            }
                        ],
                    }
                ],
                max_tokens=400,
                temperature=0.0,
            ),
            timeout=settings.bedrock_extract_timeout_seconds,
        )
    except TimeoutError:
        logger.warning(
            "chat_draft_extracted",
            ok=False,
            reason="timeout",
            model_id=settings.bedrock_extract_model_id,
        )
        return SongDraft()

    block = _json_block(text) if outcome is ConverseOutcome.OK and text else None
    if block is None:
        logger.warning(
            "chat_draft_extracted",
            ok=False,
            reason=outcome.value,
            model_id=settings.bedrock_extract_model_id,
        )
        return SongDraft()

    try:
        delta = SongDraft.model_validate_json(block)
    except ValidationError:
        # `_coerce` normalises rather than raises, so reaching here means the
        # reply was not an object at all. Nothing to salvage; the prose still
        # goes back to the user and the stored draft is left as it was.
        logger.warning(
            "chat_draft_extracted",
            ok=False,
            reason="invalid",
            model_id=settings.bedrock_extract_model_id,
        )
        return SongDraft()

    filled = sum(1 for value in delta.model_dump().values() if value not in (None, []))
    # Counts and flags only, never the values (rule 3). THIS is the number that
    # says whether the feature works: a run of ok=false means the extraction
    # prompt needs work, and it is visible instead of silent.
    logger.info(
        "chat_draft_extracted",
        ok=True,
        model_id=settings.bedrock_extract_model_id,
        fields=filled,
    )
    return delta


# ── The offline interviewer — the floor ────────────────────────────────────

_OFFLINE_OPENING = (
    "Let's make something. Describe the music you want — a scene, a feeling, "
    "anything at all."
)

# Deliberately fixed strings, not templates over the user's words: this path
# runs with no model in front of it, so anything it echoes back it has echoed
# verbatim.
_OFFLINE_GENRE = (
    "Good. What genre fits it best? "
    + ", ".join(GENRES[:4])
    + " — or any of the others."
)
_OFFLINE_MOOD = "And the mood — " + ", ".join(MOODS[:4]) + ", something else?"
_OFFLINE_LYRICS = (
    "Should it be sung, or instrumental? If it's sung I can ask RITHM for a "
    "female or male lead."
)
_OFFLINE_VOICE = "Who should sing it — a female lead, a male lead, or shall RITHM pick?"

_OFFLINE_DONE = (
    "That's everything I need. Open it in Create and you can adjust anything "
    "before you generate."
)

_INSTRUMENTAL_WORDS = (
    "instrumental",
    "no vocals",
    "no words",
    "no singing",
    "no lyrics",
)
_SUNG_WORDS = ("sung", "vocals", "singing", "with words", "lyrics", "singer")


def _offline_delta(*, user_text: str, draft: SongDraft) -> SongDraft:
    """
    A hand-written parse of one message: keyword matching, and nothing clever.

    This is what makes the feature buildable. `docker compose up` with no AWS
    credentials gives a chat that holds a real five-turn conversation and fills
    the form, which is enough to develop and demo the entire UI — and it is the
    double `test_chat_routes.py` runs against, so those route tests exercise
    the real code path rather than a mock.
    """
    lowered = user_text.casefold()
    values: dict[str, object] = {}

    genre = next((g for g in GENRES if g.casefold() in lowered), None)
    if genre is not None:
        values["genre"] = genre
    mood = next((m for m in MOODS if m.casefold() in lowered), None)
    if mood is not None:
        values["mood"] = mood

    if any(word in lowered for word in _INSTRUMENTAL_WORDS):
        values["lyrics_mode"] = LyricsMode.INSTRUMENTAL.value
    elif any(word in lowered for word in _SUNG_WORDS):
        values["lyrics_mode"] = LyricsMode.WRITE.value

    if "female" in lowered:
        values["voice"] = Voice.FEMALE.value
    elif "male" in lowered:
        values["voice"] = Voice.MALE.value

    # The first message is the song. Every later one is an answer to a
    # question, and treating "energetic" as the whole description would
    # overwrite what they actually asked for.
    if draft.prompt is None:
        values["prompt"] = user_text

    # Carry the rest forward so the merge sees a complete picture.
    values.setdefault("instruments", draft.instruments)
    return SongDraft.model_validate(values)


def _offline_question(draft: SongDraft) -> str:
    """The first thing still missing, asked as a fixed question."""
    if draft.prompt is None:
        return _OFFLINE_OPENING
    if draft.genre is None:
        return _OFFLINE_GENRE
    if draft.mood is None:
        return _OFFLINE_MOOD
    if draft.lyrics_mode is None:
        return _OFFLINE_LYRICS
    # Asked AFTER the draft is already ready, on purpose: voice is optional, so
    # the DraftCard appears while this question is still on screen. Being able
    # to leave early is the point of "Use what we have".
    if draft.lyrics_mode is not LyricsMode.INSTRUMENTAL and draft.voice is None:
        return _OFFLINE_VOICE
    return _OFFLINE_DONE


# ── Suggestions ────────────────────────────────────────────────────────────

_SUGGESTIONS: dict[str, list[str]] = {
    "genre": ["Lo-Fi", "EDM", "Cinematic"],
    "mood": ["Calm", "Energetic", "Dark"],
    "lyrics_mode": ["Sung", "Instrumental"],
    "voice": ["Female", "Male", "Surprise me"],
}


def _suggestions(draft: SongDraft) -> list[str]:
    """
    One-tap answers for whatever is still missing.

    Derived from the DRAFT, not asked of the model: a second structured-output
    contract for three chips would be three more things that can silently come
    back malformed, and the chips are a shortcut rather than the menu — the
    text box is always there.
    """
    if draft.prompt is None:
        return []
    for name in ("genre", "mood", "lyrics_mode"):
        if getattr(draft, name) is None:
            return _SUGGESTIONS[name]
    if draft.lyrics_mode is not LyricsMode.INSTRUMENTAL and draft.voice is None:
        return _SUGGESTIONS["voice"]
    return []


# ── The turn ───────────────────────────────────────────────────────────────


async def run_turn(*, history: list[ConverseMessage], draft: SongDraft) -> TurnResult:
    """
    One assistant turn. `history` ends with the user message being answered.

    Two model calls: the chain writes the prose, then nova-micro extracts the
    draft. With Bedrock switched off — the default, and what local, CI and the
    tests all run — neither happens and the scripted interviewer answers
    instead.
    """
    settings = get_settings()
    user_text = _last_user_text(history)

    try:
        outcome, model_id, reply = await asyncio.wait_for(
            _run_chain(history=history, system=_chat_system(draft)),
            timeout=settings.bedrock_chat_timeout_seconds,
        )
    except TimeoutError:
        # A timeout ENDS the turn; it does not advance to the next model.
        # asyncio.wait_for cancels the await, never the boto3 thread underneath
        # run_in_threadpool, and anyio's default limiter is 40 threads SHARED
        # with send_sqs_message on the generate path. Trying the next model
        # here would stack a second orphan on that limiter — which is a way to
        # stall generation in exchange for one more chance at a chat reply.
        logger.warning(
            "chat_turn_timed_out", budget=settings.bedrock_chat_timeout_seconds
        )
        raise AssistantUnavailableException() from None

    if outcome is ConverseOutcome.DISABLED:
        delta = _offline_delta(user_text=user_text, draft=draft)
        merged = draft.merged_with(delta)
        return TurnResult(
            reply=_offline_question(merged),
            delta=delta,
            draft=merged,
            ready=draft_is_ready(merged),
            suggestions=_suggestions(merged),
            offline=True,
        )

    if outcome is not ConverseOutcome.OK or reply is None:
        logger.warning("chat_chain_exhausted", models=len(settings.chat_model_ids))
        raise AssistantUnavailableException()

    delta = await _extract(draft=draft, user_text=user_text, reply=reply)
    merged = draft.merged_with(delta)
    logger.info(
        "chat_turn_complete",
        model_id=model_id,
        reply_chars=len(reply),
        ready=draft_is_ready(merged),
    )
    return TurnResult(
        reply=reply.strip(),
        delta=delta,
        draft=merged,
        ready=draft_is_ready(merged),
        suggestions=_suggestions(merged),
    )


def _last_user_text(history: list[ConverseMessage]) -> str:
    """The message this turn is answering. Empty only if the caller misused this."""
    for message in reversed(history):
        if message["role"] == "user":
            return " ".join(
                block.get("text", "") for block in message["content"]
            ).strip()
    return ""
