"""
Compute branch-distribution stats (motivation / random_exploration / no_candidates / ...)
from an exported `agentDecisionLogs` table, for any stage under data/.

Usage:
    pip install openpyxl
    python analysis/decision_log_stats.py data/03-dynamic-subgoal/decisionlogs.xlsx

Expects the columns produced by the project's Convex dashboard export: at minimum
`decisionType` and `branch` (plus optional creationTime_readable, playerId, playerName).
"""
import sys
from collections import Counter

import openpyxl


def load_rows(path):
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    ws = wb.active
    rows = list(ws.iter_rows(values_only=True))
    header = [str(h) for h in rows[0]]
    return header, rows[1:]


def main(path):
    header, data = load_rows(path)
    dt_i = header.index("decisionType")
    br_i = header.index("branch")

    total = len(data)
    counts = Counter((r[dt_i], r[br_i]) for r in data)

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
