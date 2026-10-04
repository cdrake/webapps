//! FFTs (FFTPACK), PNNLS, the incomplete beta function, eigenvalues and other numerical kernels.
//!
//! Translated from LCModel.f 6.3-1N; see PORTING.md.
#![allow(unused_variables, unused_mut, unused_assignments, unused_imports, unreachable_code, unused_labels, clippy::all)]

use crate::format::{self, FVal, RKind, ReadErr};
use crate::fortran::*;
use crate::io::{self, Units, STDOUT};
use crate::state::*;
use crate::{fv, ErrQueue, Lcm};

/// SAVEd and static locals of this module's subprograms. The DATA constants
/// here (NTRYH, the FFTPACK rotation constants, RANDOM's A/P, SEQTOT's
/// NZERO/RENDS/RZERO, PNNLS's MFACTR/RFACTR, PLPRIN's CHAR) are never
/// assigned, so they are Rust constants.
#[derive(Default, Clone, Debug)]
pub struct Saves {}

// ---------------------------------------------------------------------------
// FFTPACK stores the INTEGER factor table IFAC in the REAL (or DOUBLE
// PRECISION) work array WSAVE, starting at WSAVE(4*N+1). These views give
// the same storage as INTEGERs.
// ---------------------------------------------------------------------------

fn ifac_view_f32(s: &mut [f32]) -> &mut [i32] {
    // SAFETY: f32 and i32 have the same size and alignment.
    unsafe { std::slice::from_raw_parts_mut(s.as_mut_ptr() as *mut i32, s.len()) }
}

fn ifac_view_f64(s: &mut [f64]) -> &mut [i32] {
    // SAFETY: an f64 holds two i32 and is at least as aligned.
    unsafe { std::slice::from_raw_parts_mut(s.as_mut_ptr() as *mut i32, s.len() * 2) }
}

