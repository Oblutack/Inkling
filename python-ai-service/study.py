"""Questions to ask about a document, and study material made from it (flashcards and a quiz).

As with the podcast, the model writes plain text in a fixed layout and this module does the real work:
reading it tolerantly (numbering, bold, odd spacing, code fences) and then checking every item, so the
interface only ever receives well-formed cards and questions.
"""

import random
import re
from typing import Any

# Documents longer than this are told to the model through their summary alone.
FULL_TEXT_MAX_CHARS = 12_000

MIN_SUGGESTIONS = 3
MAX_SUGGESTIONS = 5
MAX_SUGGESTION_CHARS = 140

MIN_CARDS = 3
MAX_CARDS = 12
MAX_CARD_CHARS = 400

MIN_QUIZ_QUESTIONS = 3
MAX_QUIZ_QUESTIONS = 10
OPTION_COUNT = 4
MAX_QUIZ_CHARS = 300


def _anchor(summary: str) -> str:
    """What the language of the reply is judged by: the summary, or the text itself when a document is studied
    without a summary."""
    return "SUMMARY" if summary.strip() else "FULL TEXT"


def _source(summary: str, text: str) -> str:
    parts = []
    if summary.strip():
        parts.append(f"SUMMARY:\n{summary.strip()}")
    if text.strip() and len(text) <= FULL_TEXT_MAX_CHARS:
        parts.append(f"FULL TEXT:\n{text.strip()}")
    return "\n\n".join(parts)


def _spoken(language: str | None, anchor: str = "SUMMARY") -> str:
    return f"Write in {language}." if language else f"Write in the language of the {anchor}."


def _language_reminder(language: str | None, anchor: str = "SUMMARY") -> str:
    """Said last, after the source: models drift into another language now and then (a German question
    for an English document), and the end of a prompt is what they weigh most."""
    if language:
        return f"Remember: every word of your reply must be in {language}."
    return (
        f"Remember: use exactly the language of the {anchor} above for every word of your reply. "
        f"If the {anchor} is in English, reply in English. Never translate it."
    )


# ---- suggested questions ------------------------------------------------------------------------------


def suggestions_prompt(summary: str, text: str, language: str | None) -> str:
    return f"""Suggest {MAX_SUGGESTIONS} good questions a reader could ask about the document below.
Each question must be answerable from the document, specific to it (not generic), and under 90 characters.
Cover different parts of the document. {_spoken(language, _anchor(summary))}
Reply with one question per line and nothing else: no numbering, no bullets, no introduction.

SOURCE MATERIAL
---
{_source(summary, text)}
---

{_language_reminder(language, _anchor(summary))}"""


_LEADING_MARK = re.compile(r"^\s*(?:[-*•>]+|\d+[.)])\s*")


def _clean(line: str) -> str:
    line = _LEADING_MARK.sub("", line.strip())
    return re.sub(r"[*_`]+", "", line).strip()


def parse_suggestions(reply: str) -> list[str] | None:
    """The questions in a reply, or None when there are too few usable ones."""
    seen, questions = set(), []
    for raw in reply.splitlines():
        line = _clean(raw)
        if not line.endswith("?") or len(line) < 8 or len(line) > MAX_SUGGESTION_CHARS:
            continue
        if line.lower() in seen:
            continue
        seen.add(line.lower())
        questions.append(line)
        if len(questions) == MAX_SUGGESTIONS:
            break
    return questions if len(questions) >= MIN_SUGGESTIONS else None


# ---- flashcards ----------------------------------------------------------------------------------------------


def flashcards_prompt(summary: str, text: str, language: str | None) -> str:
    return f"""Make {MAX_CARDS} flashcards for studying the document below.
Each card has a question or term on the front and a short, exact answer on the back (one or two sentences).
Use ONLY facts from the document and get every figure and name exactly right. Cover the whole document, most
important points first. {_spoken(language, _anchor(summary))} Plain text only: no Markdown.

Reply in exactly this format and nothing else, one blank line between cards:
Q: the question or term
A: the answer

SOURCE MATERIAL
---
{_source(summary, text)}
---

{_language_reminder(language, _anchor(summary))}"""


_Q = re.compile(r"^\s*(?:\d+[.)]\s*)?[*_]*\s*(?:Q|Question|Front)\s*\d*\s*[*_]*\s*[:：]\s*[*_]*\s*(.*)$", re.IGNORECASE)
_A = re.compile(r"^\s*[*_]*\s*(?:A|Answer|Back)\s*[*_]*\s*[:：]\s*[*_]*\s*(.*)$", re.IGNORECASE)


