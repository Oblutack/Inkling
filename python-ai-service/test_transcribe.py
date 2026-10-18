import asyncio
import functools
import json

import httpx
import pytest
from fastapi.testclient import TestClient

import main
import transcribe
from retrieval import PAGE_BREAK
from transcribe import Transcript, TranscriptionError


def sync(test):
    @functools.wraps(test)
    def run(*args, **kwargs):
        return asyncio.run(test(*args, **kwargs))

    return run


def seg(start, end, text, no_speech=0.01, logprob=-0.2):
    return {"start": start, "end": end, "text": f" {text}", "no_speech_prob": no_speech, "avg_logprob": logprob}


# --- turning segments into a transcript ---


def test_clock_reads_like_a_player():
    assert [transcribe.clock(s) for s in (0, 5, 65, 754, 3599, 3600, 3725.9)] == [
        "0:00", "0:05", "1:05", "12:34", "59:59", "1:00:00", "1:02:05",
    ]  # fmt: skip
    assert transcribe.clock(-3) == "0:00"


def test_a_transcript_has_a_heading_and_paragraphs_that_start_with_their_time():
    text = transcribe.format_transcript(
        [
            seg(0, 4, "Welcome everyone."),
            seg(4.5, 9, "Let us start with the budget."),
            seg(20, 24, "Next, the launch."),
        ],
        "meeting.mp3",
        24,
    )
    lines = text.split("\n\n")
    assert lines[0].startswith("Transcript of meeting.mp3 (length 0:24).")
    assert lines[1] == "[0:00] Welcome everyone. Let us start with the budget."  # a short pause stays in one paragraph
    assert lines[2] == "[0:20] Next, the launch."  # a long pause starts a new one
    assert PAGE_BREAK not in text


def test_every_five_minutes_is_a_page():
    segments = [seg(10, 14, "First stretch."), seg(310, 314, "Second stretch."), seg(905, 910, "Fourth stretch.")]
    pages = transcribe.format_transcript(segments, "talk.m4a", 910).split(PAGE_BREAK)
    assert len(pages) == 3
    assert "[0:10] First stretch." in pages[0] and pages[0].startswith("Transcript of talk.m4a")
    assert pages[1] == "[5:10] Second stretch."
    assert pages[2] == "[15:05] Fourth stretch."


def test_a_very_long_run_of_speech_is_split_into_paragraphs():
    segments = [seg(i * 5, i * 5 + 5, f"Sentence number {i} " + "word " * 25) for i in range(12)]  # no pauses at all
    text = transcribe.format_transcript(segments, "x.wav", 60)
    paragraphs = [p for p in text.split("\n\n") if p.startswith("[")]
    assert len(paragraphs) > 2
    assert all(len(p) < transcribe.PARAGRAPH_MAX_CHARS + 300 for p in paragraphs)


def test_hours_show_in_the_times():
    text = transcribe.format_transcript([seg(3725, 3730, "Late in the day.")], "long.mp3", 3730)
    assert "[1:02:05] Late in the day." in text and "length 1:02:10" in text


# --- what Whisper makes up ---


def test_segments_that_are_probably_silence_are_dropped():
    segments = [
        seg(0, 3, "Real words here."),
        seg(3, 6, "Thanks for watching!", no_speech=0.9),  # certainly not speech
        seg(6, 9, "Subtitles by someone", no_speech=0.6, logprob=-1.4),  # doubtful and unsure
        seg(9, 12, "A quiet but real sentence.", no_speech=0.6, logprob=-0.3),  # doubtful, but sure of its words
        seg(12, 13, "   "),
    ]
    kept = [s["text"] for s in transcribe.speech_segments(segments)]
    assert kept == ["Real words here.", "A quiet but real sentence."]


def test_a_looping_line_is_kept_once():
    segments = [seg(i, i + 1, "Thank you.") for i in range(6)] + [seg(10, 12, "Now something else.")]
    kept = [s["text"] for s in transcribe.speech_segments(segments)]
    assert kept == ["Thank you.", "Thank you.", "Now something else."]


def test_nothing_but_silence_has_no_transcript():
    assert transcribe.format_transcript([seg(0, 5, "Thanks for watching!", no_speech=0.95)], "x.mp3", 5) == ""
    assert transcribe.format_transcript([], "x.mp3", 0) == ""


