"""Checks each sentence of a summary against the source text: which passages back it up, and how well.

This is deliberately plain text matching, not another model call. It is free, instant and gives the
same answer every time. What it measures is how much of a sentence's wording (and, separately, its
numbers) appears in a passage of the original. That catches the classic summarizer failures, such as
a figure that is not in the document, but it cannot judge meaning: a faithful paraphrase can score
as only partly found, and a sentence marked "not found" is a reason to look, not proof of an error.
"""

import math
import re
from collections import Counter
from dataclasses import dataclass, field

from retrieval import Passage, select_passages

# Support levels, from best to worst.
STRONG, WEAK, NONE = "strong", "weak", "none"

STRONG_COVERAGE = 0.70
WEAK_COVERAGE = 0.40
MIN_SHOWN_COVERAGE = 0.30
MAX_PASSAGES_PER_SENTENCE = 2
# Below this share of supported sentences the summary is probably in another language than the
# document, and "not found" would only mean "different words".
MIN_SUPPORTED_SHARE = 0.15

_STOPWORDS = frozenset(
    """a about above after again all also am an and any are as at be because been before being below
    between both but by can could did do does doing down during each few for from further had has have
    having he her here hers him his how i if in into is it its just may me might more most must my no
    nor not now of off on once only or other our out over own same she should so some such than that
    the their them then there these they this those through to too under until up us very was we were
    what when where which while who whom why will with would you your""".split()
)

_WORD = re.compile(r"[^\W\d_]+", re.UNICODE)
_NUMBER = re.compile(r"\d+(?:[.,]\d+)*")
_SENTENCE_END = re.compile(r"(?<=[.!?])\s+(?=[A-Z0-9\"“(\[])")
_BULLET = re.compile(r"^\s*(?:[-*+•]|\d+[.)])\s+")
_LINK = re.compile(r"\[([^\]]*)\]\([^)]*\)")


def stem(word: str) -> str:
    """A very light stemmer, enough to let 'filters' meet 'filter' and 'covered' meet 'covers'."""
    for suffix in ("ing", "ed", "es", "s"):
        if len(word) > len(suffix) + 3 and word.endswith(suffix):
            return word[: -len(suffix)]
    return word


def terms(text: str) -> set[str]:
    """The meaningful words of a text, lightly stemmed."""
    return {stem(w) for w in (m.lower() for m in _WORD.findall(text)) if len(w) > 2 and w not in _STOPWORDS}


_NUMBER_WORDS = {
    **{w: str(i) for i, w in enumerate("zero one two three four five six seven eight nine ten eleven twelve".split())},
    **{
        w: str(v)
        for w, v in (
            ("thirteen", 13),
            ("fourteen", 14),
            ("fifteen", 15),
            ("sixteen", 16),
            ("seventeen", 17),
            ("eighteen", 18),
            ("nineteen", 19),
        )
    },
    **{
        w: str(v)
        for w, v in (
            ("twenty", 20),
            ("thirty", 30),
            ("forty", 40),
            ("fifty", 50),
            ("sixty", 60),
            ("seventy", 70),
            ("eighty", 80),
            ("ninety", 90),
        )
    },
    **{w: str(v) for w, v in (("hundred", 100), ("thousand", 1000), ("million", 1000000), ("billion", 1000000000))},
}


def numbers(text: str) -> list[str]:
    """The numbers in a text, written the same way: no thousands separators, and number words
    ('seven') as digits, so 'seven years' and '7 years' agree and 'ten' does not match 'three'."""
    found = [n.replace(",", "") for n in _NUMBER.findall(text)]
    found += [_NUMBER_WORDS[w] for w in (m.lower() for m in _WORD.findall(text)) if w in _NUMBER_WORDS]
    return found


@dataclass
class Unit:
    text: str
    kind: str  # "claim" is checked; "heading" is a label such as "Key Points" and is not


def _plain(line: str) -> str:
    """A line of Markdown as plain text."""
    line = _LINK.sub(r"\1", line)
    line = re.sub(r"^\s*(?:#{1,6}|>)\s*", "", line)
    line = _BULLET.sub("", line)
    line = re.sub(r"(\*\*|__|\*|_|`)", "", line)
    return re.sub(r"\s+", " ", line).strip()


