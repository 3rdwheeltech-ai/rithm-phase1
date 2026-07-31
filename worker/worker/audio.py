"""
ffmpeg post-processing.

These run in BOTH the stub and production images. The stub skips *inference*,
not post-processing — running the real ffmpeg chain over a real WAV is a large
part of what makes Gate C meaningful rather than a mock handshake.

Pure functions over file paths, each shelling out with check=True so a non-zero
exit surfaces as CalledProcessError. The processor classifies that as a
permanent failure: ffmpeg failing on input it already accepted is a bug or a
corrupt artifact, and retrying it just burns receives until the DLQ.
"""
import hashlib
import os
import subprocess
import tempfile
from pathlib import Path

import structlog

logger = structlog.get_logger()

# EBU R128 target. −14 LUFS is the streaming-platform convention.
_LOUDNORM_FILTER = "loudnorm=I=-14:LRA=11:TP=-1.0"
_SAMPLE_RATE = "44100"
_CHANNELS = "2"
_MP3_BITRATE = "192k"

# Long enough for a 180s render, short enough that a wedged ffmpeg cannot hold
# the SQS visibility window open forever.
_FFMPEG_TIMEOUT_SECONDS = 300


def _run(args: list[str]) -> str:
    """Run a subprocess, returning stdout. Raises on non-zero exit."""
    result = subprocess.run(  # noqa: S603 — fixed argv, no shell
        args,
        check=True,
        capture_output=True,
        text=True,
        timeout=_FFMPEG_TIMEOUT_SECONDS,
    )
    return result.stdout


def _temp_path(suffix: str) -> Path:
    """Reserve a unique temp filename for ffmpeg to write into."""
    handle, name = tempfile.mkstemp(suffix=suffix)
    os.close(handle)   # ffmpeg opens the path itself; -y overwrites the stub
    return Path(name)


def loudnorm(src: Path) -> Path:
    """
    Single-pass EBU R128 normalisation to −14 LUFS. Returns the new WAV path.

    Day-2 decision: single-pass, not two-pass. Two-pass means parsing pass 1's
    measured JSON and threading it into pass 2 — fiddly, and irrelevant to what
    Gate C proves (that the ffmpeg path runs and yields valid artifacts). If the
    Track-C PoC shows LUFS drift on real 30–180s output, Day 3 upgrades this
    body to two-pass; the signature does not change.
    """
    dst = _temp_path(".wav")
    _run(
        [
            "ffmpeg", "-v", "error", "-y",
            "-i", str(src),
            "-af", _LOUDNORM_FILTER,
            "-ar", _SAMPLE_RATE,
            "-ac", _CHANNELS,
            str(dst),
        ]
    )
    return dst


def encode_mp3(src: Path, bitrate: str = _MP3_BITRATE) -> Path:
    """Encode to MP3. Returns the new path."""
    dst = _temp_path(".mp3")
    _run(
        [
            "ffmpeg", "-v", "error", "-y",
            "-i", str(src),
            "-codec:a", "libmp3lame",
            "-b:a", bitrate,
            "-ar", _SAMPLE_RATE,
            str(dst),
        ]
    )
    return dst


def probe_duration_seconds(path: Path) -> int:
    """Duration in whole seconds, rounded."""
    out = _run(
        [
            "ffprobe", "-v", "error",
            "-show_entries", "format=duration",
            "-of", "csv=p=0",
            str(path),
        ]
    )
    return round(float(out.strip()))


def waveform_sha256(wav: Path) -> str:
    """
    SHA-256 over decoded 16-bit PCM samples. Lowercase hex, 64 chars → CHAR(64).

    Hashing the decoded stream rather than the file is deliberate: container
    metadata (encoder version, timestamps) differs run to run, so a file hash
    would report two identical renders as different audio.
    """
    result = subprocess.run(  # noqa: S603 — fixed argv, no shell
        [
            "ffmpeg", "-v", "error",
            "-i", str(wav),
            "-f", "s16le",
            "-ac", _CHANNELS,
            "-ar", _SAMPLE_RATE,
            "-",
        ],
        check=True,
        capture_output=True,
        timeout=_FFMPEG_TIMEOUT_SECONDS,
    )
    return hashlib.sha256(result.stdout).hexdigest()
