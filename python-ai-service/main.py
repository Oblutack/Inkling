import asyncio
import hmac
import json
import logging
import os
import tempfile
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from typing import Optional
from urllib.parse import urlsplit

from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import Response, StreamingResponse
from langchain_text_splitters import RecursiveCharacterTextSplitter
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest
from pydantic import BaseModel
from pypdf import PdfReader

import compare
import dates
import embeddings
import extraction
import ocr
import photos
from attribution import check_summary
from cache import from_env as cache_from_env
from cache import summary_key
from citations import clean_citations, strip_citations
from error_reporting import setup_error_reporting
from extract import (
    FetchError,
    UnreadableDocument,
    decode_body,
    fetch_page,
    html_to_text,
    office_text,
    robots_allows,
    title_from_url,
)
from internal_auth import InternalAuthMiddleware
from llm import (
    ServiceUnavailable,
    active_model,
    breaker,
    candidate_models,
    counts_as_outage,
    get_llm,
    is_model_missing,
    mark_unavailable,
    verify_models,
)
from logging_setup import RequestContextMiddleware, configure_logging
from metrics import MetricsMiddleware, StateCollector, record_llm, record_rejected, record_usage, registry
from podcast import normalize_script, parse_reply, podcast_prompt
from prompts import (
    DEFAULT_LANGUAGE,
    DEFAULT_STYLE,
    LANGUAGES,
    MAX_INSTRUCTIONS_CHARS,
    PROMPT_VERSION,
    STYLE_INSTRUCTIONS,
    chat_prompt,
    is_valid_language,
    is_valid_style,
    summary_prompt,
)
from retrieval import PAGE_BREAK, Passage, select_passages
from study import (
    FULL_TEXT_MAX_CHARS,
    flashcards_prompt,
    parse_flashcards,
    parse_quiz,
    parse_suggestions,
    quiz_prompt,
    suggestions_prompt,
)
from transcribe import MAX_AUDIO_BYTES, TranscriptionError, is_audio, transcribe

load_dotenv()
configure_logging()
setup_error_reporting()

logger = logging.getLogger("ai-summarizer")

MAX_PDF_BYTES = 10 * 1024 * 1024
# A web page with less text than this is a login wall, an app shell or an error page, not an article.
MIN_PAGE_CHARS = 200
# A PDF with fewer letters and digits than this in all is a scan (it has no text layer), not a short document.
SCAN_MAX_CHARACTERS = 3
MAX_TEXT_CHARS = 200_000
MAX_FILES = 5
# A collection overview is written from the stored summaries of the documents in it.
MIN_OVERVIEW_DOCUMENTS, MAX_OVERVIEW_DOCUMENTS = 2, 20
MAX_MULTI_TEXT_CHARS = 400_000
MIN_WORDS, MAX_WORDS = 50, 1000
MAX_PAGE_LIMIT = 20
WORDS_PER_PAGE = 250

# Texts longer than this go through map-reduce even without a page limit, so a single
# prompt never exceeds the model's context or the provider's per-request token limit.
SINGLE_SHOT_MAX_CHARS = 24_000
CHUNK_SIZE = 4_000
CHUNK_OVERLAP = 200
# If the joined chunk summaries are still longer than this, they are summarized again.
REDUCE_MAX_CHARS = 24_000
# Cap parallel LLM calls so long documents don't trip the provider's rate limit.
MAX_CONCURRENT_LLM_CALLS = 3

# Chat limits: how much of the document is shown to the model per question, and how much
# conversation history and question text is accepted.
CHAT_CONTEXT_CHARS = 16_000
MAX_QUESTION_CHARS = 1_000
MAX_HISTORY_MESSAGES = 10
MAX_HISTORY_MESSAGE_CHARS = 4_000

SUMMARY_FAILED = "The language model failed to produce a summary. Please try again."
BUSY_MESSAGE = "The AI service is busy right now. Please try again in a minute."

summary_cache = cache_from_env()
# Cache and breaker state are read when Prometheus scrapes, so nothing is instrumented on the hot path.
registry.register(StateCollector(lambda: summary_cache, lambda: breaker))

ProgressCallback = Callable[[int, int], None]


@asynccontextmanager
async def lifespan(_: FastAPI):
    # Fail loudly in the logs at boot if the configured model has been retired.
    if os.getenv("GROQ_API_KEY"):
        model = await verify_models()
        if model:
            logger.info("Using language model %s", model)
    else:
        logger.error("GROQ_API_KEY is not set; summarization will fail")
    yield


app = FastAPI(title="Inkling AI Service", lifespan=lifespan)
# Added innermost first: the secret is checked inside metrics and logging, so refused calls still show up in both.
app.add_middleware(InternalAuthMiddleware)
app.add_middleware(MetricsMiddleware)
app.add_middleware(RequestContextMiddleware)

_llm_slots: dict[asyncio.AbstractEventLoop, asyncio.Semaphore] = {}


class TextPayload(BaseModel):
    text: str


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatPayload(BaseModel):
    text: str
    question: str
    history: Optional[list[ChatMessage]] = None


class LibraryPassage(BaseModel):
    """A passage the Go API found for a question across the user's documents."""

    id: int
    text: str
    page: Optional[int] = None
    pageEnd: Optional[int] = None
    document: Optional[str] = None


class AskPayload(BaseModel):
    question: str
    history: Optional[list[ChatMessage]] = None
    passages: list[LibraryPassage]


class PassagesPayload(BaseModel):
    text: str


class EmbedPayload(BaseModel):
    texts: list[str]
    kind: str = "passage"


class StudyPayload(BaseModel):
    # A document can be studied without a summary when its text is short enough to be given whole.
    summary: str = ""
    text: str = ""
    language: Optional[str] = None
    kind: str = "flashcards"


class SuggestPayload(BaseModel):
    summary: str = ""
    text: str = ""
    language: Optional[str] = None


class PodcastPayload(BaseModel):
    summary: str
    text: str = ""
    language: Optional[str] = None


class ProofPayload(BaseModel):
    summary: str
    text: str


def _slots() -> asyncio.Semaphore:
    # A semaphore is bound to the loop that first awaits it, so keep one per running loop.
    return _llm_slots.setdefault(asyncio.get_running_loop(), asyncio.Semaphore(MAX_CONCURRENT_LLM_CALLS))


