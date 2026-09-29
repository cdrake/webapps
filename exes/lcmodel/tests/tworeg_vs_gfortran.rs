//! NEXTRE, INFLEC, get_field and conc_prior (with parse_prior and
//! parse_sum) against tests/data/tworeg_driver.f, compiled with
//! `gfortran -std=legacy -O2` together with those subprograms, lcmodel.inc
//! and a printing ERRMES stub. Reals are compared bit for bit (hex).
use lcmodel::fortran::FStr;
use lcmodel::tworeg::{get_field, inflec, nextre};
use lcmodel::{ErrQueue, Lcm};

fn h64(x: f64) -> String {
    format!("{:016X}", x.to_bits())
}

fn h32(x: f32) -> String {
    format!("{:08X}", x.to_bits())
}

fn p64(s: &str) -> f64 {
    f64::from_bits(u64::from_str_radix(s, 16).unwrap())
}

fn run() -> Vec<String> {
    let expected: Vec<&str> = include_str!("data/tworeg_driver.txt").lines().collect();
    let mut out = Vec::new();
    let mut k = 0;
    // Lineshape cases: inputs are read from the gfortran output itself.
    while expected[k].starts_with("LS") {
        let f: Vec<&str> = expected[k].split_whitespace().collect();
        let n: i32 = f[1].parse().unwrap();
        let th = f32::from_bits(u32::from_str_radix(f[2], 16).unwrap());
        let im: i32 = f[3].parse().unwrap();
        let p: Vec<f64> = expected[k + 1].split_whitespace().skip(1).map(p64).collect();
        let g: Vec<f64> = expected[k + 2].split_whitespace().skip(1).map(p64).collect();
        let mut dy = vec![0f64; 90];
        let mut dz = vec![0f64; 90];
        let i1 = nextre(&p, n, &mut dy, &g, th, im);
        let i2 = inflec(&p, n, &mut dz, &g, th, im);
        out.push(expected[k].to_string());
        out.push(expected[k + 1].to_string());
        out.push(expected[k + 2].to_string());
        out.push(format!("R{i1:4}{i2:4}"));
        out.push(format!("DN {}", dy[..(2 * n + 6) as usize].iter().map(|x| h64(*x)).collect::<Vec<_>>().join(" ")));
        out.push(format!("DI {}", dz[..(2 * n + 10) as usize].iter().map(|x| h64(*x)).collect::<Vec<_>>().join(" ")));
        k += 6;
    }
    // get_field.
    let strs = [
        "NAAG/NAA = 0.15 +- 0.15",
        "  = 1",
        "x =  abc +- 1",
        "x = 1.2.3 +- 1",
        "x = 0.123456789012 +- 1",
        "x = 1 +- 2 +WT= GPC+PCh",
        "x = 1 +- 2 +WT= GPC+PCh",
        "x = 3E-2+-1",
        "x = 1 +- 2   ",
    ];
    let seps = ["=", "=", "+-", "+-", "+-", "+WT=", " ", "+-", "+WT="];
    let lsep = [1, 1, 2, 2, 2, 4, 0, 2, 4];
    let ityp = [1, 1, 2, 2, 2, 2, 1, 2, 2];
    let iate = [0, 0, 0, 0, 0, 1, 2, 0, 1];
    let ist = [1, 1, 4, 4, 4, 9, 16, 4, 9];
    for ic in 0..9 {
        let s = FStr::new(40, strs[ic]);
        let mut chr = FStr::new(40, "#");
        let mut fr: f32 = -7.0;
        let mut istart = ist[ic];
        let mut q = ErrQueue::new();
        get_field(seps[ic], lsep[ic], ityp[ic], iate[ic], &mut chr, &mut fr, &mut istart, s.len_trim() as i32, &s, &mut q).unwrap();
        assert!(q.calls.is_empty());
        out.push(format!("GF{:3}{:4} {} {}", ic + 1, istart, h32(fr), chr.trim()));
    }
    // conc_prior.
    let mut lcm = Lcm::new();
    let c = &mut lcm.c;
    c.lprint = 0;
    c.ipdump = 0;
    c.nmetab = 7;
    for (j, name) in ["NAA", "NAAG", "Cr", "PCr", "GPC", "PCh", "Ins"].iter().enumerate() {
        c.nacomb[j as i32 + 1].set(name);
    }
    for (j, v) in [1.3, 0.2, 0.7, 0.45, 0.21, 0.0, 0.9].iter().enumerate() {
        c.solbes[(j as i32 + 1, 1)] = *v;
    }
    c.fcsum = 0.01;
    c.nnorat = 1;
    c.norato[1].set("Ins");
    let chrato = [
        "NAAG/NAA = 0.15 +- 0.15",
        "PCr/Cr+PCr = 0.5 +- 0.1 +WT= GPC",
        "GPC/totCho = 0.6 +- 0.2",
        "PCh/Big3 = 0.1 +- 0.05",
        "Cr/P* = 0.3 +- 0.1",
        "Glu/Cr = 1 +- 1",
        "NAA/Lac = 1 +- 1",
        "Ins/Cr = 1 +- .5",
        "NAA/PCh = 2 +- 1",
    ];
    c.nratio = chrato.len() as i32;
    for (j, s) in chrato.iter().enumerate() {
        let j = j as i32 + 1;
        c.chrato[j].set(s);
        c.chratw[j].set(" ");
        c.chrati[j].set(" ");
    }
    lcm.conc_prior().unwrap();
    let c = &lcm.c;
    out.push(format!("NU{:4}", c.nratio_used));
    for j in 1..=c.nratio {
        out.push(format!("CI{:3} {} {}", j, c.chrati[j].trim(), c.chratw[j].trim()));
    }
    for j in 1..=c.nratio_used {
        out.push(format!(
            "CU{:4}{:4} {} {} {} {}",
            j,
            c.lmetab_prior[j],
            h32(c.sqrtwt_ratio_used[j]),
            h32(c.exrati[j]),
            h32(c.sdrati[j]),
            c.chrato[j].trim()
        ));
        out.push(format!("CP {}", (1..=c.nmetab).map(|k| h32(c.cprior[(j, k)])).collect::<Vec<_>>().join(" ")));
    }
    // The printed prior matrix and the CHRATO list.
    lcm.c.lprint = 6;
    lcm.c.ipdump = 3;
    lcm.conc_prior().unwrap();
    lcm.c.ipdump = 0;
    lcm.conc_prior().unwrap();
    out.extend(lcm.io.stdout.lines().map(|l| l.to_string()));
    out
}

#[test]
fn matches_gfortran() {
    let expected: Vec<&str> = include_str!("data/tworeg_driver.txt").lines().collect();
    let got = run();
    assert_eq!(got.len(), expected.len());
    for (k, (g, e)) in got.iter().zip(expected.iter()).enumerate() {
        assert_eq!(g.trim_end(), e.trim_end(), "line {}", k + 1);
    }
}
