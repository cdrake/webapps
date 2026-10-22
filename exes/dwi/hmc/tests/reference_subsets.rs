//! The pinned hmc reference data (`validation/reference.manifest.json`, `hmc/reference/` of the
//! Hugging Face dataset) and the subsets that `validation/fetch_reference.py` downloads.
//!
//! Without data, the manifest test checks that this file's `*` matcher selects the files and
//! bytes that `make_manifest.py` recorded for each subset, so the script and the tests agree on
//! what a subset holds.
//!
//! With data (`HMC_REFERENCE`, and `HMC_REFERENCE_SUBSETS` as the script prints it; all subsets
//! when it is not set), every file of each named subset must be present at its pinned size, and
//! two subsets are read with this crate:
//! - `decomposition`: each NiFreeze run's 90 ITK transforms, converted to RAS, against its
//!   `motion_affines.tsv` (NiFreeze's own conversion, from its HDF5 output), exactly.
//! - `clip`: the trivial model's first in-place clip of `bzero` against its prediction
//!   (`predicted_00000`), which NiFreeze wrote after that clip (Q55).
//!
//! Without `HMC_REFERENCE` the data test passes and does nothing, unless `HMC_REQUIRE_REFERENCE`
//! is set, as in CI: then missing data is a failure.
//!
//! ```sh
//! export $(python3 validation/fetch_reference.py /var/tmp/hmc-ref decomposition clip)
//! cargo test --release -p dwi-hmc --test reference_subsets -- --nocapture
//! ```

mod common;

use common::read_nifti;
use dwi_hmc::ItkAffine;
use dwi_hmc::clip::advanced_clip_in_place;
use dwi_hmc::motion::itk_ras_matrix;
use serde_json::Value;
use std::path::Path;

const MANIFEST: &str = include_str!("../validation/reference.manifest.json");

/// NiFreeze's six runs (README "NiFreeze runs").
const NIFREEZE_RUNS: [&str; 6] = [
    "nifreeze-trivial-a1",
    "nifreeze-trivial-a2",
    "nifreeze-trivial-float",
    "nifreeze-gp",
    "nifreeze-gp-float",
    "nifreeze-gp-seed1235",
];
const DWI_VOLUMES: usize = 90;

fn manifest() -> Value {
    serde_json::from_str(MANIFEST).expect("reference.manifest.json")
}

/// fnmatch with only `*`, which also matches `/`: the patterns that `make_manifest.py` allows.
fn glob(pattern: &[u8], path: &[u8]) -> bool {
    match pattern.split_first() {
        None => path.is_empty(),
        Some((b'*', rest)) => (0..=path.len()).any(|k| glob(rest, &path[k..])),
        Some((c, rest)) => path.first() == Some(c) && glob(rest, &path[1..]),
    }
}