def summary_units(summary: str) -> list[Unit]:
    """Splits a Markdown summary into headings and individual sentences, in order."""
    units: list[Unit] = []
    for raw in summary.splitlines():
        stripped = raw.strip()
        if not stripped or set(stripped) <= set("-=_*| :"):  # blank lines, rules, table dividers
            continue
        text = _plain(stripped.strip("|").replace("|", " "))
        if not text:
            continue
        words = text.split()
        # "Key Points" is a label; "Tenant: Jordan Ellis" (a label with its value) states something
        label_like = (
            len(words) <= 4
            and not re.search(r"[.!?]$", text)
            and not any(c.isdigit() for c in text)
            and not re.search(r":\s*\S", text)
        )
        if stripped.startswith("#") or label_like:
            units.append(Unit(text.rstrip(":"), "heading"))
            continue
        for sentence in _SENTENCE_END.split(text):
            sentence = sentence.strip()
            if sentence:
                units.append(Unit(sentence, "claim"))
    return units


@dataclass
class PassageMatch:
    passage: Passage
    coverage: float


@dataclass
class Checked:
    text: str
    kind: str
    support: str | None = None  # strong / weak / none; None for headings
    coverage: float = 0.0
    missing_numbers: list[str] = field(default_factory=list)  # in the summary, nowhere in the document
    elsewhere_numbers: list[str] = field(default_factory=list)  # in the document, but not near the match
    matches: list[PassageMatch] = field(default_factory=list)


class _Index:
    """The passages of a document, searchable by word."""

    def __init__(self, passages: list[Passage]):
        self.passages = passages
        self.terms = [terms(p.text) for p in passages]
        self.numbers = [set(numbers(p.text)) for p in passages]
        self.all_numbers = set().union(*self.numbers) if passages else set()
        self._sentences: dict[int, list[tuple[set[str], set[str]]]] = {}
        self.postings: dict[str, list[int]] = {}
        for i, passage_terms in enumerate(self.terms):
            for term in passage_terms:
                self.postings.setdefault(term, []).append(i)
        n = max(len(passages), 1)
        # Rare words say more than common ones: weight each by how unusual it is in this document.
        self.weight = {t: math.log(1 + n / len(p)) for t, p in self.postings.items()}

    def coverage(self, wanted: set[str], passage_terms: set[str]) -> float:
        total = sum(self.weight.get(t, 1.0) for t in wanted)
        if total == 0:
            return 0.0
        return sum(self.weight.get(t, 1.0) for t in wanted & passage_terms) / total

    def best(self, wanted: set[str]) -> list[tuple[int, float]]:
        """Candidate passages with their coverage, best first. Only passages sharing a word are scored."""
        hits: Counter[int] = Counter()
        for term in wanted:
            for i in self.postings.get(term, ()):
                hits[i] += 1
        scored = [(i, self.coverage(wanted, self.terms[i])) for i in hits]
        return sorted(scored, key=lambda pair: (-pair[1], pair[0]))[:5]


def _in_document(index: _Index, number: str) -> bool:
    """Whether the number appears anywhere in the document."""
    return number in index.all_numbers


MAX_COVERING_SENTENCES = 4
# A further sentence is only worth adding if it explains at least this share of the wording.
MIN_COVER_GAIN = 0.15


