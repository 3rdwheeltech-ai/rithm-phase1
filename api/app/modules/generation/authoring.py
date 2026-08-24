"""
Lyrics and titles, written by a model at submit time.

Lives inside the generation module rather than in shared/ because the prompts
below are product copy about THIS module's domain — how a RITHM song is
structured, what ACE-Step's tags are, what a RITHM track is called. It imports
only app.shared.aws, app.config and its own module's schemas, so the
import-linter independence contract is untouched.

TWO RULES GOVERN EVERYTHING HERE
--------------------------------
1. Best-effort, never load-bearing. Every call gets a timeout and a fallback,
   and every failure degrades to the pre-Bedrock behaviour. A Bedrock outage
   must never turn a 202 into a 500: generation is the product, and an LLM
   garnish must not be able to take it down. That is why `write_lyrics`
   returns None rather than raising, and why `write_title` has a heuristic
   floor and returns a string on every path.

2. Never log lyric or title TEXT, only lengths — the same rule
   worker/worker/inference.py already follows for user lyrics. "Were there
   any, and roughly how much" is the first question when a track comes back
   wrong; the words themselves are user content and do not belong in a log
   aggregator.
"""

import asyncio
import re
from dataclasses import dataclass

import structlog

from app.config import get_settings
from app.modules.generation.schemas import (
    LYRICS_MAX_LENGTH,
    TITLE_MAX_LENGTH,
    Voice,
)
from app.shared.aws import converse

logger = structlog.get_logger()

# ACE-Step understands exactly these, lowercase, on their own line. The system
# prompt says so and step 4 of _sanitise_lyrics truncates on them, so the two
# have to agree.
_SECTION_TAGS = (
    "[intro]",
    "[verse]",
    "[pre-chorus]",
    "[chorus]",
    "[bridge]",
    "[outro]",
)

# Titles that would fit every song ever made. A model that reaches for one of
# these has told us nothing, so the heuristic floor beats it.
_BANNED_TITLES = frozenset(
    {
        "untitled",
        "untitled track",
        "new song",
        "song",
        "track",
        "music",
        "vibes",
        "melody",
        "rhythm",
        "harmony",
    }
)

_FALLBACK_TITLE = "Untitled track"


@dataclass(frozen=True, slots=True)
class AuthoringSpec:
    """Everything both authoring calls need, assembled once at the route."""

    prompt: str
    genre: str | None
    mood: str | None
    instruments: list[str]
    bpm: int | None
    length_seconds: int
    voice: Voice
    lyrics_prompt: str | None


# ── Lyrics ─────────────────────────────────────────────────────────────────

_LYRICS_SYSTEM = """\
You are RITHM's lyricist. What you write is fed VERBATIM into ACE-Step, a
text-to-music model, as the lyrics of a song that is about to be sung. Your
entire reply becomes that field. It must contain nothing but the words to be
sung and their section tags.

FORMAT — not negotiable:
- Section tags go on their own line, lowercase, in square brackets. The only
  tags ACE-Step understands are: [intro], [verse], [pre-chorus], [chorus],
  [bridge], [outro].
- Every other line is a line that will be sung, one per line.
- A blank line between sections. No blank line between a tag and its first line.
- No title. No headings, markdown, code fences, commentary, stage directions,
  "(x2)", numbering, or any explanation of your choices.
- English, unless the style brief is plainly in another language.
- To repeat a chorus, write it out again under a second [chorus] tag. ACE-Step
  does not expand repeat markers.

LENGTH — match the duration. Lyrics that overrun get sung at a rush or cut off
mid-word:
    up to 45s    [verse] [chorus]                                    8-12 lines
    46-90s       [verse] [chorus] [verse] [chorus]                  16-24 lines
    91-135s      ...plus a [bridge] before the final [chorus]       24-32 lines
    136-180s     [intro] [verse] [chorus] [verse] [chorus]
                 [bridge] [chorus] [outro]                          32-44 lines
Keep lines to roughly 6-10 syllables. A sung line is not a sentence.

CRAFT:
- The style brief describes the MUSIC. Your words sit inside it; they do not
  fight it. A dark cinematic brief does not get a cheerful chorus.
- The chorus is the hook: concrete, singable, and the SAME words every time.
- Concrete images over abstractions. No "journey", "destiny", "shining bright"
  unless the brief asks for precisely that.
- Never name the genre, the tempo, the instruments or the singer in the words.
- Stay under 1800 characters."""

