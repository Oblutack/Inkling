import pytest
from fastapi.testclient import TestClient

import bilingual
import main
from bilingual import Block, assemble, bilingual_prompt, parse_bilingual, split_blocks

SUMMARY = """## Rent and deposit
The tenant pays 950 euros per month.
- The deposit is 1,900 euros.
- It is returned within 30 days.

1. Notice is 60 days.
---
**Pets** are not allowed."""


def test_a_summary_is_cut_into_lines_without_their_marks():
    blocks = split_blocks(SUMMARY)
    assert [(b.kind, b.text) for b in blocks] == [
        ("heading", "Rent and deposit"),
        ("paragraph", "The tenant pays 950 euros per month."),
        ("bullet", "The deposit is 1,900 euros."),
        ("bullet", "It is returned within 30 days."),
        ("numbered", "Notice is 60 days."),
        ("paragraph", "Pets are not allowed."),
    ]


def test_an_empty_summary_has_no_lines_and_a_long_one_is_limited():
    assert split_blocks("\n\n---\n") == []
    assert len(split_blocks("\n".join(f"Line {i}." for i in range(200)))) == bilingual.MAX_BLOCKS


def test_the_prompt_numbers_the_lines_and_names_the_language():
    prompt = bilingual_prompt("Lease", split_blocks(SUMMARY), "German")
    assert '"Lease"' in prompt and "into German" in prompt
    assert "1. Rent and deposit" in prompt and "6. Pets are not allowed." in prompt
    assert "VOCAB |" in prompt and "Keep every number" in prompt


def test_the_reply_is_read_whatever_the_decoration():
    reply = (
        "1 | Miete und Kaution\n"
        "**2.** | Der Mieter zahlt 950 Euro pro Monat.\n"
        "9 | a line that does not exist\n"
        "2 | a repeat\n"
        "VOCAB | deposit | Kaution\n"
        "- VOCAB | notice | Kündigung\n"
        "Some chatter\n"
    )
    parsed = parse_bilingual(reply, 6)
    assert parsed is not None
    lines, words = parsed
    assert lines == {1: "Miete und Kaution", 2: "Der Mieter zahlt 950 Euro pro Monat."}
    assert words == [("deposit", "Kaution"), ("notice", "Kündigung")]


def test_a_reply_with_no_readable_line_is_none():
    assert parse_bilingual("I cannot translate that, sorry", 4) is None
    assert parse_bilingual("VOCAB | deposit | Kaution", 4) is None


def test_rows_pair_each_line_with_its_translation_and_check_the_figures():
    blocks = [
        Block("paragraph", "The tenant pays 950 euros per month."),
        Block("bullet", "Notice is 60 days."),
        Block("heading", "Pets"),
    ]
    result = assemble(blocks, {1: "Der Mieter zahlt 950 Euro pro Monat.", 2: "Die Frist beträgt 30 Tage."}, [])
    rows = result["rows"]
    assert [r["figuresKept"] for r in rows] == [True, False, True]
    assert rows[2]["target"] == "" and result["missing"] == 1
    assert rows[1]["kind"] == "bullet" and rows[1]["source"] == "Notice is 60 days."


def test_number_words_and_thousand_separators_are_not_taken_for_changes():
    blocks = [Block("paragraph", "The deposit is 1,900 euros and lasts seven years.")]
    ok = assemble(blocks, {1: "Die Kaution beträgt 1900 Euro und gilt 7 Jahre."}, [])
    assert ok["rows"][0]["figuresKept"] is True


def test_only_vocabulary_that_occurs_in_the_summary_is_kept_once():
    blocks = split_blocks(SUMMARY)
    words = assemble(
        blocks,
        {},
        [
            ("deposit", "Kaution"),
            ("Deposit", "again"),
            ("mortgage", "Hypothek"),
            ("security  deposit", "x"),
            ("pets", "Haustiere"),
            ("deposi", "a part of a word"),
            ("500", "500"),
        ],
    )["vocabulary"]
    assert [w["word"] for w in words] == ["deposit", "pets"]


class Model:
    def __init__(self, reply):
        self.reply, self.prompts = reply, []

    async def ainvoke(self, prompt):
        self.prompts.append(prompt)
        return type("Msg", (), {"content": self.reply, "usage_metadata": None})()


@pytest.fixture
def client():
    return TestClient(main.app, raise_server_exceptions=False)


def test_the_endpoint_translates_and_checks(client, monkeypatch):
    reply = (
        "1 | Miete und Kaution\n2 | Der Mieter zahlt 950 Euro pro Monat.\n3 | Die Kaution beträgt 2 Monate.\n"
        "VOCAB | deposit | Kaution\nVOCAB | ghost | Geist"
    )
    model = Model(reply)
    monkeypatch.setattr(main, "get_llm", lambda: model)
    body = client.post("/bilingual", json={"name": "Lease", "summary": SUMMARY, "language": "German"}).json()
    assert len(body["rows"]) == 6 and body["missing"] == 3
    assert body["rows"][2]["figuresKept"] is False  # 1,900 is not in "2 Monate"
    assert body["rows"][1]["figuresKept"] is True
    assert body["vocabulary"] == [{"word": "deposit", "translation": "Kaution"}]
    assert len(model.prompts) == 1


def test_the_endpoint_validates(client, monkeypatch):
    monkeypatch.setattr(main, "get_llm", lambda: Model("1 | x"))
    assert client.post("/bilingual", json={"summary": SUMMARY, "language": "Klingon"}).status_code == 422
    assert client.post("/bilingual", json={"summary": SUMMARY, "language": "Same as the text"}).status_code == 422
    assert client.post("/bilingual", json={"summary": "  ", "language": "German"}).status_code == 422
    assert (
        client.post(
            "/bilingual", json={"summary": "x" * (bilingual.MAX_SUMMARY_CHARS + 1), "language": "German"}
        ).status_code
        == 413
    )
    monkeypatch.setattr(main, "get_llm", lambda: Model("not the layout at all"))
    assert client.post("/bilingual", json={"summary": SUMMARY, "language": "German"}).status_code == 502
