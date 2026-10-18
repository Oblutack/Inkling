"""Speech to text: a recording becomes a transcript that the rest of the service treats like any document.

The recording goes to Groq's Whisper (the same key as the language model). What comes back is a list of timed
segments; this module turns them into readable text:

  - paragraphs, each starting with its time ("[12:30] ..."), so a summary or an answer can say when something
    was said and a person can find the place in the recording;
  - a page break every five minutes (retrieval.PAGE_BREAK), so chat citations point to a stretch of the
    recording ("page 3" is minutes 10 to 15) the way they point to a page of a PDF;
  - a first line that says what the text is ("Transcript of meeting.mp3 (length 34:12)"), so the language
    model knows it is reading speech with no speaker names and does not invent any.

Whisper is known to invent text over silence and noise ("Thanks for watching!"), so segments it itself rates as
probably not speech are dropped, and a segment repeated over and over is kept once.
"""

import logging
import os
import re
from dataclasses import dataclass, field
from typing import Optional

import httpx

from llm import api_key
from retrieval import PAGE_BREAK

logger = logging.getLogger("ai-summarizer")

URL = "https://api.groq.com/openai/v1/audio/transcriptions"
# The turbo model is several times faster and a third of the price of large-v3 for a little more mistakes (12.0%
# against 10.3% word errors in Groq's own figures); either is cents an hour.
MODEL = os.getenv("STT_MODEL", "whisper-large-v3-turbo")
TIMEOUT_SECONDS = 180.0
# The most Groq takes in one file: 25 MB on the free tier, 100 MB on the paid one.
MAX_AUDIO_BYTES = int(os.getenv("MAX_AUDIO_MB", "25")) * 1024 * 1024

# Formats Whisper reads. mp4 and webm are often a video: only the sound is used.
AUDIO_TYPES = {
    ".mp3": "audio/mpeg",
    ".mpga": "audio/mpeg",
    ".mpeg": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".mp4": "video/mp4",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".flac": "audio/flac",
    ".webm": "audio/webm",
}

PARAGRAPH_GAP_SECONDS = 2.5  # a pause this long starts a new paragraph
PARAGRAPH_MAX_CHARS = 700
PAGE_SECONDS = 300  # five minutes of speech is one "page"
# Whisper's own rating of a segment: the chance it is silence, and how sure it was of its words.
NO_SPEECH_CERTAIN = 0.8
NO_SPEECH_DOUBTFUL = 0.5
LOW_CONFIDENCE = -1.0


class TranscriptionError(Exception):
    """A recording could not be transcribed. `status` is the HTTP status to report, `message` is safe to show."""

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


@dataclass
class Transcript:
    text: str
    seconds: float
    language: Optional[str] = None
    segments: list[dict] = field(default_factory=list)


def base_name(filename: str) -> str:
    """The file's own name, whichever kind of path it came with. Some clients send a whole Windows path, and this
    service runs where a backslash is not a separator, so os.path.basename alone would keep the folders."""
    return re.split(r"[\\/]", filename)[-1]


def is_audio(filename: str) -> bool:
    return os.path.splitext(filename.lower())[1] in AUDIO_TYPES


def clock(seconds: float) -> str:
    """12:30, or 1:02:30 once it passes an hour."""
    total = int(max(0, seconds))
    hours, rest = divmod(total, 3600)
    minutes, secs = divmod(rest, 60)
    return f"{hours}:{minutes:02d}:{secs:02d}" if hours else f"{minutes}:{secs:02d}"


def speech_segments(segments: list[dict]) -> list[dict]:
    """The segments that are speech: Whisper's guesses about silence and noise are left out."""
    kept: list[dict] = []
    for segment in segments:
        text = str(segment.get("text") or "").strip()
        if not text:
            continue
        no_speech = float(segment.get("no_speech_prob") or 0.0)
        confidence = float(segment.get("avg_logprob") or 0.0)
        if no_speech >= NO_SPEECH_CERTAIN or (no_speech >= NO_SPEECH_DOUBTFUL and confidence < LOW_CONFIDENCE):
            continue
        # The model sometimes loops on one line; the same text three times running is kept once.
        if len(kept) >= 2 and all(str(k.get("text")).strip() == text for k in kept[-2:]):
            continue
        kept.append({**segment, "text": text})
    return kept