/// The forward FFTPACK passes (PASSF*/CFFTF1 for REAL, DPASF*/DCFTF1 for
/// DOUBLE PRECISION) and the initialisation (CFFTI1/DCFTI1). The two
/// precisions are the same code; the rotation constants are literals of the
/// module's type, as in the Fortran (REAL literals in PASSF*, D literals in
/// DPASF*).
macro_rules! fftpack_forward {
    ($m:ident, $t:ty) => {
        pub(super) mod $m {
            #![allow(clippy::all)]
            type T = $t;

            /// CFFTI1 / DCFTI1 (N, WA, IFAC).
            pub(crate) fn cfti1(n: i32, wa: &mut [T], ifac: &mut [i32]) {
                const NTRYH: [i32; 4] = [3, 4, 2, 5];
                let wa_ = |i: i32| (i - 1) as usize;
                let fc = |i: i32| (i - 1) as usize;
                let mut nl = n;
                let mut nf = 0;
                let mut j = 0;
                let mut ntry = 0;
                'l101: loop {
                    j = j + 1;
                    if j - 4 <= 0 {
                        ntry = NTRYH[(j - 1) as usize];
                    } else {
                        ntry = ntry + 2;
                    }
                    // 104
                    loop {
                        let nq = nl / ntry;
                        let nr = nl - ntry * nq;
                        if nr != 0 {
                            continue 'l101;
                        }
                        // 105
                        nf = nf + 1;
                        ifac[fc(nf + 2)] = ntry;
                        nl = nq;
                        if ntry == 2 && nf != 1 {
                            for i in 2..=nf {
                                let ib = nf - i + 2;
                                ifac[fc(ib + 2)] = ifac[fc(ib + 1)];
                            }
                            ifac[fc(3)] = 2;
                        }
                        // 107
                        if nl != 1 {
                            continue;
                        }
                        break 'l101;
                    }
                }
                ifac[fc(1)] = n;
                ifac[fc(2)] = nf;
                let tpi: T = 6.28318530717959_f64 as T;
                let argh: T = tpi / n as T;
                let mut i = 2;
                let mut l1 = 1;
                for k1 in 1..=nf {
                    let ip = ifac[fc(k1 + 2)];
                    let mut ld = 0;
                    let l2 = l1 * ip;
                    let ido = n / l2;
                    let idot = ido + ido + 2;
                    let ipm = ip - 1;
                    for j in 1..=ipm {
                        let i1 = i;
                        wa[wa_(i - 1)] = 1.0;
                        wa[wa_(i)] = 0.0;
                        ld = ld + l1;
                        let mut fi: T = 0.0;
                        let argld: T = ld as T * argh;
                        for _ii in (4..=idot).step_by(2) {
                            i = i + 2;
                            fi = fi + 1.0;
                            let arg: T = fi * argld;
                            wa[wa_(i - 1)] = arg.cos();
                            wa[wa_(i)] = arg.sin();
                        }
                        if ip <= 5 {
                            continue;
                        }
                        wa[wa_(i1 - 1)] = wa[wa_(i - 1)];
                        wa[wa_(i1)] = wa[wa_(i)];
                    }
                    l1 = l2;
                }
            }

            /// CFFTF1 / DCFTF1 (N, C, CH, WA, IFAC).
            pub(crate) fn cftf1(n: i32, c: &mut [T], ch: &mut [T], wa: &[T], ifac: &[i32]) {
                let nf = ifac[1];
                let mut na = 0;
                let mut l1 = 1;
                let mut iw = 1;
                let mut nac = 0;
                let w = |k: i32| &wa[(k - 1) as usize..];
                for k1 in 1..=nf {
                    let ip = ifac[(k1 + 1) as usize];
                    let l2 = ip * l1;
                    let ido = n / l2;
                    let idot = ido + ido;
                    let idl1 = idot * l1;
                    if ip == 4 {
                        let ix2 = iw + idot;
                        let ix3 = ix2 + idot;
                        if na == 0 {
                            passf4(idot, l1, c, ch, w(iw), w(ix2), w(ix3));
                        } else {
                            passf4(idot, l1, ch, c, w(iw), w(ix2), w(ix3));
                        }
                        na = 1 - na;
                    } else if ip == 2 {
                        if na == 0 {
                            passf2(idot, l1, c, ch, w(iw));
                        } else {
                            passf2(idot, l1, ch, c, w(iw));
                        }
                        na = 1 - na;
                    } else if ip == 3 {
                        let ix2 = iw + idot;
                        if na == 0 {
                            passf3(idot, l1, c, ch, w(iw), w(ix2));
                        } else {
                            passf3(idot, l1, ch, c, w(iw), w(ix2));
                        }
                        na = 1 - na;
                    } else if ip == 5 {
                        let ix2 = iw + idot;
                        let ix3 = ix2 + idot;
                        let ix4 = ix3 + idot;
                        if na == 0 {
                            passf5(idot, l1, c, ch, w(iw), w(ix2), w(ix3), w(ix4));
                        } else {
                            passf5(idot, l1, ch, c, w(iw), w(ix2), w(ix3), w(ix4));
                        }
                        na = 1 - na;
                    } else {
                        // 112
                        if na == 0 {
                            passf(&mut nac, idot, ip, l1, idl1, c, ch, w(iw));
                        } else {
                            passf(&mut nac, idot, ip, l1, idl1, ch, c, w(iw));
                        }
                        if nac != 0 {
                            na = 1 - na;
                        }
                    }
                    // 115
                    l1 = l2;
                    iw = iw + (ip - 1) * idot;
                }
                if na == 0 {
                    return;
                }
                let n2 = n + n;
                for i in 0..n2 as usize {
                    c[i] = ch[i];
                }
            }

            /// PASSF / DPASF: general odd factor. CC, C1, C2 share the array `c`;
            /// CH, CH2 share `ch`.
            fn passf(nac: &mut i32, ido: i32, ip: i32, l1: i32, idl1: i32, c: &mut [T], ch: &mut [T], wa: &[T]) {
                let cc = |i: i32, j: i32, k: i32| ((i - 1) + ido * ((j - 1) + ip * (k - 1))) as usize;
                let c1 = |i: i32, k: i32, j: i32| ((i - 1) + ido * ((k - 1) + l1 * (j - 1))) as usize;
                let c2 = |ik: i32, j: i32| ((ik - 1) + idl1 * (j - 1)) as usize;
                let h = c1;
                let h2 = c2;
                let w = |i: i32| wa[(i - 1) as usize];
                let idot = ido / 2;
                let nt = ip * idl1;
                let ipp2 = ip + 2;
                let ipph = (ip + 1) / 2;
                let idp = ip * ido;
                if ido >= l1 {
                    for j in 2..=ipph {
                        let jc = ipp2 - j;
                        for k in 1..=l1 {
                            for i in 1..=ido {
                                ch[h(i, k, j)] = c[cc(i, j, k)] + c[cc(i, jc, k)];
                                ch[h(i, k, jc)] = c[cc(i, j, k)] - c[cc(i, jc, k)];
                            }
                        }
                    }
                    for k in 1..=l1 {
                        for i in 1..=ido {
                            ch[h(i, k, 1)] = c[cc(i, 1, k)];
                        }
                    }
                } else {
                    // 106
                    for j in 2..=ipph {
                        let jc = ipp2 - j;
                        for i in 1..=ido {
                            for k in 1..=l1 {
                                ch[h(i, k, j)] = c[cc(i, j, k)] + c[cc(i, jc, k)];
                                ch[h(i, k, jc)] = c[cc(i, j, k)] - c[cc(i, jc, k)];
                            }
                        }
                    }
                    for i in 1..=ido {
                        for k in 1..=l1 {
                            ch[h(i, k, 1)] = c[cc(i, 1, k)];
                        }
                    }
                }
                // 112
                let mut idl = 2 - ido;
                let mut inc = 0;
                for l in 2..=ipph {
                    let lc = ipp2 - l;
                    idl = idl + ido;
                    for ik in 1..=idl1 {
                        c[c2(ik, l)] = ch[h2(ik, 1)] + w(idl - 1) * ch[h2(ik, 2)];
                        c[c2(ik, lc)] = -w(idl) * ch[h2(ik, ip)];
                    }
                    let mut idlj = idl;
                    inc = inc + ido;
                    for j in 3..=ipph {
                        let jc = ipp2 - j;
                        idlj = idlj + inc;
                        if idlj > idp {
                            idlj = idlj - idp;
                        }
                        let war = w(idlj - 1);
                        let wai = w(idlj);
                        for ik in 1..=idl1 {
                            c[c2(ik, l)] = c[c2(ik, l)] + war * ch[h2(ik, j)];
                            c[c2(ik, lc)] = c[c2(ik, lc)] - wai * ch[h2(ik, jc)];
                        }
                    }
                }
                for j in 2..=ipph {
                    for ik in 1..=idl1 {
                        ch[h2(ik, 1)] = ch[h2(ik, 1)] + ch[h2(ik, j)];
                    }
                }
                for j in 2..=ipph {
                    let jc = ipp2 - j;
                    for ik in (2..=idl1).step_by(2) {
                        ch[h2(ik - 1, j)] = c[c2(ik - 1, j)] - c[c2(ik, jc)];
                        ch[h2(ik - 1, jc)] = c[c2(ik - 1, j)] + c[c2(ik, jc)];
                        ch[h2(ik, j)] = c[c2(ik, j)] + c[c2(ik - 1, jc)];
                        ch[h2(ik, jc)] = c[c2(ik, j)] - c[c2(ik - 1, jc)];
                    }
                }
                *nac = 1;
                if ido == 2 {
                    return;
                }
                *nac = 0;
                for ik in 1..=idl1 {
                    c[c2(ik, 1)] = ch[h2(ik, 1)];
                }
                for j in 2..=ip {
                    for k in 1..=l1 {
                        c[c1(1, k, j)] = ch[h(1, k, j)];
                        c[c1(2, k, j)] = ch[h(2, k, j)];
                    }
                }
                if idot <= l1 {
                    let mut idij = 0;
                    for j in 2..=ip {
                        idij = idij + 2;
                        for i in (4..=ido).step_by(2) {
                            idij = idij + 2;
                            for k in 1..=l1 {
                                c[c1(i - 1, k, j)] = w(idij - 1) * ch[h(i - 1, k, j)] + w(idij) * ch[h(i, k, j)];
                                c[c1(i, k, j)] = w(idij - 1) * ch[h(i, k, j)] - w(idij) * ch[h(i - 1, k, j)];
                            }
                        }
                    }
                    return;
                }
                // 127
                let mut idj = 2 - ido;
                for j in 2..=ip {
                    idj = idj + ido;
                    for k in 1..=l1 {
                        let mut idij = idj;
                        for i in (4..=ido).step_by(2) {
                            idij = idij + 2;
                            c[c1(i - 1, k, j)] = w(idij - 1) * ch[h(i - 1, k, j)] + w(idij) * ch[h(i, k, j)];
                            c[c1(i, k, j)] = w(idij - 1) * ch[h(i, k, j)] - w(idij) * ch[h(i - 1, k, j)];
                        }
                    }
                }
            }

            /// PASSF5 / DPASF5.
            fn passf5(ido: i32, l1: i32, cc: &[T], ch: &mut [T], wa1: &[T], wa2: &[T], wa3: &[T], wa4: &[T]) {
                const TR11: T = 0.309016994374947;
                const TI11: T = -0.951056516295154;
                const TR12: T = -0.809016994374947;
                const TI12: T = -0.587785252292473;
                let c = |i: i32, j: i32, k: i32| ((i - 1) + ido * ((j - 1) + 5 * (k - 1))) as usize;
                let h = |i: i32, k: i32, j: i32| ((i - 1) + ido * ((k - 1) + l1 * (j - 1))) as usize;
                let w = |i: i32| (i - 1) as usize;
                if ido == 2 {
                    for k in 1..=l1 {
                        let ti5 = cc[c(2, 2, k)] - cc[c(2, 5, k)];
                        let ti2 = cc[c(2, 2, k)] + cc[c(2, 5, k)];
                        let ti4 = cc[c(2, 3, k)] - cc[c(2, 4, k)];
                        let ti3 = cc[c(2, 3, k)] + cc[c(2, 4, k)];
                        let tr5 = cc[c(1, 2, k)] - cc[c(1, 5, k)];
                        let tr2 = cc[c(1, 2, k)] + cc[c(1, 5, k)];
                        let tr4 = cc[c(1, 3, k)] - cc[c(1, 4, k)];
                        let tr3 = cc[c(1, 3, k)] + cc[c(1, 4, k)];
                        ch[h(1, k, 1)] = cc[c(1, 1, k)] + tr2 + tr3;
                        ch[h(2, k, 1)] = cc[c(2, 1, k)] + ti2 + ti3;
                        let cr2 = cc[c(1, 1, k)] + TR11 * tr2 + TR12 * tr3;
                        let ci2 = cc[c(2, 1, k)] + TR11 * ti2 + TR12 * ti3;
                        let cr3 = cc[c(1, 1, k)] + TR12 * tr2 + TR11 * tr3;
                        let ci3 = cc[c(2, 1, k)] + TR12 * ti2 + TR11 * ti3;
                        let cr5 = TI11 * tr5 + TI12 * tr4;
                        let ci5 = TI11 * ti5 + TI12 * ti4;
                        let cr4 = TI12 * tr5 - TI11 * tr4;
                        let ci4 = TI12 * ti5 - TI11 * ti4;
                        ch[h(1, k, 2)] = cr2 - ci5;
                        ch[h(1, k, 5)] = cr2 + ci5;
                        ch[h(2, k, 2)] = ci2 + cr5;
                        ch[h(2, k, 3)] = ci3 + cr4;
                        ch[h(1, k, 3)] = cr3 - ci4;
                        ch[h(1, k, 4)] = cr3 + ci4;
                        ch[h(2, k, 4)] = ci3 - cr4;
                        ch[h(2, k, 5)] = ci2 - cr5;
                    }
                    return;
                }
                for k in 1..=l1 {
                    for i in (2..=ido).step_by(2) {
                        let ti5 = cc[c(i, 2, k)] - cc[c(i, 5, k)];
                        let ti2 = cc[c(i, 2, k)] + cc[c(i, 5, k)];
                        let ti4 = cc[c(i, 3, k)] - cc[c(i, 4, k)];
                        let ti3 = cc[c(i, 3, k)] + cc[c(i, 4, k)];
                        let tr5 = cc[c(i - 1, 2, k)] - cc[c(i - 1, 5, k)];
                        let tr2 = cc[c(i - 1, 2, k)] + cc[c(i - 1, 5, k)];
                        let tr4 = cc[c(i - 1, 3, k)] - cc[c(i - 1, 4, k)];
                        let tr3 = cc[c(i - 1, 3, k)] + cc[c(i - 1, 4, k)];
                        ch[h(i - 1, k, 1)] = cc[c(i - 1, 1, k)] + tr2 + tr3;
                        ch[h(i, k, 1)] = cc[c(i, 1, k)] + ti2 + ti3;
                        let cr2 = cc[c(i - 1, 1, k)] + TR11 * tr2 + TR12 * tr3;
                        let ci2 = cc[c(i, 1, k)] + TR11 * ti2 + TR12 * ti3;
                        let cr3 = cc[c(i - 1, 1, k)] + TR12 * tr2 + TR11 * tr3;
                        let ci3 = cc[c(i, 1, k)] + TR12 * ti2 + TR11 * ti3;
                        let cr5 = TI11 * tr5 + TI12 * tr4;
                        let ci5 = TI11 * ti5 + TI12 * ti4;
                        let cr4 = TI12 * tr5 - TI11 * tr4;
                        let ci4 = TI12 * ti5 - TI11 * ti4;
                        let dr3 = cr3 - ci4;
                        let dr4 = cr3 + ci4;
                        let di3 = ci3 + cr4;
                        let di4 = ci3 - cr4;
                        let dr5 = cr2 + ci5;
                        let dr2 = cr2 - ci5;
                        let di5 = ci2 - cr5;
                        let di2 = ci2 + cr5;
                        ch[h(i - 1, k, 2)] = wa1[w(i - 1)] * dr2 + wa1[w(i)] * di2;
                        ch[h(i, k, 2)] = wa1[w(i - 1)] * di2 - wa1[w(i)] * dr2;
                        ch[h(i - 1, k, 3)] = wa2[w(i - 1)] * dr3 + wa2[w(i)] * di3;
                        ch[h(i, k, 3)] = wa2[w(i - 1)] * di3 - wa2[w(i)] * dr3;
                        ch[h(i - 1, k, 4)] = wa3[w(i - 1)] * dr4 + wa3[w(i)] * di4;
                        ch[h(i, k, 4)] = wa3[w(i - 1)] * di4 - wa3[w(i)] * dr4;
                        ch[h(i - 1, k, 5)] = wa4[w(i - 1)] * dr5 + wa4[w(i)] * di5;
                        ch[h(i, k, 5)] = wa4[w(i - 1)] * di5 - wa4[w(i)] * dr5;
                    }
                }
            }

            /// PASSF3 / DPASF3.
            fn passf3(ido: i32, l1: i32, cc: &[T], ch: &mut [T], wa1: &[T], wa2: &[T]) {
                const TAUR: T = -0.5;
                const TAUI: T = -0.866025403784439;
                let c = |i: i32, j: i32, k: i32| ((i - 1) + ido * ((j - 1) + 3 * (k - 1))) as usize;
                let h = |i: i32, k: i32, j: i32| ((i - 1) + ido * ((k - 1) + l1 * (j - 1))) as usize;
                let w = |i: i32| (i - 1) as usize;
                if ido == 2 {
                    for k in 1..=l1 {
                        let tr2 = cc[c(1, 2, k)] + cc[c(1, 3, k)];
                        let cr2 = cc[c(1, 1, k)] + TAUR * tr2;
                        ch[h(1, k, 1)] = cc[c(1, 1, k)] + tr2;
                        let ti2 = cc[c(2, 2, k)] + cc[c(2, 3, k)];
                        let ci2 = cc[c(2, 1, k)] + TAUR * ti2;
                        ch[h(2, k, 1)] = cc[c(2, 1, k)] + ti2;
                        let cr3 = TAUI * (cc[c(1, 2, k)] - cc[c(1, 3, k)]);
                        let ci3 = TAUI * (cc[c(2, 2, k)] - cc[c(2, 3, k)]);
                        ch[h(1, k, 2)] = cr2 - ci3;
                        ch[h(1, k, 3)] = cr2 + ci3;
                        ch[h(2, k, 2)] = ci2 + cr3;
                        ch[h(2, k, 3)] = ci2 - cr3;
                    }
                    return;
                }
                for k in 1..=l1 {
                    for i in (2..=ido).step_by(2) {
                        let tr2 = cc[c(i - 1, 2, k)] + cc[c(i - 1, 3, k)];
                        let cr2 = cc[c(i - 1, 1, k)] + TAUR * tr2;
                        ch[h(i - 1, k, 1)] = cc[c(i - 1, 1, k)] + tr2;
                        let ti2 = cc[c(i, 2, k)] + cc[c(i, 3, k)];
                        let ci2 = cc[c(i, 1, k)] + TAUR * ti2;
                        ch[h(i, k, 1)] = cc[c(i, 1, k)] + ti2;
                        let cr3 = TAUI * (cc[c(i - 1, 2, k)] - cc[c(i - 1, 3, k)]);
                        let ci3 = TAUI * (cc[c(i, 2, k)] - cc[c(i, 3, k)]);
                        let dr2 = cr2 - ci3;
                        let dr3 = cr2 + ci3;
                        let di2 = ci2 + cr3;
                        let di3 = ci2 - cr3;
                        ch[h(i, k, 2)] = wa1[w(i - 1)] * di2 - wa1[w(i)] * dr2;
                        ch[h(i - 1, k, 2)] = wa1[w(i - 1)] * dr2 + wa1[w(i)] * di2;
                        ch[h(i, k, 3)] = wa2[w(i - 1)] * di3 - wa2[w(i)] * dr3;
                        ch[h(i - 1, k, 3)] = wa2[w(i - 1)] * dr3 + wa2[w(i)] * di3;
                    }
                }
            }

            /// PASSF2 / DPASF2.
            fn passf2(ido: i32, l1: i32, cc: &[T], ch: &mut [T], wa1: &[T]) {
                let c = |i: i32, j: i32, k: i32| ((i - 1) + ido * ((j - 1) + 2 * (k - 1))) as usize;
                let h = |i: i32, k: i32, j: i32| ((i - 1) + ido * ((k - 1) + l1 * (j - 1))) as usize;
                let w = |i: i32| (i - 1) as usize;
                if ido <= 2 {
                    for k in 1..=l1 {
                        ch[h(1, k, 1)] = cc[c(1, 1, k)] + cc[c(1, 2, k)];
                        ch[h(1, k, 2)] = cc[c(1, 1, k)] - cc[c(1, 2, k)];
                        ch[h(2, k, 1)] = cc[c(2, 1, k)] + cc[c(2, 2, k)];
                        ch[h(2, k, 2)] = cc[c(2, 1, k)] - cc[c(2, 2, k)];
                    }
                    return;
                }
                for k in 1..=l1 {
                    for i in (2..=ido).step_by(2) {
                        ch[h(i - 1, k, 1)] = cc[c(i - 1, 1, k)] + cc[c(i - 1, 2, k)];
                        let tr2 = cc[c(i - 1, 1, k)] - cc[c(i - 1, 2, k)];
                        ch[h(i, k, 1)] = cc[c(i, 1, k)] + cc[c(i, 2, k)];
                        let ti2 = cc[c(i, 1, k)] - cc[c(i, 2, k)];
                        ch[h(i, k, 2)] = wa1[w(i - 1)] * ti2 - wa1[w(i)] * tr2;
                        ch[h(i - 1, k, 2)] = wa1[w(i - 1)] * tr2 + wa1[w(i)] * ti2;
                    }
                }
            }

            /// PASSF4 / DPASF4.
            fn passf4(ido: i32, l1: i32, cc: &[T], ch: &mut [T], wa1: &[T], wa2: &[T], wa3: &[T]) {
                let c = |i: i32, j: i32, k: i32| ((i - 1) + ido * ((j - 1) + 4 * (k - 1))) as usize;
                let h = |i: i32, k: i32, j: i32| ((i - 1) + ido * ((k - 1) + l1 * (j - 1))) as usize;
                let w = |i: i32| (i - 1) as usize;
                if ido == 2 {
                    for k in 1..=l1 {
                        let ti1 = cc[c(2, 1, k)] - cc[c(2, 3, k)];
                        let ti2 = cc[c(2, 1, k)] + cc[c(2, 3, k)];
                        let tr4 = cc[c(2, 2, k)] - cc[c(2, 4, k)];
                        let ti3 = cc[c(2, 2, k)] + cc[c(2, 4, k)];
                        let tr1 = cc[c(1, 1, k)] - cc[c(1, 3, k)];
                        let tr2 = cc[c(1, 1, k)] + cc[c(1, 3, k)];
                        let ti4 = cc[c(1, 4, k)] - cc[c(1, 2, k)];
                        let tr3 = cc[c(1, 2, k)] + cc[c(1, 4, k)];
                        ch[h(1, k, 1)] = tr2 + tr3;
                        ch[h(1, k, 3)] = tr2 - tr3;
                        ch[h(2, k, 1)] = ti2 + ti3;
                        ch[h(2, k, 3)] = ti2 - ti3;
                        ch[h(1, k, 2)] = tr1 + tr4;
                        ch[h(1, k, 4)] = tr1 - tr4;
                        ch[h(2, k, 2)] = ti1 + ti4;
                        ch[h(2, k, 4)] = ti1 - ti4;
                    }
                    return;
                }
                for k in 1..=l1 {
                    for i in (2..=ido).step_by(2) {
                        let ti1 = cc[c(i, 1, k)] - cc[c(i, 3, k)];
                        let ti2 = cc[c(i, 1, k)] + cc[c(i, 3, k)];
                        let ti3 = cc[c(i, 2, k)] + cc[c(i, 4, k)];
                        let tr4 = cc[c(i, 2, k)] - cc[c(i, 4, k)];
                        let tr1 = cc[c(i - 1, 1, k)] - cc[c(i - 1, 3, k)];
                        let tr2 = cc[c(i - 1, 1, k)] + cc[c(i - 1, 3, k)];
                        let ti4 = cc[c(i - 1, 4, k)] - cc[c(i - 1, 2, k)];
                        let tr3 = cc[c(i - 1, 2, k)] + cc[c(i - 1, 4, k)];
                        ch[h(i - 1, k, 1)] = tr2 + tr3;
                        let cr3 = tr2 - tr3;
                        ch[h(i, k, 1)] = ti2 + ti3;
                        let ci3 = ti2 - ti3;
                        let cr2 = tr1 + tr4;
                        let cr4 = tr1 - tr4;
                        let ci2 = ti1 + ti4;
                        let ci4 = ti1 - ti4;
                        ch[h(i - 1, k, 2)] = wa1[w(i - 1)] * cr2 + wa1[w(i)] * ci2;
                        ch[h(i, k, 2)] = wa1[w(i - 1)] * ci2 - wa1[w(i)] * cr2;
                        ch[h(i - 1, k, 3)] = wa2[w(i - 1)] * cr3 + wa2[w(i)] * ci3;
                        ch[h(i, k, 3)] = wa2[w(i - 1)] * ci3 - wa2[w(i)] * cr3;
                        ch[h(i - 1, k, 4)] = wa3[w(i - 1)] * cr4 + wa3[w(i)] * ci4;
                        ch[h(i, k, 4)] = wa3[w(i - 1)] * ci4 - wa3[w(i)] * cr4;
                    }
                }
            }
        }
    };
}

