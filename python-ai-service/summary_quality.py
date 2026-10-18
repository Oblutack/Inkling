"""Scores a summary against what the document is known to say.

The summary-quality check (evals/summary) summarizes documents whose facts are known and uses this module
to judge each result. Like attribution.py it is plain code, not another model: free, instant, and the same
answer every time, so a change to a prompt or a model can be measured and compared run to run.

What is measured, per summary:

  - facts       the things a good summary of this document must keep (a figure, a name, a deadline), given
                as patterns so that any reasonable wording is found. Reported as recall.
  - traps       mistakes this kind of document invites, given as patterns that must NOT appear: the wrong
                currency, a figure moved to the wrong month, "year on year" where the text says "on the
                previous quarter", a warranty exclusion turned into a coverage.
  - numbers     digits in the summary that appear nowhere in the document (attribution.py does the matching).
  - format      what the chosen style promises (bullets only, "Key Takeaways" and "Action Items", ...), and
                leaks such as "(about 70 words)", a "Here is your summary" preamble, or a "=====" underline.
  - language    that the summary is in the language that was asked for (English, Spanish, German, French).
  - length      words against the target. Reported on its own: models overshoot, and it is not an error.

A run is "clean" when it has no trap, no invented number, no format problem, the right language, and at least
`MIN_RECALL` of its facts. The share of clean runs is the headline number.
"""

import re
import unicodedata
from dataclasses import dataclass, field
from statistics import mean
from typing import Optional

from attribution import check_summary

MIN_RECALL = 0.75
# Words may land anywhere in this range around the target before a run is called too short or too long.
LENGTH_TOLERANCE = (0.5, 1.8)


@dataclass(frozen=True)
class Fact:
    """Something a good summary keeps. `patterns` are alternatives: any one of them is a hit. `neutral`
    facts (figures, names) can be found whatever language the summary is written in; the rest are words
    that only make sense in English."""

    name: str
    patterns: tuple[str, ...]
    neutral: bool = True


@dataclass(frozen=True)
class Trap:
    """A mistake that must not appear: a hit on `pattern` is a failure."""

    name: str
    pattern: str


@dataclass
class Score:
    facts_hit: list[str] = field(default_factory=list)
    facts_missed: list[str] = field(default_factory=list)
    traps_hit: list[str] = field(default_factory=list)
    invented_numbers: list[str] = field(default_factory=list)
    format_problems: list[str] = field(default_factory=list)
    language: Optional[str] = None  # what the summary was detected to be written in
    language_ok: Optional[bool] = None  # None when the check does not cover that language
    words: int = 0
    target_words: int = 0

    @property
    def recall(self) -> float:
        total = len(self.facts_hit) + len(self.facts_missed)
        return len(self.facts_hit) / total if total else 1.0

    @property
    def length_ratio(self) -> float:
        return self.words / self.target_words if self.target_words else 0.0

    @property
    def length_ok(self) -> bool:
        low, high = LENGTH_TOLERANCE
        return low <= self.length_ratio <= high

    @property
    def clean(self) -> bool:
        return (
            not self.traps_hit
            and not self.invented_numbers
            and not self.format_problems
            and self.language_ok is not False
            and self.recall >= MIN_RECALL
        )

    def as_dict(self) -> dict:
        return {
            "factsHit": self.facts_hit,
            "factsMissed": self.facts_missed,
            "recall": round(self.recall, 3),
            "trapsHit": self.traps_hit,
            "inventedNumbers": self.invented_numbers,
            "formatProblems": self.format_problems,
            "language": self.language,
            "languageOk": self.language_ok,
            "words": self.words,
            "targetWords": self.target_words,
            "lengthRatio": round(self.length_ratio, 2),
            "lengthOk": self.length_ok,
            "clean": self.clean,
        }


# ---- reading the summary -------------------------------------------------------------------------------


def normalize(text: str) -> str:
    """The summary as plain, single-spaced text, so patterns do not have to know about Markdown marks,
    table bars, non-breaking spaces (models write "4.1 million" with a narrow no-break space) or hyphens."""
    text = unicodedata.normalize("NFKC", text)
    text = re.sub(r"[‐-―−]", "-", text)  # every kind of dash and hyphen, and the minus sign
    text = re.sub(r"[*_`#>|]", " ", text)
    return re.sub(r"[ \t ]+", " ", text)


def words_in(text: str) -> int:
    return len(re.findall(r"\w[\w'’-]*", normalize(text)))


