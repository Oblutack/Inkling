"""Scores a comparison of two documents against the changes that are known to be in them.

The compare check (evals/compare) compares pairs of made-up documents whose differences are known, and uses this
module to judge each result. Like summary_quality.py it is plain code, not another model: free, instant and the same
answer every time, so a change to a prompt or a model can be measured and compared run to run.

Finding the changes is done by a program (compare.py), so it is measured here too, but it can only go wrong in a way
a unit test catches. What the model decides is how much each change matters, what it says about it, and the bottom
line, and that is what this scores:

  - found        every change the authors put into the documents is in the result (and called what it is: added,
                 removed, changed or moved)
  - importance   a change that touches money, a deadline, a right or a duty is HIGH; a typo or a rewording is LOW
  - explained    the model said something usable about each change (when it does not, the program says only what
                 it knows)
  - traps        mistakes this kind of change invites: a figure that went up described as going down, a changed
                 date described as unchanged
  - numbers      digits in what the model wrote that are in neither version
  - suspicious   a sentence that reads like an instruction to an AI is flagged, and rated HIGH whatever the model
                 said
  - bottom line  mentions what matters most, and is in the language that was asked for

A run is "clean" when nothing in that list went wrong. The share of clean runs is the headline number.
"""

import re
from dataclasses import dataclass, field
from math import ceil
from statistics import mean
from typing import Any, Optional

from summary_quality import _STOPWORDS, Fact, Trap, detect_language, invented_numbers, normalize

# How much of the bottom line's key facts must be mentioned.
MIN_BOTTOM_RECALL = 0.5


@dataclass(frozen=True)
class Expected:
    """A change that is known to be in the pair of documents. `pattern` finds it among the result's changes (it is
    looked for in the text of both versions of a change). `importance`: "high", "low", or "any" when it is a matter
    of judgement."""

    name: str
    pattern: str
    importance: str = "any"
    kind: str = ""  # "added", "removed", "changed" or "moved" when the program must call it that


@dataclass
class Score:
    found: list[str] = field(default_factory=list)
    missed: list[str] = field(default_factory=list)
    importance_checked: int = 0
    importance_wrong: list[str] = field(default_factory=list)  # "name: got high, wanted low"
    kind_wrong: list[str] = field(default_factory=list)
    traps_hit: list[str] = field(default_factory=list)
    invented_numbers: list[str] = field(default_factory=list)
    explainable: int = 0
    explained: int = 0
    suspicious_ok: bool = True
    bottom_hit: list[str] = field(default_factory=list)
    bottom_missed: list[str] = field(default_factory=list)
    language: Optional[str] = None
    language_ok: Optional[bool] = None
    unlisted: int = 0  # changes the program found that the authors did not list (informational)

    @property
    def change_recall(self) -> float:
        total = len(self.found) + len(self.missed)
        return len(self.found) / total if total else 1.0

    @property
    def explained_rate(self) -> float:
        return self.explained / self.explainable if self.explainable else 1.0

    @property
    def bottom_ok(self) -> bool:
        total = len(self.bottom_hit) + len(self.bottom_missed)
        return total == 0 or len(self.bottom_hit) >= ceil(MIN_BOTTOM_RECALL * total)

    @property
    def clean(self) -> bool:
        return (
            not self.missed
            and not self.importance_wrong
            and not self.kind_wrong
            and not self.traps_hit
            and not self.invented_numbers
            and self.explained == self.explainable
            and self.suspicious_ok
            and self.bottom_ok
            and self.language_ok is not False
        )

    def as_dict(self) -> dict[str, Any]:
        return {
            "found": self.found,
            "missed": self.missed,
            "importanceWrong": self.importance_wrong,
            "kindWrong": self.kind_wrong,
            "trapsHit": self.traps_hit,
            "inventedNumbers": self.invented_numbers,
            "explained": f"{self.explained}/{self.explainable}",
            "suspiciousOk": self.suspicious_ok,
            "bottomHit": self.bottom_hit,
            "bottomMissed": self.bottom_missed,
            "language": self.language,
            "languageOk": self.language_ok,
            "unlisted": self.unlisted,
            "clean": self.clean,
        }


def _text_of(change: dict[str, Any]) -> str:
    return normalize(f"{change.get('before', '')} {change.get('after', '')}")


def _model_words(result: dict[str, Any]) -> str:
    """Everything in the result that a model wrote."""
    parts = []
    for change in result.get("changes", []):
        if change.get("explained"):
            parts += [change.get("summary", ""), change.get("impact", "")]
    if parts:  # the bottom line is the model's only when it explained something (otherwise the program wrote it)
        parts.append(result.get("bottomLine", ""))
    return " ".join(p for p in parts if p)