fftpack_forward!(fwd32, f32);
fftpack_forward!(fwd64, f64);

/// The backward REAL passes: CFFTB1, PASSB, PASSB2-5.
mod bwd32 {
    #![allow(clippy::all)]
    type T = f32;

    /// CFFTB1 (N, C, CH, WA, IFAC).
    pub(crate) fn cftb1(n: i32, c: &mut [T], ch: &mut [T], wa: &[T], ifac: &[i32]) {
        let nf = ifac[1];
        let mut na = 0;
        let mut l1 = 1;
        let mut iw = 1;
        let mut nac = 0;
        let w = |k: i32| &wa[(k - 1) as usize..];
        for k1 in 1..=nf {
            let ip = ifac[(k1 + 1) as usize];
            let l2 = ip * l1;
            let ido = n / l2;
            let idot = ido + ido;
            let idl1 = idot * l1;
            if ip == 4 {
                let ix2 = iw + idot;
                let ix3 = ix2 + idot;
                if na == 0 {
                    passb4(idot, l1, c, ch, w(iw), w(ix2), w(ix3));
                } else {
                    passb4(idot, l1, ch, c, w(iw), w(ix2), w(ix3));
                }
                na = 1 - na;
            } else if ip == 2 {
                if na == 0 {
                    passb2(idot, l1, c, ch, w(iw));
                } else {
                    passb2(idot, l1, ch, c, w(iw));
                }
                na = 1 - na;
            } else if ip == 3 {
                let ix2 = iw + idot;
                if na == 0 {
                    passb3(idot, l1, c, ch, w(iw), w(ix2));
                } else {
                    passb3(idot, l1, ch, c, w(iw), w(ix2));
                }
                na = 1 - na;
            } else if ip == 5 {
                let ix2 = iw + idot;
                let ix3 = ix2 + idot;
                let ix4 = ix3 + idot;
                if na == 0 {
                    passb5(idot, l1, c, ch, w(iw), w(ix2), w(ix3), w(ix4));
                } else {
                    passb5(idot, l1, ch, c, w(iw), w(ix2), w(ix3), w(ix4));
                }
                na = 1 - na;
            } else {
                // 112
                if na == 0 {
                    passb(&mut nac, idot, ip, l1, idl1, c, ch, w(iw));
                } else {
                    passb(&mut nac, idot, ip, l1, idl1, ch, c, w(iw));
                }
                if nac != 0 {
                    na = 1 - na;
                }
            }
            // 115
            l1 = l2;
            iw = iw + (ip - 1) * idot;
        }
        if na == 0 {
            return;
        }
        let n2 = n + n;
        for i in 0..n2 as usize {
            c[i] = ch[i];
        }
    }

    /// PASSB: general odd factor. CC, C1, C2 share `c`; CH, CH2 share `ch`.
    fn passb(nac: &mut i32, ido: i32, ip: i32, l1: i32, idl1: i32, c: &mut [T], ch: &mut [T], wa: &[T]) {
        let cc = |i: i32, j: i32, k: i32| ((i - 1) + ido * ((j - 1) + ip * (k - 1))) as usize;
        let c1 = |i: i32, k: i32, j: i32| ((i - 1) + ido * ((k - 1) + l1 * (j - 1))) as usize;
        let c2 = |ik: i32, j: i32| ((ik - 1) + idl1 * (j - 1)) as usize;
        let h = c1;
        let h2 = c2;
        let w = |i: i32| wa[(i - 1) as usize];
        let idot = ido / 2;
        let nt = ip * idl1;
        let ipp2 = ip + 2;
        let ipph = (ip + 1) / 2;
        let idp = ip * ido;
        if ido >= l1 {
            for j in 2..=ipph {
                let jc = ipp2 - j;
                for k in 1..=l1 {
                    for i in 1..=ido {
                        ch[h(i, k, j)] = c[cc(i, j, k)] + c[cc(i, jc, k)];
                        ch[h(i, k, jc)] = c[cc(i, j, k)] - c[cc(i, jc, k)];
                    }
                }
            }
            for k in 1..=l1 {
                for i in 1..=ido {
                    ch[h(i, k, 1)] = c[cc(i, 1, k)];
                }
            }
        } else {
            // 106
            for j in 2..=ipph {
                let jc = ipp2 - j;
                for i in 1..=ido {
                    for k in 1..=l1 {
                        ch[h(i, k, j)] = c[cc(i, j, k)] + c[cc(i, jc, k)];
                        ch[h(i, k, jc)] = c[cc(i, j, k)] - c[cc(i, jc, k)];
                    }
                }
            }
            for i in 1..=ido {
                for k in 1..=l1 {
                    ch[h(i, k, 1)] = c[cc(i, 1, k)];
                }
            }
        }
        // 112
        let mut idl = 2 - ido;
        let mut inc = 0;
        for l in 2..=ipph {
            let lc = ipp2 - l;
            idl = idl + ido;
            for ik in 1..=idl1 {
                c[c2(ik, l)] = ch[h2(ik, 1)] + w(idl - 1) * ch[h2(ik, 2)];
                c[c2(ik, lc)] = w(idl) * ch[h2(ik, ip)];
            }
            let mut idlj = idl;
            inc = inc + ido;
            for j in 3..=ipph {
                let jc = ipp2 - j;
                idlj = idlj + inc;
                if idlj > idp {
                    idlj = idlj - idp;
                }
                let war = w(idlj - 1);
                let wai = w(idlj);
                for ik in 1..=idl1 {
                    c[c2(ik, l)] = c[c2(ik, l)] + war * ch[h2(ik, j)];
                    c[c2(ik, lc)] = c[c2(ik, lc)] + wai * ch[h2(ik, jc)];
                }
            }
        }
        for j in 2..=ipph {
            for ik in 1..=idl1 {
                ch[h2(ik, 1)] = ch[h2(ik, 1)] + ch[h2(ik, j)];
            }
        }
        for j in 2..=ipph {
            let jc = ipp2 - j;
            for ik in (2..=idl1).step_by(2) {
                ch[h2(ik - 1, j)] = c[c2(ik - 1, j)] - c[c2(ik, jc)];
                ch[h2(ik - 1, jc)] = c[c2(ik - 1, j)] + c[c2(ik, jc)];
                ch[h2(ik, j)] = c[c2(ik, j)] + c[c2(ik - 1, jc)];
                ch[h2(ik, jc)] = c[c2(ik, j)] - c[c2(ik - 1, jc)];
            }
        }
        *nac = 1;
        if ido == 2 {
            return;
        }
        *nac = 0;
        for ik in 1..=idl1 {
            c[c2(ik, 1)] = ch[h2(ik, 1)];
        }
        for j in 2..=ip {
            for k in 1..=l1 {
                c[c1(1, k, j)] = ch[h(1, k, j)];
                c[c1(2, k, j)] = ch[h(2, k, j)];
            }
        }
        if idot <= l1 {
            let mut idij = 0;
            for j in 2..=ip {
                idij = idij + 2;
                for i in (4..=ido).step_by(2) {
                    idij = idij + 2;
                    for k in 1..=l1 {
                        c[c1(i - 1, k, j)] = w(idij - 1) * ch[h(i - 1, k, j)] - w(idij) * ch[h(i, k, j)];
                        c[c1(i, k, j)] = w(idij - 1) * ch[h(i, k, j)] + w(idij) * ch[h(i - 1, k, j)];
                    }
                }
            }
            return;
        }
        // 127
        let mut idj = 2 - ido;
        for j in 2..=ip {
            idj = idj + ido;
            for k in 1..=l1 {
                let mut idij = idj;
                for i in (4..=ido).step_by(2) {
                    idij = idij + 2;
                    c[c1(i - 1, k, j)] = w(idij - 1) * ch[h(i - 1, k, j)] - w(idij) * ch[h(i, k, j)];
                    c[c1(i, k, j)] = w(idij - 1) * ch[h(i, k, j)] + w(idij) * ch[h(i - 1, k, j)];
                }
            }
        }
    }

