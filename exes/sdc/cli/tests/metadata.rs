use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT: AtomicU64 = AtomicU64::new(0);

struct Directory(PathBuf);

impl Directory {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "sdc-cli-metadata-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }

    fn sidecar(&self, name: &str, text: &str) {
        std::fs::write(self.0.join(format!("{name}.json")), text).unwrap();
    }

    fn run(&self, extra: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_sdc"))
            .args(["pyhysco", "ap.nii", "pa.nii", "out"])
            .args(extra)
            .current_dir(&self.0)
            .output()
            .unwrap()
    }
}

impl Drop for Directory {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn both_sidecars_need_a_positive_readout_before_images_are_read() {
    let dir = Directory::new();
    dir.sidecar(
        "ap",
        r#"{"PhaseEncodingDirection":"j-","TotalReadoutTime":0.05}"#,
    );
    for readout in ["", ",\"TotalReadoutTime\":0", ",\"TotalReadoutTime\":-0.05"] {
        dir.sidecar(
            "pa",
            &format!(r#"{{"PhaseEncodingDirection":"j"{readout}}}"#),
        );
        let result = dir.run(&[]);
        assert!(!result.status.success());
        let error = String::from_utf8_lossy(&result.stderr);
        assert!(
            error.contains("image 2") && error.contains("finite positive TotalReadoutTime"),
            "{error}"
        );
        assert!(!dir.0.join("out_fieldmap.nii.gz").exists());
    }
}

#[test]
fn unequal_readouts_are_refused_before_images_are_read() {
    let dir = Directory::new();
    dir.sidecar(
        "ap",
        r#"{"PhaseEncodingDirection":"j-","TotalReadoutTime":0.05}"#,
    );
    dir.sidecar(
        "pa",
        r#"{"PhaseEncodingDirection":"j","TotalReadoutTime":0.1}"#,
    );
    let result = dir.run(&[]);
    assert!(!result.status.success());
    let error = String::from_utf8_lossy(&result.stderr);
    assert!(error.contains("same TotalReadoutTime"), "{error}");
    assert!(!dir.0.join("out_fieldmap.nii.gz").exists());
}

#[test]
fn the_explicit_common_readout_must_be_finite_and_positive() {
    let dir = Directory::new();
    for value in ["NaN", "inf", "0", "-0.05"] {
        let result = dir.run(&["--pe1", "j-", "--pe2", "j", "--trt", value]);
        assert!(!result.status.success());
        let error = String::from_utf8_lossy(&result.stderr);
        assert!(
            error.contains("finite positive TotalReadoutTime"),
            "{error}"
        );
    }
}

fn image(path: &Path) {
    let mut bytes = vec![0u8; 352];
    bytes[..4].copy_from_slice(&348i32.to_le_bytes());
    for (index, value) in [3i16, 4, 8, 3, 1, 1, 1, 1].into_iter().enumerate() {
        bytes[40 + 2 * index..42 + 2 * index].copy_from_slice(&value.to_le_bytes());
    }
    bytes[70..72].copy_from_slice(&16i16.to_le_bytes());
    bytes[72..74].copy_from_slice(&32i16.to_le_bytes());
    bytes[108..112].copy_from_slice(&352f32.to_le_bytes());
    bytes[112..116].copy_from_slice(&1f32.to_le_bytes());
    bytes[254..256].copy_from_slice(&2i16.to_le_bytes());
    for offset in [76, 80, 84, 88, 92, 96, 100, 104, 280, 300, 320] {
        bytes[offset..offset + 4].copy_from_slice(&1f32.to_le_bytes());
    }
    bytes[123] = 2;
    bytes[344..348].copy_from_slice(b"n+1\0");
    for z in 0..3 {
        for y in 0..8 {
            for x in 0..4 {
                bytes.extend(((x + 2 * y + 3 * z + 1) as f32).to_le_bytes());
            }
        }
    }
    std::fs::write(path, bytes).unwrap();
}

#[test]
fn explicit_direction_and_common_readout_overrides_still_write_the_field() {
    let dir = Directory::new();
    image(&dir.0.join("ap.nii"));
    image(&dir.0.join("pa.nii"));
    dir.sidecar(
        "ap",
        r#"{"PhaseEncodingDirection":"invalid","TotalReadoutTime":0.1}"#,
    );
    dir.sidecar("pa", "{}");
    let result = dir.run(&["--pe1", "j-", "--pe2", "j", "--trt", "0.05"]);
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let metadata: serde_json::Value =
        serde_json::from_slice(&std::fs::read(dir.0.join("out_fieldmap.json")).unwrap()).unwrap();
    assert_eq!(metadata["PhaseEncodingDirection"], "j-");
    assert_eq!(metadata["TotalReadoutTime"], 0.05);
    assert_eq!(metadata["Units"], "Hz");
    assert!(dir.0.join("out_fieldmap.nii.gz").exists());
}
