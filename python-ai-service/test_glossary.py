import pytest
from fastapi.testclient import TestClient

import glossary
import main
from glossary import Term, glossary_prompt, parse_glossary, verify

TEXT = (
    "The tenant pays a security deposit. An escrow account holds it.\f"
    "Page two says the deposit is returned. Escrow rules differ. The lessor may deduct arrears from the deposit.\f"
    "The statute of limitations applies to arrears."
)


def test_the_prompt_asks_for_terms_that_really_appear_and_explanations_in_the_right_language():
    prompt = glossary_prompt("Lease", [], "German")
    assert '"Lease"' in prompt and "in German" in prompt and "exactly as the document writes it" in prompt
    assert "language of the document" in glossary_prompt("", [], None)


def test_the_reply_is_read_whatever_the_decoration():
    reply = (
        "Escrow | Money held by a third party until a condition is met.\n"
        "**Arrears** | Payments that are overdue.\n"
        "- Statute of limitations: not a pipe line\n"
        "TERM | explanation\n"
        "Lessor | The person who rents something out.\n"
    )
    terms = parse_glossary(reply)
    assert terms is not None
    assert [t.term for t in terms] == ["Escrow", "Arrears", "Lessor"]
    assert terms[1].explanation == "Payments that are overdue."


def test_none_is_an_answer_and_nonsense_is_not():
    assert parse_glossary("NONE") == []
    assert parse_glossary("None.") == []
    assert parse_glossary("I could not find any specialist words, sorry") is None


def test_only_terms_that_occur_as_whole_words_are_kept_with_their_pages():
    found = verify(
        [
            Term("escrow", "Money held by a third party."),
            Term("deposit", "Money paid in advance."),
            Term("Statute of Limitations", "A time limit for claims."),
            Term("tenancy", "Not in the text."),
            Term("rent", "Only inside another word? no: 'rented' is not in the text either."),
            Term("Escrow", "A repeat, in another case."),
        ],
        TEXT,
    )
    assert [f["term"] for f in found] == ["escrow", "deposit", "Statute of Limitations"]
    assert found[0]["pages"] == [1, 2] and found[1]["pages"] == [1, 2] and found[2]["pages"] == [3]


def test_a_term_is_not_found_inside_a_longer_word():
    assert verify([Term("art", "x")], "The apartment and the party.") == []
    assert verify([Term("art", "x")], "The art of the deal.")[0]["pages"] == []


def test_a_term_with_spaces_matches_across_line_breaks_and_a_text_with_no_pages_has_none():
    found = verify([Term("security deposit", "x")], "A security\ndeposit is paid.")
    assert found == [{"term": "security deposit", "explanation": "x", "pages": []}]


def test_at_most_fifteen_terms():
    text = " ".join(f"term{i}" for i in range(40))
    terms = [Term(f"term{i}", "x") for i in range(40)]
    assert len(verify(terms, text)) == glossary.MAX_TERMS


class Model:
    def __init__(self, reply):
        self.reply, self.prompts = reply, []

    async def ainvoke(self, prompt):
        self.prompts.append(prompt)
        return type("Msg", (), {"content": self.reply, "usage_metadata": None})()


@pytest.fixture
def client():
    return TestClient(main.app, raise_server_exceptions=False)


def test_the_endpoint_returns_only_real_terms_and_asks_the_model_once(client, monkeypatch):
    model = Model(
        "Escrow | Money held by a third party.\nPhantom | A word that is not in the text.\nArrears | Overdue payments."
    )
    monkeypatch.setattr(main, "get_llm", lambda: model)
    body = client.post("/glossary", json={"name": "Lease", "text": TEXT}).json()
    assert [t["term"] for t in body["terms"]] == ["Escrow", "Arrears"]
    assert body["terms"][1]["pages"] == [2, 3] and body["suspicious"] is False
    assert len(model.prompts) == 1


def test_none_gives_an_empty_glossary_and_the_endpoint_validates(client, monkeypatch):
    monkeypatch.setattr(main, "get_llm", lambda: Model("NONE"))
    assert client.post("/glossary", json={"text": TEXT}).json()["terms"] == []
    assert client.post("/glossary", json={"text": "  "}).status_code == 422
    assert client.post("/glossary", json={"text": TEXT, "language": "Klingon"}).status_code == 422
    assert client.post("/glossary", json={"text": "x" * (main.MAX_MULTI_TEXT_CHARS + 1)}).status_code == 413
