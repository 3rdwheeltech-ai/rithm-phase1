"""
SongDraft: the vocabulary pins, and the repair-never-refuse contract.

Every value in a draft came out of a language model and every one of them ends
up seeding the Create form. These tests are the statement that a draft which
validates cannot 422 at POST /tracks/generate — which the user would read as
"the chatbot broke Create".
"""

from app.modules.conversation.schemas import (
    BPM_MAX,
    LENGTH_MAX_SECONDS,
    LYRICS_PROMPT_MAX_LENGTH,
    MAX_INSTRUMENTS,
    LyricsMode,
    SongDraft,
    Voice,
    draft_is_ready,
)

# ── Vocabulary pins ───────────────────────────────────────────────────────


def test_chat_vocabulary_matches_the_catalog_vocabulary() -> None:
    """
    conversation re-declares GENRES/MOODS because import-linter forbids it
    importing catalog. Tests sit outside the `app` root package, so they may
    import both — which is the only thing keeping the copies from drifting.
    Mirrors test_identity_profile.py's pin on identity's copy.
    """
    from app.modules.catalog.models import GENRES as CATALOG_GENRES
    from app.modules.catalog.models import MOODS as CATALOG_MOODS
    from app.modules.conversation.schemas import GENRES, MOODS

    assert GENRES == CATALOG_GENRES
    assert MOODS == CATALOG_MOODS


def test_chat_lyric_vocabulary_matches_the_generation_wire_dto() -> None:
    """
    LyricsMode and Voice go onto the wire as the SAME strings GenerateRequest
    accepts — the SPA hands a draft's values straight to the Create form, which
    puts them in the request body. A rename on either side is a 422 nobody
    would predict.
    """
    from app.modules.conversation.schemas import LyricsMode as ChatLyricsMode
    from app.modules.conversation.schemas import Voice as ChatVoice
    from app.modules.generation.schemas import LyricsMode as GenLyricsMode
    from app.modules.generation.schemas import Voice as GenVoice

    assert [m.value for m in ChatLyricsMode] == [m.value for m in GenLyricsMode]
    assert [v.value for v in ChatVoice] == [v.value for v in GenVoice]


def test_chat_bounds_match_the_generation_bounds() -> None:
    """
    The reason every bound is re-declared rather than approximated: a draft
    that validates here must not fail validation there.
    """
    from app.modules.conversation import schemas as chat
    from app.modules.generation import schemas as gen

    assert chat.LYRICS_MAX_LENGTH == gen.LYRICS_MAX_LENGTH
    assert chat.TITLE_MAX_LENGTH == gen.TITLE_MAX_LENGTH
    assert chat.LYRICS_PROMPT_MAX_LENGTH == gen.LYRICS_PROMPT_MAX_LENGTH

    fields = gen.GenerateRequest.model_fields
    assert chat.PROMPT_MAX_LENGTH == 2000  # GenerateRequest.prompt's max_length
    assert fields["instruments"].metadata[0].max_length == chat.MAX_INSTRUMENTS


# ── Repair, never refuse ──────────────────────────────────────────────────


def test_an_out_of_vocabulary_genre_is_dropped_not_raised() -> None:
    draft = SongDraft.model_validate({"genre": "Synthwave", "mood": "Calm"})

    assert draft.genre is None
    assert draft.mood == "Calm"


def test_genre_and_mood_are_matched_case_insensitively() -> None:
    """A model that lowercases "Lo-Fi" has answered correctly, not wrongly."""
    draft = SongDraft.model_validate({"genre": "lo-fi", "mood": "DARK"})

    assert draft.genre == "Lo-Fi"
    assert draft.mood == "Dark"


def test_numbers_outside_their_bounds_are_clamped() -> None:
    draft = SongDraft.model_validate(
        {"length_seconds": 600, "bpm_min": 5, "bpm_max": 9000}
    )

    assert draft.length_seconds == LENGTH_MAX_SECONDS
    assert draft.bpm_max == BPM_MAX


def test_instrumental_clears_the_lyrics_and_forces_auto_voice() -> None:
    """
    GenerateRequest 422s this pair — the worker's [Instrumental] token IS the
    lyrics field, so one of the two would have to silently win. A draft is a
    work in progress, so it normalises instead.
    """
    draft = SongDraft.model_validate(
        {
            "lyrics_mode": "instrumental",
            "lyrics": "[verse]\nneon rain",
            "lyrics_prompt": "a late drive home",
            "voice": "female",
        }
    )

    assert draft.lyrics is None
    assert draft.lyrics_prompt is None
    assert draft.voice is Voice.AUTO


