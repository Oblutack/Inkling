import random

import pytest
from fastapi.testclient import TestClient

import main
from study import (
    MAX_CARDS,
    MAX_QUIZ_QUESTIONS,
    MAX_SUGGESTIONS,
    flashcards_prompt,
    parse_flashcards,
    parse_quiz,
    parse_suggestions,
    quiz_prompt,
    suggestions_prompt,
)

# ---- suggested questions ---------------------------------------------------------------------------


def test_the_suggestion_prompt_asks_for_specific_answerable_questions_and_gives_the_source():
    prompt = suggestions_prompt("The summary.", "The full text.", None)
    assert "answerable from the document" in prompt and "specific" in prompt
    assert "SUMMARY:\nThe summary." in prompt and "FULL TEXT:\nThe full text." in prompt
    assert "language of the SUMMARY" in prompt and "Never translate" in prompt.rsplit("---", 1)[1]
    assert "Write in Spanish." in suggestions_prompt("s", "", "Spanish")
    assert "every word of your reply must be in Spanish" in suggestions_prompt("s", "", "Spanish")


def test_a_long_text_is_left_out_of_the_prompt():
    assert "FULL TEXT" not in suggestions_prompt("s", "x" * 50_000, None)


REPLY = """Here are some questions:
1. What does the warranty cover?
- **How long is the warranty?**
* Who pays for repairs?
> When must the receipt be shown?
Is there a free replacement?
This line is not a question.
2) What does the warranty cover?
"""


def test_questions_are_found_whatever_the_decoration():
    questions = parse_suggestions(REPLY)
    assert questions == [
        "What does the warranty cover?",
        "How long is the warranty?",
        "Who pays for repairs?",
        "When must the receipt be shown?",
        "Is there a free replacement?",
    ]


def test_questions_are_capped_and_too_few_is_a_failure():
    many = "\n".join(f"What is point number {i} about?" for i in range(20))
    assert len(parse_suggestions(many)) == MAX_SUGGESTIONS
    assert parse_suggestions("What is this?\nWhat is that thing?") is None
    assert parse_suggestions("") is None
    assert parse_suggestions("No questions here.\nJust statements.\nThree of them.") is None


def test_very_short_and_very_long_questions_are_dropped():
    long = "Why " + "really " * 40 + "so?"
    reply = f"Why?\n{long}\nWhat is covered by the warranty?\nWhat is excluded from it?\nWho do I call for repairs?"
    assert parse_suggestions(reply) == [
        "What is covered by the warranty?",
        "What is excluded from it?",
        "Who do I call for repairs?",
    ]


# ---- flashcards -----------------------------------------------------------------------------------------

CARDS = """Q: What is the warranty period?
A: Twenty-four months from purchase.

Q: What is not covered?
A: Accidental damage,
such as a cracked screen.

**Q:** Who must be shown the receipt?
**A:** The service desk.

Question 4: What is the battery rated for?
Answer: 800 charge cycles.
"""


def test_cards_are_read_including_wrapped_answers_and_bold_labels():
    cards = parse_flashcards(CARDS)
    assert [c["front"] for c in cards] == [
        "What is the warranty period?",
        "What is not covered?",
        "Who must be shown the receipt?",
        "What is the battery rated for?",
    ]
    assert cards[1]["back"] == "Accidental damage, such as a cracked screen."
    assert all(set(c) == {"front", "back"} for c in cards)


def test_numbered_and_fenced_cards_are_read_too():
    reply = "```\n1. Q: One thing?\nA: First.\n2. Q: Another thing?\nA: Second.\n3. Q: A third thing?\nA: Third.\n```"
    assert [c["front"] for c in parse_flashcards(reply)] == ["One thing?", "Another thing?", "A third thing?"]


def test_cards_without_an_answer_or_a_question_are_skipped_and_duplicates_dropped():
    reply = (
        "Q: Lonely question?\n\nQ: Real one?\nA: Yes.\n\nQ: Real one?\nA: Again.\n\n"
        "Q: Two?\nA: Two.\n\nQ: Three?\nA: Three."
    )
    assert [c["front"] for c in parse_flashcards(reply)] == ["Real one?", "Two?", "Three?"]


def test_there_must_be_enough_cards_and_not_too_many():
    assert parse_flashcards("Q: Only one?\nA: Yes.") is None
    assert parse_flashcards("") is None
    many = "\n\n".join(f"Q: Question {i}?\nA: Answer {i}." for i in range(40))
    assert len(parse_flashcards(many)) == MAX_CARDS


