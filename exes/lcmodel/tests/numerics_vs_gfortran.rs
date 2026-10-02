//! numerics.rs against gfortran: tests/data/numerics_driver.f calls LCModel's
//! own FFT, SEQTOT, RANDOM, DGAMLN, BETAIN, FISHNI, PNNLS, EIGVrs and PLPRIN
//! (built as the native binary is, -O3) and writes every result as its bit
//! pattern or a hash of bit patterns into tests/data/numerics_ref.txt. This
//! test repeats the driver in Rust and requires the same text.
use lcmodel::fortran::{cmplx, C32, C64};
use lcmodel::io::{Units, STDOUT};
use lcmodel::numerics::*;
use lcmodel::ErrQueue;

struct Out {
    lines: Vec<String>,
}

fn hshr(h: &mut i64, x: f32) {
    let iu = x.to_bits() as i64;
    *h = (*h * 1000003 + iu) % 2147483647;
}

fn hshd(h: &mut i64, d: f64) {
    let b = d.to_bits();
    *h = (*h * 1000003 + (b & 0xFFFF_FFFF) as i64) % 2147483647;
    *h = (*h * 1000003 + (b >> 32) as i64) % 2147483647;
}

impl Out {
    fn head(&mut self, tag: &str, n: usize, h: i64) {
        self.lines.push(format!("{tag} {n:>5} {h:>12}"));
    }
    fn prc(&mut self, tag: &str, c: &[C32]) {
        let mut h = 0;
        for z in c {
            hshr(&mut h, z.re);
            hshr(&mut h, z.im);
        }
        self.head(tag, c.len(), h);
        if c.len() <= 16 {
            for z in c {
                self.lines.push(format!(" {:08X} {:08X}", z.re.to_bits(), z.im.to_bits()));
            }
        }
    }
    fn prz(&mut self, tag: &str, c: &[C64]) {
        let mut h = 0;
        for z in c {
            hshd(&mut h, z.re);
            hshd(&mut h, z.im);
        }
        self.head(tag, c.len(), h);
        if c.len() <= 16 {
            for z in c {
                self.lines.push(format!(" {:016X} {:016X}", z.re.to_bits(), z.im.to_bits()));
            }
        }
    }
    fn prr(&mut self, tag: &str, x: &[f32]) {
        let mut h = 0;
        for &v in x {
            hshr(&mut h, v);
        }
        self.head(tag, x.len(), h);
        if x.len() <= 16 {
            for ch in x.chunks(8) {
                self.lines.push(ch.iter().map(|v| format!(" {:08X}", v.to_bits())).collect());
            }
        }
    }
    fn prd(&mut self, tag: &str, x: &[f64]) {
        let mut h = 0;
        for &v in x {
            hshd(&mut h, v);
        }
        self.head(tag, x.len(), h);
        if x.len() <= 16 {
            for ch in x.chunks(4) {
                self.lines.push(ch.iter().map(|v| format!(" {:016X}", v.to_bits())).collect());
            }
        }
    }
    fn errq(&mut self, q: ErrQueue) {
        for (n, l, s) in q.calls {
            self.lines.push(format!("ERRMES{n:>4}{l:>4} {s:<6}"));
        }
    }
}

fn mkdat(n: usize) -> Vec<C32> {
    (1..=n as i32)
        .map(|j| cmplx(((j * 7919) % 1009 - 504) as f32 / 128.0, ((j * 104729) % 2003 - 1001) as f32 / 256.0))
        .collect()
}

fn tseq(o: &mut Out, n: usize, spike: bool, lwfft: &mut i32, wfftc: &mut [f32]) {
    let mut dt = mkdat(n);
    if spike {
        for j in 1..=n {
            let t = (n - j) as f32 / n as f32;
            // gfortran expands X**4 as (X*X)*(X*X).
            let t2 = t * t;
            dt[j - 1] = dt[j - 1] * (t2 * t2);
        }
        for j in n - 30..=n {
            dt[j - 1] = C32::ZERO;
        }
        dt[n - 4] = cmplx(1.0e-3, 2.0e-3);
    }
    let mut df = vec![C32::ZERO; 8192];
    seqtot(&mut dt, &mut df, n as i32, lwfft, wfftc);
    o.prc("SEQTOT", &dt[..n]);
    o.prc("SEQTOTF", &df[..2 * n]);
}

