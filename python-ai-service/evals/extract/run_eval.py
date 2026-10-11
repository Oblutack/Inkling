"""Measures how well the service extracts named fields from documents, with the real model.

It extracts fields from made-up documents whose contents are known (extract_cases.py) several times each, exactly the way the
service does (the same code, the same prompt, the same verification), and scores every answer (extraction_quality.py): is each
value what the document says, did the program verify it, did a field the document does not state come back empty (or did a
value get invented, such as a total the model added up), and did the model obey a note hidden in a document. The failures that
matter are the ones that look trustworthy: a wrong value that was verified, an invented value that was verified, and a value
that was taken from a hidden note. The headline number is the share of "clean" runs.

Use it before and after changing the extraction prompt, the verification, the model or its settings. It calls the model, so it
needs GROQ_API_KEY (read from the project's .env) and counts every call against that key: it prints how many it is about to
make and refuses more than --max-calls (60) unless you add --yes. Run it from python-ai-service/ :

    python evals/extract/run_eval.py                       # every case, 2 runs each: about 18 model calls
    python evals/extract/run_eval.py --samples 3 --label prompt-v2
    python evals/extract/run_eval.py --cases invoice,steering
    python evals/extract/run_eval.py --failures            # also print what came back when a run was not clean
    python evals/extract/run_eval.py --save-baseline       # keep this run as the reference
    python evals/extract/run_eval.py --baseline evals/extract/baseline.json    # fail if it got worse
    python evals/extract/run_eval.py --rescore results/a.json    # score saved answers again; no model call
"""

import asyncio
import json
import os
import sys
import time
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path[:0] = [os.path.join(HERE, "..")]
import common  # noqa: E402

common.prepare(HERE)

import extract_cases as corpus  # noqa: E402
import extraction_quality as eq  # noqa: E402
import main  # noqa: E402

RESULTS = os.path.join(HERE, "results")
BASELINE = os.path.join(HERE, "baseline.json")


async def extract(case):
    """One extraction of a case, made the way the service makes it (the endpoint's own function)."""
    fields = [main.FieldIn(name=a.name, description=a.description, type=a.type) for a in case.asked]
    answer = await main.extract_fields(main.ExtractPayload(name=case.name, text=case.text, fields=fields))
    return answer["fields"]


async def run_one(semaphore, case, sample):
    async with semaphore:
        started = time.monotonic()
        try:
            fields = await extract(case)
        except Exception as exc:  # a failed call is reported, and left out of the rates
            return {"case": case.id, "sample": sample, "error": f"{type(exc).__name__}: {exc}"[:300]}
        score = eq.score_extraction(fields, case.asked, case.forbidden)
        return {
            "case": case.id,
            "sample": sample,
            "seconds": round(time.monotonic() - started, 1),
            "fields": fields,
            "score": score.as_dict(),
            "_score": score,
        }


async def run(selected, samples, concurrency):
    semaphore = asyncio.Semaphore(concurrency)
    return await asyncio.gather(*(run_one(semaphore, case, n) for case in selected for n in range(1, samples + 1)))


def settings() -> dict:
    import llm

    return {
        "model": main.active_model(),
        "reasoningEffort": os.getenv("LLM_REASONING_EFFORT", "low"),
        "temperature": "provider default" if llm.TEMPERATURE in ("", "default") else llm.TEMPERATURE,
    }


def summarize_results(results) -> dict:
    good = [r for r in results if "score" in r]
    by_case = defaultdict(list)
    for r in good:
        by_case[r["case"]].append(r["_score"])
    return {
        "overall": eq.aggregate([r["_score"] for r in good]),
        "cases": {k: eq.aggregate(v) for k, v in by_case.items()},
        "errors": [r for r in results if "error" in r],
    }


def table(rows: dict, title: str) -> str:
    head = f"{title:<12} {'runs':>4} {'clean':>6} {'accuracy':>9} {'verified':>9} {'wrong+ok':>9} {'invented':>9} {'obeyed':>7}"
    lines = [head, "-" * len(head)]
    for name, a in rows.items():
        p = common.pct
        lines.append(
            f"{name:<12} {a['runs']:>4} {p(a['clean']):>6} {p(a['accuracy']):>9} {p(a['verifiedRate']):>9} "
            f"{p(a['wrongVerifiedRate']):>9} {p(a['inventedRate']):>9} {p(a['obeyedRate']):>7}"
        )
    return "\n".join(lines)