def test_the_flashcard_prompt_demands_the_document_alone_and_a_fixed_layout():
    prompt = flashcards_prompt("S", "T", "German")
    assert "ONLY facts from the document" in prompt and "Q: the question or term" in prompt
    assert "Write in German." in prompt


# ---- quiz --------------------------------------------------------------------------------------------------

QUIZ = """Q: How long is the warranty?
A) 12 months
B) 24 months
C) 36 months
D) 48 months
ANSWER: B
WHY: The guide says 24 months from the date of purchase.

Q: What is not covered?
A) Manufacturing defects
B) Battery faults
C) A cracked screen
D) A broken hinge
ANSWER: C
WHY: Accidental damage is excluded.

**Q:** What must be kept?
**A)** The box
**B)** The receipt
**C)** The cable
**D)** The manual
**ANSWER:** B
**WHY:** Claims are refused without proof of purchase.
"""


def test_a_quiz_is_read_and_the_answer_follows_the_shuffle():
    questions = parse_quiz(QUIZ, random.Random(7))
    assert len(questions) == 3
    wanted = {
        "How long is the warranty?": "24 months",
        "What is not covered?": "A cracked screen",
        "What must be kept?": "The receipt",
    }
    for q in questions:
        assert len(q["options"]) == 4 and 0 <= q["answer"] < 4
        assert q["options"][q["answer"]] == wanted[q["question"]]
        assert q["explanation"]


def test_the_options_are_shuffled_so_the_answer_is_not_always_in_the_same_place():
    positions = {parse_quiz(QUIZ, random.Random(seed))[0]["answer"] for seed in range(30)}
    assert len(positions) > 1


def test_invalid_questions_are_skipped():
    reply = (
        "Q: Missing an option?\nA) One\nB) Two\nC) Three\nANSWER: A\nWHY: x\n\n"
        "Q: No answer given?\nA) One\nB) Two\nC) Three\nD) Four\nWHY: x\n\n"
        "Q: Repeated options?\nA) Same\nB) Same\nC) Three\nD) Four\nANSWER: A\nWHY: x\n\n" + QUIZ
    )
    assert [q["question"] for q in parse_quiz(reply)] == [
        "How long is the warranty?",
        "What is not covered?",
        "What must be kept?",
    ]


def test_the_quiz_needs_enough_questions_and_is_capped():
    assert parse_quiz("") is None
    assert parse_quiz("Q: One?\nA) a\nB) b\nC) c\nD) d\nANSWER: A\nWHY: because") is None
    many = "\n\n".join(
        f"Q: Question {i}?\nA) a{i}\nB) b{i}\nC) c{i}\nD) d{i}\nANSWER: C\nWHY: reason {i}" for i in range(30)
    )
    assert len(parse_quiz(many)) == MAX_QUIZ_QUESTIONS


def test_the_quiz_prompt_asks_for_four_options_and_a_fixed_layout():
    prompt = quiz_prompt("S", "T", None)
    assert "exactly four options" in prompt and "ANSWER:" in prompt and "WHY:" in prompt


# ---- the endpoints --------------------------------------------------------------------------------------


class Replying:
    def __init__(self, *replies):
        self.replies = list(replies)
        self.prompts = []

    async def ainvoke(self, prompt):
        self.prompts.append(prompt)
        reply = self.replies.pop(0) if len(self.replies) > 1 else self.replies[0]
        return type("Msg", (), {"content": reply, "usage_metadata": None})()


@pytest.fixture
def client():
    return TestClient(main.app, raise_server_exceptions=False)


def post(client, monkeypatch, path, *replies, **body):
    fake = Replying(*replies)
    monkeypatch.setattr(main, "get_llm", lambda: fake)
    return client.post(path, json={"summary": "A summary.", "text": "The text.", **body}), fake


def test_suggestions_come_back_as_a_list(client, monkeypatch):
    response, fake = post(client, monkeypatch, "/suggest", REPLY)
    assert response.status_code == 200
    assert len(response.json()["questions"]) == MAX_SUGGESTIONS
    assert "The text." in fake.prompts[0]


def test_an_unreadable_reply_is_retried_then_fails_cleanly(client, monkeypatch):
    response, fake = post(client, monkeypatch, "/suggest", "nothing useful", REPLY)
    assert response.status_code == 200 and len(fake.prompts) == 2
    response, fake = post(client, monkeypatch, "/suggest", "nope")
    assert response.status_code == 502 and len(fake.prompts) == main.STUDY_ATTEMPTS
    assert "usable" in response.json()["detail"]