_VOICE_PHRASE = {
    Voice.FEMALE: "a female voice",
    Voice.MALE: "a male voice",
    Voice.AUTO: "unspecified",
}


def _brief_lines(spec: AuthoringSpec) -> list[str]:
    """
    The style brief, shared by both calls so they cannot drift apart.

    The `Tempo:` line is OMITTED ENTIRELY when bpm is None rather than sent as
    "unspecified": a tempo the user did not choose is not a fact about the
    song, and stating it as one invites the model to write to a tempo nobody
    asked for.
    """
    lines = [
        f"Style brief: {spec.prompt}",
        f"Genre: {spec.genre or 'unspecified'}",
        f"Mood: {spec.mood or 'unspecified'}",
        f"Instruments: {', '.join(spec.instruments) or 'unspecified'}",
    ]
    if spec.bpm is not None:
        lines.append(f"Tempo: {spec.bpm} BPM")
    lines.append(f"Track length: {spec.length_seconds} seconds")
    lines.append(f"Lead vocal: {_VOICE_PHRASE[spec.voice]}")
    return lines


def _lyrics_user_turn(spec: AuthoringSpec) -> str:
    about = spec.lyrics_prompt or (
        "Nothing beyond the style brief. Write words that belong to that music."
    )
    return "\n".join(
        [
            *_brief_lines(spec),
            "",
            "What the song should be about:",
            about,
            "",
            "Write the lyrics now.",
        ]
    )


def _strip_fences(text: str) -> str:
    """Unwrap a whole reply the model put in a code fence."""
    stripped = text.strip()
    if not stripped.startswith("```"):
        return stripped
    lines = stripped.splitlines()
    # Drop the opening fence (and any language tag on it) and the closing one.
    lines = lines[1:]
    while lines and lines[-1].strip().startswith("```"):
        lines.pop()
    return "\n".join(lines).strip()


def _drop_preamble(text: str) -> str:
    """
    Drop everything before the first section tag — "Here are your lyrics:" and
    friends, which otherwise get SUNG.

    Only when the text contains a `[` at all. A tag-less reply is still usable
    lyrics; deleting it entirely because it has no tag turns a stylistic miss
    into an empty field.
    """
    if "[" not in text:
        return text
    lines = text.splitlines()
    for index, line in enumerate(lines):
        if line.lstrip().startswith("["):
            return "\n".join(lines[index:])
    return text


def _truncate_lyrics(text: str) -> str:
    """
    Bring an overlong reply under the bound WITHOUT cutting mid-line.

    Prefer the last section boundary that fits, so the song still ends on a
    whole section; fall back to the last newline. Never a raw character offset:
    ACE-Step sings the fragment.
    """
    if len(text) <= LYRICS_MAX_LENGTH:
        return text

    head = text[:LYRICS_MAX_LENGTH]
    lowered = head.lower()
    cut = max(lowered.rfind(f"\n{tag}") for tag in _SECTION_TAGS)
    if cut <= 0:
        cut = head.rfind("\n")
    return head[:cut].rstrip() if cut > 0 else head[: head.rfind(" ")].rstrip()


def _sanitise_lyrics(text: str) -> str | None:
    """
    Belt and braces to the system prompt's "nothing but the words".

    The order matters: unwrap the fence FIRST, or the preamble check sees a
    ``` line rather than the model's own text and the fence survives into the
    song.
    """
    cleaned = _drop_preamble(_strip_fences(text))
    # Three or more blank lines read as a section break to nothing. One is the
    # separator the prompt asks for.
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned).strip()
    cleaned = _truncate_lyrics(cleaned).strip()
    return cleaned or None


