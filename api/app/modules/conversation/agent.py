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
import re
from dataclasses import dataclass, field
from time import perf_counter

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
            # A CEILING, NOT A TARGET — and worth being clear about, because
            # it is easy to read as a latency fix and it is not. A reply that
            # was already going to be 60 tokens takes exactly as long under
            # either cap; this only bites the pathological turn. That turn is
            # real though: the persona is specified as "two or three sentences,
            # then a question", and 400 tokens is roughly 300 words — licence
            # to monologue that nothing else takes away. Anam's own model ran
            # at 4096 and did exactly that for a minute at a time.
            max_tokens=160,
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
#
# ONE INTERVIEW, TWO DELIVERIES. Everything about WHAT to ask is shared, which
# is what keeps Talk and Chat one assistant rather than two that happen to
# write to the same table. Only the block describing HOW to say it differs,
# because a 245px panel someone reads and a voice someone listens to are not
# the same medium and pretending otherwise produced an avatar that spoke in
# paragraphs.
#
# NO EM-DASHES ANYWHERE IN THE PROMPT COPY, and note the examples especially.
# This file used to teach the habit: "Nice — a rainy late-night drive" sat in
# the worked example, so the model produced em-dashes all day and the TTS
# engine, which has no word for one, either swallowed them or named them.
# Python COMMENTS are free to use them; the model never sees these.
#
# "Rithm", never "RITHM". An all-caps token is an initialism to a TTS engine,
# so the brand came out spelled letter by letter. The wordmark in the UI is
# untouched; this is only the text a model echoes.

_CHAT_DELIVERY = """\
HOW YOU TALK
- Short. Two or three sentences, then a question. This is a 245px-wide panel on
  the side of a screen, not a chat window.
- ONE question at a time, two at the very most, and only when they are the same
  question ("Sung or instrumental, and if sung, whose voice?").
- Never dump the whole form at them. Never present a numbered list of fields.
- Warm and specific. "Nice, a rainy late-night drive. Is that sung or
  instrumental?" beats "Please specify vocal preference."
- Acknowledge what they just told you before asking the next thing.
- If they have already answered something, do not ask again. What is known is
  listed for you below.
- If they say they are done, or say "surprise me", accept it and fill in the
  rest yourself with sensible choices. Do not interrogate."""

_VOICE_DELIVERY = """\
HOW YOU TALK
EVERY WORD YOU WRITE IS SPOKEN ALOUD by a text-to-speech engine. Nobody can
re-read you, skim you, or scroll back. Write for the ear.
- ONE or two sentences, then a question. Shorter than you would type. A long
  spoken turn is not thorough, it is something the listener has to sit through.
- ONE question at a time, two at the very most, and only when they are the same
  question ("Sung or instrumental, and if sung, whose voice?").
- Never a list. Not numbered, not bulleted, not "first, second, third". If you
  need to offer options, name two or three inside a sentence.
- No markdown of any kind. No asterisks, no headings, no formatting characters.
  They are read out as their own names.
- NO EM-DASHES and NO ELLIPSES. Write a comma or a full stop instead. The
  engine has no word for a dash and reads "..." as "dot dot dot".
- Otherwise PUNCTUATE NORMALLY. Full stops and commas are how the engine paces
  you, so ordinary sentences are exactly what it wants. Do not try to help it
  by writing round the punctuation.
- THE GENRE AND MOOD LISTS ARE YOURS TO MATCH AGAINST, NEVER TO READ OUT. Nine
  options spoken aloud is a menu nobody can hold in their head, and by the time
  you reach the end they have forgotten the start. Offer two or three that suit
  what they have already described and let them say something else instead:
  "Sounds like Lo-Fi or Ambient to me, unless you had something else in mind?"
- Write "Rithm", never "RITHM". Capitals get spelled out letter by letter.
- Write numbers the way you would say them. "Ninety seconds", not "90s".
- Never say "panel", "screen", "button", "click", "type" or "form". They are
  talking to you, not looking at anything.
- Warm and specific. "Nice, a rainy late-night drive. Is that sung or
  instrumental?" beats "Please specify vocal preference."
- Acknowledge what they just told you before asking the next thing.
- If they have already answered something, do not ask again. What is known is
  listed for you below.
- If they say they are done, or say "surprise me", accept it and fill in the
  rest yourself with sensible choices. Do not interrogate."""