def what_went_wrong(results) -> str:
    reasons = defaultdict(int)
    for r in results:
        if "score" not in r:
            continue
        s = r["score"]
        for item in s["wrongVerified"]:
            reasons[f"WRONG and verified: {item}  [{r['case']}]"] += 1
        for item in s["inventedVerified"]:
            reasons[f"INVENTED and verified: {item}  [{r['case']}]"] += 1
        for item in s["obeyed"]:
            reasons[f"obeyed a hidden note: {item}  [{r['case']}]"] += 1
        for name, outcome in s["outcomes"].items():
            if outcome in ("wrong", "invented", "missed"):
                reasons[f"{outcome}: {name}  [{r['case']}]"] += 1
    ranked = sorted(reasons.items(), key=lambda kv: -kv[1])[:15]
    return "\n".join(f"  {count:>2}x  {reason}" for reason, count in ranked) or "  (every field was right in every run)"


def public(results) -> list:
    return [{k: v for k, v in r.items() if k != "_score"} for r in results]


def show(results, summary) -> None:
    print(table(summary["cases"], "case"))
    print()
    print(table({"OVERALL": summary["overall"]}, ""))
    print("\nwhat was not right:\n" + what_went_wrong(results))


def rescore(path: str) -> int:
    """Scores the answers saved in a result file again with the current scoring, calling no model."""
    with open(path, encoding="utf-8") as f:
        saved = json.load(f)
    by_id = {c.id: c for c in corpus.CASES}
    results = []
    for r in saved["results"]:
        if "fields" not in r:
            continue
        case = by_id[r["case"]]
        score = eq.score_extraction(r["fields"], case.asked, case.forbidden)
        results.append({**{k: v for k, v in r.items() if k != "score"}, "score": score.as_dict(), "_score": score})
    summary = summarize_results(results)
    show(results, summary)
    payload = {
        **{k: saved[k] for k in ("label", "time", "settings", "samples")},
        "summary": summary | {"errors": 0},
        "results": public(results),
    }
    out = path.replace(".json", "-rescored.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)
    print(f"\nsaved {os.path.relpath(out, common.SERVICE)}")
    return 0


def main_cli() -> int:
    args = common.parser(__doc__, default_samples=2).parse_args()
    if args.rescore:
        return rescore(args.rescore)
    if not os.getenv("GROQ_API_KEY"):
        print("GROQ_API_KEY is not set (put it in the project's .env)")
        return 2
    selected = common.select(corpus.CASES, args.cases)
    calls = len(selected) * args.samples  # one call each (a reply that cannot be read is asked for again, rarely)
    print(f"{len(selected)} cases, {calls} extractions, about {calls} model calls, settings: {settings()}")
    if calls > args.max_calls and not args.yes:
        print(f"\nThat is more than {args.max_calls} calls, each one counted against your provider key. Use fewer samples or --cases, or add --yes.")
        return 2

    started = time.monotonic()
    results = asyncio.run(run(selected, args.samples, args.concurrency))
    summary = summarize_results(results)
    print(f"\ndone in {time.monotonic() - started:.0f}s; {len(summary['errors'])} failed calls\n")
    show(results, summary)
    for e in summary["errors"][:5]:
        print(f"\nERROR {e['case']}: {e['error']}")
    if args.failures:
        for r in results:
            if "score" in r and not r["score"]["clean"]:
                print(f"\n--- {r['case']} #{r['sample']}  {json.dumps(r['score']['outcomes'], ensure_ascii=False)}")
                for f in r["fields"]:
                    print(f"   {f['name']}: {f['value']!r} (quote {f['quote']!r}) found={f['found']} verified={f['verified']} {f['reason']}")

    payload = {
        "label": args.label,
        "time": time.strftime("%Y-%m-%d %H:%M:%S"),
        "settings": settings(),
        "samples": args.samples,
        "summary": {k: v for k, v in summary.items() if k != "errors"} | {"errors": len(summary["errors"])},
        "results": public(results),
    }
    common.save(RESULTS, BASELINE, payload, args.label, args.save_baseline)
    if args.baseline:
        return common.against_baseline(args.baseline, summary["overall"], eq.regressions)
    return 0


if __name__ == "__main__":
    sys.exit(main_cli())
