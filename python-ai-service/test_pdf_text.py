import pdf_text

# Lines as pypdf returned them for a book whose code samples print every letter twice.
DOUBLED = [
    "v v ooi iddvveec ct to or r_ _i in ni it t( (VVeec ct to or r&&vv,,i i nnttss) )",
    "v v ..e el le emm= =nneewwddo ou ubbl lee[ [s s] ];;/ // /allocate an array of s doubles",
    "That is, v v’se el le em mmember gets a pointer produced by the n ne e ww operator and v v’ss si iz z ee member",
]

NORMAL = [
    "Dynamic arrays are allocated with the new operator, which reserves memory on the free store.",
    "The committee met in Mississippi to discuss the bookkeeping of the cooperative's accounts.",
    "Tom Hawkins reported that the balloon would be successful, all the same.",
    "1 000 000 0 0 0 0 0 0 0 0 0 0 0 0 0 0",  # numbers are not letters
    "-----------------------------------------------",
]


def test_lines_with_every_letter_printed_twice_are_recognised():
    assert all(pdf_text.line_is_doubled(line) for line in DOUBLED[:2])


def test_a_line_that_is_only_partly_doubled_is_left_to_the_page_as_a_whole():
    # Half of it is ordinary text, so alone it is not enough (the page it is on has other lines that are).
    assert not pdf_text.line_is_doubled(DOUBLED[2])


def test_ordinary_lines_are_not_taken_for_doubled_ones():
    assert not any(pdf_text.line_is_doubled(line) for line in NORMAL)


def test_a_short_line_says_too_little_to_judge():
    assert not pdf_text.line_is_doubled("ee ll")


def test_a_page_needs_more_than_one_doubled_line():
    assert not pdf_text.page_is_doubled("\n".join(NORMAL + DOUBLED[:1]))
    assert pdf_text.page_is_doubled("\n".join(NORMAL + DOUBLED[:2]))


class FakePage:
    def __init__(self, text):
        self.text = text

    def extract_text(self):
        return self.text


def fake_reader(pages):
    return lambda path: type("Reader", (), {"pages": [FakePage(t) for t in pages]})()


def test_only_the_doubled_page_is_read_again(monkeypatch):
    first, last = "\n".join(NORMAL), "A last page."
    monkeypatch.setattr(pdf_text, "PdfReader", fake_reader([first, "\n".join(DOUBLED), last]))
    asked = []
    monkeypatch.setattr(pdf_text, "_pdfium_page_text", lambda path, index: asked.append(index) or "read again")
    assert pdf_text.page_texts("x.pdf") == [first, "read again", last]
    assert asked == [1]


def test_a_page_that_cannot_be_read_again_is_kept_as_it_was(monkeypatch):
    doubled = "\n".join(DOUBLED)
    monkeypatch.setattr(pdf_text, "PdfReader", fake_reader([doubled]))
    monkeypatch.setattr(pdf_text, "_pdfium_page_text", lambda path, index: None)
    assert pdf_text.page_texts("x.pdf") == [doubled]


def test_a_page_pdfium_cannot_open_is_kept_as_it_was(tmp_path):
    broken = tmp_path / "broken.pdf"
    broken.write_bytes(b"not a pdf")
    assert pdf_text._pdfium_page_text(str(broken), 0) is None
