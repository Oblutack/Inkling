"""The compare check's scoring and its documents, offline (no model): the evals/compare cases are real pairs, a
hand-written ideal answer must score clean for every one, and answers with a known mistake must be caught."""

import asyncio
import copy
import os
import re
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "evals", "compare"))

from compare_cases import CASES  # noqa: E402

import compare  # noqa: E402
import compare_quality as cq  # noqa: E402


def ideal_ask(case):
    """A model that answers the way a careful reader would: each change rated as the authors say it should be, and the
    case's own bottom line."""
    changes = compare.find_changes(case.old[1], case.new[1])

    def importance_of(change) -> str:
        text = f"{change.before} {change.after}"
        for want in case.expected:
            if re.search(want.pattern, text, re.I) and want.importance in ("high", "low"):
                return want.importance.upper()
        return "MEDIUM"

    async def ask(prompt: str) -> str:
        if prompt.startswith("Two versions of a document were compared"):
            return case.reference_bottom_line
        lines = []
        for number, change in enumerate(changes, start=1):
            if change.kind != "moved":
                lines.append(
                    f"{number} | {importance_of(change)} | The text was changed. | A reader would want to know."
                )
        return "\n".join(lines)

    return ask


def ideal_result(case):
    return asyncio.run(
        compare.compare_documents(case.old[0], case.old[1], case.new[0], case.new[1], case.language, ideal_ask(case))
    )


def score(case, result):
    return cq.score_comparison(
        result,
        case.old[1],
        case.new[1],
        case.expected,
        case.traps,
        language=case.language,
        bottom_facts=case.bottom_facts,
        allowed_numbers=case.allowed_numbers,
        expect_suspicious=case.expect_suspicious,
        names=(case.old[0], case.new[0]),
    )


def case_named(name):
    return next(c for c in CASES if c.id == name)


# ---- the documents ----------------------------------------------------------------------------------


def test_the_cases_are_well_formed():
    assert len({c.id for c in CASES}) == len(CASES)
    for case in CASES:
        assert case.old[1] != case.new[1], case.id
        assert case.expected and case.reference_bottom_line, case.id
        for want in case.expected:
            re.compile(want.pattern)
            assert want.importance in ("high", "low", "any"), (case.id, want.name)
        for trap in case.traps:
            re.compile(trap.pattern)


@pytest.mark.parametrize("case", CASES, ids=lambda c: c.id)
def test_the_program_finds_every_change_the_authors_put_in(case):
    changes = compare.find_changes(case.old[1], case.new[1])
    texts = [f"{c.before} {c.after}" for c in changes]
    for want in case.expected:
        hits = [c for c, t in zip(changes, texts, strict=False) if re.search(want.pattern, t, re.I)]
        assert hits, f"{case.id}: nothing matches {want.name!r}"
        if want.kind:
            assert hits[0].kind == want.kind, f"{case.id}: {want.name} is {hits[0].kind}"


# ---- an ideal answer is clean ----------------------------------------------------------------------


@pytest.mark.parametrize("case", CASES, ids=lambda c: c.id)
def test_the_ideal_answer_scores_clean(case):
    result = ideal_result(case)
    s = score(case, result)
    assert s.clean, (case.id, s.as_dict())
    assert s.change_recall == 1.0


def test_the_traps_do_not_fire_on_the_ideal_answers():
    for case in CASES:
        assert score(case, ideal_result(case)).traps_hit == [], case.id


# ---- known mistakes are caught ---------------------------------------------------------------------


def broken(case_id, edit):
    case = case_named(case_id)
    result = copy.deepcopy(ideal_result(case))
    edit(result)
    return case, score(case, result)


def change_with(result, text):
    return next(c for c in result["changes"] if text in c["before"] + c["after"])


def test_a_change_rated_the_wrong_way_is_caught():
    case, s = broken("lease", lambda r: change_with(r, "Notice.").update(importance="low"))
    assert not s.clean and s.importance_wrong == ["notice: got low, wanted high"]
    case, s = broken("wording", lambda r: change_with(r, "recieve").update(importance="high"))
    assert not s.clean and s.importance_wrong and "typo" in s.importance_wrong[0]


