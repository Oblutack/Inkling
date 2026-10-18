"""Getting the words out of things that are not plain text: Word and PowerPoint files, and web pages.

Everything here is plain Python (zipfile, XML, html.parser, httpx), so there is nothing extra to install,
patch or audit. Page boundaries are kept as form feeds (see retrieval.PAGE_BREAK) wherever the format
has real pages, so chat answers can still say which page or slide they came from.

Files and web pages are untrusted input. The Word and PowerPoint readers refuse documents that unpack to
something huge or that declare XML entities (the classic "billion laughs" trick), and the web page fetcher
refuses to talk to anything but the public internet (see fetch_page).
"""

import asyncio
import io
import ipaddress
import re
import socket
import zipfile
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from html.parser import HTMLParser
from typing import Optional
from urllib import robotparser
from urllib.parse import urljoin, urlsplit
from xml.etree import ElementTree

import httpx

from retrieval import PAGE_BREAK

# ---- Word and PowerPoint --------------------------------------------------------------------

# The most one XML part of an Office file may unpack to. Real documents are far below this; a
# "zip bomb" is a small file that unpacks to gigabytes.
MAX_PART_BYTES = 40 * 1024 * 1024
MAX_TOTAL_PART_BYTES = 80 * 1024 * 1024

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
P = "{http://schemas.openxmlformats.org/presentationml/2006/main}"
R = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
REL = "{http://schemas.openxmlformats.org/package/2006/relationships}"


class UnreadableDocument(Exception):
    """The file is not a Word or PowerPoint document this reader can open."""


def _open_zip(content: bytes) -> zipfile.ZipFile:
    try:
        archive = zipfile.ZipFile(io.BytesIO(content))
    except zipfile.BadZipFile as exc:
        raise UnreadableDocument("not a zip file") from exc
    if sum(info.file_size for info in archive.infolist()) > MAX_TOTAL_PART_BYTES:
        raise UnreadableDocument("unpacks to too much data")
    return archive


def _read_xml(archive: zipfile.ZipFile, name: str) -> ElementTree.Element:
    try:
        info = archive.getinfo(name)
    except KeyError as exc:
        raise UnreadableDocument(f"{name} is missing") from exc
    if info.file_size > MAX_PART_BYTES:
        raise UnreadableDocument(f"{name} is too large")
    with archive.open(info) as part:
        data = part.read(MAX_PART_BYTES + 1)
    if len(data) > MAX_PART_BYTES:
        raise UnreadableDocument(f"{name} is too large")
    # Office XML never has a document type declaration. One means entity tricks, so it is refused.
    if b"<!DOCTYPE" in data[:4096].upper() or b"<!ENTITY" in data.upper():
        raise UnreadableDocument("unexpected XML declarations")
    try:
        return ElementTree.fromstring(data)
    except ElementTree.ParseError as exc:
        raise UnreadableDocument(f"{name} is not valid XML") from exc


def _tidy(text: str) -> str:
    return re.sub(r"[ \t ]+", " ", text).strip()


# -- Word

_HEADING_STYLE = re.compile(r"^(?:heading|titre|überschrift|ueberschrift|título|titulo)\s*(\d)?$", re.I)


def _paragraph_text(paragraph: ElementTree.Element) -> tuple[str, bool]:
    """The words of one paragraph, and whether a page break happens inside it (before the text that
    follows the break is not tracked: the break is applied after the paragraph that holds it)."""
    parts: list[str] = []
    page_break = False
    for node in paragraph.iter():
        if node.tag == W + "t" and node.text:
            parts.append(node.text)
        elif node.tag == W + "tab":
            parts.append(" ")
        elif node.tag == W + "br":
            if node.get(W + "type") == "page":
                page_break = True
            else:
                parts.append("\n")
        elif node.tag == W + "lastRenderedPageBreak":
            page_break = True
    return "".join(parts), page_break