def to_http_error(exc: Exception, failure_message: str = SUMMARY_FAILED) -> HTTPException:
    """Turns any failure into a client-safe HTTP error; internals are logged, never returned."""
    if isinstance(exc, HTTPException):
        return exc
    if isinstance(exc, ServiceUnavailable):
        return HTTPException(503, BUSY_MESSAGE, headers={"Retry-After": "30"})
    logger.exception("Request failed", exc_info=exc)
    return HTTPException(502, failure_message)


def content_text(content: str | list[str | dict] | None) -> str:
    """The text of a model reply. Providers may return a plain string or a list of content blocks."""
    if not content:
        return ""
    if isinstance(content, str):
        return content
    parts = []
    for block in content:
        if isinstance(block, str):
            parts.append(block)
        elif isinstance(block, dict) and isinstance(block.get("text"), str):
            parts.append(block["text"])
    return "".join(parts)


async def call_llm(prompt: str) -> str:
    async with _slots():
        # If the provider says the model no longer exists, move to the next candidate and retry.
        for _ in candidate_models():
            model = active_model()
            if not breaker.allow():
                record_rejected(model)
                raise ServiceUnavailable("circuit open")
            started = time.perf_counter()
            try:
                response = await get_llm().ainvoke(prompt)
                breaker.success()
                record_llm(model, "invoke", "ok", started)
                record_usage(model, getattr(response, "usage_metadata", None))
                return content_text(response.content).strip()
            except Exception as exc:
                if is_model_missing(exc):
                    record_llm(model, "invoke", "model_missing", started)
                    mark_unavailable(model)
                    continue
                outage = counts_as_outage(exc)
                if outage:
                    breaker.failure()
                record_llm(model, "invoke", "provider_error" if outage else "error", started)
                raise
    raise RuntimeError("No configured language model is available")


async def stream_llm(prompt: str) -> AsyncIterator[str]:
    """Yields the model's reply piece by piece, with the same model fallback as call_llm."""
    async with _slots():
        for _ in candidate_models():
            model = active_model()
            if not breaker.allow():
                record_rejected(model)
                raise ServiceUnavailable("circuit open")
            started = False
            began = time.perf_counter()
            usage = None
            outcome = "cancelled"  # what it stays if the client disconnects and the stream is closed
            try:
                async for chunk in get_llm().astream(prompt):
                    usage = getattr(chunk, "usage_metadata", None) or usage
                    text = content_text(chunk.content)
                    if text:
                        started = True
                        yield text
                breaker.success()
                outcome = "ok"
                record_usage(model, usage)
                return
            except Exception as exc:
                # Only fall back if nothing was sent yet; a half-written answer can't be resumed.
                if is_model_missing(exc) and not started:
                    outcome = "model_missing"
                    mark_unavailable(model)
                    continue
                outage = counts_as_outage(exc)
                if outage:
                    breaker.failure()
                outcome = "provider_error" if outage else "error"
                raise
            finally:
                record_llm(model, "stream", outcome, began)
    raise RuntimeError("No configured language model is available")


@app.get("/")
def read_root():
    return {"message": "Python AI Service is running"}


@app.get("/healthz")
def healthz():
    """Liveness: the process is up. Deliberately independent of the LLM provider."""
    return {"status": "ok"}


@app.get("/metrics", include_in_schema=False)
def prometheus_metrics(request: Request):
    """Prometheus metrics. Off (404) unless METRICS_TOKEN is set, and then only for callers that
    present it as a bearer token: traffic patterns and usage are not for the public."""
    token = os.getenv("METRICS_TOKEN", "")
    if not token:
        raise HTTPException(404, "Not Found")
    given = request.headers.get("authorization", "")
    if not given.startswith("Bearer ") or not hmac.compare_digest(given[len("Bearer ") :], token):
        raise HTTPException(401, "Unauthorized", headers={"WWW-Authenticate": "Bearer"})
    return Response(generate_latest(registry), media_type=CONTENT_TYPE_LATEST)


@app.get("/readyz")
async def readyz():
    """Readiness: we hold an API key and at least one configured model exists at the provider."""
    if not os.getenv("GROQ_API_KEY"):
        raise HTTPException(503, "GROQ_API_KEY is not set")
    model = await verify_models()
    if model is None:
        raise HTTPException(503, "No usable language model (provider unreachable or models retired)")
    if breaker.is_open:
        raise HTTPException(503, "The language model circuit breaker is open")
    return {"status": "ready", "model": model}


@app.get("/options")
def options():
    return {"styles": list(STYLE_INSTRUCTIONS), "languages": LANGUAGES}


def validate_options(word_count: int, page_limit: int, style: str, language: str, instructions: str = "") -> None:
    if len(instructions) > MAX_INSTRUCTIONS_CHARS:
        raise HTTPException(422, f"instructions must be at most {MAX_INSTRUCTIONS_CHARS} characters")
    if not MIN_WORDS <= word_count <= MAX_WORDS:
        raise HTTPException(422, f"word_count must be between {MIN_WORDS} and {MAX_WORDS}")
    if not 0 <= page_limit <= MAX_PAGE_LIMIT:
        raise HTTPException(422, f"page_limit must be between 0 and {MAX_PAGE_LIMIT}")
    if not is_valid_style(style):
        raise HTTPException(422, f"style must be one of: {', '.join(STYLE_INSTRUCTIONS)}")
    if not is_valid_language(language):
        raise HTTPException(422, "Unsupported language")


def skim(text: str, skim_chars: int) -> str:
    """What is summarized when only a skim is wanted (a few lines for a reading list): the start of a long text. The
    whole text is still kept and returned; a long page would otherwise take dozens of model calls for three lines."""
    return text[:skim_chars] if 0 < skim_chars < len(text) else text


def extract_pdf_text(path: str) -> str:
    # Page breaks are kept (as form feeds) so chat answers can cite the page they came from.
    return PAGE_BREAK.join(page.extract_text() or "" for page in PdfReader(path).pages)


def ocr_http_error(exc: "ocr.OcrError") -> HTTPException:
    """A client-safe error for a scan that could not be read; "busy" says when to come back."""
    headers = {"Retry-After": "30"} if exc.status == 503 else None
    return HTTPException(exc.status, exc.message, headers=headers)