fn tpnnls(o: &mut Out, m: i32, n: i32, kind: i32) {
    const MDA: i32 = 45;
    let ia = |i: i32, j: i32| ((i - 1) + MDA * (j - 1)) as usize;
    let mut a = vec![0.0f64; (MDA * 20) as usize];
    let mut b = vec![0.0f64; MDA as usize];
    let mut nonneg = vec![false; 20];
    let mut xt = vec![0.0f64; 20];
    for j in 1..=n {
        for i in 1..=m {
            a[ia(i, j)] = ((i * 37 + j * 101 + i * j * 13) % 97 - 48) as f64 / 16.0;
        }
        nonneg[(j - 1) as usize] = kind == 0 || j % 3 != 0;
        xt[(j - 1) as usize] = ((j * 7) % 11 - 4) as f64 / 3.0;
    }
    for i in 1..=m {
        let iu = (i - 1) as usize;
        b[iu] = ((i * 53) % 89 - 44) as f64 / 8.0;
        if kind == 2 {
            b[iu] = b[iu] * 1.0e-2;
            for j in 1..=n {
                b[iu] = b[iu] + a[ia(i, j)] * xt[(j - 1) as usize];
            }
        }
    }
    let (mut x, mut w, mut zz, mut index) = (vec![0.0; 20], vec![0.0; 20], vec![0.0; MDA as usize], vec![0; 20]);
    let (mut dvar, mut mode, mut nsetp) = (0.0f64, 0, 0);
    let mut q = ErrQueue::new();
    pnnls(&mut a, MDA, m, n, &mut b, &mut x, &mut dvar, &mut w, &mut zz, &mut index, &mut mode, 1.0e30, &nonneg, 0.5, &mut nsetp, &mut q).unwrap();
    o.errq(q);
    o.lines.push(format!("PNNLS{m:>5}{n:>5}{mode:>5}{nsetp:>5}"));
    o.lines.push(index[..n as usize].iter().map(|k| format!("{k:>4}")).collect());
    o.prd("DVAR", &[dvar]);
    o.prd("X", &x[..n as usize]);
    o.prd("W", &w[..n as usize]);
    let ap: Vec<f64> = (1..=n).flat_map(|j| (1..=m).map(move |i| (i, j))).map(|(i, j)| a[ia(i, j)]).collect();
    o.prd("A", &ap);
    o.prd("B", &b[..m as usize]);
}

fn teig(o: &mut Out, n: i32, kind: i32) {
    const NM: i32 = 8;
    let iz = |i: i32, j: i32| ((i - 1) + NM * (j - 1)) as usize;
    let mut a = vec![0.0f32; 64];
    for j in 1..=NM {
        for i in 1..=NM {
            a[iz(i, j)] = ((i * j * 7 + i + j) % 23 - 11) as f32 / 4.0;
            if kind == 1 {
                a[iz(i, j)] = 0.0;
            }
            if kind == 2 {
                a[iz(i, j)] = 1.0 / (i + j - 1) as f32;
            }
        }
        if kind == 1 {
            a[iz(j, j)] = (j % 3) as f32;
        }
    }
    let (mut w, mut z, mut fv1, mut fv2) = (vec![0.0f32; 8], vec![0.0f32; 64], vec![0.0f32; 8], vec![0.0f32; 8]);
    let mut ierr = 0;
    eigvrs(NM, n, &a, &mut w, &mut z, &mut fv1, &mut fv2, &mut ierr);
    o.lines.push(format!("EIGVRS{n:>5}{kind:>5}{ierr:>5}"));
    if ierr != 0 {
        return;
    }
    o.prr("W", &w[..n as usize]);
    o.prr("Z", &z[..(NM * n) as usize]);
}

