"""
Conversation wire DTOs, and the draft the chat is building towards.

THE VOCABULARIES ARE RE-DECLARED, NOT IMPORTED
----------------------------------------------
GENRES, MOODS, LyricsMode, Voice and the length bounds below all exist
elsewhere — in `catalog/models.py` and `generation/schemas.py`. import-linter's
"Module independence" contract (pyproject.toml) lists
`app.modules.conversation`, so this module may not reach for either. This is
the same trade `identity/models.py` and `generation/schemas.py` already make,
and it is handled the same way: `tests/test_chat_schemas.py` pins these copies
against the originals. Tests sit outside the `app` root package, so a test may
import both trees; application code may not.

That makes this copy #4. Hoisting the vocabulary into `app/shared/` (which is
not in the contract) is legal and is probably right at copy #5 — but it is a
three-module refactor plus two pin tests, and it does not belong inside a
feature change.

THE BOUNDS ARE NOT DECORATIVE
-----------------------------
`SongDraft` is handed to the SPA, which seeds the Create form with it, which
POSTs it to `/tracks/generate`. Every bound here is the matching bound in
`GenerateRequest`, so a draft that validates cannot produce a 422 the user
reads as "the chatbot broke Create".

And every value in it came out of a language model, then goes back INTO the
system prompt on the next turn — so the draft is a persistent injection
surface as well as a wire DTO. Everything is therefore sanitised and clamped on
WRITE, in `_coerce`, rather than trusted on read. `_coerce` NORMALISES rather
than refuses: this is a draft being repaired, not a request being validated.
"""

from datetime import datetime
from enum import StrEnum
from typing import Literal, Self, cast
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

# ── Vocabularies (re-declared — see the module docstring) ──────────────────

GENRES: tuple[str, ...] = (
    "Pop",
    "Hip-Hop",
    "EDM",
    "Lo-Fi",
    "Cinematic",
    "Rock",
    "Country",
    "R&B",
    "Ambient",
)
MOODS: tuple[str, ...] = (
    "Happy",
    "Calm",
    "Energetic",
    "Dark",
    "Romantic",
    "Inspirational",
    "Dramatic",
)


class LyricsMode(StrEnum):
    """Where the words come from — and only that. Mirrors generation's copy."""

    WRITE = "write"
    PROMPT = "prompt"
    INSTRUMENTAL = "instrumental"


class Voice(StrEnum):
    """The requested lead vocal. Mirrors generation's copy."""

    AUTO = "auto"
    FEMALE = "female"
    MALE = "male"


# ── Bounds (re-declared — every one mirrors GenerateRequest) ───────────────

PROMPT_MAX_LENGTH = 2000
TITLE_MAX_LENGTH = 80
LYRICS_MAX_LENGTH = 3000
LYRICS_PROMPT_MAX_LENGTH = 600
INSTRUMENT_MAX_LENGTH = 40
MAX_INSTRUMENTS = 10
LENGTH_MIN_SECONDS = 10
LENGTH_MAX_SECONDS = 180
BPM_MIN = 20
BPM_MAX = 300

# What one chat turn may carry. Short on purpose: this is a conversation, not
# the lyrics box — and every message is echoed back into the model's context,
# so an unbounded field here is an unbounded token bill as well as an
# unbounded column.
CHAT_MESSAGE_MAX_LENGTH = 1000

# A ceiling on one record POST, not on the conversation. The client debounces
# and flushes what Anam's history event gave it; a handful of turns is the
# realistic batch and anything near this bound means the client is replaying
# history it should have de-duplicated.
MAX_RECORDED_TURNS = 20


# ── Sanitisers ─────────────────────────────────────────────────────────────


def _clean_text(value: object, limit: int) -> str | None:
    """A trimmed, bounded string — or None for anything that is not usable."""
    if not isinstance(value, str):
        return None
    # Collapse the newline runs a model likes to pad JSON strings with, but
    # keep single newlines: lyrics are multi-line by nature.
    cleaned = value.strip()[:limit].strip()
    return cleaned or None