def _paragraph_prefix(paragraph: ElementTree.Element) -> str:
    properties = paragraph.find(W + "pPr")
    if properties is None:
        return ""
    style = properties.find(W + "pStyle")
    name = (style.get(W + "val") if style is not None else "") or ""
    name = re.sub(r"[\s_-]+", "", name)
    if name.lower() == "title":
        return "# "
    heading = _HEADING_STYLE.match(name)
    if heading:
        return "#" * min(int(heading.group(1) or 1), 3) + " "
    if properties.find(W + "numPr") is not None:
        return "- "
    return ""


def docx_text(content: bytes) -> str:
    """The text of a .docx: headings and list items as light Markdown, tables as rows of cells, and a
    page break wherever Word (or the author) put one."""
    archive = _open_zip(content)
    root = _read_xml(archive, "word/document.xml")
    body = root.find(W + "body")
    if body is None:
        raise UnreadableDocument("no document body")

    lines: list[str] = []
    pending_break = False

    def add(line: str, page_break: bool) -> None:
        nonlocal pending_break
        if line:
            if pending_break:
                lines.append(PAGE_BREAK)
                pending_break = False
            lines.append(line)
        if page_break:
            pending_break = True

    def walk(parent: ElementTree.Element) -> None:
        for child in parent:
            if child.tag == W + "p":
                text, page_break = _paragraph_text(child)
                text = _tidy(text.replace("\n", " "))
                add(_paragraph_prefix(child) + text if text else "", page_break)
            elif child.tag == W + "tbl":
                for row in child.iter(W + "tr"):
                    cells = []
                    for cell in row.findall(W + "tc"):
                        cell_text = " ".join(
                            _tidy(_paragraph_text(p)[0].replace("\n", " ")) for p in cell.iter(W + "p")
                        )
                        cells.append(_tidy(cell_text))
                    if any(cells):
                        add(" | ".join(cells), False)
            elif child.tag in (W + "sdt", W + "sdtContent", W + "customXml"):
                walk(child)

    walk(body)
    # A form feed on its own line would split the text into an empty page; join pages with one.
    text = "\n".join(lines)
    return text.replace("\n" + PAGE_BREAK + "\n", PAGE_BREAK)


# -- PowerPoint


def _slide_paths(archive: zipfile.ZipFile) -> list[str]:
    """The slide files in the order they are shown (presentation.xml lists them; the numbers in the file
    names are only the order they were created in)."""
    try:
        presentation = _read_xml(archive, "ppt/presentation.xml")
        rels = _read_xml(archive, "ppt/_rels/presentation.xml.rels")
        targets = {rel.get("Id"): rel.get("Target") for rel in rels.iter(REL + "Relationship")}
        ordered: list[str] = []
        for slide_id in presentation.iter(P + "sldId"):
            target = targets.get(slide_id.get(R + "id"))
            if target:
                ordered.append(target.lstrip("/") if target.startswith("/") else "ppt/" + target)
        ordered = [path for path in ordered if path in archive.namelist()]
        if ordered:
            return ordered
    except UnreadableDocument:
        pass
    numbered = [n for n in archive.namelist() if re.fullmatch(r"ppt/slides/slide\d+\.xml", n)]
    return sorted(numbered, key=lambda n: int(re.findall(r"\d+", n)[-1]))


def pptx_text(content: bytes) -> str:
    """The text of a .pptx: one page per slide, in the order shown."""
    archive = _open_zip(content)
    slides: list[str] = []
    for path in _slide_paths(archive):
        root = _read_xml(archive, path)
        lines = []
        for paragraph in root.iter(A + "p"):
            text = _tidy("".join((t.text or "") for t in paragraph.iter(A + "t")))
            if text:
                lines.append(text)
        slides.append("\n".join(lines))
    if not slides:
        raise UnreadableDocument("no slides")
    return PAGE_BREAK.join(slides)


OFFICE_READERS = {".docx": docx_text, ".pptx": pptx_text}


def office_text(filename: str, content: bytes) -> Optional[str]:
    """The text of a Word or PowerPoint file, or None if the extension is not one of them."""
    name = filename.lower()
    for extension, reader in OFFICE_READERS.items():
        if name.endswith(extension):
            return reader(content)
    return None