fn tplot(o: &mut Out, kind: i32) {
    let n: i32 = if kind == 4 { 30 } else { 12 };
    let mut x = vec![0.0f32; 40];
    let mut y1 = vec![0.0f32; 40];
    let mut y2 = vec![0.0f32; 40];
    let mut yerr = vec![0.0f64; 40];
    for j in 1..=n {
        let u = (j - 1) as usize;
        x[u] = j as f32 * 0.5;
        y1[u] = ((j * 17) % 23 - 11) as f32 * 0.37;
        y2[u] = ((j * 29) % 19 - 9) as f32 * 0.41;
        yerr[u] = ((j * 5) % 7 + 1) as f64 * 0.123;
    }
    let only1 = kind == 1 || kind == 3;
    let plterr = kind >= 3;
    let nlinf = if kind >= 2 { 5 } else { 0 };
    let my1 = if kind == 2 { 4 } else { n - 1 };
    let mut io = Units::new();
    plprin(&x, &y1, &y2, n, only1, STDOUT, 1.0e30, nlinf, 1, my1, &yerr, plterr, &mut io);
    o.lines.extend(io.stdout.lines().map(|l| l.to_string()));
}

fn run_driver() -> Vec<String> {
    let mut o = Out { lines: Vec::new() };
    let ns = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 15, 16, 25, 30, 49, 64, 77, 98, 120, 143, 210, 256, 1000, 1024, 2048];
    let mut wfftc = vec![0.0f32; 4 * 4096 + 15];
    let mut dwfftc = vec![0.0f64; 4 * 4096 + 15];
    let (mut lwfft, mut ldwfft) = (0, 0);
    for &n in ns.iter() {
        let dt = mkdat(n);
        let ddt: Vec<C64> = dt.iter().map(|&c| C64::from(c)).collect();
        let (mut ft, mut fw, mut fi) = (vec![C32::ZERO; n], vec![C32::ZERO; n], vec![C32::ZERO; n]);
        let ni = n as i32;
        cfft(&dt, &mut ft, ni, &mut lwfft, &mut wfftc);
        o.prc("CFFT", &ft);
        cfftin(&ft, &mut fi, ni, &mut lwfft, &mut wfftc);
        o.prc("CFFTIN", &fi);
        cfft_r(&dt, &mut ft, ni, &mut lwfft, &mut wfftc);
        o.prc("CFFT_R", &ft);
        cfftin_r(&ft, &mut fw, &mut fi, ni, &mut lwfft, &mut wfftc);
        o.prc("CFFTIN_R", &fi);
        let mut dft = vec![C64::ZERO; n];
        dcfft_r(&ddt, &mut dft, ni, &mut ldwfft, &mut dwfftc);
        o.prz("DCFFT_R", &dft);
        if n <= 64 {
            csft_r(&dt, &mut ft, ni);
            o.prc("CSFT_R", &ft);
            csftin_r(&ft, &mut fw, &mut fi, ni);
            o.prc("CSFTIN_R", &fi);
        }
    }
    tseq(&mut o, 100, false, &mut lwfft, &mut wfftc);
    tseq(&mut o, 256, false, &mut lwfft, &mut wfftc);
    tseq(&mut o, 256, true, &mut lwfft, &mut wfftc);
    tseq(&mut o, 2048, true, &mut lwfft, &mut wfftc);
    // RANDOM
    let mut dix = 1234567.0f64;
    let xs: Vec<f32> = (0..5000).map(|_| random(&mut dix)).collect();
    o.prr("RANDOM", &xs);
    o.prr("RANDOM1", &xs[..8]);
    o.prd("DIX", &[dix]);
    // DGAMLN
    let g: Vec<f64> = (1..=400).map(|k| dgamln(k as f64 / 8.0 + k as f64 * 1.0e-3)).collect();
    o.prd("DGAMLN", &g);
    o.prd("DGAMLN1", &g[..12]);
    // BETAIN, FISHNI
    let ab = [0.5f32, 1., 2.5, 7., 30.25, 150., 1000.];
    let fs = [0.1f32, 0.5, 1., 2., 5., 20.];
    for &a in ab.iter() {
        for &b in ab.iter() {
            let mut y = Vec::new();
            for i in 0..=16 {
                let mut q = ErrQueue::new();
                y.push(betain(i as f32 / 16.0, a, b, 6, &mut q).unwrap());
                o.errq(q);
            }
            o.prr("BETAIN", &y);
        }
    }
    for &f in fs.iter() {
        let mut y = Vec::new();
        for &b in ab[..6].iter() {
            let mut q = ErrQueue::new();
            y.push(fishni(f, 2.0 * b + 1.0, 3.0 * b + 0.5, 6, &mut q).unwrap());
            o.errq(q);
        }
        o.prr("FISHNI", &y);
    }
    tpnnls(&mut o, 12, 5, 0);
    tpnnls(&mut o, 12, 5, 1);
    tpnnls(&mut o, 20, 8, 0);
    tpnnls(&mut o, 3, 5, 0);
    tpnnls(&mut o, 30, 12, 2);
    tpnnls(&mut o, 40, 20, 2);
    for n in 1..=9 {
        teig(&mut o, n, 0);
    }
    teig(&mut o, 5, 1);
    teig(&mut o, 6, 2);
    for k in 1..=4 {
        tplot(&mut o, k);
    }
    o.lines
}