def format_transcript(segments: list[dict], name: str, seconds: float) -> str:
    """Segments as paragraphs that start with their time, in five-minute pages, under a one-line heading."""
    speech = speech_segments(segments)
    if not speech:
        return ""
    heading = (
        f"Transcript of {name} (length {clock(seconds)}). Times in brackets are minutes and seconds into the recording."
    )
    pages: list[list[str]] = []
    paragraph: list[str] = []
    page = -1
    previous_end = 0.0
    start_of_paragraph = 0.0

    def flush() -> None:
        if paragraph and pages:
            pages[-1].append(f"[{clock(start_of_paragraph)}] " + " ".join(paragraph))
        paragraph.clear()

    for segment in speech:
        start = float(segment.get("start") or 0.0)
        this_page = int(start // PAGE_SECONDS)
        new_page = this_page != page
        long_pause = paragraph and start - previous_end > PARAGRAPH_GAP_SECONDS
        too_long = paragraph and sum(len(p) for p in paragraph) > PARAGRAPH_MAX_CHARS
        if new_page or long_pause or too_long:
            flush()
            if new_page:
                pages.append([])
                page = this_page
            start_of_paragraph = start
        paragraph.append(segment["text"])
        previous_end = float(segment.get("end") or start)
    flush()

    pages[0].insert(0, heading)
    return PAGE_BREAK.join("\n\n".join(parts) for parts in pages)


# A spoken question is short: at most this long and this big, and at most this many characters once written down.
VOICE_MAX_BYTES = 1024 * 1024
VOICE_MAX_SECONDS = 75.0
VOICE_MAX_CHARS = 1000


def plain_speech(transcript: Transcript) -> str:
    """What was said, as one plain line: no times, no heading (a spoken question is not a document)."""
    if transcript.segments:
        words = " ".join(segment["text"] for segment in speech_segments(transcript.segments))
    else:
        words = re.sub(r"^Transcript of [^\n]*\n+", "", transcript.text)
    return " ".join(words.split())[:VOICE_MAX_CHARS]


def _error_for(status: int, body: str) -> TranscriptionError:
    if status in (400, 422):
        return TranscriptionError(
            422, "That recording could not be read. Check that it is a normal audio or video file."
        )
    if status == 413:
        return TranscriptionError(413, "That recording is too large to transcribe.")
    if status == 429:
        return TranscriptionError(503, "The transcription service is busy right now. Please try again in a minute.")
    if status in (401, 403):
        logger.error("The speech-to-text provider refused the key (HTTP %s)", status)
        return TranscriptionError(502, "Transcription is not available right now.")
    logger.error("Speech-to-text failed: HTTP %s %s", status, body[:200])
    return TranscriptionError(502, "The recording could not be transcribed. Please try again.")


async def transcribe(filename: str, content: bytes, client: Optional[httpx.AsyncClient] = None) -> Transcript:
    """Sends a recording to Whisper and returns its transcript (text, length, language)."""
    if len(content) > MAX_AUDIO_BYTES:
        raise TranscriptionError(413, f"{filename} is too large (max {MAX_AUDIO_BYTES // (1024 * 1024)} MB)")
    try:
        key = api_key()
    except RuntimeError as exc:
        raise TranscriptionError(503, "GROQ_API_KEY is not set") from exc

    extension = os.path.splitext(filename.lower())[1]
    owns_client = client is None
    if client is None:
        client = httpx.AsyncClient(timeout=httpx.Timeout(TIMEOUT_SECONDS, connect=10.0))
    try:
        response = await client.post(
            URL,
            headers={"Authorization": f"Bearer {key}"},
            data={
                "model": MODEL,
                "response_format": "verbose_json",
                "temperature": "0",
                "timestamp_granularities[]": "segment",
            },
            files={
                "file": (
                    base_name(filename) or "recording",
                    content,
                    AUDIO_TYPES.get(extension, "application/octet-stream"),
                )
            },
        )
    except httpx.TimeoutException as exc:
        raise TranscriptionError(504, "Transcribing took too long. Try a shorter recording.") from exc
    except httpx.HTTPError as exc:
        logger.error("Speech-to-text could not be reached: %s", type(exc).__name__)
        raise TranscriptionError(502, "The transcription service could not be reached.") from exc
    finally:
        if owns_client:
            await client.aclose()

    if response.status_code != 200:
        raise _error_for(response.status_code, response.text)
    try:
        body = response.json()
    except ValueError as exc:
        raise TranscriptionError(502, "The recording could not be transcribed. Please try again.") from exc

    segments = body.get("segments") or []
    seconds = float(body.get("duration") or (segments[-1].get("end", 0.0) if segments else 0.0))
    text = format_transcript(segments, base_name(filename), seconds) if segments else ""
    if not segments and str(body.get("text") or "").strip():
        # No timing came back at all: keep the words, without times or pages. (When segments came back and every
        # one was judged to be silence, the plain text is the same made-up words, so it is not used.)
        text = f"Transcript of {base_name(filename)}.\n\n{str(body['text']).strip()}"
    if not text:
        raise TranscriptionError(422, "No speech was found in that recording.")
    return Transcript(text=text, seconds=seconds, language=body.get("language"), segments=segments)