/// The manifest entries (path, bytes) of one subset.
fn subset_files<'a>(manifest: &'a Value, name: &str) -> Vec<(&'a str, u64)> {
    let patterns: Vec<&str> = manifest["subsets"][name]["patterns"]
        .as_array()
        .unwrap_or_else(|| panic!("no subset {name} in the manifest"))
        .iter()
        .map(|p| p.as_str().unwrap())
        .collect();
    manifest["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| (e["path"].as_str().unwrap(), e["bytes"].as_u64().unwrap()))
        .filter(|(path, _)| patterns.iter().any(|p| glob(p.as_bytes(), path.as_bytes())))
        .collect()
}

#[test]
fn subsets_select_the_recorded_files() {
    let manifest = manifest();
    let revision = manifest["revision"].as_str().unwrap();
    // An immutable address: the dataset at one full commit, as the repository's pin rule asks.
    assert_eq!(revision.len(), 40);
    assert!(
        revision
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
    );
    assert_eq!(
        manifest["base"].as_str().unwrap(),
        format!(
            "https://huggingface.co/datasets/{}/resolve/{revision}/hmc/reference/",
            manifest["repository"].as_str().unwrap()
        )
    );
    for (name, subset) in manifest["subsets"].as_object().unwrap() {
        let files = subset_files(&manifest, name);
        let bytes: u64 = files.iter().map(|(_, b)| b).sum();
        assert_eq!(
            files.len() as u64,
            subset["files"].as_u64().unwrap(),
            "{name}: file count"
        );
        assert_eq!(bytes, subset["bytes"].as_u64().unwrap(), "{name}: bytes");
    }
}

/// The 4×4 matrices of a `motion_affines.tsv`: a header, then one row-major row per volume.
fn motion_affines(path: &Path) -> Vec<[f64; 16]> {
    let text = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{path:?}: {e}"));
    text.lines()
        .skip(1)
        .map(|line| {
            let v: Vec<f64> = line.split('\t').map(|x| x.parse().unwrap()).collect();
            v.try_into().unwrap()
        })
        .collect()
}

fn check_decomposition(root: &Path) {
    for run in NIFREEZE_RUNS {
        let rows = motion_affines(&root.join(run).join("motion_affines.tsv"));
        assert_eq!(rows.len(), DWI_VOLUMES, "{run}: motion_affines.tsv rows");
        for (i, row) in rows.iter().enumerate() {
            let path = root.join(format!("{run}/work/ants-{i:05}0GenericAffine.mat"));
            let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("{path:?}: {e}"));
            let ras = itk_ras_matrix(&ItkAffine::from_mat(&bytes).unwrap());
            let flat: Vec<f64> = ras.iter().flatten().copied().collect();
            assert_eq!(flat, row, "{run} volume {i}: RAS matrix");
        }
    }
    eprintln!(
        "decomposition: {} ITK transforms equal motion_affines.tsv",
        NIFREEZE_RUNS.len() * DWI_VOLUMES
    );
}

fn check_clip(root: &Path) {
    let bzero = read_nifti(&root.join("nifreeze-gp/bzero.nii.gz"));
    assert_eq!(bzero.datatype, 64);
    let [nx, ny, nz] = [bzero.dim[0], bzero.dim[1], bzero.dim[2]];
    let mut map = bzero.f64s();
    advanced_clip_in_place(&mut map, [nz, ny, nx]).unwrap();
    let predicted = read_nifti(&root.join("nifreeze-trivial-a1/work/predicted_00000.nii.gz"));
    assert_eq!(predicted.dim[..3], bzero.dim[..3]);
    let differing = map
        .iter()
        .zip(predicted.f64s())
        .filter(|&(&a, b)| a != b)
        .count();
    assert_eq!(
        differing, 0,
        "the clipped bzero differs from predicted_00000 in {differing} voxels"
    );
    eprintln!(
        "clip: bzero clipped in place equals predicted_00000 in all {} voxels",
        map.len()
    );
}

#[test]
fn fetched_subsets_are_complete_and_readable() {
    let Ok(root) = std::env::var("HMC_REFERENCE") else {
        if std::env::var_os("HMC_REQUIRE_REFERENCE").is_some() {
            panic!("HMC_REFERENCE is not set, but HMC_REQUIRE_REFERENCE is set");
        }
        eprintln!("HMC_REFERENCE is not set; the reference subsets are not checked");
        return;
    };
    let root = Path::new(&root);
    let manifest = manifest();
    let names: Vec<String> = match std::env::var("HMC_REFERENCE_SUBSETS") {
        Ok(list) if list != "all" => list.split(',').map(|s| s.trim().to_string()).collect(),
        _ => manifest["subsets"]
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect(),
    };
    for name in &names {
        let files = subset_files(&manifest, name);
        for (path, bytes) in &files {
            let size = std::fs::metadata(root.join(path))
                .unwrap_or_else(|e| panic!("{name}: {path}: {e}"))
                .len();
            assert_eq!(size, *bytes, "{name}: {path}: size");
        }
        eprintln!(
            "{name}: {} files present at their pinned sizes",
            files.len()
        );
        match name.as_str() {
            "decomposition" => check_decomposition(root),
            "clip" => check_clip(root),
            _ => {}
        }
    }
}