_CHAT_SYSTEM = """\
You are Rithm's studio assistant. Your name is Ria. Rithm turns a description
into a piece of music. Your ONE job is to interview the person about the song
they want, until you have enough for Rithm's Create form to be filled in. You
do not write the song, you do not generate anything, and you never claim to be
making music right now.

{delivery}

THE THREE THAT MATTER, in this order
1. What the song is, a sentence describing the music. Everything else is
   optional next to this.
2. Genre. It must be one of: {genres}
3. Mood. It must be one of: {moods}

THE MOMENT YOU HAVE THOSE THREE, the song is ready to open in Create, and you
say so: one short line telling them it is ready whenever they are, and then
ask the next question below anyway, in the same message. They choose whether to
answer it or go. Do not make them ask permission to leave, and do not announce
it twice.

NICE TO HAVE, one at a time, after that
4. Sung or instrumental.
5. If sung: who sings it, a female lead, a male lead, or let Rithm pick.
   Skip this one entirely for an instrumental.
6. Instruments. One or two that should carry it is plenty.
7. Length, in seconds ({length_min}-{length_max}).

Every one of these can be skipped and none of them is worth a second ask. A
tempo range in BPM (20-300) and a title are worth raising only if they bring
them up first. When there is nothing sensible left to ask, say so and stop.

RULES YOU CANNOT BREAK
- A brush-off is an answer. "Whatever fits", "you pick", "surprise me". Take
  it, say what you'll do, and move to the next question. Never ask the same
  thing twice.
- Genre and mood must come from the two lists above, exactly. If they say
  "synthwave", TAKE the nearest one on the list, name the one you took, and
  carry on ("Synthwave. I'll put that down as EDM. What mood are you after?").
  Never ask them to confirm a mapping you can make yourself, and never invent
  a genre that is not on the list.
- If an answer fits a DIFFERENT question than the one you asked, take it for
  the question it fits and then ask the one that is still open. Someone who
  answers "EDM" to a question about mood has given you the genre: record it,
  and ask the mood ONCE more, never twice, and never as a yes/no about the
  answer they already gave.
- Never mention JSON, fields, forms, schemas, parameters or "the draft". You
  are having a conversation, not filling in a record in front of them. "Ready
  to open in Create" is the one exception. Create is a place they can see, and
  a button that says exactly that appears when you say it.
- Never write lyrics unless they ask you to, and if they do, keep it to a few
  lines and say Rithm will write the rest.
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
        lines.append("- Instrumental, no vocals")
    elif draft.lyrics_mode is not None:
        voice = {
            Voice.FEMALE: "a female lead",
            Voice.MALE: "a male lead",
            Voice.AUTO: "Rithm picks the voice",
        }.get(draft.voice or Voice.AUTO, "Rithm picks the voice")
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
        return "Nothing yet. This is the start of the conversation."
    return "\n".join(lines)


def _chat_system(draft: SongDraft, *, voice: bool) -> str:
    """
    The interview, in the register of the door it came through.

    `voice` rides in on `ChatTurnRequest.source`, which already existed for the
    `chat_turn` log line and for `sessions.voice_enabled` — so this costs
    nothing on the wire and an older client that sends no source keeps getting
    the chat register, which is the safe default.
    """
    return _CHAT_SYSTEM.format(
        delivery=_VOICE_DELIVERY if voice else _CHAT_DELIVERY,
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


def _extract_user_turn(*, draft: SongDraft, user_text: str, asked: str) -> str:
    """
    The extraction call's one user message.

    `asked` is the QUESTION being answered, not the reply to it — extraction
    now runs before the interviewer writes anything. That is the better half of
    the exchange to hand over anyway: "Dark" is a mood next to "what mood are
    you after?" and almost nothing on its own, and the prior question is what
    disambiguates a one-word answer.
    """
    known = json.dumps(draft.model_dump(mode="json"), ensure_ascii=False)
    return "\n".join(
        [
            "Known so far:",
            known,
            "",
            "The assistant had asked:",
            asked or "(nothing yet — this is the first message)",
            "",
            "They said:",
            user_text,
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


async def _extract(*, draft: SongDraft, user_text: str, asked: str) -> SongDraft:
    """
    Turn the exchange into a draft delta. Never raises; an empty draft means
    "nothing learned this turn", which is a normal outcome.

    A SEPARATE call, on a DIFFERENT model, and this is the single most important
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
                                    draft=draft, user_text=user_text, asked=asked
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

    # DISABLED is the default posture rather than a miss — local, CI and every
    # route test run this way, and warning on each turn would bury the misses
    # that matter. `converse_messages` makes no call at all in that state.
    if outcome is ConverseOutcome.DISABLED:
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
#
# NO EM-DASHES AND NO "RITHM" IN ANY OF THEM. These are spoken verbatim on the
# voice door, and a TTS engine has no word for an em-dash while an all-caps
# token gets spelled out letter by letter. `sanitizeForSpeech` would rewrite
# both anyway, so writing them here only guarantees the two doors say
# different words.
_OFFLINE_GENRE = (
    "Good. What genre fits it best? "
    + ", ".join(GENRES[:4])
    + ", or any of the others."
)
_OFFLINE_MOOD = "And the mood. " + ", ".join(MOODS[:4]) + ", something else?"
# Deliberately keeps off the next step's words: `_TOPIC_WORDS` reads these
# back to decide what has been asked, and "female or male lead" here would mark
# the voice question answered before it was ever put.
_OFFLINE_LYRICS = "Should it be sung, or instrumental?"
_OFFLINE_VOICE = "Who should sing it? A female lead, a male lead, or shall Rithm pick?"
_OFFLINE_INSTRUMENTS = (
    "What instruments should carry it? Piano, guitar, strings, or leave it to Rithm."
)
_OFFLINE_LENGTH = (
    f"How long should it run? Anything from {LENGTH_MIN_SECONDS} seconds to "
    f"{LENGTH_MAX_SECONDS // 60} minutes."
)

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