    /// PASSB5.
    fn passb5(ido: i32, l1: i32, cc: &[T], ch: &mut [T], wa1: &[T], wa2: &[T], wa3: &[T], wa4: &[T]) {
        const TR11: T = 0.309016994374947;
        const TI11: T = 0.951056516295154;
        const TR12: T = -0.809016994374947;
        const TI12: T = 0.587785252292473;
        let c = |i: i32, j: i32, k: i32| ((i - 1) + ido * ((j - 1) + 5 * (k - 1))) as usize;
        let h = |i: i32, k: i32, j: i32| ((i - 1) + ido * ((k - 1) + l1 * (j - 1))) as usize;
        let w = |i: i32| (i - 1) as usize;
        if ido == 2 {
            for k in 1..=l1 {
                let ti5 = cc[c(2, 2, k)] - cc[c(2, 5, k)];
                let ti2 = cc[c(2, 2, k)] + cc[c(2, 5, k)];
                let ti4 = cc[c(2, 3, k)] - cc[c(2, 4, k)];
                let ti3 = cc[c(2, 3, k)] + cc[c(2, 4, k)];
                let tr5 = cc[c(1, 2, k)] - cc[c(1, 5, k)];
                let tr2 = cc[c(1, 2, k)] + cc[c(1, 5, k)];
                let tr4 = cc[c(1, 3, k)] - cc[c(1, 4, k)];
                let tr3 = cc[c(1, 3, k)] + cc[c(1, 4, k)];
                ch[h(1, k, 1)] = cc[c(1, 1, k)] + tr2 + tr3;
                ch[h(2, k, 1)] = cc[c(2, 1, k)] + ti2 + ti3;
                let cr2 = cc[c(1, 1, k)] + TR11 * tr2 + TR12 * tr3;
                let ci2 = cc[c(2, 1, k)] + TR11 * ti2 + TR12 * ti3;
                let cr3 = cc[c(1, 1, k)] + TR12 * tr2 + TR11 * tr3;
                let ci3 = cc[c(2, 1, k)] + TR12 * ti2 + TR11 * ti3;
                let cr5 = TI11 * tr5 + TI12 * tr4;
                let ci5 = TI11 * ti5 + TI12 * ti4;
                let cr4 = TI12 * tr5 - TI11 * tr4;
                let ci4 = TI12 * ti5 - TI11 * ti4;
                ch[h(1, k, 2)] = cr2 - ci5;
                ch[h(1, k, 5)] = cr2 + ci5;
                ch[h(2, k, 2)] = ci2 + cr5;
                ch[h(2, k, 3)] = ci3 + cr4;
                ch[h(1, k, 3)] = cr3 - ci4;
                ch[h(1, k, 4)] = cr3 + ci4;
                ch[h(2, k, 4)] = ci3 - cr4;
                ch[h(2, k, 5)] = ci2 - cr5;
            }
            return;
        }
        for k in 1..=l1 {
            for i in (2..=ido).step_by(2) {
                let ti5 = cc[c(i, 2, k)] - cc[c(i, 5, k)];
                let ti2 = cc[c(i, 2, k)] + cc[c(i, 5, k)];
                let ti4 = cc[c(i, 3, k)] - cc[c(i, 4, k)];
                let ti3 = cc[c(i, 3, k)] + cc[c(i, 4, k)];
                let tr5 = cc[c(i - 1, 2, k)] - cc[c(i - 1, 5, k)];
                let tr2 = cc[c(i - 1, 2, k)] + cc[c(i - 1, 5, k)];
                let tr4 = cc[c(i - 1, 3, k)] - cc[c(i - 1, 4, k)];
                let tr3 = cc[c(i - 1, 3, k)] + cc[c(i - 1, 4, k)];
                ch[h(i - 1, k, 1)] = cc[c(i - 1, 1, k)] + tr2 + tr3;
                ch[h(i, k, 1)] = cc[c(i, 1, k)] + ti2 + ti3;
                let cr2 = cc[c(i - 1, 1, k)] + TR11 * tr2 + TR12 * tr3;
                let ci2 = cc[c(i, 1, k)] + TR11 * ti2 + TR12 * ti3;
                let cr3 = cc[c(i - 1, 1, k)] + TR12 * tr2 + TR11 * tr3;
                let ci3 = cc[c(i, 1, k)] + TR12 * ti2 + TR11 * ti3;
                let cr5 = TI11 * tr5 + TI12 * tr4;
                let ci5 = TI11 * ti5 + TI12 * ti4;
                let cr4 = TI12 * tr5 - TI11 * tr4;
                let ci4 = TI12 * ti5 - TI11 * ti4;
                let dr3 = cr3 - ci4;
                let dr4 = cr3 + ci4;
                let di3 = ci3 + cr4;
                let di4 = ci3 - cr4;
                let dr5 = cr2 + ci5;
                let dr2 = cr2 - ci5;
                let di5 = ci2 - cr5;
                let di2 = ci2 + cr5;
                ch[h(i - 1, k, 2)] = wa1[w(i - 1)] * dr2 - wa1[w(i)] * di2;
                ch[h(i, k, 2)] = wa1[w(i - 1)] * di2 + wa1[w(i)] * dr2;
                ch[h(i - 1, k, 3)] = wa2[w(i - 1)] * dr3 - wa2[w(i)] * di3;
                ch[h(i, k, 3)] = wa2[w(i - 1)] * di3 + wa2[w(i)] * dr3;
                ch[h(i - 1, k, 4)] = wa3[w(i - 1)] * dr4 - wa3[w(i)] * di4;
                ch[h(i, k, 4)] = wa3[w(i - 1)] * di4 + wa3[w(i)] * dr4;
                ch[h(i - 1, k, 5)] = wa4[w(i - 1)] * dr5 - wa4[w(i)] * di5;
                ch[h(i, k, 5)] = wa4[w(i - 1)] * di5 + wa4[w(i)] * dr5;
            }
        }
    }

    /// PASSB3.
    fn passb3(ido: i32, l1: i32, cc: &[T], ch: &mut [T], wa1: &[T], wa2: &[T]) {
        const TAUR: T = -0.5;
        const TAUI: T = 0.866025403784439;
        let c = |i: i32, j: i32, k: i32| ((i - 1) + ido * ((j - 1) + 3 * (k - 1))) as usize;
        let h = |i: i32, k: i32, j: i32| ((i - 1) + ido * ((k - 1) + l1 * (j - 1))) as usize;
        let w = |i: i32| (i - 1) as usize;
        if ido == 2 {
            for k in 1..=l1 {
                let tr2 = cc[c(1, 2, k)] + cc[c(1, 3, k)];
                let cr2 = cc[c(1, 1, k)] + TAUR * tr2;
                ch[h(1, k, 1)] = cc[c(1, 1, k)] + tr2;
                let ti2 = cc[c(2, 2, k)] + cc[c(2, 3, k)];
                let ci2 = cc[c(2, 1, k)] + TAUR * ti2;
                ch[h(2, k, 1)] = cc[c(2, 1, k)] + ti2;
                let cr3 = TAUI * (cc[c(1, 2, k)] - cc[c(1, 3, k)]);
                let ci3 = TAUI * (cc[c(2, 2, k)] - cc[c(2, 3, k)]);
                ch[h(1, k, 2)] = cr2 - ci3;
                ch[h(1, k, 3)] = cr2 + ci3;
                ch[h(2, k, 2)] = ci2 + cr3;
                ch[h(2, k, 3)] = ci2 - cr3;
            }
            return;
        }
        for k in 1..=l1 {
            for i in (2..=ido).step_by(2) {
                let tr2 = cc[c(i - 1, 2, k)] + cc[c(i - 1, 3, k)];
                let cr2 = cc[c(i - 1, 1, k)] + TAUR * tr2;
                ch[h(i - 1, k, 1)] = cc[c(i - 1, 1, k)] + tr2;
                let ti2 = cc[c(i, 2, k)] + cc[c(i, 3, k)];
                let ci2 = cc[c(i, 1, k)] + TAUR * ti2;
                ch[h(i, k, 1)] = cc[c(i, 1, k)] + ti2;
                let cr3 = TAUI * (cc[c(i - 1, 2, k)] - cc[c(i - 1, 3, k)]);
                let ci3 = TAUI * (cc[c(i, 2, k)] - cc[c(i, 3, k)]);
                let dr2 = cr2 - ci3;
                let dr3 = cr2 + ci3;
                let di2 = ci2 + cr3;
                let di3 = ci2 - cr3;
                ch[h(i, k, 2)] = wa1[w(i - 1)] * di2 + wa1[w(i)] * dr2;
                ch[h(i - 1, k, 2)] = wa1[w(i - 1)] * dr2 - wa1[w(i)] * di2;
                ch[h(i, k, 3)] = wa2[w(i - 1)] * di3 + wa2[w(i)] * dr3;
                ch[h(i - 1, k, 3)] = wa2[w(i - 1)] * dr3 - wa2[w(i)] * di3;
            }
        }
    }

    /// PASSB2.
    fn passb2(ido: i32, l1: i32, cc: &[T], ch: &mut [T], wa1: &[T]) {
        let c = |i: i32, j: i32, k: i32| ((i - 1) + ido * ((j - 1) + 2 * (k - 1))) as usize;
        let h = |i: i32, k: i32, j: i32| ((i - 1) + ido * ((k - 1) + l1 * (j - 1))) as usize;
        let w = |i: i32| (i - 1) as usize;
        if ido <= 2 {
            for k in 1..=l1 {
                ch[h(1, k, 1)] = cc[c(1, 1, k)] + cc[c(1, 2, k)];
                ch[h(1, k, 2)] = cc[c(1, 1, k)] - cc[c(1, 2, k)];
                ch[h(2, k, 1)] = cc[c(2, 1, k)] + cc[c(2, 2, k)];
                ch[h(2, k, 2)] = cc[c(2, 1, k)] - cc[c(2, 2, k)];
            }
            return;
        }
        for k in 1..=l1 {
            for i in (2..=ido).step_by(2) {
                ch[h(i - 1, k, 1)] = cc[c(i - 1, 1, k)] + cc[c(i - 1, 2, k)];
                let tr2 = cc[c(i - 1, 1, k)] - cc[c(i - 1, 2, k)];
                ch[h(i, k, 1)] = cc[c(i, 1, k)] + cc[c(i, 2, k)];
                let ti2 = cc[c(i, 1, k)] - cc[c(i, 2, k)];
                ch[h(i, k, 2)] = wa1[w(i - 1)] * ti2 + wa1[w(i)] * tr2;
                ch[h(i - 1, k, 2)] = wa1[w(i - 1)] * tr2 - wa1[w(i)] * ti2;
            }
        }
    }

    /// PASSB4.
    fn passb4(ido: i32, l1: i32, cc: &[T], ch: &mut [T], wa1: &[T], wa2: &[T], wa3: &[T]) {
        let c = |i: i32, j: i32, k: i32| ((i - 1) + ido * ((j - 1) + 4 * (k - 1))) as usize;
        let h = |i: i32, k: i32, j: i32| ((i - 1) + ido * ((k - 1) + l1 * (j - 1))) as usize;
        let w = |i: i32| (i - 1) as usize;
        if ido == 2 {
            for k in 1..=l1 {
                let ti1 = cc[c(2, 1, k)] - cc[c(2, 3, k)];
                let ti2 = cc[c(2, 1, k)] + cc[c(2, 3, k)];
                let tr4 = cc[c(2, 4, k)] - cc[c(2, 2, k)];
                let ti3 = cc[c(2, 2, k)] + cc[c(2, 4, k)];
                let tr1 = cc[c(1, 1, k)] - cc[c(1, 3, k)];
                let tr2 = cc[c(1, 1, k)] + cc[c(1, 3, k)];
                let ti4 = cc[c(1, 2, k)] - cc[c(1, 4, k)];
                let tr3 = cc[c(1, 2, k)] + cc[c(1, 4, k)];
                ch[h(1, k, 1)] = tr2 + tr3;
                ch[h(1, k, 3)] = tr2 - tr3;
                ch[h(2, k, 1)] = ti2 + ti3;
                ch[h(2, k, 3)] = ti2 - ti3;
                ch[h(1, k, 2)] = tr1 + tr4;
                ch[h(1, k, 4)] = tr1 - tr4;
                ch[h(2, k, 2)] = ti1 + ti4;
                ch[h(2, k, 4)] = ti1 - ti4;
            }
            return;
        }
        for k in 1..=l1 {
            for i in (2..=ido).step_by(2) {
                let ti1 = cc[c(i, 1, k)] - cc[c(i, 3, k)];
                let ti2 = cc[c(i, 1, k)] + cc[c(i, 3, k)];
                let ti3 = cc[c(i, 2, k)] + cc[c(i, 4, k)];
                let tr4 = cc[c(i, 4, k)] - cc[c(i, 2, k)];
                let tr1 = cc[c(i - 1, 1, k)] - cc[c(i - 1, 3, k)];
                let tr2 = cc[c(i - 1, 1, k)] + cc[c(i - 1, 3, k)];
                let ti4 = cc[c(i - 1, 2, k)] - cc[c(i - 1, 4, k)];
                let tr3 = cc[c(i - 1, 2, k)] + cc[c(i - 1, 4, k)];
                ch[h(i - 1, k, 1)] = tr2 + tr3;
                let cr3 = tr2 - tr3;
                ch[h(i, k, 1)] = ti2 + ti3;
                let ci3 = ti2 - ti3;
                let cr2 = tr1 + tr4;
                let cr4 = tr1 - tr4;
                let ci2 = ti1 + ti4;
                let ci4 = ti1 - ti4;
                ch[h(i - 1, k, 2)] = wa1[w(i - 1)] * cr2 - wa1[w(i)] * ci2;
                ch[h(i, k, 2)] = wa1[w(i - 1)] * ci2 + wa1[w(i)] * cr2;
                ch[h(i - 1, k, 3)] = wa2[w(i - 1)] * cr3 - wa2[w(i)] * ci3;
                ch[h(i, k, 3)] = wa2[w(i - 1)] * ci3 + wa2[w(i)] * cr3;
                ch[h(i - 1, k, 4)] = wa3[w(i - 1)] * cr4 - wa3[w(i)] * ci4;
                ch[h(i, k, 4)] = wa3[w(i - 1)] * ci4 + wa3[w(i)] * cr4;
            }
        }
    }
}

