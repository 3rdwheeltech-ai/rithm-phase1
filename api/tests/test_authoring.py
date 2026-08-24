"""
The authoring module: prompt assembly, both sanitisers, and the floor.

A hand-rolled fake stands in for `converse` rather than a moto round-trip,
per the house rule — moto would test botocore, and the parts that can actually
be wrong here are the prompt we send and the reply we accept.

The floor (`derive_title_from_prompt`) is a port of web/src/lib/track.ts, and
the cases below are lifted VERBATIM from web/src/lib/track.test.ts. The two
implementations must agree: the client still derives a name for every track
written before the title column existed, and a track that renames itself the
moment the server starts naming things is worse than either.
"""

# The sanitisers are private and probed directly: they are what stands between
# a chatty model and a preamble getting sung, and driving them through the
# public path would need a Bedrock account.
# pyright: reportPrivateUsage=false
from typing import Any

import pytest

from app.config import get_settings
from app.modules.generation import authoring
from app.modules.generation.authoring import AuthoringSpec, derive_title_from_prompt
from app.modules.generation.schemas import LYRICS_MAX_LENGTH, TITLE_MAX_LENGTH, Voice


def _spec(**overrides: Any) -> AuthoringSpec:
    defaults: dict[str, Any] = {
        "prompt": "warm lo-fi piano loop",
        "genre": "Lo-Fi",
        "mood": "Calm",
        "instruments": ["piano", "rhodes"],
        "bpm": 85,
        "length_seconds": 90,
        "voice": Voice.FEMALE,
        "lyrics_prompt": "a late drive home",
    }
    return AuthoringSpec(**{**defaults, **overrides})


class FakeConverse:
    """Records every turn and answers with whatever it was handed."""

    def __init__(self, reply: str | None = "…") -> None:
        self.reply = reply
        self.calls: list[dict[str, Any]] = []

    async def __call__(self, **kwargs: Any) -> str | None:
        self.calls.append(kwargs)
        return self.reply


@pytest.fixture(autouse=True)
def clear_settings() -> None:
    get_settings.cache_clear()


# ── the user turn ──────────────────────────────────────────────────────────


def test_the_brief_carries_every_control_the_model_can_use() -> None:
    turn = authoring._lyrics_user_turn(_spec())

    assert "Style brief: warm lo-fi piano loop" in turn
    assert "Genre: Lo-Fi" in turn
    assert "Mood: Calm" in turn
    assert "Instruments: piano, rhodes" in turn
    assert "Tempo: 85 BPM" in turn
    assert "Track length: 90 seconds" in turn
    assert "Lead vocal: a female voice" in turn
    assert "a late drive home" in turn


def test_an_unset_tempo_is_omitted_rather_than_called_unspecified() -> None:
    """
    A tempo the user did not choose is not a fact about the song. Sending
    "Tempo: unspecified" invites the model to write to a tempo nobody asked
    for; the absent line says nothing at all, which is the truth.
    """
    turn = authoring._lyrics_user_turn(_spec(bpm=None))

    assert "Tempo" not in turn
    # ...while the controls that WERE set still say "unspecified" happily.
    assert "Genre: unspecified" in authoring._lyrics_user_turn(_spec(genre=None))


def test_no_brief_asks_for_words_that_belong_to_the_music() -> None:
    turn = authoring._lyrics_user_turn(_spec(lyrics_prompt=None))

    assert "Nothing beyond the style brief" in turn


def test_the_title_turn_quotes_the_lyrics_or_says_there_are_none() -> None:
    with_words = authoring._title_user_turn(_spec(), "[chorus]\nDrive it off")
    assert "[chorus]\nDrive it off" in with_words
    assert with_words.rstrip().endswith("Title:")

    assert "(instrumental — no lyrics)" in authoring._title_user_turn(_spec(), None)


# ── _sanitise_lyrics ───────────────────────────────────────────────────────


def test_a_whole_reply_in_a_code_fence_is_unwrapped() -> None:
    fenced = "```\n[verse]\nNeon rain\n\n[chorus]\nDrive\n```"

    assert authoring._sanitise_lyrics(fenced) == "[verse]\nNeon rain\n\n[chorus]\nDrive"