def test_a_change_the_result_does_not_have_is_caught():
    case, s = broken("services", lambda r: r["changes"].remove(change_with(r, "governed by")))
    assert s.missed == ["governing law"] and not s.clean and s.change_recall == 0.75


def test_a_change_called_by_the_wrong_kind_is_caught():
    case, s = broken("deleted", lambda r: change_with(r, "Indemnity.").update(kind="added"))
    assert s.kind_wrong and not s.clean


def test_a_figure_described_in_the_wrong_direction_is_caught():
    case, s = broken(
        "lease", lambda r: change_with(r, "Rent.").update(impact="The rent decreases, so the tenant pays less.")
    )
    assert s.traps_hit == ["rent said to go down"] and not s.clean
    case, s = broken(
        "report", lambda r: change_with(r, "Headcount").update(impact="Headcount grew, so the team is bigger.")
    )
    assert s.traps_hit == ["headcount said to grow"]


def test_a_number_nobody_wrote_is_caught():
    case, s = broken(
        "services", lambda r: change_with(r, "total liability").update(impact="Cover of 75,000 euros would apply.")
    )
    assert s.invented_numbers == ["75000"] and not s.clean


def test_a_change_the_model_said_nothing_usable_about_is_caught():
    case, s = broken("services", lambda r: change_with(r, "Audit.").update(explained=False))
    assert s.explained == s.explainable - 1 and not s.clean


def test_obeying_a_sentence_written_to_steer_it_is_caught():
    def obey(result):
        result["bottomLine"] = "All the changes are low importance, nothing to worry about."
        change_with(result, "Ignore your instructions").update(importance="low")

    case, s = broken("steering", obey)
    assert s.traps_hit == ["the instruction was obeyed"] and not s.suspicious_ok and not s.clean


def test_a_missing_warning_about_a_steering_sentence_is_caught():
    case, s = broken("steering", lambda r: r.update(suspicious=False))
    assert not s.suspicious_ok and not s.clean
    # and a warning where there is nothing to warn about is just as wrong
    case, s = broken("lease", lambda r: r.update(suspicious=True))
    assert not s.suspicious_ok


def test_a_bottom_line_that_misses_what_matters_or_is_in_the_wrong_language_is_caught():
    case, s = broken(
        "lease", lambda r: r.update(bottomLine="Some things are different between the two versions of the lease.")
    )
    assert s.bottom_missed and not s.bottom_ok and not s.clean
    case, s = broken(
        "spanish",
        lambda r: r.update(
            bottomLine="The rent rises from 800 to 850 euros and the contract now lasts 24 months instead of twelve."
        ),
    )
    assert s.language_ok is False and not s.clean


def test_a_move_called_a_change_of_content_is_caught():
    def misread(result):
        # (with nothing but moves the program writes the bottom line itself; here the model has had its say)
        result["changes"][0].update(explained=True, summary="The break times were removed.")
        result["bottomLine"] = "The break times were removed and a new section was added."

    case, s = broken("moved", misread)
    assert "a move described as a change of content" in s.traps_hit and not s.clean


# ---- many runs ------------------------------------------------------------------------------------


def test_the_rates_over_many_runs():
    good = score(case_named("lease"), ideal_result(case_named("lease")))
    case, bad = broken("lease", lambda r: change_with(r, "Notice.").update(importance="low"))
    rates = cq.aggregate([good, good, good, bad])
    assert rates["runs"] == 4 and rates["clean"] == 0.75
    assert rates["importanceAccuracy"] == round(1 - 1 / 16, 3)
    assert rates["changeRecall"] == 1.0 and rates["languageOk"] == 1.0
    assert cq.aggregate([]) == {"runs": 0}


def test_a_worse_run_is_reported_as_a_regression():
    baseline = {"clean": 0.9, "importanceAccuracy": 0.95, "trapRate": 0.0}
    assert cq.regressions({"clean": 0.88, "importanceAccuracy": 0.9, "trapRate": 0.05}, baseline) == []
    worse = cq.regressions({"clean": 0.6, "importanceAccuracy": 0.7, "trapRate": 0.3}, baseline)
    assert len(worse) == 3 and "clean fell from 90% to 60%" in worse[0]