# ---- Web pages --------------------------------------------------------------------------------

MAX_PAGE_BYTES = 5 * 1024 * 1024
MAX_DOCUMENT_BYTES = 10 * 1024 * 1024
FETCH_TIMEOUT_SECONDS = 12.0  # per step: connecting, waiting for the next piece of the page
FETCH_TOTAL_SECONDS = 30.0  # the whole download, so a server that drips bytes cannot hold a request open
MAX_REDIRECTS = 5
MAX_URL_CHARS = 2048
USER_AGENT = "Mozilla/5.0 (compatible; Inkling/1.0; +https://github.com/Oblutack/Inkling)"
HTML_TYPES = ("text/html", "application/xhtml+xml")
TEXT_TYPES = ("text/plain",)
PDF_TYPES = ("application/pdf",)


class FetchError(Exception):
    """A page could not be fetched. `status` is the HTTP status to report, `message` is safe to show."""

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


@dataclass
class Fetched:
    kind: str  # "html", "text" or "pdf"
    body: bytes
    charset: Optional[str]
    final_url: str


def is_public_address(value: str) -> bool:
    """True only for addresses on the public internet: not loopback, private, link-local (which includes
    the cloud metadata address 169.254.169.254), carrier-grade NAT, multicast or otherwise reserved."""
    try:
        address = ipaddress.ip_address(value.split("%")[0])
    except ValueError:
        return False
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped:
        address = address.ipv4_mapped
    return address.is_global and not address.is_multicast


def check_url(raw: str) -> str:
    """Validates the address a person typed and returns it cleaned up."""
    url = raw.strip()
    if not url or len(url) > MAX_URL_CHARS:
        raise FetchError(422, "That does not look like a web address.")
    if "://" not in url:
        url = "https://" + url
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise FetchError(422, "Only http and https web addresses are supported.")
    if parts.username or parts.password:
        raise FetchError(422, "Web addresses with a user name or password are not supported.")
    try:
        parts.port  # noqa: B018 - raises ValueError for a port outside 1-65535
    except ValueError as exc:
        raise FetchError(422, "That does not look like a web address.") from exc
    return url


async def resolve_public(host: str, port: int) -> None:
    """Refuses a host that is, or points at, anything but the public internet."""
    try:
        infos = await asyncio.get_running_loop().getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise FetchError(422, "That address could not be found. Check that it is typed correctly.") from exc
    addresses = {str(info[4][0]) for info in infos}
    if not addresses or not all(is_public_address(address) for address in addresses):
        raise FetchError(422, "That address is not on the public internet, so Inkling cannot open it.")


def _kind_of(content_type: str) -> Optional[str]:
    base = content_type.split(";")[0].strip().lower()
    if base in HTML_TYPES:
        return "html"
    if base in TEXT_TYPES:
        return "text"
    if base in PDF_TYPES:
        return "pdf"
    return None


def _charset_of(content_type: str) -> Optional[str]:
    match = re.search(r"charset=([\w.:-]+)", content_type, re.I)
    return match.group(1).strip("\"'") if match else None


async def fetch_page(raw_url: str, client: Optional[httpx.AsyncClient] = None) -> Fetched:
    """Downloads a web page (or a PDF or text file at a link) for summarizing.

    The service must never become a way to reach private things from the outside, so:
      - only http(s), and only hosts that resolve to public addresses, checked again on every redirect;
      - the address the connection actually went to is checked before any of the reply is read, which
        also closes the gap between "looked up" and "connected" (DNS rebinding);
      - no proxies, no cookies, no credentials, a short timeout and a size cap.
    """
    try:
        async with asyncio.timeout(FETCH_TOTAL_SECONDS):
            return await _fetch(raw_url, client)
    except TimeoutError as exc:
        raise FetchError(504, "That page took too long to answer.") from exc


