//! GBACKG (with its region merges) and setup3 against gfortran -std=legacy -O2.
//! tests/data/startv_driver.f calls the original subprograms from LCModel.f
//! (lines 6465-6537 and 6697-6961) and wrote tests/data/startv_driver.txt.
use lcmodel::state::MBACKG;
use lcmodel::Lcm;

fn gbackg_case(icase: i32, out: &mut Vec<String>) {
    let mut l = Lcm::new();
    let c = &mut l.c;
    c.pi = 3.1415927;
    c.lprint = 0;
    c.ny = 480;
    c.ppminc = 0.0078125;
    c.ppmcen = 4.65;
    for jy in 1..=c.ny {
        c.delppm[jy] = -0.65 - (jy - 1) as f32 * c.ppminc;
    }
    c.ppmst = 4.0;
    c.ppmend = c.delppm[c.ny] + c.ppmcen;
    c.nbackg = 40;
    c.nbckmn = 6;
    c.rmsamp = 123.4;
    c.nmetab = 5;
    c.ppmpos[1] = 3.5;
    c.ppmpos[2] = 1.0;
    if icase == 1 {
        c.ngap = 0;
    } else {
        c.ngap = 3;
        c.ppmgap[(1, 1)] = 3.0;
        c.ppmgap[(2, 1)] = 2.8;
        c.ppmgap[(1, 2)] = 2.75;
        c.ppmgap[(2, 2)] = 2.6;
        c.ppmgap[(1, 3)] = 1.2;
        c.ppmgap[(2, 3)] = 1.15;
        if icase == 2 {
            c.ppmsep[1] = 2.9;
            c.ppmsep[2] = 2.7;
        } else {
            c.ppmsep[1] = 2.7;
            c.ppmsep[2] = 2.9;
            c.ppmsep[3] = 1.17;
        }
    }
    l.gbackg().unwrap();
    let c = &l.c;
    out.push(format!("NBACKG{:5}", c.nbackg));
    for k in 1..=MBACKG {
        for jy in 1..=c.ny {
            if c.backgr[(jy, k)] != 0. {
                out.push(format!("B{:5}{:5}{:12}", jy, k, c.backgr[(jy, k)].to_bits() as i32));
            }
        }
        for j in 1..=MBACKG {
            if c.regb[(j, k)] != 0. {
                out.push(format!("R{:5}{:5}{:12}", j, k, c.regb[(j, k)].to_bits() as i32));
            }
        }
    }
    for j in c.nmetab + 1..=c.nmetab + c.nbackg {
        out.push(format!("N{:5} {}", j, if c.nonneg[j] { "T" } else { "F" }));
    }
}

#[test]
fn gbackg_and_setup3_match_gfortran() {
    let mut out = Vec::new();
    for icase in 1..=3 {
        gbackg_case(icase, &mut out);
    }
    let mut l = Lcm::new();
    let c = &mut l.c;
    c.pi = 3.1415927;
    c.mpower = 2;
    c.power[1] = 1.0;
    c.power[2] = 1.7;
    c.fwhmst = 0.05;
    c.hzpppm = 123.2;
    c.tofwhm = 0.8;
    c.deltat = 2.5e-4;
    c.ndata = 64;
    c.fmain_power = 0.6;
    c.fother_power = 0.1;
    c.rpowmq = 2.;
    c.nmetab = 3;
    c.npower[1] = 2;
    c.npower[2] = 1;
    c.npower[3] = 2;
    for k in 1..=3 {
        for j in 1..=3 {
            c.fract_power_sd[(j, k)] = 0.5 / j as f32;
        }
    }
    c.lrt2st = 10;
    l.setup3().unwrap();
    let c = &l.c;
    out.push(format!("NNONL{:5}", c.nnonl));
    for j in 0..=c.nmetab {
        out.push(format!("LPOWEN{:5}{:5}", j, c.lpowen[j]));
    }
    for j in 1..=c.nnonl {
        out.push(format!("P{:5}{:21}", j, c.parnln[j].to_bits() as i64));
        out.push(format!("D{:5}{:21}", j, c.dparmq[j].to_bits() as i64));
    }
    for k in 1..=c.nmetab {
        for j in 1..=3 {
            out.push(format!("C{:5}{:5}{:21}", j, k, c.coeff_power_sd[(j, k)].to_bits() as i64));
        }
    }
    for k in 1..=c.ndata {
        for j in 1..=c.mpower {
            out.push(format!("T{:5}{:5}{:21}", j, k, c.tpower[(j, k)].to_bits() as i64));
        }
    }
    let expected: Vec<&str> = include_str!("data/startv_driver.txt").lines().collect();
    assert_eq!(out.len(), expected.len());
    for (k, (g, e)) in out.iter().zip(expected.iter()).enumerate() {
        assert_eq!(g, e, "line {k}");
    }
}
