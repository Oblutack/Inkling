"""Dates and deadlines in a document: "rent is due on the first of each month", "notice by 28 February 2027", "the exam
is on 12 June".

A person wants these on a calendar, so a wrong one is worse than a missing one. The work is split to keep the model from
being trusted with anything a program can check:

- A program picks the sentences that can hold a date (a month name, a numeric date, "within 30 days", "each month", ...)
  and numbers them. The model is shown only those, and points at a sentence by its number. So the quote shown for a
  date is always the document's own words, never the model's copy of them.
- The model gives for each date what it is, the sentence it came from, the date as YYYY-MM-DD, whether it repeats, and,
  when the sentence gives no calendar date but a time after or before another event ("within 30 days of moving out"),
  that time in the document's words.
- A program then checks every date: it must be a real calendar date, and its day, month and year must really be in the
  sentence (as digits in any usual order, or with the month written out in any of the supported languages). A repeat
  must be said by the sentence ("each month", "monthly"). A sentence that reads like an instruction to an AI is never
  trusted.

What does not check out is still listed, marked as unconfirmed with the reason, so nothing is silently dropped; and a
sentence with a day and month but no year is listed for the person to complete, never guessed at.
"""

import re
from dataclasses import dataclass
from datetime import date
from typing import Any, Optional

from compare import split_units

MAX_ITEMS = 30
MAX_SENTENCES = 150
MAX_PROMPT_CHARS = 30_000
MAX_WHAT_CHARS = 120
MAX_RELATIVE_CHARS = 200
MAX_QUOTE_CHARS = 500
REPEATS = ("none", "weekly", "monthly", "yearly")
FIRST_YEAR, LAST_YEAR = 1950, 2200

# Month names by language, lower case, as they are written in dates (the form after a day number, and the plain one).
_MONTH_WORDS = {
    1: (
        "january jan januar jänner janvier enero gennaio janeiro januari styczeń stycznia ocak "
        "января январь siječnja siječanj sijecnja januara"
    ),
    2: (
        "february feb februar février fevrier febrero febbraio fevereiro februari luty lutego şubat subat "
        "февраля февраль veljače veljača veljace februara"
    ),
    3: "march mar märz maerz mars marzo março marco maart marzec marca mart марта март ožujka ožujak ozujka marta",
    4: "april apr avril abril aprile kwiecień kwietnia nisan апреля апрель travnja travanj aprila",
    5: "may mai mayo maggio maio mei maj maja mayıs mayis мая май svibnja svibanj",
    6: "june jun juni juin junio giugno junho czerwiec czerwca haziran июня июнь lipnja lipanj juna",
    7: "july jul juli juillet julio luglio julho lipiec lipca temmuz июля июль srpnja srpanj jula",
    8: (
        "august aug août aout agosto sierpień sierpnia ağustos agustos augustus августа август kolovoza kolovoz augusta"
    ),
    9: (
        "september sep sept septembre septiembre setiembre settembre setembro wrzesień września wrzesnia "
        "eylül eylul сентября сентябрь rujna rujan septembra"
    ),
    10: (
        "october oct oktober octobre octubre ottobre outubro październik października pazdziernika ekim "
        "октября октябрь listopada listopad oktobra"
    ),
    11: (
        "november nov novembre noviembre novembro listopad listopada kasım kasim ноября ноябрь "
        "studenoga studeni studenog novembra"
    ),
    12: (
        "december dec dezember décembre decembre diciembre dicembre dezembro grudnia grudzień aralık aralik "
        "декабря декабрь prosinca prosinac decembra"
    ),
}
MONTHS: dict[str, int] = {}
for _number, _words in _MONTH_WORDS.items():
    for _word in _words.split():
        MONTHS.setdefault(_word, _number)

_WORD = re.compile(r"[^\W\d_]+", re.UNICODE)
_NUMERIC_DATE = re.compile(r"(?<!\d)(\d{1,4})[./-](\d{1,2})[./-](\d{1,4})(?!\d)")
_CJK_DATE = re.compile(r"(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日")
_INTEGER = re.compile(r"(?<!\d)\d{1,4}(?!\d)")

