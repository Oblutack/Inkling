import io
import random
import subprocess
import zlib

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont

import main
import ocr
import photos
from retrieval import PAGE_BREAK

LEASE = [
    "RESIDENTIAL LEASE AGREEMENT",
    "",
    "The tenant pays 950 euros per month,",
    "due on the fifth day of each month.",
    "",
    "Pets are allowed only with written",
    "permission of the landlord.",
    "Deposit: 1,900 euros.",
]
FACTS = ("950", "euros", "Pets", "1,900")


def page_of(lines, size=(1240, 1754), ink=30, paper=235):
    image = Image.new("L", size, paper)
    draw = ImageDraw.Draw(image)
    font = ImageFont.load_default(size=34)
    for i, line in enumerate(lines):
        draw.text((90, 140 + i * 56), line, fill=ink, font=font)
    return image


def photographed(page, angle=0.0, seed=3):
    """What a phone makes of a page: one side in shadow, a little blur, noise and a slight turn."""
    random.seed(seed)
    shade = Image.linear_gradient("L").resize(page.size).rotate(30)
    image = Image.composite(page, ImageEnhance.Brightness(page).enhance(0.55), shade)
    image = image.rotate(angle, expand=True, fillcolor=120).filter(ImageFilter.GaussianBlur(1.0))
    pixels = image.load()
    for _ in range(40000):
        x, y = random.randrange(image.width), random.randrange(image.height)
        pixels[x, y] = max(0, min(255, pixels[x, y] + random.randint(-40, 40)))
    return image


def encoded(image, fmt="JPEG", **options):
    buffer = io.BytesIO()
    image.save(buffer, format=fmt, **options)
    return buffer.getvalue()


# --- which files are photos ---


def test_photos_are_known_by_their_extension():
    for name in ("page.jpg", "PAGE.JPEG", "scan.Png", "web.webp", "my photo.final.jpg", "IMG_0042.HEIC", "shot.heif"):
        assert photos.is_image(name), name
    for name in ("page.pdf", "notes.docx", "a.gif", "a.bmp", "jpg", "photo.jpg.pdf", "meeting.mp3"):
        assert not photos.is_image(name), name


# --- preparing a picture ---


def test_a_picture_is_turned_the_way_the_file_says():
    sideways = Image.new("RGB", (400, 200), "white")  # the phone saw a portrait page as landscape
    exif = Image.Exif()
    exif[0x0112] = 6  # rotate 90 clockwise to display
    out = photos.prepare(encoded(sideways, exif=exif), "p.jpg")
    assert out.height > out.width


def test_an_iphone_picture_in_heic_is_opened_like_any_other():
    page = photographed(page_of(LEASE))
    heic = encoded(page.convert("RGB"), "HEIF", quality=85)
    assert heic[4:8] == b"ftyp"  # really a HEIF container, not a renamed JPEG
    prepared = photos.prepare(heic, "IMG_0042.HEIC")
    assert prepared.width > 0 and prepared.height > 0
    # the name does not matter, what the file is does
    assert photos.prepare(heic, "renamed.jpg").size == prepared.size


