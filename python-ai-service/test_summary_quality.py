import os
import re
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "evals", "summary"))

import cases as corpus  # noqa: E402

import summary_quality as sq  # noqa: E402


def score(case, summary, variant=None, **kw):
    variant = variant or case.variants[0]
    return sq.score_summary(
        summary,
        case.text,
        case.facts,
        case.traps,
        style=kw.pop("style", "default"),
        language=kw.pop("language", variant.language),
        target_words=variant.word_count,
        allowed_numbers=case.allowed_numbers,
    )


def by_id(case_id):
    return next(c for c in corpus.CASES if c.id == case_id)


# --- the corpus itself ---


@pytest.mark.parametrize("case", corpus.CASES, ids=lambda c: c.id)
def test_the_reference_summary_of_every_case_scores_clean(case):
    result = score(case, case.reference, language="English")
    assert result.clean, result.as_dict()
    assert result.recall == 1.0, result.facts_missed
    assert not result.traps_hit and not result.invented_numbers and not result.format_problems


@pytest.mark.parametrize("case", corpus.CASES, ids=lambda c: c.id)
def test_every_pattern_in_the_corpus_is_a_valid_pattern(case):
    for fact in case.facts:
        assert fact.patterns and all(re.compile(p, re.I) for p in fact.patterns), fact.name
    for trap in case.traps:
        assert re.compile(trap.pattern, re.I), trap.name


def test_the_corpus_is_what_it_claims_to_be():
    assert len({c.id for c in corpus.CASES}) == len(corpus.CASES)
    assert len(corpus.LONG) > 24_000, "the long report must need several passes through the model"
    for case in corpus.CASES:
        assert case.variants and case.facts, case.id
        assert case.kind in ("single", "multi", "overview")
        assert (len(case.docs) > 1) == (case.kind != "single"), case.id


# --- facts ---


def test_a_summary_that_drops_the_figures_has_low_recall():
    case = by_id("lease")
    result = score(case, "## Lease\n- A landlord rents out an apartment to a tenant for a year.")
    assert result.recall < 0.4 and not result.clean
    assert "rent 950" in result.facts_missed


def test_facts_are_found_whatever_the_wording_markdown_or_spacing():
    case = by_id("deck")
    summary = "Revenue **grew 12%**, reaching 4.1 million; support tickets fell by a third."
    result = score(case, summary)
    assert {"revenue up 12%", "4.1 million", "tickets down a third"} <= set(result.facts_hit)


def test_in_another_language_only_language_neutral_facts_are_judged():
    case = by_id("lease")
    result = score(
        case,
        "## Contrato\n- La renta es de 950 euros y la fianza de 1.900 euros; Marta Kovač y Daniel Reyes.",
        language="Spanish",
    )
    assert "three months' notice" not in result.facts_missed + result.facts_hit
    assert {"rent 950", "landlord Marta Kovač", "tenant Daniel Reyes"} <= set(result.facts_hit)


# --- traps ---


def test_the_traps_that_were_really_seen_are_caught():
    deck = score(by_id("deck"), "Revenue grew 12% to $4.1 million.")
    assert deck.traps_hit == ["invents a currency"]
    assert not score(by_id("deck"), "Revenue grew 12% to 4.1 million (the currency is not stated).").traps_hit

    q2 = score(by_id("northwind_q2"), "Revenue was 4.4 million euros, up 10% year over year.")
    assert "year on year" in q2.traps_hit
    assert not score(by_id("northwind_q2"), "Revenue was 4.4 million euros, up 10% on the previous quarter.").traps_hit

    warranty = score(by_id("warranty"), "The warranty covers water damage for seven years.")
    assert "water damage presented as covered" in warranty.traps_hit
    assert not score(by_id("warranty"), "The warranty does not cover water damage.").traps_hit


def test_a_figure_moved_to_the_wrong_thing_is_caught():
    assert (
        "rent and deposit swapped"
        in score(by_id("lease"), "The rent is 1,900 euros and the deposit is 950 euros.").traps_hit
    )
    assert (
        "March figure given to another month"
        in score(by_id("finance"), "February revenue peaked at 5,200 while March was 4,100.").traps_hit
    )
    assert "action given to the wrong person" in score(by_id("meeting"), "Priya will book the venue.").traps_hit
    swapped = score(by_id("multi"), "The invoice from Harbour Print asks for 650 euros a month.")
    assert "invoice and cleaning fee swapped" in swapped.traps_hit


def test_an_overview_that_credits_a_risk_to_every_document_is_caught():
    result = score(by_id("overview"), "All three reports name customer concentration as the main risk.")
    assert "a shared risk that is not shared" in result.traps_hit


# --- numbers ---


def test_a_number_that_is_not_in_the_document_is_found():
    case = by_id("lease")
    result = score(case, "## Lease\n- The rent is 950 euros per month and the penalty for late payment is 75 euros.")
    assert result.invented_numbers == ["75"]
    assert not result.clean