#[test]
fn matches_gfortran_bit_for_bit() {
    let expected: Vec<&str> = include_str!("data/numerics_ref.txt").lines().collect();
    let got = run_driver();
    for (k, (g, e)) in got.iter().zip(expected.iter()).enumerate() {
        assert_eq!(g, e, "line {}", k + 1);
    }
    assert_eq!(got.len(), expected.len());
}

/// The FFTs against a direct DFT in double precision.
#[test]
fn ffts_match_direct_dft() {
    let mut wfftc = vec![0.0f32; 4 * 2048 + 15];
    let mut dwfftc = vec![0.0f64; 4 * 2048 + 15];
    let (mut lwfft, mut ldwfft) = (0, 0);
    for &n in [1usize, 6, 7, 30, 77, 143, 210, 1000, 2048].iter() {
        let dt = mkdat(n);
        let mut dft = vec![(0.0f64, 0.0f64); n];
        for (m, out) in dft.iter_mut().enumerate() {
            for (j, z) in dt.iter().enumerate() {
                let ang = -2.0 * std::f64::consts::PI * ((m * j) % n) as f64 / n as f64;
                out.0 += z.re as f64 * ang.cos() - z.im as f64 * ang.sin();
                out.1 += z.re as f64 * ang.sin() + z.im as f64 * ang.cos();
            }
            out.0 /= (n as f64).sqrt();
            out.1 /= (n as f64).sqrt();
        }
        let scale = dft.iter().map(|z| z.0.hypot(z.1)).fold(0.0, f64::max);
        let mut ft = vec![C32::ZERO; n];
        cfft(&dt, &mut ft, n as i32, &mut lwfft, &mut wfftc);
        for m in 0..n {
            assert!(((ft[m].re as f64 - dft[m].0).abs() + (ft[m].im as f64 - dft[m].1).abs()) < 1e-5 * scale, "cfft n={n} m={m}");
        }
        let mut back = vec![C32::ZERO; n];
        cfftin(&ft, &mut back, n as i32, &mut lwfft, &mut wfftc);
        for j in 0..n {
            assert!((back[j].re - dt[j].re).abs() + (back[j].im - dt[j].im).abs() < 1e-4 * scale as f32, "cfftin n={n}");
        }
        let ddt: Vec<C64> = dt.iter().map(|&c| C64::from(c)).collect();
        let mut dft_r = vec![C64::ZERO; n];
        dcfft_r(&ddt, &mut dft_r, n as i32, &mut ldwfft, &mut dwfftc);
        let h = n / 2;
        for m in 0..n {
            // Rearranged: FT(J) and FT(NUNFIL+J) swapped for J <= N/2 (and the
            // last point unscaled when N is odd).
            let (src, fact) = if m < h {
                (m + h, 1.0)
            } else if m < 2 * h {
                (m - h, 1.0)
            } else {
                (m, (n as f64).sqrt())
            };
            let e = dft[src];
            let g = dft_r[m];
            assert!(((g.re / fact - e.0).abs() + (g.im / fact - e.1).abs()) < 1e-6 * scale, "dcfft_r n={n} m={m}");
        }
    }
}
