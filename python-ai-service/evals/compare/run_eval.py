"""Measures how well the model judges the differences between two documents, with the real model.

It compares pairs of made-up documents whose differences are known (compare_cases.py) several times each, exactly the way the
service does (the same code, the same prompts), and scores every comparison (compare_quality.py): was every change found,
was each rated as important as it should be (a changed figure, deadline or right: high; a typo or a rewording: low), did
the model describe a figure going up as going down, did it invent a number, was a sentence written to steer it flagged,
does the bottom line say what matters, in the language that was asked for. The headline number is the share of "clean" runs.

Use it before and after changing the compare prompts, the model or its settings. It calls the model, so it needs
GROQ_API_KEY (read from the project's .env) and counts every call against that key: it prints how many it is about to make
and refuses more than --max-calls (60) unless you add --yes. Run it from python-ai-service/ :

    python evals/compare/run_eval.py                       # every case, 2 runs each: about 30 model calls
    python evals/compare/run_eval.py --samples 3 --label prompt-v2
    python evals/compare/run_eval.py --cases lease,steering
    python evals/compare/run_eval.py --failures            # also print what the model said when a run was not clean
    python evals/compare/run_eval.py --save-baseline       # keep this run as the reference
    python evals/compare/run_eval.py --baseline evals/compare/baseline.json    # fail if it got worse
    python evals/compare/run_eval.py --rescore results/a.json    # score saved answers again; no model call
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

import compare_cases as corpus  # noqa: E402
import compare  # noqa: E402
import compare_quality as cq  # noqa: E402
import main  # noqa: E402

RESULTS = os.path.join(HERE, "results")
BASELINE = os.path.join(HERE, "baseline.json")


def calls_for(case) -> int:
    """About how many model calls one comparison takes: the explanations of the changes, then the bottom line (nothing
    at all when the only change is a move: the program says that itself)."""
    changes = compare.find_changes(case.old[1], case.new[1])
    explainable = [c for c in changes if c.kind != "moved"]
    if not explainable:
        return 0
    batches = -(-len(explainable) // compare.BATCH_SIZE)
    return batches + 1


async def ask(prompt: str) -> str:
    return await main.call_llm(prompt)


def score_of(case, result) -> cq.Score:
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


async def run_one(semaphore, case, sample):
    async with semaphore:
        started = time.monotonic()
        try:
            result = await compare.compare_documents(case.old[0], case.old[1], case.new[0], case.new[1], case.language, ask)
        except Exception as exc:  # a failed call is reported, and left out of the rates
            return {"case": case.id, "sample": sample, "error": f"{type(exc).__name__}: {exc}"[:300]}
        score = score_of(case, result)
        return {
            "case": case.id,
            "sample": sample,
            "seconds": round(time.monotonic() - started, 1),
            "result": result,
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
        "overall": cq.aggregate([r["_score"] for r in good]),
        "cases": {k: cq.aggregate(v) for k, v in by_case.items()},
        "errors": [r for r in results if "error" in r],
    }


def table(rows: dict, title: str) -> str:
    head = (
        f"{title:<12} {'runs':>4} {'clean':>6} {'found':>6} {'rating':>7} {'explained':>10} {'traps':>6} "
        f"{'numbers':>8} {'steer':>6} {'bottom':>7} {'lang':>5}"
    )
    lines = [head, "-" * len(head)]
    for name, a in rows.items():
        p = common.pct
        lines.append(
            f"{name:<12} {a['runs']:>4} {p(a['clean']):>6} {p(a['changeRecall']):>6} {p(a['importanceAccuracy']):>7} "
            f"{p(a['explainedRate']):>10} {p(a['trapRate']):>6} {p(a['inventedNumberRate']):>8} {p(a['suspiciousOk']):>6} "
            f"{p(a['bottomLineOk']):>7} {p(a['languageOk']):>5}"
        )
    return "\n".join(lines)


def what_went_wrong(results) -> str:
    reasons = defaultdict(int)
    for r in results:
        if "score" not in r or r["score"]["clean"]:
            continue
        s = r["score"]
        for item in s["missed"]:
            reasons[f"change not found: {item}  [{r['case']}]"] += 1
        for item in s["importanceWrong"]:
            reasons[f"rated wrong: {item}  [{r['case']}]"] += 1
        for item in s["kindWrong"]:
            reasons[f"called wrong: {item}  [{r['case']}]"] += 1
        for item in s["trapsHit"]:
            reasons[f"trap: {item}  [{r['case']}]"] += 1
        for number in s["inventedNumbers"]:
            reasons[f"invented number {number}  [{r['case']}]"] += 1
        done, total = s["explained"].split("/")
        if done != total:
            reasons[f"changes left unexplained ({s['explained']})  [{r['case']}]"] += 1
        if not s["suspiciousOk"]:
            reasons[f"steering sentence not handled  [{r['case']}]"] += 1
        if s["bottomMissed"]:
            reasons[f"bottom line missed: {', '.join(s['bottomMissed'])}  [{r['case']}]"] += 1
        if s["languageOk"] is False:
            reasons[f"wrong language ({s['language']})  [{r['case']}]"] += 1
    ranked = sorted(reasons.items(), key=lambda kv: -kv[1])[:15]
    return "\n".join(f"  {count:>2}x  {reason}" for reason, count in ranked) or "  (every run was clean)"


def public(results) -> list:
    return [{k: v for k, v in r.items() if k != "_score"} for r in results]


def show(results, summary) -> None:
    print(table(summary["cases"], "case"))
    print()
    print(table({"OVERALL": summary["overall"]}, ""))
    print("\nwhy runs were not clean:\n" + what_went_wrong(results))


def rescore(path: str) -> int:
    """Scores the answers saved in a result file again with the current scoring, calling no model."""
    with open(path, encoding="utf-8") as f:
        saved = json.load(f)
    by_id = {c.id: c for c in corpus.CASES}
    results = []
    for r in saved["results"]:
        if "result" not in r:
            continue
        score = score_of(by_id[r["case"]], r["result"])
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
    calls = sum(calls_for(c) for c in selected) * args.samples
    print(f"{len(selected)} cases, {len(selected) * args.samples} comparisons, about {calls} model calls, settings: {settings()}")
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
                print(f"\n--- {r['case']} #{r['sample']}  {json.dumps(r['score'], ensure_ascii=False)}")
                for c in r["result"]["changes"]:
                    print(f"   [{c['importance']}/{c['kind']}] {c['summary']} | {c['impact']}")
                print(f"   bottom line: {r['result']['bottomLine']}")

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
        return common.against_baseline(args.baseline, summary["overall"], cq.regressions)
    return 0


if __name__ == "__main__":
    sys.exit(main_cli())
