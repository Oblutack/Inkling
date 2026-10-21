"""Prompt construction for summaries and document chat."""

# Bump when prompt wording changes so cached summaries made with the old wording are not reused.
PROMPT_VERSION = "3"

DEFAULT_STYLE = "default"
DEFAULT_LANGUAGE = "English"

STYLE_INSTRUCTIONS = {
    "default": ("Use headings, bullet points, and bold text where appropriate to structure the key information."),
    "bullets": (
        "Write only concise bullet points, one sentence each, grouped under short headings. Do not write paragraphs."
    ),
    "brief": (
        "Write an executive brief with these sections: '## Overview' (2-3 sentences), "
        "'## Key Points' (bullets), and '## Implications' (bullets). Keep the tone professional."
    ),
    "simple": (
        "Explain it in plain language a curious 12-year-old could follow: short sentences, "
        "everyday words, no jargon (explain any unavoidable term briefly)."
    ),
    "glance": (
        "Write one plain paragraph of two or three sentences that says what this is and what matters most. "
        "No headings, no bullet points, no bold text, no lists."
    ),
    "takeaways": (
        "Write '## Key Takeaways' as a numbered list, then '## Action Items' as a bullet list "
        "of concrete next steps. If the text has no action items, write 'None'."
    ),
}

LANGUAGES = [
    "English",
    "Spanish",
    "French",
    "German",
    "Italian",
    "Portuguese",
    "Dutch",
    "Polish",
    "Turkish",
    "Russian",
    "Serbian",
    "Croatian",
    "Bosnian",
    "Chinese",
    "Japanese",
]


def is_valid_style(style: str) -> bool:
    return style in STYLE_INSTRUCTIONS


# Not a language to translate into: the output follows the text it is made from. Used when a document is read for
# study and the person has not chosen a language.
SAME_LANGUAGE = "Same as the text"


def is_valid_language(language: str) -> bool:
    return language in LANGUAGES or language == SAME_LANGUAGE


def _language_line(language: str) -> str:
    if language == SAME_LANGUAGE:
        return "\n        Write the entire output in the language the text is written in. Never translate it."
    # Always said, English included: without it a summary of a Spanish text came back in Spanish.
    return f"\n        Write the entire output in {language}, whatever language the text is written in."


# What every summary must hold to. Each rule answers a mistake the summary-quality check (evals/summary) found.
FAITHFULNESS_RULES = (
    "\n        Rules for the content: use only what the text says. Do not add figures, dates, names, currencies or "
    "units that the text does not give, and do not work out figures of your own (no totals, percentages, end "
    "dates or splits of a number). Keep every figure with exactly what the text attaches it to. A figure the text "
    "gives without a currency is written without one. Keep comparisons as the text words them: “compared with "
    "the previous quarter” never becomes “year on year”, and YoY or QoQ are not used unless the text uses them. "
    "When the text gives a start date and a length of time, write both as given and do not write the date it ends. "
    "Prefer the names, dates and figures that matter over general remarks, in every style, plain language included. "
    "Never mention these rules, the word count or the length of the summary, and add no note about your own output."
)


MAX_INSTRUCTIONS_CHARS = 500


def _instructions_block(instructions: str) -> str:
    """The reader's own standing preferences. They adjust tone and focus; they never replace the format."""
    instructions = " ".join(instructions.split())
    if not instructions:
        return ""
    return (
        "\n        The reader has these standing preferences for every summary. Follow them where they do not "
        f"conflict with the Markdown format and style above: {instructions}"
    )


def summary_prompt(
    material: str,
    target_words: int,
    style: str,
    language: str,
    kind: str = "text",
    instructions: str = "",
    subject: str = "",
) -> str:
    """Builds the final summarization prompt.

    kind: "text" for raw text, "summaries" for already-condensed chunk summaries,
    "documents" for several labelled documents that must be summarized together,
    "collection" for the summaries of the documents of one collection (named `subject`), written as a briefing.
    """
    if kind == "summaries":
        task = (
            "Condense and combine the following summaries into a single, well-structured text "
            f"of about {target_words} words."
        )
    elif kind == "documents":
        task = (
            f"Write one combined summary of about {target_words} words covering all of the documents below. "
            "Mention the document names when a point comes from a specific one, and call out notable "
            "overlaps or differences between them."
        )
    elif kind == "collection":
        called = f" called \u201c{subject}\u201d" if subject else ""
        task = (
            f"Below are the summaries of the documents in a collection{called}. Write a briefing of about "
            f"{target_words} words on the collection as a whole: what it is about, the main points that come up "
            "in several documents, where the documents agree, where they differ or contradict each other, and "
            "anything only one document mentions. Name the documents behind every point, and call something "
            "shared only when each document you name says it. If the summaries do not clearly agree or differ "
            "on a matter, leave it out rather than guessing. Keep every number with the document and the period "
            "it belongs to. Use only what the summaries say; do not add facts that are not in them, and do not "
            "use tables."
        )
    else:
        task = f"Provide a summary of the following text in about {target_words} words."

    return f"""{task}
        **Format the entire output strictly as Markdown.**
        {STYLE_INSTRUCTIONS[style]}{_language_line(language)}{FAITHFULNESS_RULES}{_instructions_block(instructions)}

        ---

        {material}"""


def describe_passage(passage) -> str:
    """The heading of a numbered excerpt, e.g. "[2] (page 4 of report.pdf)"."""
    where = []
    if passage.page is not None:
        if passage.page_end is not None and passage.page_end != passage.page:
            where.append(f"pages {passage.page}-{passage.page_end}")
        else:
            where.append(f"page {passage.page}")
    if passage.document:
        where.append(passage.document)
    return f"[{passage.id}]" + (f" ({' of '.join(where)})" if where else "")


def chat_prompt(passages: list, history: list[dict], question: str, library: bool = False) -> str:
    turns = "\n".join(f"{'User' if m['role'] == 'user' else 'Assistant'}: {m['content']}" for m in history)
    history_block = f"Conversation so far:\n{turns}\n\n" if turns else ""
    excerpts = "\n\n".join(f"{describe_passage(p)}\n{p.text}" for p in passages)
    subject = (
        "the user's saved documents. The excerpts come from different documents; each heading names its document"
        if library
        else "a document"
    )
    return f"""You answer questions about {subject}. Use only the numbered excerpts below.
If the answer is not in the excerpts, say you could not find it in the document; do not guess, and do not cite.
Cite your sources: right after each statement taken from an excerpt, put that excerpt's number in square
brackets, like [2], or [1][3] when several excerpts support it. Cite only excerpts you actually used. Never
invent numbers and never use square brackets for anything else.
Answer in the language of the user's latest question (not the document's language or an earlier answer's),
be concise, and format with Markdown when helpful.

Document excerpts:
---
{excerpts}
---

{history_block}User: {question}
Assistant:"""