/// FFTCI (N, WSAVE).
fn fftci(n: i32, wsave: &mut [f32]) {
    if n == 1 {
        return;
    }
    let iw1 = (n + n) as usize;
    let (_, rest) = wsave.split_at_mut(iw1);
    let (wa, ifac) = rest.split_at_mut((n + n) as usize);
    fwd32::cfti1(n, wa, ifac_view_f32(ifac));
}

/// DFFTCI (N, WSAVE).
fn dfftci(n: i32, wsave: &mut [f64]) {
    if n == 1 {
        return;
    }
    let iw1 = (n + n) as usize;
    let (_, rest) = wsave.split_at_mut(iw1);
    let (wa, ifac) = rest.split_at_mut((n + n) as usize);
    fwd64::cfti1(n, wa, ifac_view_f64(ifac));
}

/// F2TCF (N, C, YOUT, WSAVE) after its copy of C into YOUT (`yout` holds the input).
fn f2tcf(n: i32, yout: &mut [f32], wsave: &mut [f32]) {
    if n == 1 {
        return;
    }
    let (ch, rest) = wsave.split_at_mut((n + n) as usize);
    let (wa, ifac) = rest.split_at_mut((n + n) as usize);
    fwd32::cftf1(n, yout, ch, wa, ifac_view_f32(ifac));
}

/// F2TCB (N, C, YOUT, WSAVE) after its copy of C into YOUT.
fn f2tcb(n: i32, yout: &mut [f32], wsave: &mut [f32]) {
    if n <= 1 {
        return;
    }
    let (ch, rest) = wsave.split_at_mut((n + n) as usize);
    let (wa, ifac) = rest.split_at_mut((n + n) as usize);
    bwd32::cftb1(n, yout, ch, wa, ifac_view_f32(ifac));
}

/// DF2TCF (N, C, YOUT, WSAVE) after its copy of C into YOUT.
fn df2tcf(n: i32, yout: &mut [f64], wsave: &mut [f64]) {
    if n == 1 {
        return;
    }
    let (ch, rest) = wsave.split_at_mut((n + n) as usize);
    let (wa, ifac) = rest.split_at_mut((n + n) as usize);
    fwd64::cftf1(n, yout, ch, wa, ifac_view_f64(ifac));
}

/// CFFT with DATAT and FT the same array (`ft` holds the input).
pub fn cfft_inplace(ft: &mut [C32], n: i32, lwfft: &mut i32, wfftc: &mut [f32]) {
    if n != *lwfft {
        fftci(n, wfftc);
        *lwfft = n;
    }
    f2tcf(n, c32_as_f32_mut(&mut ft[..n as usize]), wfftc);
    let fact = 1.0f32 / (n as f32).sqrt();
    for j in 0..n as usize {
        ft[j] = ft[j] * fact;
    }
}

/// CFFT (DATAT, FT, N, LWFFT, WFFTC): normalized FFT without rearrangement.
pub fn cfft(datat: &[C32], ft: &mut [C32], n: i32, lwfft: &mut i32, wfftc: &mut [f32]) {
    let nu = n as usize;
    ft[..nu].copy_from_slice(&datat[..nu]);
    cfft_inplace(ft, n, lwfft, wfftc);
}

/// CFFT_r with DATAT and FT the same array.
pub fn cfft_r_inplace(ft: &mut [C32], n: i32, lwfft: &mut i32, wfftc: &mut [f32]) {
    if n != *lwfft {
        fftci(n, wfftc);
        *lwfft = n;
    }
    f2tcf(n, c32_as_f32_mut(&mut ft[..n as usize]), wfftc);
    // Scale & rearrange.
    let fact = 1.0f32 / (n as f32).sqrt();
    let nunfil = (n / 2) as usize;
    for j in 0..nunfil {
        let cterm = ft[nunfil + j];
        ft[nunfil + j] = ft[j] * fact;
        ft[j] = cterm * fact;
    }
}

/// CFFT_r (DATAT, FT, N, LWFFT, WFFTC): normalized FFT with rearrangement.
pub fn cfft_r(datat: &[C32], ft: &mut [C32], n: i32, lwfft: &mut i32, wfftc: &mut [f32]) {
    let nu = n as usize;
    ft[..nu].copy_from_slice(&datat[..nu]);
    cfft_r_inplace(ft, n, lwfft, wfftc);
}

/// CFFTIN with FT and FTINV the same array.
pub fn cfftin_inplace(ftinv: &mut [C32], n: i32, lwfft: &mut i32, wfftc: &mut [f32]) {
    if n != *lwfft {
        fftci(n, wfftc);
        *lwfft = n;
    }
    f2tcb(n, c32_as_f32_mut(&mut ftinv[..n as usize]), wfftc);
    let fact = 1.0f32 / (n as f32).sqrt();
    for j in 0..n as usize {
        ftinv[j] = ftinv[j] * fact;
    }
}

/// CFFTIN (FT, FTINV, N, LWFFT, WFFTC): normalized inverse FFT without rearrangement.
pub fn cfftin(ft: &[C32], ftinv: &mut [C32], n: i32, lwfft: &mut i32, wfftc: &mut [f32]) {
    let nu = n as usize;
    ftinv[..nu].copy_from_slice(&ft[..nu]);
    cfftin_inplace(ftinv, n, lwfft, wfftc);
}

/// CFFTIN_r (FT, FTWORK, FTINV, N, LWFFT, WFFTC): FT is rearranged; it is
/// unrearranged into FTWORK before the inverse FFT.
pub fn cfftin_r(ft: &[C32], ftwork: &mut [C32], ftinv: &mut [C32], n: i32, lwfft: &mut i32, wfftc: &mut [f32]) {
    // Unrearrange.
    let nunfil = (n / 2) as usize;
    for j in 0..nunfil {
        ftwork[j] = ft[nunfil + j];
        ftwork[nunfil + j] = ft[j];
    }
    if n != *lwfft {
        fftci(n, wfftc);
        *lwfft = n;
    }
    let nu = n as usize;
    ftinv[..nu].copy_from_slice(&ftwork[..nu]);
    f2tcb(n, c32_as_f32_mut(&mut ftinv[..nu]), wfftc);
    let fact = 1.0f32 / (n as f32).sqrt();
    for j in 0..nu {
        ftinv[j] = ftinv[j] * fact;
    }
}

/// DCFFT_R with DATAT and FT the same array.
pub fn dcfft_r_inplace(ft: &mut [C64], n: i32, ldwfft: &mut i32, dwfftc: &mut [f64]) {
    if n != *ldwfft {
        dfftci(n, dwfftc);
        *ldwfft = n;
    }
    df2tcf(n, c64_as_f64_mut(&mut ft[..n as usize]), dwfftc);
    // Scale & rearrange. FACT is REAL.
    let fact = 1.0f32 / (n as f32).sqrt();
    let nunfil = (n / 2) as usize;
    for j in 0..nunfil {
        let cterm = ft[nunfil + j];
        ft[nunfil + j] = ft[j] * fact as f64;
        ft[j] = cterm * fact as f64;
    }
}

/// DCFFT_R (DATAT, FT, N, LDWFFT, DWFFTC): normalized double-precision FFT with rearrangement.
pub fn dcfft_r(datat: &[C64], ft: &mut [C64], n: i32, ldwfft: &mut i32, dwfftc: &mut [f64]) {
    let nu = n as usize;
    ft[..nu].copy_from_slice(&datat[..nu]);
    dcfft_r_inplace(ft, n, ldwfft, dwfftc);
}

/// csft_r (DATAT, FT, NCAP): slow FT with rearrangement (IMSL Math, p 716).
pub fn csft_r(datat: &[C32], ft: &mut [C32], ncap: i32) {
    let twopi: f32 = 6.28318530717959_f64 as f32;
    let nc = ncap as usize;
    for m in 1..=ncap {
        let mu = (m - 1) as usize;
        let mut cterm = cmplx(1.0, 0.0);
        ft[mu] = cmplx(0.0, 0.0);
        let cfact = cmplx(0.0, -twopi * (m - 1) as f32 / ncap as f32).exp();
        cterm = cmplx(1.0, 0.0);
        for n in 0..nc {
            ft[mu] = ft[mu] + datat[n] * cterm;
            cterm = cterm * cfact;
        }
    }
    // Scale & rearrange.
    let fact = 1.0f32 / (ncap as f32).sqrt();
    let nunfil = (ncap / 2) as usize;
    for j in 0..nunfil {
        let cterm = ft[nunfil + j];
        ft[nunfil + j] = ft[j] * fact;
        ft[j] = cterm * fact;
    }
}

/// csftin_r (FT, FTWORK, FTINV, NCAP): slow inverse FT of a rearranged FT.
pub fn csftin_r(ft: &[C32], ftwork: &mut [C32], ftinv: &mut [C32], ncap: i32) {
    let twopi: f32 = 6.28318530717959_f64 as f32;
    let nc = ncap as usize;
    // Unrearrange.
    let nunfil = (ncap / 2) as usize;
    for j in 0..nunfil {
        ftwork[j] = ft[nunfil + j];
        ftwork[nunfil + j] = ft[j];
    }
    for n in 1..=ncap {
        let nu = (n - 1) as usize;
        let mut cterm = cmplx(1.0, 0.0);
        ftinv[nu] = cmplx(0.0, 0.0);
        let cfact = cmplx(0.0, twopi * (n - 1) as f32 / ncap as f32).exp();
        cterm = cmplx(1.0, 0.0);
        for m in 0..nc {
            ftinv[nu] = ftinv[nu] + ftwork[m] * cterm;
            cterm = cterm * cfact;
        }
    }
    let fact = 1.0f32 / (ncap as f32).sqrt();
    for j in 0..nc {
        ftinv[j] = ftinv[j] * fact;
    }
}