def _numbers_near(index: _Index, wanted: set[str], near: list[int]) -> set[str]:
    """The numbers in the source sentences that, together, account for the summary sentence's wording.

    A passage is often a whole page, so "somewhere in the passage" is too loose: a figure for one thing
    would pass as the figure for its neighbour. But a summary sentence may also combine several source
    sentences ("7 years for the unit, 3 for the motor"). So sentences are picked greedily, best first,
    each one only if it explains words the earlier ones did not, and the numbers of all of them count.
    A sentence that one source sentence covers completely stops there, which is what keeps a figure
    borrowed from the next sentence over from passing."""
    # Number words ("seven") are what is being verified, so they must not help pick the sentences.
    remaining = {t for t in wanted if t not in _NUMBER_WORDS} or set(wanted)
    total = sum(index.weight.get(t, 1.0) for t in remaining) or 1.0

    candidates: list[tuple[set[str], set[str]]] = []
    for i in near:
        if i not in index._sentences:
            index._sentences[i] = [
                (terms(sentence), set(numbers(sentence))) for sentence in _SENTENCE_END.split(index.passages[i].text)
            ]
        candidates += [(t, n) for t, n in index._sentences[i] if t]
    if not candidates:
        return set().union(*(index.numbers[i] for i in near)) if near else set()

    def gain(sentence_terms: set[str]) -> float:
        return sum(index.weight.get(t, 1.0) for t in remaining & sentence_terms)

    chosen: set[str] = set()
    for _ in range(MAX_COVERING_SENTENCES):
        if not candidates:
            break
        best = max(candidates, key=lambda c: gain(c[0]))
        if gain(best[0]) < MIN_COVER_GAIN * total:
            break
        chosen |= best[1]
        remaining -= best[0]
        candidates.remove(best)
        if not remaining:
            break
    return chosen


def check_summary(summary: str, text: str) -> dict:
    """Checks every sentence of `summary` against `text`. Returns plain data ready for JSON."""
    passages = select_passages(text, "", len(text) + 1)  # every passage, with page and file
    index = _Index(passages)

    checked: list[Checked] = []
    for unit in summary_units(summary):
        if unit.kind == "heading":
            checked.append(Checked(unit.text, "heading"))
            continue
        wanted = terms(unit.text)
        item = Checked(unit.text, "claim", NONE)
        candidates = index.best(wanted) if wanted else []
        if candidates:
            top, coverage = candidates[0]
            # A sentence may draw on two neighbouring passages; judge on both together, as long as
            # each really contributes.
            if len(candidates) > 1 and candidates[1][1] >= 0.2 and coverage >= 0.2:
                joint = index.coverage(wanted, index.terms[top] | index.terms[candidates[1][0]])
                coverage = max(coverage, joint)
            item.coverage = round(coverage, 3)
            shown = [c for c in candidates if c[1] >= MIN_SHOWN_COVERAGE][:MAX_PASSAGES_PER_SENTENCE]
            item.matches = [PassageMatch(index.passages[i], round(c, 3)) for i, c in shown]
            near = [i for i, _ in candidates[:MAX_PASSAGES_PER_SENTENCE]]
            nearby = _numbers_near(index, wanted, near)
            for n in dict.fromkeys(numbers(unit.text)):
                if not _in_document(index, n):
                    item.missing_numbers.append(n)  # a figure the document never mentions
                elif n not in nearby:
                    item.elsewhere_numbers.append(n)  # in the document, but not where the wording matches
            numbers_ok = not item.missing_numbers and not item.elsewhere_numbers
            if coverage >= STRONG_COVERAGE and numbers_ok:
                item.support = STRONG
            elif coverage >= WEAK_COVERAGE:
                item.support = WEAK
        else:
            item.missing_numbers = [n for n in dict.fromkeys(numbers(unit.text)) if not _in_document(index, n)]
        checked.append(item)

    claims = [c for c in checked if c.kind == "claim"]
    supported = sum(1 for c in claims if c.support in (STRONG, WEAK))
    share = supported / len(claims) if claims else 0.0
    return {
        "sentences": [
            {
                "text": c.text,
                "kind": c.kind,
                "support": c.support,
                "coverage": c.coverage,
                "missingNumbers": c.missing_numbers,
                "elsewhereNumbers": c.elsewhere_numbers,
                "passages": [
                    {
                        "id": m.passage.id,
                        "text": m.passage.text,
                        "page": m.passage.page,
                        "pageEnd": m.passage.page_end,
                        "document": m.passage.document,
                        "coverage": m.coverage,
                    }
                    for m in c.matches
                ],
            }
            for c in checked
        ],
        "claims": len(claims),
        "found": sum(1 for c in claims if c.support == STRONG),
        "partly": sum(1 for c in claims if c.support == WEAK),
        "notFound": sum(1 for c in claims if c.support == NONE),
        # False when almost nothing matched: the summary is most likely in another language than the document.
        "verifiable": len(claims) < 3 or share >= MIN_SUPPORTED_SHARE,
    }
