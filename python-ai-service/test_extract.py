import asyncio
import functools
import io
import zipfile

import httpx
import pytest
from fastapi.testclient import TestClient

import extract
import main
from extract import FetchError, UnreadableDocument
from retrieval import PAGE_BREAK


def sync(test):
    """Runs an async test to the end (no async test plugin is installed)."""

    @functools.wraps(test)
    def run(*args, **kwargs):
        return asyncio.run(test(*args, **kwargs))

    return run


W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"
P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main"
R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"


def make_zip(parts: dict[str, str]) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, content in parts.items():
            archive.writestr(name, content)
    return buffer.getvalue()


def paragraph(text: str, style: str = "", numbered: bool = False, tail: str = "") -> str:
    props = ""
    if style or numbered:
        props = (
            "<w:pPr>"
            + (f'<w:pStyle w:val="{style}"/>' if style else "")
            + ("<w:numPr/>" if numbered else "")
            + "</w:pPr>"
        )
    return f"<w:p>{props}<w:r><w:t>{text}</w:t></w:r>{tail}</w:p>"


def docx(*body: str) -> bytes:
    xml = f'<?xml version="1.0"?><w:document xmlns:w="{W_NS}"><w:body>{"".join(body)}</w:body></w:document>'
    return make_zip({"word/document.xml": xml})


def pptx(slides: list[str], order: list[int] | None = None) -> bytes:
    parts = {}
    for number, text in enumerate(slides, start=1):
        lines = "".join(f"<a:p><a:r><a:t>{line}</a:t></a:r></a:p>" for line in text.split("|"))
        parts[f"ppt/slides/slide{number}.xml"] = (
            f'<p:sld xmlns:p="{P_NS}" xmlns:a="{A_NS}"><p:cSld><p:spTree>{lines}</p:spTree></p:cSld></p:sld>'
        )
    if order is not None:
        ids = "".join(f'<p:sldId id="{256 + i}" r:id="rId{n}"/>' for i, n in enumerate(order))
        parts["ppt/presentation.xml"] = (
            f'<p:presentation xmlns:p="{P_NS}" xmlns:r="{R_NS}"><p:sldIdLst>{ids}</p:sldIdLst></p:presentation>'
        )
        rels = "".join(f'<Relationship Id="rId{n}" Target="slides/slide{n}.xml"/>' for n in range(1, len(slides) + 1))
        parts["ppt/_rels/presentation.xml.rels"] = (
            f'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">{rels}</Relationships>'
        )
    return make_zip(parts)


# --- Word ---


def test_docx_keeps_headings_lists_tables_and_text():
    text = extract.docx_text(
        docx(
            paragraph("Annual report", style="Title"),
            paragraph("Overview", style="Heading1"),
            paragraph("Revenue grew."),
            paragraph("First point", numbered=True),
            "<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Year</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>2025</w:t></w:r></w:p></w:tc></w:tr></w:tbl>",
        )
    )
    assert text.splitlines() == ["# Annual report", "# Overview", "Revenue grew.", "- First point", "Year | 2025"]


def test_docx_page_breaks_become_pages():
    page_break = '<w:r><w:br w:type="page"/></w:r>'
    rendered = "<w:r><w:lastRenderedPageBreak/></w:r>"
    text = extract.docx_text(
        docx(paragraph("One", tail=page_break), paragraph("Two", tail=rendered), paragraph("Three"))
    )
    assert text.count(PAGE_BREAK) == 2
    assert text.startswith("One" + PAGE_BREAK + "Two")


def test_docx_without_breaks_is_one_page():
    assert PAGE_BREAK not in extract.docx_text(docx(paragraph("Only"), paragraph("page")))


def test_docx_text_with_xml_characters():
    assert extract.docx_text(docx(paragraph("R&amp;D &lt;draft&gt;"))) == "R&D <draft>"


def test_office_files_that_are_not_office_files_are_refused():
    with pytest.raises(UnreadableDocument):
        extract.docx_text(b"definitely not a zip")
    with pytest.raises(UnreadableDocument):
        extract.docx_text(make_zip({"readme.txt": "hi"}))
    with pytest.raises(UnreadableDocument):
        extract.docx_text(make_zip({"word/document.xml": "<not-closed"}))


def test_xml_entity_tricks_are_refused():
    bomb = (
        '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">]>'
        f'<w:document xmlns:w="{W_NS}"><w:body><w:p><w:r><w:t>&b;</w:t></w:r></w:p></w:body></w:document>'
    )
    with pytest.raises(UnreadableDocument):
        extract.docx_text(make_zip({"word/document.xml": bomb}))