/// SEQTOT (DATAT, DATAF, NUNFIL, LWFFT, WFFTC): converts NUNFIL sequentially
/// acquired Bruker time-domain data (complex-conjugated, since the Bruker
/// quadrature is at -90 deg). DATAF must hold 2*NUNFIL points. There cannot be
/// peaks in the last RENDS*NUNFIL/2 spectrum points at each end.
pub fn seqtot(datat: &mut [C32], dataf: &mut [C32], nunfil: i32, lwfft: &mut i32, wfftc: &mut [f32]) {
    const NZERO: i32 = 20;
    const RENDS: f32 = 0.05;
    const RZERO: f32 = 0.01;
    let d = |j: i32| (j - 1) as usize;
    // Scale by sqrt(2): the inverse FFT is twice as long.
    for j in 1..=nunfil {
        dataf[d(j)] = cmplx(0.0, -datat[d(j)].im * 1.414214);
    }
    cfft_inplace(dataf, nunfil, lwfft, wfftc);
    // Fill the FFT of the imaginary part with the mean of the high-frequency ends.
    let nhalf = nunfil / 2;
    let nends = nint(RENDS * nhalf as f32);
    let mut endavg = cmplx(0.0, 0.0);
    for j in (nhalf - nends + 1)..=(nhalf + nends) {
        endavg = endavg + dataf[d(j)];
    }
    endavg = endavg / (2 * nends) as f32;
    for j in (nhalf + 1)..=nunfil {
        dataf[d(j + nunfil)] = dataf[d(j)];
        dataf[d(j)] = endavg;
        dataf[d(j + nhalf)] = endavg;
    }
    let ndata = 2 * nunfil;
    cfftin_inplace(dataf, ndata, lwfft, wfftc);
    // Insert the interpolated imaginary part into DATAT (except the first point).
    datat[d(1)] = datat[d(1)].conj();
    let mut jf = 0;
    for j in 2..=nunfil {
        jf = jf + 2;
        datat[d(j)] = cmplx(datat[d(j)].re, dataf[d(jf)].im);
    }
    // Adjust DATAT(1) so that the high-frequency ends of the spectrum are about zero.
    cfft(datat, dataf, nunfil, lwfft, wfftc);
    endavg = cmplx(0.0, 0.0);
    for j in (nhalf - nends + 1)..=(nhalf + nends) {
        endavg = endavg + dataf[d(j)];
    }
    endavg = endavg / (2 * nends) as f32;
    datat[d(1)] = datat[d(1)] - endavg;
    // Zero up to RZERO*NUNFIL points if CABS of the preceding NZERO points are all smaller.
    'l210: for jzero in 1i32.max(nint((1.0 - RZERO) * nunfil as f32))..=nunfil {
        let term = datat[d(jzero)].re * datat[d(jzero)].re + datat[d(jzero)].im * datat[d(jzero)].im;
        if NZERO >= jzero {
            return;
        }
        for j in fdo(jzero - 1, jzero - NZERO, -1) {
            if term <= datat[d(j)].re * datat[d(j)].re + datat[d(j)].im * datat[d(j)].im {
                continue 'l210;
            }
        }
        for j in jzero..=nunfil {
            datat[d(j)] = cmplx(0.0, 0.0);
        }
        return;
    }
}

/// RANDOM (DIX): pseudorandom REAL on (0,1); DIX must start as a whole number
/// in [1, 2147483646]. L. Schrage, ACM TOMS 5, 132 (1979).
pub fn random(dix: &mut f64) -> f32 {
    // 7**5, 2**15, 2**16, 2**31-1
    const A: f64 = 16807.0;
    const B15: f64 = 32768.0;
    const B16: f64 = 65536.0;
    const P: f64 = 2147483647.0;
    // 15 hi order bits of DIX.
    let mut xhi = *dix / B16;
    xhi = xhi - xhi % 1.0;
    // 16 lo bits of DIX and the lo product.
    let xalo = (*dix - xhi * B16) * A;
    // 15 hi order bits of the lo product.
    let mut leftlo = xalo / B16;
    leftlo = leftlo - leftlo % 1.0;
    // 31 highest bits of the full product.
    let fhi = xhi * A + leftlo;
    // Overflow past the 31st bit.
    let mut k = fhi / B15;
    k = k - k % 1.0;
    // Assemble the parts and presubtract P (the parentheses are essential).
    *dix = (((xalo - leftlo * B16) - P) + (fhi - k * B15) * B16) + k;
    if *dix < 0.0 {
        *dix = *dix + P;
    }
    (*dix * 4.656612875e-10) as f32
}

/// FISHNI (F, DF1, DF2, NOUT): Fisher F-distribution (Abramowitz & Stegun 26.6.2, 26.5.2).
pub fn fishni(f: f32, df1: f32, df2: f32, nout: i32, q: &mut ErrQueue) -> R<f32> {
    const CHSUBP: &str = "FISHNI";
    if df1.min(df2) <= 0.0 {
        q.errmes(1, 4, CHSUBP)?;
    }
    let hdf1 = 0.5f32 * df1;
    let hdf2 = 0.5f32 * df2;
    let dum = df1 * f;
    betain(dum / (df2 + dum), hdf1, hdf2, nout, q)
}

/// DGAMLN (XARG): ln Gamma for positive XARG (CACM algorithm 291).
pub fn dgamln(xarg: f64) -> f64 {
    let mut x = xarg;
    let mut p = 1.0f64;
    let mut dgamln = 0.0f64;
    while x < 30.0 {
        p = p * x;
        x = x + 1.0;
    }
    // 150
    if xarg < 30.0 {
        dgamln = -p.ln();
    }
    let z = 1.0 / (x * x);
    dgamln = dgamln + (x - 0.5) * x.ln() - x + 0.918938533204672742
        - (((z / 1680.0 - 1.0 / 1260.0) * z + 1.0 / 360.0) * z - 1.0 / 12.0) / x;
    dgamln
}

/// BETAIN (X, A, B, NOUT): incomplete beta function ratio I_x(A,B)
/// (Abramowitz & Stegun 26.5.5). Error exit if A or B >= 2E4.
pub fn betain(x: f32, a: f32, b: f32, nout: i32, q: &mut ErrQueue) -> R<f32> {
    const CHSUBP: &str = "BETAIN";
    let tol: f32 = 1.0e-8;
    if x < 0.0 || x > 1.0 || a.min(b) <= 0.0 || a.max(b) >= 2.0e4 {
        q.errmes(1, 4, CHSUBP)?;
    }
    let mut betain = x;
    let swap = x > 0.5;
    let (xx, aa, bb): (f32, f32, f32);
    if !swap {
        xx = x;
        aa = a;
        bb = b;
    } else {
        // 150: when SWAP, I_(1-x)(B,A) = 1 - I_x(A,B) is evaluated first.
        xx = (1.0f64 - x as f64) as f32;
        aa = b;
        bb = a;
    }
    // 200
    let cx: f32 = (1.0f64 - xx as f64) as f32;
    if xx.min(x) <= 0.0 || cx.max(x) >= 1.0 {
        return Ok(betain);
    }
    let r = xx / cx;
    // Term IMAX is about the maximum term in the sum; 0 < R < 1 implies IMAX < BB.
    let imax = 0i32.max(int((r * bb - aa - 1.0) / (r + 1.0)));
    let mut ri = imax as f32;
    let mut sum: f32 = 0.0;
    let daa = aa as f64;
    let dri = imax as f64;
    let dbb = bb as f64;
    let mut termax: f32 = ((daa + dri) * (xx as f64).ln() + (dbb - dri - 1.0) * (cx as f64).ln() + dgamln(daa + dbb)
        - dgamln(daa + dri + 1.0)
        - dgamln(dbb - dri)) as f32;
    'l700: {
        if termax < -50.0 {
            break 'l700;
        }
        termax = termax.exp();
        let mut term = termax;
        sum = term;
        // Sum terms for I=IMAX+1,IMAX+2,... until convergence.
        let i1 = imax + 1;
        'l300: {
            for i in i1..=40000 {
                let tnumer = bb - i as f32;
                term = term * r * tnumer / (aa + i as f32);
                sum = sum + term;
                // TNUMER = 0 makes all following terms 0 (BB an integer).
                if term.abs() <= tol * sum || tnumer.abs() <= 1.0e-3 {
                    break 'l300;
                }
            }
            q.errmes(2, 3, CHSUBP)?;
        }
        // 300
        if imax == 0 {
            break 'l700;
        }
        // Sum terms for I=IMAX-1,IMAX-2,... until convergence.
        term = termax;
        for i in fdo(imax, 1, -1) {
            ri = i as f32;
            term = term * (aa + ri) / (r * (bb - ri));
            sum = sum + term;
            if term.abs() <= tol * sum {
                break 'l700;
            }
        }
    }
    // 700
    betain = sum;
    if swap {
        betain = (1.0f64 - betain as f64) as f32;
    }
    Ok(betain)
}

/// DIFF (X, Y) (Lawson & Hanson).
pub fn diff(x: f64, y: f64) -> f64 {
    x - y
}

/// G1 (A, B, COS, SIN, SIG): Givens rotation (Lawson & Hanson). Returns
/// (COS, SIN, SIG); SIG is stored last by the caller, as it may alias A or B.
fn g1(a: f64, b: f64) -> (f64, f64, f64) {
    let zero = 0.0f64;
    let one = 1.0f64;
    if a.abs() > b.abs() {
        let xr = b / a;
        let yr = (one + xr * xr).sqrt();
        let cos = dsign(one / yr, a);
        let sin = cos * xr;
        let sig = a.abs() * yr;
        return (cos, sin, sig);
    }
    // 10
    if b != 0.0 {
        let xr = a / b;
        let yr = (one + xr * xr).sqrt();
        let sin = dsign(one / yr, b);
        let cos = sin * xr;
        let sig = b.abs() * yr;
        return (cos, sin, sig);
    }
    // 30
    (zero, one, zero)
}

/// G2 (COS, SIN, X, Y): apply the rotation from G1 to (X, Y).
fn g2(cos: f64, sin: f64, x: &mut f64, y: &mut f64) {
    let xr = cos * *x + sin * *y;
    *y = -sin * *x + cos * *y;
    *x = xr;
}

/// H12 (MODE, LPIVOT, L1, M, U, IUE, UP, C, ICE, ICV, NCV, RANGE): construct
/// and/or apply a Householder transformation Q = I + U*(U**T)/B (Lawson &
/// Hanson). `u` starts at U(1,1), `c` at C(1).
fn h12(mode: i32, lpivot: i32, l1: i32, m: i32, u: &mut [f64], iue: i32, up: &mut f64, c: &mut [f64], ice: i32, icv: i32, ncv: i32, range: f64) {
    let ui = |j: i32| ((j - 1) * iue) as usize;
    let ci = |i: i32| (i - 1) as usize;
    let one = 1.0f64;
    if 0 >= lpivot || lpivot >= l1 || l1 > m {
        return;
    }
    let rangin = one / range;
    let mut cl = u[ui(lpivot)].abs();
    'l130: {
        if mode != 2 {
            // Construct the transformation.
            for j in l1..=m {
                cl = u[ui(j)].abs().max(cl);
            }
            if cl <= rangin {
                break 'l130;
            }
            let clinv = one / cl;
            let t = u[ui(lpivot)] * clinv;
            let mut sm = t * t;
            for j in l1..=m {
                let t = u[ui(j)] * clinv;
                sm = sm + t * t;
            }
            let sm1 = sm;
            cl = -dsign(cl * sm1.sqrt(), u[ui(lpivot)]);
            *up = u[ui(lpivot)] - cl;
            u[ui(lpivot)] = cl;
        } else {
            // 60: apply the transformation I+U*(U**T)/B to C.
            if cl <= rangin {
                break 'l130;
            }
        }
        // 70
        if ncv <= 0 {
            return;
        }
        let mut b = *up * u[ui(lpivot)];
        // B must be nonpositive here. If B = 0., return.
        if b >= -rangin {
            break 'l130;
        }
        b = one / b;
        let mut i2 = 1 - icv + ice * (lpivot - 1);
        let incr = ice * (l1 - lpivot);
        for j in 1..=ncv {
            i2 = i2 + icv;
            let mut i3 = i2 + incr;
            let mut i4 = i3;
            let mut sm = c[ci(i2)] * *up;
            for i in l1..=m {
                sm = sm + c[ci(i3)] * u[ui(i)];
                i3 = i3 + ice;
            }
            if sm == 0.0 {
                continue;
            }
            sm = sm * b;
            c[ci(i2)] = c[ci(i2)] + sm * *up;
            for i in l1..=m {
                c[ci(i4)] = c[ci(i4)] + sm * u[ui(i)];
                i4 = i4 + ice;
            }
        }
    }
    // 130
}