async def write_lyrics(spec: AuthoringSpec) -> str | None:
    """
    Words for a sung track, or None.

    None means "nobody could write these" — the caller records
    lyrics_source="acestep" and the request proceeds unchanged, with ACE-Step's
    own LM planning phase getting the empty field exactly as it did before this
    module existed.
    """
    settings = get_settings()
    try:
        reply = await asyncio.wait_for(
            converse(
                model_id=settings.bedrock_lyrics_model_id,
                system=_LYRICS_SYSTEM,
                user=_lyrics_user_turn(spec),
                max_tokens=1200,
                temperature=0.8,
            ),
            timeout=settings.bedrock_lyrics_timeout_seconds,
        )
    except TimeoutError:
        # A latency budget, not a generosity setting: this sits in front of a
        # 202 the user is watching a button spinner for.
        logger.warning("lyrics_authoring_timed_out")
        return None
    except Exception as exc:
        # Deliberately blind. `converse` already swallows every AWS failure it
        # knows about, so anything arriving here is something nobody
        # anticipated — and rule 1 says an unanticipated failure degrades, it
        # does not 500 a submit. The class only: an exception message can
        # carry the prompt, and prompts carry user content.
        logger.warning("lyrics_authoring_failed", error=type(exc).__name__)
        return None

    if reply is None:
        return None
    lyrics = _sanitise_lyrics(reply)
    # Lengths only — never the words.
    logger.info(
        "lyrics_authored",
        reply_chars=len(reply),
        lyrics_chars=len(lyrics) if lyrics else 0,
    )
    return lyrics


# ── Titles ─────────────────────────────────────────────────────────────────

_TITLE_SYSTEM = """\
You name songs. You are given a song's style brief and, when it has any, its
lyrics. You reply with the title. Nothing else.

- Two or three words. Never one, never four.
- Title Case. No quotation marks, no trailing punctuation, no emoji.
- Never "Untitled", "New Song", "Song", "Track", "Music", "Vibes", "Melody",
  "Rhythm", "Harmony", or any other word that would fit every song ever made.
- Do not name the genre, the mood, the tempo or an instrument. "Lo-Fi Piano
  Dreams" is a rejected answer: it describes the file, not the song.
- When lyrics are supplied, prefer a concrete phrase taken or adapted from the
  chorus.
- No preamble, no explanation, no alternatives. The whole reply is the title."""

# Enough of the song for the chorus to be in view without paying for the rest.
_TITLE_LYRICS_CHARS = 600


def _title_user_turn(spec: AuthoringSpec, lyrics: str | None) -> str:
    excerpt = lyrics[:_TITLE_LYRICS_CHARS] if lyrics else "(instrumental — no lyrics)"
    return "\n".join([*_brief_lines(spec), "", "Lyrics:", excerpt, "", "Title:"])


def _sanitise_title(text: str) -> str | None:
    """
    Reduce a reply to the title it should have been, or None.

    None means the model answered with something that names every song ever
    made (or nothing at all), and the caller falls back to the prompt
    heuristic — which at least describes THIS song.
    """
    first = next((line for line in text.splitlines() if line.strip()), "")
    first = re.sub(r"^\s*title\s*:\s*", "", first, flags=re.IGNORECASE)
    first = first.strip().strip("\"'“”‘’*").strip()
    first = first.rstrip(".!").strip()
    first = re.sub(r"\s+", " ", first)

    words = first.split(" ")
    if len(words) > 3:
        first = " ".join(words[:3])
    first = first[:TITLE_MAX_LENGTH].strip()

    if not first or first.lower() in _BANNED_TITLES:
        return None
    return first