# "day", "weeks", "mois", "Tagen": a stretch of time, in the languages Inkling writes in.
_UNITS = (
    "day days week weeks month months year years "
    "día días dia dias semana semanas mes meses año años "
    "tag tage tagen tagesfrist woche wochen monat monate monaten jahr jahre jahren "
    "jour jours semaine semaines mois an ans année années "
    "giorno giorni settimana settimane mese mesi anno anni "
    "dag dagen week weken maand maanden jaar "
    "dzień dni tydzień tygodnie miesiąc miesięcy rok lat lata "
    "gün hafta ay yıl "
    "день дня дней неделя недели месяц месяца месяцев год года лет "
    "dan dana sedmica sedmice mjesec mjeseca mjeseci godina godine godinu"
).split()
_UNIT_ALTERNATIVES = "|".join(sorted(set(_UNITS), key=len, reverse=True))
# a number and a unit: "30 days", "2 weeks"
_PERIOD = re.compile(rf"\d+\s*[- ]?\s*(?:{_UNIT_ALTERNATIVES})\b", re.IGNORECASE)
_UNIT_WORD = re.compile(rf"\b(?:{_UNIT_ALTERNATIVES})\b", re.IGNORECASE)

# Words that say something happens again and again.
_REPEAT_CUES = (
    "each", "every", "monthly", "weekly", "annual", "annually", "yearly", "per month", "per year", "per week",
    "a month", "a year", "cada", "mensual", "anual", "semanal", "por mes", "al mes", "jede", "jeden", "jedes",
    "monatlich", "jährlich", "wöchentlich", "pro monat", "chaque", "tous les", "toutes les", "mensuel", "annuel",
    "hebdomadaire", "par mois", "ogni", "mensile", "annuale", "settimanale", "mensal", "elke", "iedere",
    "maandelijks", "jaarlijks", "wekelijks", "każdy", "każdego", "co miesiąc", "miesięcznie", "rocznie", "aylık",
    "yıllık", "haftalık", "her ay", "каждый", "каждого", "ежемесячно", "ежегодно", "еженедельно", "svaki", "svakog",
    "mjesečno", "mesečno", "godišnje", "tjedno", "sedmično", "每", "毎",
)  # fmt: skip


@dataclass
class Candidate:
    """A sentence that can hold a date, as shown to the model (number = its place in the list)."""

    number: int
    text: str
    page: Optional[int]
    key: str


def month_numbers(text: str) -> set[int]:
    """The months a text names, by their written names."""
    return {MONTHS[w] for w in (m.lower() for m in _WORD.findall(text)) if w in MONTHS}


def says_it_repeats(quote: str) -> bool:
    lowered = quote.lower()
    return any(cue in lowered for cue in _REPEAT_CUES)


def can_hold_a_date(text: str) -> bool:
    """Whether a sentence has anything that looks like a date, a time after another event, or something that comes round
    again ("on the first day of each month", which has no digit in it)."""
    if _NUMERIC_DATE.search(text) or _CJK_DATE.search(text) or _PERIOD.search(text):
        return True
    if month_numbers(text) and _INTEGER.search(text):
        return True
    return says_it_repeats(text) and bool(_UNIT_WORD.search(text))


def date_sentences(text: str) -> list[Candidate]:
    """The sentences of a document that can hold a date, numbered, in document order (as many as the model is shown)."""
    picked: list[Candidate] = []
    size = 0
    for unit in split_units(text):
        if not can_hold_a_date(unit.text):
            continue
        if len(picked) >= MAX_SENTENCES or size + len(unit.text) > MAX_PROMPT_CHARS:
            break
        picked.append(Candidate(len(picked) + 1, unit.text[:MAX_QUOTE_CHARS], unit.page, unit.key))
        size += len(unit.text)
    return picked


def date_in_quote(day: date, quote: str) -> bool:
    """Whether a quote really says this date: its numbers, in an order people write dates in, or the month written out
    beside the day and the year."""
    year, month, dom = day.year, day.month, day.day
    for a, b, c in (tuple(int(x) for x in m.groups()) for m in _NUMERIC_DATE.finditer(quote)):
        if (a, b, c) in ((year, month, dom), (dom, month, year), (month, dom, year)):
            return True
    for m in _CJK_DATE.finditer(quote):
        if tuple(int(x) for x in m.groups()) == (year, month, dom):
            return True
    numbers = {int(x) for x in _INTEGER.findall(quote)}
    return month in month_numbers(quote) and dom in numbers and year in numbers


# ---- the prompt and the reading of its answer -------------------------------------------------------------------


def dates_prompt(name: str, sentences: list[Candidate], language: Optional[str]) -> str:
    numbered = "\n".join(f"[{s.number}] {s.text}" for s in sentences)
    if language:
        spoken = f"Write the WHAT lines in {language}."
    else:
        spoken = "Write the WHAT lines in the language of the sentences."
    title = f' "{name}"' if name.strip() else ""
    return f"""Below are numbered sentences from a document{title}. List every date and deadline they state: something
that happens or is due on a day, or a time after or before another event.
Use ONLY what a sentence says. Never work out a date, never add a year the sentence does not give, never combine
sentences. {spoken} Plain text only: no Markdown.

Reply in exactly this layout, one blank line between items, and nothing else:
WHAT: a short name for what happens or is due
SOURCE: the number of the sentence it comes from
DATE: the date as YYYY-MM-DD, or NONE when the sentence gives no complete calendar date (day, month and year)
REPEAT: none, weekly, monthly or yearly (not none only if the sentence says it happens again and again)
RELATIVE: for a time after or before another event ("within 30 days of moving out"), or for a date given without its
year, say it in the sentence's own words; otherwise NONE
If there is nothing to list, reply with the single word NONE.

SENTENCES
---
{numbered}
---"""