def _clean_choice(value: object, allowed: tuple[str, ...]) -> str | None:
    """
    Narrow a model's answer onto the real vocabulary, case-insensitively.

    Anything outside it is DROPPED rather than passed through. A genre the
    Create form has no option for would render as a blank select, which reads
    as the handoff having lost it.
    """
    if not isinstance(value, str):
        return None
    folded = value.strip().casefold()
    return next((item for item in allowed if item.casefold() == folded), None)


def _clean_int(value: object, low: int, high: int) -> int | None:
    """Clamp into range. A number just outside a bound is a near miss, not a lie."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return min(max(int(value), low), high)


def _clean_instruments(value: object) -> list[str]:
    """At most MAX_INSTRUMENTS lowercase names, deduped, each bounded."""
    if not isinstance(value, list):
        return []
    items = cast(list[object], value)
    out: list[str] = []
    for item in items:
        name = _clean_text(item, INSTRUMENT_MAX_LENGTH)
        if name is None:
            continue
        lowered = name.lower()
        if lowered not in out:
            out.append(lowered)
        if len(out) == MAX_INSTRUMENTS:
            break
    return out


def _clean_enum(value: object, enum: type[StrEnum]) -> str | None:
    if not isinstance(value, str):
        return None
    folded = value.strip().casefold()
    return next((member.value for member in enum if member.value == folded), None)


class SongDraft(BaseModel):
    """
    What the conversation has collected so far.

    Every field is optional — the whole point of the chat is that it fills in
    over several turns, and a half-built draft is the normal state rather than
    an error.
    """

    prompt: str | None = Field(default=None, min_length=1, max_length=PROMPT_MAX_LENGTH)
    title: str | None = Field(default=None, max_length=TITLE_MAX_LENGTH)
    genre: str | None = None
    mood: str | None = None
    instruments: list[str] = Field(default_factory=list, max_length=MAX_INSTRUMENTS)
    length_seconds: int | None = Field(
        default=None, ge=LENGTH_MIN_SECONDS, le=LENGTH_MAX_SECONDS
    )
    bpm_min: int | None = Field(default=None, ge=BPM_MIN, le=BPM_MAX)
    bpm_max: int | None = Field(default=None, ge=BPM_MIN, le=BPM_MAX)
    lyrics_mode: LyricsMode | None = None
    voice: Voice | None = None
    lyrics: str | None = Field(default=None, max_length=LYRICS_MAX_LENGTH)
    lyrics_prompt: str | None = Field(default=None, max_length=LYRICS_PROMPT_MAX_LENGTH)

    @model_validator(mode="before")
    @classmethod
    def _coerce(cls, data: object) -> object:
        """
        Repair, never refuse.

        This runs BEFORE the field bounds above, and its job is to make sure
        they can never fire: the input is model output, and a raise here would
        throw away eleven good fields because the twelfth came back as
        "medium". Out-of-vocabulary values are dropped, numbers are clamped,
        text is trimmed to its bound.

        The bounds are still declared on the fields, and that is deliberate
        belt-and-braces: if this misses something, extraction fails loudly for
        that one turn and the stored draft is left untouched — which is a far
        better failure than a draft that 422s at Create.
        """
        if not isinstance(data, dict):
            return data
        raw = cast(dict[str, object], data)
        return {
            "prompt": _clean_text(raw.get("prompt"), PROMPT_MAX_LENGTH),
            "title": _clean_text(raw.get("title"), TITLE_MAX_LENGTH),
            "genre": _clean_choice(raw.get("genre"), GENRES),
            "mood": _clean_choice(raw.get("mood"), MOODS),
            "instruments": _clean_instruments(raw.get("instruments")),
            "length_seconds": _clean_int(
                raw.get("length_seconds"), LENGTH_MIN_SECONDS, LENGTH_MAX_SECONDS
            ),
            "bpm_min": _clean_int(raw.get("bpm_min"), BPM_MIN, BPM_MAX),
            "bpm_max": _clean_int(raw.get("bpm_max"), BPM_MIN, BPM_MAX),
            "lyrics_mode": _clean_enum(raw.get("lyrics_mode"), LyricsMode),
            "voice": _clean_enum(raw.get("voice"), Voice),
            "lyrics": _clean_text(raw.get("lyrics"), LYRICS_MAX_LENGTH),
            "lyrics_prompt": _clean_text(
                raw.get("lyrics_prompt"), LYRICS_PROMPT_MAX_LENGTH
            ),
        }

    @model_validator(mode="after")
    def _fields_agree(self) -> Self:
        """
        The same biconditional GenerateRequest._lyric_fields_agree enforces,
        NORMALISED rather than raised.

        GenerateRequest 422s these pairings because a request has to mean one
        thing. A draft is a work in progress that a model has been guessing at,
        so the honest response to "instrumental, female vocal" is to keep the
        decision the user actually made about words and quietly fix the rest.
        """
        if self.lyrics_mode is LyricsMode.INSTRUMENTAL:
            # A gender for a track with no singer is meaningless, and lyrics
            # with vocal=false are unrepresentable downstream: the worker's
            # [Instrumental] token IS the lyrics field.
            self.lyrics = None
            self.lyrics_prompt = None
            self.voice = Voice.AUTO
        elif self.lyrics_mode is LyricsMode.WRITE:
            self.lyrics_prompt = None
        elif self.lyrics_mode is LyricsMode.PROMPT:
            self.lyrics = None

        # Both or neither: GenerateRequest takes a RANGE, and one half of a
        # range is not a tempo. Order them too, rather than 422ing at submit.
        if self.bpm_min is None or self.bpm_max is None:
            self.bpm_min = None
            self.bpm_max = None
        elif self.bpm_min > self.bpm_max:
            self.bpm_min, self.bpm_max = self.bpm_max, self.bpm_min
        return self

    def merged_with(self, delta: "SongDraft") -> "SongDraft":
        """
        Fold a turn's delta onto this draft. Non-null wins; `instruments`
        replaces wholesale.

        A list cannot be merged field-wise without deciding whether "drums" was
        added or the whole line-up was restated, and the extractor is told to
        restate. Replacing is also what makes "actually, no drums" work at all.
        """
        instruments = delta.instruments or self.instruments
        base = self.model_dump()
        base.update(
            {
                k: v
                for k, v in delta.model_dump().items()
                if v is not None and k != "instruments"
            }
        )
        base["instruments"] = instruments
        return SongDraft.model_validate(base)


def draft_is_ready(draft: SongDraft) -> bool:
    """
    Whether the Create form has enough to open on.

    Derived HERE, server-side, from the merged draft — never read off a flag
    the model sets about its own work. A model that decides it is finished is
    reporting a mood, not a fact, and the DraftCard appearing over an empty
    form is the one failure the user cannot recover from without starting over.

    THREE THINGS: what the song is, its genre, its mood. Nothing else is
    withheld for, and the bar is deliberately low — the door opening is not the
    interview ending. Vocals, voice, instruments and length all keep being
    asked afterwards, one at a time, with the card already on screen; the
    person answers as many as they feel like and leaves whenever they want.

    Vocals used to be the fourth condition and is not any more. It has a form
    default like the rest of them (`lyrics_mode ?? "write"`, web/src/lib/chat.ts)
    and holding the door shut for it cost a whole extra turn for something the
    Create form asks in a two-option toggle.
    """
    return (
        draft.prompt is not None and draft.genre is not None and draft.mood is not None
    )


# ── Wire DTOs ──────────────────────────────────────────────────────────────


class ChatMessageOut(BaseModel):
    id: UUID
    role: str
    content: str
    created_at: datetime


class ChatTurnRequest(BaseModel):
    # Stripped BEFORE the bounds are checked, which is what makes min_length
    # mean something: a box the user tabbed through arrives as three spaces,
    # and three spaces is a turn the assistant cannot answer.
    model_config = ConfigDict(str_strip_whitespace=True)

    message: str = Field(min_length=1, max_length=CHAT_MESSAGE_MAX_LENGTH)

    # Which door this turn came through. DEFAULTED, so no client breaks and the
    # deploy window is safe — an older SPA that knows nothing about voice keeps
    # posting valid bodies.
    #
    # It earns its place twice: it puts `voice=<bool>` on the existing
    # `chat_turn` log line, which makes "how much of our traffic is voice, and
    # is it slower?" answerable from CloudWatch; and it is what finally writes
    # `sessions.voice_enabled`, a column that has existed since the baseline
    # migration and has never had a writer.
    source: Literal["chat", "voice"] = "chat"


class ChatTurnResponse(BaseModel):
    message: ChatMessageOut
    draft: SongDraft
    ready: bool
    # One-tap answers to whatever the assistant just asked. Chips, not a menu:
    # the panel is 245px wide and a full option list would not fit.
    suggestions: list[str] = Field(default_factory=list)


class RecordedTurn(BaseModel):
    """One line of a voice conversation Anam's own model conducted."""

    model_config = ConfigDict(str_strip_whitespace=True)

    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=CHAT_MESSAGE_MAX_LENGTH)