async def write_title(spec: AuthoringSpec, *, lyrics: str | None) -> str:
    """
    A name for the track. NEVER None.

    Three floors, in order: the model's answer, the prompt heuristic, and
    "Untitled track". A track with no name at all is not a state the library
    can render, so this function does not have a failure mode.
    """
    settings = get_settings()
    try:
        reply = await asyncio.wait_for(
            converse(
                model_id=settings.bedrock_title_model_id,
                system=_TITLE_SYSTEM,
                user=_title_user_turn(spec, lyrics),
                max_tokens=20,
                temperature=0.9,
            ),
            timeout=settings.bedrock_title_timeout_seconds,
        )
    except TimeoutError:
        logger.warning("title_authoring_timed_out")
        reply = None
    except Exception as exc:  # see write_lyrics — degrade, never 500
        logger.warning("title_authoring_failed", error=type(exc).__name__)
        reply = None

    named = _sanitise_title(reply) if reply is not None else None
    logger.info("title_authored", from_model=named is not None)
    return named or derive_title_from_prompt(spec.prompt)


# ── The floor ──────────────────────────────────────────────────────────────

# A PORT of web/src/lib/track.ts's derivation, kept deliberately identical.
# The two implementations must agree: the client still derives a name for every
# track written before the title column existed, and a track that renames
# itself the moment the server starts naming things is worse than either.
# web/src/lib/track.test.ts is the reference, and tests/test_authoring.py
# reuses its cases verbatim.
_DERIVED_TITLE_MAX_LENGTH = 48

_LEADING_NOISE = [
    # No \b after this one: "e.g." ends in a period, and there is no word
    # boundary between "." and the following space.
    re.compile(
        r"^(?:e\.?\s?g\.?|for example|please|can you|could you|"
        r"i(?:'d| would) like|i want)[\s.,:;-]*",
        re.IGNORECASE,
    ),
    re.compile(
        r"^(?:make|create|generate|compose|write|produce|build|give)\s+(?:me\s+)?",
        re.IGNORECASE,
    ),
    re.compile(r"^(?:a|an|the)\b", re.IGNORECASE),
    re.compile(
        r"^(?:song|track|piece|tune|melody|music)\s+"
        r"(?:about|for|that|which|with|in)\b",
        re.IGNORECASE,
    ),
]

_LEADING_PUNCT = re.compile(r"^[\s,:;–—-]+")
_TRAILING_PUNCT = re.compile(r"[\s,;:–—-]+$")
_CLAUSE_SPLIT = re.compile(r"[,.—–\n]")


def _peel(text: str) -> str:
    """Strip stacked filler prefixes, bounded so a pathological prompt cannot spin."""
    out = text
    for _ in range(len(_LEADING_NOISE) * 2):
        before = out
        for pattern in _LEADING_NOISE:
            out = _LEADING_PUNCT.sub("", pattern.sub("", out, count=1), count=1)
        if out == before:
            break
    return out


def _clip(text: str, limit: int) -> str:
    """Trim to a word boundary rather than mid-word, and mark the cut."""
    if len(text) <= limit:
        return text
    cut = text[:limit]
    last_space = cut.rfind(" ")
    # Only honour the boundary if it is not so early that the label loses its
    # sense — a single very long word still gets a hard cut.
    kept = cut[:last_space] if last_space > limit * 0.6 else cut
    return f"{_TRAILING_PUNCT.sub('', kept)}…"


def derive_title_from_prompt(prompt: str) -> str:
    """
    Name a track from its prompt alone. The floor under everything above.

    The first clause of a prompt is usually a good name, but only once the
    instruction wrapper people type around it is taken off the front.
    """
    text = re.sub(r"\s+", " ", prompt).strip()
    if not text:
        return _FALLBACK_TITLE

    # Peel BEFORE splitting into clauses: "e.g." carries a period, so a clause
    # split on the raw prompt would slice the filler itself in half and title
    # the track "E". Peel again after, for filler exposed by the split.
    first_clause = _CLAUSE_SPLIT.split(_peel(text))[0].strip() or text
    label = _peel(first_clause)
    # Reverted if peeling ate everything — a prompt of pure filler still needs
    # a name, and its own words beat "Untitled track".
    if not label.strip():
        label = first_clause

    label = _clip(_TRAILING_PUNCT.sub("", label), _DERIVED_TITLE_MAX_LENGTH)
    if not label:
        return _FALLBACK_TITLE

    # Only the first letter — anything more would flatten "lo-fi" and "EDM".
    return label[0].upper() + label[1:]