def test_parts_that_unpack_too_large_are_refused(monkeypatch):
    monkeypatch.setattr(extract, "MAX_PART_BYTES", 500)
    with pytest.raises(UnreadableDocument):
        extract.docx_text(docx(paragraph("x" * 2000)))
    monkeypatch.setattr(extract, "MAX_PART_BYTES", 40_000_000)
    monkeypatch.setattr(extract, "MAX_TOTAL_PART_BYTES", 500)
    with pytest.raises(UnreadableDocument):
        extract.docx_text(docx(paragraph("x" * 2000)))


# --- PowerPoint ---


def test_pptx_is_one_page_per_slide_in_the_order_shown():
    content = pptx(["Created first|Details A", "Created second", "Created third"], order=[3, 1, 2])
    text = extract.pptx_text(content)
    assert text.split(PAGE_BREAK) == ["Created third", "Created first\nDetails A", "Created second"]


def test_pptx_without_a_slide_list_uses_the_file_numbers():
    slides = [f"Slide {n}" for n in range(1, 12)]
    assert extract.pptx_text(pptx(slides)).split(PAGE_BREAK) == slides


def test_pptx_without_slides_is_refused():
    with pytest.raises(UnreadableDocument):
        extract.pptx_text(make_zip({"readme.txt": "hi"}))


def test_office_text_picks_the_reader_by_extension():
    assert extract.office_text("Notes.DOCX", docx(paragraph("hello"))) == "hello"
    assert extract.office_text("deck.pptx", pptx(["hi"])) == "hi"
    assert extract.office_text("manual.pdf", b"%PDF") is None


# --- web pages: reading HTML ---

ARTICLE = "A sentence that is long enough to matter in the article body. " * 20

PAGE = f"""<!doctype html><html><head><title>Fallback title</title>
<meta property="og:title" content="The real title">
<style>.x {{ color: red }}</style><script>var tracking = "do not read me";</script></head>
<body class="has-sidebar">
<nav><a href="/">Home</a><a href="/about">About</a></nav>
<div class="cookie-banner">We use cookies</div>
<article><h1>Heading one</h1><p>First paragraph &amp; more.</p>
<ul><li>Item A</li><li>Item B</li></ul><h2>Part two</h2><p>{ARTICLE}</p></article>
<aside>You may also like</aside><footer>Copyright</footer></body></html>"""


def test_html_to_text_keeps_the_article_and_drops_the_furniture():
    title, text = extract.html_to_text(PAGE)
    assert title == "The real title"
    assert text.startswith(
        "# Heading one\n\nFirst paragraph & more.\n\n- Item A\n- Item B\n\n## Part two\n\nA sentence"
    )
    for noise in ("Home", "cookies", "tracking", "You may also like", "Copyright", "color: red"):
        assert noise not in text


def test_html_title_falls_back_to_title_tag_then_first_heading():
    assert (
        extract.html_to_text("<html><head><title> Plain  title </title></head><body><p>x</p></body></html>")[0]
        == "Plain title"
    )
    assert extract.html_to_text("<body><h1>From heading</h1><p>x</p></body>")[0] == "From heading"


def test_a_wrapper_class_name_does_not_hide_the_page():
    body = "<p>" + ("Real words on a page with an unlucky wrapper class. " * 12) + "</p>"
    _, text = extract.html_to_text(
        f'<html><body class="sidebar-open"><div class="share-wrapper">{body}</div></body></html>'
    )
    assert "Real words on a page" in text


def test_pages_without_an_article_use_the_whole_body():
    body = "<div><p>" + ("Plain page words. " * 30) + "</p></div>"
    assert "Plain page words." in extract.html_to_text(f"<html><body>{body}<footer>bye</footer></body></html>")[1]


def test_badly_formed_html_still_reads():
    _, text = extract.html_to_text("<p>One<p>Two<li>Three<li>Four<b>bold</i></div>")
    assert "One" in text and "Two" in text and "Three" in text and "Four" in text


def test_decode_body_uses_the_declared_charset():
    assert extract.decode_body("café".encode("latin-1"), "iso-8859-1") == "café"
    assert extract.decode_body('<meta charset="windows-1250"><p>č</p>'.encode("cp1250"), None).endswith("č</p>")
    assert extract.decode_body("ünï".encode(), None) == "ünï"
    assert extract.decode_body(b"\xff\xfe broken", "utf-8")  # never raises


# --- web pages: addresses ---