async def _fetch(raw_url: str, client: Optional[httpx.AsyncClient]) -> Fetched:
    url = check_url(raw_url)
    owns_client = client is None
    if client is None:
        client = httpx.AsyncClient(
            follow_redirects=False,
            trust_env=False,
            timeout=httpx.Timeout(FETCH_TIMEOUT_SECONDS),
            headers={
                "User-Agent": USER_AGENT,
                "Accept": "text/html,application/xhtml+xml,application/pdf,text/plain;q=0.8",
            },
        )
    try:
        for _ in range(MAX_REDIRECTS + 1):
            parts = urlsplit(url)
            await resolve_public(parts.hostname or "", parts.port or (443 if parts.scheme == "https" else 80))
            try:
                async with client.stream("GET", url) as response:
                    _check_peer(response)
                    if response.is_redirect:
                        location = response.headers.get("location")
                        if not location:
                            raise FetchError(502, "That page redirected somewhere Inkling could not follow.")
                        url = check_url(urljoin(url, location))
                        continue
                    if response.status_code in (401, 403):
                        raise FetchError(422, "That page needs a login or does not allow Inkling to read it.")
                    if response.status_code == 404 or response.status_code == 410:
                        raise FetchError(422, "That page was not found (it may have moved or been removed).")
                    if response.status_code >= 400:
                        raise FetchError(502, f"That site answered with an error ({response.status_code}).")
                    content_type = response.headers.get("content-type", "")
                    kind = _kind_of(content_type)
                    if kind is None:
                        raise FetchError(
                            422,
                            "That link is not a web page, PDF or text file. Download the file and attach it instead.",
                        )
                    limit = MAX_DOCUMENT_BYTES if kind == "pdf" else MAX_PAGE_BYTES
                    body = bytearray()
                    async for chunk in response.aiter_bytes():
                        body.extend(chunk)
                        if len(body) > limit:
                            raise FetchError(413, "That page is too large.")
                    return Fetched(kind, bytes(body), _charset_of(content_type), str(response.url))
            except httpx.TimeoutException as exc:
                raise FetchError(504, "That page took too long to answer.") from exc
            except httpx.HTTPError as exc:
                raise FetchError(502, "Inkling could not reach that page.") from exc
        raise FetchError(502, "That page redirected too many times.")
    finally:
        if owns_client:
            await client.aclose()


ROBOTS_NAME = "Inkling"
MAX_ROBOTS_BYTES = 512 * 1024


async def robots_allows(raw_url: str, fetch: Optional[Callable[[str], Awaitable[Fetched]]] = None) -> bool:
    """Whether the site's robots.txt lets Inkling open this address by itself. Used for pages that are checked over
    and over, not for a page a person asks to be read once. A site with no robots.txt, or one that cannot be read,
    allows it: the file only counts when it can be read and says no."""
    parts = urlsplit(raw_url)
    if parts.scheme not in ("http", "https") or not parts.netloc:
        return True
    robots_url = f"{parts.scheme}://{parts.netloc}/robots.txt"
    try:
        page = await (fetch or fetch_page)(robots_url)
    except FetchError:
        return True
    if page.kind != "text" or len(page.body) > MAX_ROBOTS_BYTES:
        return True
    parser = robotparser.RobotFileParser()
    parser.parse(decode_body(page.body, page.charset).splitlines())
    return parser.can_fetch(ROBOTS_NAME, raw_url)


def _check_peer(response: httpx.Response) -> None:
    """Rejects a reply that came from a non-public address (when the connection can tell us)."""
    stream = response.extensions.get("network_stream")
    address = stream.get_extra_info("server_addr") if stream is not None else None
    if address and not is_public_address(str(address[0])):
        raise FetchError(422, "That address is not on the public internet, so Inkling cannot open it.")


# -- Reading HTML