def add_scanned_pages(content: bytes, text: str, filename: str, allow_ocr: bool) -> str:
    """Fills in the pages of a PDF that have no text of their own (pictures of text) by reading them with OCR.

    Reading scanned pages is real work, so it is only done when the caller allows it (the gateway does, for signed-in
    people). Without it a PDF that is nothing but pictures says why it cannot be read; one that mixes real and scanned
    pages is used as it is, as before."""
    pages = text.split(PAGE_BREAK)
    blank = [i for i, page in enumerate(pages) if ocr.needs_ocr(page)]
    if not blank or not ocr.available():
        return text
    if not allow_ocr:
        # Nothing at all (not even a page number) is what a scan looks like; a short document is only short.
        if len(blank) == len(pages) and ocr.characters(text) < SCAN_MAX_CHARACTERS:
            raise HTTPException(
                422, f"{filename} has no text of its own (it looks like a scan). Sign in to have its pages read."
            )
        return text
    try:
        read = ocr.read_pages(content, blank)
    except ocr.OcrError as exc:
        raise ocr_http_error(exc) from exc
    for index, page_text in read.items():
        # A page that had a little text of its own keeps it unless reading the picture found more.
        if ocr.characters(page_text) > ocr.characters(pages[index]):
            pages[index] = page_text
    return PAGE_BREAK.join(pages)


def extract_pdf_bytes(content: bytes, filename: str = "document.pdf", allow_ocr: bool = False) -> str:
    """The text of PDF bytes, raising client-safe HTTP errors."""
    temp_pdf_path = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=".pdf") as temp_pdf:
            temp_pdf.write(content)
            temp_pdf_path = temp_pdf.name
        try:
            text = extract_pdf_text(temp_pdf_path)
        except Exception as exc:
            logger.exception("Failed to parse PDF")
            raise HTTPException(422, f"Could not read {filename}. It may be corrupted or password-protected.") from exc
        return add_scanned_pages(content, text, filename, allow_ocr)
    finally:
        if temp_pdf_path and os.path.exists(temp_pdf_path):
            os.unlink(temp_pdf_path)


def extract_upload_text(filename: str, content: bytes, allow_ocr: bool = False) -> str:
    """The text of an uploaded document: a PDF, or a Word or PowerPoint file."""
    try:
        office = office_text(filename, content)
    except UnreadableDocument as exc:
        logger.warning("Could not read %s: %s", "an Office file", exc)
        raise HTTPException(422, f"Could not read {filename}. It may be corrupted or not a real Office file.") from exc
    if office is not None:
        return office
    return extract_pdf_bytes(content, filename, allow_ocr)


async def transcribe_upload(file: UploadFile) -> str:
    """The transcript of an uploaded recording, raising client-safe HTTP errors."""
    name = file.filename or "recording"
    content = await file.read(MAX_AUDIO_BYTES + 1)
    try:
        return (await transcribe(name, content)).text
    except TranscriptionError as exc:
        headers = {"Retry-After": "30"} if exc.status == 503 else None
        raise HTTPException(exc.status, exc.message, headers=headers) from exc


async def read_photo_uploads(items: list[UploadFile], allow_ocr: bool) -> str:
    """The text of photos of pages, one page per photo in the order given."""
    if not allow_ocr:
        raise HTTPException(422, "Sign in to have the text in photos read.")
    pictures = []
    for file in items:
        content = await file.read(MAX_PDF_BYTES + 1)
        if len(content) > MAX_PDF_BYTES:
            raise HTTPException(413, f"{file.filename} is too large (max 10 MB)")
        pictures.append((file.filename or "photo", content))
    try:
        pages = await asyncio.to_thread(photos.read_photos, pictures)
    except ocr.OcrError as exc:
        raise ocr_http_error(exc) from exc
    return PAGE_BREAK.join(pages)


async def read_pdf_upload(file: UploadFile, allow_ocr: bool = False) -> str:
    """Reads an uploaded document (PDF, Word, PowerPoint, a photo or a recording) and returns its text, raising
    client-safe HTTP errors."""
    if is_audio(file.filename or ""):
        return await transcribe_upload(file)
    if photos.is_image(file.filename or ""):
        return await read_photo_uploads([file], allow_ocr)
    content = await file.read(MAX_PDF_BYTES + 1)
    if len(content) > MAX_PDF_BYTES:
        raise HTTPException(413, f"{file.filename} is too large (max 10 MB)")
    return await asyncio.to_thread(extract_upload_text, file.filename or "document.pdf", content, allow_ocr)


async def read_uploads(files: list[UploadFile], allow_ocr: bool) -> list[tuple[str, str]]:
    """(name, text) for each document. Photos are pages of one document, wherever they come among the files."""
    docs: list[tuple[str, str]] = []
    pictures: list[UploadFile] = []
    slot = 0
    for file in files:
        if photos.is_image(file.filename or ""):
            if not pictures:
                slot = len(docs)
                docs.append(("", ""))
            pictures.append(file)
        else:
            docs.append((file.filename or "document.pdf", await read_pdf_upload(file, allow_ocr)))
    if pictures:
        first = pictures[0].filename or "photo"
        name = first if len(pictures) == 1 else f"{first} (+{len(pictures) - 1} more photos)"
        docs[slot] = (name, await read_photo_uploads(pictures, allow_ocr))
    return docs


async def read_web_page(raw_url: str, allow_ocr: bool = False) -> tuple[str, str]:
    """Fetches a web address and returns (title, text), raising client-safe HTTP errors."""
    try:
        page = await fetch_page(raw_url)
    except FetchError as exc:
        raise HTTPException(exc.status, exc.message) from exc

    if page.kind == "pdf":
        text = await asyncio.to_thread(extract_pdf_bytes, page.body, "that PDF", allow_ocr)
        title = urlsplit(page.final_url).path.rsplit("/", 1)[-1] or title_from_url(page.final_url)
    elif page.kind == "text":
        text, title = decode_body(page.body, page.charset), title_from_url(page.final_url)
    else:
        title, text = await asyncio.to_thread(html_to_text, decode_body(page.body, page.charset))
        # A web page with almost no text is a login wall or an app that needs JavaScript. A short PDF or text file
        # is just short, and says so itself if it has nothing.
        if len(text.strip()) < MIN_PAGE_CHARS:
            raise HTTPException(
                422,
                "Inkling could not find readable text on that page. Pages that need JavaScript or a login "
                "are not supported: copy the text and paste it instead.",
            )
    return (title or title_from_url(page.final_url))[:200], text


