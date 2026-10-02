//! The Rust port against the native gfortran LCModel on LCModel's test case:
//! every number in the .TABLE and .COORD outputs must agree.
use lcmodel::run_lcmodel;

fn numbers(text: &str) -> Vec<f64> {
    text.split(|c: char| c.is_whitespace() || c == '%' || c == '=' || c == ',')
        .filter_map(|t| t.parse::<f64>().ok())
        .collect()
}

/// Lines that differ only in the run date or version.
fn comparable(text: &str) -> Vec<String> {
    text.lines().filter(|l| !l.contains("LCModel (Version") && !l.contains("2026") && !l.contains("Data of:")).map(str::to_string).collect()
}

#[test]
fn test_lcm_matches_native() {
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/data/test_lcm/");
    let read = |f: &str| std::fs::read(format!("{dir}{f}")).unwrap();
    let control = String::from_utf8(read("control.file")).unwrap();
    let basis = read("3t.basis");
    let raw = read("data.raw");
    let r = run_lcmodel(&control, &[("3t.basis", &basis), ("data.raw", &raw)], "Tue Sep 29 03:26:46 2026");
    assert!(r.error.is_none(), "run failed: {:?}\n{}", r.error, r.stdout);
    for (out, native) in [("out.table", "native.table"), ("out.coord", "native.coord")] {
        let got = r.outputs.get(out).unwrap_or_else(|| panic!("no {out}; outputs {:?}", r.outputs.keys().collect::<Vec<_>>()));
        let want = String::from_utf8(read(native)).unwrap();
        let (g, w) = (comparable(got), comparable(&want));
        let gn: Vec<f64> = g.iter().flat_map(|l| numbers(l)).collect();
        let wn: Vec<f64> = w.iter().flat_map(|l| numbers(l)).collect();
        assert_eq!(gn.len(), wn.len(), "{out}: {} numbers vs {} native", gn.len(), wn.len());
        let mut worst = (0.0f64, 0usize);
        for (k, (a, b)) in gn.iter().zip(wn.iter()).enumerate() {
            let scale = b.abs().max(1e-30);
            let rel = (a - b).abs() / scale;
            if rel > worst.0 {
                worst = (rel, k);
            }
        }
        eprintln!("{out}: {} numbers, worst relative difference {:.3e} at #{}", gn.len(), worst.0, worst.1);
        let identical = g == w;
        eprintln!("{out}: byte-identical apart from date/version lines: {identical}");
        assert!(worst.0 <= 1e-3, "{out}: number #{} differs by {:.3e}", worst.1, worst.0);
    }
}
