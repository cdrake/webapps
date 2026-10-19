//! Times each step of the NODDI voxel fit on an oracle.json (AMICO_ORACLE):
//! cargo run --release -p dwi-amico --example profile
use dwi_amico::{Dictionary, N_WM, lasso, nnls};
use serde_json::Value;
use std::time::Instant;

fn nums(v: &Value) -> Vec<f64> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|x| x.as_f64().unwrap())
        .collect()
}

fn main() {
    let path = std::env::var("AMICO_ORACLE").expect("set AMICO_ORACLE");
    let oracle: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let bvals = nums(&oracle["bvals"]);
    let bvecs: Vec<[f64; 3]> = oracle["bvecs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| {
            let n = nums(v);
            [n[0], n[1], n[2]]
        })
        .collect();
    let t = Instant::now();
    let dict = Dictionary::new(&bvals, &bvecs).unwrap();
    println!("dictionary {:?}", t.elapsed());
    let voxels = oracle["voxels"].as_array().unwrap();
    let rows = bvals.len();
    let (mut ta, mut tn, mut tl, mut tf) = (0.0, 0.0, 0.0, 0.0);
    for v in voxels {
        let y = nums(&v["y"]);
        let n = dict.direction(&y).unwrap();
        let t = Instant::now();
        let wm = dict.atoms(n);
        ta += t.elapsed().as_secs_f64();
        let mut a = vec![0.0; rows * (N_WM + 1)];
        for r in 0..rows {
            for c in 0..N_WM {
                a[c * rows + r] = wm[r * N_WM + c];
            }
            a[N_WM * rows + r] = dict.iso(r);
        }
        let t = Instant::now();
        let _ = nnls::nnls(&mut a.clone(), rows, N_WM + 1, &mut y.clone());
        tn += t.elapsed().as_secs_f64();
        let t = Instant::now();
        let _ = lasso::lasso_nonneg(&a[..rows * N_WM], rows, N_WM, &y, 0.5, 0.001);
        tl += t.elapsed().as_secs_f64();
        let t = Instant::now();
        let _ = dict.fit(&y, n);
        tf += t.elapsed().as_secs_f64();
    }
    let k = voxels.len() as f64 / 1000.0;
    println!(
        "per voxel ms: atoms {:.3} nnls {:.3} lasso {:.3} whole fit {:.3}",
        ta / k,
        tn / k,
        tl / k,
        tf / k
    );
}
