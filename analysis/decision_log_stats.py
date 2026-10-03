"""
Compute branch-distribution stats (motivation / random_exploration / no_candidates / ...)
from an exported `agentDecisionLogs` table, for any stage under data/.

Accepts either the xlsx export from the Convex dashboard's table UI, or the raw
`documents.jsonl` export from the dashboard's "Export" button.

Usage:
    pip install openpyxl
    python analysis/decision_log_stats.py data/03-dynamic-subgoal/decisionlogs.jsonl
    python analysis/decision_log_stats.py data/02-fixed-motivation-wander/decisionlog-export/decisionlogs.xlsx
"""
import json
import sys
from collections import Counter


def load_rows_jsonl(path):
    with open(path) as f:
        return [json.loads(line) for line in f if line.strip()]


def load_rows_xlsx(path):
    import openpyxl

    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    ws = wb.active
    rows = list(ws.iter_rows(values_only=True))
    header = [str(h) for h in rows[0]]
    return [dict(zip(header, r)) for r in rows[1:]]


def load_rows(path):
    if path.endswith(".jsonl"):
        return load_rows_jsonl(path)
    return load_rows_xlsx(path)


def main(path):
    data = load_rows(path)
    total = len(data)
    counts = Counter((r["decisionType"], r["branch"]) for r in data)

    print(f"{path}")
    print(f"total decisions: {total}\n")
    print(f"{'decisionType':<10} {'branch':<20} {'count':>6} {'% of total':>10}")
    for (dt, br), n in sorted(counts.items(), key=lambda kv: -kv[1]):
        pct = 100 * n / total if total else 0
        print(f"{dt:<10} {br:<20} {n:>6} {pct:>9.1f}%")

    motivation_driven = sum(n for (dt, br), n in counts.items() if br == "motivation")
    print(f"\nmotivation-driven share (invite+wander): {100 * motivation_driven / total:.1f}%")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(1)
    main(sys.argv[1])