# Wording about the request that has leaked into the answer: "(about 70 words)", "in 150 words".
_LEAK = re.compile(
    r"[(\[]\s*(?:about|approx\.?|approximately|around|≈|~)?\s*\d+\s*words?\s*[)\]]"  # (≈150 words)
    r"|[~≈]\s*\d+\s*words?\b"  # ~150 words
    r"|\b(?:total |summary )?(?:word count|length)\s*[:=]\s*[~≈]?\s*\d+(?:\s*words?)?"  # Total word count: 150
    r"|\b(?:in|of) (?:about|around|approximately)? ?\d+ words\b",
    re.I,
)
_PREAMBLE = re.compile(r"^\s*(?:sure|certainly|of course|okay|ok|here(?:'s| is| are)|below is|as requested)\b", re.I)
_UNDERLINE = re.compile(r"^\s*={3,}\s*$", re.M)
_META = re.compile(
    r"\b(?:as an ai|i cannot|i can't|i'm unable|"
    r"the (?:text|document) (?:provided|given|above) (?:says|states|discusses))\b",
    re.I,
)
_BULLET_LINE = re.compile(r"^\s*(?:[-*+•]|\d+[.)])\s+")


def _content_lines(summary: str) -> list[str]:
    lines = []
    for raw in summary.splitlines():
        line = raw.strip()
        if not line or set(line) <= set("-=_*| :"):
            continue
        lines.append(line)
    return lines


def format_problems(summary: str, style: str) -> list[str]:
    """What the style promises and what no summary should contain."""
    problems = []
    stripped = summary.strip()
    if not stripped:
        return ["empty"]
    if stripped.startswith("```") and stripped.endswith("```"):
        problems.append("wrapped in a code fence")
    if _PREAMBLE.search(stripped):
        problems.append("starts with a preamble")
    if _UNDERLINE.search(summary):
        problems.append("underlines a heading with ====")
    if _LEAK.search(summary):
        problems.append("mentions its own word count")
    if _META.search(summary):
        problems.append("talks about itself or the text")

    lines = _content_lines(summary)
    headings = [line for line in lines if line.startswith("#")]
    lowered = normalize(summary).lower()
    if style == "bullets":
        body = [line for line in lines if not line.startswith("#")]
        bullets = [line for line in body if _BULLET_LINE.match(line)]
        # A title or a "Key points:" label may stand alone; paragraphs of prose may not.
        prose = [line for line in body if not _BULLET_LINE.match(line) and len(line.split()) > 12]
        if body and (len(bullets) < 2 or prose):
            problems.append("not bullet points only")
    elif style == "brief":
        for section in ("overview", "key points", "implications"):
            if section not in lowered:
                problems.append(f"missing section: {section}")
    elif style == "glance":
        if headings or any(_BULLET_LINE.match(line) for line in lines) or "**" in summary:
            problems.append("not one plain paragraph")
    elif style == "takeaways":
        for section in ("key takeaways", "action items"):
            if section not in lowered:
                problems.append(f"missing section: {section}")
    elif (
        style == "default"
        and not headings
        and not any(_BULLET_LINE.match(line) for line in lines)
        and "**" not in summary
    ):
        problems.append("no structure (no heading, bullet or bold)")
    return problems


# ---- language ------------------------------------------------------------------------------------------

# Small common words of each language, chosen to differ from the others' ("de", "la", "que" are Spanish and French
# both, so neither list has them): what is left tells the languages apart even in a short, telegraphic summary.
_STOPWORDS = {
    "English": "the and of to in is that for with as on are was by this it be from or which has have not their will",
    "Spanish": "el los las del y por con para es su sus al lo como más pero fue sobre entre una está muy también sin",
    "German": "der die das und ist von zu den mit sich des auf für nicht ein eine dem im als auch werden aus er sind",
    "French": "le les des du et est dans pour pas sur au avec ce sa ses par plus qui une sont mais cette ont été",
}


def detect_language(text: str) -> Optional[str]:
    """The language (of English, Spanish, German, French) whose common words the text uses most, or None."""
    tokens = re.findall(r"[^\W\d_]+", normalize(text).lower())
    if len(tokens) < 12:
        return None
    scores = {
        name: sum(1 for t in tokens if t in set(words.split())) / len(tokens) for name, words in _STOPWORDS.items()
    }
    best = max(scores, key=lambda name: scores[name])
    runner_up = max((v for name, v in scores.items() if name != best), default=0.0)
    # Telegraphic bullets ("Rent: 950, due monthly") use few small words, so the bar is low, but the
    # language must clearly lead the others.
    return best if scores[best] >= 0.02 and scores[best] >= 2 * runner_up else None


# ---- numbers -------------------------------------------------------------------------------------------


def _digits(text: str) -> set[str]:
    """Numbers written with digits, as attribution.py writes them (no thousands separators)."""
    return {n.replace(",", "") for n in re.findall(r"\d+(?:[.,]\d+)*", _join_thousands(normalize(text)))}