def test_numbers_of_the_document_and_allowed_numbers_pass():
    case = by_id("lease")
    assert score(case, "- Rent is 950 euros; the deposit is 1,900 euros, back within 30 days.").invented_numbers == []
    assert score(by_id("cpp"), "- The array of 5 integers is released with delete[].").invented_numbers == []


def test_wording_about_the_request_is_not_an_invented_number():
    summary = "**Q3 summary (about 70 words)**\n- Revenue: 4.1 million, down 7%."
    result = score(by_id("deck"), summary)
    assert "70" not in result.invented_numbers
    assert "mentions its own word count" in result.format_problems


# --- format ---


def test_format_problems_by_style():
    case = by_id("lease")
    prose = "The tenant pays rent every month and the landlord keeps a deposit that is returned when the lease ends, so both sides know what to expect."  # noqa: E501
    assert "not bullet points only" in score(case, "## Lease\n" + prose, style="bullets").format_problems
    assert not score(case, "## Lease\n- Rent is 950.\n- Deposit is 1,900.", style="bullets").format_problems

    assert (
        "missing section: implications"
        in score(case, "## Overview\nx\n## Key Points\n- y", style="brief").format_problems
    )
    assert not score(case, "## Overview\nx\n## Key Points\n- y\n## Implications\n- z", style="brief").format_problems

    meeting = by_id("meeting")
    assert (
        "missing section: action items" in score(meeting, "## Key Takeaways\n1. a", style="takeaways").format_problems
    )
    assert not score(meeting, meeting.reference, style="takeaways").format_problems


def test_things_no_summary_should_contain():
    case = by_id("cpp")
    assert "underlines a heading with ====" in score(case, "# Dynamic arrays\n=====\n- x").format_problems
    assert "starts with a preamble" in score(case, "Sure! Here is the summary:\n- x").format_problems
    assert "wrapped in a code fence" in score(case, "```markdown\n- x\n```").format_problems
    assert "empty" in score(case, "   ").format_problems
    assert (
        "no structure (no heading, bullet or bold)"
        in score(case, "Plain words only, with nothing to show where one idea ends.").format_problems
    )


# --- language ---


@pytest.mark.parametrize(
    "text, expected",
    [
        (
            "The company said that revenue was up and that the team has grown to more than forty people this year.",
            "English",
        ),
        (
            "La empresa dijo que los ingresos han subido y que el equipo ha crecido hasta más de cuarenta personas en el año.",  # noqa: E501
            "Spanish",
        ),
        (
            "Das Unternehmen sagte, dass der Umsatz gestiegen ist und dass das Team in diesem Jahr auf mehr als vierzig Personen gewachsen ist.",  # noqa: E501
            "German",
        ),
        (
            "L'entreprise a dit que le chiffre d'affaires a augmenté et que l'équipe est passée à plus de quarante personnes cette année.",  # noqa: E501
            "French",
        ),
    ],
)
def test_the_language_of_a_summary_is_recognised(text, expected):
    assert sq.detect_language(text) == expected


def test_a_summary_in_the_wrong_language_is_not_clean():
    case = by_id("lease")
    spanish = "## Contrato\n- La renta es de 950 euros al mes y la fianza de 1.900 euros se devuelve en 30 días después de que termine el contrato de alquiler."  # noqa: E501
    result = score(case, spanish, language="English")
    assert result.language == "Spanish" and result.language_ok is False and not result.clean
    assert score(case, spanish, language="Spanish").language_ok is True
    assert score(case, "## Lease\n- 950", language="Japanese").language_ok is None
    assert sq.detect_language("Too short.") is None


# --- length ---


def test_length_is_reported_but_is_not_a_failure():
    case = by_id("lease")
    long_summary = "## Lease\n" + "- " + "word " * 600 + "\n"
    result = score(case, long_summary)
    assert not result.length_ok and result.length_ratio > 3
    assert "length" not in "".join(result.format_problems)
    short = score(case, "- Rent 950.")
    assert not short.length_ok


# --- many runs ---


def test_the_rates_over_several_runs():
    case = by_id("lease")
    good = score(case, case.reference)
    bad = score(case, "- Rent is 1,900 euros and the deposit is 950 euros, plus a $50 fee.")
    summary = sq.aggregate([good, good, good, bad])
    assert summary["runs"] == 4 and summary["clean"] == 0.75
    assert summary["trapRate"] == 0.25 and 0 < summary["recall"] < 1
    assert sq.aggregate([]) == {"runs": 0}