_SKIP = {
    "script", "style", "noscript", "template", "svg", "iframe", "canvas", "nav", "footer", "aside",
    "form", "button", "select", "menu", "dialog", "head", "object", "embed", "audio", "video",
}  # fmt: skip
_BLOCK = {
    "p", "div", "section", "article", "main", "header", "li", "ul", "ol", "br", "tr", "table", "blockquote",
    "pre", "figure", "figcaption", "h1", "h2", "h3", "h4", "h5", "h6", "dd", "dt", "dl", "hr", "details", "summary",
}  # fmt: skip
_VOID = {"br", "hr", "img", "input", "meta", "link", "source", "wbr", "area", "base", "col", "embed", "param", "track"}
_STRUCTURE = {"html", "body", "main", "article", "section"}
LINKY = "\x01"  # marks a list item that is almost entirely a link
LINKY_RUN = 4  # this many in a row is a menu, a language list or a category list, not content
_NOISE = re.compile(
    r"(?:^|[\s_-])(?:cookie|consent|banner|advert|ads?|promo|newsletter|subscribe|comments?|sidebar|share|social|related|breadcrumbs?|popup|modal)(?:$|[\s_-])",
    re.I,
)


class _Reader(HTMLParser):
    """Collects the readable text of a page: the whole body, and separately what is inside <article> or
    <main>, which is preferred when it holds most of the words."""

    def __init__(self, filter_noise: bool = True) -> None:
        super().__init__(convert_charrefs=True)
        self._filter_noise = filter_noise
        self.title = ""
        self.og_title = ""
        self.first_h1 = ""
        self._stack: list[tuple[str, bool]] = []  # (tag, hides what is inside)
        self._hidden = 0
        self._in_title = False
        self._in_h1 = False
        self._main_depth = 0
        self._link_depth = 0
        self._items: list[dict] = []  # the list items being read: where they start and how much of them is link
        self._parts: list[list] = []  # [text, whether it is inside <article> or <main>]

    @property
    def body(self) -> list[str]:
        return [text for text, _ in self._parts]

    @property
    def main(self) -> list[str]:
        return [text for text, inside in self._parts if inside]

    def _emit(self, text: str) -> None:
        self._parts.append([text, self._main_depth > 0])

    def handle_starttag(self, tag: str, attrs: list[tuple[str, Optional[str]]]) -> None:
        values = dict(attrs)
        if tag == "meta" and (values.get("property") or "").lower() == "og:title" and values.get("content"):
            self.og_title = _tidy(values["content"] or "")
        if tag in _VOID:
            if tag in _BLOCK:
                self._emit("\n")
            return
        # Class names like "ad", "share" or "comments" mark page furniture, but a wrapper (<body class="has-sidebar">)
        # must never hide the whole page, so the names are only trusted on ordinary elements.
        noisy = (
            self._filter_noise
            and tag not in _STRUCTURE
            and bool(_NOISE.search(f"{values.get('class') or ''} {values.get('id') or ''}"))
        )
        hidden_attribute = values.get("aria-hidden") == "true" or "hidden" in values
        hides = tag in _SKIP or noisy or hidden_attribute
        if tag == "title":
            self._in_title = True
        self._stack.append((tag, hides))
        if tag in ("article", "main"):
            self._main_depth += 1
        if tag == "a":
            self._link_depth += 1
        if hides:
            self._hidden += 1
            if tag == "li":
                self._items.append({"at": None, "chars": 0, "links": 0})
            return
        if tag == "h1":
            self._in_h1 = True
        if tag in _BLOCK:
            self._emit("\n")
        if tag in ("h1", "h2", "h3", "h4", "h5", "h6"):
            self._emit("#" * min(int(tag[1]), 3) + " ")
        elif tag == "li":
            self._emit("- ")
            self._items.append({"at": len(self._parts) - 1, "chars": 0, "links": 0})

    def handle_endtag(self, tag: str) -> None:
        if tag in _VOID:
            return
        # Close back to the matching tag; pages in the wild are not always well formed.
        for index in range(len(self._stack) - 1, -1, -1):
            if self._stack[index][0] == tag:
                for _, hides in self._stack[index:]:
                    if hides:
                        self._hidden -= 1
                closed = [name for name, _ in self._stack[index:]]
                del self._stack[index:]
                for name in reversed(closed):
                    if name == "li":
                        self._finish_item()
                    elif name == "a":
                        self._link_depth = max(0, self._link_depth - 1)
                self._main_depth = max(0, self._main_depth - sum(1 for n in closed if n in ("article", "main")))
                break
        else:
            return
        if tag == "title":
            self._in_title = False
        if tag == "h1":
            self._in_h1 = False
        if tag in _BLOCK and not self._hidden:
            self._emit("\n")

    def _finish_item(self) -> None:
        """A short list item that is nearly all link ("Español", "Category: Arrays") is navigation. It is
        marked, and a run of them is dropped when the lines are cleaned."""
        if not self._items:
            return
        item = self._items.pop()
        if item["at"] is not None and 0 < item["chars"] <= 80 and item["links"] >= 0.9 * item["chars"]:
            self._parts[item["at"]][0] = LINKY + "- "

    def handle_data(self, data: str) -> None:
        if self._in_title:
            self.title += data
            return
        if self._hidden:
            return
        if self._in_h1 and not self.first_h1:
            self.first_h1 = _tidy(data)
        if self._items and data.strip():
            self._items[-1]["chars"] += len(data.strip())
            if self._link_depth:
                self._items[-1]["links"] += len(data.strip())
        self._emit(data)


