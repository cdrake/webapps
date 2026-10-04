//! The nonlinear least-squares analysis (RFALSI ... SAVBES).
//!
//! Translated from LCModel.f 6.3-1N; see PORTING.md.
#![allow(unused_variables, unused_mut, unused_assignments, unused_imports, unreachable_code, unused_labels, clippy::all)]

use crate::format::{self, FVal, RKind, ReadErr};
use crate::fortran::*;
use crate::io::{self, Units, STDOUT};
use crate::numerics::{dcfft_r, dgamln, fishni, pnnls};
use crate::state::*;
use crate::tworeg::{inflec, nextre};
use crate::{fv, ErrQueue, Lcm};

/// SAVEd and static locals of this module's subprograms. The large SOLVE
/// arrays are allocated on the first call to SOLVE.
#[derive(Default, Clone, Debug)]
pub struct Saves {
    /// SOLVE: `COMPLEX*16 BASIYF(1-MINCSD*MSIDES:MY+MINCSD*MSIDES, MMETAB, 2)` (SAVE).
    basiyf: FArr3<C64>,
    /// SOLVE: `COMPLEX*16 basiyf_power(MY, mcoeff_power)` (static; only used with IMETHD=3).
    basiyf_power: FArr2<C64>,
    /// SOLVE: `COMPLEX*16 DCEXOL(MMETAB, 2)` (SAVE).
    dcexol: FArr2<C64>,
    /// SOLVE: `INTEGER LSTOLD(2)` (SAVE).
    lstold: FArr1<i32>,
    /// SOLVE blank COMMON: `DOUBLE PRECISION DAMARQ(MNONL)`.
    damarq: FArr1<f64>,
    /// SOLVE blank COMMON: `COMPLEX*16 DCDATA(MDATA, 5)`.
    dcdata: FArr2<C64>,
    /// SOLVE blank COMMON: `DOUBLE PRECISION DRHS(MROW)`.
    drhs: FArr1<f64>,
    /// SOLVE blank COMMON: `DOUBLE PRECISION DWORK(MROW+MPAR)`.
    dwork: FArr1<f64>,
    /// Copy of the input of an in-place DCFFT_R (DCDATA passed as both arguments).
    fftin: Vec<C64>,
}

impl Saves {
    fn ensure_solve(&mut self) {
        if self.dcexol.data.is_empty() {
            self.basiyf = FArr3::with_bounds([(1 - MINCSD * MSIDES, MY + MINCSD * MSIDES), (1, MMETAB), (1, 2)]);
            self.dcexol = FArr2::new(MMETAB as usize, 2);
            self.lstold = FArr1::new(2);
            self.damarq = FArr1::new(MNONL as usize);
            self.dcdata = FArr2::new(MDATA as usize, 5);
            self.drhs = FArr1::new(MROW as usize);
            self.dwork = FArr1::new((MROW + MPAR) as usize);
        }
    }
}

/// `CALL DCFFT_R (DCDATA(1,COL), DCDATA(1,COL), N, LDWFFT, DWFFTC)`.
fn fft_col(dcdata: &mut FArr2<C64>, col: i32, fftin: &mut Vec<C64>, n: i32, ldwfft: &mut i32, dwfftc: &mut [f64]) {
    let c = dcdata.col_mut(col);
    fftin.clear();
    fftin.extend_from_slice(&c[..n as usize]);
    dcfft_r(fftin, c, n, ldwfft, dwfftc);
}