@pytest.mark.parametrize(
    "address",
    [
        "127.0.0.1",
        "10.1.2.3",
        "172.16.0.9",
        "192.168.1.1",
        "169.254.169.254",
        "100.64.0.1",
        "0.0.0.0",
        "::1",
        "fe80::1",
        "fc00::1",
        "::ffff:127.0.0.1",
        "224.0.0.1",
        "not-an-ip",
    ],
)
def test_private_and_special_addresses_are_not_public(address):
    assert not extract.is_public_address(address)


@pytest.mark.parametrize("address", ["93.184.216.34", "8.8.8.8", "2606:4700:4700::1111"])
def test_public_addresses_are_public(address):
    assert extract.is_public_address(address)


def test_check_url_cleans_and_rejects():
    assert extract.check_url("  https://example.com/a?b=1 ") == "https://example.com/a?b=1"
    assert extract.check_url("example.com/post") == "https://example.com/post"
    for bad in [
        "",
        "   ",
        "ftp://example.com",
        "file:///etc/passwd",
        "javascript:alert(1)",
        "https://user:pw@example.com/",
        "https://example.com:99999/",
        "https:///nohost",
        "x" * 3000,
    ]:
        with pytest.raises(FetchError) as caught:
            extract.check_url(bad)
        assert caught.value.status == 422


@sync
async def test_resolve_public_refuses_loopback_and_private_hosts():
    for host in ("127.0.0.1", "localhost", "10.0.0.5", "169.254.169.254", "[::1]".strip("[]")):
        with pytest.raises(FetchError):
            await extract.resolve_public(host, 80)
    await extract.resolve_public("93.184.216.34", 80)  # a literal public address needs no lookup


# --- web pages: fetching (a fake network, no real requests) ---


@pytest.fixture
def public_dns(monkeypatch):
    """Every host looks public, except names that start with "internal"."""

    async def resolve(host, port):
        if host.startswith("internal") or host == "localhost":
            raise FetchError(422, "That address is not on the public internet, so Inkling cannot open it.")

    monkeypatch.setattr(extract, "resolve_public", resolve)


def serving(routes: dict[str, httpx.Response]):
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        return routes.get(str(request.url), httpx.Response(404))

    return httpx.AsyncClient(transport=httpx.MockTransport(handler), follow_redirects=False), seen


def html_response(body: str, status=200, content_type="text/html; charset=utf-8", headers=None):
    return httpx.Response(status, content=body.encode(), headers={"content-type": content_type, **(headers or {})})


@sync
async def test_fetch_page_returns_html(public_dns):
    client, _ = serving({"https://news.example/post": html_response(PAGE)})
    page = await extract.fetch_page("https://news.example/post", client)
    assert page.kind == "html" and page.charset == "utf-8" and b"The real title" in page.body


@sync
async def test_fetch_page_follows_redirects_and_checks_every_hop(public_dns):
    client, seen = serving(
        {
            "https://short.example/a": httpx.Response(301, headers={"location": "https://news.example/final"}),
            "https://news.example/final": html_response("<p>ok</p>"),
            "https://short.example/evil": httpx.Response(302, headers={"location": "https://internal.example/admin"}),
            "https://short.example/loop": httpx.Response(302, headers={"location": "/loop"}),
        }
    )
    page = await extract.fetch_page("https://short.example/a", client)
    assert page.final_url == "https://news.example/final"

    with pytest.raises(FetchError) as caught:
        await extract.fetch_page("https://short.example/evil", client)
    assert "public internet" in caught.value.message
    assert not any("internal.example" in url for url in seen), "the private address must never be requested"

    with pytest.raises(FetchError) as caught:
        await extract.fetch_page("https://short.example/loop", client)
    assert "too many" in caught.value.message


@sync
async def test_fetch_page_refuses_a_redirect_to_another_scheme(public_dns):
    client, _ = serving({"https://a.example/x": httpx.Response(302, headers={"location": "file:///etc/passwd"})})
    with pytest.raises(FetchError) as caught:
        await extract.fetch_page("https://a.example/x", client)
    assert caught.value.status == 422


@sync
async def test_fetch_page_reports_what_went_wrong(public_dns):
    client, _ = serving(
        {
            "https://a.example/gone": httpx.Response(404),
            "https://a.example/login": httpx.Response(403),
            "https://a.example/broken": httpx.Response(500),
            "https://a.example/image": httpx.Response(200, content=b"GIF89a", headers={"content-type": "image/gif"}),
            "https://a.example/big": httpx.Response(
                200, content=b"x" * (extract.MAX_PAGE_BYTES + 10), headers={"content-type": "text/html"}
            ),
        }
    )
    expected = {"gone": 422, "login": 422, "broken": 502, "image": 422, "big": 413}
    for name, status in expected.items():
        with pytest.raises(FetchError) as caught:
            await extract.fetch_page(f"https://a.example/{name}", client)
        assert caught.value.status == status, name