class VoiceTurnRecordRequest(BaseModel):
    """
    POST /chat/turns/record — the transcript of a turn Anam already spoke.

    THIS ROUTE GENERATES NOTHING. Since the avatar answers with Anam's own LLM
    (see config.anam_llm_id), the reply exists before the server hears about
    it. What the server still owns is the RECORD: the durable transcript Chat
    reads, and the structured SongDraft that pre-fills the Create form. Without
    this the conversation would be fast and completely unusable — nothing
    captured, nothing validated, and no handoff to Create.

    An ORDERED LIST rather than a user/assistant pair, because Anam's
    MESSAGE_HISTORY_UPDATED carries a history array and the client can flush
    two user utterances that both arrived before the persona answered. The
    caller's order is the record's order.
    """

    turns: list[RecordedTurn] = Field(min_length=1, max_length=MAX_RECORDED_TURNS)


class VoiceTurnRecordResponse(BaseModel):
    """
    The draft as it stands after extraction, and nothing else.

    No `message` and no `suggestions`: there is no reply to hand back, and
    chips would be one-tap answers to a question this server never asked.
    """

    draft: SongDraft
    ready: bool


class ChatSessionResponse(BaseModel):
    """
    GET /chat/session. `session_id` is None when the user has never sent a
    message — a bare GET must not create a row (see service.start).
    """

    session_id: UUID | None
    messages: list[ChatMessageOut]
    draft: SongDraft
    ready: bool
    # How the SPA learns voice exists WITHOUT spending the one global Anam slot
    # to find out. Asking the token route would mint a token and claim the slot
    # to answer a yes/no question; this GET is already fetched on Home mount
    # with staleTime: Infinity, so it costs nothing. The 501 from the POST
    # stays as the backstop for the race where the flag flips between the two
    # calls.
    voice_available: bool = False


class VoiceSessionResponse(BaseModel):
    """
    A one-hour bearer credential for a three-minute session.

    NEVER CACHED AND NEVER LOGGED. The token outlives its usefulness by twenty
    times, so the SPA fetches it with a plain `request()` and holds it in a ref
    — putting it in a react-query cache entry would leave it visible in
    devtools for ten minutes after the call ended. The route sets
    `Cache-Control: no-store` for the same reason.
    """

    session_token: str
    # The SPA's countdown runs off THIS, never off a hardcoded 180. The cap is a
    # vendor fact, and a client that hardcodes it starts lying the day the plan
    # changes.
    expires_in_seconds: int
    # Returned so DELETE can prove it owns the slot: a stale tab's unload must
    # not free the lease the user's current tab is holding.
    lease_id: UUID