# A keyword list, NOT a vocabulary: `instruments` is free text on the wire and
# in the Create form, and this path only has to recognise the common answers.
# Mirrors web/src/lib/suggestions.ts so a chip tapped there and a word typed
# here land on the same string. Longest first, so "rhodes piano" is not also
# recorded as "piano".
_INSTRUMENT_WORDS: tuple[str, ...] = tuple(
    sorted(
        (
            "electric guitar",
            "acoustic guitar",
            "upright bass",
            "hammond organ",
            "brushed snare",
            "vinyl crackle",
            "rhodes piano",
            "synth pads",
            "saxophone",
            "808 bass",
            "marimba",
            "trumpet",
            "strings",
            "guitar",
            "violin",
            "drums",
            "piano",
            "cello",
            "choir",
            "flute",
            "organ",
            "synth",
            "bass",
            "harp",
        ),
        key=len,
        reverse=True,
    )
)

_SECONDS_RE = re.compile(r"(\d+)\s*(?:s\b|sec|second)")
_MINUTES_RE = re.compile(r"(\d+(?:\.\d+)?)\s*(?:m\b|min|minute)")
_HALF_MINUTE_RE = re.compile(r"half a (?:min|minute)")
# A bare number, which is what "how long?" gets answered with more often than
# not. Only when it is the WHOLE message: a number inside a sentence is as
# likely to be a year or a BPM.
_BARE_NUMBER_RE = re.compile(r"^\d{1,3}$")