def _drop_link_runs(lines: list[str]) -> list[str]:
    """Removes runs of LINKY_RUN or more navigation-like list items; shorter runs are normal lists of links."""
    kept: list[str] = []
    run: list[str] = []

    def flush() -> None:
        if len(run) < LINKY_RUN:
            kept.extend(line[len(LINKY) :] for line in run)
        run.clear()

    for line in lines:
        if line.startswith(LINKY):
            run.append(line)
        else:
            flush()
            kept.append(line)
    flush()
    return kept


def _clean_lines(chunks: list[str]) -> str:
    text = ""
    previous = ""
    cleaned = (re.sub(r"\s+", " ", raw).strip() for raw in "".join(chunks).split("\n"))
    for line in _drop_link_runs([line for line in cleaned if line]):
        if line in ("-", "#", "##", "###"):
            continue
        # Blocks are separated by a blank line, the items of a list only by a line break.
        if text:
            text += ("\n" if previous.startswith("- ") and line.startswith("- ") else "\n\n") + line
        else:
            text = line
        previous = line
    return text


def html_to_text(html: str) -> tuple[str, str]:
    """Returns (title, readable text) for a page. Menus, footers, forms, scripts and similar page furniture
    are left out; the article body is used when the page has one."""
    for filter_noise in (True, False):
        reader = _Reader(filter_noise)
        reader.feed(html)
        reader.close()
        whole = _clean_lines(reader.body)
        article = _clean_lines(reader.main)
        # An <article> or <main> that holds most of the words is the content; a tiny one is just a widget.
        text = article if len(article) >= 600 and len(article) >= 0.4 * len(whole) else whole
        # If the class-name filter left almost nothing it was wrong about this page: read it without.
        if len(text) >= 200:
            break
    title = _tidy(reader.og_title or reader.title or reader.first_h1)
    return title, text


def decode_body(body: bytes, charset: Optional[str]) -> str:
    """Page bytes as text: the charset the server declared, else the one the page declares, else UTF-8."""
    candidates = []
    if charset:
        candidates.append(charset)
    meta = re.search(rb"<meta[^>]+charset=[\"']?([\w.:-]+)", body[:4096], re.I)
    if meta:
        candidates.append(meta.group(1).decode("ascii", "ignore"))
    candidates.append("utf-8")
    for name in candidates:
        try:
            return body.decode(name)
        except (LookupError, UnicodeDecodeError):
            continue
    return body.decode("utf-8", "replace")


def title_from_url(url: str) -> str:
    """A name for a page that has no title: its host."""
    return (urlsplit(url).hostname or "web page").removeprefix("www.")