def test_flashcards_and_a_quiz(client, monkeypatch):
    response, _ = post(client, monkeypatch, "/study", CARDS, kind="flashcards")
    assert (
        response.status_code == 200 and response.json()["kind"] == "flashcards" and len(response.json()["cards"]) == 4
    )
    response, _ = post(client, monkeypatch, "/study", QUIZ, kind="quiz")
    assert response.status_code == 200 and response.json()["kind"] == "quiz" and len(response.json()["questions"]) == 3


def test_the_language_is_passed_on(client, monkeypatch):
    _, fake = post(client, monkeypatch, "/study", CARDS, kind="flashcards", language="French")
    assert "Write in French." in fake.prompts[0]


@pytest.mark.parametrize(
    ("path", "override", "status"),
    [
        ("/suggest", {"summary": "  ", "text": ""}, 422),
        ("/suggest", {"language": "Klingon"}, 422),
        ("/suggest", {"text": "x" * (main.MAX_MULTI_TEXT_CHARS + 20_000)}, 413),
        ("/study", {"kind": "poem"}, 422),
        ("/study", {"summary": "", "text": ""}, 422),
    ],
    ids=["blank-summary", "unknown-language", "huge-text", "unknown-kind", "study-nothing-to-study-from"],
)
def test_validation(client, monkeypatch, path, override, status):
    response, _ = post(client, monkeypatch, path, CARDS, **override)
    assert response.status_code == status


# ---- a document studied without a summary -----------------------------------------------------------------


def test_the_prompts_work_from_the_text_alone_and_judge_the_language_by_it():
    for prompt in (flashcards_prompt("", "Some short notes.", None), quiz_prompt("  ", "Some short notes.", None)):
        assert "FULL TEXT:\nSome short notes." in prompt and "SUMMARY" not in prompt
        assert "language of the FULL TEXT" in prompt and "Never translate" in prompt.rsplit("---", 1)[1]
    assert "SUMMARY:\nThe summary." in flashcards_prompt("The summary.", "", None)
    assert "language of the SUMMARY" in flashcards_prompt("The summary.", "", None)


def test_flashcards_can_be_made_from_a_short_text_without_a_summary(client, monkeypatch):
    fake = Replying(CARDS)
    monkeypatch.setattr(main, "get_llm", lambda: fake)
    response = client.post("/study", json={"text": "Short lecture notes about cells.", "kind": "flashcards"})
    assert response.status_code == 200 and len(response.json()["cards"]) == 4
    assert "FULL TEXT:\nShort lecture notes about cells." in fake.prompts[0]


def test_a_long_text_needs_its_summary(client, monkeypatch):
    fake = Replying(CARDS)
    monkeypatch.setattr(main, "get_llm", lambda: fake)
    long_text = "x" * (main.FULL_TEXT_MAX_CHARS + 1)
    response = client.post("/study", json={"text": long_text, "kind": "flashcards"})
    assert response.status_code == 422 and "long" in response.json()["detail"] and fake.prompts == []
    assert (
        client.post("/study", json={"summary": "A summary.", "text": long_text, "kind": "flashcards"}).status_code
        == 200
    )


def test_nothing_to_study_from_is_refused(client, monkeypatch):
    fake = Replying(CARDS)
    monkeypatch.setattr(main, "get_llm", lambda: fake)
    assert client.post("/study", json={"summary": " ", "text": " ", "kind": "flashcards"}).status_code == 422
    assert client.post("/study", json={"kind": "quiz"}).status_code == 422
    assert fake.prompts == []


def test_suggestions_also_work_from_a_short_text_alone(client, monkeypatch):
    response, fake = post(client, monkeypatch, "/suggest", REPLY, summary="")
    assert response.status_code == 200 and len(response.json()["questions"]) == MAX_SUGGESTIONS
    assert "FULL TEXT:\nThe text." in fake.prompts[0] and "SUMMARY:" not in fake.prompts[0]
    response, _ = post(client, monkeypatch, "/suggest", REPLY, summary="", text="")
    assert response.status_code == 422


def test_the_podcast_still_needs_a_summary(client, monkeypatch):
    response, _ = post(client, monkeypatch, "/podcast", REPLY, summary="")
    assert response.status_code == 422