def test_a_preamble_is_dropped_rather_than_sung() -> None:
    """
    "Here are your lyrics:" reaches ACE-Step's lyrics field verbatim, and
    ACE-Step sings whatever is in it. The system prompt forbids this; this is
    the belt to that braces.
    """
    chatty = "Here are your lyrics:\n\n[verse]\nNeon rain\n"

    assert authoring._sanitise_lyrics(chatty) == "[verse]\nNeon rain"


def test_a_fence_around_a_preamble_is_unwrapped_before_the_preamble_is_read() -> None:
    """Order matters: fence first, or the preamble check only sees ```."""
    both = "```text\nHere are the lyrics:\n[verse]\nNeon rain\n```"

    assert authoring._sanitise_lyrics(both) == "[verse]\nNeon rain"


def test_a_tag_less_reply_survives_instead_of_being_deleted() -> None:
    """
    The preamble strip is anchored on the first `[`. Applied unconditionally it
    would delete a reply that simply has no tags — turning a stylistic miss
    into an empty lyrics field, which is a much worse outcome.
    """
    plain = "Neon on the wet street\nEngine running low"

    assert authoring._sanitise_lyrics(plain) == plain


def test_runs_of_blank_lines_collapse_to_one() -> None:
    gappy = "[verse]\nNeon rain\n\n\n\n\n[chorus]\nDrive"

    assert authoring._sanitise_lyrics(gappy) == "[verse]\nNeon rain\n\n[chorus]\nDrive"


def test_an_overlong_reply_is_cut_at_a_section_never_mid_line() -> None:
    """
    ACE-Step sings the fragment. A cut at a character offset produces a track
    that ends mid-word, which sounds like a bug in the audio pipeline and is
    debugged there for an afternoon.
    """
    section = "[verse]\n" + "Neon on the wet street\n" * 20 + "\n"
    long = section * 12
    assert len(long) > LYRICS_MAX_LENGTH

    cleaned = authoring._sanitise_lyrics(long)

    assert cleaned is not None
    assert len(cleaned) <= LYRICS_MAX_LENGTH
    # Ends on a whole line, and on a whole section.
    assert cleaned.endswith("Neon on the wet street")
    assert cleaned.count("[verse]") >= 1


def test_a_tag_less_overlong_reply_still_falls_back_to_a_line_boundary() -> None:
    long = "Neon on the wet street\n" * 400

    cleaned = authoring._sanitise_lyrics(long)

    assert cleaned is not None
    assert len(cleaned) <= LYRICS_MAX_LENGTH
    assert cleaned.endswith("Neon on the wet street")


def test_a_blank_reply_becomes_none() -> None:
    """None is what makes the caller record lyrics_source='acestep'."""
    assert authoring._sanitise_lyrics("   \n\n  ") is None
    assert authoring._sanitise_lyrics("```\n\n```") is None


# ── _sanitise_title ────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("reply", "expected"),
    [
        ("Wet Road Nights", "Wet Road Nights"),
        ('"Wet Road Nights"', "Wet Road Nights"),
        ("**Wet Road Nights**", "Wet Road Nights"),
        ("Title: Wet Road Nights", "Wet Road Nights"),
        ("title:  Wet Road Nights ", "Wet Road Nights"),
        ("Wet Road Nights.", "Wet Road Nights"),
        ("Wet Road Nights!", "Wet Road Nights"),
        # Four words or seven, the first three are the title.
        ("Wet Road Nights In The Rain City", "Wet Road Nights"),
        ("\n\nWet Road Nights\nor maybe something else", "Wet Road Nights"),
    ],
)
def test_a_title_is_reduced_to_the_title(reply: str, expected: str) -> None:
    assert authoring._sanitise_title(reply) == expected


@pytest.mark.parametrize("reply", ["Untitled", "untitled", "Song", "Vibes", "   ", ""])
def test_a_title_that_would_fit_every_song_is_refused(reply: str) -> None:
    """
    None here sends the caller to the prompt heuristic — which at least
    describes THIS song, rather than every song ever made.
    """
    assert authoring._sanitise_title(reply) is None


def test_a_title_is_clipped_to_the_column_bound() -> None:
    assert (
        len(authoring._sanitise_title("Antidisestablishmentarianism " * 3) or "")
        <= TITLE_MAX_LENGTH
    )


# ── the public calls ───────────────────────────────────────────────────────


