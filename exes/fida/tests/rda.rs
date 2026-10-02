//! io_loadspec_rda against FID-A on the synthetic files of validation/make_rda.py.
#[path = "readers_common/mod.rs"]
mod common;
use common::*;

fn case(name: &str, rel: &str) {
    let Some(dir) = data_dir(name) else { return };
    let Some(bytes) = input(&dir, rel) else { return };
    let Some(r) = reference(&dir, name) else { return };
    let s = fida::io::rda::load(&bytes).expect("rda");
    // FID-A stores the text 'na' / 'N/A' in these two fields
    compare(name, &s, &r, &["rawSubspecs", "pointsToLeftshift"]);
    assert_eq!((s.raw_subspecs, s.points_to_leftshift), (1, 0.0));
}

#[test]
fn rda_crlf() {
    case("rda_synthetic_crlf_rda", "RDA/synthetic_crlf.rda");
}

#[test]
fn rda_lf() {
    case("rda_synthetic_lf_rda", "RDA/synthetic_lf.rda");
}