def test_the_audio_types_are_recognised_by_extension():
    for name in ("a.mp3", "B.M4A", "c.wav", "d.ogg", "e.flac", "f.webm", "g.mp4", "h.mpeg", "i.mpga"):
        assert transcribe.is_audio(name), name
    for name in ("a.pdf", "b.docx", "c.txt", "mp3", "audio.mp3.exe", ""):
        assert not transcribe.is_audio(name), name


# --- calling the provider (a fake network) ---


@pytest.fixture(autouse=True)
def key(monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "gsk_test_key")


def provider(handler):
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def verbose(segments, **extra):
    return httpx.Response(200, json={"text": " ".join(s["text"] for s in segments), "segments": segments, **extra})


@sync
async def test_a_recording_is_sent_to_whisper_and_comes_back_as_a_transcript():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["auth"] = request.headers["authorization"]
        seen["body"] = request.content
        return verbose(
            [seg(0, 4, "Hello team."), seg(5, 9, "The budget is approved.")], duration=9.5, language="english"
        )

    result = await transcribe.transcribe("weekly sync.mp3", b"ID3 fake audio bytes", provider(handler))
    assert isinstance(result, Transcript)
    assert result.seconds == 9.5 and result.language == "english"
    assert "[0:00] Hello team. The budget is approved." in result.text and "weekly sync.mp3" in result.text
    assert seen["url"] == "https://api.groq.com/openai/v1/audio/transcriptions"
    assert seen["auth"] == "Bearer gsk_test_key"
    body = seen["body"]
    for part in (
        b"whisper-large-v3-turbo",
        b"verbose_json",
        b'name="temperature"',
        b'filename="weekly sync.mp3"',
        b"audio/mpeg",
        b"ID3 fake audio bytes",
    ):
        assert part in body, part


@sync
async def test_a_path_in_the_file_name_is_not_sent():
    seen = {}

    def handler(request):
        seen["body"] = request.content
        return verbose([seg(0, 3, "Hello there everyone.")])

    await transcribe.transcribe("C:\\Users\\someone\\Desktop\\private\\call.wav", b"RIFF", provider(handler))
    assert b"someone" not in seen["body"] and b'filename="C:' not in seen["body"]


@sync
async def test_the_length_comes_from_the_last_segment_when_the_provider_gives_none():
    result = await transcribe.transcribe(
        "a.mp3", b"x", provider(lambda r: verbose([seg(0, 3, "Hi there."), seg(3, 61, "Long part.")]))
    )
    assert result.seconds == 61


@sync
async def test_words_without_timing_are_kept_without_times():
    def handler(request):
        return httpx.Response(200, json={"text": "Just the words, nothing else.", "segments": []})

    result = await transcribe.transcribe("a.mp3", b"x", provider(handler))
    assert result.text.endswith("Just the words, nothing else.") and "[" not in result.text


@pytest.mark.parametrize(
    "status, expected_status, words",
    [(400, 422, "could not be read"), (422, 422, "could not be read"), (413, 413, "too large"), (429, 503, "busy"),
     (401, 502, "not available"), (403, 502, "not available"), (500, 502, "could not be transcribed")],
)  # fmt: skip
@sync
async def test_provider_failures_become_plain_messages(status, expected_status, words):
    client = provider(lambda r: httpx.Response(status, text="internal details: secret=gsk_leak"))
    with pytest.raises(TranscriptionError) as caught:
        await transcribe.transcribe("a.mp3", b"x", client)
    assert caught.value.status == expected_status and words in caught.value.message
    assert "gsk_" not in caught.value.message and "secret" not in caught.value.message


@sync
async def test_timeouts_and_network_errors_are_reported():
    def slow(request):
        raise httpx.ReadTimeout("slow")

    def down(request):
        raise httpx.ConnectError("refused")

    with pytest.raises(TranscriptionError) as caught:
        await transcribe.transcribe("a.mp3", b"x", provider(slow))
    assert caught.value.status == 504
    with pytest.raises(TranscriptionError) as caught:
        await transcribe.transcribe("a.mp3", b"x", provider(down))
    assert caught.value.status == 502


@sync
async def test_a_reply_that_is_not_json_is_an_error():
    with pytest.raises(TranscriptionError) as caught:
        await transcribe.transcribe("a.mp3", b"x", provider(lambda r: httpx.Response(200, text="<html>")))
    assert caught.value.status == 502


