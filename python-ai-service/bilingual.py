"""A summary in two languages side by side, paragraph by paragraph, with a list of the key words and their
translations.

The summary is cut into lines (a heading, a bullet or a paragraph each) and the model translates them one by
one, so the two languages line up exactly. A program checks what it can: every line must come back (one that
does not is left empty, not invented), and the numbers of a line must still be in its translation, because a
changed figure is the mistake that matters most. A line whose figures differ is marked so the screen can say
"check this one". The vocabulary words must really occur in the summary. One call; the translation is the
model's, and is shown as that.
"""

import re
from dataclasses import dataclass
from typing import Any, Optional

from attribution import numbers

MAX_BLOCKS = 80
MAX_BLOCK_CHARS = 1_200
MAX_VOCABULARY = 12
MAX_WORD_CHARS = 60
MAX_SUMMARY_CHARS = 24_000

_PREFIX = re.compile(r"^(\s*(?:#{1,6}\s+|[-*+•]\s+|\d{1,3}[.)]\s+))")


@dataclass
class Block:
    kind: str  # "heading", "bullet", "numbered" or "paragraph"
    text: str  # the line without its marks


def split_blocks(summary: str) -> list[Block]:
    """The lines of a summary, each without its Markdown marks and with what kind of line it was."""
    blocks: list[Block] = []
    for raw in summary.replace("\r\n", "\n").split("\n"):
        line = raw.strip()
        if not line or re.fullmatch(r"[-*_=]{3,}", line):
            continue
        match = _PREFIX.match(raw)
        marks = match.group(1).strip() if match else ""
        text = re.sub(r"[*_`]+", "", raw[len(match.group(1)) :] if match else line).strip()
        if not text:
            continue
        if marks.startswith("#"):
            kind = "heading"
        elif marks and marks[0].isdigit():
            kind = "numbered"
        elif marks:
            kind = "bullet"
        else:
            kind = "paragraph"
        blocks.append(Block(kind, text[:MAX_BLOCK_CHARS]))
    return blocks[:MAX_BLOCKS]


def bilingual_prompt(name: str, blocks: list[Block], language: str) -> str:
    listing = "\n".join(f"{i}. {b.text}" for i, b in enumerate(blocks, start=1))
    title = f' "{name}"' if name.strip() else ""
    return f"""Translate the numbered lines of this summary{title} into {language}.

Rules:
- Reply with one line for each numbered line, in the same order, in this layout:
  NUMBER | translation
  The translation is of that line only. Keep every number, amount, date and name exactly as it is. Do not add, drop
  or combine lines, and do not explain anything.
- Then, on lines of their own, list up to {MAX_VOCABULARY} key words or short phrases (at most 3 words) from the lines,
  each with its translation, in this layout:
  VOCAB | the word as written in the lines | its translation
- Plain text only: no Markdown marks.

LINES
---
{listing}
---"""


_LINE = re.compile(r"^\W*(\d{1,3})\W*\|(.*)$")
_VOCAB = re.compile(r"^\W*VOCAB\W*\|(.*)$", re.IGNORECASE)


def _plain(text: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"<[^>]*>|[*_`#]+", "", text)).strip()


def parse_bilingual(reply: str, count: int) -> Optional[tuple[dict[int, str], list[tuple[str, str]]]]:
    """({line number: translation}, [(word, translation)]) from a reply, or None when no line of it can be read."""
    lines: dict[int, str] = {}
    vocabulary: list[tuple[str, str]] = []
    for raw in reply.splitlines():
        vocab = _VOCAB.match(raw.strip())
        if vocab:
            parts = vocab.group(1).split("|")
            if len(parts) >= 2 and _plain(parts[0]) and _plain(parts[1]):
                vocabulary.append((_plain(parts[0])[:MAX_WORD_CHARS], _plain(parts[1])[:MAX_WORD_CHARS]))
            continue
        match = _LINE.match(raw.strip())
        if not match:
            continue
        number = int(match.group(1))
        text = _plain(match.group(2))
        if 1 <= number <= count and number not in lines and text:
            lines[number] = text[: MAX_BLOCK_CHARS * 2]
    return (lines, vocabulary) if lines else None


def _numbers_match(source: str, target: str) -> bool:
    return set(numbers(source)) <= set(numbers(target))


def assemble(blocks: list[Block], translated: dict[int, str], vocabulary: list[tuple[str, str]]) -> dict[str, Any]:
    """The rows (a line and its translation, with whether its figures are all still there) and the vocabulary, keeping
    only words that really occur in the summary."""
    rows = []
    for number, block in enumerate(blocks, start=1):
        target = translated.get(number, "")
        rows.append(
            {
                "kind": block.kind,
                "source": block.text,
                "target": target,
                "figuresKept": _numbers_match(block.text, target) if target else True,
            }
        )
    whole = " ".join(" ".join(b.text for b in blocks).lower().split())
    seen: set[str] = set()
    words = []
    for word, translation in vocabulary:
        key = " ".join(word.lower().split())
        # a whole word or phrase of the summary (a pair the model wrote the wrong way round is not)
        if (
            not any(ch.isalpha() for ch in key)
            or key in seen
            or not re.search(rf"(?<!\w){re.escape(key)}(?!\w)", whole)
        ):
            continue
        seen.add(key)
        words.append({"word": word, "translation": translation})
        if len(words) == MAX_VOCABULARY:
            break
    return {"rows": rows, "vocabulary": words, "missing": sum(1 for r in rows if not r["target"])}