def test_lyrics_survive_only_in_write_mode_and_a_brief_only_in_prompt_mode() -> None:
    written = SongDraft.model_validate(
        {"lyrics_mode": "write", "lyrics": "words", "lyrics_prompt": "a brief"}
    )
    briefed = SongDraft.model_validate(
        {"lyrics_mode": "prompt", "lyrics": "words", "lyrics_prompt": "a brief"}
    )

    assert (written.lyrics, written.lyrics_prompt) == ("words", None)
    assert (briefed.lyrics, briefed.lyrics_prompt) == (None, "a brief")


def test_a_half_a_bpm_range_is_normalised_rather_than_raised() -> None:
    """One end of a range is not a tempo, and GenerateRequest takes the pair."""
    assert SongDraft.model_validate({"bpm_min": 90}).bpm_min is None
    assert SongDraft.model_validate({"bpm_max": 130}).bpm_max is None


def test_a_reversed_bpm_range_is_ordered_rather_than_raised() -> None:
    draft = SongDraft.model_validate({"bpm_min": 140, "bpm_max": 90})

    assert (draft.bpm_min, draft.bpm_max) == (90, 140)


def test_instruments_are_bounded_lowercased_and_deduped() -> None:
    draft = SongDraft.model_validate(
        {"instruments": ["Piano", "piano", "  Rhodes  ", 7, "x" * 200] + ["a"] * 20}
    )

    assert draft.instruments[:3] == ["piano", "rhodes", "x" * 40]
    assert len(draft.instruments) <= MAX_INSTRUMENTS


def test_overlong_text_is_trimmed_rather_than_refused() -> None:
    draft = SongDraft.model_validate(
        {"lyrics_mode": "prompt", "lyrics_prompt": "b" * 5000}
    )

    assert draft.lyrics_prompt is not None
    assert len(draft.lyrics_prompt) == LYRICS_PROMPT_MAX_LENGTH


def test_junk_of_the_wrong_type_becomes_null_rather_than_an_error() -> None:
    """
    The whole point of _coerce: one field coming back as a number must not
    throw away the eleven that came back right.
    """
    draft = SongDraft.model_validate(
        {"prompt": {"nested": "object"}, "genre": 12, "mood": "Calm"}
    )

    assert draft.prompt is None
    assert draft.genre is None
    assert draft.mood == "Calm"


# ── Merge ─────────────────────────────────────────────────────────────────


def test_a_delta_only_overwrites_what_it_actually_carries() -> None:
    base = SongDraft.model_validate({"prompt": "rainy drive", "genre": "Lo-Fi"})
    merged = base.merged_with(SongDraft.model_validate({"mood": "Calm"}))

    assert (merged.prompt, merged.genre, merged.mood) == (
        "rainy drive",
        "Lo-Fi",
        "Calm",
    )


def test_instruments_replace_wholesale_but_an_empty_list_keeps_what_we_had() -> None:
    """
    A list cannot be merged field-wise without deciding whether "drums" was
    added or the line-up was restated — so the extractor restates and this
    replaces. An EMPTY list is the extractor saying nothing, not "remove them".
    """
    base = SongDraft.model_validate({"instruments": ["piano", "rhodes"]})

    assert base.merged_with(SongDraft.model_validate({})).instruments == [
        "piano",
        "rhodes",
    ]
    assert base.merged_with(
        SongDraft.model_validate({"instruments": ["drums"]})
    ).instruments == ["drums"]


def test_a_merge_re_applies_the_agreement_rules() -> None:
    """Switching to instrumental late must clear the words already collected."""
    base = SongDraft.model_validate({"lyrics_mode": "write", "lyrics": "words"})
    merged = base.merged_with(SongDraft.model_validate({"lyrics_mode": "instrumental"}))

    assert merged.lyrics_mode is LyricsMode.INSTRUMENTAL
    assert merged.lyrics is None


# ── Readiness ─────────────────────────────────────────────────────────────


def test_ready_needs_a_prompt_a_genre_a_mood_and_a_vocals_decision() -> None:
    complete = {
        "prompt": "rainy drive",
        "genre": "Lo-Fi",
        "mood": "Calm",
        "lyrics_mode": "instrumental",
    }

    assert draft_is_ready(SongDraft.model_validate(complete)) is True
    for missing in complete:
        partial = {k: v for k, v in complete.items() if k != missing}
        assert draft_is_ready(SongDraft.model_validate(partial)) is False