# "two minutes" is at least as common as "120". Substituted only inside
# `_offline_length`, and only ahead of a unit — turning the "a" in "a rainy
# drive" into a 1 is harmless there and would not be anywhere else.
_NUMBER_WORDS: dict[str, str] = {
    "a": "1",
    "an": "1",
    "one": "1",
    "two": "2",
    "three": "3",
    "four": "4",
    "five": "5",
    "six": "6",
    "seven": "7",
    "eight": "8",
    "nine": "9",
    "ten": "10",
}
_NUMBER_WORD_RE = re.compile(r"\b(" + "|".join(_NUMBER_WORDS) + r")\b")


def _offline_instruments(lowered: str) -> list[str]:
    """
    Instrument names in a message, in the order they were named.

    Matched longest-first so "rhodes piano" is not also recorded as "piano",
    then put back into the order they appear in the sentence: that is the order
    the person said them, and it is the order the chips in the DraftCard will
    show.
    """
    found: list[str] = []
    for name in _INSTRUMENT_WORDS:
        if name in lowered and not any(name in picked for picked in found):
            found.append(name)
    return sorted(found, key=lowered.index)


def _offline_length(lowered: str) -> int | None:
    """
    Seconds, from the handful of ways people say a duration.

    Out-of-range answers are not rejected here — `_clean_int` clamps them, so
    "5 minutes" becomes the longest track RITHM makes rather than nothing.
    """
    if _HALF_MINUTE_RE.search(lowered) is not None:
        return 30
    spelled = _NUMBER_WORD_RE.sub(lambda match: _NUMBER_WORDS[match.group(1)], lowered)
    seconds = _SECONDS_RE.search(spelled)
    if seconds is not None:
        return int(seconds.group(1))
    minutes = _MINUTES_RE.search(spelled)
    if minutes is not None:
        return int(float(minutes.group(1)) * 60)
    # The bare check reads the ORIGINAL: after substitution a lone "a" is a 1.
    bare = _BARE_NUMBER_RE.match(lowered.strip())
    return int(bare.group(0)) if bare is not None else None


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

    length = _offline_length(lowered)
    if length is not None:
        values["length_seconds"] = length

    # The first message is the song. Every later one is an answer to a
    # question, and treating "energetic" as the whole description would
    # overwrite what they actually asked for.
    if draft.prompt is None:
        values["prompt"] = user_text

    # Carry the rest forward so the merge sees a complete picture.
    values["instruments"] = _offline_instruments(lowered) or draft.instruments
    return SongDraft.model_validate(values)


_OFFLINE_QUESTIONS: dict[str, str] = {
    "prompt": _OFFLINE_OPENING,
    "genre": _OFFLINE_GENRE,
    "mood": _OFFLINE_MOOD,
    "lyrics_mode": _OFFLINE_LYRICS,
    "voice": _OFFLINE_VOICE,
    "instruments": _OFFLINE_INSTRUMENTS,
    "length": _OFFLINE_LENGTH,
}


def _offline_question(step: str | None) -> str:
    """The fixed question for a step. No step left means the interview is over."""
    return _OFFLINE_QUESTIONS.get(step or "", _OFFLINE_DONE)


# ── The ladder ─────────────────────────────────────────────────────────────

_LADDER: tuple[str, ...] = (
    "prompt",
    "genre",
    "mood",
    "lyrics_mode",
    "voice",
    "instruments",
    "length",
)

# What each question sounds like, so one can be recognised in prose.
#
# TWO JOBS. It tells the ladder that a question has already been put — the last
# three steps cannot be answered wrong, since "surprise me" leaves voice null
# and "whatever fits" leaves instruments empty, so asking has to be what counts
# or the interview deadlocks one question short of done. And it tells the chips
# which question the MODEL just asked, which beats guessing from the draft when
# the two disagree.
#
# Matched in ladder order, so "sung or instrumental?" reads as the vocals
# question rather than the instruments one. That ordering is also why the
# instruments entry is the plural: "instrument" is a prefix of "instrumental",
# and the vocals question would otherwise cover a step nobody had asked about.
_TOPIC_WORDS: dict[str, tuple[str, ...]] = {
    "genre": ("genre", "style"),
    "mood": ("mood",),
    "lyrics_mode": ("sung", "instrumental", "vocals", "singing"),
    "voice": ("voice", "sing it", "sings it", "female", "male"),
    "instruments": ("instruments", "instrumentation", "line-up", "lineup"),
    "length": ("how long", "length", "seconds", "minute"),
}


