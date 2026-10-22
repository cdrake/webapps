// SPDX-License-Identifier: Apache-2.0
//! The `antsRegistration` arguments of NiFreeze 3bcfb00 for one volume.
//!
//! NiFreeze uses `b0-to-b0_level0.json` for every volume (`registration/ants.py:280-295`; no code
//! path selects `dwi-to-b0_level0`) and adds `--masks [ brainmask, NULL ]` after each stage
//! (`ants.py:412-415`). The fixed image is the model's prediction and the moving image the raw
//! volume. nipype renders the arguments with spaces inside the brackets (`Rigid[ 12.0 ]`) and
//! runs them through a shell; [`nifreeze_argv`] writes each bracket group as one word, which
//! native ANTs 52bc0ab parses to the same transform, byte for byte.
//!
//! Native NiFreeze runs double precision and seeds ANTs through `ANTS_RANDOM_SEED`. The
//! WebAssembly kernel compiles only `--float 1` (Q53) and cannot read the environment, so the
//! port passes `--float 1` and `--random-seed`; with `--random-seed 1234` native ANTs writes the
//! same transform as with `ANTS_RANDOM_SEED=1234`.

use crate::Precision;

/// The files of one registration, as the kernel's argv names them.
#[derive(Clone, Copy, Debug)]
pub struct RegistrationFiles<'a> {
    /// The prediction.
    pub fixed: &'a str,
    /// The raw volume.
    pub moving: &'a str,
    /// The brain mask, on the fixed image's grid.
    pub mask: &'a str,
    /// The output prefix: the transform is `<output>0GenericAffine.mat`.
    pub output: &'a str,
}

/// NiFreeze's argv for one volume, without the program name. [`Precision::Double`] adds no
/// precision flag, as NiFreeze does; [`Precision::Float`] adds `--float 1` after
/// `--dimensionality`, where nipype renders it. `seed` adds `--random-seed` at the end.
pub fn nifreeze_argv(
    files: RegistrationFiles,
    precision: Precision,
    seed: Option<u32>,
) -> Vec<String> {
    let RegistrationFiles {
        fixed,
        moving,
        mask,
        output,
    } = files;
    let stage = |step: &str, sampling: &str, convergence: &str, sigma: &str, shrink: &str| {
        [
            "--transform".to_string(),
            format!("Rigid[{step}]"),
            "--metric".to_string(),
            format!("GC[{fixed},{moving},1,{sampling}]"),
            "--convergence".to_string(),
            format!("[{convergence}]"),
            "--smoothing-sigmas".to_string(),
            format!("{sigma}vox"),
            "--shrink-factors".to_string(),
            shrink.to_string(),
            "--use-histogram-matching".to_string(),
            "1".to_string(),
            "--masks".to_string(),
            format!("[{mask},NULL]"),
        ]
    };
    let mut argv: Vec<String> = ["--collapse-output-transforms", "1", "--dimensionality", "3"]
        .map(String::from)
        .to_vec();
    // nipype renders `float=True` here, as in the M0 float runs.
    if precision == Precision::Float {
        argv.extend(["--float".to_string(), "1".to_string()]);
    }
    argv.extend(
        [
            "--initialize-transforms-per-stage",
            "0",
            "--interpolation",
            "Linear",
            "--output",
            output,
        ]
        .map(String::from),
    );
    argv.extend(stage("12.0", "3,Random,0.4", "20,1e-06,4", "2.71", "3"));
    argv.extend(stage("1.96", "4,Random,0.18", "10,1e-07,2", "0.0", "2"));
    argv.extend(
        [
            "-v",
            "--winsorize-image-intensities",
            "[0.063,0.991]",
            "--write-composite-transform",
            "0",
        ]
        .map(String::from),
    );
    if let Some(seed) = seed {
        argv.extend(["--random-seed".to_string(), seed.to_string()]);
    }
    argv
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `nifreeze-gp/work/cmd-00000.sh` of the M0 reference with its directories removed and each
    /// bracket group joined (`Rigid[ 12.0 ]` → `Rigid[12.0]`). `tests/registration_reference.rs`
    /// checks the builder against all 540 kept commands.
    const KEPT: &str = "--collapse-output-transforms 1 --dimensionality 3 --initialize-transforms-per-stage 0 --interpolation Linear --output ants-00000 --transform Rigid[12.0] --metric GC[predicted_00000.nii.gz,sample_00000.nii.gz,1,3,Random,0.4] --convergence [20,1e-06,4] --smoothing-sigmas 2.71vox --shrink-factors 3 --use-histogram-matching 1 --masks [brainmask.nii.gz,NULL] --transform Rigid[1.96] --metric GC[predicted_00000.nii.gz,sample_00000.nii.gz,1,4,Random,0.18] --convergence [10,1e-07,2] --smoothing-sigmas 0.0vox --shrink-factors 2 --use-histogram-matching 1 --masks [brainmask.nii.gz,NULL] -v --winsorize-image-intensities [0.063,0.991] --write-composite-transform 0";

    const FILES: RegistrationFiles = RegistrationFiles {
        fixed: "predicted_00000.nii.gz",
        moving: "sample_00000.nii.gz",
        mask: "brainmask.nii.gz",
        output: "ants-00000",
    };

    #[test]
    fn double_without_seed_is_the_kept_command() {
        assert_eq!(
            nifreeze_argv(FILES, Precision::Double, None).join(" "),
            KEPT
        );
    }

    #[test]
    fn the_port_adds_float_and_the_seed() {
        let argv = nifreeze_argv(FILES, Precision::Float, Some(1234));
        assert_eq!(argv[4..6], ["--float", "1"]);
        assert_eq!(argv[argv.len() - 2..], ["--random-seed", "1234"]);
        let rest: Vec<&str> = argv[..4]
            .iter()
            .chain(&argv[6..argv.len() - 2])
            .map(String::as_str)
            .collect();
        assert_eq!(rest.join(" "), KEPT);
    }
}