impl Lcm {
    /// Regula falsi search for an ALPHA with SSQ between SSQMIN and SSQMAX, where
    /// ALPHAB = ALPHB*ALPHA when IALPHA=1 or 3, ALPHAS = ALPHS*ALPHA when IALPHA=2 or 3.
    /// IALPHA = 1 keeping ALPHAS fixed; 2 keeping ALPHAB fixed; 3 varying both.
    /// IRANGE: PRMNMX(*, IRANGE) will be used.
    /// LREPHA = T to rephase and get Reference Solution.
    pub fn rfalsi(
        &mut self,
        ialpha: i32,
        irange: i32,
        lrepha: bool,
        alphb: f64,
        alphs: f64,
        assqlo: f32,
        aalplo: f32,
        assqhi: f32,
        aalphi: f32,
        aalpha: f32,
        prejok: &mut bool,
        prej1: &mut f32,
    ) -> R<()> {
        const CHSUBP: &str = "RFALSI";
        let mut ierror: i32 = 0;
        if irange.min(ialpha) < 1 || irange.max(ialpha) > 3 {
            self.errmes(1, 5, CHSUBP)?;
        }
        if self.c.ralimn.min(self.c.ralinc) <= 1.0 {
            self.errmes(2, 4, CHSUBP)?;
        }
        self.c.is_alpbmn = false;
        let alpbus: f64 = self.c.alpbmx.min(self.c.alpbmn.max(alphb));
        let alpsus: f64 = self.c.alpsmx.min(self.c.alpsmn.max(alphs));
        let mut ssqlo: f32 = assqlo;
        let mut alplo: f32 = aalplo;
        let mut ssqhi: f32 = assqhi;
        let mut alphi: f32 = aalphi;
        let mut alpha: f32 = aalpha;
        if lrepha {
            // Rephase data and get Reference Solution.
            if self.c.lprint > 0 {
                self.io.write(self.c.lprint, "(//////20X, 'Reference Solution for rephased data')", &[]);
            }
            self.rephas()?;
            self.c.alphab = self.c.alpbmn;
            self.c.alphas = self.c.alpsmn;
            self.plinls(2, &mut ierror)?;
            if self.c.object >= self.c.drange {
                self.errmes(3, 4, CHSUBP)?;
            }
            self.c.inisol = false;
            self.c.ssqref = self.c.dssq as f32;
            self.c.ndfref = self.c.ndf;
            self.ssrang(irange)?;
        }
        self.c.daimbs = self.c.rrange;
        let mut ninfle: i32 = 99;
        *prejok = false;
        self.c.alphab = alpbus;
        self.c.alphas = alpsus;
        let mut ssq: f32 = 0.0;
        let mut next: i32 = 0;
        let mut itest: i32 = 0;
        let mut alpold: f32 = 0.0;
        'l700: {
            for jtry in 1..=self.c.mfndal {
                'l310: {
                    let alpbol: f64 = self.c.alphab;
                    let alpsol: f64 = self.c.alphas;
                    if ialpha == 1 {
                        self.c.alphab = self.c.alpbmn.max(self.c.alpbmx.min(alpbus * alpha as f64));
                        // ALPHA must be adjusted (for next ALPHA interpolation) to agree
                        // with any limit imposed by ALPBMN or ALPBMX.
                        alpha = (self.c.alphab / alpbus) as f32;
                        if jtry > 1 {
                            if alpbol.min(self.c.alphab) >= r2d(0.99999) * self.c.alpbmx {
                                if !self.c.nobase {
                                    self.errmes(4, 1, CHSUBP)?;
                                }
                                break 'l700;
                            } else if alpbol.max(self.c.alphab) <= r2d(1.00001) * self.c.alpbmn {
                                self.errmes(5, 1, CHSUBP)?;
                                self.c.is_alpbmn = true;
                                break 'l700;
                            }
                        }
                    } else if ialpha == 2 {
                        self.c.alphas = self.c.alpsmn.max(self.c.alpsmx.min(alpsus * alpha as f64));
                        alpha = (self.c.alphas / alpsus) as f32;
                        if jtry > 1 {
                            if alpsol.min(self.c.alphas) >= r2d(0.99999) * self.c.alpsmx {
                                self.errmes(6, 1, CHSUBP)?;
                                break 'l700;
                            } else if alpsol.max(self.c.alphas) <= r2d(1.00001) * self.c.alpsmn {
                                self.errmes(7, 2, CHSUBP)?;
                                break 'l700;
                            }
                        }
                    } else {
                        self.c.alphab = self.c.alpbmn.max(self.c.alpbmx.min(alpbus * alpha as f64));
                        self.c.alphas = self.c.alpsmn.max(self.c.alpsmx.min(alpsus * alpha as f64));
                        // The limits produce two ALPHAs; readjust ALPHA to the one
                        // furthest from 1 (on log scale).
                        let alpha_alphab: f64 = self.c.alphab / alpbus;
                        let alpha_alphas: f64 = self.c.alphas / alpsus;
                        if alpha_alphab.ln().abs() > alpha_alphas.ln().abs() {
                            alpha = alpha_alphab as f32;
                        } else {
                            alpha = alpha_alphas as f32;
                        }
                        if jtry > 1 {
                            if alpbol.min(self.c.alphab) >= r2d(0.99999) * self.c.alpbmx
                                && alpsol.min(self.c.alphas) >= r2d(0.99999) * self.c.alpsmx
                            {
                                // PREJOK = T for special case that both ALPHAs are max,
                                // and SSQ<SSQMAX nevertheless.
                                *prejok = ssq <= self.c.ssqmax;
                                self.errmes(8, 1, CHSUBP)?;
                                break 'l700;
                            }
                            if alpbol.max(self.c.alphab) <= r2d(1.00001) * self.c.alpbmn
                                && alpsol.max(self.c.alphas) <= r2d(1.00001) * self.c.alpsmn
                            {
                                self.errmes(9, 2, CHSUBP)?;
                                break 'l700;
                            }
                        }
                    }
                    if lrepha {
                        self.plinls(2, &mut ierror)?;
                    } else {
                        self.plinls(3, &mut ierror)?;
                    }
                    ssq = self.c.dssq as f32;
                    if self.c.object < self.c.drange {
                        {
                            let c = &mut self.c;
                            ninfle = inflec(&c.parnln.data, c.nside2, &mut c.dpy.data, &c.dgauss.data, c.thrlin, c.imethd);
                            next = nextre(&c.parnln.data, c.nside2, &mut c.dpy.data, &c.dgauss.data, c.thrlin, c.imethd);
                        }
                        if self.c.mdalpb <= 0 || self.c.usinfl {
                            itest = ninfle - 2;
                        } else {
                            itest = next - 1;
                        }
                        if itest <= 0 && ssq <= self.c.ssqmax {
                            // The peak is smooth and the fit is good; special exit to
                            // stop increasing ALPHAS.
                            *prejok = ialpha == 2
                                || (self.c.alphab >= r2d(0.99999) * self.c.alpbmx && (ialpha == 3 || self.c.nsides <= 1));
                        }
                        if self.c.imethd == 2
                            && ialpha == 2
                            && self.c.alphas >= r2d(0.99999) * self.c.alpsmx
                            && ssq <= self.c.ssqmax
                        {
                            *prejok = true;
                            self.errmes(18, 1, CHSUBP)?;
                        }
                        let rterm: f32 = (ssq - self.c.ssqaim).abs();
                        if rterm < self.c.daimbs {
                            self.c.daimbs = rterm;
                            self.savbes(1)?;
                        }
                    } else {
                        self.errmes(10, 3, CHSUBP)?;
                        alpha = alpha * self.c.ralinc;
                        break 'l310;
                    }
                    if self.c.lprint > 0 {
                        let penb: f32;
                        let pens: f32;
                        let rpen: f32;
                        let mut pen: f32;
                        if self.c.sdref * self.c.sdref > 0.0 {
                            let sd2 = self.c.sdref * self.c.sdref;
                            let alphab = self.c.alphab;
                            let alphas = self.c.alphas;
                            let sol = std::mem::take(&mut self.c.solutn);
                            let par = std::mem::take(&mut self.c.parnln);
                            let p1 = self.penlty(alphab, 0.0, &sol.data, &par.data);
                            let p2 = self.penlty(0.0, alphas, &sol.data, &par.data);
                            self.c.solutn = sol;
                            self.c.parnln = par;
                            penb = (p1 / sd2) as f32;
                            pens = (p2 / sd2) as f32;
                            if pens > 0.0 {
                                rpen = penb / pens;
                            } else {
                                rpen = self.c.rrange;
                            }
                            pen = ((self.c.object - self.c.dssq) / sd2) as f32;
                            if (self.c.alphab as f32) < self.c.alpbpn {
                                pen = pen + self.c.pnalpb;
                            }
                        } else {
                            penb = self.c.rrange;
                            pens = self.c.rrange;
                            rpen = self.c.rrange;
                            pen = self.c.rrange;
                        }
                        let c = &self.c;
                        self.io.write(
                            c.lprint,
                            "(/' ITER =',I2,'     ALPHAB =', 1PE10.3, 3X, 'ALPHAS =', E10.3, 6X, 'Ninfle =', I2, 6X, '(SSQ', E14.6, ' <', E14.6,' <',E14.6,')'/ 14X, 'penB/penS =', E9.2, ' /', E9.2, ' =', E9.2, 3X, 'Nextre =', I2, / 14X, 'Penalty =', E12.4, 24X, 'Penalty*SDREF**2 (w/o prior) =', E10.2)",
                            &fv![jtry, c.alphab, c.alphas, ninfle, ssqlo, ssq, ssqhi, penb, pens, rpen, next, pen, c.object - c.dssq],
                        );
                        if self.c.iter_dump == jtry
                            && (self.c.alphab - self.c.alphab_dump as f64).abs() <= 1.0e-3 * self.c.alphab
                            && (self.c.alphas - self.c.alphas_dump as f64).abs() <= 1.0e-3 * self.c.alphas
                        {
                            self.savbes(1)?;
                            self.savbes(2)?;
                            self.finout()?;
                            return stop("STOP");
                        }
                    }
                    if *prejok {
                        // Special exit when either of the above 2 criteria are satisfied.
                        self.savbes(1)?;
                        break 'l700;
                    }
                    alpold = alpha;
                    'l320: {
                        if ssq <= self.c.ssqref.max(ssqlo) {
                            if ssq >= self.c.ssqref {
                                // Probably due to a local min. in a preceding solution.
                                self.errmes(11, 1, CHSUBP)?;
                            } else {
                                // Probably a local min. in the Reference Solution.
                                // Redefine the present solution as the Reference Solution.
                                self.errmes(12, 1, CHSUBP)?;
                                self.c.ssqref = ssq;
                                self.c.ndfref = self.c.ndf;
                                self.ssrang(irange)?;
                            }
                            ssqlo = ssq;
                            alplo = alpha;
                            if alphi < self.c.rrange {
                                alpha = (0.5 * (alpha + alphi)).min(alpha * self.c.ralinc);
                            } else {
                                alpha = alpha * self.c.ralinc;
                            }
                            break 'l320;
                        }
                        if ssq >= ssqhi {
                            // Probably due to round-off or to a local min. in this solution.
                            alpha = (0.5 * (alpha + alplo)).max(alpha / self.c.ralinc);
                            self.errmes(13, 1, CHSUBP)?;
                            break 'l320;
                        }
                        let c = &self.c;
                        if ssq > c.ssqmax {
                            if ssqhi - c.ssqaim <= c.ssqaim - ssqlo {
                                // SSQLO is too far away for interpolation. Extrapolate using SSQHI.
                                alpha = (alpha / c.ralinc).max(alphi - (alphi - alpha) * (ssqhi - c.ssqaim) / (ssqhi - ssq));
                                // If extrapolation goes back behind ALPLO, then take midpoint.
                                if alpha <= alplo {
                                    alpha = 0.5 * (alpold + alplo);
                                }
                            } else if ssqlo < 0.0 {
                                alpha = alpha / c.ralinc;
                            } else {
                                // Normal interpolation.
                                alpha = alplo + (alpha - alplo) * (c.ssqaim - ssqlo) / (ssq - ssqlo);
                            }
                            alphi = alpold;
                            ssqhi = ssq;
                        } else if ssq < c.ssqmin {
                            if ssqhi >= c.rrange {
                                if ssqlo < 0.0 {
                                    alpha = alpha * c.ralinc;
                                } else {
                                    // Limited extrapolation.
                                    let test: f32 = alplo + (alpha - alplo) * (c.ssqaim - ssqlo) / (ssq - ssqlo);
                                    alpha = test.min(c.xtrpmx * alpha);
                                }
                            } else if c.ssqaim - ssqlo <= ssqhi - c.ssqaim && ssqlo > 0.0 {
                                // SSQHI is too far away for interpolation. Extrapolate using SSQLO.
                                alpha = alplo + (alpha - alplo) * (c.ssqaim - ssqlo) / (ssq - ssqlo);
                                if alpha >= alphi {
                                    // Limit extrapolation beyond ALPHI and remove ALPHI as
                                    // upper bound (it could have been a local min.).
                                    alpha = alpha.min(alpold * c.ralinc);
                                    alphi = c.rrange;
                                    ssqhi = c.rrange;
                                }
                            } else {
                                // Normal interpolation.
                                alpha = alpha + (alphi - alpha) * (c.ssqaim - ssq) / (ssqhi - ssq);
                            }
                            alplo = alpold;
                            ssqlo = ssq;
                        } else {
                            break 'l700;
                        }
                    }
                    // Label 320.
                    if alpha / alpold > 1.0 && alpha / alpold < self.c.ralimn {
                        // Too small an increase in ALPHA could be due to too low an
                        // upper bound; remove it.
                        ssqhi = self.c.rrange;
                        alphi = self.c.rrange;
                    } else if alpold / alpha > 1.0 && alpold / alpha < self.c.ralimn {
                        // Too small a decrease could be due to too high a lower bound.
                        ssqlo = -1.0 / self.c.rrange;
                        alplo = 0.0;
                    }
                }
            }
            self.errmes(14, 2, CHSUBP)?;
        }
        // Label 700.
        if self.c.daimbs >= self.c.rrange {
            self.errmes(15, 4, CHSUBP)?;
        }
        if self.c.ssqref * self.c.ndfref as f32 <= 0.0 {
            self.errmes(16, 3, CHSUBP)?;
            *prej1 = -1.0;
        } else {
            let c = &self.c;
            let f = 0f32.max(c.ssqbes[1] - c.ssqref) * (c.nyuse - c.ndfref) as f32 / (c.ssqref * c.ndfref as f32);
            let mut q = ErrQueue::new();
            let r = fishni(f, c.ndfref as f32, (c.nyuse - c.ndfref) as f32, c.lprint, &mut q);
            *prej1 = self.after(q, r)?;
            if self.c.lprint > 0 {
                self.io.write(self.c.lprint, "(/' Probability to reject =',F7.4)", &fv![*prej1]);
            }
            let c = &self.c;
            *prejok = *prejok || (*prej1 >= 0.99 * c.prmnmx[(1, irange)] && *prej1 <= 1.01 * c.prmnmx[(2, irange)]);
            // PREJOK = F together with an alpha = alpha_max is probably harmless.
            if !*prejok && c.alphab < r2d(0.99999) * c.alpbmx && c.alphab > r2d(1.00001) * c.alpbmn {
                self.errmes(17, 2, CHSUBP)?;
            }
        }
        Ok(())
    }

    /// PENLTY = regularizor penalty for ALPHAB=ALPB and ALPHAS=ALPS multiplied by
    /// SDREF**2; 0 if SDREF has not yet been computed. REGF is for the lineshape
    /// coefficients with the center one eliminated by the equality constraint, so
    /// its first 3 rows have the constants 2, -1, -1 on the rhs.
    /// `sol` is SOL(MPAR), `parnl` is PARNL(MNONL), both 1-based.
    fn penlty(&mut self, alpb: f64, alps: f64, sol: &[f64], parnl: &[f64]) -> f64 {
        let c = &mut self.c;
        let mut penlty: f64 = 0.0;
        if c.sdref >= c.drange {
            return penlty;
        }
        if alpb > 0.0 {
            for irow in 1..=c.nbackg {
                c.dterm[1] = 0.0;
                for icol in 1..=c.nbackg {
                    c.dterm[1] = c.dterm[1] + c.regb[(irow, icol)] as f64 * sol[(c.nmetab + icol - 1) as usize];
                }
                let t = alpb * c.dterm[1];
                penlty = penlty + t * t;
            }
        }
        if alps > 0.0 {
            if c.imethd == 2 {
                for jmetab in 1..=c.nmetab {
                    let jnonl = c.lrt2st - 1 + jmetab;
                    // CONC_EXPECT = expectation of relative CONC; RT2MIN = 1/T2 of the
                    // initial Gaussian; RLRNTZ penalizes Lorentzian broadening.
                    c.dterm[1] = alps * sol[(jmetab - 1) as usize] / c.conc_expect[jmetab] as f64;
                    if c.ipowrg == 1 {
                        let t = c.dterm[1] * (c.rt2min[jmetab] as f64 + c.rlrntz as f64 * parnl[(jnonl - 1) as usize]);
                        penlty = penlty + t * t;
                    } else {
                        let u = c.rt2min[jmetab] as f64 + c.rlrntz as f64 * parnl[(jnonl - 1) as usize];
                        c.dterm[2] = u * u;
                        let t = c.dterm[1] * c.dterm[2];
                        penlty = penlty + t * t;
                    }
                }
            } else {
                for irow in 1..=c.nregf {
                    if irow == 1 {
                        c.dterm[1] = -2.0;
                    } else if irow <= 3 {
                        c.dterm[1] = 1.0;
                    } else {
                        c.dterm[1] = 0.0;
                    }
                    for icol in 1..=c.nside2 {
                        c.dterm[1] = c.dterm[1] + c.regf[(irow, icol)] * parnl[(icol - 1) as usize];
                    }
                    let t = alps * c.dterm[1];
                    penlty = penlty + t * t;
                }
            }
        }
        penlty * (c.sdref * c.sdref)
    }

    /// PENLTY with SOL = SOLUTN and PARNL = PARNLN.
    fn penlty_solutn_parnln(&mut self, alpb: f64, alps: f64) -> f64 {
        let sol = std::mem::take(&mut self.c.solutn);
        let par = std::mem::take(&mut self.c.parnln);
        let p = self.penlty(alpb, alps, &sol.data, &par.data);
        self.c.solutn = sol;
        self.c.parnln = par;
        p
    }

    /// Rephases CY using phases in PARBES(*,2); loads PARBES(*,2) into PARNLN.
    pub fn rephas(&mut self) -> R<()> {
        let c = &mut self.c;
        let lphast = c.lphast;
        c.phitot[1] = (c.phitot[1] as f64 + c.parbes[(lphast, 2)]) as f32;
        c.phitot[2] = (c.phitot[2] as f64 + c.parbes[(lphast + 1, 2)]) as f32;
        if c.lprint > 0 {
            self.io.write(
                c.lprint,
                "(/'Rephasing to', f7.1, ' deg;   ', f8.2, ' deg/ppm'/)",
                &fv![c.phitot[1] / c.radian, c.phitot[2] / c.radian],
            );
        }
        c.cterm[1] = cmplx(0.0, (c.parbes[(lphast, 2)] + c.parbes[(lphast + 1, 2)] * c.delppm[1] as f64) as f32).exp();
        c.cterm[2] = cmplx(0.0, -((c.parbes[(lphast + 1, 2)] * c.ppminc as f64) as f32)).exp();
        for jy in 1..=c.ny {
            c.cy[jy] = c.cy[jy] * c.cterm[1];
            c.cterm[1] = c.cterm[1] * c.cterm[2];
        }
        c.parbes[(lphast, 2)] = 0.0;
        c.parbes[(lphast + 1, 2)] = 0.0;
        for jnonl in 1..=c.nnonl {
            c.parnln[jnonl] = c.parbes[(jnonl, 2)];
        }
        Ok(())
    }

    /// FSHSSQ = the weighted sum of squared deviations corresponding to the
    /// Fisher variance ratio for PREJ (the probability to reject), REFNDF (the
    /// degrees of freedom of the Reference Solution), NYuse, and SSQREF.
    pub fn fshssq(&mut self, prej: f32, idfish: i32, nyuse: i32, refndf: f32, ssqref: f32, lprint: i32, rrange: f32) -> R<f32> {
        const CHSUBP: &str = "FSHSSQ";
        let mtry: i32 = 20;
        let ptol: f32 = 5.0e-4;
        if prej.min(ssqref) <= 0.0 || prej >= 1.0 || refndf <= 1.0 || refndf >= (nyuse - 1) as f32 {
            self.errmes(1, 4, CHSUBP)?;
        }
        // Approximate inverse of the F-distribution (Abramowitz and Stegun).
        // YP = inverse of the complementary normal distribution for PREJ (A&S 26.2.23).
        let exmax: f32 = rrange.ln();
        let pcomp: f32 = 1.0 - prej;
        let psmall: f32 = if pcomp <= 0.5 { pcomp } else { prej };
        let tt: f32 = (-2.0 * psmall.ln()).sqrt();
        let mut yp: f32 = tt
            - (2.515517 + tt * (0.802853 + tt * 0.010328)) / (1.0 + tt * (1.432788 + tt * (0.189269 + tt * 0.001308)));
        if pcomp > 0.5 {
            yp = -yp;
        }
        // A&S 26.6.16 and 26.5.22 give the approximate F value in FF.
        let r2am1: f32 = 1.0 / ((nyuse - 1) as f32 - refndf);
        let r2bm1: f32 = 1.0 / (refndf - 1.0);
        let slambd: f32 = (yp * yp - 3.0) / 6.0;
        let hh: f32 = 2.0 / (r2am1 + r2bm1);
        let mut dum: f32 = hh + slambd;
        if dum <= 0.0 {
            // So few degrees of freedom that the approximation is very poor.
            dum = 0.0;
            self.errmes(2, 3, CHSUBP)?;
        }
        let ww: f32 = yp * dum.sqrt() / hh - (r2bm1 - r2am1) * (slambd + (5.0 - 4.0 / hh) / 6.0);
        if 2.0 * ww >= exmax {
            self.errmes(3, 4, CHSUBP)?;
        }
        let mut ff: f32 = (2.0 * ww).exp();
        // Newton's method to refine FF so that its PREJ is within PTOL.
        let mut dpbest: f32 = rrange;
        let df1: f32 = refndf;
        let hdf1: f32 = 0.5 * df1;
        let df2: f32 = nyuse as f32 - refndf;
        let hdf2: f32 = 0.5 * df2;
        let faclog: f32 = (dgamln((hdf1 + hdf2) as f64) - dgamln(hdf1 as f64) - dgamln(hdf2 as f64)
            + (hdf1 * df1.ln()) as f64
            + (hdf2 * df2.ln()) as f64) as f32;
        let exp1: f32 = hdf1 - 1.0;
        let exp2: f32 = -hdf1 - hdf2;
        let mut fbest: f32 = rrange;
        'l300: {
            for jtry in 1..=mtry {
                let mut q = ErrQueue::new();
                let r = fishni(ff, df1, df2, lprint, &mut q);
                let prtry: f32 = self.after(q, r)?;
                let dprtry: f32 = prtry - prej;
                if dprtry.abs() <= dpbest {
                    dpbest = dprtry.abs();
                    fbest = ff;
                    if dpbest <= ptol {
                        break 'l300;
                    }
                }
                let dpdf: f32 = (faclog + exp1 * ff.ln() + exp2 * (df2 + df1 * ff).ln()).exp();
                if dpdf <= 0.0 {
                    self.errmes(4, 2, CHSUBP)?;
                    break 'l300;
                }
                ff = ff - dprtry / dpdf;
                if ff <= 0.0 {
                    self.errmes(5, 3, CHSUBP)?;
                    break 'l300;
                }
            }
            self.errmes(6, 3, CHSUBP)?;
        }
        Ok(ssqref * (1.0 + fbest * df1 / df2))
    }

    /// Nonlinear least-squares analysis with the first NLIN parameters linear
    /// and NLIN+1..NPAR nonlinear. SOLUTN(1:NLIN) = linear parameters,
    /// SOLUTN(NLIN+1:NPAR) = full steps for the nonlinear parameters PARNLN.
    /// ISTAGE = 1 preliminary; 2 Reference Solution or other difficult one;
    /// 3 regularized solution of full analysis.
    /// IERROR = 1 on normal return, 2 on max. iterations.
    pub fn plinls(&mut self, istage: i32, ierror: &mut i32) -> R<()> {
        const CHSUBP: &str = "PLINLS";
        let mut lerror = false;
        let mut solold: FArr1<f64> = FArr1::new(MPAR as usize);
        if istage <= 0 || istage > 3 {
            self.errmes(1, 5, CHSUBP)?;
        }
        let is = istage;
        {
            let c = &self.c;
            let amin = c.pmqst[is]
                .min(c.pmqstl[is])
                .min(c.rstpmx[is])
                .min(c.rconvr[is])
                .min(c.rmqdec[is])
                .min(c.rmqinc[(1, is)])
                .min(c.rmqinc[(2, is)])
                .min(c.cosmin[is])
                .min(c.rincrs[is])
                .min(c.rpmqmn[is]);
            let amax = c.rstpmn[is].max(c.rconvr[is]).max(c.rmqdec[is]).max(c.rincrs[is]);
            if amin <= 0.0 || amax >= 1.0 {
                self.errmes(2, 4, CHSUBP)?;
            }
        }
        let lstage: i32 = 2.min(istage);
        let mut pmarq: f64 = self.c.pmqst[is] as f64;
        let mut pmqact: f64 = 0.0;
        let mut cosine: f32 = -2.0;
        let mut rstep: f32 = 0.0;
        *ierror = 1;
        let mut interp: i32 = 0;
        let mut actred: f32 = 0.0;
        let mut prered: f32 = 0.0;
        let mut tryzer = true;
        let mut nzbad: i32 = 0;
        let mut nzskip: i32 = 0;
        // Initialize nonnegativity constraints on delta(1/T2).
        {
            let c = &mut self.c;
            for jnonl in c.lrt2st..=c.nnonl {
                c.nonneg[c.nlin + jnonl] = c.parnln[jnonl] <= 0.0;
            }
        }
        // Get OBJECT = objective function.
        self.solve(lstage, false, 0.0, false, &mut lerror)?;
        if lerror {
            self.c.object = self.c.drange;
            self.c.stddev = self.c.drange;
        }
        const F5210: &str = "(1X, I4, 1PE14.6, E12.3, E13.3, I6, E12.2, 0P2F12.6, I11, 2F10.2, 1PE15.4)";
        if self.c.lprint > 0 {
            self.io.write(
                self.c.lprint,
                "(////' Iter', 3X, 'Obj. funct.', 3X, 'Rel. dec.', 3X, 'Pred. dec.', 3X, 'NDF', 3X, 'Marquardt', 3X, 'Rel. step', 6X, 'Cosine', 3X, 'Interps.', 3X, 'Degrees', 3X, 'Deg/ppm')",
                &[],
            );
        }
        let mut pmqold: f64 = 0.0;
        let mut objold: f64 = 0.0;
        let mut sdold: f64 = 0.0;
        let mut iterol: i32;
        let mut dgzer: f32;
        let mut dgppm: f32;
        let iter_last = self.c.miter[is] + 1;
        let iter: i32 = 'l300: {
            'l210: for iter in 1..=iter_last {
                pmqold = pmqact;
                objold = self.c.object;
                sdold = self.c.stddev;
                iterol = iter - 1;
                dgzer = (self.c.parnln[self.c.lphast] / self.c.radian as f64) as f32;
                dgppm = (self.c.parnln[self.c.lphast + 1] / self.c.radian as f64) as f32;
                if self.c.lprint > 0 {
                    let c = &self.c;
                    self.io.write(
                        c.lprint,
                        F5210,
                        &fv![iterol, c.object, actred, prered, c.ndf, pmqact, rstep, cosine, interp, dgzer, dgppm],
                    );
                }
                if self.c.idump[is] >= 2 && self.c.lprint > 0 {
                    self.dump1(lstage)?;
                }
                interp = 0;
                cosine = -2.0;
                {
                    let c = &mut self.c;
                    for jnonl in 1..=c.nnonl {
                        c.parold[jnonl] = c.parnln[jnonl];
                    }
                    for jpar in 1..=c.nlin {
                        solold[jpar] = c.solutn[jpar];
                    }
                }
                'l280: {
                    'l222: {
                        if tryzer && self.c.dozero[is] && nzskip <= 0 {
                            // Compute new direction, first trying 0 Marquardt parameter.
                            self.solve(lstage, true, 0.0, false, &mut lerror)?;
                            if lerror {
                                break 'l222;
                            }
                            cosine = -2.0;
                            pmqact = 0.0;
                            rstep = 1.0;
                            self.pastep(&mut rstep);
                            self.solve(lstage, false, 0.0, false, &mut lerror)?;
                            if self.c.object >= objold {
                                nzbad += 1;
                                nzskip = nzbad;
                            } else {
                                nzbad = 0;
                            }
                        } else {
                            nzskip -= 1;
                        }
                    }
                    // Label 222.
                    if self.c.object >= objold || !(tryzer && self.c.dozero[is]) || lerror {
                        // Try again with PMARQ.
                        {
                            let c = &mut self.c;
                            for jnonl in 1..=c.nnonl {
                                c.parnln[jnonl] = c.parold[jnonl];
                            }
                            for jpar in 1..=c.nlin {
                                c.solutn[jpar] = solold[jpar];
                            }
                        }
                        self.solve(lstage, true, pmarq, false, &mut lerror)?;
                        if lerror {
                            break 'l280;
                        }
                        pmqact = pmarq;
                        rstep = 1.0;
                        self.pastep(&mut rstep);
                        self.solve(lstage, false, 0.0, false, &mut lerror)?;
                        if lerror {
                            break 'l280;
                        }
                    }
                    if objold <= 0.0 {
                        self.errmes(3, 2, CHSUBP)?;
                        break 'l300 iter;
                    } else {
                        prered = (1.0 - self.c.objlin / objold) as f32;
                        actred = (1.0 - self.c.object / objold) as f32;
                    }
                    // Test objective function.
                    self.c.pmqsav = pmqact;
                    tryzer = actred >= -self.c.rincrs[is];
                    if tryzer {
                        // Objective function has not significantly increased with a
                        // full step. Decrease Marquardt parameter PMARQ.
                        let c = &self.c;
                        pmarq = (c.rpmqmn[is] as f64 * c.precis).max(pmarq * c.rmqdec[is] as f64);
                        // Convergence test.
                        if prered.abs().max(actred.abs()) <= c.rconvr[is]
                            && actred.abs() < 2.0 * prered.abs()
                            && pmqact < c.pmqstl[is] as f64
                            && rstep >= 1.0
                        {
                            break 'l300 iter;
                        }
                        continue 'l210;
                    } else {
                        // Objective function has significantly increased. Test the
                        // cosine of the angle between gradient and step.
                        let mut grad2: f64 = 0.0;
                        let mut step2: f64 = 0.0;
                        let mut gradst: f64 = 0.0;
                        {
                            let c = &self.c;
                            for jnonl in 1..=c.nnonl {
                                grad2 = grad2 + c.grad[jnonl] * c.grad[jnonl];
                                step2 = step2 + c.solutn[c.nlin + jnonl] * c.solutn[c.nlin + jnonl];
                                gradst = gradst + c.grad[jnonl] * c.solutn[c.nlin + jnonl];
                            }
                        }
                        if gradst > 0.0 {
                            self.errmes(4, 1, CHSUBP)?;
                        }
                        self.c.dterm[1] = step2.sqrt() * grad2.sqrt();
                        if self.c.dterm[1] <= 0.0 {
                            self.errmes(5, 2, CHSUBP)?;
                            break 'l280;
                        }
                        cosine = (-gradst / self.c.dterm[1]) as f32;
                        if cosine < self.c.cosmin[is] {
                            break 'l280;
                        }
                        // Gradient and step are close enough to parallel. Interpolate
                        // to get RSTEP (fractional step size).
                        let minter = self.c.minter[is];
                        interp = 1;
                        while interp <= minter {
                            if pmqact > 0.0 {
                                pmarq = pmarq * self.c.rmqinc[(2, is)] as f64;
                            }
                            self.c.dterm[1] = objold - self.c.object + gradst * rstep as f64;
                            if self.c.dterm[1].abs() <= 0.0 {
                                // Denominator exactly zero: next iteration with an
                                // increased Marquardt parameter.
                                self.errmes(6, 3, CHSUBP)?;
                                break 'l280;
                            }
                            rstep = (0.5 * gradst * (rstep * rstep) as f64 / self.c.dterm[1]) as f32;
                            // Unreasonable fractional step: next iteration with an increased PMARQ.
                            if rstep < self.c.rstpmn[is] || rstep > self.c.rstpmx[is] {
                                break 'l280;
                            }
                            self.pastep(&mut rstep);
                            self.solve(lstage, false, 0.0, false, &mut lerror)?;
                            if lerror {
                                break 'l280;
                            }
                            if self.c.object < objold {
                                continue 'l210;
                            }
                            interp += 1;
                        }
                    }
                }
                // Label 280: unsuccessful. Restore PAROLD, OBJOLD and SDOLD; increase PMARQ.
                let c = &mut self.c;
                for jnonl in 1..=c.nnonl {
                    c.parnln[jnonl] = c.parold[jnonl];
                }
                for jpar in 1..=c.nlin {
                    c.solutn[jpar] = solold[jpar];
                }
                c.object = objold;
                c.stddev = sdold;
                c.pmqsav = pmqold;
                if pmqact > 0.0 {
                    pmarq = (pmarq * c.rmqinc[(1, is)] as f64).max(c.pmqstl[is] as f64);
                }
            }
            *ierror = 2;
            if istage >= 2 {
                self.errmes(7, 1, CHSUBP)?;
            }
            fdo_end(1, iter_last, 1)
        };
        // Label 300.
        iterol = iter - 1;
        dgzer = (self.c.parnln[self.c.lphast] / self.c.radian as f64) as f32;
        dgppm = (self.c.parnln[self.c.lphast + 1] / self.c.radian as f64) as f32;
        if self.c.lprint > 0 {
            let c = &self.c;
            self.io.write(c.lprint, F5210, &fv![iterol, c.object, actred, prered, c.ndf, pmqact, rstep, cosine, interp, dgzer, dgppm]);
        }
        if self.c.idump[is] >= 1 && self.c.lprint > 0 {
            self.dump1(lstage)?;
        }
        Ok(())
    }

    /// DUMP1.
    fn dump1(&mut self, lstage: i32) -> R<()> {
        let c = &self.c;
        if c.lprint <= 0 {
            return Ok(());
        }
        let v: Vec<FVal> = (1..=c.nmetab).map(|j| FVal::D(c.solutn[j])).collect();
        self.io.write(c.lprint, "(' Conc =', 1P10E12.3/ (7X, 1P10E12.3))", &v);
        if c.nbackg > 0 {
            let v: Vec<FVal> = (c.nmetab + 1..=c.nmetab + c.nbackg).map(|j| FVal::D(c.solutn[j])).collect();
            self.io.write(c.lprint, "(' Backgr =', 1P10E12.3/ (9X, 1P10E12.3))", &v);
        }
        if c.nside2 > 0 {
            let v: Vec<FVal> = (1..=c.nside2).map(|j| FVal::D(c.parnln[j])).collect();
            self.io.write(c.lprint, "(' Lineshape =', 10F12.4/ (12X, 10F12.4))", &v);
        }
        let f = (2.0 * c.pi * c.hzpppm) as f64;
        let v: Vec<FVal> = (c.lshist..=c.lshist + c.nexpon - 1).map(|j| FVal::D(c.parnln[j] / f)).collect();
        self.io.write(c.lprint, "(' 1000*Shift =', 3P10F11.2/ (13X, 10F11.2))", &v);
        if lstage == 1 {
            self.io.write(c.lprint, "(' Gaussian FWHM (ppm) =', F8.4)", &fv![c.tofwhm as f64 * c.parnln[c.lrt2st]]);
        } else {
            let v: Vec<FVal> = (c.lrt2st..=c.nnonl).map(|j| FVal::D(c.parnln[j])).collect();
            self.io.write(c.lprint, "(' delta(1/T2) =', 10F11.2/ (14X, 10F11.2))", &v);
        }
        Ok(())
    }

    /// PASTEP: limit RSTEP and take the step PARNLN = PAROLD + RSTEP*SOLUTN(NLIN+*).
    fn pastep(&mut self, rstep: &mut f32) {
        let c = &mut self.c;
        for jnonl in 1..=c.nnonl {
            if c.solutn[c.nlin + jnonl] != 0.0 {
                *rstep = rstep.min((c.fstpmq * (c.dparmq[jnonl] / c.solutn[c.nlin + jnonl]) as f32).abs());
            }
        }
        // Enforce nonnegativity of delta(1/T2).
        let mut lpar: i32 = 0;
        for jnonl in c.lrt2st..=c.nnonl {
            let jpar = c.nlin + jnonl;
            if c.solutn[jpar] < 0.0 && !c.nonneg[jpar] {
                let term: f32 = (c.parnln[jnonl] / c.solutn[jpar]).abs() as f32;
                if term < *rstep {
                    *rstep = term;
                    lpar = jpar;
                }
            }
            c.nonneg[jpar] = c.nonneg[jpar] && c.solutn[jpar] <= 0.0;
        }
        if lpar != 0 {
            c.nonneg[lpar] = true;
        }
        for jnonl in 1..=c.nnonl {
            c.parnln[jnonl] = c.parold[jnonl] + *rstep as f64 * c.solutn[c.nlin + jnonl];
        }
    }

    /// Sets up and solves the nonnegative linear least-squares problem.
    ///
    /// SOLVE must first be called with PMQACT=0 and DONONL=ONLYFT=F so that SDREF
    /// can be initialized for computing the Marquardt rows.
    /// LSTAGE = 1 preliminary unregularized analysis (1 Gaussian broadener,
    /// 1 shift, NSIDES=0, no priors); 2 full analysis.
    /// ONLYFT = T to only compute YFITRE/BACKRE/YREAL for plotting, leaving DAMAT
    /// for error estimates from the previous call.
    /// DONONL = T for SOLUTN and OBJLIN; F for OBJECT and the linear SOLUTN only.
    ///
    /// Columns (reduced by NLESS above NLIN): 1..NMETAB concentrations,
    /// ..NLIN background, then lineshape, LPHAST/LPHAST+1 phases, LSHIST.. shifts,
    /// LRT2ST.. delta(1/T2). Rows: NY data, NRATIO_USED ratio priors, shift priors,
    /// delta(1/T2) priors, phase priors (= NROWDA), background regularizor,
    /// lineshape regularizor, Marquardt rows.
    pub fn solve(&mut self, lstage: i32, dononl: bool, pmqact: f64, onlyft: bool, lerror: &mut bool) -> R<()> {
        const CHSUBP: &str = "SOLVE";
        self.s_solve.ensure_solve();
        let mut dcsum: [C64; 3] = [C64::ZERO; 3];
        if self.c.initialize_solve {
            self.c.initialize_solve = false;
            let s = &mut self.s_solve;
            for k in 1..=2 {
                s.lstold[k] = 0;
                for j in 1..=MMETAB {
                    s.dcexol[(j, k)] = C64::ZERO;
                }
            }
        }
        if lstage <= 0 || lstage >= 3 {
            self.errmes(1, 5, CHSUBP)?;
        }
        if self.c.imethd == 3 && self.s_solve.basiyf_power.data.is_empty() {
            self.s_solve.basiyf_power = FArr2::new(MY as usize, MCOEFF_POWER as usize);
        }
        let priorz = !(self.c.fxdegz || self.c.sddegz >= 45.0);
        let priorp = !self.c.fxdegp;
        // Indices starting with K replace those with L for temporarily
        // contracting DAMAT, GRAD & NONNEG before PNNLS when FXDEGZ or FXDEGP = T.
        // SOLUTN comes out of PNNLS contracted. PARNLN is never compressed.
        let mut nless: i32;
        let kdegp: i32;
        if self.c.fxdegz {
            nless = 1;
            kdegp = self.c.lphast;
        } else {
            nless = 0;
            kdegp = self.c.lphast + 1;
        }
        if self.c.fxdegp {
            nless += 1;
        }
        let kshist = self.c.lshist - nless;
        let krt2st = self.c.lrt2st - nless;
        let knonl = self.c.nnonl - nless;
        // Compute broadened basis in frequency-domain.
        let ddtime: f64 = self.c.deltat as f64;
        let mut dtime: f64;
        {
            let c = &mut self.c;
            let s = &mut self.s_solve;
            let ndata = c.ndata;
            if lstage == 1 {
                // DCDATA(*,1) = data for individual metabolites
                //          2  = sum over all metabolites of conc*(metabolite data)
                //          3  = broadening and shifting factors for time-domain data
                //          4  = shifting factors without broadening (LSHAPE=F)
                //          5  = sum over broadened (LSHAPE=T) metabolites of conc*data
                if dononl {
                    for jdata in 1..=ndata {
                        s.dcdata[(jdata, 2)] = C64::ZERO;
                        s.dcdata[(jdata, 5)] = C64::ZERO;
                    }
                }
                let dexpre: f64 = c.parnln[c.lrt2st] * c.parnln[c.lrt2st];
                let dcexus = dcmplx(c.parnln[c.lrt2st], c.parnln[c.lshist]);
                let newexp = dcexus != s.dcexol[(1, 1)] || s.lstold[1] != 1;
                if newexp || dononl {
                    dtime = 0.0;
                    if newexp {
                        for jdata in 1..=ndata {
                            s.dcdata[(jdata, 4)] = dcmplx(0.0, -(dtime * c.parnln[c.lshist])).exp();
                            s.dcdata[(jdata, 3)] = (-(dexpre * (dtime * dtime))).exp() * s.dcdata[(jdata, 4)];
                            dtime = dtime + ddtime;
                        }
                    }
                    for jmetab in 1..=c.nmetab {
                        // LSHAPE = T to do Gaussian broadening (LSTAGE=1).
                        if c.lshape[jmetab] {
                            for jdata in 1..=ndata {
                                s.dcdata[(jdata, 1)] = s.dcdata[(jdata, 3)] * C64::from(c.basist[(jdata, jmetab)]);
                            }
                            if dononl {
                                for jdata in 1..=ndata {
                                    let dcterm = c.solutn[jmetab] * s.dcdata[(jdata, 1)];
                                    s.dcdata[(jdata, 2)] = s.dcdata[(jdata, 2)] + dcterm;
                                    s.dcdata[(jdata, 5)] = s.dcdata[(jdata, 5)] + dcterm;
                                }
                            }
                        } else {
                            // No broadening (LSHAPE = F).
                            for jdata in 1..=ndata {
                                s.dcdata[(jdata, 1)] = s.dcdata[(jdata, 4)] * C64::from(c.basist[(jdata, jmetab)]);
                            }
                            if dononl {
                                for jdata in 1..=ndata {
                                    s.dcdata[(jdata, 2)] = s.dcdata[(jdata, 2)] + c.solutn[jmetab] * s.dcdata[(jdata, 1)];
                                }
                            }
                        }
                        if newexp {
                            s.lstold[1] = 1;
                            s.dcexol[(1, 1)] = dcexus;
                            fft_col(&mut s.dcdata, 1, &mut s.fftin, ndata, &mut c.ldwfft, &mut c.dwfftc.data);
                            let mut jdata = c.ldatst;
                            for jy in 1..=c.ny {
                                s.basiyf[(jy, jmetab, 1)] = s.dcdata[(jdata, 1)];
                                jdata += 1;
                            }
                        }
                    }
                }
                if dononl {
                    // i*exp(-phase)*BASIYF(JY,1,2) = derivative wrt shift parameter.
                    // exp(-phase)*BASIYF(JY,2,2) = derivative wrt broadening parameter.
                    // BASIYF(*,*,2) from previous calls cannot be used (they contain
                    // concentrations).
                    dtime = 0.0;
                    for jdata in 1..=ndata {
                        s.dcdata[(jdata, 1)] = dtime * s.dcdata[(jdata, 2)];
                        s.dcdata[(jdata, 2)] = (dtime * dtime) * s.dcdata[(jdata, 5)];
                        dtime = dtime - ddtime;
                    }
                    fft_col(&mut s.dcdata, 1, &mut s.fftin, ndata, &mut c.ldwfft, &mut c.dwfftc.data);
                    fft_col(&mut s.dcdata, 2, &mut s.fftin, ndata, &mut c.ldwfft, &mut c.dwfftc.data);
                    let mut jdata = c.ldatst;
                    for jy in 1..=c.ny {
                        s.basiyf[(jy, 1, 2)] = s.dcdata[(jdata, 1)];
                        s.basiyf[(jy, 2, 2)] = -(2.0 * c.parnln[c.lrt2st] * s.dcdata[(jdata, 2)]);
                        jdata += 1;
                    }
                }
            } else {
                // LSTAGE = 2.
                let nside = c.incsid * c.nsides;
                for jmetab in 1..=c.nmetab {
                    'l110: {
                        if c.imethd == 3 {
                            dtime = 0.0;
                            for jdata in 1..=ndata {
                                c.dterm[1] = 0.0;
                                for jpower in 1..=c.npower[jmetab] {
                                    c.dterm[1] = c.dterm[1] - c.parnln[c.lpowen[jmetab - 1] + jpower] * c.tpower[(jpower, jdata)];
                                }
                                dtime = dtime - ddtime;
                                s.dcdata[(jdata, 1)] = dcmplx(c.dterm[1], c.parnln[c.lshist - 1 + jmetab] * dtime).exp()
                                    * C64::from(c.basist[(jdata, jmetab)]);
                            }
                        } else {
                            let dcexus = dcmplx(c.parnln[c.lrt2st - 1 + jmetab], c.parnln[c.lshist - 1 + jmetab]);
                            if dcexus == s.dcexol[(jmetab, 1)] && s.lstold[1] == 2 {
                                break 'l110;
                            }
                            s.lstold[1] = 2;
                            s.dcexol[(jmetab, 1)] = dcexus;
                            let dcfact = (-(dcexus * ddtime)).exp();
                            let mut dcterm = dcmplx(1.0, 0.0);
                            for jdata in 1..=ndata {
                                s.dcdata[(jdata, 1)] = dcterm * C64::from(c.basist[(jdata, jmetab)]);
                                dcterm = dcterm * dcfact;
                            }
                        }
                        fft_col(&mut s.dcdata, 1, &mut s.fftin, ndata, &mut c.ldwfft, &mut c.dwfftc.data);
                        // BASIYF(JYSIDE,JMETAB,1) = shifted frequency-domain basis spectra
                        // in the region of interest, extended by INCSID*NSIDES points at
                        // each end.
                        let mut jdata = c.ldatst - nside;
                        for jyside in 1 - nside..=c.ny + nside {
                            s.basiyf[(jyside, jmetab, 1)] = s.dcdata[(jdata, 1)];
                            jdata += 1;
                        }
                    }
                }
                if dononl {
                    // Derivative wrt delta(1/T2) of broadened frequency-domain basis spectra.
                    if c.imethd == 3 {
                        // BASIYF(JY,JMETAB,2) = (derivative wrt shift of exponential term) / -sqrt(-1)
                        for jmetab in 1..=c.nmetab {
                            dtime = 0.0;
                            for jdata in 1..=ndata {
                                c.dterm[1] = 0.0;
                                for jpower in 1..=c.npower[jmetab] {
                                    c.dterm[1] = c.dterm[1] - c.parnln[c.lpowen[jmetab - 1] + jpower] * c.tpower[(jpower, jdata)];
                                }
                                dtime = dtime - ddtime;
                                s.dcdata[(jdata, 1)] = dtime * dcmplx(c.dterm[1], c.parnln[c.lshist - 1 + jmetab] * dtime).exp()
                                    * C64::from(c.basist[(jdata, jmetab)]);
                            }
                            fft_col(&mut s.dcdata, 1, &mut s.fftin, ndata, &mut c.ldwfft, &mut c.dwfftc.data);
                            let mut jdata = c.ldatst;
                            for jy in 1..=c.ny {
                                s.basiyf[(jy, jmetab, 2)] = s.dcdata[(jdata, 1)];
                                jdata += 1;
                            }
                        }
                        // BASIYF_power(Jy,jcoeff_power) = derivative wrt coefficient of POWER
                        let mut jcoeff_power = 0;
                        for jmetab in 1..=c.nmetab {
                            for kpower in 1..=c.npower[jmetab] {
                                jcoeff_power += 1;
                                dtime = 0.0;
                                for jdata in 1..=ndata {
                                    c.dterm[1] = 0.0;
                                    for jpower in 1..=c.npower[jmetab] {
                                        c.dterm[1] =
                                            c.dterm[1] - c.parnln[c.lpowen[jmetab - 1] + jpower] * c.tpower[(jpower, jdata)];
                                    }
                                    dtime = dtime - ddtime;
                                    s.dcdata[(jdata, 1)] = -(c.tpower[(kpower, jdata)]
                                        * dcmplx(c.dterm[1], c.parnln[c.lshist - 1 + jmetab] * dtime).exp()
                                        * C64::from(c.basist[(jdata, jmetab)]));
                                }
                                fft_col(&mut s.dcdata, 1, &mut s.fftin, ndata, &mut c.ldwfft, &mut c.dwfftc.data);
                                let mut jdata = c.ldatst;
                                for jy in 1..=c.ny {
                                    s.basiyf_power[(jy, jcoeff_power)] = s.dcdata[(jdata, 1)];
                                    jdata += 1;
                                }
                            }
                        }
                    } else {
                        for jmetab in 1..=c.nmetab {
                            let dcexus = s.dcexol[(jmetab, 1)];
                            if dcexus == s.dcexol[(jmetab, 2)] && s.lstold[2] == 2 {
                                continue;
                            }
                            s.lstold[2] = 2;
                            s.dcexol[(jmetab, 2)] = dcexus;
                            let dcfact = (-(dcexus * ddtime)).exp();
                            dtime = 0.0;
                            let mut dcterm = dcmplx(1.0, 0.0);
                            for jdata in 1..=ndata {
                                s.dcdata[(jdata, 1)] = dtime * dcterm * C64::from(c.basist[(jdata, jmetab)]);
                                dcterm = dcterm * dcfact;
                                dtime = dtime - ddtime;
                            }
                            fft_col(&mut s.dcdata, 1, &mut s.fftin, ndata, &mut c.ldwfft, &mut c.dwfftc.data);
                            // BASIYF(JYSIDE,JMETAB,2) = derivative wrt gamma (in MRM) of the
                            // shifted frequency-domain basis, extended at each end.
                            let mut jdata = c.ldatst - nside;
                            for jyside in 1 - nside..=c.ny + nside {
                                s.basiyf[(jyside, jmetab, 2)] = s.dcdata[(jdata, 1)];
                                jdata += 1;
                            }
                        }
                    }
                }
            }
        }
        // Load DAMAT and DRHS, or YFITRE.
        self.c.dssq = 0.0;
        let mut nrow: i32 = 0;
        {
            let c = &mut self.c;
            let s = &mut self.s_solve;
            if !onlyft {
                if dononl {
                    for jnonl in 1..=knonl {
                        c.grad[jnonl] = 0.0;
                    }
                }
                let n = (c.npar.max(0) as usize) * MROW as usize;
                for v in c.damat.data[..n].iter_mut() {
                    *v = 0.0;
                }
                for irow in 1..=MROW {
                    s.drhs[irow] = 0.0;
                }
            }
            let mut dfzero: f64 = 1.0;
            for jnonl in 1..=c.nside2 {
                dfzero = dfzero - c.parnln[jnonl];
            }
            let mut dppm: f64 = c.delppm[1] as f64;
            let dppinc: f64 = c.ppminc as f64;
            let mut dcphas = dcmplx(0.0, -c.parnln[c.lphast] - c.parnln[c.lphast + 1] * dppm).exp();
            let dcfact = dcmplx(0.0, c.parnln[c.lphast + 1] * dppinc).exp();
            let nside = c.incsid * c.nsides;
            let nlin = c.nlin;
            for jy in 1..=c.ny {
                if c.lcy_skip[jy] {
                    continue;
                }
                nrow += 1;
                if onlyft {
                    c.yfitre[(nrow, 0)] = 0.0;
                }
                let mut dcyfit = C64::ZERO;
                let mut jcoeff_power = 0;
                for jmetab in 1..=c.nmetab {
                    // LSHAPE(JMETAB) = F to eliminate convolution with the lineshape.
                    if c.lshape[jmetab] {
                        dcsum[1] = dfzero * s.basiyf[(jy, jmetab, 1)];
                        if dononl && lstage == 2 {
                            dcsum[2] = dfzero * s.basiyf[(jy, jmetab, 2)];
                        }
                        let mut jnonl = 1;
                        for jyside in fdo(jy - nside, jy + nside, c.incsid) {
                            if jyside == jy {
                                continue;
                            }
                            dcsum[1] = dcsum[1] + c.parnln[jnonl] * s.basiyf[(jyside, jmetab, 1)];
                            if dononl {
                                dcsum[2] = dcsum[2] + c.parnln[jnonl] * s.basiyf[(jyside, jmetab, 2)];
                            }
                            jnonl += 1;
                        }
                    } else {
                        dcsum[1] = s.basiyf[(jy, jmetab, 1)];
                        if dononl && lstage == 2 {
                            dcsum[2] = s.basiyf[(jy, jmetab, 2)];
                        }
                    }
                    dcsum[1] = dcsum[1] * dcphas;
                    if onlyft {
                        c.yfitre[(nrow, jmetab)] = (c.solutn[jmetab] * (dcsum[1].re as f32) as f64) as f32;
                        c.yfitre[(nrow, 0)] = c.yfitre[(nrow, 0)] + c.yfitre[(nrow, jmetab)];
                    } else {
                        // Derivatives wrt concentration coefficients.
                        c.damat[(nrow, jmetab)] = dcsum[1].re;
                        if dononl {
                            dcyfit = dcyfit + c.solutn[jmetab] * dcsum[1];
                            // Derivatives wrt shift and delta(1/T2).
                            if lstage == 2 {
                                dcsum[2] = dcsum[2] * dcphas * c.solutn[jmetab];
                                c.damat[(nrow, nlin + kshist - 1 + jmetab)] = -dcsum[2].im;
                                if c.imethd == 3 {
                                    for kpower in 1..=c.npower[jmetab] {
                                        jcoeff_power += 1;
                                        c.damat[(nrow, nlin + krt2st - 1 + jcoeff_power)] =
                                            (dcphas * c.solutn[jmetab] * s.basiyf_power[(jy, jcoeff_power)]).re;
                                    }
                                } else {
                                    c.damat[(nrow, nlin + krt2st - 1 + jmetab)] = dcsum[2].re;
                                }
                            } else if jmetab == 1 {
                                c.damat[(nrow, nlin + krt2st)] = (dcphas * s.basiyf[(jy, 2, 2)]).re;
                                c.damat[(nrow, nlin + kshist)] = -(dcphas * s.basiyf[(jy, 1, 2)]).im;
                            }
                        }
                    }
                }
                // Background is assumed real.
                let mut bacfit: f32 = 0.0;
                let mut jsol = c.nmetab;
                for jbackg in 1..=c.nbackg {
                    jsol += 1;
                    let dcterm = dcphas * c.backgr[(jy, jbackg)] as f64;
                    if onlyft {
                        bacfit = bacfit + (c.solutn[jsol] as f32) * (dcterm.re as f32);
                    } else {
                        c.damat[(nrow, jsol)] = dcterm.re;
                        dcyfit = dcyfit + c.solutn[jsol] * dcterm;
                    }
                }
                'l390: {
                    if onlyft {
                        c.backre[nrow] = bacfit;
                        if c.subbas {
                            c.yreal[nrow] = c.cy[jy].re - bacfit;
                        } else {
                            c.yreal[nrow] = c.cy[jy].re;
                            for jmetab in 0..=c.nmetab {
                                c.yfitre[(nrow, jmetab)] = c.yfitre[(nrow, jmetab)] + bacfit;
                            }
                        }
                        break 'l390;
                    }
                    // Right-hand side.
                    s.drhs[nrow] = c.cy[jy].re as f64;
                    if dononl {
                        // Derivatives wrt phase corrections.
                        if !c.fxdegz {
                            c.damat[(nrow, nlin + c.lphast)] = dcyfit.im;
                        }
                        if !c.fxdegp {
                            c.damat[(nrow, nlin + kdegp)] = dppm * dcyfit.im;
                        }
                        dppm = dppm - dppinc;
                    }
                    if dononl {
                        // Derivatives wrt lineshape coefficients.
                        let mut icol = nlin;
                        for jyside in fdo(jy - nside, jy + nside, c.incsid) {
                            if jyside == jy {
                                continue;
                            }
                            dcsum[1] = C64::ZERO;
                            for jmetab in 1..=c.nmetab {
                                if c.lshape[jmetab] {
                                    dcsum[1] = dcsum[1]
                                        + c.solutn[jmetab] * (s.basiyf[(jyside, jmetab, 1)] - s.basiyf[(jy, jmetab, 1)]);
                                }
                            }
                            icol += 1;
                            c.damat[(nrow, icol)] = (dcsum[1] * dcphas).re;
                        }
                        // Gradients.
                        c.dterm[1] = -(2.0 * (s.drhs[nrow] - dcyfit.re));
                        for jnonl in 1..=knonl {
                            c.grad[jnonl] = c.grad[jnonl] + c.dterm[1] * c.damat[(nrow, nlin + jnonl)];
                        }
                    }
                }
                // Label 390.
                dcphas = dcphas * dcfact;
            }
        }
        if onlyft {
            return Ok(());
        }
        let nlin = self.c.nlin;
        // Append priors for CONC ratios. Weighting by SDRATI*CSUM has been done, so
        // only weight CPRIOR by SDREF. RHS=0.
        if self.c.sdref < self.c.drange {
            let c = &mut self.c;
            for jratio in 1..=c.nratio_used {
                nrow += 1;
                for jmetab in 1..=c.nmetab {
                    c.damat[(nrow, jmetab)] = c.sdref * c.cprior[(jratio, jmetab)] as f64;
                }
            }
        }
        if dononl && lstage == 2 {
            // Append rows for priors. First the shifts: SDSHIF(JMETAB) = prior SD of
            // shift (prior mean 0).
            for jmetab in 1..=self.c.nmetab {
                nrow += 1;
                let jnonl = kshist - 1 + jmetab;
                if self.c.sdshif[jmetab] <= 0.0 {
                    self.errmes(2, 4, CHSUBP)?;
                }
                let c = &mut self.c;
                let s = &mut self.s_solve;
                let sqrtwt: f64 = c.sdref / c.sdshif[jmetab] as f64;
                c.damat[(nrow, nlin + jnonl)] = sqrtwt;
                s.drhs[nrow] = -(sqrtwt * c.parnln[jnonl + nless]);
                c.grad[jnonl] = c.grad[jnonl] - 2.0 * s.drhs[nrow] * sqrtwt;
            }
            // Append rows for priors for group shifts.
            {
                let c = &mut self.c;
                let s = &mut self.s_solve;
                for jrow_group_shift in 1..=c.nrow_group_shift {
                    nrow += 1;
                    let sqrtwt: f64 = c.sdref / c.sdgroup_shift_row[jrow_group_shift] as f64;
                    // DTERM(1) = weighted residual
                    c.dterm[1] = 0.0;
                    for jmetab in 1..=c.nmetab {
                        let jnonl = kshist + jmetab - 1;
                        c.dterm[2] = c.cgroup_shift[(jrow_group_shift, jmetab)] as f64 * sqrtwt;
                        c.damat[(nrow, nlin + jnonl)] = c.dterm[2];
                        c.dterm[1] = c.dterm[1] - c.dterm[2] * c.parnln[jnonl + nless];
                    }
                    s.drhs[nrow] = c.dterm[1];
                    for jnonl in kshist..=kshist + c.nmetab - 1 {
                        c.grad[jnonl] = c.grad[jnonl] - 2.0 * c.dterm[1] * c.damat[(nrow, nlin + jnonl)];
                    }
                }
            }
            // Append rows for priors for delta(1/T2).
            if self.c.imethd == 3 {
                let mut jcoeff_power = 0;
                for jmetab in 1..=self.c.nmetab {
                    for kpower in 1..=self.c.npower[jmetab] {
                        nrow += 1;
                        jcoeff_power += 1;
                        let jnonl = krt2st - 1 + jcoeff_power;
                        if self.c.coeff_power_sd[(kpower, jmetab)] <= 0.0 {
                            self.errmes(9, 4, CHSUBP)?;
                        }
                        let c = &mut self.c;
                        let s = &mut self.s_solve;
                        let sqrtwt: f64 = c.sdref / c.coeff_power_sd[(kpower, jmetab)];
                        c.damat[(nrow, nlin + jnonl)] = sqrtwt;
                        s.drhs[nrow] = -(sqrtwt * c.parnln[jnonl + nless]);
                        c.grad[jnonl] = c.grad[jnonl] - 2.0 * s.drhs[nrow] * sqrtwt;
                    }
                }
            } else {
                for jmetab in 1..=self.c.nmetab {
                    nrow += 1;
                    let jnonl = krt2st - 1 + jmetab;
                    if self.c.sdrt2[jmetab] <= 0.0 {
                        self.errmes(5, 4, CHSUBP)?;
                    }
                    let c = &mut self.c;
                    let s = &mut self.s_solve;
                    let sqrtwt: f64 = c.sdref / c.sdrt2[jmetab] as f64;
                    c.damat[(nrow, nlin + jnonl)] = sqrtwt;
                    s.drhs[nrow] = sqrtwt * (c.exrt2[jmetab] as f64 - c.parnln[jnonl + nless]);
                    c.grad[jnonl] = c.grad[jnonl] - 2.0 * s.drhs[nrow] * sqrtwt;
                }
            }
        }
        {
            let c = &mut self.c;
            let s = &mut self.s_solve;
            if dononl {
                // Append rows for priors for phases.
                if priorz {
                    nrow += 1;
                    let sqrtwt: f64 = c.sdref / (c.sddegz * c.radian) as f64;
                    c.damat[(nrow, nlin + c.lphast)] = sqrtwt;
                    s.drhs[nrow] = sqrtwt * ((c.exdegz * c.radian) as f64 - c.parnln[c.lphast] - c.phitot[1] as f64);
                    c.grad[c.lphast] = c.grad[c.lphast] - 2.0 * s.drhs[nrow] * sqrtwt;
                }
                if priorp {
                    nrow += 1;
                    let sqrtwt: f64 = c.sdref / (c.sddegp * c.radian) as f64;
                    c.damat[(nrow, nlin + kdegp)] = sqrtwt;
                    s.drhs[nrow] = sqrtwt * ((c.exdegp * c.radian) as f64 - c.parnln[c.lphast + 1] - c.phitot[2] as f64);
                    c.grad[kdegp] = c.grad[kdegp] - 2.0 * s.drhs[nrow] * sqrtwt;
                }
            }
            c.nrowda = nrow;
            if c.imethd == 2 && lstage == 2 && c.alphas > 0.0 {
                // IMETHD = 2: rows for linewidths (rather than lineshape) being
                // regularized. They contain concentration and so are also used in
                // the linear analysis. DRHS & GRAD are deliberately not set.
                for jmetab in 1..=c.nmetab {
                    nrow += 1;
                    let jnonl = krt2st - 1 + jmetab;
                    let sqrtwt: f64 = c.sdref * c.alphas / c.conc_expect[jmetab] as f64;
                    c.dterm[1] = c.rt2min[jmetab] as f64 + c.rlrntz as f64 * c.parnln[jnonl + nless];
                    if c.ipowrg == 1 {
                        c.damat[(nrow, jmetab)] = sqrtwt * c.dterm[1];
                    } else {
                        c.damat[(nrow, jmetab)] = sqrtwt * (c.dterm[1] * c.dterm[1]);
                    }
                    if dononl {
                        if c.ipowrg == 1 {
                            c.damat[(nrow, nlin + jnonl)] = sqrtwt * c.solutn[jmetab] * c.rlrntz as f64;
                        } else {
                            c.damat[(nrow, nlin + jnonl)] = 2.0 * sqrtwt * c.solutn[jmetab] * c.dterm[1] * c.rlrntz as f64;
                        }
                    }
                }
            }
            if c.alphab > 0.0 && c.sdref < c.drange {
                // Append rows for background regularizor, REGB.
                for jbackg in 1..=c.nbackg {
                    nrow += 1;
                    for jreg in 1..=c.nbackg {
                        c.damat[(nrow, c.nmetab + jreg)] = c.sdref * c.alphab * c.regb[(jbackg, jreg)] as f64;
                    }
                }
            }
            if c.alphas > 0.0 && dononl && c.imethd != 2 && c.nside2 > 0 {
                // Append rows for the lineshape regularizor (REGF, center coefficient
                // eliminated, so rows 1-3 have 2, -1, -1 on the rhs).
                for irowf in 1..=c.nregf {
                    nrow += 1;
                    if irowf == 1 {
                        c.dterm[1] = 2.0 * c.sdref * c.alphas;
                    } else if irowf <= 3 {
                        c.dterm[1] = -(c.sdref * c.alphas);
                    } else {
                        c.dterm[1] = 0.0;
                    }
                    let mut icol = nlin;
                    for jnonl in 1..=c.nside2 {
                        c.dterm[2] = c.sdref * c.alphas * c.regf[(irowf, jnonl)];
                        c.dterm[1] = c.dterm[1] - c.dterm[2] * c.parnln[jnonl];
                        icol += 1;
                        c.damat[(nrow, icol)] = c.dterm[2];
                    }
                    s.drhs[nrow] = c.dterm[1];
                    let mut icol = nlin;
                    for jnonl in 1..=c.nside2 {
                        icol += 1;
                        c.grad[jnonl] = c.grad[jnonl] - 2.0 * c.dterm[1] * c.damat[(nrow, icol)];
                    }
                }
            }
        }
        if pmqact > 0.0 && dononl {
            // Append Marquardt rows.
            if self.c.sdref >= self.c.drange {
                self.errmes(6, 4, CHSUBP)?;
            }
            let rtmarq: f32 = (pmqact as f32).sqrt();
            let mut inonl = 0;
            for jnonl in 1..=self.c.nnonl {
                if (self.c.fxdegz && jnonl == self.c.lphast) || (self.c.fxdegp && jnonl == self.c.lphast + 1) {
                    continue;
                }
                inonl += 1;
                nrow += 1;
                if self.c.dparmq[jnonl] <= 0.0 {
                    self.errmes(7, 4, CHSUBP)?;
                }
                let c = &mut self.c;
                let s = &mut self.s_solve;
                s.damarq[inonl] = rtmarq as f64 * c.sdref / c.dparmq[jnonl];
                c.damat[(nrow, nlin + inonl)] = s.damarq[inonl];
            }
        }
        let ncol: i32;
        {
            let c = &mut self.c;
            if dononl {
                ncol = c.npar - nless;
                if nless > 0 {
                    // Compress NONNEG.
                    if c.fxdegz && !c.fxdegp {
                        c.nonneg[nlin + c.lphast] = c.nonneg[nlin + c.lphast + 1];
                    }
                    for jnonl in kshist..=knonl {
                        c.nonneg[nlin + jnonl] = c.nonneg[nlin + jnonl + nless];
                    }
                }
            } else {
                ncol = nlin;
            }
        }
        // Compute optimal SOLUTN with PNNLS.
        let mut objtot: f64 = 0.0;
        let mut ierror: i32 = 0;
        {
            let c = &mut self.c;
            let s = &mut self.s_solve;
            let (w, zz) = s.dwork.data.split_at_mut(c.npar as usize);
            let mut q = ErrQueue::new();
            let drange = c.drange;
            let r = pnnls(
                &mut c.damat.data,
                MROW,
                nrow,
                ncol,
                &mut s.drhs.data,
                &mut c.solutn.data,
                &mut objtot,
                w,
                zz,
                &mut c.indcol.data,
                &mut ierror,
                drange,
                &c.nonneg.data,
                0.0,
                &mut c.ndf,
                &mut q,
            );
            self.after(q, r)?;
        }
        *lerror = ierror != 1;
        if !*lerror {
            {
                let c = &mut self.c;
                let s = &mut self.s_solve;
                if pmqact > 0.0 && dononl {
                    // Subtract Marquardt penalty from OBJTOT.
                    let mut inonl = 0;
                    for jnonl in 1..=c.nnonl {
                        if (c.fxdegz && jnonl == c.lphast) || (c.fxdegp && jnonl == c.lphast + 1) {
                            continue;
                        }
                        inonl += 1;
                        let t = s.damarq[inonl] * c.solutn[nlin + inonl];
                        objtot = objtot - t * t;
                    }
                }
                if nless > 0 && dononl {
                    // Restore (expand) NONNEG, SOLUTN & GRAD.
                    for jnonl in fdo(c.nnonl, c.lshist, -1) {
                        c.nonneg[nlin + jnonl] = c.nonneg[nlin + jnonl - nless];
                        c.solutn[nlin + jnonl] = c.solutn[nlin + jnonl - nless];
                        c.grad[jnonl] = c.grad[jnonl - nless];
                    }
                    let lphast = c.lphast;
                    if c.fxdegz && !c.fxdegp {
                        c.nonneg[nlin + lphast + 1] = c.nonneg[nlin + lphast];
                        c.solutn[nlin + lphast + 1] = c.solutn[nlin + lphast];
                        c.grad[lphast + 1] = c.grad[lphast];
                    }
                    if c.fxdegz {
                        c.nonneg[nlin + lphast] = false;
                        c.solutn[nlin + lphast] = 0.0;
                        c.grad[lphast] = 0.0;
                    }
                    if c.fxdegp {
                        c.nonneg[nlin + lphast + 1] = false;
                        c.solutn[nlin + lphast + 1] = 0.0;
                        c.grad[lphast + 1] = 0.0;
                    }
                }
                if !dononl && c.sdref < c.drange && lstage == 2 {
                    // Add penalties for shift and 1/T2 priors to OBJTOT.
                    let mut jcoeff_power = 0;
                    for jmetab in 1..=c.nmetab {
                        let t = c.parnln[c.lshist - 1 + jmetab] * c.sdref / c.sdshif[jmetab] as f64;
                        objtot = objtot + t * t;
                        if c.imethd == 3 {
                            for kpower in 1..=c.npower[jmetab] {
                                jcoeff_power += 1;
                                let jnonl = c.lrt2st - 1 + jcoeff_power;
                                let t = c.parnln[jnonl] * c.sdref / c.coeff_power_sd[(kpower, jmetab)];
                                objtot = objtot + t * t;
                            }
                        } else {
                            let t = (c.exrt2[jmetab] as f64 - c.parnln[c.lrt2st - 1 + jmetab]) * c.sdref / c.sdrt2[jmetab] as f64;
                            objtot = objtot + t * t;
                        }
                    }
                    for jrow_group_shift in 1..=c.nrow_group_shift {
                        c.dterm[1] = 0.0;
                        for jmetab in 1..=c.nmetab {
                            let jnonl = c.lshist + jmetab - 1;
                            c.dterm[1] = c.dterm[1] + c.parnln[jnonl] * c.cgroup_shift[(jrow_group_shift, jmetab)] as f64;
                        }
                        let t = c.sdref * c.dterm[1] / c.sdgroup_shift_row[jrow_group_shift] as f64;
                        objtot = objtot + t * t;
                    }
                }
                if !dononl && c.sdref < c.drange {
                    // Add penalties for priors for phases to OBJTOT (simplified from
                    // EXDEG?*RADIAN and SDDEG?*RADIAN).
                    if priorz {
                        let t = (c.exdegz as f64 - (c.parnln[c.lphast] + c.phitot[1] as f64) / c.radian as f64) * c.sdref
                            / c.sddegz as f64;
                        objtot = objtot + t * t;
                    }
                    if priorp {
                        let t = (c.exdegp as f64 - (c.parnln[c.lphast + 1] + c.phitot[2] as f64) / c.radian as f64) * c.sdref
                            / c.sddegp as f64;
                        objtot = objtot + t * t;
                    }
                }
            }
            // DSSQ = OBJTOT - (regularizor penalty)
            let alphab = self.c.alphab;
            self.c.dssq = objtot - self.penlty_solutn_parnln(alphab, 0.0);
            let alphas = self.c.alphas;
            if alphas > 0.0 && self.c.imethd == 2 && lstage == 2 && self.c.sdref < self.c.drange {
                if dononl {
                    {
                        let c = &self.c;
                        let s = &mut self.s_solve;
                        for jmetab in 1..=c.nmetab {
                            let jnonl = c.lrt2st - 1 + jmetab;
                            s.dwork[jnonl] = c.solutn[nlin + jnonl] + c.parnln[jnonl];
                        }
                    }
                    // Here IMETHD=2, and the ALPHAS component is already in the
                    // solution when DONONL=F; this only affects the output penB.
                    let sol = std::mem::take(&mut self.c.solutn);
                    let dw = std::mem::take(&mut self.s_solve.dwork);
                    let p = self.penlty(0.0, alphas, &sol.data, &dw.data);
                    self.c.solutn = sol;
                    self.s_solve.dwork = dw;
                    self.c.dssq = self.c.dssq - p;
                }
            }
            if self.c.nside2 > 0 && alphas > 0.0 && self.c.imethd != 2 {
                if dononl {
                    {
                        let c = &mut self.c;
                        for jside2 in 1..=c.nside2 {
                            c.dpy[jside2] = c.solutn[nlin + jside2] + c.parnln[jside2];
                        }
                    }
                    let sol = std::mem::take(&mut self.c.solutn);
                    let dpy = std::mem::take(&mut self.c.dpy);
                    let p = self.penlty(0.0, alphas, &sol.data, &dpy.data);
                    self.c.solutn = sol;
                    self.c.dpy = dpy;
                    self.c.dssq = self.c.dssq - p;
                } else {
                    objtot = objtot + self.penlty_solutn_parnln(0.0, alphas);
                }
            }
            if dononl {
                self.c.objlin = objtot;
            } else {
                let c = &mut self.c;
                c.object = objtot;
                // Correct NDF for KNONL nonlinear parameters.
                c.ndf = c.ndf + knonl;
                if c.nrowda > c.ndf && c.dssq > 0.0 {
                    c.stddev = (c.dssq / (c.nrowda - c.ndf) as f64).sqrt();
                    // SDREF = rough estimate for SD of fit, updated to the minimum
                    // during the Starting Solution (INISOL=T).
                    if c.inisol {
                        c.sdref = c.sdref.min(c.stddev);
                    }
                } else {
                    self.errmes(8, 3, CHSUBP)?;
                }
            }
        }
        Ok(())
    }

    /// ILEVEL = 1 saves the best solution from a Regula Falsi analysis;
    /// 2 saves the best of all solutions so far and loads PARNLN with PARBES;
    /// >=3 saves the current best (*,2) solution in slot ILEVEL;
    /// <=-3 loads slot -ILEVEL into slot 2.
    pub fn savbes(&mut self, ilevel: i32) -> R<()> {
        const CHSUBP: &str = "SAVBES";
        if ilevel == 1 {
            let c = &mut self.c;
            c.penbes[1] = c.object - c.dssq;
            if (c.alphab as f32) < c.alpbpn && c.sdref < c.drange {
                c.penbes[1] = c.penbes[1] + c.pnalpb as f64 * (c.sdref * c.sdref);
            }
            c.ssqbes[1] = c.dssq as f32;
            c.sdbest[1] = c.stddev;
            c.pmqbes[1] = c.pmqsav;
            c.alpbbs[1] = c.alphab;
            c.alpsbs[1] = c.alphas;
            for jnonl in 1..=c.nnonl {
                c.parbes[(jnonl, 1)] = c.parnln[jnonl];
            }
            for jpar in 1..=c.nlin {
                c.solbes[(jpar, 1)] = c.solutn[jpar];
            }
            c.phitot_sav[(1, 1)] = c.phitot[1];
            c.phitot_sav[(1, 2)] = c.phitot[2];
            for j in 1..=c.ny {
                c.cy_sav[(j, 1)] = c.cy[j];
            }
        } else if ilevel == 2 {
            let c = &mut self.c;
            c.penbes[2] = c.penbes[1];
            c.ssqbes[2] = c.ssqbes[1];
            c.sdbest[2] = c.sdbest[1];
            c.pmqbes[2] = c.pmqbes[1];
            c.alpbbs[2] = c.alpbbs[1];
            c.alpsbs[2] = c.alpsbs[1];
            for jnonl in 1..=c.nnonl {
                c.parbes[(jnonl, 2)] = c.parbes[(jnonl, 1)];
                c.parnln[jnonl] = c.parbes[(jnonl, 1)];
            }
            for jpar in 1..=c.nlin {
                c.solbes[(jpar, 2)] = c.solbes[(jpar, 1)];
            }
            c.phitot_sav[(2, 1)] = c.phitot_sav[(1, 1)];
            c.phitot_sav[(2, 2)] = c.phitot_sav[(1, 2)];
            for j in 1..=c.ny {
                c.cy_sav[(j, 2)] = c.cy_sav[(j, 1)];
            }
        } else {
            if ilevel.abs() < 3 || ilevel.abs() > MMDEGP3 + 7 {
                self.errmes(1, 5, CHSUBP)?;
            }
            let c = &mut self.c;
            if ilevel > 0 {
                c.penbes[ilevel] = c.penbes[2];
                c.ssqbes[ilevel] = c.ssqbes[2];
                c.sdbest[ilevel] = c.sdbest[2];
                c.pmqbes[ilevel] = c.pmqbes[2];
                c.alpbbs[ilevel] = c.alpbbs[2];
                c.alpsbs[ilevel] = c.alpsbs[2];
                for jnonl in 1..=c.nnonl {
                    c.parbes[(jnonl, ilevel)] = c.parbes[(jnonl, 2)];
                    c.parnln[jnonl] = c.parbes[(jnonl, 2)];
                }
                for jpar in 1..=c.nlin {
                    c.solbes[(jpar, ilevel)] = c.solbes[(jpar, 2)];
                }
                c.phitot_sav[(ilevel, 1)] = c.phitot_sav[(2, 1)];
                c.phitot_sav[(ilevel, 2)] = c.phitot_sav[(2, 2)];
                for j in 1..=c.ny {
                    c.cy_sav[(j, ilevel)] = c.cy_sav[(j, 2)];
                }
            } else {
                let k = -ilevel;
                c.penbes[2] = c.penbes[k];
                c.ssqbes[2] = c.ssqbes[k];
                c.sdbest[2] = c.sdbest[k];
                c.pmqbes[2] = c.pmqbes[k];
                c.alpbbs[2] = c.alpbbs[k];
                c.alpsbs[2] = c.alpsbs[k];
                for jnonl in 1..=c.nnonl {
                    c.parbes[(jnonl, 2)] = c.parbes[(jnonl, k)];
                    c.parnln[jnonl] = c.parbes[(jnonl, k)];
                }
                for jpar in 1..=c.nlin {
                    c.solbes[(jpar, 2)] = c.solbes[(jpar, k)];
                }
                c.phitot_sav[(2, 1)] = c.phitot_sav[(k, 1)];
                c.phitot_sav[(2, 2)] = c.phitot_sav[(k, 2)];
                for j in 1..=c.ny {
                    c.cy_sav[(j, 2)] = c.cy_sav[(j, k)];
                }
            }
        }
        Ok(())
    }
}