def _asked_step(text: str) -> str | None:
    """Which of the questions a piece of prose is asking, if any."""
    lowered = text.casefold()
    return next(
        (
            step
            for step in _LADDER
            if step in _TOPIC_WORDS
            and any(word in lowered for word in _TOPIC_WORDS[step])
        ),
        None,
    )


def _next_step(draft: SongDraft, asked: str = "") -> str | None:
    """
    The first thing still missing. `asked` is the assistant's previous message.

    The first THREE are what `draft_is_ready` wants, so they are asked until
    they are answered. The rest are asked ONCE: they are the ones a person is
    entitled to wave away, and a ladder that waits for a value would put the
    same question on screen forever.

    Everything below the line is asked after the draft is already ready, on
    purpose — the DraftCard appears while the questions continue, and being
    able to leave early is the whole point of the door being open.
    """
    if draft.prompt is None:
        return "prompt"
    if draft.genre is None:
        return "genre"
    if draft.mood is None:
        return "mood"

    lowered = asked.casefold()

    def already_put(step: str) -> bool:
        return any(word in lowered for word in _TOPIC_WORDS[step])

    if draft.lyrics_mode is None and not already_put("lyrics_mode"):
        return "lyrics_mode"
    # Nothing sings on an instrumental — `_fields_agree` has already forced
    # voice to AUTO there, so this is skipped rather than answered. An UNASKED
    # vocals question lands here too: with `lyrics_mode` still None there is no
    # sung/instrumental decision to hang a voice on, so it waits its turn.
    if (
        draft.lyrics_mode is not None
        and draft.lyrics_mode is not LyricsMode.INSTRUMENTAL
        and draft.voice is None
        and not already_put("voice")
    ):
        return "voice"
    if not draft.instruments and not already_put("instruments"):
        return "instruments"
    if draft.length_seconds is None and not already_put("length"):
        return "length"
    return None


# ── Suggestions ────────────────────────────────────────────────────────────

_SUGGESTIONS: dict[str, list[str]] = {
    "genre": ["Lo-Fi", "EDM", "Cinematic"],
    "mood": ["Calm", "Energetic", "Dark"],
    "lyrics_mode": ["Sung", "Instrumental"],
    "voice": ["Female", "Male", "Surprise me"],
    "instruments": ["Piano", "Guitar", "Whatever fits"],
    "length": ["30 seconds", "1 minute", "2 minutes"],
}


def _chips(step: str | None) -> list[str]:
    """One-tap answers to a given question. A copy: the caller owns the list."""
    return list(_SUGGESTIONS.get(step or "", []))


def _suggestions(draft: SongDraft, asked: str = "") -> list[str]:
    """
    One-tap answers to whatever was just asked.

    Derived from the DRAFT and the question, not asked of the model: a second
    structured-output contract for three chips would be three more things that
    can silently come back malformed, and the chips are a shortcut rather than
    the menu — the text box is always there.

    Every chip is a phrase the offline parse recognises, so tapping one moves
    the draft on even with Bedrock switched off. "Whatever fits" and "Surprise
    me" deliberately parse to nothing: the ladder advances on having asked.
    """
    if draft.prompt is None:
        return []
    return _chips(_asked_step(asked) or _next_step(draft, asked))


# ── The turn ───────────────────────────────────────────────────────────────