def _join_thousands(text: str) -> str:
    """ "1 900" and "1\u202f900" (a space as the thousands separator, as in Spanish and French) as "1900"."""
    previous = None
    while previous != text:
        previous = text
        text = re.sub(r"(?<![\d.,])(\d{1,3})[ \u00a0\u202f](\d{3})(?![\d])", r"\1\2", text)
    return text


def _canonical(number: str) -> str:
    """A figure without its separators, so "2,4" (Spanish) and "2.4", "85.000" and "85,000" are one figure."""
    return re.sub(r"[.,]", "", number)


def invented_numbers(summary: str, source: str, allowed: tuple[str, ...] = ()) -> list[str]:
    """Digits in the summary that the document never mentions (words such as "three" are not counted: only
    a written figure can be checked without guessing). Wording about the request itself is ignored."""
    cleaned = _join_thousands(_LEAK.sub(" ", summary))
    cleaned = re.sub(r"\b(\d{1,2}):00\b", r"\1", cleaned)  # a time: "9:00" is the figure 9, not 9 and 00
    report = check_summary(cleaned, source)
    known = {_canonical(n) for n in re.findall(r"\d+(?:[.,]\d+)*", normalize(source))}
    missing: list[str] = []
    for sentence in report["sentences"]:
        written = _digits(sentence["text"])  # "one-third" is a number word, not a written figure
        for number in sentence["missingNumbers"]:
            if (
                number in written
                and number not in allowed
                and number not in missing
                and _canonical(number) not in known
            ):
                missing.append(number)
    return missing


# ---- the whole judgement -------------------------------------------------------------------------------


def score_summary(
    summary: str,
    source: str,
    facts: tuple[Fact, ...],
    traps: tuple[Trap, ...],
    *,
    style: str = "default",
    language: str = "English",
    target_words: int = 150,
    allowed_numbers: tuple[str, ...] = (),
) -> Score:
    text = normalize(summary)
    score = Score(words=words_in(summary), target_words=target_words)

    for fact in facts:
        if language != "English" and not fact.neutral:
            continue  # a word pattern says nothing about a summary in another language
        if any(re.search(p, text, re.I) for p in fact.patterns):
            score.facts_hit.append(fact.name)
        else:
            score.facts_missed.append(fact.name)
    score.traps_hit = [trap.name for trap in traps if re.search(trap.pattern, text, re.I)]
    allowed = allowed_numbers + (("12",) if style == "simple" else ())  # "a 12-year-old": that style's own wording
    score.invented_numbers = invented_numbers(summary, source, allowed)
    score.format_problems = format_problems(summary, style)

    score.language = detect_language(summary)
    if language in _STOPWORDS:
        score.language_ok = score.language == language if score.language else None
    return score


# ---- many runs -----------------------------------------------------------------------------------------


def aggregate(scores: list[Score]) -> dict:
    """The rates over a set of runs (the same case and variant sampled several times, or everything)."""
    n = len(scores)
    if n == 0:
        return {"runs": 0}
    judged_language = [s for s in scores if s.language_ok is not None]
    return {
        "runs": n,
        "clean": round(sum(s.clean for s in scores) / n, 3),
        "recall": round(mean(s.recall for s in scores), 3),
        "trapRate": round(sum(bool(s.traps_hit) for s in scores) / n, 3),
        "inventedNumberRate": round(sum(bool(s.invented_numbers) for s in scores) / n, 3),
        "formatProblemRate": round(sum(bool(s.format_problems) for s in scores) / n, 3),
        "languageOk": round(sum(bool(s.language_ok) for s in judged_language) / len(judged_language), 3)
        if judged_language
        else None,
        "lengthOk": round(sum(s.length_ok for s in scores) / n, 3),
        "lengthRatio": round(mean(s.length_ratio for s in scores), 2),
    }


# Rates where a bigger number is better, and where a smaller one is.
HIGHER_IS_BETTER = ("clean", "recall", "languageOk", "lengthOk")
LOWER_IS_BETTER = ("trapRate", "inventedNumberRate", "formatProblemRate")


def regressions(current: dict, baseline: dict, tolerance: float = 0.10) -> list[str]:
    """The headline rates that got worse than the baseline by more than `tolerance`."""
    worse = []
    for key in HIGHER_IS_BETTER:
        if current.get(key) is not None and baseline.get(key) is not None and current[key] < baseline[key] - tolerance:
            worse.append(f"{key} fell from {baseline[key]:.0%} to {current[key]:.0%}")
    for key in LOWER_IS_BETTER:
        if current.get(key) is not None and baseline.get(key) is not None and current[key] > baseline[key] + tolerance:
            worse.append(f"{key} rose from {baseline[key]:.0%} to {current[key]:.0%}")
    return worse
