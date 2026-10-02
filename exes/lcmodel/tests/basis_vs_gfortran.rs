//! GETPHA, INTEGRATE, AREAWA and SET_LSHAPE_FALSE against gfortran -O3
//! (tests/data/basis_gfortran.f); values are compared bit for bit.
use lcmodel::basis::{getpha, integrate};
use lcmodel::fortran::{cmplx, C32};
use lcmodel::{ErrQueue, Lcm};

fn section<'a>(text: &'a str, name: &str) -> Vec<&'a str> {
    let mut lines = text.lines().skip_while(|l| l.trim() != name);
    lines.next().expect(name);
    lines.take_while(|l| !l.trim().ends_with("_IN") && !l.trim().ends_with("_OUT")).collect()
}

fn hex_words(lines: &[&str]) -> Vec<u32> {
    lines.iter().flat_map(|l| l.split_whitespace()).map(|w| u32::from_str_radix(w, 16).unwrap()).collect()
}

fn complexes(lines: &[&str]) -> Vec<C32> {
    hex_words(lines).chunks(2).map(|p| cmplx(f32::from_bits(p[0]), f32::from_bits(p[1]))).collect()
}

fn assert_bits(got: &[C32], want: &[C32], what: &str) {
    assert_eq!(got.len(), want.len());
    for (k, (g, w)) in got.iter().zip(want).enumerate() {
        assert_eq!((g.re.to_bits(), g.im.to_bits()), (w.re.to_bits(), w.im.to_bits()), "{what}[{}]: {g:?} vs {w:?}", k + 1);
    }
}

#[test]
fn matches_gfortran() {
    let text = include_str!("data/basis_gfortran.txt");
    assert!(!text.contains("ERRMES"));

    // GETPHA
    let dataf = complexes(&section(text, "GETPHA_IN"));
    let n = dataf.len() as i32;
    let mut dataw = dataf.clone();
    let (mut ks, mut ke) = (118, 138);
    let mut np = ke - ks + 1;
    let radian = 3.14159265f32 / 180.0;
    let mut degz = 0.0f32;
    let mut yo = vec![0f32; 256];
    let mut yi = vec![0f32; 256];
    let mut q = ErrQueue::new();
    getpha(&mut ks, &mut ke, &dataf, &mut dataw, n, radian, &mut np, &mut yo, &mut yi, &mut degz, &mut q).unwrap();
    let out = section(text, "GETPHA_OUT");
    let head: Vec<&str> = out[0].split_whitespace().collect();
    assert_eq!((ks, ke, np), (head[0].parse().unwrap(), head[1].parse().unwrap(), head[2].parse().unwrap()));
    assert_eq!(degz.to_bits(), u32::from_str_radix(head[3], 16).unwrap());
    assert_bits(&dataw, &complexes(&out[1..]), "GETPHA DATAW");

    // INTEGRATE on the phased spectrum
    let (mut ks, mut ke) = (110, 146);
    let mut rint = 0f32;
    integrate(&dataw, 0.0123, &mut rint, &mut ke, &mut ks, 128, n, 12);
    let out = section(text, "INTEGRATE_OUT");
    let w: Vec<&str> = out[0].split_whitespace().collect();
    assert_eq!((ks, ke), (w[0].parse().unwrap(), w[1].parse().unwrap()));
    assert_eq!(rint.to_bits(), u32::from_str_radix(w[2], 16).unwrap(), "INTEGRATE {rint}");

    // AREAWA (log-linear regression branch)
    let mut l = Lcm::new();
    l.c.nunfil = 512;
    l.c.ppminc = 0.0153;
    l.c.rrange = 1.0e30;
    l.c.nwsst = 3;
    l.c.nwsend = 40;
    l.c.iareaw = 1;
    for (k, z) in complexes(&section(text, "AREAWA_IN")).into_iter().enumerate() {
        l.c.h2ot[k as i32 + 1] = z;
    }
    let a = l.areawa(1).unwrap();
    let want = hex_words(&section(text, "AREAWA_OUT"))[0];
    assert_eq!(a.to_bits(), want, "AREAWA {a} vs {}", f32::from_bits(want));

    // SET_LSHAPE_FALSE
    let mut l = Lcm::new();
    l.c.ndata = 512;
    l.c.nmetab = 2;
    l.c.pi = 3.14159265;
    l.c.fwhmst = 0.09;
    l.c.fwhmba = 0.03;
    l.c.deltat = 2.5e-4;
    l.c.hzpppm = 123.2;
    l.c.rrange = 1.0e30;
    for (k, z) in complexes(&section(text, "LSHAPE_IN")).into_iter().enumerate() {
        l.c.basist[(k as i32 + 1, 2)] = z;
    }
    l.set_lshape_false().unwrap();
    assert!(!l.c.lshape[2]);
    let want = complexes(&section(text, "LSHAPE_OUT"));
    assert_bits(&l.c.basist.col(2)[..512], &want, "SET_LSHAPE_FALSE BASIST");
}