def check_text(text: str) -> None:
    """Rejects input that can't be summarized, before any LLM work or streaming starts."""
    if not text.strip():
        raise HTTPException(422, "No readable text was found to summarize.")
    if len(text) > MAX_TEXT_CHARS:
        raise HTTPException(413, f"Text is too long (max {MAX_TEXT_CHARS} characters)")


def check_documents(docs: list[tuple[str, str]]) -> None:
    for name, text in docs:
        if not text.strip():
            raise HTTPException(422, f"No readable text was found in {name}.")
    if sum(len(text) for _, text in docs) > MAX_MULTI_TEXT_CHARS:
        raise HTTPException(413, f"The documents are too long together (max {MAX_MULTI_TEXT_CHARS} characters)")


# ---- Server-sent events -------------------------------------------------------------------
# Each event is one line of JSON: {"type": "status" | "delta" | "done" | "error", ...}.


def sse(event: dict) -> str:
    return f"data: {json.dumps(event, ensure_ascii=False)}\n\n"


CACHED_PIECE_CHARS = 160


async def summary_event_stream(
    prepare: Callable[[Optional[ProgressCallback]], Awaitable[str]],
    done_extra: Optional[dict] = None,
    cache_key: Optional[str] = None,
) -> AsyncIterator[str]:
    """Runs `prepare` (which may do map-reduce work and reports progress), then streams the
    final summary as it is generated. Failures become a final "error" event, since by the time
    they happen the HTTP status line has already been sent."""
    progress: asyncio.Queue = asyncio.Queue()
    task: Optional[asyncio.Task] = None
    try:
        yield sse({"type": "status", "stage": "preparing"})

        cached = summary_cache.get(cache_key) if cache_key else None
        if cached is not None:
            # Same input and options as before: replay the stored summary without calling the LLM.
            yield sse({"type": "status", "stage": "writing"})
            for i in range(0, len(cached), CACHED_PIECE_CHARS):
                yield sse({"type": "delta", "text": cached[i : i + CACHED_PIECE_CHARS]})
            yield sse({"type": "done", **(done_extra or {})})
            return

        task = asyncio.ensure_future(prepare(lambda done, total: progress.put_nowait((done, total))))
        while not task.done() or not progress.empty():
            try:
                done, total = await asyncio.wait_for(progress.get(), timeout=0.2)
            except TimeoutError:
                continue
            yield sse({"type": "status", "stage": "summarizing", "done": done, "total": total})
        prompt = task.result()

        yield sse({"type": "status", "stage": "writing"})
        pieces: list[str] = []
        async for piece in stream_llm(prompt):
            pieces.append(piece)
            yield sse({"type": "delta", "text": piece})
        if not pieces:
            raise ValueError("The model returned an empty or invalid summary.")
        if cache_key:
            summary_cache.put(cache_key, "".join(pieces))

        yield sse({"type": "done", **(done_extra or {})})
    except Exception as exc:
        error = to_http_error(exc)
        yield sse({"type": "error", "status": error.status_code, "message": error.detail})
    finally:
        if task and not task.done():
            task.cancel()


def sse_response(stream: AsyncIterator[str]) -> StreamingResponse:
    return StreamingResponse(
        stream,
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},  # no proxy buffering
    )


# ---- Endpoints ----------------------------------------------------------------------------


async def summarize_one(
    filename: Optional[str],
    text: str,
    word_count: int,
    page_limit: int,
    style: str,
    language: str,
    instructions: str,
    stream: bool,
):
    """Summarizes the text of one document (streamed or not)."""
    check_text(text)

    if stream:

        def prepare(progress):
            return prepare_summary_prompt(
                text, word_count, page_limit, style, language, progress, instructions=instructions
            )

        key = text_cache_key(text, word_count, page_limit, style, language, instructions)
        return sse_response(summary_event_stream(prepare, {"filename": filename, "text": text}, key))

    summary = await summarize_or_fail(text, word_count, page_limit, style, language, instructions)
    return {"filename": filename, "summary": summary, "text": text}


@app.post("/summarize")
async def summarize_file(
    file: UploadFile = File(...),
    word_count: int = Form(150),
    page_limit: int = Form(0),
    style: str = Form(DEFAULT_STYLE),
    language: str = Form(DEFAULT_LANGUAGE),
    instructions: str = Form(""),
    ocr_pages: bool = Form(False, alias="ocr"),
    stream: bool = Query(False),
):
    validate_options(word_count, page_limit, style, language, instructions)
    text = await read_pdf_upload(file, ocr_pages)
    return await summarize_one(file.filename, text, word_count, page_limit, style, language, instructions, stream)


@app.post("/summarize-text")
async def summarize_text(
    payload: TextPayload,
    word_count: int = Query(150),
    page_limit: int = Query(0),
    style: str = Query(DEFAULT_STYLE),
    language: str = Query(DEFAULT_LANGUAGE),
    instructions: str = Query(""),
    skim_chars: int = Query(0, ge=0, le=MAX_TEXT_CHARS),
    stream: bool = Query(False),
):
    validate_options(word_count, page_limit, style, language, instructions)
    check_text(payload.text)
    wanted = skim(payload.text, skim_chars)

    if stream:

        def prepare(progress):
            return prepare_summary_prompt(
                wanted, word_count, page_limit, style, language, progress, instructions=instructions
            )

        key = text_cache_key(wanted, word_count, page_limit, style, language, instructions)
        return sse_response(summary_event_stream(prepare, None, key))

    summary = await summarize_or_fail(wanted, word_count, page_limit, style, language, instructions)
    return {"summary": summary}


class UrlPayload(BaseModel):
    url: str


@app.post("/summarize-url")
async def summarize_url(
    payload: UrlPayload,
    word_count: int = Query(150),
    page_limit: int = Query(0),
    style: str = Query(DEFAULT_STYLE),
    language: str = Query(DEFAULT_LANGUAGE),
    instructions: str = Query(""),
    ocr_pages: bool = Query(False, alias="ocr"),
    skim_chars: int = Query(0, ge=0, le=MAX_TEXT_CHARS),
    stream: bool = Query(False),
):
    """Summarizes the page at a web address. The page is read first (so a bad address is a plain error, not
    a failed stream), then summarized like any other text (only its start, with skim_chars)."""
    validate_options(word_count, page_limit, style, language, instructions)
    title, text = await read_web_page(payload.url, ocr_pages)
    check_text(text)
    wanted = skim(text, skim_chars)

    if stream:

        def prepare(progress):
            return prepare_summary_prompt(
                wanted, word_count, page_limit, style, language, progress, instructions=instructions
            )

        key = text_cache_key(wanted, word_count, page_limit, style, language, instructions)
        return sse_response(summary_event_stream(prepare, {"filename": title, "text": text}, key))

    summary = await summarize_or_fail(wanted, word_count, page_limit, style, language, instructions)
    return {"filename": title, "summary": summary, "text": text}