def test_a_heic_picture_that_is_cut_short_is_a_plain_error():
    heic = encoded(Image.new("RGB", (300, 300), "white"), "HEIF")
    with pytest.raises(ocr.OcrError) as caught:
        photos.prepare(heic[: len(heic) // 2], "IMG_0042.HEIC")
    assert caught.value.status == 422 and "IMG_0042.HEIC" in caught.value.message


@pytest.mark.parametrize("fmt", ["TIFF", "GIF", "BMP", "PPM", "EPS", "PDF"])
def test_only_the_accepted_kinds_of_picture_are_opened_whatever_the_file_is_called(fmt, monkeypatch):
    # Pillow's other readers are not even tried: nothing of a TIFF, GIF, EPS or PPM file is parsed
    other = encoded(Image.new("RGB", (60, 60), "white"), fmt)
    opened = []
    real_open = Image.open
    monkeypatch.setattr(
        Image, "open", lambda fp, mode="r", formats=None: opened.append(formats) or real_open(fp, mode, formats)
    )
    with pytest.raises(ocr.OcrError) as caught:
        photos.prepare(other, "holiday.jpg")
    assert caught.value.status == 422 and "not a JPG, PNG, WebP or HEIC picture" in caught.value.message
    assert opened == [list(photos.IMAGE_FORMATS)]


def test_a_see_through_png_is_read_on_white_paper():
    image = Image.new("RGBA", (800, 800), (0, 0, 0, 0))
    ImageDraw.Draw(image).rectangle((100, 100, 200, 200), fill=(0, 0, 0, 255))
    out = photos.prepare(encoded(image, "PNG"), "p.png")
    assert out.mode == "L" and out.getpixel((5, 5)) == 255 and out.getpixel((150 * 2, 150 * 2)) < 20


def test_big_pictures_are_made_smaller_and_small_ones_bigger():
    big = photos.prepare(encoded(Image.new("L", (6000, 4000), 255), "PNG"), "big.png")
    assert max(big.size) == ocr.MAX_SIDE_PIXELS
    small = photos.prepare(encoded(Image.new("L", (600, 400), 255), "PNG"), "small.png")
    assert max(small.size) == 1600
    tiny = photos.prepare(encoded(Image.new("L", (100, 50), 255), "PNG"), "tiny.png")
    assert tiny.width == 300  # never more than three times bigger


def test_a_picture_with_too_many_pixels_is_refused_before_it_is_opened_up(monkeypatch):
    monkeypatch.setattr(photos, "MAX_PIXELS", 10_000)
    with pytest.raises(ocr.OcrError) as caught:
        photos.prepare(encoded(Image.new("L", (200, 200), 255), "PNG"), "huge.png")
    assert caught.value.status == 413 and "huge.png" in caught.value.message


def png_with_part(kind: bytes, data: bytes = b"") -> bytes:
    """A real PNG with one more part (a chunk) put in right after its header, as a crafted file would have."""
    original = encoded(Image.new("L", (60, 40), 255), "PNG")
    after_header = len(photos.PNG_SIGNATURE) + 12 + 13  # the signature, then IHDR: length, name, 13 bytes, check value
    part = len(data).to_bytes(4, "big") + kind + data + zlib.crc32(kind + data).to_bytes(4, "big")
    return original[:after_header] + part + original[after_header:]


def test_an_ordinary_png_passes_the_check():
    photos.check_png(encoded(Image.new("L", (60, 40), 255), "PNG"), "page.png")
    assert photos.prepare(encoded(Image.new("L", (60, 40), 255), "PNG"), "page.png").mode == "L"


def test_a_png_that_says_it_is_animated_is_refused_before_it_is_opened():
    crafted = png_with_part(b"acTL", (2).to_bytes(4, "big") + (0).to_bytes(4, "big"))
    with pytest.raises(ocr.OcrError) as caught:
        photos.prepare(crafted, "moving.png")
    assert caught.value.status == 422 and "moving.png" in caught.value.message


def test_a_png_with_a_huge_metadata_block_is_refused_but_a_small_one_is_fine():
    with pytest.raises(ocr.OcrError):
        photos.check_png(png_with_part(b"eXIf", b"Exif\x00\x00" * 20_000), "slow.png")
    photos.check_png(png_with_part(b"eXIf", b"Exif\x00\x00MM\x00*" + b"\x00" * 200), "photo.png")


def test_a_png_that_claims_an_enormous_size_is_refused_without_being_opened():
    real = bytearray(encoded(Image.new("L", (60, 40), 255), "PNG"))
    start = len(photos.PNG_SIGNATURE) + 8  # the width and the height are the first 8 bytes of the header
    real[start : start + 8] = (22_000).to_bytes(4, "big") + (22_000).to_bytes(4, "big")
    with pytest.raises(ocr.OcrError) as caught:
        photos.prepare(bytes(real), "claims.png")
    assert caught.value.status == 413 and "22000x22000" in caught.value.message


def test_the_check_leaves_other_kinds_of_picture_and_cut_short_files_to_the_normal_handling():
    photos.check_png(encoded(Image.new("L", (50, 50), 255), "JPEG"), "photo.jpg")
    photos.check_png(photos.PNG_SIGNATURE + b"\x00\x00", "cut.png")  # nothing to read: Pillow gives the error


def test_what_the_file_really_is_decides_not_its_name():
    for fmt in ("GIF", "BMP", "TIFF"):
        with pytest.raises(ocr.OcrError) as caught:
            photos.prepare(encoded(Image.new("L", (50, 50), 255), fmt), "pretend.jpg")
        assert caught.value.status == 422 and "JPG, PNG, WebP or HEIC" in caught.value.message, fmt


def test_a_broken_picture_is_a_plain_error_that_tells_nothing_of_the_server():
    for junk in (b"", b"not a picture at all", encoded(Image.new("L", (50, 50), 255), "PNG")[:40]):
        with pytest.raises(ocr.OcrError) as caught:
            photos.prepare(junk, "broken.png")
        assert caught.value.status == 422 and "broken.png" in caught.value.message
        assert "PIL" not in caught.value.message and "Traceback" not in caught.value.message


# --- evening out the light ---


def test_a_shadow_over_the_page_is_removed():
    image = photographed(page_of(LEASE)).convert("L")
    flat = np.asarray(photos.even_out(image), dtype=float)
    # paper on the dark side and on the bright side end up equally white
    left, right = flat[300:1500, 15:65].mean(), flat[300:1500, -65:-15].mean()
    assert left > 215 and right > 215 and abs(left - right) < 25
    assert flat[0:10, :].mean() > 200
    before = np.asarray(image, dtype=float)
    assert abs(before[300:1500, 15:65].mean() - before[300:1500, -65:-15].mean()) > 25, (
        "the test photo really has a shadow"
    )


def test_light_text_on_a_dark_background_is_turned_into_dark_on_light():
    dark = page_of(LEASE, ink=235, paper=25)
    out = np.asarray(photos.even_out(dark))
    assert out.mean() > 200


# --- a page held at a slant ---


def evened(angle, seed=1):
    """What the reader sees of a photo of the lease page held at `angle` degrees, after the light is evened out."""
    shot = photographed(page_of(LEASE), angle=angle, seed=seed)
    return photos.even_out(photos.prepare(encoded(shot, quality=80), "lease.jpg"))


@pytest.mark.parametrize("tilt", [-15, -12, -9, -6, -3, -2, 2, 3, 6, 9, 12, 15])
def test_the_slant_of_a_page_is_found_and_corrected(tilt):
    # the shading, the noise and the dark corners around the page are part of the test picture, as on a desk
    for seed in (1, 2):
        found = photos.skew_angle(evened(tilt, seed))
        assert found == pytest.approx(-tilt, abs=0.6), (tilt, seed, found)


@pytest.mark.parametrize("tilt", [-1, 0, 1])
def test_a_page_that_is_nearly_straight_is_left_alone(tilt):
    picture = evened(tilt)
    assert photos.skew_angle(picture) == 0.0
    assert photos.straighten(picture) is picture  # not even copied: every turn blurs a little


def test_a_page_with_too_little_on_it_to_tell_is_left_alone():
    assert photos.skew_angle(Image.new("L", (1240, 1754), 235)) == 0.0
    one_word = page_of(["OK"]).rotate(9, expand=True, fillcolor=235)
    assert photos.skew_angle(one_word) == 0.0
    noise = Image.fromarray(np.random.default_rng(1).integers(0, 256, (900, 700), dtype=np.uint8))
    assert photos.skew_angle(noise) == 0.0


def test_a_picture_that_is_mostly_dark_is_not_taken_for_lines_of_text():
    assert photos.skew_angle(Image.new("L", (1000, 1400), 20)) == 0.0


def test_a_page_beyond_the_limit_is_corrected_as_far_as_the_limit():
    found = photos.skew_angle(page_of(LEASE).rotate(25, expand=True, fillcolor=235))
    assert found == -photos.MAX_SKEW_DEGREES or abs(found) <= photos.MAX_SKEW_DEGREES + 1


def test_a_straightened_page_has_level_lines():
    for tilt in (-11, 7):
        crooked = evened(tilt)
        level = photos.straighten(crooked)
        assert level.size != crooked.size  # it was turned (and made bigger, so no corner is cut off)
        assert abs(photos.skew_angle(level)) < photos.MIN_SKEW_DEGREES, tilt
        assert np.asarray(level)[0, 0] > 200  # the corners that appeared are paper-coloured


def test_a_dark_edge_of_the_table_does_not_hide_the_slant():
    # a wide dark band beside the page, as in a photo taken on a dark desk
    page = page_of(LEASE).rotate(8, expand=True, fillcolor=235)
    page.paste(0, (0, 0, 120, page.height))
    assert photos.skew_angle(page) == pytest.approx(-8, abs=0.6)


def test_finding_the_slant_is_quick():
    import time

    picture = evened(7)
    started = time.monotonic()
    photos.skew_angle(picture)
    assert time.monotonic() - started < 3.0


# --- orientation ---


def fake_tesseract(monkeypatch, stdout=b"", stderr=b"", code=0):
    calls = []

    def run(png, languages, timeout, *options, must_succeed=True):
        calls.append((languages, options, must_succeed))
        return subprocess.CompletedProcess(["tesseract"], code, stdout, stderr)

    monkeypatch.setattr(ocr, "run_tesseract", run)
    return calls


def test_the_turn_tesseract_asks_for_is_read_from_its_report(monkeypatch):
    calls = fake_tesseract(
        monkeypatch, stdout=b"Page number: 0\nOrientation in degrees: 90\nRotate: 270\nOrientation confidence: 2.40\n"
    )
    assert photos.turn_needed(b"png", 10) == 270
    assert calls == [("osd", ("--psm", "0"), False)]


def test_a_guess_it_is_hardly_sure_of_is_ignored(monkeypatch):
    fake_tesseract(monkeypatch, stdout=b"Rotate: 90\nOrientation confidence: 0.20\n")
    assert photos.turn_needed(b"png", 10) == 0


def test_no_report_means_no_turn(monkeypatch):
    fake_tesseract(monkeypatch, stderr=b"Too few characters. Skipping this page\n", code=1)
    assert photos.turn_needed(b"png", 10) == 0


def test_a_missing_tesseract_is_still_reported(monkeypatch):
    def run(*args, **kwargs):
        raise ocr.OcrError(503, "Reading scanned pages is not available on this server.")

    monkeypatch.setattr(ocr, "run_tesseract", run)
    with pytest.raises(ocr.OcrError) as caught:
        photos.turn_needed(b"png", 10)
    assert caught.value.status == 503


# --- the words Tesseract found ---

HEADER = "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n"


def word(block, par, line, n, conf, text):
    return f"5\t1\t{block}\t{par}\t{line}\t{n}\t0\t0\t10\t10\t{conf}\t{text}\n"


def test_the_words_are_put_back_into_lines_and_paragraphs_with_how_sure_they_were(monkeypatch):
    tsv = HEADER + "1\t1\t0\t0\t0\t0\t0\t0\t100\t100\t-1\t\n"
    tsv += (
        word(1, 1, 1, 1, 96.5, "The")
        + word(1, 1, 1, 2, 91, "tenant")
        + word(1, 1, 2, 1, 88, "pays")
        + word(1, 1, 2, 2, 20, "950")
    )
    tsv += word(2, 1, 1, 1, 95, "Pets") + word(2, 1, 1, 2, -1, "  ")
    fake_tesseract(monkeypatch, stdout=tsv.encode())
    text, sure = photos.read_words(b"png", "eng", 10)
    assert text == "The tenant\npays 950\n\nPets"
    assert sure == len("The") + len("tenant") + len("pays") + len("Pets"), "only words it was sure of count"


# --- two ways of reading a page ---


@pytest.fixture
def reading(monkeypatch):
    log = {"reads": 0, "turn": 0, "sizes": []}
    monkeypatch.setattr(photos, "prepare", lambda content, name: Image.new("L", (300, 200), 255))
    monkeypatch.setattr(photos, "even_out", lambda image: image)
    monkeypatch.setattr(photos, "turn_needed", lambda png, timeout: log["turn"])

    def read(png, languages, timeout):
        log["reads"] += 1
        log["sizes"].append(Image.open(io.BytesIO(png)).size)
        return log["answers"].pop(0)

    monkeypatch.setattr(photos, "read_words", read)
    return log


def test_an_upright_page_is_read_once(reading):
    reading["answers"] = [("The page text", 40)]
    assert photos.read_photo(b"x", "p.jpg", "eng", 30) == "The page text"
    assert reading["reads"] == 1


def test_a_page_the_detector_thinks_is_sideways_is_read_both_ways_and_the_surer_reading_wins(reading):
    reading["turn"] = 90
    reading["answers"] = [("garbage", 3), ("The real text", 40)]
    assert photos.read_photo(b"x", "p.jpg", "eng", 30) == "The real text"
    assert reading["sizes"] == [(300, 200), (200, 300)], "the second reading is of the turned page"


def test_a_wrong_guess_from_the_detector_does_no_harm(reading):
    reading["turn"] = 180
    reading["answers"] = [("The real text", 40), ("elaas", 2)]
    assert photos.read_photo(b"x", "p.jpg", "eng", 30) == "The real text"


def test_on_a_tie_the_photo_as_it_came_wins(reading):
    reading["turn"] = 90
    reading["answers"] = [("as it came", 10), ("turned", 10)]
    assert photos.read_photo(b"x", "p.jpg", "eng", 30) == "as it came"


def test_a_page_that_gives_next_to_nothing_and_has_no_detected_turn_is_also_tried_on_its_side(reading):
    # as when a page is on its side and slanted: the detector cannot tell, but one of the sideways readings is clear
    reading["answers"] = [("", 0), ("garbage", 4), ("The real text of a sideways page", 60)]
    assert photos.read_photo(b"x", "p.jpg", "eng", 30) == "The real text of a sideways page"
    assert reading["sizes"] == [(300, 200), (200, 300), (200, 300)]


def test_a_blank_page_is_looked_at_three_ways_and_stays_empty(reading):
    reading["answers"] = [("", 0), ("", 0), ("", 0)]
    assert photos.read_photo(b"x", "p.jpg", "eng", 30) == ""
    assert reading["reads"] == 3


def test_a_page_with_enough_text_is_not_tried_on_its_side(reading):
    reading["answers"] = [("Only a short line.", photos.LOW_YIELD)]
    assert photos.read_photo(b"x", "p.jpg", "eng", 30) == "Only a short line."
    assert reading["reads"] == 1


def test_a_detected_turn_is_trusted_and_nothing_else_is_tried(reading):
    reading["turn"] = 90
    reading["answers"] = [("", 0), ("", 0)]
    photos.read_photo(b"x", "p.jpg", "eng", 30)
    assert reading["reads"] == 2


def test_reading_a_photo_stops_when_the_time_is_up(reading):
    with pytest.raises(ocr.OcrError) as caught:
        photos.read_photo(b"x", "p.jpg", "eng", 0.0)
    assert caught.value.status == 504


def test_photos_are_read_side_by_side_in_order(monkeypatch):
    monkeypatch.setattr(photos, "read_photo", lambda content, name, languages, timeout: f"{name}:{content.decode()}")
    out = photos.read_photos([("a.jpg", b"1"), ("b.jpg", b"2"), ("c.jpg", b"3")])
    assert out == ["a.jpg:1", "b.jpg:2", "c.jpg:3"]


def test_too_many_photos_are_refused_before_any_work(monkeypatch):
    monkeypatch.setattr(ocr, "MAX_PAGES", 2)
    monkeypatch.setattr(photos, "read_photo", lambda *a: pytest.fail("no photo should be read"))
    with pytest.raises(ocr.OcrError) as caught:
        photos.read_photos([("a.jpg", b""), ("b.jpg", b""), ("c.jpg", b"")])
    assert caught.value.status == 413


# --- through the service ---


class Writer:
    async def ainvoke(self, prompt):
        self.prompt = prompt
        return type("Msg", (), {"content": "A summary."})()


@pytest.fixture
def client(monkeypatch):
    writer = Writer()
    seen = []
    monkeypatch.setattr(main, "get_llm", lambda: writer)
    monkeypatch.setattr(
        photos, "read_photos", lambda items: seen.append([n for n, _ in items]) or [f"Text of {n}" for n, _ in items]
    )
    c = TestClient(main.app, raise_server_exceptions=False)
    c.writer, c.seen = writer, seen
    return c


def upload(name, body=b"x", kind="image/jpeg"):
    return (name, body, kind)


def test_one_photo_is_summarized_when_allowed(client):
    r = client.post("/summarize", files={"file": upload("page.jpg")}, data={"ocr": "true"})
    assert r.status_code == 200 and r.json()["text"] == "Text of page.jpg"
    assert "Text of page.jpg" in client.writer.prompt


def test_a_photo_without_permission_says_to_sign_in(client):
    r = client.post("/summarize", files={"file": upload("page.jpg")})
    assert r.status_code == 422 and "Sign in" in r.json()["detail"]
    assert client.seen == []


def test_several_photos_are_pages_of_one_document(client):
    files = [("files", upload(n)) for n in ("p1.jpg", "p2.jpg", "p3.png")]
    r = client.post("/summarize-multiple", files=files, data={"ocr": "true"})
    assert r.status_code == 200
    assert client.seen == [["p1.jpg", "p2.jpg", "p3.png"]], "read together, in order"
    assert r.json()["filename"] == "p1.jpg (+2 more photos)"
    text = r.json()["text"]
    assert text.split(PAGE_BREAK) == ["Text of p1.jpg", "Text of p2.jpg", "Text of p3.png"]
    assert "=== " not in text, "one document, so no heading per document"
    assert "Text of p2.jpg" in client.writer.prompt


def test_photos_keep_their_place_among_other_files(client, monkeypatch):
    monkeypatch.setattr(main, "extract_upload_text", lambda name, content, allow_ocr=False: f"Words of {name}")
    files = [
        ("files", upload("a.pdf", kind="application/pdf")),
        ("files", upload("p1.jpg")),
        ("files", upload("b.pdf")),
        ("files", upload("p2.jpg")),
    ]
    r = client.post("/summarize-multiple", files=files, data={"ocr": "true"})
    assert r.status_code == 200
    text = r.json()["text"]
    assert text.index("=== a.pdf ===") < text.index("=== p1.jpg (+1 more photos) ===") < text.index("=== b.pdf ===")
    assert client.seen == [["p1.jpg", "p2.jpg"]]


def test_a_photo_problem_reaches_the_caller_as_a_plain_error(client, monkeypatch):
    def fail(items):
        raise ocr.OcrError(422, "Could not read page.jpg. It may be corrupted or not a real picture.")

    monkeypatch.setattr(photos, "read_photos", fail)
    r = client.post("/summarize", files={"file": upload("page.jpg")}, data={"ocr": "true"})
    assert r.status_code == 422 and "page.jpg" in r.json()["detail"]


def test_a_photo_with_no_text_says_so(client, monkeypatch):
    monkeypatch.setattr(photos, "read_photos", lambda items: [""])
    r = client.post("/summarize", files={"file": upload("blank.jpg")}, data={"ocr": "true"})
    assert r.status_code == 422 and "No readable text" in r.json()["detail"]


def test_a_photo_that_is_too_large_is_refused(client, monkeypatch):
    monkeypatch.setattr(main, "MAX_PDF_BYTES", 10)
    r = client.post("/summarize", files={"file": upload("big.jpg", b"x" * 50)}, data={"ocr": "true"})
    assert r.status_code == 413 and client.seen == []


# --- the real thing (needs the tesseract program: the Docker image and CI have it) ---

needs_tesseract = pytest.mark.skipif(not ocr.available(), reason="the tesseract program is not installed here")


def facts_in(text):
    return all(fact in text for fact in FACTS)


@needs_tesseract
def test_a_photo_of_a_page_taken_in_poor_light_is_read():
    text = photos.read_photos([("lease.jpg", encoded(photographed(page_of(LEASE), angle=1.5), quality=80))], "eng")[0]
    assert facts_in(text), text
    assert text.splitlines()[0].startswith("RESIDENTIAL"), "the first line stays first"


@needs_tesseract
@pytest.mark.parametrize("turn", [90, 180, 270])
def test_a_page_photographed_sideways_or_upside_down_is_read(turn):
    sideways = photographed(page_of(LEASE).rotate(turn, expand=True), angle=0.5)
    text = photos.read_photos([("lease.jpg", encoded(sideways, quality=80))], "eng")[0]
    assert facts_in(text), (turn, text)


@needs_tesseract
@pytest.mark.parametrize("tilt", [-14, -10, -6, 6, 10, 14])
def test_a_page_held_at_a_slant_is_read(tilt):
    # without the correction Tesseract reads nothing at all of this page from about eight degrees on
    slanted = photographed(page_of(LEASE), angle=tilt, seed=2)
    text = photos.read_photos([("lease.jpg", encoded(slanted, quality=80))], "eng")[0]
    assert facts_in(text), (tilt, text)


@needs_tesseract
def test_a_page_that_is_sideways_and_slanted_is_read():
    both = photographed(page_of(LEASE), angle=9, seed=2).rotate(90, expand=True)
    text = photos.read_photos([("lease.jpg", encoded(both, quality=80))], "eng")[0]
    assert facts_in(text), text


@needs_tesseract
def test_a_straight_page_is_read_exactly_as_before():
    straight = encoded(photographed(page_of(LEASE), angle=0, seed=2), quality=80)
    assert photos.skew_angle(photos.even_out(photos.prepare(straight, "x.jpg"))) == 0.0
    assert facts_in(photos.read_photos([("lease.jpg", straight)], "eng")[0])


@needs_tesseract
def test_a_phone_photo_that_is_stored_sideways_with_a_note_is_read():
    stored_sideways = photographed(page_of(LEASE), angle=0.5).rotate(90, expand=True)  # as the sensor saw it
    exif = Image.Exif()
    exif[0x0112] = 6  # "turn it 90 degrees clockwise to display"
    text = photos.read_photos([("IMG_0042.jpg", encoded(stored_sideways, quality=80, exif=exif))], "eng")[0]
    assert facts_in(text), text


@needs_tesseract
def test_a_screenshot_with_light_text_on_dark_is_read():
    dark = page_of(LEASE, ink=235, paper=25)
    text = photos.read_photos([("dark.png", encoded(dark, "PNG"))], "eng")[0]
    assert facts_in(text), text


@needs_tesseract
def test_a_clean_screenshot_is_read_as_well_as_before():
    text = photos.read_photos([("shot.png", encoded(page_of(LEASE, paper=255), "PNG"))], "eng")[0]
    assert facts_in(text), text


@needs_tesseract
def test_photos_of_two_pages_come_back_in_order_and_an_empty_page_stays_empty():
    pages = [
        photographed(page_of(["First page: the rent is 950 euros."])),
        Image.new("L", (900, 1200), 240),
        photographed(page_of(["Third page: pets are allowed."]), 1.0),
    ]
    first, second, third = photos.read_photos(
        [(f"{i}.jpg", encoded(p, quality=80)) for i, p in enumerate(pages)], "eng"
    )
    assert "950" in first and "First" in first
    assert second == ""
    assert "Third" in third and "pets" in third.lower()


@needs_tesseract
def test_two_photos_through_the_service_become_one_summarized_document(monkeypatch):
    writer = Writer()
    monkeypatch.setattr(main, "get_llm", lambda: writer)
    client = TestClient(main.app, raise_server_exceptions=False)
    files = [
        ("files", ("p1.jpg", encoded(photographed(page_of(LEASE)), quality=80), "image/jpeg")),
        ("files", ("p2.png", encoded(page_of(["The cat sat on the mat all day."], paper=255), "PNG"), "image/png")),
    ]
    r = client.post("/summarize-multiple", files=files, data={"ocr": "true"})
    assert r.status_code == 200, r.text
    text = r.json()["text"]
    assert "950" in text and "cat sat" in text and PAGE_BREAK in text
