//! Q53 for the WebAssembly registration (#446): NiFreeze's kept registrations replayed through
//! `@neurodesk/hmc-registration` (`packages/hmc-registration/validation/nifreeze-replay.mjs`,
//! which writes `HMC_WASM_REPLAY`) against native ANTs 52bc0ab from the M0 reference.
//!
//! For each volume and axis (translation x, y, z in mm; rotation vector x, y, z in degrees) a cell
//! passes when `|wasm − double| ≤ |double − double seed 1235|`, all at seed 1234 unless named.
//! Both sides are computed by QSIPrep's formula (`motion::ras_motion`, the TSV convention, on the
//! raw DWI grid) and about the world grid centre (`motion::world_centre_motion`). The GP set is the
//! 90 DWI volumes of `nifreeze-gp`; the b0 set is the 11 pairs of `q53-b0/`. `|float − double|`
//! (native float) is reported beside them, and so is whether each WebAssembly transform equals
//! native float byte for byte.
//!
//! The kernel is single-threaded, seeded and SHA-256-pinned, so the whole table is deterministic.
//! `validation/q53-replay.json` holds it, and this test fails when a recomputed value or a pass
//! flag differs. Rewrite it with `HMC_Q53_WRITE=1` after a deliberate change of the kernel or the
//! argv, and give the new failing cells in the PR. Data-gated on the `nifreeze-replay` subset; with
//! `HMC_REQUIRE_REFERENCE` set, a missing `HMC_WASM_REPLAY` is a failure.

mod common;

use common::reference;
use dwi_hmc::ItkAffine;
use dwi_hmc::motion::{Grid, Motion, itk_ras_matrix, motion_about, world_centre_motion};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

const AXES: [&str; 6] = ["tx", "ty", "tz", "rx", "ry", "rz"];
const REPORT: &str = "validation/q53-replay.json";

/// The DWI volumes (0-89) and the b0 volumes of `q53-b0/` (original indices).
const GP_VOLUMES: usize = 90;
const B0_VOLUMES: [usize; 11] = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];

fn read(path: &Path) -> Vec<u8> {
    std::fs::read(path).unwrap_or_else(|e| panic!("{path:?}: {e}"))
}

/// The raw DWI grid from `input/input-facts.json` (nibabel's shape and affine).
fn grid(root: &Path) -> Grid {
    // Python's json writes the NaN scale fields as bare NaN, which is not JSON.
    let text = String::from_utf8(read(&root.join("input/input-facts.json"))).unwrap();
    let facts: Value = serde_json::from_str(&text.replace("NaN", "null")).unwrap();
    let shape: Vec<usize> = facts["shape"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_u64().unwrap() as usize)
        .collect();
    let row =
        |i: usize| -> [f64; 4] { std::array::from_fn(|j| facts["affine"][i][j].as_f64().unwrap()) };
    Grid {
        shape: [shape[0], shape[1], shape[2]],
        affine: [row(0), row(1), row(2), row(3)],
    }
}

/// The six parameters of a motion: translation (mm), then the rotation vector (degrees).
fn six(m: Motion) -> [f64; 6] {
    let [tx, ty, tz] = m.translation;
    let [rx, ry, rz] = m.rotation.map(f64::to_degrees);
    [tx, ty, tz, rx, ry, rz]
}

/// One registration's four transforms: WebAssembly, native double, double at seed 1235, native
/// float.
struct Case {
    volume: usize,
    files: [PathBuf; 4],
}

fn cases(root: &Path, wasm: &Path) -> (Vec<Case>, Vec<Case>) {
    let gp = (0..GP_VOLUMES)
        .map(|v| {
            let name = format!("ants-{v:05}0GenericAffine.mat");
            Case {
                volume: v,
                files: [
                    wasm.join("gp").join(&name),
                    root.join("nifreeze-gp/work").join(&name),
                    root.join("nifreeze-gp-seed1235/work").join(&name),
                    root.join("nifreeze-gp-float/work").join(&name),
                ],
            }
        })
        .collect();
    let b0 = B0_VOLUMES
        .iter()
        .map(|&k| Case {
            volume: k,
            files: [
                wasm.join(format!("b0/float-{k:03}_0GenericAffine.mat")),
                root.join(format!("q53-b0/double-{k:03}_0GenericAffine.mat")),
                root.join(format!("q53-b0/double_seed1235-{k:03}_0GenericAffine.mat")),
                root.join(format!("q53-b0/float-{k:03}_0GenericAffine.mat")),
            ],
        })
        .collect();
    (gp, b0)
}