@app.post("/read")
async def read_files(
    files: list[UploadFile] = File(...),
    ocr_pages: bool = Form(False, alias="ocr"),
):
    """The text of uploaded documents, with no summary made: for studying a document straight away. Photos are
    the pages of one document, and several documents are joined the way a combined summary joins them."""
    if not 1 <= len(files) <= MAX_FILES:
        raise HTTPException(422, f"Upload between 1 and {MAX_FILES} files")
    docs = await read_uploads(files, ocr_pages)
    check_documents(docs)
    if len(docs) == 1:
        name, text = docs[0]
        check_text(text)
        return {"filename": name, "text": text}
    return {"filename": label_for(docs), "text": combine_documents(docs)}


@app.post("/read-url")
async def read_url(
    payload: UrlPayload,
    ocr_pages: bool = Query(False, alias="ocr"),
    watch: bool = Query(False),
):
    """The text of the page at a web address, with no summary made. With `watch` the page is one that will be opened
    again and again (a page someone follows), so the site's robots.txt is honoured first."""
    if watch and not await robots_allows(payload.url):
        raise HTTPException(
            422, "That site asks not to be checked automatically (its robots.txt), so Inkling cannot watch that page."
        )
    title, text = await read_web_page(payload.url, ocr_pages)
    check_text(text)
    return {"filename": title, "text": text}


async def prepare_overview_prompt(
    name: str,
    docs: list[tuple[str, str]],
    word_count: int,
    style: str = DEFAULT_STYLE,
    language: str = DEFAULT_LANGUAGE,
    progress: Optional[ProgressCallback] = None,
    instructions: str = "",
) -> str:
    """The prompt for a briefing on a collection, from the (already short) summaries of its documents."""
    material = "\n\n".join(f"### {doc_name}\n{text}" for doc_name, text in docs)
    if len(material) > REDUCE_MAX_CHARS:
        material = await condense(material, progress)
    return summary_prompt(
        material,
        target_words_for(word_count, 0),
        style,
        language,
        kind="collection",
        instructions=instructions,
        subject=name,
    )


class OverviewDocument(BaseModel):
    name: str
    text: str


class OverviewPayload(BaseModel):
    name: str = ""
    documents: list[OverviewDocument]


@app.post("/overview")
async def overview_collection(
    payload: OverviewPayload,
    word_count: int = Query(300),
    style: str = Query(DEFAULT_STYLE),
    language: str = Query(DEFAULT_LANGUAGE),
    instructions: str = Query(""),
    stream: bool = Query(False),
):
    """One briefing on a group of documents, written from their (already short) summaries: what they are
    about together, where they agree and where they differ."""
    validate_options(word_count, 0, style, language, instructions)
    if not MIN_OVERVIEW_DOCUMENTS <= len(payload.documents) <= MAX_OVERVIEW_DOCUMENTS:
        raise HTTPException(
            422, f"An overview needs between {MIN_OVERVIEW_DOCUMENTS} and {MAX_OVERVIEW_DOCUMENTS} documents"
        )
    docs = [(d.name.strip()[:200] or f"Document {i}", d.text) for i, d in enumerate(payload.documents, start=1)]
    check_documents(docs)
    name = payload.name.strip()[:100]
    done_extra = {"filename": f"Overview: {name}" if name else "Overview"}
    key = summary_key(
        "overview",
        name + "\n" + combine_documents(docs),
        target_words_for(word_count, 0),
        style,
        language,
        active_model_or_none(),
        PROMPT_VERSION,
        instructions,
    )

    def prepare(progress: Optional[ProgressCallback] = None) -> Awaitable[str]:
        return prepare_overview_prompt(name, docs, word_count, style, language, progress, instructions)

    if stream:
        return sse_response(summary_event_stream(prepare, done_extra, key))

    try:
        summary = summary_cache.get(key)
        if summary is None:
            summary = await call_llm(await prepare())
            if not summary:
                raise ValueError("The model returned an empty or invalid summary.")
            summary_cache.put(key, summary)
    except Exception as exc:
        raise to_http_error(exc) from exc
    return {**done_extra, "summary": summary}


@app.post("/summarize-multiple")
async def summarize_multiple(
    files: list[UploadFile] = File(...),
    word_count: int = Form(150),
    page_limit: int = Form(0),
    style: str = Form(DEFAULT_STYLE),
    language: str = Form(DEFAULT_LANGUAGE),
    instructions: str = Form(""),
    ocr_pages: bool = Form(False, alias="ocr"),
    stream: bool = Query(False),
):
    validate_options(word_count, page_limit, style, language, instructions)
    if not 1 <= len(files) <= MAX_FILES:
        raise HTTPException(422, f"Upload between 1 and {MAX_FILES} files")

    docs = await read_uploads(files, ocr_pages)
    check_documents(docs)
    if len(docs) == 1:
        # Several photos are the pages of one document: it is summarized as one, not as a set of documents.
        name, text = docs[0]
        return await summarize_one(name, text, word_count, page_limit, style, language, instructions, stream)
    extra = {"filename": label_for(docs), "text": combine_documents(docs)}

    key = multi_cache_key(docs, word_count, page_limit, style, language, instructions)
    if stream:

        def prepare(progress):
            return prepare_multi_prompt(docs, word_count, page_limit, style, language, progress, instructions)

        return sse_response(summary_event_stream(prepare, extra, key))

    try:
        summary = summary_cache.get(key)
        if summary is None:
            summary = await process_multi_summary(docs, word_count, page_limit, style, language, instructions)
            summary_cache.put(key, summary)
    except Exception as exc:
        raise to_http_error(exc) from exc
    return {"filename": extra["filename"], "summary": summary, "text": extra["text"]}


def validated_question(raw: str) -> str:
    question = raw.strip()
    if not question:
        raise HTTPException(422, "Question is required")
    if len(question) > MAX_QUESTION_CHARS:
        raise HTTPException(422, f"Question is too long (max {MAX_QUESTION_CHARS} characters)")
    return question