/// PNNLS (A, MDA, M, N, B, X, DVAR, W, ZZ, INDEX, MODE, RANGE, NONNEG, DVARAC,
/// NSETP): least squares A*X = B with X(J) >= 0 where NONNEG(J) (Lawson &
/// Hanson NNLS). DVAR = DVARAC + RNORM**2. NSETP = number of degrees of
/// freedom. FACTOR is decreased by RFACTR up to MFACTR times when the inner
/// loop exceeds 2*N iterations. MODE: 1 success, 2 bad dimensions,
/// 3 iteration count exceeded.
pub fn pnnls(a: &mut [f64], mda: i32, m: i32, n: i32, b: &mut [f64], x: &mut [f64], dvar: &mut f64, w: &mut [f64], zz: &mut [f64], index: &mut [i32], mode: &mut i32, range: f64, nonneg: &[bool], dvarac: f64, nsetp: &mut i32, q: &mut ErrQueue) -> R<()> {
    const CHSUBP: &str = "PNNLS";
    const MFACTR: i32 = 4;
    const RFACTR: f32 = 0.01;
    let ia = |i: i32, j: i32| ((i - 1) + mda * (j - 1)) as usize;
    let v = |i: i32| (i - 1) as usize;
    let zero = 0.0f64;
    let two = 2.0f64;
    let mut factor = 1.0e-2f64;
    let mut nfactr = 0;
    *mode = 1;
    if !(m > 0 && n > 0) {
        *mode = 2;
        return Ok(());
    }
    // 10
    let mut iter = 0;
    let itmax = 2 * n;
    // Initialize the arrays INDEX() and X().
    for i in 1..=n {
        x[v(i)] = zero;
        index[v(i)] = i;
    }
    let mut iz2 = n;
    let mut iz1 = 1;
    *nsetp = 0;
    let mut npp1 = 1;
    let mut up = 0.0f64;
    let mut dummy = [0.0f64; 1];
    let mut jj = 0;
    let mut izmax = 0;
    // Solve the triangular system (label 400), putting the solution in ZZ().
    let solve_tri = |a: &[f64], zz: &mut [f64], index: &[i32], nsetp: i32, jj: &mut i32| {
        for l in 1..=nsetp {
            let ip = nsetp + 1 - l;
            if l != 1 {
                for ii in 1..=ip {
                    zz[v(ii)] = zz[v(ii)] - a[ia(ii, *jj)] * zz[v(ip + 1)];
                }
            }
            // 420
            *jj = index[v(ip)];
            zz[v(ip)] = zz[v(ip)] / a[ia(ip, *jj)];
        }
    };
    // Main loop.
    'main: loop {
        // 30: quit if all coefficients are in the solution or M columns are triangularized.
        if iz1 > iz2 || *nsetp >= m {
            break 'main;
        }
        // Components of the dual (negative gradient) vector W().
        for iz in iz1..=iz2 {
            let j = index[v(iz)];
            let mut sm = zero;
            for l in npp1..=m {
                sm = sm + a[ia(l, j)] * b[v(l)];
            }
            if nonneg[v(j)] {
                w[v(j)] = sm;
            } else {
                w[v(j)] = sm.abs();
            }
        }
        let mut j;
        let mut iz;
        'l60: loop {
            // Find the largest positive W(J).
            let mut wmax = zero;
            for izz in iz1..=iz2 {
                let jz = index[v(izz)];
                if w[v(jz)] <= wmax {
                    continue;
                }
                wmax = w[v(jz)];
                izmax = izz;
            }
            // WMAX <= 0 satisfies the Kuhn-Tucker conditions.
            if wmax <= 0.0 {
                break 'main;
            }
            // 80
            iz = izmax;
            j = index[v(iz)];
            // Begin the transformation and check the new diagonal element to
            // avoid near linear dependence.
            let asave = a[ia(npp1, j)];
            {
                let colj = &mut a[ia(1, j)..];
                h12(1, npp1, npp1 + 1, m, colj, 1, &mut up, &mut dummy, 1, 1, 0, range);
            }
            let mut unorm = zero;
            if *nsetp != 0 {
                for l in 1..=*nsetp {
                    unorm = unorm + a[ia(l, j)] * a[ia(l, j)];
                }
                unorm = unorm.sqrt();
            }
            // 100
            'l130: {
                if diff(unorm + a[ia(npp1, j)].abs() * factor, unorm) <= 0.0 {
                    break 'l130;
                }
                // 110: column J is sufficiently independent. Copy B into ZZ,
                // update ZZ and solve for ZTEST (proposed new X(J)).
                for l in 1..=m {
                    zz[v(l)] = b[v(l)];
                }
                {
                    let colj = &mut a[ia(1, j)..];
                    h12(2, npp1, npp1 + 1, m, colj, 1, &mut up, zz, 1, 1, 1, range);
                }
                let mut ztest = zz[v(npp1)] / a[ia(npp1, j)];
                if !nonneg[v(j)] {
                    ztest = ztest.abs();
                }
                // See if ZTEST is positive.
                if ztest <= 0.0 {
                    break 'l130;
                }
                break 'l60;
            }
            // 130: reject J; restore A(NPP1,J), set W(J)=0 and test the dual coefficients again.
            a[ia(npp1, j)] = asave;
            w[v(j)] = zero;
        }
        // 140: move J=INDEX(IZ) from set Z to set P. Update B and the
        // indices, apply the Householder transformations to the columns in the
        // new set Z, zero the subdiagonal elements of column J, set W(J)=0.
        for l in 1..=m {
            b[v(l)] = zz[v(l)];
        }
        index[v(iz)] = index[v(iz1)];
        index[v(iz1)] = j;
        iz1 = iz1 + 1;
        *nsetp = npp1;
        npp1 = npp1 + 1;
        if iz1 <= iz2 {
            for jz in iz1..=iz2 {
                jj = index[v(jz)];
                let (colj, coljj) = split_cols(a, ia(1, j), ia(1, jj));
                h12(2, *nsetp, npp1, m, colj, 1, &mut up, coljj, 1, mda, 1, range);
            }
        }
        // 170
        if *nsetp != m {
            for l in npp1..=m {
                a[ia(l, j)] = zero;
            }
        }
        // 190
        w[v(j)] = zero;
        // Solve the triangular system; the solution goes temporarily in ZZ().
        solve_tri(a, zz, index, *nsetp, &mut jj);
        // 200: secondary loop.
        'l210: loop {
            iter = iter + 1;
            if iter > itmax {
                if nfactr >= MFACTR {
                    *mode = 3;
                    break 'main;
                } else {
                    q.errmes(1, 1, CHSUBP)?;
                    nfactr = nfactr + 1;
                    factor = factor * RFACTR as f64;
                    iter = 0;
                }
            }
            // See if all new constrained coefficients are feasible; if not compute ALPHA.
            let mut alpha = two;
            for ip in 1..=*nsetp {
                let l = index[v(ip)];
                if nonneg[v(l)] && zz[v(ip)] <= zero {
                    let t = -x[v(l)] / (zz[v(ip)] - x[v(l)]);
                    if alpha <= t {
                        continue;
                    }
                    alpha = t;
                    jj = ip;
                }
            }
            // If all are feasible ALPHA is still 2: exit to the main loop.
            if alpha == two {
                break 'l210;
            }
            // Otherwise interpolate between the old X and the new ZZ (0 < ALPHA < 1).
            for ip in 1..=*nsetp {
                let l = index[v(ip)];
                x[v(l)] = x[v(l)] + alpha * (zz[v(ip)] - x[v(l)]);
            }
            // Move coefficient I from set P to set Z.
            let mut i = index[v(jj)];
            'l260: loop {
                x[v(i)] = zero;
                if jj != *nsetp {
                    jj = jj + 1;
                    for jx in jj..=*nsetp {
                        let ii = index[v(jx)];
                        index[v(jx - 1)] = ii;
                        let (cc, ss, sig) = g1(a[ia(jx - 1, ii)], a[ia(jx, ii)]);
                        a[ia(jx - 1, ii)] = sig;
                        a[ia(jx, ii)] = zero;
                        for l in 1..=n {
                            if l != ii {
                                let (mut p, mut r) = (a[ia(jx - 1, l)], a[ia(jx, l)]);
                                g2(cc, ss, &mut p, &mut r);
                                a[ia(jx - 1, l)] = p;
                                a[ia(jx, l)] = r;
                            }
                        }
                        let (mut p, mut r) = (b[v(jx - 1)], b[v(jx)]);
                        g2(cc, ss, &mut p, &mut r);
                        b[v(jx - 1)] = p;
                        b[v(jx)] = r;
                    }
                }
                // 290
                npp1 = *nsetp;
                *nsetp = *nsetp - 1;
                iz1 = iz1 - 1;
                index[v(iz1)] = i;
                // The remaining coefficients in set P should be feasible; any
                // nonpositive ones (round-off) are set to zero and moved to set Z.
                for jx in 1..=*nsetp {
                    jj = jx;
                    i = index[v(jj)];
                    if nonneg[v(i)] && x[v(i)] <= zero {
                        continue 'l260;
                    }
                }
                jj = *nsetp + 1;
                break 'l260;
            }
            // Copy B into ZZ, solve again and loop back.
            for i in 1..=m {
                zz[v(i)] = b[v(i)];
            }
            solve_tri(a, zz, index, *nsetp, &mut jj);
            // 320
        }
        // 330: all new coefficients are positive; loop back to the beginning.
        for ip in 1..=*nsetp {
            let i = index[v(ip)];
            x[v(i)] = zz[v(ip)];
        }
    }
    // 350: termination; norm of the final residual vector.
    let mut sm = zero;
    if npp1 <= m {
        for i in npp1..=m {
            sm = sm + b[v(i)] * b[v(i)];
        }
    } else {
        for j in 1..=n {
            w[v(j)] = zero;
        }
    }
    // 390
    *dvar = sm + dvarac;
    Ok(())
}

/// Disjoint views of A from offset `ju` (column J, read by H12 as U) and from
/// offset `jc` (column JJ onward, transformed by H12 as C); J != JJ.
fn split_cols(a: &mut [f64], ju: usize, jc: usize) -> (&mut [f64], &mut [f64]) {
    if jc > ju {
        let (lo, hi) = a.split_at_mut(jc);
        (&mut lo[ju..], hi)
    } else {
        let (lo, hi) = a.split_at_mut(ju);
        (hi, &mut lo[jc..])
    }
}