def test_a_regression_against_a_baseline_is_named():
    baseline = {
        "clean": 0.9,
        "recall": 0.95,
        "trapRate": 0.02,
        "inventedNumberRate": 0.05,
        "formatProblemRate": 0.0,
        "languageOk": 1.0,
        "lengthOk": 0.8,
    }
    worse = {**baseline, "clean": 0.6, "trapRate": 0.3}
    messages = sq.regressions(worse, baseline)
    assert any("clean fell from 90% to 60%" in m for m in messages) and any("trapRate rose" in m for m in messages)
    assert sq.regressions(baseline, baseline) == []
    assert sq.regressions({**baseline, "clean": 0.85}, baseline) == [], "a small wobble is within tolerance"
    assert sq.regressions({"clean": None}, baseline) == []


def test_a_space_as_the_thousands_separator_is_one_number():
    case = by_id("lease")
    spanish = "- La fianza es de 1 900 \u20ac y la renta de 950 \u20ac al mes, con Marta Kova\u010d y Daniel Reyes."
    assert score(case, spanish, language="Spanish").invented_numbers == []
    assert score(case, "- The deposit is 1\u202f900 euros.").invented_numbers == []
    # but a figure that really is not there is still found
    assert score(case, "- The deposit is 2 900 euros.").invented_numbers == ["2900"]


def test_short_telegraphic_bullets_still_have_a_language():
    bullets = "**Key Terms**\n- Landlord: Marta Kovac\n- Rent: 950/month\n- Deposit: 1,900, returned within 30 days of the end"  # noqa: E501
    assert sq.detect_language(bullets + "\n- Pets: only with the written permission of the landlord") == "English"
    assert sq.detect_language("Numbers 1 2 3 4 5 6 7 8 9 10 11 12 13 14") is None


def test_a_correct_overrun_is_not_a_swapped_figure():
    news = by_id("news")
    correct = "- Total cost: 38 million euros.\n- Budget overrun: 9 million euros above the original budget."
    assert "cost and overrun swapped" not in score(news, correct).traps_hit
    assert "cost and overrun swapped" in score(news, "- The total cost was 9 million euros.").traps_hit
    assert "cost and overrun swapped" in score(news, "- The overrun was 38 million euros.").traps_hit


def test_a_figure_under_its_month_on_the_next_line_is_found():
    finance = by_id("finance")
    layout = "**March**\n- Revenue: **5,200**\n- Costs: **3,900**\n- Profit: **1,300**"
    result = score(finance, layout)
    assert {"March revenue 5,200", "March profit 1,300"} <= set(result.facts_hit)


def test_year_on_year_is_right_for_q1_of_the_overview_and_wrong_for_q2_and_q3():
    overview = by_id("overview")
    assert "year on year" not in score(overview, "- Q1: 4.0 million euros, +5% YoY.\n- Q2: +10% QoQ.").traps_hit
    assert "year on year" in score(overview, "- Q2: 4.4 million euros, +10% YoY.").traps_hit
    assert "year on year" in score(overview, "- Q3: down 7% year over year.").traps_hit


def test_a_list_of_people_is_not_a_wrong_assignment_but_a_swapped_action_is():
    meeting = by_id("meeting")
    harmless = "Priya Nair, Tom Becker and Aisha Khan have deadlines for the budget, the venue and the bug fixes."
    assert "action given to the wrong person" not in score(meeting, harmless).traps_hit
    for wrong in ("Priya will book the venue.", "Aisha Khan: send the revised budget.", "Tom Becker to fix the bugs."):
        assert "action given to the wrong person" in score(meeting, wrong).traps_hit, wrong
    right = "Priya Nair will send the budget; Tom Becker will book the venue; Aisha Khan will fix the bugs."
    assert "action given to the wrong person" not in score(meeting, right).traps_hit


def test_a_per_quarter_list_of_risks_is_not_a_shared_risk():
    overview = by_id("overview")
    right = (
        "Each report lists a main risk: cloud provider (Q1), infrastructure costs (Q2), customer concentration (Q3)."
    )
    assert "a shared risk that is not shared" not in score(overview, right).traps_hit
    for wrong in (
        "All three reports name customer concentration as the main risk.",
        "Every report identifies the same cloud provider dependence.",
        "All documents highlight infrastructure costs.",
    ):
        assert "a shared risk that is not shared" in score(overview, wrong).traps_hit, wrong


def test_a_glance_is_one_plain_paragraph():
    from summary_quality import format_problems

    assert (
        format_problems("This is a lease for a flat. Rent is 950 euros a month and notice is 60 days.", "glance") == []
    )
    for text in ("## Overview\nA lease.", "- Rent is 950 euros.\n- Notice is 60 days.", "A lease with **bold** rent."):
        assert "not one plain paragraph" in format_problems(text, "glance"), text


def test_the_glance_style_is_asked_for_in_plain_words():
    import prompts

    assert prompts.is_valid_style("glance")
    assert "two or three sentences" in prompts.STYLE_INSTRUCTIONS["glance"]