@sync
async def test_fetch_page_maps_timeouts_and_network_errors(public_dns):
    def handler(request):
        raise httpx.ConnectTimeout("slow")

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    with pytest.raises(FetchError) as caught:
        await extract.fetch_page("https://a.example/", client)
    assert caught.value.status == 504

    def refuse(request):
        raise httpx.ConnectError("refused")

    client = httpx.AsyncClient(transport=httpx.MockTransport(refuse))
    with pytest.raises(FetchError) as caught:
        await extract.fetch_page("https://a.example/", client)
    assert caught.value.status == 502


@sync
async def test_fetch_page_checks_the_address_the_connection_went_to(public_dns):
    class Stream:
        def __init__(self, address):
            self.address = address

        def get_extra_info(self, name):
            return self.address if name == "server_addr" else None

    def respond(address):
        return httpx.Response(
            200,
            content=b"<p>secret</p>",
            headers={"content-type": "text/html"},
            extensions={"network_stream": Stream(address)},
        )

    private = httpx.AsyncClient(transport=httpx.MockTransport(lambda request: respond(("10.0.0.7", 443))))
    with pytest.raises(FetchError) as caught:
        await extract.fetch_page("https://rebinding.example/", private)
    assert "public internet" in caught.value.message

    public = httpx.AsyncClient(transport=httpx.MockTransport(lambda request: respond(("93.184.216.34", 443))))
    assert (await extract.fetch_page("https://fine.example/", public)).kind == "html"


# --- the endpoint ---


@pytest.fixture
def client():
    return TestClient(main.app, raise_server_exceptions=False)


class Reply:
    def __init__(self, text="summary"):
        self.text = text

    async def ainvoke(self, prompt):
        return type("Msg", (), {"content": self.text})()

    async def astream(self, prompt):
        yield type("Chunk", (), {"content": self.text})()


def fake_page(monkeypatch, html: str, final_url="https://news.example/post", kind="html"):
    async def fetch(url):
        return extract.Fetched(kind, html.encode(), "utf-8", final_url)

    monkeypatch.setattr(main, "fetch_page", fetch)
    monkeypatch.setattr(main, "get_llm", lambda: Reply())


def test_summarize_url_returns_the_title_and_the_page_text(client, monkeypatch):
    fake_page(monkeypatch, PAGE)
    r = client.post("/summarize-url", json={"url": "https://news.example/post"})
    assert r.status_code == 200
    body = r.json()
    assert body["filename"] == "The real title" and body["summary"] == "summary"
    assert body["text"].startswith("# Heading one") and "Copyright" not in body["text"]


def test_read_url_gives_the_title_and_text_without_a_summary(client, monkeypatch):
    fake_page(monkeypatch, PAGE)
    r = client.post("/read-url", json={"url": "https://news.example/post"})
    assert r.status_code == 200
    body = r.json()
    assert body["filename"] == "The real title" and "summary" not in body
    assert body["text"].startswith("# Heading one") and "Copyright" not in body["text"]


def test_read_url_refuses_pages_with_no_readable_text(client, monkeypatch):
    fake_page(monkeypatch, '<html><body><div id="app"></div><script>render()</script></body></html>')
    r = client.post("/read-url", json={"url": "https://spa.example/"})
    assert r.status_code == 422 and "readable text" in r.json()["detail"]
    assert client.post("/read-url", json={}).status_code == 422


def test_summarize_url_streams_with_the_title_in_the_done_event(client, monkeypatch):
    fake_page(monkeypatch, PAGE)
    r = client.post("/summarize-url?stream=true", json={"url": "https://news.example/post"})
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/event-stream")
    done = [line for line in r.text.splitlines() if line.startswith("data:")][-1]
    assert '"filename": "The real title"' in done


def test_summarize_url_names_a_page_without_a_title_after_its_site(client, monkeypatch):
    fake_page(monkeypatch, "<body><p>" + "Words about something. " * 30 + "</p></body>", "https://www.site.example/x")
    assert (
        client.post("/summarize-url", json={"url": "https://www.site.example/x"}).json()["filename"] == "site.example"
    )