/// PLPRIN (X, Y1, Y2, N, ONLY1, NOUT, SRANGE, NLINF, NG, MY1, YERR, PLTERR):
/// line-printer plot of Y1 (and Y2 unless ONLY1) against X, with an error
/// band from YERR if PLTERR; prints the NLINF linear coefficients
/// Y1(NG+1..MY1) if NLINF > 0.
pub fn plprin(x: &[f32], y1: &[f32], y2: &[f32], n: i32, only1: bool, nout: i32, srange: f32, nlinf: i32, ng: i32, my1: i32, yerr: &[f64], plterr: bool, io: &mut Units) {
    const CHAR: [&str; 5] = [" ", "X", "O", "*", "."];
    let v = |i: i32| (i - 1) as usize;
    let single = |dub: f64| dub as f32;
    let mut ih: Vec<&str> = vec![" "; 109];
    let mut ymin = srange;
    let mut ymax = -srange;
    for j in 1..=n {
        ymin = ymin.min(y1[v(j)]);
        ymax = ymax.max(y1[v(j)]);
        if only1 {
            continue;
        }
        ymin = ymin.min(y2[v(j)]);
        ymax = ymax.max(y2[v(j)]);
    }
    let mut dum = ymax - ymin;
    let mut nchar = 109;
    if dum <= nchar as f32 / srange {
        dum = 1.0;
    }
    if !plterr {
        io.write(nout, "(/4X,8HORDINATE,2X,8HABSCISSA)", &[]);
    } else {
        nchar = 100;
        io.write(nout, "(/4X,8HORDINATE,4X,5HERROR,2X,8HABSCISSA)", &[]);
    }
    // 140
    let r = (nchar as f32 - 0.001) / dum;
    for j in 1..=n {
        for l1 in 1..=nchar {
            ih[v(l1)] = CHAR[0];
        }
        if plterr {
            let lmin = int(((ymin).max(y1[v(j)] - single(yerr[v(j)]).abs()) - ymin) * r) + 1;
            let lmax = int(((ymax).min(y1[v(j)] + single(yerr[v(j)]).abs()) - ymin) * r) + 1;
            if lmin < lmax {
                for l1 in lmin..=lmax {
                    ih[v(l1)] = CHAR[4];
                }
            }
        }
        // 158
        let l1 = int((y1[v(j)] - ymin) * r) + 1;
        ih[v(l1)] = CHAR[1];
        if !only1 {
            let l2 = int((y2[v(j)] - ymin) * r) + 1;
            ih[v(l2)] = CHAR[2];
            if l1 == l2 {
                ih[v(l2)] = CHAR[3];
            }
        }
        // 160
        if !plterr {
            let mut vals = fv![y1[v(j)], x[v(j)]];
            for c in ih.iter() {
                vals.push(FVal::S(c.to_string()));
            }
            io.write(nout, "(1X,1PE11.3,E10.2,109A1)", &vals);
        }
        if plterr {
            let mut vals = fv![y1[v(j)], yerr[v(j)], x[v(j)]];
            for l1 in 1..=nchar {
                vals.push(FVal::S(ih[v(l1)].to_string()));
            }
            io.write(nout, "(1X,1PE11.3,D9.1,E10.2,100A1)", &vals);
        }
    }
    if nlinf <= 0 {
        return;
    }
    let l2 = ng + 1;
    if !plterr {
        let mut vals = Vec::new();
        for j in l2..=my1 {
            vals.push(FVal::R(y1[v(j)]));
        }
        io.write(nout, "(22H0LINEAR COEFFICIENTS =,1P8E13.4/(22X,8E13.4))", &vals);
    }
    if plterr {
        let mut vals = Vec::new();
        for j in l2..=my1 {
            vals.push(FVal::R(y1[v(j)]));
            vals.push(FVal::D(yerr[v(j)]));
        }
        io.write(
            nout,
            "(22H0LINEAR COEFFICIENTS =, 1PE13.4,3H +-,D9.1,E20.4,3H +-,D9.1,E20.4,3H +-,D9.1/ (22X,1PE13.4,3H +-,D9.1,E20.4,3H +-,D9.1,E20.4,3H +-,D9.1))",
            &vals,
        );
    }
}

/// EIGVrs (NM, N, A, W, Z, FV1, FV2, IERR): eigenvalues (ascending, in W)
/// and eigenvectors (Z) of a real symmetric matrix, via EISPACK tred2 + tql2.
pub fn eigvrs(nm: i32, n: i32, a: &[f32], w: &mut [f32], z: &mut [f32], fv1: &mut [f32], fv2: &mut [f32], ierr: &mut i32) {
    if n > nm {
        *ierr = 10 * n;
        return;
    }
    // Find both eigenvalues and eigenvectors.
    tred2(nm, n, a, w, fv1, z);
    tql2(nm, n, w, fv1, z, ierr);
}

/// tql2 (NM, N, D, E, Z, IERR): eigenvalues and eigenvectors of a symmetric
/// tridiagonal matrix by the QL method (EISPACK, August 1983).
fn tql2(nm: i32, n: i32, d: &mut [f32], e: &mut [f32], z: &mut [f32], ierr: &mut i32) {
    let v = |i: i32| (i - 1) as usize;
    let iz = |i: i32, j: i32| ((i - 1) + nm * (j - 1)) as usize;
    *ierr = 0;
    if n == 1 {
        return;
    }
    for i in 2..=n {
        e[v(i - 1)] = e[v(i)];
    }
    let mut f: f32 = 0.0;
    let mut tst1: f32 = 0.0;
    e[v(n)] = 0.0;
    for l in 1..=n {
        let mut j = 0;
        let mut h = d[v(l)].abs() + e[v(l)].abs();
        if tst1 < h {
            tst1 = h;
        }
        // Look for a small sub-diagonal element.
        let mut m = l;
        while m <= n {
            let tst2 = tst1 + e[v(m)].abs();
            if tst2 == tst1 {
                break;
            }
            // E(N) is always zero, so there is no exit through the bottom of the loop.
            m += 1;
        }
        // 120
        if m != l {
            loop {
                // 130
                if j == 30 {
                    // No convergence to an eigenvalue after 30 iterations.
                    *ierr = l;
                    return;
                }
                j = j + 1;
                // Form shift.
                let l1 = l + 1;
                let l2 = l1 + 1;
                let mut g = d[v(l)];
                let mut p = (d[v(l1)] - g) / (2.0 * e[v(l)]);
                let mut r = pythag(p, 1.0);
                d[v(l)] = e[v(l)] / (p + sign(r, p));
                d[v(l1)] = e[v(l)] * (p + sign(r, p));
                let dl1 = d[v(l1)];
                h = g - d[v(l)];
                if l2 <= n {
                    for i in l2..=n {
                        d[v(i)] = d[v(i)] - h;
                    }
                }
                // 145
                f = f + h;
                // QL transformation.
                p = d[v(m)];
                let mut c: f32 = 1.0;
                let mut c2 = c;
                let el1 = e[v(l1)];
                let mut s: f32 = 0.0;
                let mut c3: f32 = 0.0;
                let mut s2: f32 = 0.0;
                let mml = m - l;
                // For i=m-1 step -1 until l.
                for ii in 1..=mml {
                    c3 = c2;
                    c2 = c;
                    s2 = s;
                    let i = m - ii;
                    g = c * e[v(i)];
                    h = c * p;
                    r = pythag(p, e[v(i)]);
                    e[v(i + 1)] = s * r;
                    s = e[v(i)] / r;
                    c = p / r;
                    p = c * d[v(i)] - s * g;
                    d[v(i + 1)] = h + s * (c * g + s * d[v(i)]);
                    // Form vector.
                    for k in 1..=n {
                        h = z[iz(k, i + 1)];
                        z[iz(k, i + 1)] = s * z[iz(k, i)] + c * h;
                        z[iz(k, i)] = c * z[iz(k, i)] - s * h;
                    }
                }
                p = -s * s2 * c3 * el1 * e[v(l)] / dl1;
                e[v(l)] = s * p;
                d[v(l)] = c * p;
                let tst2 = tst1 + e[v(l)].abs();
                if tst2 > tst1 {
                    continue;
                }
                break;
            }
        }
        // 220
        d[v(l)] = d[v(l)] + f;
    }
    // Order eigenvalues and eigenvectors.
    for ii in 2..=n {
        let i = ii - 1;
        let mut k = i;
        let mut p = d[v(i)];
        for j in ii..=n {
            if d[v(j)] >= p {
                continue;
            }
            k = j;
            p = d[v(j)];
        }
        if k == i {
            continue;
        }
        d[v(k)] = d[v(i)];
        d[v(i)] = p;
        for j in 1..=n {
            p = z[iz(j, i)];
            z[iz(j, i)] = z[iz(j, k)];
            z[iz(j, k)] = p;
        }
    }
}

/// tred2 (NM, N, A, D, E, Z): Householder reduction of a real symmetric
/// matrix to tridiagonal form, accumulating the transformations (EISPACK).
fn tred2(nm: i32, n: i32, a: &[f32], d: &mut [f32], e: &mut [f32], z: &mut [f32]) {
    let v = |i: i32| (i - 1) as usize;
    let iz = |i: i32, j: i32| ((i - 1) + nm * (j - 1)) as usize;
    for i in 1..=n {
        for j in i..=n {
            z[iz(j, i)] = a[iz(j, i)];
        }
        d[v(i)] = a[iz(n, i)];
    }
    'l510: {
        if n == 1 {
            break 'l510;
        }
        // For i=n step -1 until 2.
        for ii in 2..=n {
            let i = n + 2 - ii;
            let l = i - 1;
            let mut h: f32 = 0.0;
            let mut scale: f32 = 0.0;
            'l290: {
                'l130: {
                    if l < 2 {
                        break 'l130;
                    }
                    // Scale row (algol tol then not needed).
                    for k in 1..=l {
                        scale = scale + d[v(k)].abs();
                    }
                    if scale != 0.0 {
                        // 140
                        for k in 1..=l {
                            d[v(k)] = d[v(k)] / scale;
                            h = h + d[v(k)] * d[v(k)];
                        }
                        let mut f = d[v(l)];
                        let mut g = -sign(h.sqrt(), f);
                        e[v(i)] = scale * g;
                        h = h - f * g;
                        d[v(l)] = f - g;
                        // Form a*u.
                        for j in 1..=l {
                            e[v(j)] = 0.0;
                        }
                        for j in 1..=l {
                            f = d[v(j)];
                            z[iz(j, i)] = f;
                            g = e[v(j)] + z[iz(j, j)] * f;
                            let jp1 = j + 1;
                            if l >= jp1 {
                                for k in jp1..=l {
                                    g = g + z[iz(k, j)] * d[v(k)];
                                    e[v(k)] = e[v(k)] + z[iz(k, j)] * f;
                                }
                            }
                            // 220
                            e[v(j)] = g;
                        }
                        // Form p.
                        f = 0.0;
                        for j in 1..=l {
                            e[v(j)] = e[v(j)] / h;
                            f = f + e[v(j)] * d[v(j)];
                        }
                        let hh = f / (h + h);
                        // Form q.
                        for j in 1..=l {
                            e[v(j)] = e[v(j)] - hh * d[v(j)];
                        }
                        // Form reduced a.
                        for j in 1..=l {
                            f = d[v(j)];
                            g = e[v(j)];
                            for k in j..=l {
                                z[iz(k, j)] = z[iz(k, j)] - f * e[v(k)] - g * d[v(k)];
                            }
                            d[v(j)] = z[iz(l, j)];
                            z[iz(i, j)] = 0.0;
                        }
                        break 'l290;
                    }
                }
                // 130
                e[v(i)] = d[v(l)];
                for j in 1..=l {
                    d[v(j)] = z[iz(l, j)];
                    z[iz(i, j)] = 0.0;
                    z[iz(j, i)] = 0.0;
                }
            }
            // 290
            d[v(i)] = h;
        }
        // Accumulation of transformation matrices.
        for i in 2..=n {
            let l = i - 1;
            z[iz(n, l)] = z[iz(l, l)];
            z[iz(l, l)] = 1.0;
            let h = d[v(i)];
            if h != 0.0 {
                for k in 1..=l {
                    d[v(k)] = z[iz(k, i)] / h;
                }
                for j in 1..=l {
                    let mut g: f32 = 0.0;
                    for k in 1..=l {
                        g = g + z[iz(k, i)] * z[iz(k, j)];
                    }
                    for k in 1..=l {
                        z[iz(k, j)] = z[iz(k, j)] - g * d[v(k)];
                    }
                }
            }
            // 380
            for k in 1..=l {
                z[iz(k, i)] = 0.0;
            }
        }
    }
    // 510
    for i in 1..=n {
        d[v(i)] = z[iz(n, i)];
        z[iz(n, i)] = 0.0;
    }
    z[iz(n, n)] = 1.0;
    e[v(1)] = 0.0;
}

/// pythag (A, B): sqrt(a**2+b**2) without overflow or destructive underflow.
fn pythag(a: f32, b: f32) -> f32 {
    let mut p = a.abs().max(b.abs());
    if p != 0.0 {
        let q = a.abs().min(b.abs()) / p;
        let mut r = q * q;
        loop {
            let t = 4.0f32 + r;
            if t == 4.0 {
                break;
            }
            let s = r / t;
            let u = 1.0f32 + 2.0 * s;
            p = u * p;
            let q = s / u;
            r = q * q * r;
        }
    }
    p
}