_KEY = re.compile(
    r"^\s*(?:[-*•]\s*)?[*_]*\s*(WHAT|SOURCE|DATE|REPEAT|RELATIVE)\s*[*_]*\s*[:：]\s*[*_]*\s*(.*?)[*_]*\s*$",
    re.IGNORECASE,
)


def _plain(text: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[*_`]+", "", text)).strip()


@dataclass
class RawItem:
    what: str
    source: int
    date: str
    repeat: str
    relative: str


def parse_dates(reply: str) -> Optional[list[RawItem]]:
    """The items in a reply: [] when it says there is nothing, None when it cannot be read at all."""
    blocks: list[dict[str, str]] = []
    current: dict[str, str] = {}
    for line in reply.splitlines():
        if not line.strip():
            if current:
                blocks.append(current)
                current = {}
            continue
        m = _KEY.match(line)
        if m:
            key = m.group(1).upper()
            if key == "WHAT" and "WHAT" in current:  # a new item without a blank line before it
                blocks.append(current)
                current = {}
            current[key] = m.group(2).strip()
    if current:
        blocks.append(current)

    items: list[RawItem] = []
    for block in blocks:
        source = re.search(r"\d+", block.get("SOURCE", ""))
        if "WHAT" not in block or not source:
            continue
        repeat = block.get("REPEAT", "none").strip().lower().rstrip(".")
        items.append(
            RawItem(
                what=_plain(block["WHAT"])[:MAX_WHAT_CHARS],
                source=int(source.group()),
                date=_plain(block.get("DATE", "NONE")).rstrip("."),
                repeat=repeat if repeat in REPEATS else "none",
                relative=_plain(block.get("RELATIVE", "NONE"))[:MAX_RELATIVE_CHARS],
            )
        )
    if items:
        return items
    stripped = _plain(reply).strip(". ").lower()
    return [] if stripped in ("none", "nothing", "no dates", "") else None


def _is_none(value: str) -> bool:
    return value.strip(" .").lower() in ("", "none", "n/a", "na", "-", "—", "unknown")


# ---- checking what the model said ------------------------------------------------------------------------------


def assemble(
    items: list[RawItem], sentences: list[Candidate], suspect: Optional[list[str]] = None
) -> list[dict[str, Any]]:
    """The dates, each with its quote (the document's own sentence), its page, and whether it checks out and, if not,
    why."""
    by_number = {s.number: s for s in sentences}
    results: list[dict[str, Any]] = []
    seen: set[tuple[str, str, str]] = set()
    for item in items:
        sentence = by_number.get(item.source)
        if sentence is None or not item.what:
            continue
        day: Optional[date] = None
        reason = ""
        if not _is_none(item.date):
            try:
                day = date.fromisoformat(item.date)
            except ValueError:
                reason = "The date is not a real calendar date."
        relative = "" if _is_none(item.relative) else item.relative
        if day is None and not relative:
            continue  # nothing to put on a calendar, and nothing to say about when

        verified = True
        if any(sentence.key in s for s in suspect or []):
            verified, reason = False, "This sentence reads like an instruction to an AI, so it is not trusted."
        elif reason:
            verified = False
        elif day is not None:
            if not FIRST_YEAR <= day.year <= LAST_YEAR:
                verified, reason = False, "The year is outside the years Inkling handles."
            elif not date_in_quote(day, sentence.text):
                verified = False
                reason = "The date is not in the sentence (its day, month and year could not all be found there)."
        repeat = item.repeat
        if repeat != "none" and not says_it_repeats(sentence.text):
            repeat = "none"
            reason = reason or "The sentence does not say it repeats, so it is listed once."

        marker = (day.isoformat() if day else "", item.what.lower(), relative.lower())
        if marker in seen:
            continue
        seen.add(marker)
        results.append(
            {
                "what": item.what,
                "date": day.isoformat() if day else None,
                "repeat": repeat,
                "relative": relative,
                "quote": sentence.text,
                "page": sentence.page,
                "verified": verified,
                "reason": reason,
            }
        )
    # dated ones first, soonest first; the ones that wait for a date after them
    results.sort(key=lambda r: (r["date"] is None, r["date"] or "", r["what"].lower()))
    return results[:MAX_ITEMS]