def clean_history(messages: Optional[list[ChatMessage]]) -> list[dict]:
    """The recent conversation, limited in size, without roles we did not define, and without the old
    citation numbers (they would not match the excerpts numbered for the new question)."""
    return [
        {"role": m.role, "content": strip_citations(m.content).strip()[:MAX_HISTORY_MESSAGE_CHARS]}
        for m in (messages or [])[-MAX_HISTORY_MESSAGES:]
        if m.role in ("user", "assistant") and m.content.strip()
    ]


async def answer_from_passages(passages: list[Passage], history: list[dict], question: str, library: bool = False):
    """Asks the model to answer from numbered passages and returns the answer with the passages it cites."""
    try:
        answer = await call_llm(chat_prompt(passages, history, question, library))
    except Exception as exc:
        raise to_http_error(exc, "The language model failed to answer. Please try again.") from exc
    if not answer:
        raise HTTPException(502, "The language model returned an empty answer. Please try again.")

    # Only excerpts the answer actually cites are returned, and markers that point at nothing are removed.
    answer, cited = clean_citations(answer, {p.id for p in passages})
    by_id = {p.id: p for p in passages}
    sources = [
        {
            "id": n,
            "text": by_id[n].text,
            "page": by_id[n].page,
            "pageEnd": by_id[n].page_end,
            "document": by_id[n].document,
        }
        for n in cited
    ]
    return {"answer": answer, "sources": sources}


@app.post("/chat")
async def chat(payload: ChatPayload):
    question = validated_question(payload.question)
    if not payload.text.strip():
        raise HTTPException(422, "This document has no text to chat with")
    if len(payload.text) > MAX_MULTI_TEXT_CHARS + 10_000:
        raise HTTPException(413, "Document is too long")

    passages = select_passages(payload.text, question, CHAT_CONTEXT_CHARS)
    return await answer_from_passages(passages, clean_history(payload.history), question)


MAX_LIBRARY_PASSAGES = 30
MAX_LIBRARY_PASSAGE_CHARS = 5_000


@app.post("/ask")
async def ask(payload: AskPayload):
    """Answers a question from passages the Go API found across all of a user's documents."""
    question = validated_question(payload.question)
    if not payload.passages:
        raise HTTPException(422, "No passages to answer from")
    if len(payload.passages) > MAX_LIBRARY_PASSAGES:
        raise HTTPException(413, "Too many passages")
    ids = [p.id for p in payload.passages]
    if len(set(ids)) != len(ids) or any(i < 1 for i in ids):
        raise HTTPException(422, "Passage numbers must be unique and positive")
    passages = [
        Passage(
            id=p.id,
            text=p.text[:MAX_LIBRARY_PASSAGE_CHARS],
            page=p.page,
            page_end=p.pageEnd if p.pageEnd is not None else p.page,
            document=p.document,
        )
        for p in payload.passages
    ]
    return await answer_from_passages(passages, clean_history(payload.history), question, library=True)


@app.post("/passages")
async def passages_of(payload: PassagesPayload):
    """Cuts a document into the page-aware passages used for citations, so they can be indexed for search."""
    if not payload.text.strip():
        raise HTTPException(422, "This document has no text")
    if len(payload.text) > MAX_MULTI_TEXT_CHARS + 10_000:
        raise HTTPException(413, "Document is too long")
    found = await asyncio.to_thread(select_passages, payload.text, "", len(payload.text) + 1)
    return {
        "passages": [{"text": p.text, "page": p.page, "pageEnd": p.page_end, "document": p.document} for p in found]
    }


@app.post("/embed")
async def embed_texts(payload: EmbedPayload):
    """Turns passages or a question into vectors, so the gateway can search by meaning."""
    if payload.kind not in embeddings.KINDS:
        raise HTTPException(422, "kind must be 'passage' or 'query'")
    if not payload.texts or any(not t.strip() for t in payload.texts):
        raise HTTPException(422, "Texts must not be empty")
    if len(payload.texts) > embeddings.MAX_TEXTS:
        raise HTTPException(413, "Too many texts")
    try:
        vectors = await asyncio.to_thread(embeddings.embed, payload.texts, payload.kind)
    except embeddings.EmbeddingsUnavailable as exc:
        raise HTTPException(503, str(exc)) from exc
    return {
        "model": embeddings.model_name(),
        "dim": len(vectors[0]) // 4,
        "minScore": embeddings.min_score(),
        "vectors": [embeddings.encode(v) for v in vectors],
    }


MAX_PROOF_SUMMARY_CHARS = 30_000
PODCAST_ATTEMPTS = 3
STUDY_ATTEMPTS = 3


@app.post("/podcast")
async def podcast(payload: PodcastPayload):
    """Writes a short two-host conversation about a document, as a script of speaker turns."""
    if not payload.summary.strip():
        raise HTTPException(422, "A summary is required")
    if payload.language and not is_valid_language(payload.language):
        raise HTTPException(422, "Unsupported language")
    if len(payload.summary) > MAX_PROOF_SUMMARY_CHARS or len(payload.text) > MAX_MULTI_TEXT_CHARS + 10_000:
        raise HTTPException(413, "The document is too long")

    prompt = podcast_prompt(payload.summary, payload.text, payload.language)
    # Models often ignore the format (one-sided scripts, wrong shape); trying again is cheaper than failing.
    for _ in range(PODCAST_ATTEMPTS):
        try:
            reply = await call_llm(prompt)
        except Exception as exc:
            raise to_http_error(exc, "The language model failed to write the script. Please try again.") from exc
        parsed = parse_reply(reply)
        script = normalize_script(parsed) if parsed else None
        if script:
            return script
    raise HTTPException(502, "The language model did not return a usable script. Please try again.")


def check_generation_input(
    summary: str, text: str, language: Optional[str], text_may_stand_alone: bool = False
) -> None:
    """`text_may_stand_alone`: study material can be made from a short text without a summary of it."""
    if not summary.strip():
        if not text_may_stand_alone:
            raise HTTPException(422, "A summary is required")
        if not text.strip():
            raise HTTPException(422, "A summary or the text of the document is required")
        if len(text) > FULL_TEXT_MAX_CHARS:
            raise HTTPException(422, "A summary is required for a document this long")
    if language and not is_valid_language(language):
        raise HTTPException(422, "Unsupported language")
    if len(summary) > MAX_PROOF_SUMMARY_CHARS or len(text) > MAX_MULTI_TEXT_CHARS + 10_000:
        raise HTTPException(413, "The document is too long")


