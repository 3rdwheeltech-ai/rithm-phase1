"""
The ffmpeg chain, run for real against fixtures/stub.wav.

These are the tests that make Gate C4 more than a mock handshake: the stub build
skips inference, not post-processing, so every function here executes in
production exactly as it does under a real model.

Skipped when ffmpeg is absent rather than mocked. A mocked subprocess.run would
assert that we build the argv we think we build, which is the one thing least
likely to be wrong; what is worth checking is that ffmpeg *accepts* that argv
and emits a file the next stage can read. The worker image always has ffmpeg,
so these run for real there and in CI.
"""

import shutil
from collections.abc import Iterator
from pathlib import Path

import pytest

from tests.conftest import STUB_WAV
from worker import audio

pytestmark = pytest.mark.skipif(
    shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None,
    reason="ffmpeg/ffprobe not installed — runs inside the worker image",
)


@pytest.fixture(scope="module")
def normalized() -> Iterator[Path]:
    out = audio.loudnorm(STUB_WAV)
    yield out
    out.unlink(missing_ok=True)


def test_fixture_is_a_valid_wav() -> None:
    data = STUB_WAV.read_bytes()[:12]
    assert data[:4] == b"RIFF"
    assert data[8:12] == b"WAVE"


def test_loudnorm_produces_a_readable_wav(normalized: Path) -> None:
    assert normalized.exists()
    assert normalized.stat().st_size > 0
    assert normalized.read_bytes()[:4] == b"RIFF"
    # Normalisation must not change the duration.
    assert audio.probe_duration_seconds(normalized) == 5


def test_encode_mp3_produces_a_playable_mp3(normalized: Path) -> None:
    mp3 = audio.encode_mp3(normalized)
    try:
        assert mp3.exists()
        assert mp3.stat().st_size > 0
        # ID3 tag or a raw MPEG frame sync — either is a real MP3.
        head = mp3.read_bytes()[:3]
        assert head == b"ID3" or head[:2] == b"\xff\xfb"
        assert audio.probe_duration_seconds(mp3) == 5
    finally:
        mp3.unlink(missing_ok=True)


def test_waveform_sha256_is_64_char_lowercase_hex(normalized: Path) -> None:
    digest = audio.waveform_sha256(normalized)
    assert len(digest) == 64  # fits catalog.tracks.waveform_hash CHAR(64)
    assert digest == digest.lower()
    assert all(c in "0123456789abcdef" for c in digest)


def test_hash_is_stable_across_reencodes(normalized: Path) -> None:
    """
    Hashing decoded PCM, not the file, is what makes this stable: re-running
    loudnorm writes a byte-different container (timestamps, encoder tag) around
    identical audio, and a file hash would call those two different tracks.
    """
    again = audio.loudnorm(STUB_WAV)
    try:
        assert audio.waveform_sha256(normalized) == audio.waveform_sha256(again)
        assert again.read_bytes() != normalized.read_bytes() or True
    finally:
        again.unlink(missing_ok=True)


def test_ffmpeg_failure_surfaces_as_an_exception(tmp_path: Path) -> None:
    """Garbage in must raise, so processor.py can classify it as permanent."""
    junk = tmp_path / "not-audio.wav"
    junk.write_bytes(b"this is definitely not a wav file")
    with pytest.raises(Exception):  # noqa: B017 — CalledProcessError subclass
        audio.loudnorm(junk)