async def run_turn(
    *, history: list[ConverseMessage], draft: SongDraft, voice: bool = False
) -> TurnResult:
    """
    One assistant turn. `history` ends with the user message being answered.

    Two model calls, EXTRACTION FIRST: nova-micro reads this message into the
    draft, then the chain writes the prose against the draft it just moved.
    With Bedrock switched off — the default, and what local, CI and the tests
    all run — neither happens and the scripted interviewer answers instead.

    The order is the fix for an interviewer that asked the same thing twice.
    Extraction used to run after the reply, which meant `_chat_system` was
    always built from the draft as it stood BEFORE the message being answered:
    the model was told "you do not know the mood yet" in the very turn the user
    named one, and it duly asked again. Nothing is paid for this — the two
    calls were already sequential, so the budget is the same either way.

    A failed extraction (timeout, malformed JSON) still returns an empty draft
    and the chain still runs, on the pre-turn draft. That is exactly the old
    behaviour, and it is the floor rather than the path.
    """
    settings = get_settings()
    user_text = _last_user_text(history)
    # The question this message is answering. It disambiguates a one-word reply
    # for the extractor, and it is what stops the interview asking a second
    # time for something nobody is going to give it.
    asked = _last_assistant_text(history)

    # A no-op when Bedrock is off — `_extract` reads DISABLED off the transport
    # the same way `_run_chain` does, and returns an empty draft. The offline
    # interviewer below parses the message itself.
    # TIMED, because until now nothing was. `chat_turn` carries a comment
    # claiming CloudWatch can answer "how much of our traffic is voice, and is
    # it slower?" and it could not: there was no duration on any line in this
    # module. A voice turn is two SEQUENTIAL model calls and the user waits for
    # both before hearing a word, so which of the two dominates is the whole
    # question — and it was being guessed at rather than read.
    extract_started = perf_counter()
    delta = await _extract(draft=draft, user_text=user_text, asked=asked)
    extract_ms = round((perf_counter() - extract_started) * 1000)
    merged = draft.merged_with(delta)

    chain_started = perf_counter()
    try:
        outcome, model_id, reply = await asyncio.wait_for(
            _run_chain(history=history, system=_chat_system(merged, voice=voice)),
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
        # `merged` is `draft` here — the extraction above was the same no-op,
        # so the offline parse starts from the untouched draft.
        delta = _offline_delta(user_text=user_text, draft=draft)
        merged = draft.merged_with(delta)
        step = _next_step(merged, asked)
        return TurnResult(
            reply=_offline_question(step),
            delta=delta,
            draft=merged,
            ready=draft_is_ready(merged),
            suggestions=_chips(step),
            offline=True,
        )

    if outcome is not ConverseOutcome.OK or reply is None:
        logger.warning("chat_chain_exhausted", models=len(settings.chat_model_ids))
        raise AssistantUnavailableException()

    chain_ms = round((perf_counter() - chain_started) * 1000)
    logger.info(
        "chat_turn_complete",
        model_id=model_id,
        reply_chars=len(reply),
        ready=draft_is_ready(merged),
        # The two halves separately, because the fix differs. Time in the chain
        # is answered by streaming the reply — the avatar could start on
        # sentence one instead of waiting for the last. Time in extraction is
        # answered by a smaller model or by not blocking the reply on it.
        extract_ms=extract_ms,
        chain_ms=chain_ms,
        total_ms=extract_ms + chain_ms,
    )
    return TurnResult(
        reply=reply.strip(),
        delta=delta,
        draft=merged,
        ready=draft_is_ready(merged),
        # Against the model's OWN reply: it chose the question, and chips for a
        # different one are worse than none.
        suggestions=_suggestions(merged, reply),
    )


def _last_user_text(history: list[ConverseMessage]) -> str:
    """The message this turn is answering. Empty only if the caller misused this."""
    return _last_text(history, "user")


def _last_assistant_text(history: list[ConverseMessage]) -> str:
    """The question being answered. Empty on the first turn of a conversation."""
    return _last_text(history, "assistant")


def _last_text(history: list[ConverseMessage], role: str) -> str:
    for message in reversed(history):
        if message["role"] == role:
            return " ".join(
                block.get("text", "") for block in message["content"]
            ).strip()
    return ""