/// PENLTY, PASTEP, REPHAS and SAVBES against gfortran -O2: tests/data/solve_gfortran.f
/// linked with those four subprograms extracted verbatim from LCModel.f
/// (lines 8587-8685, 9060-9090, 10008-10106); its output is solve_gfortran.txt.
#[cfg(test)]
mod tests {
    use super::*;

    fn g(k: &mut i32) -> f64 {
        *k += 1;
        (((*k * 7919) % 1000) - 500) as f64 / 250.0
    }

    enum V {
        D(f64),
        R(f32),
        L(bool),
    }

    #[test]
    fn matches_gfortran() {
        let exp: Vec<&str> = include_str!("../tests/data/solve_gfortran.txt").lines().map(|l| l.trim()).collect();
        let mut got: Vec<V> = Vec::new();
        let mut lcm = Lcm::new();
        let mut k = 0;
        let c = &mut lcm.c;
        c.drange = 1.0e30;
        c.sdref = 1.3;
        c.nbackg = 5;
        c.nmetab = 4;
        for i in 1..=5 {
            for j in 1..=5 {
                c.regb[(i, j)] = g(&mut k) as f32;
            }
        }
        let mut sol = vec![0f64; MPAR as usize];
        let mut parnl = vec![0f64; MNONL as usize];
        for j in 0..30 {
            sol[j] = g(&mut k);
            parnl[j] = g(&mut k);
        }
        c.nregf = 6;
        c.nside2 = 5;
        for i in 1..=6 {
            for j in 1..=5 {
                c.regf[(i, j)] = g(&mut k);
            }
        }
        c.lrt2st = 10;
        c.rlrntz = 1.7;
        for j in 1..=4 {
            c.conc_expect[j] = 2.0 + g(&mut k) as f32;
            c.rt2min[j] = g(&mut k) as f32;
        }
        c.imethd = 0;
        got.push(V::D(lcm.penlty(0.37, 0.0, &sol, &parnl)));
        got.push(V::D(lcm.penlty(0.0, 1.9, &sol, &parnl)));
        got.push(V::D(lcm.penlty(0.37, 1.9, &sol, &parnl)));
        lcm.c.imethd = 2;
        lcm.c.ipowrg = 1;
        got.push(V::D(lcm.penlty(0.37, 1.9, &sol, &parnl)));
        lcm.c.ipowrg = 2;
        got.push(V::D(lcm.penlty(0.37, 1.9, &sol, &parnl)));
        got.push(V::D(lcm.c.dterm[1]));
        got.push(V::D(lcm.c.dterm[2]));
        // PASTEP
        let c = &mut lcm.c;
        c.nnonl = 12;
        c.nlin = 9;
        c.lrt2st = 5;
        c.fstpmq = 0.8;
        for j in 1..=21 {
            c.solutn[j] = g(&mut k);
            c.nonneg[j] = j % 3 == 0;
        }
        for j in 1..=12 {
            c.dparmq[j] = g(&mut k).abs() + 0.1;
            c.parold[j] = g(&mut k);
            c.parnln[j] = g(&mut k);
        }
        let mut rstep = 1.0f32;
        lcm.pastep(&mut rstep);
        got.push(V::R(rstep));
        for j in 1..=12 {
            got.push(V::D(lcm.c.parnln[j]));
        }
        for j in 1..=21 {
            got.push(V::L(lcm.c.nonneg[j]));
        }
        // REPHAS
        let c = &mut lcm.c;
        c.lprint = 0;
        c.lphast = 3;
        c.ny = 50;
        c.radian = 57.29578;
        c.ppminc = 0.0123;
        c.delppm[1] = 4.1;
        c.phitot[1] = 0.3;
        c.phitot[2] = -0.02;
        for j in 1..=12 {
            c.parbes[(j, 2)] = g(&mut k) * 0.1;
        }
        for j in 1..=50 {
            let x1 = g(&mut k) as f32;
            let x2 = g(&mut k) as f32;
            c.cy[j] = cmplx(x1, x2);
        }
        lcm.rephas().unwrap();
        let c = &lcm.c;
        got.push(V::R(c.phitot[1]));
        got.push(V::R(c.phitot[2]));
        for j in 1..=50 {
            got.push(V::R(c.cy[j].re));
            got.push(V::R(c.cy[j].im));
        }
        got.push(V::R(c.cterm[1].re));
        got.push(V::R(c.cterm[1].im));
        for j in 1..=12 {
            got.push(V::D(c.parnln[j]));
        }
        // SAVBES
        let c = &mut lcm.c;
        c.object = 12.5;
        c.dssq = 11.25;
        c.alphab = 0.001;
        c.alpbpn = 0.01;
        c.pnalpb = 3.3;
        c.stddev = 0.7;
        c.pmqsav = 0.2;
        c.alphas = 5.0;
        lcm.savbes(1).unwrap();
        lcm.savbes(2).unwrap();
        lcm.savbes(5).unwrap();
        lcm.savbes(-5).unwrap();
        got.push(V::D(lcm.c.penbes[1]));
        got.push(V::D(lcm.c.penbes[2]));
        got.push(V::D(lcm.c.penbes[5]));
        got.push(V::R(lcm.c.ssqbes[5]));
        assert_eq!(got.len(), exp.len());
        for (i, (a, e)) in got.iter().zip(exp.iter()).enumerate() {
            match a {
                V::L(b) => assert_eq!(if *b { "T" } else { "F" }, *e, "line {}", i + 1),
                V::D(x) => {
                    let y: f64 = e.parse().unwrap();
                    assert_eq!(x.to_bits(), y.to_bits(), "line {}: {x:e} vs {e}", i + 1);
                }
                V::R(x) => {
                    let y: f32 = e.parse().unwrap();
                    assert_eq!(x.to_bits(), y.to_bits(), "line {}: {x:e} vs {e}", i + 1);
                }
            }
        }
    }
}
