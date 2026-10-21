"""Reading the text of a PDF, including pages whose letters are printed twice.

Some PDFs print part of a page (the code samples of a book, bold words) by drawing every letter twice, a hair apart. The
usual reader (pypdf) then returns the two copies mixed together: "v.elem = new double[s];" comes back as
"v v ..e el le emm= =nneewwddo ou ubbl lee[ [s s] ];;". Summaries, answers and quoted passages built on that text are
garbled too. PDFium (the engine of Chrome) reads the same page correctly, so a page that shows the doubling is read
with it instead. All other pages are left exactly as pypdf gives them.
"""

import logging
import re
from typing import Optional

from pypdf import PdfReader

logger = logging.getLogger("ai-summarizer")

# A line of normal text has about one letter pair in twenty that is the same letter twice ("ll", "ee"); a doubled
# line has about one in two or three. Short lines say too little to judge.
MIN_LETTERS = 12
DOUBLED_SHARE = 0.2
# A page is read again when this many of its lines look doubled (one line alone can be a word such as "Mississippi").
DOUBLED_LINES_NEEDED = 2

_LETTERS = re.compile(r"[^\W\d_]")


def line_is_doubled(line: str) -> bool:
    letters = "".join(_LETTERS.findall(line)).lower()
    if len(letters) < MIN_LETTERS:
        return False
    same = sum(1 for a, b in zip(letters, letters[1:], strict=False) if a == b)
    return same / (len(letters) - 1) >= DOUBLED_SHARE


def page_is_doubled(text: str) -> bool:
    return sum(1 for line in text.splitlines() if line_is_doubled(line)) >= DOUBLED_LINES_NEEDED


def _pdfium_page_text(path: str, index: int) -> Optional[str]:
    try:
        import pypdfium2 as pdfium

        document = pdfium.PdfDocument(path)
        try:
            text = document[index].get_textpage().get_text_range()
        finally:
            document.close()
    except Exception:  # the page is simply kept as the first reader gave it
        logger.warning("could not re-read page %d with PDFium", index + 1, exc_info=True)
        return None
    return text.replace("\r\n", "\n").replace("\r", "\n").strip() or None


def page_texts(path: str) -> list[str]:
    """The text of each page, a page that was printed twice read again with PDFium."""
    texts = []
    read_again = []
    for index, page in enumerate(PdfReader(path).pages):
        text = page.extract_text() or ""
        if page_is_doubled(text):
            better = _pdfium_page_text(path, index)
            if better:
                read_again.append(index + 1)
                text = better
        texts.append(text)
    if read_again:
        logger.info("%d pages have doubled letters and were read with PDFium: %s", len(read_again), read_again)
    return texts