async def generate_until_usable(prompt: str, parse: Callable[[str], object | None], failure: str):
    """Asks the model, and asks again when its reply cannot be read: models sometimes ignore the layout."""
    for _ in range(STUDY_ATTEMPTS):
        try:
            reply = await call_llm(prompt)
        except Exception as exc:
            raise to_http_error(exc, failure) from exc
        parsed = parse(reply)
        if parsed is not None:  # an empty list is an answer; only an unreadable reply is asked again
            return parsed
    raise HTTPException(502, "The language model did not return a usable result. Please try again.")


@app.post("/suggest")
async def suggest_questions(payload: SuggestPayload):
    """Questions a reader could ask about a document, for the chat to offer."""
    check_generation_input(payload.summary, payload.text, payload.language, text_may_stand_alone=True)
    prompt = suggestions_prompt(payload.summary, payload.text, payload.language)
    questions = await generate_until_usable(
        prompt, parse_suggestions, "The language model failed to suggest questions."
    )
    return {"questions": questions}


@app.post("/study")
async def study_material(payload: StudyPayload):
    """Flashcards or a multiple-choice quiz made from a document."""
    check_generation_input(payload.summary, payload.text, payload.language, text_may_stand_alone=True)
    if payload.kind == "flashcards":
        prompt = flashcards_prompt(payload.summary, payload.text, payload.language)
        cards = await generate_until_usable(prompt, parse_flashcards, "The language model failed to write flashcards.")
        return {"kind": "flashcards", "cards": cards}
    if payload.kind == "quiz":
        prompt = quiz_prompt(payload.summary, payload.text, payload.language)
        questions = await generate_until_usable(prompt, parse_quiz, "The language model failed to write a quiz.")
        return {"kind": "quiz", "questions": questions}
    raise HTTPException(422, "kind must be 'flashcards' or 'quiz'")


class DatesPayload(BaseModel):
    name: str = ""
    text: str
    language: Optional[str] = None


@app.post("/dates")
async def find_dates(payload: DatesPayload):
    """The dates and deadlines a document states, each with its own sentence as the quote and a check that the date is
    really in it (see dates.py). A document with no sentence that can hold a date costs no model call."""
    check_text(payload.text)
    if payload.language and not is_valid_language(payload.language):
        raise HTTPException(422, "Unsupported language")
    sentences = dates.date_sentences(payload.text)
    suspect = extraction.injection_sentences(payload.text)
    if not sentences:
        return {"dates": [], "suspicious": bool(suspect), "sentences": 0}
    prompt = dates.dates_prompt(payload.name, sentences, payload.language)
    items = await generate_until_usable(prompt, dates.parse_dates, "The language model failed to find the dates.")
    found = dates.assemble(items, sentences, suspect)
    flagged = any(any(s.key in key for key in suspect) for s in sentences)
    return {"dates": found, "suspicious": flagged, "sentences": len(sentences)}


class FieldIn(BaseModel):
    name: str
    description: str = ""
    type: str = "text"


class ExtractPayload(BaseModel):
    name: str = ""
    text: str
    fields: list[FieldIn]
    language: Optional[str] = None


@app.post("/extract")
async def extract_fields(payload: ExtractPayload):
    """The named fields of a document, each with the exact quote it comes from and whether that checks out (see
    extraction.py)."""
    if payload.language and not is_valid_language(payload.language):
        raise HTTPException(422, "Unsupported language")
    if not payload.text.strip():
        raise HTTPException(422, "This document has no text to extract from")
    if len(payload.text) > MAX_MULTI_TEXT_CHARS:
        raise HTTPException(413, "Document is too long")
    try:
        fields = extraction.clean_fields(
            [{"name": f.name, "description": f.description, "type": f.type} for f in payload.fields]
        )
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc

    question = " ".join(f"{f.name} {f.description}" for f in fields)
    passages = await asyncio.to_thread(select_passages, payload.text, question, extraction.MAX_PROMPT_CHARS)
    prompt = extraction.extraction_prompt(passages, fields, payload.language)
    answers = await generate_until_usable(
        prompt,
        lambda reply: extraction.parse_extraction(reply, len(fields)),
        "The language model failed to extract the fields.",
    )
    suspect = await asyncio.to_thread(extraction.injection_sentences, payload.text)
    results = await asyncio.to_thread(extraction.assemble, fields, answers, payload.text, suspect)
    return {"name": payload.name.strip()[:200], "fields": results, "suspicious": bool(suspect)}


class CompareSide(BaseModel):
    name: str = ""
    text: str


class ComparePayload(BaseModel):
    old: CompareSide
    new: CompareSide
    language: Optional[str] = None


# Each text of a comparison may be this long (a little more than a long contract).
MAX_COMPARE_CHARS = 300_000


@app.post("/compare")
async def compare_versions(payload: ComparePayload):
    """What changed between two versions of a document, and how much it matters (see compare.py)."""
    if payload.language and not is_valid_language(payload.language):
        raise HTTPException(422, "Unsupported language")
    for side in (payload.old, payload.new):
        if not side.text.strip():
            raise HTTPException(422, "Both documents need some text to compare")
        if len(side.text) > MAX_COMPARE_CHARS:
            raise HTTPException(413, f"A document is too long to compare (max {MAX_COMPARE_CHARS} characters)")

    async def ask(prompt: str) -> str:
        try:
            return await call_llm(prompt)
        except Exception as exc:
            raise to_http_error(exc, "The language model failed to compare the documents.") from exc

    try:
        return await compare.compare_documents(
            payload.old.name.strip()[:200] or "Older version",
            payload.old.text,
            payload.new.name.strip()[:200] or "Newer version",
            payload.new.text,
            payload.language,
            ask,
        )
    except compare.TooLong as exc:
        raise HTTPException(413, "A document has too many sentences to compare") from exc


