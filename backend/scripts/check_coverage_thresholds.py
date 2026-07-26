from __future__ import annotations

import argparse
import json
from pathlib import Path


def percentage(covered: int, total: int) -> float:
    return 100.0 if total == 0 else covered * 100.0 / total


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("report", type=Path)
    parser.add_argument("--minimum-line", type=float, required=True)
    parser.add_argument("--minimum-branch", type=float, required=True)
    args = parser.parse_args()

    totals = json.loads(args.report.read_text(encoding="utf-8"))["totals"]
    line = percentage(totals["covered_lines"], totals["num_statements"])
    branch = percentage(totals["covered_branches"], totals["num_branches"])
    print(f"line={line:.2f}% branch={branch:.2f}%")

    return int(line < args.minimum_line or branch < args.minimum_branch)


if __name__ == "__main__":
    raise SystemExit(main())