@sync
async def test_a_recording_with_no_speech_is_refused():
    client = provider(lambda r: verbose([seg(0, 10, "Thanks for watching!", no_speech=0.97)]))
    with pytest.raises(TranscriptionError) as caught:
        await transcribe.transcribe("silence.wav", b"x", client)
    assert caught.value.status == 422 and "No speech" in caught.value.message


@sync
async def test_a_file_over_the_limit_is_refused_before_anything_is_sent(monkeypatch):
    sent = []
    monkeypatch.setattr(transcribe, "MAX_AUDIO_BYTES", 100)
    client = provider(lambda r: sent.append(r) or verbose([seg(0, 3, "Hi there.")]))
    with pytest.raises(TranscriptionError) as caught:
        await transcribe.transcribe("big.mp3", b"x" * 101, client)
    assert caught.value.status == 413 and "big.mp3" in caught.value.message and not sent


@sync
async def test_without_a_key_it_says_so(monkeypatch):
    monkeypatch.delenv("GROQ_API_KEY")
    with pytest.raises(TranscriptionError) as caught:
        await transcribe.transcribe("a.mp3", b"x", provider(lambda r: verbose([])))
    assert caught.value.status == 503


# --- through the service ---


@pytest.fixture
def client():
    return TestClient(main.app, raise_server_exceptions=False)


class Writer:
    async def ainvoke(self, prompt):
        self.prompt = prompt
        return type("Msg", (), {"content": "A summary of the meeting."})()

    async def astream(self, prompt):
        self.prompt = prompt
        yield type("Chunk", (), {"content": "A summary of the meeting."})()


MEETING = "Transcript of sync.mp3 (length 1:00).\n\n[0:00] Priya will send the budget by Friday."


@pytest.fixture
def meeting(monkeypatch):
    writer = Writer()
    monkeypatch.setattr(main, "get_llm", lambda: writer)

    async def fake(name, content, client=None):
        fake.calls.append((name, len(content)))
        return Transcript(text=MEETING, seconds=60)

    fake.calls = []
    monkeypatch.setattr(main, "transcribe", fake)
    return writer, fake


def test_a_recording_is_transcribed_then_summarized_like_any_document(client, meeting):
    writer, fake = meeting
    r = client.post("/summarize", files={"file": ("sync.mp3", b"audio bytes", "audio/mpeg")})
    assert r.status_code == 200
    assert r.json() == {"filename": "sync.mp3", "summary": "A summary of the meeting.", "text": MEETING}
    assert fake.calls == [("sync.mp3", 11)]
    assert "Priya will send the budget by Friday." in writer.prompt


def test_a_streamed_recording_keeps_its_transcript_for_chat(client, meeting):
    r = client.post("/summarize?stream=true", files={"file": ("sync.mp3", b"audio", "audio/mpeg")})
    done = [json.loads(line[6:]) for line in r.text.splitlines() if line.startswith("data: ")][-1]
    assert done == {"type": "done", "filename": "sync.mp3", "text": MEETING}


def test_a_recording_can_be_combined_with_a_document(client, meeting, monkeypatch):
    monkeypatch.setattr(main, "extract_pdf_text", lambda path: "the agenda said budget")
    files = [("files", ("agenda.pdf", b"%PDF", "application/pdf")), ("files", ("sync.mp3", b"audio", "audio/mpeg"))]
    body = client.post("/summarize-multiple", files=files).json()
    assert body["filename"] == "agenda.pdf, sync.mp3"
    assert "the agenda said budget" in body["text"] and "Priya will send the budget" in body["text"]


def test_transcription_problems_reach_the_caller_as_plain_errors(client, monkeypatch):
    async def busy(name, content, client=None):
        raise TranscriptionError(503, "The transcription service is busy right now. Please try again in a minute.")

    monkeypatch.setattr(main, "transcribe", busy)
    r = client.post("/summarize", files={"file": ("sync.mp3", b"audio", "audio/mpeg")})
    assert r.status_code == 503 and r.headers["retry-after"] == "30" and "busy" in r.json()["detail"]

    async def silent(name, content, client=None):
        raise TranscriptionError(422, "No speech was found in that recording.")

    monkeypatch.setattr(main, "transcribe", silent)
    r = client.post("/summarize?stream=true", files={"file": ("quiet.wav", b"audio", "audio/wav")})
    assert r.status_code == 422 and "No speech" in r.json()["detail"]