@app.post("/proof")
async def proof(payload: ProofPayload):
    """Checks each sentence of a summary against the document it came from (see attribution.py).
    No language model is involved, so it is free and gives the same answer every time."""
    if not payload.summary.strip():
        raise HTTPException(422, "A summary is required")
    if not payload.text.strip():
        raise HTTPException(422, "This document has no text to check against")
    if len(payload.summary) > MAX_PROOF_SUMMARY_CHARS:
        raise HTTPException(413, "The summary is too long to check")
    if len(payload.text) > MAX_MULTI_TEXT_CHARS + 10_000:
        raise HTTPException(413, "Document is too long")
    # Pure computation, so it runs in a thread rather than holding up other requests.
    return await asyncio.to_thread(check_summary, payload.summary, payload.text)


# ---- Summarization pipeline ---------------------------------------------------------------


def label_for(docs: list[tuple[str, str]]) -> str:
    names = [name for name, _ in docs]
    if len(names) <= 2:
        return ", ".join(names)
    return f"{names[0]}, {names[1]} (+{len(names) - 2} more)"


def combine_documents(docs: list[tuple[str, str]]) -> str:
    return "\n\n".join(f"=== {name} ===\n{text}" for name, text in docs)


async def summarize_or_fail(
    text: str, word_count: int, page_limit: int, style: str, language: str, instructions: str = ""
) -> str:
    """Runs the summarizer, turning failures into client-safe HTTP errors."""
    check_text(text)
    key = text_cache_key(text, word_count, page_limit, style, language, instructions)
    cached = summary_cache.get(key)
    if cached is not None:
        return cached
    try:
        summary = await process_summary(text, word_count, page_limit, style, language, instructions)
    except Exception as exc:
        raise to_http_error(exc) from exc
    summary_cache.put(key, summary)
    return summary


def text_cache_key(
    text: str, word_count: int, page_limit: int, style: str, language: str, instructions: str = ""
) -> str:
    return summary_key(
        "text",
        text,
        target_words_for(word_count, page_limit),
        style,
        language,
        active_model_or_none(),
        PROMPT_VERSION,
        instructions,
    )


def multi_cache_key(
    docs: list[tuple[str, str]], word_count: int, page_limit: int, style: str, language: str, instructions: str = ""
) -> str:
    return summary_key(
        "docs",
        combine_documents(docs),
        target_words_for(word_count, page_limit),
        style,
        language,
        active_model_or_none(),
        PROMPT_VERSION,
        instructions,
    )


def active_model_or_none() -> str:
    try:
        return active_model()
    except RuntimeError:
        return "none"


def split_text(text: str) -> list[str]:
    splitter = RecursiveCharacterTextSplitter(chunk_size=CHUNK_SIZE, chunk_overlap=CHUNK_OVERLAP)
    return [chunk.page_content for chunk in splitter.create_documents([text])]


async def condense(text: str, progress: Optional[ProgressCallback] = None) -> str:
    """Map step: summarize each chunk, repeating until the result fits in a single reduce prompt.

    `progress(done, total)` is called as each chunk of the current round finishes."""
    while True:
        chunks = split_text(text)
        finished = 0

        async def summarize_chunk(chunk: str, total: int) -> str:
            nonlocal finished
            result = await call_llm(
                "Summarize the following text concisely, focusing on the key points. Keep every figure, name and "
                "date exactly as written, with what it belongs to, and add nothing that is not in the text:"
                "\n\n---\n\n" + chunk
            )
            finished += 1
            if progress:
                progress(finished, total)
            return result

        results = await asyncio.gather(*(summarize_chunk(chunk, len(chunks)) for chunk in chunks))
        combined = "\n\n".join(r for r in results if r)
        if not combined:
            raise ValueError("Failed to generate intermediate summaries from the document.")
        # A single pass over a single chunk can't shrink further; stop to avoid looping forever.
        if len(combined) <= REDUCE_MAX_CHARS or len(chunks) == 1:
            return combined
        text = combined


def target_words_for(word_count: int, page_limit: int) -> int:
    return page_limit * WORDS_PER_PAGE if page_limit > 0 else word_count


async def prepare_summary_prompt(
    text: str,
    word_count: int,
    page_limit: int,
    style: str = DEFAULT_STYLE,
    language: str = DEFAULT_LANGUAGE,
    progress: Optional[ProgressCallback] = None,
    instructions: str = "",
) -> str:
    """Builds the final prompt, doing any map-reduce condensing it needs first."""
    target_words = target_words_for(word_count, page_limit)
    if page_limit > 0 or len(text) > SINGLE_SHOT_MAX_CHARS:
        return summary_prompt(
            await condense(text, progress), target_words, style, language, kind="summaries", instructions=instructions
        )
    return summary_prompt(text, target_words, style, language, kind="text", instructions=instructions)


async def process_summary(
    text: str,
    word_count: int,
    page_limit: int,
    style: str = DEFAULT_STYLE,
    language: str = DEFAULT_LANGUAGE,
    instructions: str = "",
) -> str:
    prompt = await prepare_summary_prompt(text, word_count, page_limit, style, language, instructions=instructions)
    summary = await call_llm(prompt)
    if not summary:
        raise ValueError("The model returned an empty or invalid summary.")
    return summary


async def prepare_multi_prompt(
    docs: list[tuple[str, str]],
    word_count: int,
    page_limit: int,
    style: str = DEFAULT_STYLE,
    language: str = DEFAULT_LANGUAGE,
    progress: Optional[ProgressCallback] = None,
    instructions: str = "",
) -> str:
    """Builds the combined prompt for several documents. Long documents are condensed first so
    the combined material fits in a single prompt and each document keeps its share of it."""

    async def prepare(name: str, text: str) -> str:
        body = await condense(text, progress) if len(text) > SINGLE_SHOT_MAX_CHARS // len(docs) else text
        return f"### {name}\n{body}"

    sections = await asyncio.gather(*(prepare(name, text) for name, text in docs))
    material = "\n\n".join(sections)
    if len(material) > REDUCE_MAX_CHARS:
        material = await condense(material, progress)

    return summary_prompt(
        material, target_words_for(word_count, page_limit), style, language, kind="documents", instructions=instructions
    )


async def process_multi_summary(
    docs: list[tuple[str, str]],
    word_count: int,
    page_limit: int,
    style: str = DEFAULT_STYLE,
    language: str = DEFAULT_LANGUAGE,
    instructions: str = "",
) -> str:
    prompt = await prepare_multi_prompt(docs, word_count, page_limit, style, language, instructions=instructions)
    summary = await call_llm(prompt)
    if not summary:
        raise ValueError("The model returned an empty or invalid summary.")
    return summary
