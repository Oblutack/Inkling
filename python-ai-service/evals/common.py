"""What the compare and extract checks share: reading the key, the command line, and saving a run.

(The summary check, evals/summary, was written first and keeps its own copy of these.)
"""

import argparse
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE = os.path.abspath(os.path.join(HERE, ".."))


def prepare(check_dir: str) -> None:
    """Puts the service and the check's own folder on the path and reads the project's .env (for GROQ_API_KEY)."""
    sys.path[:0] = [SERVICE, check_dir]
    from dotenv import load_dotenv

    load_dotenv(os.path.join(SERVICE, "..", ".env"))
    os.environ.setdefault("LOG_LEVEL", "WARNING")


def pct(value) -> str:
    return "   -" if value is None else f"{value:>4.0%}"


def parser(description: str, default_samples: int) -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=description, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--samples", type=int, default=default_samples, help=f"runs per case (default {default_samples})")
    p.add_argument("--cases", default="", help="comma-separated case ids (default: all)")
    p.add_argument("--concurrency", type=int, default=3, help="model calls at once (default 3)")
    p.add_argument("--label", default="", help="name for the result file")
    p.add_argument("--failures", action="store_true", help="print every run that was not clean")
    p.add_argument("--max-calls", type=int, default=60, help="refuse a run that would make more model calls than this")
    p.add_argument("--yes", action="store_true", help="go ahead with a run above --max-calls")
    p.add_argument("--save-baseline", action="store_true", help="write this run as baseline.json")
    p.add_argument("--baseline", default="", help="compare with this result file and fail on a regression")
    p.add_argument("--rescore", metavar="FILE", help="score a saved result file again with the current scoring; no model call")
    return p


def select(cases, wanted: str):
    names = {c.strip() for c in wanted.split(",") if c.strip()}
    unknown = names - {c.id for c in cases}
    if unknown:
        raise SystemExit(f"unknown cases: {', '.join(sorted(unknown))}; known: {', '.join(c.id for c in cases)}")
    return [c for c in cases if not names or c.id in names]


def save(results_dir: str, baseline_path: str, payload: dict, label: str, as_baseline: bool) -> None:
    os.makedirs(results_dir, exist_ok=True)
    path = os.path.join(results_dir, f"{time.strftime('%Y%m%d-%H%M%S')}-{label or 'run'}.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)
    print(f"\nsaved {os.path.relpath(path, SERVICE)}")
    if as_baseline:
        with open(baseline_path, "w", encoding="utf-8") as f:
            keep = ("label", "time", "settings", "samples", "summary")
            json.dump({k: payload[k] for k in keep}, f, ensure_ascii=False, indent=1)
        print(f"saved {os.path.relpath(baseline_path, SERVICE)}")


def against_baseline(path: str, overall: dict, regressions) -> int:
    with open(path, encoding="utf-8") as f:
        reference = json.load(f)
    worse = regressions(overall, reference["summary"]["overall"])
    print("\nagainst the baseline:", "; ".join(worse) if worse else "no regression")
    return 1 if worse else 0
