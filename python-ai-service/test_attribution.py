import pytest

from attribution import NONE, STRONG, WEAK, check_summary, numbers, stem, summary_units, terms
from retrieval import PAGE_BREAK

SOURCE = PAGE_BREAK.join(
    [
        "Atlas X200 is an oil-free rotary screw compressor designed for workshops and small factories.",
        "The compressor unit is covered by a warranty of seven years from the date of purchase. "
        "The electric motor is covered for three years. Consumable parts such as filters and belts are not covered.",
        "Replace the air filter every 90 days or after 500 operating hours, whichever comes first. "
        "Drain the condensate tank weekly. The 1,200 hour service needs a technician.",
    ]
)


def sentence(result, fragment):
    return next(s for s in result["sentences"] if fragment in s["text"])


# ---- reading the summary ---------------------------------------------------------------------


def test_markdown_is_stripped_and_sentences_are_split():
    units = summary_units(
        "# Atlas Summary\n\n**Warranty**\n- The unit has **seven** years of cover. The motor has three.\n"
        "- See [the manual](http://x.test) for more.\n\n| a | b |\n|---|---|\n"
    )
    assert [(u.kind, u.text) for u in units][:5] == [
        ("heading", "Atlas Summary"),
        ("heading", "Warranty"),
        ("claim", "The unit has seven years of cover."),
        ("claim", "The motor has three."),
        ("claim", "See the manual for more."),
    ]


def test_short_labels_are_headings_but_short_facts_are_not():
    kinds = {u.text: u.kind for u in summary_units("Key Points\nImplications:\nProfits rose 5%.\nIt works well.")}
    assert kinds["Key Points"] == "heading" and kinds["Implications"] == "heading"
    assert kinds["Profits rose 5%."] == "claim" and kinds["It works well."] == "claim"


def test_a_label_with_its_value_is_a_statement_not_a_heading():
    summary = "- **Parties**\n  - Tenant: Jordan Ellis  \n  - Landlord: Harbour Lane Properties Ltd"
    kinds = {u.text: u.kind for u in summary_units(summary)}
    assert kinds == {
        "Parties": "heading",
        "Tenant: Jordan Ellis": "claim",
        "Landlord: Harbour Lane Properties Ltd": "claim",
    }


def test_abbreviations_do_not_split_sentences():
    (unit,) = summary_units("Parts, e.g. filters and belts, wear out. ")
    assert unit.text == "Parts, e.g. filters and belts, wear out."


def test_terms_ignore_common_words_and_light_stemming_joins_forms():
    assert terms("The filters are covered by the warranty") == {"filter", "cover", "warranty"}
    assert stem("filters") == "filter" and stem("covered") == "cover" and stem("gas") == "gas"


def test_numbers_are_compared_in_one_form():
    # Digits come first (thousands separators removed), then number words as digits.
    assert numbers("About 1,200 units and 3.5 million, seven of them, ten more") == [
        "1200",
        "3.5",
        "1000000",
        "7",
        "10",
    ]


# ---- checking against the document ------------------------------------------------------------


def test_faithful_sentences_are_found_with_their_page():
    result = check_summary("The air filter should be replaced every 90 days.", SOURCE)
    s = sentence(result, "air filter")
    assert s["support"] == STRONG and s["missingNumbers"] == []
    top = s["passages"][0]
    assert top["page"] == 3 and top["pageEnd"] == 3 and "90 days" in top["text"]


def test_a_paraphrase_with_matching_numbers_is_found():
    result = check_summary("The compressor has a seven-year warranty from the purchase date.", SOURCE)
    s = sentence(result, "warranty")
    assert s["support"] in (STRONG, WEAK) and s["passages"][0]["page"] == 2


def test_a_wrong_number_is_never_marked_as_found():
    result = check_summary("The electric motor is covered for ten years.", SOURCE)
    s = sentence(result, "motor")
    assert s["support"] != STRONG
    assert s["missingNumbers"] == ["10"]


def test_digits_and_number_words_agree():
    result = check_summary("The unit is covered by a warranty of 7 years from purchase.", SOURCE)
    assert sentence(result, "warranty")["missingNumbers"] == []


def test_thousands_separators_do_not_matter():
    result = check_summary("The 1200 hour service needs a technician.", SOURCE)
    s = sentence(result, "service")
    assert s["support"] == STRONG and s["missingNumbers"] == []


def test_a_claim_with_nothing_behind_it_is_not_found():
    result = check_summary("The compressor won an industry award in 1987 for its quiet design.", SOURCE)
    s = sentence(result, "award")
    assert s["support"] == NONE
    assert "1987" in s["missingNumbers"]


