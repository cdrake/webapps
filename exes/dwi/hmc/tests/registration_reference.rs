//! `registration::nifreeze_argv` against every command that NiFreeze ran in the M0 reference:
//! `nifreeze-*/work/cmd-NNNNN.sh` of the six runs, 540 in all, with the run directories removed
//! and each bracket group joined into one word. Data-gated on the `nifreeze-replay` subset
//! (`HMC_REFERENCE`, see `tests/common`).

mod common;

use common::{bracket_words, reference};
use dwi_hmc::Precision;
use dwi_hmc::registration::{RegistrationFiles, nifreeze_argv};

const RUNS: [&str; 6] = [
    "nifreeze-trivial-a1",
    "nifreeze-trivial-a2",
    "nifreeze-trivial-float",
    "nifreeze-gp",
    "nifreeze-gp-float",
    "nifreeze-gp-seed1235",
];

#[test]
fn builder_writes_every_kept_command() {
    let Some(root) = reference("nifreeze-replay") else {
        return;
    };
    for run in RUNS {
        let host = format!("/var/tmp/dwi-hmc/runs/{run}/work/");
        for v in 0..90 {
            let path = root.join(format!("{run}/work/cmd-{v:05}.sh"));
            let kept = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path:?}: {e}"));
            let words = bracket_words(&kept.replace(&host, ""));
            assert_eq!(words[0], "antsRegistration", "{run} {v}");
            let (fixed, moving, output) = (
                format!("predicted_{v:05}.nii.gz"),
                format!("sample_{v:05}.nii.gz"),
                format!("ants-{v:05}"),
            );
            let files = RegistrationFiles {
                fixed: &fixed,
                moving: &moving,
                mask: "brainmask.nii.gz",
                output: &output,
            };
            // nipype rendered the two float runs with `float=True`.
            let precision = if run.ends_with("-float") {
                Precision::Float
            } else {
                Precision::Double
            };
            assert_eq!(
                nifreeze_argv(files, precision, None),
                words[1..],
                "{run} volume {v}"
            );
        }
    }
    eprintln!("nifreeze_argv equals all {} kept commands", RUNS.len() * 90);
}