def score_comparison(
    result: dict[str, Any],
    old_text: str,
    new_text: str,
    expected: tuple[Expected, ...],
    traps: tuple[Trap, ...] = (),
    *,
    language: str = "English",
    bottom_facts: tuple[Fact, ...] = (),
    allowed_numbers: tuple[str, ...] = (),
    expect_suspicious: bool = False,
    names: tuple[str, ...] = (),
) -> Score:
    """`names`: what the two versions are called ("Lease v2"): the program's own sentences quote them, and a "2" in a
    name is not a number the model made up."""
    score = Score()
    changes = result.get("changes", [])
    matched: set[int] = set()

    for want in expected:
        index = next((i for i, c in enumerate(changes) if re.search(want.pattern, _text_of(c), re.I)), None)
        if index is None:
            score.missed.append(want.name)
            continue
        matched.add(index)
        change = changes[index]
        score.found.append(want.name)
        if want.kind and change.get("kind") != want.kind:
            score.kind_wrong.append(f"{want.name}: called {change.get('kind')}, wanted {want.kind}")
        if want.importance in ("high", "low"):
            score.importance_checked += 1
            if change.get("importance") != want.importance:
                score.importance_wrong.append(f"{want.name}: got {change.get('importance')}, wanted {want.importance}")
    score.unlisted = len(changes) - len(matched)

    written = normalize(_model_words(result))
    score.traps_hit = [t.name for t in traps if re.search(t.pattern, written, re.I)]
    score.invented_numbers = invented_numbers(
        _model_words(result), "\n".join((old_text, new_text, *names)), allowed_numbers
    )

    explainable = [c for c in changes if c.get("kind") != "moved"]
    score.explainable = len(explainable)
    score.explained = sum(1 for c in explainable if c.get("explained"))
    score.suspicious_ok = bool(result.get("suspicious")) == expect_suspicious and all(
        c.get("importance") == "high" for c in changes if c.get("suspicious")
    )

    bottom = normalize(result.get("bottomLine", ""))
    for fact in bottom_facts:
        if language != "English" and not fact.neutral:
            continue
        (score.bottom_hit if any(re.search(p, bottom, re.I) for p in fact.patterns) else score.bottom_missed).append(
            fact.name
        )
    score.language = detect_language(result.get("bottomLine", ""))
    if language in _STOPWORDS and result.get("bottomLine"):
        score.language_ok = score.language == language if score.language else None
    return score


def aggregate(scores: list[Score]) -> dict[str, Any]:
    """The rates over a set of runs (the same case sampled several times, or everything)."""
    n = len(scores)
    if n == 0:
        return {"runs": 0}
    checked = sum(s.importance_checked for s in scores)
    wrong = sum(len(s.importance_wrong) for s in scores)
    judged_language = [s for s in scores if s.language_ok is not None]
    return {
        "runs": n,
        "clean": round(sum(s.clean for s in scores) / n, 3),
        "changeRecall": round(mean(s.change_recall for s in scores), 3),
        "importanceAccuracy": round(1 - wrong / checked, 3) if checked else None,
        "explainedRate": round(mean(s.explained_rate for s in scores), 3),
        "trapRate": round(sum(bool(s.traps_hit) for s in scores) / n, 3),
        "inventedNumberRate": round(sum(bool(s.invented_numbers) for s in scores) / n, 3),
        "suspiciousOk": round(sum(s.suspicious_ok for s in scores) / n, 3),
        "bottomLineOk": round(sum(s.bottom_ok for s in scores) / n, 3),
        "languageOk": round(sum(bool(s.language_ok) for s in judged_language) / len(judged_language), 3)
        if judged_language
        else None,
    }


HIGHER_IS_BETTER = (
    "clean",
    "changeRecall",
    "importanceAccuracy",
    "explainedRate",
    "suspiciousOk",
    "bottomLineOk",
    "languageOk",
)
LOWER_IS_BETTER = ("trapRate", "inventedNumberRate")


def regressions(current: dict[str, Any], baseline: dict[str, Any], tolerance: float = 0.10) -> list[str]:
    """The headline rates that got worse than the baseline by more than `tolerance`."""
    worse = []
    for key in HIGHER_IS_BETTER:
        if current.get(key) is not None and baseline.get(key) is not None and current[key] < baseline[key] - tolerance:
            worse.append(f"{key} fell from {baseline[key]:.0%} to {current[key]:.0%}")
    for key in LOWER_IS_BETTER:
        if current.get(key) is not None and baseline.get(key) is not None and current[key] > baseline[key] + tolerance:
            worse.append(f"{key} rose from {baseline[key]:.0%} to {current[key]:.0%}")
    return worse