def test_summarize_url_refuses_pages_with_no_readable_text(client, monkeypatch):
    fake_page(monkeypatch, '<html><body><div id="app"></div><script>render()</script></body></html>')
    r = client.post("/summarize-url", json={"url": "https://spa.example/"})
    assert r.status_code == 422 and "readable text" in r.json()["detail"]


def test_summarize_url_passes_fetch_errors_on_as_plain_messages(client, monkeypatch):
    async def fetch(url):
        raise FetchError(422, "That address is not on the public internet, so Inkling cannot open it.")

    monkeypatch.setattr(main, "fetch_page", fetch)
    r = client.post("/summarize-url?stream=true", json={"url": "http://127.0.0.1:8000/"})
    assert r.status_code == 422 and "public internet" in r.json()["detail"]


def test_summarize_url_checks_the_options_first(client, monkeypatch):
    fake_page(monkeypatch, PAGE)
    assert client.post("/summarize-url?style=poem", json={"url": "https://news.example/post"}).status_code == 422
    assert client.post("/summarize-url", json={}).status_code == 422


def test_summarize_url_reads_a_pdf_link(client, monkeypatch):
    fake_page(monkeypatch, "%PDF-fake", "https://files.example/reports/q3-report.pdf", kind="pdf")
    monkeypatch.setattr(main, "extract_pdf_text", lambda path: "Quarterly results were strong. " * 20)
    body = client.post("/summarize-url", json={"url": "https://files.example/reports/q3-report.pdf"}).json()
    assert body["filename"] == "q3-report.pdf" and body["text"].startswith("Quarterly results")


# --- uploads: Word and PowerPoint through the same endpoints ---

DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"


def test_summarize_accepts_a_word_file(client, monkeypatch):
    monkeypatch.setattr(main, "get_llm", lambda: Reply())
    content = docx(paragraph("Contract terms", style="Heading1"), paragraph("The tenant pays monthly."))
    r = client.post("/summarize", files={"file": ("lease.docx", content, DOCX_TYPE)})
    assert r.status_code == 200
    assert r.json() == {
        "filename": "lease.docx",
        "summary": "summary",
        "text": "# Contract terms\nThe tenant pays monthly.",
    }


def test_summarize_multiple_mixes_pdf_word_and_powerpoint(client, monkeypatch):
    monkeypatch.setattr(main, "get_llm", lambda: Reply())
    monkeypatch.setattr(main, "extract_pdf_text", lambda path: "pdf words")
    files = [
        ("files", ("a.pdf", b"%PDF", "application/pdf")),
        ("files", ("b.docx", docx(paragraph("word words")), DOCX_TYPE)),
        ("files", ("c.pptx", pptx(["slide words"]), "application/octet-stream")),
    ]
    body = client.post("/summarize-multiple", files=files).json()
    assert body["filename"] == "a.pdf, b.docx (+1 more)"
    for part in ("pdf words", "word words", "slide words"):
        assert part in body["text"]


def test_a_broken_word_file_is_a_plain_error(client, monkeypatch):
    monkeypatch.setattr(main, "get_llm", lambda: Reply())
    r = client.post("/summarize", files={"file": ("broken.docx", b"not a zip", DOCX_TYPE)})
    assert r.status_code == 422 and "broken.docx" in r.json()["detail"]


# --- navigation lists and long pages ---


def test_a_run_of_link_only_list_items_is_navigation_and_is_dropped():
    languages = "".join(f'<li><a href="/{n}">Language {n}</a></li>' for n in range(6))
    text = extract.html_to_text(f"<body><ul>{languages}</ul><p>{'Body words of the page. ' * 20}</p></body>")[1]
    assert "Language" not in text and "Body words of the page." in text


def test_a_short_list_of_links_and_linked_sentences_are_content():
    few = "".join(f'<li><a href="/{n}">Related reading {n}</a></li>' for n in range(3))
    sentence = '<li><a href="/x">A link</a> inside a sentence that goes on to say something real about it.</li>' * 6
    text = extract.html_to_text(f"<body><ul>{few}</ul><ul>{sentence}</ul><p>{'More words here. ' * 20}</p></body>")[1]
    assert "Related reading 0" in text and "Related reading 2" in text
    assert text.count("inside a sentence") == 6


def test_a_page_longer_than_the_limit_is_refused_not_cut_short(client, monkeypatch):
    fake_page(monkeypatch, "<body><p>" + "Long page words. " * 13_000 + "</p></body>")
    r = client.post("/summarize-url", json={"url": "https://news.example/book"})
    assert r.status_code == 413 and "too long" in r.json()["detail"]