/// The table of one set: for each convention and volume, `|wasm − double|`, the seed spread and
/// `|float − double|` per axis, the failing axes, and the byte comparison with native float.
fn table(cases: &[Case], grid: &Grid) -> Value {
    let pivot = grid.pivot();
    let mut out = serde_json::Map::new();
    for convention in ["qsiprep", "world"] {
        let mut rows = Vec::new();
        let (mut cells, mut volumes) = (0, 0);
        for case in cases {
            let [w, d, s, f] = case.files.each_ref().map(|path| {
                let m = itk_ras_matrix(&ItkAffine::from_mat(&read(path)).unwrap());
                six(match convention {
                    "qsiprep" => motion_about(&m, pivot),
                    _ => world_centre_motion(&m, grid),
                })
            });
            let wasm: Vec<f64> = (0..6).map(|k| (w[k] - d[k]).abs()).collect();
            let seed: Vec<f64> = (0..6).map(|k| (d[k] - s[k]).abs()).collect();
            let float: Vec<f64> = (0..6).map(|k| (f[k] - d[k]).abs()).collect();
            let failing: Vec<&str> = (0..6)
                .filter(|&k| wasm[k] > seed[k])
                .map(|k| AXES[k])
                .collect();
            cells += failing.len();
            volumes += usize::from(!failing.is_empty());
            rows.push(json!({
                "volume": case.volume,
                "wasm_minus_double": wasm,
                "seed_spread": seed,
                "float_minus_double": float,
                "failing_axes": failing,
            }));
        }
        out.insert(
            convention.to_string(),
            json!({ "failing_volumes": volumes, "failing_cells": cells, "volumes": rows }),
        );
    }
    let differ: Vec<usize> = cases
        .iter()
        .filter(|case| read(&case.files[0]) != read(&case.files[3]))
        .map(|case| case.volume)
        .collect();
    out.insert("wasm_differs_from_native_float".to_string(), json!(differ));
    Value::Object(out)
}

#[test]
fn wasm_registration_against_the_native_seed_spread() {
    let Some(root) = reference("nifreeze-replay") else {
        return;
    };
    let Ok(wasm) = std::env::var("HMC_WASM_REPLAY") else {
        if std::env::var_os("HMC_REQUIRE_REFERENCE").is_some() {
            panic!("HMC_WASM_REPLAY is not set, but HMC_REQUIRE_REFERENCE is set");
        }
        eprintln!("HMC_WASM_REPLAY is not set; run validation/nifreeze-replay.mjs first");
        return;
    };
    let wasm = PathBuf::from(wasm);
    let grid = grid(&root);
    let (gp, b0) = cases(&root, &wasm);
    let report = json!({
        "rule": "per volume and axis: |wasm - double| <= |double - double seed 1235| (Q53); translations in mm, rotation vector in degrees",
        "gp": table(&gp, &grid),
        "b0": table(&b0, &grid),
    });
    for set in ["gp", "b0"] {
        for convention in ["qsiprep", "world"] {
            let t = &report[set][convention];
            eprintln!(
                "{set} {convention}: {} failing volumes, {} failing cells",
                t["failing_volumes"], t["failing_cells"]
            );
        }
        eprintln!(
            "{set}: WebAssembly differs from native float on {}",
            report[set]["wasm_differs_from_native_float"]
        );
    }
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(REPORT);
    if std::env::var_os("HMC_Q53_WRITE").is_some() {
        std::fs::write(&path, report_text(&report)).unwrap();
        eprintln!("wrote {path:?}");
        return;
    }
    let recorded: Value = serde_json::from_slice(&read(&path)).unwrap();
    assert!(
        recorded == report,
        "the replay differs from {REPORT}; rerun with HMC_Q53_WRITE=1 and review the change"
    );
}

/// The report with one volume per line, so a change reads as a line diff.
fn report_text(report: &Value) -> String {
    let mut text = String::from("{\n");
    text += &format!("  \"rule\": {},\n", report["rule"]);
    for (i, set) in ["gp", "b0"].iter().enumerate() {
        text += &format!("  \"{set}\": {{\n");
        for convention in ["qsiprep", "world"] {
            let t = &report[set][convention];
            text += &format!(
                "    \"{convention}\": {{\n      \"failing_volumes\": {},\n      \"failing_cells\": {},\n      \"volumes\": [\n",
                t["failing_volumes"], t["failing_cells"]
            );
            let rows: Vec<String> = t["volumes"]
                .as_array()
                .unwrap()
                .iter()
                .map(|row| format!("        {row}"))
                .collect();
            text += &rows.join(",\n");
            text += "\n      ]\n    },\n";
        }
        text += &format!(
            "    \"wasm_differs_from_native_float\": {}\n  }}{}\n",
            report[set]["wasm_differs_from_native_float"],
            if i == 0 { "," } else { "" }
        );
    }
    text + "}\n"
}