async def test_nothing_is_asked_of_bedrock_while_it_is_disabled() -> None:
    """
    OFF is the default, so local, CI and every test above take the fallback
    path — which is both the correct behaviour without credentials and free
    coverage of the degradation §0.1 rests on.
    """
    assert get_settings().bedrock_enabled is False

    assert await authoring.write_lyrics(_spec()) is None
    # ...and the title still comes back, from the prompt.
    assert await authoring.write_title(_spec(), lyrics=None) == "Warm lo-fi piano loop"


async def test_a_disabled_bedrock_constructs_no_client(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The switch is checked before boto3 is touched, not after."""
    from app.shared import aws

    def _explode() -> Any:
        raise AssertionError("a client was built for a disabled Bedrock")

    monkeypatch.setattr(aws, "_bedrock_client", _explode)

    assert await authoring.write_lyrics(_spec()) is None


async def test_lyrics_go_out_with_the_configured_model_and_sampling(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake = FakeConverse("[verse]\nNeon rain")
    monkeypatch.setattr(authoring, "converse", fake)

    assert await authoring.write_lyrics(_spec()) == "[verse]\nNeon rain"

    call = fake.calls[0]
    assert call["model_id"] == get_settings().bedrock_lyrics_model_id
    assert call["max_tokens"] == 1200
    assert call["temperature"] == 0.8
    assert "fed VERBATIM into ACE-Step" in call["system"]


async def test_a_model_that_cannot_answer_yields_none(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(authoring, "converse", FakeConverse(None))

    assert await authoring.write_lyrics(_spec()) is None


async def test_a_title_falls_back_to_the_heuristic_and_never_raises(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """
    write_title has no failure mode. A track with no name at all is not a
    state the library can render.
    """

    async def _explode(**_kwargs: Any) -> str | None:
        raise RuntimeError("bedrock is having a day")

    monkeypatch.setattr(authoring, "converse", _explode)

    assert (
        await authoring.write_title(
            _spec(prompt="create a song about rainy nights"), lyrics=None
        )
        == "Rainy nights"
    )


async def test_a_banned_title_falls_through_to_the_heuristic(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(authoring, "converse", FakeConverse("Untitled"))

    assert await authoring.write_title(_spec(), lyrics=None) == "Warm lo-fi piano loop"


async def test_a_lyric_timeout_degrades_rather_than_propagating(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """
    These calls sit in front of a 202 the user is watching a button spinner
    for, so the timeout is a latency budget — and blowing it must cost the
    lyrics, never the job.
    """

    async def _hang(**_kwargs: Any) -> str | None:
        raise TimeoutError

    monkeypatch.setattr(authoring, "converse", _hang)

    assert await authoring.write_lyrics(_spec()) is None


# ── the floor, against web/src/lib/track.test.ts ───────────────────────────


@pytest.mark.parametrize(
    ("prompt", "expected"),
    [
        # "takes the first clause of a descriptive prompt"
        ("warm lo-fi piano, soft vinyl crackle, rain", "Warm lo-fi piano"),
        # "strips the instruction wrapper people type around a prompt"
        ("create a song about rainy nights", "Rainy nights"),
        ("make me a track for studying", "Studying"),
        ("Please generate an upbeat synthwave loop", "Upbeat synthwave loop"),
        ("e.g. opera metal, hard-hitting drums", "Opera metal"),
        # "keeps leading words that actually describe the music"
        ("instrumental lo-fi beat", "Instrumental lo-fi beat"),
        ("ambient drone for deep focus", "Ambient drone for deep focus"),
        ("song of the summer", "Song of the summer"),
        # "truncates on a word boundary rather than mid-word"
        (
            "a sweeping cinematic orchestral build with enormous timpani hits",
            "Sweeping cinematic orchestral build with…",
        ),
        # "still cuts a single unbroken word"
        ("x" * 80, "X" + "x" * 47 + "…"),
        # "collapses whitespace and trailing punctuation"
        ("  dreamy   lo-fi  \n  piano  ", "Dreamy lo-fi piano"),
        ("midnight drive -", "Midnight drive"),
        # "preserves casing after the first character"
        ("EDM festival anthem", "EDM festival anthem"),
        ("lo-fi study beat", "Lo-fi study beat"),
        # "falls back rather than returning an empty name"
        ("", "Untitled track"),
        ("   ", "Untitled track"),
        (",,,", "Untitled track"),
        ("a song about", "A song about"),
    ],
)
def test_the_heuristic_matches_the_client_case_for_case(
    prompt: str, expected: str
) -> None:
    assert derive_title_from_prompt(prompt) == expected
