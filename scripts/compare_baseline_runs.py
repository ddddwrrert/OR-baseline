"""Compare completed, matched AHC runs from any method's exported measurements."""

import argparse
import json
import math
import statistics
from collections import defaultdict
from pathlib import Path


def read_runs(manifest: Path, control: str) -> dict:
    pairs = defaultdict(dict)
    for index, row in enumerate(json.loads(manifest.read_text(encoding="utf-8")), 1):
        # Fingerprints are supplied by the benchmark runner, before search starts.
        key = tuple(row[field] for field in ("task", "baseline_sha256", "seed"))
        method = row["method"]
        if method in pairs[key]:
            raise ValueError(f"duplicate run at manifest row {index}: {key}, {method}")
        metrics = row.get("metrics", {})
        if "report" in row:
            report = json.loads((manifest.parent / row["report"]).read_text(encoding="utf-8"))
            if report["budget"]["remaining"] != 0 or report["budget"]["max"] != row["candidate_budget"]:
                raise ValueError(f"run at row {index} did not complete the declared candidate budget")
            metrics = {**report["metrics"], **metrics}
        match = tuple(row[field] for field in ("candidate_budget", "model", "inference_limit",
                                                "cpu_limit", "public_cases_sha256", "judge_sha256"))
        pairs[key][method] = (match, metrics, row.get("baseline_level"))
    if not any(control in entries for entries in pairs.values()):
        raise ValueError(f"control method missing: {control}")
    return pairs


def paired_summary(pairs: dict, control: str, metric: str) -> dict:
    differences = defaultdict(list)
    skipped = defaultdict(int)
    for (task, baseline, _), entries in pairs.items():
        reference = entries.get(control)
        for method, run in entries.items():
            if method == control:
                continue
            if reference is None:
                skipped[method] += 1
                continue
            match, measures, level = run
            ref_match, ref_measures, ref_level = reference
            if match != ref_match or level != ref_level:
                raise ValueError(f"unmatched conditions for {task} / {baseline} / {method}")
            value, ref_value = measures.get(metric), ref_measures.get(metric)
            if value is None or ref_value is None:
                skipped[method] += 1
                continue
            if not all(isinstance(x, (int, float)) and math.isfinite(x) for x in (value, ref_value)):
                raise ValueError(f"metric {metric} must be finite and numeric")
            differences[(method, task, baseline, level)].append(value - ref_value)

    comparisons = []
    for (method, task, baseline, level), deltas in differences.items():
        comparisons.append({
            "method": method, "task": task, "baseline_sha256": baseline, "baseline_level": level,
            "matched_seeds": len(deltas), "mean_difference": statistics.mean(deltas),
            "median_difference": statistics.median(deltas),
            "standard_deviation": statistics.stdev(deltas) if len(deltas) > 1 else None,
            "seed_differences": deltas,
        })
    return {"metric": metric, "control": control, "comparisons": comparisons, "unpaired_or_missing": skipped}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--control", default="Organon")
    parser.add_argument("--metric", default="finalBestScore")
    args = parser.parse_args()
    try:
        result = paired_summary(read_runs(args.manifest, args.control), args.control, args.metric)
    except (KeyError, OSError, TypeError, ValueError) as error:
        parser.error(str(error))
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

