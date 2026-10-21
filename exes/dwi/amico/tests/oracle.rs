//! Compares the port with AMICO 1.5.4 voxel by voxel. AMICO_ORACLE names an oracle.json that
//! tools/oracle.py wrote; without it the test is skipped, or fails when DWI_REQUIRE_ORACLE=1
//! (CI). `validation/fetch_oracle.py` fetches the pinned oracle.

use dwi_amico::{Dictionary, N_WM};
use serde_json::Value;

fn numbers(v: &Value) -> Vec<f64> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|x| x.as_f64().unwrap())
        .collect()
}

fn vec3(v: &Value) -> [f64; 3] {
    let n = numbers(v);
    [n[0], n[1], n[2]]
}

fn median(mut v: Vec<f64>) -> f64 {
    v.sort_by(f64::total_cmp);
    v[v.len() / 2]
}

fn percentile(mut v: Vec<f64>, p: f64) -> f64 {
    v.sort_by(f64::total_cmp);
    v[((v.len() - 1) as f64 * p) as usize]
}

#[test]
fn matches_amico_154() {
    let Ok(path) = std::env::var("AMICO_ORACLE") else {
        assert!(
            std::env::var("DWI_REQUIRE_ORACLE").as_deref() != Ok("1"),
            "DWI_REQUIRE_ORACLE=1 but AMICO_ORACLE is not set"
        );
        eprintln!("AMICO_ORACLE is not set; skipping");
        return;
    };
    let oracle: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let bvals = numbers(&oracle["bvals"]);
    let bvecs: Vec<[f64; 3]> = oracle["bvecs"]
        .as_array()
        .unwrap()
        .iter()
        .map(vec3)
        .collect();
    let dict = Dictionary::new(&bvals, &bvecs).unwrap();

    let norms = numbers(&oracle["norms"]);
    let worst_norm = (0..N_WM)
        .map(|a| ((dict.norm(a) - norms[a]) / norms[a]).abs())
        .fold(0.0, f64::max);
    let iso = numbers(&oracle["iso"]);
    let worst_iso = (0..iso.len())
        .map(|i| (dict.iso(i) - iso[i]).abs())
        .fold(0.0, f64::max);
    eprintln!("norms max rel diff {worst_norm:.2e}, iso max diff {worst_iso:.2e}");
    assert!(worst_norm < 1e-5);
    assert!(worst_iso < 1e-6);

    let (mut lut, mut own, mut angle) = (Vec::new(), Vec::new(), Vec::new());
    for v in oracle["voxels"].as_array().unwrap() {
        let y = numbers(&v["y"]);
        let want = [
            v["icvf"].as_f64().unwrap(),
            v["od"].as_f64().unwrap(),
            v["isovf"].as_f64().unwrap(),
        ];
        let at_lut = dict.fit(&y, vec3(&v["lutDir"]));
        lut.push(
            [at_lut.icvf, at_lut.od, at_lut.isovf]
                .iter()
                .zip(want)
                .map(|(a, b)| (a - b).abs())
                .fold(0.0, f64::max),
        );
        let n = dict.direction(&y).unwrap();
        let d = vec3(&v["dir"]);
        let dot = (n[0] * d[0] + n[1] * d[1] + n[2] * d[2]).abs().min(1.0);
        angle.push(dot.acos().to_degrees());
        let at_own = dict.fit(&y, n);
        own.push(
            [at_own.icvf, at_own.od, at_own.isovf]
                .iter()
                .zip(want)
                .map(|(a, b)| (a - b).abs())
                .fold(0.0, f64::max),
        );
    }
    eprintln!(
        "{} voxels. AMICO direction: median {:.2e}, p95 {:.2e}, max {:.2e}. Own direction: median {:.2e}, p95 {:.2e}. Direction angle median {:.2e} deg, p99 {:.2e}",
        lut.len(),
        median(lut.clone()),
        percentile(lut.clone(), 0.95),
        lut.iter().copied().fold(0.0, f64::max),
        median(own.clone()),
        percentile(own.clone(), 0.95),
        median(angle.clone()),
        percentile(angle, 0.99),
    );
    assert!(median(lut) < 1e-4);
    assert!(median(own) < 0.02);
}