def test_headings_are_not_judged():
    result = check_summary("# Warranty\n\nThe motor is covered for three years.", SOURCE)
    heading = sentence(result, "Warranty")
    assert heading["kind"] == "heading" and heading["support"] is None and heading["passages"] == []


def test_the_counts_add_up():
    summary = (
        "The air filter should be replaced every 90 days.\n"
        "The motor is covered for ten years.\n"
        "The compressor won an industry award in 1987 for its quiet design."
    )
    result = check_summary(summary, SOURCE)
    assert result["claims"] == 3
    assert result["found"] + result["partly"] + result["notFound"] == 3
    assert result["found"] >= 1 and result["notFound"] >= 1
    assert result["verifiable"] is True


def test_a_summary_in_another_language_is_reported_as_not_verifiable():
    spanish = (
        "El filtro de aire debe reemplazarse cada días.\n"
        "La garantía cubre la unidad durante varios años.\n"
        "El motor tiene una cobertura más corta que el compresor.\n"
        "Las piezas consumibles quedan excluidas del servicio."
    )
    result = check_summary(spanish, SOURCE)
    assert result["claims"] == 4
    assert result["verifiable"] is False


def test_multi_file_documents_name_the_file():
    text = (
        "=== a.pdf ===\nAlpha facts about turbines and blades.\n\n"
        "=== b.pdf ===\nBeta facts about solar panels and inverters."
    )
    result = check_summary("Solar panels need inverters.", text)
    top = sentence(result, "Solar")["passages"][0]
    assert top["document"] == "b.pdf"


def test_pasted_text_has_no_pages_but_still_checks():
    result = check_summary("Prices fell sharply last quarter.", "Prices fell sharply last quarter across the region.")
    s = sentence(result, "Prices")
    assert s["support"] == STRONG
    assert s["passages"][0]["page"] is None


def test_an_empty_summary_checks_nothing():
    result = check_summary("", SOURCE)
    assert result["sentences"] == [] and result["claims"] == 0 and result["verifiable"] is True


@pytest.mark.parametrize("junk", ["---", "|---|---|", "   ", "***"])
def test_dividers_and_blank_lines_are_ignored(junk):
    assert summary_units(junk) == []


def test_a_long_document_is_checked_quickly():
    import time

    text = " ".join(f"Section {i} discusses topic{i} and the subject{i % 40} in detail." * 3 for i in range(3000))
    summary = "\n".join(f"- Topic{i * 7} and subject{i} are discussed in detail." for i in range(40))
    started = time.perf_counter()
    result = check_summary(summary, text)
    assert time.perf_counter() - started < 6
    assert result["claims"] == 40


def test_a_number_that_exists_elsewhere_in_the_document_is_a_softer_flag():
    # Seven years is the compressor's warranty (page 2), but the motor sentence's wording matches the
    # motor's own passage, where the figure is three.
    result = check_summary("The electric motor is covered for seven years.", SOURCE)
    s = sentence(result, "motor")
    assert s["support"] == WEAK, "good wording with a misplaced number is never 'found'"
    assert s["missingNumbers"] == [] and s["elsewhereNumbers"] == ["7"]


def test_a_sentence_combining_facts_from_different_pages_is_not_accused_of_inventing_numbers():
    # Both figures are in the document, on different pages: the real-world false alarm.
    result = check_summary("Follow the schedule to keep the 7-year warranty and the 500 hour filter interval.", SOURCE)
    s = sentence(result, "schedule")
    assert s["missingNumbers"] == []


def test_a_figure_the_document_never_mentions_is_the_hard_flag():
    result = check_summary("The warranty covers the unit for twelve years from purchase.", SOURCE)
    s = sentence(result, "warranty")
    assert s["missingNumbers"] == ["12"] and s["support"] != STRONG


def test_quoted_lines_lose_their_marker():
    (unit,) = summary_units("> **Key takeaway:** change the filter every 90 days.")
    assert unit.text == "Key takeaway: change the filter every 90 days."


def test_a_sentence_combining_two_source_sentences_may_use_the_numbers_of_both():
    # 7 is the unit's figure and 3 the motor's: two sentences of the source, one of the summary.
    result = check_summary("Warranty: 7 years for the unit, 3 years for the motor; consumables excluded.", SOURCE)
    s = sentence(result, "Warranty")
    assert s["missingNumbers"] == [] and s["elsewhereNumbers"] == []
    assert s["support"] in (STRONG, WEAK)


def test_a_figure_swapped_between_two_neighbouring_facts_is_still_caught():
    result = check_summary("The electric motor is covered for seven years.", SOURCE)
    assert sentence(result, "motor")["elsewhereNumbers"] == ["7"]
    result = check_summary("The compressor unit is covered by a warranty of three years.", SOURCE)
    assert sentence(result, "compressor")["elsewhereNumbers"] == ["3"]