def _plain(text: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[*_`]+", "", text)).strip()


def parse_flashcards(reply: str) -> list[dict] | None:
    cards: list[dict] = []
    front: list[str] | None = None
    back: list[str] | None = None

    def finish():
        if front and back:
            f, b = _plain(" ".join(front)), _plain(" ".join(back))
            if f and b:
                cards.append({"front": f[:MAX_CARD_CHARS], "back": b[:MAX_CARD_CHARS]})

    for line in reply.splitlines():
        q, a = _Q.match(line), _A.match(line)
        if q:
            finish()
            front, back = [q.group(1)], None
        elif a and front is not None:
            back = [a.group(1)]
        elif line.strip() and back is not None:
            back.append(line.strip())
        elif line.strip() and front is not None and back is None:
            front.append(line.strip())
    finish()

    unique, seen = [], set()
    for card in cards:
        if card["front"].lower() not in seen:
            seen.add(card["front"].lower())
            unique.append(card)
    unique = unique[:MAX_CARDS]
    return unique if len(unique) >= MIN_CARDS else None


# ---- quiz ------------------------------------------------------------------------------------------------------


def quiz_prompt(summary: str, text: str, language: str | None) -> str:
    spoken = _spoken(language, _anchor(summary))
    return f"""Write a multiple-choice quiz of {MAX_QUIZ_QUESTIONS} questions about the document below.
Each question has exactly four options (A to D), only one of which is correct, and the wrong options must be
plausible but clearly wrong according to the document. Use ONLY facts from the document. Put the correct
answer in a different position from question to question. {spoken} Plain text only: no Markdown.

Reply in exactly this format and nothing else, one blank line between questions:
Q: the question
A) first option
B) second option
C) third option
D) fourth option
ANSWER: the letter of the correct option
WHY: one sentence from the document that shows why

SOURCE MATERIAL
---
{_source(summary, text)}
---

{_language_reminder(language, _anchor(summary))}"""


_OPTION = re.compile(r"^\s*[*_]*\s*\(?([A-D])[\).:：]\s*[*_]*\s*(.+)$", re.IGNORECASE)
_ANSWER = re.compile(r"^\s*[*_]*\s*(?:ANSWER|CORRECT)\s*[*_]*\s*[:：]\s*[*_]*\s*\(?([A-D])\b", re.IGNORECASE)
_WHY = re.compile(r"^\s*[*_]*\s*(?:WHY|EXPLANATION|BECAUSE)\s*[*_]*\s*[:：]\s*[*_]*\s*(.*)$", re.IGNORECASE)
_QUESTION_START = re.compile(
    r"^\s*(?:\d+[.)]\s*)?[*_]*\s*(?:Q|Question)\s*\d*\s*[*_]*\s*[:：]\s*[*_]*\s*(.*)$", re.IGNORECASE
)


def parse_quiz(reply: str, rng: random.Random | None = None) -> list[dict] | None:
    """Valid questions only: exactly four distinct options and an answer that names one of them. Options
    are shuffled, because models favour the same answer position, and the answer is tracked through it."""
    rng = rng or random.Random()
    blocks: list[dict] = []
    current: dict | None = None
    for line in reply.splitlines():
        if m := _QUESTION_START.match(line):
            current = {"question": [m.group(1)], "options": {}, "answer": None, "why": []}
            blocks.append(current)
        elif current is None:
            continue
        elif m := _ANSWER.match(line):
            current["answer"] = m.group(1).upper()
        elif m := _WHY.match(line):
            current["why"] = [m.group(1)]
        elif m := _OPTION.match(line):
            current["options"][m.group(1).upper()] = _plain(m.group(2))
        elif line.strip() and not current["options"] and current["answer"] is None:
            current["question"].append(line.strip())
        elif line.strip() and current["why"]:
            current["why"].append(line.strip())

    questions: list[dict[str, Any]] = []
    for b in blocks:
        question = _plain(" ".join(b["question"]))
        options = [b["options"].get(letter, "") for letter in "ABCD"]
        if not question or not all(options) or b["answer"] is None:
            continue
        if len({o.lower() for o in options}) != OPTION_COUNT:
            continue
        correct = options["ABCD".index(b["answer"])]
        shuffled = options[:]
        rng.shuffle(shuffled)
        questions.append(
            {
                "question": question[:MAX_QUIZ_CHARS],
                "options": [o[:MAX_QUIZ_CHARS] for o in shuffled],
                "answer": shuffled.index(correct),
                "explanation": _plain(" ".join(b["why"]))[:MAX_QUIZ_CHARS],
            }
        )
    unique, seen = [], set()
    for q in questions:
        if q["question"].lower() not in seen:
            seen.add(q["question"].lower())
            unique.append(q)
    unique = unique[:MAX_QUIZ_QUESTIONS]
    return unique if len(unique) >= MIN_QUIZ_QUESTIONS else None
