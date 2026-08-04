"""
S3 upload of the two track assets.

The key layout is a contract, not a convention: `tracks/{user_id}/{job_id}/`
with the literal filenames `master.wav` and `audio.mp3`. Gate C4 greps for both,
the task role scopes PutObject to `tracks/*`, and the API presigns the mp3 key
straight out of the SNS envelope.
"""

from pathlib import Path

import structlog

from worker import aws
from worker.config import get_settings

logger = structlog.get_logger()

WAV_FILENAME = "master.wav"
MP3_FILENAME = "audio.mp3"


def track_prefix(user_id: str, job_id: str) -> str:
    return f"tracks/{user_id}/{job_id}"


def upload_track_assets(
    user_id: str, job_id: str, wav: Path, mp3: Path
) -> tuple[str, str]:
    """
    Upload both assets. Returns (wav_key, mp3_key).

    ContentType is load-bearing: the API serves these via presigned GET straight
    into an <audio> element, and a missing or wrong content type makes some
    browsers refuse to play the file rather than fail loudly.
    """
    bucket = get_settings().assets_bucket
    prefix = track_prefix(user_id, job_id)
    wav_key = f"{prefix}/{WAV_FILENAME}"
    mp3_key = f"{prefix}/{MP3_FILENAME}"

    client = aws.s3()
    client.upload_file(
        str(wav), bucket, wav_key, ExtraArgs={"ContentType": "audio/wav"}
    )
    client.upload_file(
        str(mp3), bucket, mp3_key, ExtraArgs={"ContentType": "audio/mpeg"}
    )

    logger.info(
        "track_assets_uploaded",
        job_id=job_id,
        wav_key=wav_key,
        mp3_key=mp3_key,
    )
    return wav_key, mp3_key
