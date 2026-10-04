//! io_loadspec_GE against FID-A on the FID-A example P-files.
#[path = "readers_common/mod.rs"]
mod common;
use common::*;

fn case(name: &str, rel: &str, subspecs: usize) {
    let Some(dir) = data_dir(name) else { return };
    let Some(bytes) = input(&dir, rel) else { return };
    let Some(r) = reference(&dir, name) else { return };
    let rw = reference(&dir, &format!("{name}_wref")).expect("water reference export");
    let res = fida::io::ge::load(&bytes, subspecs).expect("GE load");
    compare(name, &res.out, &r, &[]);
    compare(&format!("{name}_wref"), &res.out_w, &rw, &[]);
}

#[test]
fn ge_press() {
    case("ge_press", "GE/sample01_press/press/P17920.7", 1);
}

#[test]
fn ge_megapress() {
    case("ge_megapress", "GE/sample02_megapress/megapress/P21504.7", 2);
}

#[test]
fn ge_truncated() {
    let Some(dir) = data_dir("ge_truncated") else { return };
    let Some(bytes) = input(&dir, "GE/sample01_press/press/P17920.7") else { return };
    for cut in [100usize, 5000, 70000, bytes.len() / 2, bytes.len() - 1] {
        assert!(fida::io::ge::load(&bytes[..cut], 1).is_err());
    }
}
