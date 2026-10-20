"""Combine every subject's metrics into the document's tables and apply the gate.

A check passes on a subject if the method's ratio to topup is at most the
larger of the fixed limit (AP-PA 1.1, BBR 1.02) and topup-single's ratio on
that subject. The fixed-limit result is printed too.

Usage: aggregate.py <runs-dir> [subject...]

Prints Markdown: one row per method and subject, then one row per method with
the image gate result, the mean demeaned Δfield and the mean run time.
"""

import json
import sys
from pathlib import Path

AP_PA_LIMIT = 1.1
BBR_LIMIT = 1.02
MARGIN = 1.5
ORDER = [
    "topup",
    "topup-single",
    "drbuddi",
    "pyhysco",
    "pyhysco-gpu",
    "fdnet",
    "fdnet-pa-first",
    "ants",
    "qwarp",
]


def fmt(value, digits=3):
    return "" if value is None else f"{value:.{digits}g}"


def average(rows, key):
    return sum(r[key] for r in rows) / len(rows)


def main(runs, *subjects):
    runs = Path(runs)
    if not subjects:
        subjects = sorted(
            p.name for p in runs.iterdir() if (p / "summary.json").exists()
        )
    table = {}
    for sub in subjects:
        rows = {
            m["method"]: m
            for m in json.loads((runs / sub / "summary.json").read_text())
        }
        table[sub] = rows

    print(
        "| Subject | Method | AP-PA | AP-PA, no Jacobian | BBR | Δfield (Hz) | Δfield demeaned (Hz) | r | Δ GRE demeaned (Hz) | Time (s) | Peak RAM (MB) | Image gate |"
    )
    print("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |")
    passes = {}
    strict_passes = {}
    for sub, rows in table.items():
        ref = rows["topup"]
        # "Close" means within topup's own spread: the limit on a subject is the
        # larger of the fixed limit and topup-single's ratio there.
        single = rows["topup-single"]
        appa_limit = max(AP_PA_LIMIT, single["appa_mad"] / ref["appa_mad"])
        bbr_limit = max(BBR_LIMIT, single["bbr_cost"] / ref["bbr_cost"])
        for method in ORDER:
            m = rows.get(method)
            if m is None:
                continue
            ok = (
                m["appa_mad"] <= appa_limit * ref["appa_mad"]
                and m["bbr_cost"] <= bbr_limit * ref["bbr_cost"]
            )
            strict = (
                m["appa_mad"] <= AP_PA_LIMIT * ref["appa_mad"]
                and m["bbr_cost"] <= BBR_LIMIT * ref["bbr_cost"]
            )
            passes.setdefault(method, []).append(ok)
            strict_passes.setdefault(method, []).append(strict)
            print(
                f"| {sub} | {method} | {fmt(m['appa_mad'])} | {fmt(m.get('appa_mad_nojac'))} "
                f"| {fmt(m['bbr_cost'], 4)} | {fmt(m['field_vs_topup_mad_hz'])} "
                f"| {fmt(m['field_vs_topup_mad_demeaned_hz'])} | {fmt(m['field_vs_topup_r'])} "
                f"| {fmt(m.get('field_vs_gre_mad_demeaned_hz'))} | {fmt(m.get('wall_s'))} "
                f"| {fmt(m.get('peak_rss_mb'))} | {'pass' if ok else 'fail'} |"
            )

    print()
    print(
        "| Method | Image gate (subjects passed) | Fixed limits only | Mean Δfield demeaned (Hz) | Mean Δfield (Hz) | Mean r | Mean time (s) | Max peak RAM (MB) |"
    )
    print("| --- | --- | --- | --- | --- | --- | --- | --- |")
    means = {}
    for method in ORDER:
        vals = [rows[method] for rows in table.values() if method in rows]
        if not vals:
            continue
        means[method] = average(vals, "field_vs_topup_mad_demeaned_hz")
        times = [v["wall_s"] for v in vals if "wall_s" in v]
        rams = [v["peak_rss_mb"] for v in vals if "peak_rss_mb" in v]
        print(
            f"| {method} | {sum(passes[method])}/{len(passes[method])} "
            f"| {sum(strict_passes[method])}/{len(strict_passes[method])} "
            f"| {fmt(means[method])} | {fmt(average(vals, 'field_vs_topup_mad_hz'))} "
            f"| {fmt(average(vals, 'field_vs_topup_r'))} "
            f"| {fmt(sum(times) / len(times)) if times else ''} | {fmt(max(rams)) if rams else ''} |"
        )

    candidates = [
        m
        for m in ORDER
        if m not in ("topup", "topup-single", "pyhysco-gpu", "fdnet-pa-first")
        and m in passes
        and all(passes[m])
    ]
    print()
    if not candidates:
        print("No candidate passes the image gate on every subject.")
        return
    closest = min(candidates, key=means.get)
    print(f"Passing every subject: {', '.join(candidates)}.")
    print(f"Closest by mean demeaned Δfield: {closest} ({means[closest]:.3g} Hz).")
    for m in candidates:
        print(
            f"- {m}: {means[m] / means[closest]:.2f} x the closest (margin {MARGIN})."
        )


if __name__ == "__main__":
    main(*sys.argv[1:])