def test_documents_are_not_sent_to_the_speech_service(client, meeting, monkeypatch):
    monkeypatch.setattr(main, "extract_pdf_text", lambda path: "plain pdf words")
    r = client.post("/summarize", files={"file": ("report.pdf", b"%PDF", "application/pdf")})
    assert r.status_code == 200 and meeting[1].calls == []


@pytest.mark.parametrize(
    "path, name",
    [("C:\\Users\\me\\private\\call.wav", "call.wav"), ("/home/me/call.wav", "call.wav"), ("call.wav", "call.wav"),
     ("folder/sub\\mixed.mp3", "mixed.mp3"), ("", "")],
)  # fmt: skip
def test_only_the_file_name_is_used_whatever_the_path_looks_like(path, name):
    assert transcribe.base_name(path) == name


# ---- a spoken question -------------------------------------------------------------------------------------------


def test_what_was_said_is_one_plain_line_without_times_or_heading():
    segments = [
        {"start": 0.0, "end": 2.0, "text": " What is the notice "},
        {"start": 2.0, "end": 3.5, "text": "period?"},
        {"start": 4.0, "end": 5.0, "text": "Thanks for watching!", "no_speech_prob": 0.95},
    ]
    assert (
        transcribe.plain_speech(Transcript(text="Transcript of q.webm (length 0:05).", seconds=5, segments=segments))
        == "What is the notice period?"
    )
    assert (
        transcribe.plain_speech(Transcript(text="Transcript of q.webm.\n\nJust the words.", seconds=2))
        == "Just the words."
    )
    long = Transcript(text="x", seconds=1, segments=[{"start": 0, "end": 1, "text": "word " * 600}])
    assert len(transcribe.plain_speech(long)) == transcribe.VOICE_MAX_CHARS


@pytest.fixture
def voice(monkeypatch):
    async def fake(name, content, client=None):
        fake.calls.append((name, len(content)))
        return fake.result

    fake.calls = []
    fake.result = Transcript(
        text="Transcript of q.webm.",
        seconds=4,
        language="en",
        segments=[{"start": 0, "end": 3, "text": " Who pays the deposit? "}],
    )
    monkeypatch.setattr(main, "transcribe", fake)
    return fake


def test_a_spoken_question_comes_back_as_text(client, voice):
    r = client.post("/transcribe-voice", files={"file": ("question.webm", b"audio", "audio/webm")})
    assert r.status_code == 200 and r.json() == {"text": "Who pays the deposit?", "language": "en"}
    assert voice.calls == [("question.webm", 5)]


def test_a_question_that_is_not_audio_is_refused_before_anything_is_sent(client, voice):
    r = client.post("/transcribe-voice", files={"file": ("notes.pdf", b"%PDF", "application/pdf")})
    assert r.status_code == 422 and voice.calls == []


def test_a_question_that_is_too_big_or_too_long_is_refused(client, voice):
    big = b"x" * (transcribe.VOICE_MAX_BYTES + 1)
    r = client.post("/transcribe-voice", files={"file": ("question.webm", big, "audio/webm")})
    assert r.status_code == 413 and voice.calls == []
    voice.result = Transcript(
        text="t", seconds=transcribe.VOICE_MAX_SECONDS + 1, segments=[{"start": 0, "end": 1, "text": "hello"}]
    )
    r = client.post("/transcribe-voice", files={"file": ("question.webm", b"audio", "audio/webm")})
    assert r.status_code == 413 and "under a minute" in r.json()["detail"]


def test_a_silent_question_and_a_busy_service_are_explained(client, voice, monkeypatch):
    voice.result = Transcript(
        text="t", seconds=3, segments=[{"start": 0, "end": 1, "text": "hmm", "no_speech_prob": 0.99}]
    )
    r = client.post("/transcribe-voice", files={"file": ("question.webm", b"audio", "audio/webm")})
    assert r.status_code == 422 and "No speech" in r.json()["detail"]

    async def busy(name, content, client=None):
        raise TranscriptionError(503, "The transcription service is busy right now. Please try again in a minute.")

    monkeypatch.setattr(main, "transcribe", busy)
    r = client.post("/transcribe-voice", files={"file": ("question.webm", b"audio", "audio/webm")})
    assert r.status_code == 503 and r.headers["retry-after"] == "30"
