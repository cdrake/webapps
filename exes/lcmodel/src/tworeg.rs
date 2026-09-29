//! Regularization searches and priors (TWOREG ... SSRANG).
//!
//! Translated from LCModel.f 6.3-1N; see PORTING.md.
#![allow(unused_variables, unused_mut, unused_assignments, unused_imports, unreachable_code, unused_labels, clippy::all)]

use crate::format::{self, FVal, RKind, ReadErr};
use crate::fortran::*;
use crate::io::{self, Units, STDOUT};
use crate::state::*;
use crate::{fv, ErrQueue, Lcm};

/// SAVEd and static locals of this module's subprograms.
#[derive(Default, Clone, Debug)]
pub struct Saves {}

/// ILEN as LCModel.f defines it: the trimmed length, but 1 (not 0) for an
/// all-blank string.
fn ilen_f(st: &FStr) -> i32 {
    let n = st.len_trim() as i32;
    if n == 0 {
        1
    } else {
        n
    }
}

impl Lcm {
    /// INFLEC (PARBES(1,1), NSIDE2, DPY, DGAUSS, THRLIN, IMETHD).
    fn inflec_bes(&mut self) -> i32 {
        let c = &mut self.c;
        inflec(c.parbes.col(1), c.nside2, &mut c.dpy.data, &c.dgauss.data, c.thrlin, c.imethd)
    }

    /// NEXTRE (PARBES(1,1), NSIDE2, DPY, DGAUSS, THRLIN, IMETHD).
    fn nextre_bes(&mut self) -> i32 {
        let c = &mut self.c;
        nextre(c.parbes.col(1), c.nside2, &mut c.dpy.data, &c.dgauss.data, c.thrlin, c.imethd)
    }

    /// SUBROUTINE TWOREG.
    ///
    /// Find best unconstrained solution. If unusual conditions occur, do a
    /// series of NDEGPPM3 analyses with fixed DEGPPM.
    /// IDGPPM = -1 (default): only the standard free analysis.
    ///           0: analyses stressing flat baselines (medium SSQ/SSQMIN allowed).
    ///           1: stress good phasing and fit, to find small peaks (like Cho);
    ///              forces the fixed-DEGPPM series even with a flat baseline.
    ///           2: stresses good fit, but does not force the fixed-DEGPPM
    ///              series if the unconstrained solution is flat.
    pub fn tworeg(&mut self) -> R<()> {
        const CHSUBP: &str = "TWOREG";
        let mut big_base_free = [false; 3];
        // NDEGPPM3_USED = 0 for free analysis.
        self.c.ndegppm3_used = 0;
        self.tworg2(0, false)?;
        let degppm_free: f32 = ((self.c.phitot[2] as f64 + self.c.parbes[(self.c.lphast + 1, 2)]) / self.c.radian as f64) as f32;
        big_base_free[1] = self.r_base_sol_big(1)?;
        big_base_free[2] = self.r_base_sol_big(2)?;
        let lterm = degppm_free < self.c.dgppmn || degppm_free > self.c.dgppmx || big_base_free[1];
        // No unusual conditions or IDGPPM=-1: skip the series with fixed DEGPPM.
        if self.c.fxdegp || !lterm || self.c.idgppm < 0 {
            return Ok(());
        }
        self.errmes(12, 1, CHSUBP)?;
        self.tworeg_sav()?;
        self.c.degp_degp[0] = degppm_free;
        if self.c.ddegp3 <= 0.0 || self.c.mdegp3 <= 2 {
            self.errmes(13, 4, CHSUBP)?;
        }
        // Start from near DEGPPM of the free analysis, even if that is
        // outside the range of DGPPM*.
        let dgppmn_use: f32 = degppm_free.min(self.c.dgppmn);
        let dgppmx_use: f32 = degppm_free.max(self.c.dgppmx);
        if degppm_free < self.c.dgppmn || degppm_free > self.c.dgppmx {
            self.errmes(16, 1, CHSUBP)?;
        }
        let mut ndegppm3: i32 = nint((dgppmx_use - dgppmn_use) / self.c.ddegp3);
        if ndegppm3 > self.c.mdegp3 {
            self.errmes(14, 2, CHSUBP)?;
            ndegppm3 = self.c.mdegp3;
        }
        let ddegp3_use: f32 = (dgppmx_use - dgppmn_use) / ndegppm3 as f32;
        let degzer_free: f32 = ((self.c.phitot[1] as f64 + self.c.parbes[(self.c.lphast, 2)]) / self.c.radian as f64) as f32;
        let exdegp_orig: f32 = self.c.exdegp;
        let sddegp_orig: f32 = self.c.sddegp;
        // Start with DEGPPM of previous unconstrained analysis (not EXDEGP).
        self.c.exdegp = degppm_free;
        self.c.sddegp = 0.0;
        self.c.fxdegp = true;
        self.c.ssqbes_degp = self.c.rrange;
        'l200: {
            for jdgppm in 1..=ndegppm3 {
                self.c.exdegp = self.c.exdegp + ddegp3_use;
                // 6*SD (instead of 4) in the two tests below allows for
                // prostate with SDDEGP=30 & DGPPM*=30-150.
                if (self.c.exdegp - exdegp_orig).abs() > 6.0 * sddegp_orig {
                    continue;
                }
                if self.c.exdegp > dgppmx_use + 0.5 * ddegp3_use {
                    break 'l200;
                }
                self.c.ndegppm3_used = self.c.ndegppm3_used + 1;
                self.tworg1()?;
            }
        }
        // 200: start decreasing DEGPPM from DEGPPM & DEGZER of the solution
        // with free DEGPPM.
        let lphast = self.c.lphast;
        self.c.parbes[(lphast, 2)] = (degzer_free * self.c.radian - self.c.phitot[1]) as f64;
        self.rephas()?;
        self.c.exdegp = degppm_free;
        'l300: {
            for jdgppm in 1..=ndegppm3 {
                self.c.exdegp = self.c.exdegp - ddegp3_use;
                if (self.c.exdegp - exdegp_orig).abs() > 6.0 * sddegp_orig {
                    continue;
                }
                if self.c.exdegp < dgppmn_use - 0.5 * ddegp3_use {
                    break 'l300;
                }
                self.c.ndegppm3_used = self.c.ndegppm3_used + 1;
                self.tworg1()?;
            }
        }
        // 300: regenerate solution with minimum SSQ.
        // SSQBES(7) is from the initial analysis with free DEGPPM,
        // SSQBES(4) from the min-SSQ DEGPPM-constrained one.
        'l700: {
            if self.c.ndegppm3_used <= 0 {
                break 'l700;
            }
            if self.c.ssqbes[7] <= self.c.ssqbes[4] && !big_base_free[2] {
                self.errmes(17, 1, CHSUBP)?;
                self.savbes(-7)?;
            } else {
                // Always look for the smallest spline distance among the
                // solutions with SSQ < (min SSQ) * RSDGP3.
                self.savbes(-4)?;
                let bound: f32 = self.c.ssqbes[4] * self.c.rsdgp3;
                let mut distmn: f32 = self.c.rrange;
                let mut ldistmn: i32 = -1;
                for j in 0..=self.c.ndegppm3_used {
                    if self.c.ssq_degp[j] < bound {
                        if self.c.dist_degp[j] <= distmn {
                            distmn = self.c.dist_degp[j];
                            ldistmn = j;
                        }
                    }
                }
                if ldistmn >= 0 {
                    self.savbes(-ldistmn - 7)?;
                }
            }
        }
        // 700: restore these for use in FINOUT.
        self.c.exdegp = exdegp_orig;
        self.c.fxdegp = false;
        self.c.sddegp = sddegp_orig;
        Ok(())
    }

    /// SUBROUTINE tworg1: best solution for a fixed DEGPPM.
    fn tworg1(&mut self) -> R<()> {
        let n = self.c.ndegppm3_used;
        self.c.degp_degp[n] = self.c.exdegp;
        if self.c.lprint > 0 {
            let lprint = self.c.lprint;
            self.io.write(lprint, "(////25x, 'Analysis with fixed DEGPPM =', f8.2)", &fv![self.c.exdegp]);
        }
        let lphast = self.c.lphast;
        self.c.parbes[(lphast + 1, 2)] = (self.c.exdegp * self.c.radian - self.c.phitot[2]) as f64;
        self.rephas()?;
        self.tworg2(self.c.ndegppm3_used, true)?;
        self.tworeg_sav()?;
        Ok(())
    }

    /// SUBROUTINE tworeg_sav: save the current solution in *(NDEGPPM3_USED)
    /// and compute the baseline criteria.
    fn tworeg_sav(&mut self) -> R<()> {
        let n = self.c.ndegppm3_used;
        self.savbes(n + 7)?;
        self.c.ssq_degp[n] = self.c.ssqbes[2];
        self.c.alpb_degp[n] = self.c.alpbbs[2] as f32;
        self.c.dist_degp[n] = 0.0;
        for j in self.c.nmetab + 1..=self.c.nmetab + self.c.nbackg - 1 {
            self.c.dist_degp[n] = (self.c.dist_degp[n] as f64 + (self.c.solbes[(j, 2)] - self.c.solbes[(j + 1, 2)]).abs()) as f32;
        }
        if self.c.ssq_degp[n] <= self.c.ssqbes_degp {
            self.c.ssqbes_degp = self.c.ssq_degp[n];
            self.savbes(4)?;
        }
        Ok(())
    }

    /// SUBROUTINE tworg2: call TWORG3 to find ALPHAB and ALPHAS so that
    /// PRMNMX(1,1) < PROB1 < PRMNMX(2,1).
    /// ENDPHA = T to do a fixed-phase analysis after the analysis for ALPHAB
    /// & ALPHAS. USEMXB = T to choose the final solution with the largest ALPHAB.
    fn tworg2(&mut self, jpass: i32, fixed_degppm_series: bool) -> R<()> {
        const CHSUBP: &str = "TWOREG";
        let mut parbes_phase_sav = [0f64; 3];
        let mut ierror: i32 = 0;
        let mut prejok = false;
        let mut prej1: f32 = 0.0;
        // Repeated calls to SETUP produce slightly slower execution and more
        // PNNLS.
        if jpass <= 0 {
            self.setup(2)?;
            // In a fixed-DEGPPM series rephasing has already zeroed these,
            // but SETUP sets them. Set them back to zero.
            if fixed_degppm_series {
                let lphast = self.c.lphast;
                self.c.parnln[lphast] = 0.0;
                self.c.parnln[lphast + 1] = 0.0;
                self.c.parbes[(lphast, 2)] = 0.0;
                self.c.parbes[(lphast + 1, 2)] = 0.0;
            }
        }
        // Starting solution with ALPBST and ALPSST.
        if self.c.lprint > 0 {
            let lprint = self.c.lprint;
            self.io.write(
                lprint,
                "(////20X, 'Preliminary full analysis with alphaB =', 1PE9.2E2, ' and alphaS =', E9.2E2)",
                &fv![self.c.alphab, self.c.alphas],
            );
        }
        if self.c.imethd == 1 && self.c.nratio <= 0 {
            self.c.miter[2] = 2 * self.c.miter[2];
        }
        self.plinls(2, &mut ierror)?;
        if self.c.object.max(self.c.sdref) >= self.c.drange {
            self.errmes(1, 4, CHSUBP)?;
        }
        self.savbes(1)?;
        self.savbes(2)?;
        // Special quick exit, e.g., for huge Roche-2 analyses, where the above
        // ALPHA* can be the final values.
        if self.c.imethd == 1 {
            self.c.ninfl[1] = self.inflec_bes();
            self.c.nextr[1] = self.nextre_bes();
            if self.c.nratio > 0 {
                self.conc_prior()?;
                if self.c.nratio_used > 0 {
                    if self.c.ninfl[1] > 2 {
                        self.c.alphas = self.c.alphas * (self.c.rdalpb * self.c.rdalpb) as f64;
                    }
                    self.plinls(2, &mut ierror)?;
                    if self.c.object < self.c.drange {
                        self.savbes(1)?;
                        self.savbes(2)?;
                        self.c.ninfl[2] = self.inflec_bes();
                        self.c.nextr[2] = self.nextre_bes();
                    }
                }
            }
            for jrepha in 2..=self.c.mrepha[1] {
                if !self.ldegmx(1)? {
                    return Ok(());
                }
                let lphast = self.c.lphast;
                self.c.parbes[(lphast, 2)] = self.c.parbes[(lphast, 2)] * self.c.frepha as f64;
                self.c.parbes[(lphast + 1, 2)] = self.c.parbes[(lphast + 1, 2)] * self.c.frepha as f64;
                self.rephas()?;
                self.errmes(8, 1, CHSUBP)?;
                self.plinls(2, &mut ierror)?;
                if self.c.object < self.c.drange {
                    self.savbes(1)?;
                    self.savbes(2)?;
                    self.c.ninfl[2] = self.inflec_bes();
                    self.c.nextr[2] = self.nextre_bes();
                }
            }
            if self.ldegmx(1)? {
                self.errmes(18, 2, CHSUBP)?;
            }
            return Ok(());
        }
        if self.c.rdalpb <= 1.0
            || self.c.alpbst < (r2d(0.99999) * self.c.alpbmn) as f32
            || self.c.alpbst > (r2d(1.00001) * self.c.alpbmx) as f32
        {
            self.errmes(2, 4, CHSUBP)?;
        }
        // No point in varying ALPHAS when NSIDES=1; the peak shape does not
        // change with ALPHAS.
        if self.c.nsides <= 1 && self.c.imethd != 2 {
            self.c.mdalpb = 0;
        }
        if self.c.nratio > 0 && jpass <= 0 {
            // Set up CPRIOR after a preliminary Reference Solution and a Regula
            // Falsi search with ALSBMN, to get CONC estimates for weighting.
            self.c.ssqaim = 0.0;
            self.c.penbes[2] = self.c.drange;
            let (alphb, alphs, rrange) = (self.c.alpbbs[2], self.c.alpsmn, self.c.rrange);
            self.rfalsi(1, 1, true, alphb, alphs, -1.0 / rrange, 0.0, rrange, rrange, 1.0, &mut prejok, &mut prej1)?;
            if prejok || (self.c.alphab >= r2d(0.99999) * self.c.alpbmx && self.c.mdalpb <= 0) {
                self.savbes(2)?;
            }
            self.conc_prior()?;
        }
        let exdegz_orig: f32 = self.c.exdegz;
        let exdegp_orig: f32 = self.c.exdegp;
        let sddegz_orig: f32 = self.c.sddegz;
        let sddegp_orig: f32 = self.c.sddegp;
        let fxdegz_orig = self.c.fxdegz;
        let fxdegp_orig = self.c.fxdegp;
        self.c.ssqaim = 0.0;
        self.c.alpbbs[3] = -1.0;
        let mut ldegmx_sav = false;
        'l700: {
            let mrepha1 = self.c.mrepha[1];
            for jrepha in 1..=mrepha1 {
                self.tworg3(jrepha.abs())?;
                ldegmx_sav = self.ldegmx(1)?;
                // "Final" solution with fixed phases. ENDPHA = F by default to
                // keep normal analyses from taking 50% longer.
                let lphast = self.c.lphast;
                parbes_phase_sav[1] = self.c.parbes[(lphast, 2)];
                parbes_phase_sav[2] = self.c.parbes[(lphast + 1, 2)];
                let fixed_phase = (self.c.endpha && (!ldegmx_sav || jrepha == self.c.mrepha[1]))
                    || (ldegmx_sav && jrepha == self.c.mrepha[1]);
                if fixed_phase {
                    if self.c.lprint > 0 {
                        let lprint = self.c.lprint;
                        self.io.write(lprint, "(//20x, 'Repeat analysis with fixed phases from above')", &[]);
                    }
                    self.rephas()?;
                    self.c.exdegz = self.c.phitot[1] / self.c.radian;
                    self.c.exdegp = self.c.phitot[2] / self.c.radian;
                    self.c.sddegz = 0.0;
                    self.c.sddegp = 0.0;
                    self.c.fxdegz = true;
                    self.c.fxdegp = true;
                    self.tworg3(jrepha.abs())?;
                    self.c.exdegz = exdegz_orig;
                    self.c.exdegp = exdegp_orig;
                    self.c.sddegz = sddegz_orig;
                    self.c.sddegp = sddegp_orig;
                    self.c.fxdegz = fxdegz_orig;
                    self.c.fxdegp = fxdegp_orig;
                }
                // Save the solution with the max ALPHAB with SAVBES(3).
                if self.c.usemxb && self.c.alpbbs[2] >= self.c.alpbbs[3] {
                    self.savbes(3)?;
                }
                if !ldegmx_sav {
                    break 'l700;
                }
                if jrepha < self.c.mrepha[1] {
                    // Reduce the rephasing corrections by a factor of FREPHA
                    // (0.5 hopefully avoids oscillating between two phase sets).
                    if !fixed_phase {
                        let lphast = self.c.lphast;
                        self.c.parbes[(lphast, 2)] = parbes_phase_sav[1] * self.c.frepha as f64;
                        self.c.parbes[(lphast + 1, 2)] = parbes_phase_sav[2] * self.c.frepha as f64;
                    }
                }
                self.errmes(8, 1, CHSUBP)?;
            }
            self.errmes(9, 1, CHSUBP)?;
        }
        // 700: regenerate the solution with the max ALPHAB if no stable
        // phases have been found.
        if self.c.usemxb && ldegmx_sav {
            self.savbes(-3)?;
        }
        Ok(())
    }

    /// SUBROUTINE tworg3: find ALPHAB and ALPHAS so that
    /// PRMNMX(1,1) < PROB1 < PRMNMX(2,1). Shares ERRMES numbers with TWOREG.
    fn tworg3(&mut self, jrepha: i32) -> R<()> {
        const CHSUBP: &str = "TWOREG";
        let mut prejok = false;
        let mut prej1: f32 = 0.0;
        let mut itest: i32;
        for j in 1..=2 {
            self.c.nextr[j] = 0;
            self.c.ninfl[j] = -1;
        }
        self.c.penbes[2] = self.c.drange;
        let (alphb, alphs, rrange) = (self.c.alpbbs[2], self.c.alpsmn, self.c.rrange);
        self.rfalsi(1, 1, true, alphb, alphs, -1.0 / rrange, 0.0, rrange, rrange, 1.0, &mut prejok, &mut prej1)?;
        if self.c.mdalpb <= 0 && self.c.daimbs < self.c.rrange {
            let usesol = prejok || self.c.alphab >= r2d(0.99999) * self.c.alpbmx;
            if !usesol && self.c.useany {
                self.errmes(10, 2, CHSUBP)?;
            }
            if usesol || self.c.useany {
                self.savbes(2)?;
                self.c.ninfl[1] = self.inflec_bes();
                self.c.nextr[1] = self.nextre_bes();
            }
        }
        'l330: {
            for jdalpb in 1..=self.c.mdalpb {
                if self.c.lprint > 0 {
                    let lprint = self.c.lprint;
                    self.io.write(lprint, "(//////10X, 'Phase Pair', I2, 5X, 'Decrease', I2, ' of alphaB/alphaS')", &fv![jrepha, jdalpb]);
                }
                let alphb = self.c.alpbbs[1] / self.c.rdalpb as f64;
                let alphs = self.c.alpsbs[1] * self.c.rdalpb as f64;
                let (ssqref, rrange) = (self.c.ssqref, self.c.rrange);
                self.rfalsi(3, 1, false, alphb, alphs, ssqref, 0.0, rrange, rrange, 1.0, &mut prejok, &mut prej1)?;
                if prejok {
                    if self.c.penbes[1] < self.c.penbes[2] {
                        self.savbes(2)?;
                        self.c.ninfl[1] = self.inflec_bes();
                        self.c.nextr[1] = self.nextre_bes();
                    } else if self.c.penbes[1] >= self.c.rpenmx as f64 * self.c.penbes[2] {
                        break 'l330;
                    }
                    if self.nextre_bes() <= 1 {
                        break 'l330;
                    }
                }
                if self.c.alpbbs[1] <= self.c.alpbmn || self.c.alpsbs[1] >= self.c.alpsmx {
                    break 'l330;
                }
            }
            if self.c.mdalpb > 0 {
                self.errmes(3, 2, CHSUBP)?;
            }
        }
        // 330
        if self.c.penbes[2] >= self.c.drange {
            self.errmes(4, 4, CHSUBP)?;
        }
        if self.c.mdalpb <= 0 || self.c.usinfl {
            itest = self.c.ninfl[1] - 2;
        } else {
            itest = self.c.nextr[1] - 1;
        }
        'l800: {
            if itest > 0 && self.c.alpbbs[2] > self.c.alpbmn && !self.c.vitro && self.c.alpsbs[2] < self.c.alpsmx {
                if self.c.lprint > 0 {
                    let lprint = self.c.lprint;
                    self.io.write(lprint, "(//////20X, 'Step 2: Increase alphaS with fixed', ' alphaB')", &[]);
                }
                if self.c.prmnmx[(2, 1)].max(self.c.prmnmx[(2, 3)]) > self.c.prmnmx[(1, 2)] {
                    self.errmes(5, 4, CHSUBP)?;
                }
                self.ssrang(2)?;
                for jnonl in 1..=self.c.nnonl {
                    self.c.parnln[jnonl] = self.c.parbes[(jnonl, 2)];
                }
                let (alphb, alphs, assqlo, rrange, ralinc) = (self.c.alpbbs[2], self.c.alpsbs[2], self.c.ssqbes[2], self.c.rrange, self.c.ralinc);
                self.rfalsi(2, 2, false, alphb, alphs, assqlo, 1.0, rrange, rrange, ralinc, &mut prejok, &mut prej1)?;
                if !prejok {
                    self.errmes(6, 2, CHSUBP)?;
                    break 'l800;
                }
                if self.c.skip_step3 {
                    self.savbes(2)?;
                    self.c.ninfl[2] = self.inflec_bes();
                    self.c.nextr[2] = self.nextre_bes();
                    break 'l800;
                }
                if self.c.imethd == 2 && self.c.accept_step2 {
                    self.savbes(2)?;
                }
                if self.c.mdalpb <= 0 || self.c.usinfl {
                    itest = self.inflec_bes() - 2;
                } else {
                    itest = self.nextre_bes() - 1;
                }
                if itest <= 0 {
                    // Special exit from Step 2 with a 2-inflection-point or
                    // unimodal lineshape and PREJ1 < PRMNMX(2,3).
                    if prej1 > self.c.prmnmx[(2, 3)] {
                        if self.c.lprint > 0 {
                            let lprint = self.c.lprint;
                            self.io.write(lprint, "(//////20X, 'Step 3A: Decrease alphaB and ', 'alphaS')", &[]);
                        }
                        self.ssrang(3)?;
                        let (alphb, alphs, ssqref, assqhi, ralinc) = (self.c.alpbbs[2], self.c.alpsbs[1], self.c.ssqref, self.c.ssqbes[1], self.c.ralinc);
                        self.rfalsi(3, 3, false, alphb, alphs, ssqref, 0.0, assqhi, 1.0, 1.0 / ralinc, &mut prejok, &mut prej1)?;
                    }
                } else {
                    if self.c.lprint > 0 {
                        let lprint = self.c.lprint;
                        self.io.write(lprint, "(//////20X, 'Step 3B: Decrease alphaB with ', 'fixed alphaS')", &[]);
                    }
                    self.ssrang(3)?;
                    let (alphb, alphs, rrange, assqhi, ralinc) = (self.c.alpbbs[2], self.c.alpsbs[1], self.c.rrange, self.c.ssqbes[1], self.c.ralinc);
                    self.rfalsi(1, 3, false, alphb, alphs, -1.0 / rrange, 0.0, assqhi, 1.0, 1.0 / ralinc, &mut prejok, &mut prej1)?;
                    // With IMETHD=2, use ALPBMN in Step 3, even if PREJ is not
                    // down to PRMNMX(2,3), to avoid using results of Step 1.
                    if self.c.imethd == 2 && self.c.accept_alpbmn && self.c.is_alpbmn {
                        self.savbes(1)?;
                        prejok = true;
                    }
                }
                if prejok {
                    let nextr_test = self.nextre_bes();
                    let ninfl_test = self.inflec_bes();
                    if ninfl_test >= self.c.ninfl[1] && nextr_test >= self.c.nextr[1] && self.c.imethd != 2 {
                        if self.c.lprint > 0 {
                            let lprint = self.c.lprint;
                            self.io.write(
                                lprint,
                                "(//////' Steps 2 and 3 did not decrease ', 'the no. of inflections or extrema; ', 'they will not be used.'//)",
                                &[],
                            );
                        }
                        break 'l800;
                    }
                    self.savbes(2)?;
                    self.c.ninfl[2] = ninfl_test;
                    self.c.nextr[2] = nextr_test;
                } else {
                    self.errmes(7, 1, CHSUBP)?;
                }
            }
        }
        // 800
        Ok(())
    }

    /// LOGICAL FUNCTION r_base_sol_big.
    /// ISTAGE = 1 for testing the free solution, 2 for the min-SSQ solution
    /// from the fixed-DEGPPM series. .TRUE. if the ratio of the height
    /// difference in the baseline to that in the solution > RBASMX(ISTAGE).
    /// Uses the values currently in *BES(2).
    fn r_base_sol_big(&mut self, istage: i32) -> R<bool> {
        const CHSUBP: &str = "RBASOL";
        let mut lerror = false;
        let r_base_sol_big: bool;
        // Statements down thru 165 (except SAVBES) are from FINOUT. Skipping
        // the 1st call to SOLVE below caused a FATAL.
        self.savbes(6)?;
        for jpar in 1..=self.c.nlin {
            self.c.solutn[jpar] = self.c.solbes[(jpar, 2)];
        }
        for jnonl in 1..=self.c.nnonl {
            self.c.parnln[jnonl] = self.c.parbes[(jnonl, 2)];
        }
        self.c.alphab = self.c.alpbbs[2];
        self.c.alphas = self.c.alpsbs[2];
        let pmq = self.c.pmqbes[2];
        self.solve(2, true, pmq, false, &mut lerror)?;
        if lerror {
            self.errmes(1, 4, CHSUBP)?;
        }
        // SOLVE again to get YFITRE(JY,0) = fit and BACKRE(JY) = background.
        for jpar in 1..=self.c.nlin {
            self.c.solutn[jpar] = self.c.solbes[(jpar, 2)];
        }
        self.solve(2, false, 0.0, true, &mut lerror)?;
        if lerror {
            self.errmes(2, 4, CHSUBP)?;
        }
        self.savbes(-6)?;
        let mut solmax: f32 = -self.c.rrange;
        let mut basmin: f32 = self.c.rrange;
        let mut basmax: f32 = -self.c.rrange;
        let mut lmax: i32 = 0;
        let mut lmin: i32 = 0;
        for j in 1..=self.c.nyuse {
            solmax = solmax.max((self.c.yfitre[(j, 0)] - self.c.backre[j]).abs());
            if self.c.backre[j] <= basmin {
                basmin = self.c.backre[j];
                lmin = j;
            }
            if self.c.backre[j] >= basmax {
                basmax = self.c.backre[j];
                lmax = j;
            }
        }
        let base_dist: f32 = basmax - basmin;
        if solmax <= 0.0 {
            self.errmes(3, 2, CHSUBP)?;
            r_base_sol_big = true;
        } else {
            r_base_sol_big = base_dist / solmax > self.c.rbasmx[istage];
            if self.c.lprint > 0 {
                let lprint = self.c.lprint;
                self.io.write(
                    lprint,
                    "('base_dist =', 1pe11.3, 3x, 'solmax =', e11.3, 3x, 'ratio =',  e11.3, 3x, 'ratio limit =', e11.3/)",
                    &fv![base_dist, solmax, base_dist / solmax, self.c.rbasmx[istage]],
                );
            }
        }
        Ok(r_base_sol_big)
    }

    /// SUBROUTINE conc_prior: make CPRIOR, the matrix of priors for the CONC
    /// ratios in CHRATI.
    ///
    /// CHRATI must contain exactly one Metabolite Name in the numerator, then
    /// a slash, then a CONC sum (no whitespace). CHRATW can contain a further
    /// CONC sum, used only in CSUM for the weights. The prior is
    ///   c_num - c_sum * exrati = 0 +- c_sum * sdrati,
    /// with c_sum estimated from the CONC of the Preliminary Full Analysis.
    /// In many cases a prior is simply skipped on an error condition.
    pub fn conc_prior(&mut self) -> R<()> {
        const CHSUBP: &str = "CONCPR";
        let mut chterm = FStr::blank(MCHMET as usize);
        let mut denom_absent: bool;
        let mut csum: f32;
        let mut sqrtwt: f32;
        // NRATIO = input number of priors; NRATIO_USED = number used.
        if self.c.nratio > MMETAB {
            self.errmes(1, 4, CHSUBP)?;
        }
        self.parse_prior()?;
        self.c.nratio_used = 0;
        'l110: for jratio in 1..=self.c.nratio {
            // Increment NRATIO_USED as though this try will be accepted;
            // decremented at 300 if not.
            self.c.nratio_used = self.c.nratio_used + 1;
            let nru = self.c.nratio_used;
            'l300: {
                for j in 1..=MMETAB {
                    self.c.cprior[(nru, j)] = 0.0;
                }
                let islash = self.c.chrati[jratio].index("/");
                if islash <= 1 {
                    if self.c.lprint > 0 {
                        let lprint = self.c.lprint;
                        self.io.write(lprint, "(' Missing slash in the ratio in CHRATO: ',A)", &fv![&self.c.chrati[jratio]]);
                    }
                    self.errmes(2, 4, CHSUBP)?;
                }
                // Numerator: exactly one Metabolite Name.
                let length = islash - 1;
                if length > MCHMET {
                    if self.c.lprint > 0 {
                        let lprint = self.c.lprint;
                        self.io.write(lprint, "(' Incorrect numerator in CHRATI =',A)", &fv![&self.c.chrati[jratio]]);
                    }
                    self.errmes(3, 4, CHSUBP)?;
                }
                chterm.set_f(&self.c.chrati[jratio].sub(1, length));
                for jomit in 1..=self.c.nnorat {
                    if chterm.eq_f(&self.c.norato[jomit]) {
                        break 'l300;
                    }
                }
                let mut found = false;
                for jmetab in 1..=self.c.nmetab {
                    if chterm.eq_f(&self.c.nacomb[jmetab]) {
                        if self.c.exrati[jratio] < 0.0 || self.c.sdrati[jratio] <= 0.0 {
                            self.errmes(4, 4, CHSUBP)?;
                        }
                        self.c.lmetab_prior[nru] = jmetab;
                        self.c.cprior[(nru, jmetab)] = 1.0;
                        found = true;
                        break;
                    }
                }
                if !found {
                    break 'l300;
                }
                // 150: denominator.
                csum = 0.0;
                denom_absent = true;
                let denom = self.c.chrati[jratio].sub_from(islash + 1);
                let exr = self.c.exrati[jratio];
                self.parse_sum(exr, &denom, MCHRATIO - islash, nru, &mut csum, &mut denom_absent)?;
                // CHRATW: extra metabolites included for weighting.
                let w = self.c.chratw[jratio].clone();
                self.parse_sum(0.0, &w, MCHRATIO, nru, &mut csum, &mut denom_absent)?;
                // Skip the prior if the denominator & weight metabolites are
                // not in the analysis.
                if denom_absent {
                    break 'l300;
                }
                if csum <= 0.0 {
                    // CSUM from the denominator was 0. Use the sum over all
                    // CONCs times a small factor (FCSUM) for the weight.
                    self.c.dterm[1] = 0.0;
                    for jmetab in 1..=self.c.nmetab {
                        self.c.dterm[1] = self.c.dterm[1] + self.c.solbes[(jmetab, 1)];
                    }
                    if self.c.fcsum <= 0.0 {
                        self.errmes(5, 4, CHSUBP)?;
                    }
                    csum = self.c.fcsum * self.c.dterm[1] as f32;
                    // If all CONCs are 0, skip this constraint.
                    if csum == 0.0 {
                        self.errmes(6, 2, CHSUBP)?;
                        break 'l300;
                    }
                }
                sqrtwt = 1.0 / (csum * self.c.sdrati[jratio]);
                for jmetab in 1..=self.c.nmetab {
                    self.c.cprior[(nru, jmetab)] = self.c.cprior[(nru, jmetab)] * sqrtwt;
                }
                // Move *(JRATIO) down to *(NRATIO_USED) for later output.
                let s = self.c.chrato[jratio].clone();
                self.c.chrato[nru].set_f(&s);
                self.c.exrati[nru] = self.c.exrati[jratio];
                self.c.sdrati[nru] = self.c.sdrati[jratio];
                self.c.sqrtwt_ratio_used[nru] = sqrtwt;
                continue 'l110;
            }
            // 300
            self.c.nratio_used = self.c.nratio_used - 1;
        }
        // Dump the prior matrix (IPDUMP >= 3) or the active CHRATO.
        if self.c.nratio_used.min(self.c.lprint) > 0 {
            let lprint = self.c.lprint;
            if self.c.ipdump >= 3 {
                let mut v: Vec<FVal> = Vec::new();
                for j in 1..=self.c.nmetab {
                    v.push(FVal::from(&self.c.nacomb[j]));
                }
                self.io.write(lprint, "(//20x, 'Prior matrix for concentration ratios'// (8x, (10(6x, a6))))", &v);
                for jratio in 1..=self.c.nratio_used {
                    let mut v: Vec<FVal> = vec![FVal::from(&self.c.nacomb[self.c.lmetab_prior[jratio]])];
                    for jmetab in 1..=self.c.nmetab {
                        v.push(FVal::R(self.c.cprior[(jratio, jmetab)]));
                    }
                    self.io.write(lprint, "(/2x, a6, 1p10e12.3 / (8x, 1p10e12.3))", &v);
                }
            } else {
                let mut v: Vec<FVal> = Vec::new();
                for jratio in 1..=self.c.nratio_used {
                    v.push(FVal::from(self.c.chrato[jratio].sub(1, 132)));
                    v.push(FVal::from(self.c.chrato[jratio].sub(133, 264)));
                }
                self.io.write(lprint, "(//10x, 'CHRATO ratio priors used' // (a132))", &v);
            }
        }
        Ok(())
    }

    /// SUBROUTINE parse_prior: parse the CHRATO input strings into CHRATI,
    /// CHRATW, EXRATI & SDRATI. CHRATO must be of the form
    ///   CHRATI = EXRATI +- SDRATI +WT= CHRATW
    fn parse_prior(&mut self) -> R<()> {
        const CHSUBP: &str = "PPRIOR";
        let mut chreturn = FStr::blank(MCHRATIO as usize);
        let mut freturn: f32 = 0.0;
        let mut istart: i32 = 0;
        let mut ierr: i32 = 0;
        let mut jratio: i32 = 1;
        'l800: {
            'l210: for jr in 1..=self.c.nratio {
                jratio = jr;
                let len_chrato = ilen_f(&self.c.chrato[jratio]);
                istart = 1;
                let mut q = ErrQueue::new();
                let c = &mut self.c;
                let r = get_field("=", 1, 1, 0, &mut c.chrati[jratio], &mut freturn, &mut istart, len_chrato, &c.chrato[jratio], &mut q);
                self.after(q, r)?;
                if istart <= 0 {
                    // Can be caused by an empty string, i.e., no input for CHRATO.
                    ierr = 0;
                    break 'l800;
                }
                let mut q = ErrQueue::new();
                let c = &mut self.c;
                let r = get_field("+-", 2, 2, 0, &mut chreturn, &mut c.exrati[jratio], &mut istart, len_chrato, &c.chrato[jratio], &mut q);
                self.after(q, r)?;
                if istart <= 0 {
                    ierr = 1;
                    break 'l800;
                }
                let mut q = ErrQueue::new();
                let c = &mut self.c;
                let r = get_field("+WT=", 4, 2, 1, &mut chreturn, &mut c.sdrati[jratio], &mut istart, len_chrato, &c.chrato[jratio], &mut q);
                self.after(q, r)?;
                if istart > len_chrato {
                    continue 'l210;
                }
                if istart < 0 {
                    ierr = 2;
                    break 'l800;
                }
                let mut q = ErrQueue::new();
                let c = &mut self.c;
                let r = get_field(" ", 0, 1, 2, &mut c.chratw[jratio], &mut freturn, &mut istart, len_chrato, &c.chrato[jratio], &mut q);
                self.after(q, r)?;
                if istart <= 0 {
                    ierr = 3;
                    break 'l800;
                }
            }
            return Ok(());
        }
        // 800
        if self.c.lprint > 0 {
            let lprint = self.c.lprint;
            self.io.write(
                lprint,
                "('Incorrect CHRATO follows:', / a132 / a132 / 'ISTART =', i3)",
                &fv![self.c.chrato[jratio].sub(1, 132), self.c.chrato[jratio].sub(133, 264), istart],
            );
        }
        self.errmes(100 * ierr + jratio, 4, CHSUBP)?;
        Ok(())
    }

    /// SUBROUTINE parse_sum: parse CHRATI or CHRATW, computing the
    /// (unweighted) CPRIOR elements and CSUM. CPRIOR is later multiplied by
    /// the weight 1/(SD*CSUM). With no denominator metabolites present, CPRIOR
    /// is zero except for the numerator, which then has expectation zero.
    fn parse_sum(&mut self, exrati_arg: f32, substring: &FStr, len_substring: i32, lratio: i32, csum: &mut f32, denom_absent: &mut bool) -> R<()> {
        const CHSUBP: &str = "PARSUM";
        let mut chterm = FStr::blank(MCHMET as usize);
        let mut istart: i32 = 1;
        let mut factor: f32;
        for jterm in 1..=MMET_RATIO - 1 {
            let mut length = substring.sub(istart, len_substring).index("+") - 1;
            let atend = length == -1;
            if atend {
                length = substring.sub(istart, len_substring).index(" ") - 1;
            }
            // Blank in position 1 or right after the last "+".
            if length == 0 {
                return Ok(());
            }
            // CHRATI has room for at least one blank at the end if <= MMET_RATIO
            // terms are used. If not, abort (probably > MMET_RATIO terms).
            if length == -1 {
                if self.c.lprint > 0 {
                    let lprint = self.c.lprint;
                    self.io.write(lprint, "(' Too long a sum in CHRATO, ending as follows:'/ a)", &fv![substring.sub(1, len_substring)]);
                }
                self.errmes(1, 4, CHSUBP)?;
            }
            if length > MCHMET {
                if self.c.lprint > 0 {
                    let lprint = self.c.lprint;
                    self.io.write(
                        lprint,
                        "(' Too long a Metabolite Name in CHRATO ', 'ending as follows:' / A)",
                        &fv![substring.sub(1, len_substring)],
                    );
                }
                self.errmes(2, 4, CHSUBP)?;
            }
            let wildcard = substring.sub(istart + length - 1, istart + length - 1).eq_str("*");
            for jmetab in 1..=self.c.nmetab {
                factor = 0.0;
                let nacomb = &self.c.nacomb[jmetab];
                if wildcard {
                    if length == 1 {
                        factor = 1.0;
                    } else {
                        if substring.sub(istart, istart + length - 2).eq_f(&nacomb.sub(1, length - 1)) {
                            factor = 1.0;
                        }
                    }
                } else {
                    chterm.set_f(&substring.sub(istart, istart + length - 1));
                    if chterm.eq_f(nacomb) {
                        factor = 1.0;
                    }
                    if chterm.eq_str("totCho") && (nacomb.eq_str("Cho") || nacomb.eq_str("GPC") || nacomb.eq_str("PCh")) {
                        factor = 1.0;
                    }
                    if chterm.eq_str("totCr") && (nacomb.eq_str("Cr") || nacomb.eq_str("Cre") || nacomb.eq_str("PCr")) {
                        factor = 1.0;
                    }
                    if chterm.eq_str("totNAA") && (nacomb.eq_str("NAA") || nacomb.eq_str("NAAG")) {
                        factor = 1.0;
                    }
                    if chterm.eq_str("Big3") {
                        if nacomb.eq_str("Cr") || nacomb.eq_str("Cre") || nacomb.eq_str("PCr") || nacomb.eq_str("NAA") || nacomb.eq_str("NAAG") {
                            factor = 1.0;
                        } else if nacomb.eq_str("Cho") || nacomb.eq_str("GPC") || nacomb.eq_str("PCh") {
                            factor = 3.0;
                        }
                    }
                }
                if factor > 0.0 {
                    *denom_absent = false;
                    *csum = *csum + factor * self.c.solbes[(jmetab, 1)] as f32;
                    if exrati_arg > 0.0 {
                        self.c.cprior[(lratio, jmetab)] = self.c.cprior[(lratio, jmetab)] - factor * exrati_arg;
                    }
                }
            }
            if atend {
                return Ok(());
            }
            istart = istart + length + 1;
        }
        if self.c.lprint > 0 {
            let lprint = self.c.lprint;
            self.io.write(
                lprint,
                "(' Too many metabolites in CHRATI or CHRATW ', 'ending as follows:' / A)",
                &fv![substring.sub(1, len_substring)],
            );
        }
        self.errmes(3, 4, CHSUBP)?;
        Ok(())
    }

    /// SUBROUTINE SSRANG: set parameters for the Regula Falsi search.
    pub fn ssrang(&mut self, irange: i32) -> R<()> {
        const CHSUBP: &str = "SSRANG";
        if irange < 1 || irange > 3 {
            self.errmes(1, 5, CHSUBP)?;
        }
        let (p1, nyuse, ndfref, ssqref, lprint, rrange) = (self.c.prmnmx[(1, irange)], self.c.nyuse, self.c.ndfref as f32, self.c.ssqref, self.c.lprint, self.c.rrange);
        self.c.ssqmin = self.fshssq(p1, 0, nyuse, ndfref, ssqref, lprint, rrange)?;
        let (p2, nyuse, ndfref, ssqref, lprint, rrange) = (self.c.prmnmx[(2, irange)], self.c.nyuse, self.c.ndfref as f32, self.c.ssqref, self.c.lprint, self.c.rrange);
        self.c.ssqmax = self.fshssq(p2, 0, nyuse, ndfref, ssqref, lprint, rrange)?;
        if self.c.lprint > 0 {
            let lprint = self.c.lprint;
            self.io.write(
                lprint,
                "(//' SSQREF =',1PE14.6,'   SSQMIN =',E14.6,'   SSQMAX =', E14.6,'   PREJMN =',0PF7.4,'   PREJMX =',F7.4//)",
                &fv![self.c.ssqref, self.c.ssqmin, self.c.ssqmax, self.c.prmnmx[(1, irange)], self.c.prmnmx[(2, irange)]],
            );
        }
        self.c.ssqaim = 0.5 * (self.c.ssqmin + self.c.ssqmax);
        if self.c.ssqmin >= self.c.ssqmax {
            self.errmes(2, 4, CHSUBP)?;
        }
        Ok(())
    }

    /// LOGICAL FUNCTION LDEGMX: T if the max. phase correction to the data
    /// would exceed DEGMAX(IDEGMX).
    pub fn ldegmx(&mut self, idegmx: i32) -> R<bool> {
        const CHSUBP: &str = "LDEGMX";
        if (idegmx != 1 && idegmx != 2) || self.c.radian <= 0.0 {
            self.errmes(1, 5, CHSUBP)?;
        }
        if self.c.degmax[idegmx] <= 0.0 {
            self.errmes(2, 4, CHSUBP)?;
        }
        let phizer: f32 = self.c.parbes[(self.c.lphast, 2)] as f32;
        let phione: f32 = self.c.parbes[(self.c.lphast + 1, 2)] as f32;
        let ppmcen = self.c.ppmcen;
        let phacor = |ppmarg: f32| -> f32 { (phizer + (ppmarg - ppmcen) * phione).abs() };
        let ppmsig_max: f32 = self.c.ppmsig[1].max(self.c.ppmsig[2]);
        let ppmsig_min: f32 = self.c.ppmsig[1].min(self.c.ppmsig[2]);
        let ppmmax: f32 = ppmsig_max.min(self.c.ppm[1]);
        let ppmmin: f32 = ppmsig_min.max(self.c.ppm[self.c.nyuse]);
        let ldegmx = phacor(ppmmax).max(phacor(ppmmin)) > self.c.degmax[idegmx] * self.c.radian;
        Ok(ldegmx)
    }
}

/// SUBROUTINE get_field: extract a field from STRING_IN into CHRETURN
/// (IFIELD_TYPE = 1) or FRETURN (IFIELD_TYPE = 2).
///
/// On return ISTART is the start of the next field, or negative on error:
/// -1 separator absent, -2 field blank, -3 numeric field too long,
/// -4 bad IFIELD_TYPE, -5 unreadable number.
/// IATEND = 0: CHSEPARATOR must be present; 1: it may be absent with the field
/// at the end; 2: the field is at the end.
pub fn get_field(
    chseparator: &str,
    len_chseparator: i32,
    ifield_type: i32,
    iatend: i32,
    chreturn: &mut FStr,
    freturn: &mut f32,
    istart: &mut i32,
    len_string_in: i32,
    string_in: &FStr,
    q: &mut ErrQueue,
) -> R<()> {
    const CHSUBP: &str = "GFIELD";
    let mut iend_field: i32 = 0;
    let sep = FStr::lit(chseparator).sub(1, len_chseparator);
    // Locate the field in STRING_IN.
    if len_string_in < *istart {
        q.errmes(1, 5, CHSUBP)?;
    }
    if iatend == 0 {
        // CHSEPARATOR must be present.
        iend_field = string_in.sub(*istart, len_string_in).index_f(&sep) - 2 + *istart;
        if iend_field < *istart {
            // Separator absent.
            *istart = -1;
            return Ok(());
        }
    } else if iatend == 1 {
        // CHSEPARATOR may be present, but the field may also be at the end.
        iend_field = string_in.sub(*istart, len_string_in).index_f(&sep) - 2 + *istart;
        if iend_field < *istart {
            iend_field = len_string_in;
        }
    } else if iatend == 2 {
        // The field is at the end; CHSEPARATOR is not present.
        iend_field = len_string_in;
    } else {
        q.errmes(2, 5, CHSUBP)?;
    }
    // Remove leading white space.
    let mut istart_field: i32 = 0;
    let mut nonblank = false;
    for k in *istart..=iend_field {
        istart_field = k;
        if string_in.at(k) != b' ' {
            nonblank = true;
            break;
        }
    }
    if !nonblank {
        // Entire field is blank.
        *istart = -2;
        return Ok(());
    }
    // 220: increment ISTART (IEND_FIELD is changed below).
    *istart = iend_field + len_chseparator + 1;
    // Remove trailing white space.
    *istart = iend_field + len_chseparator + 1;
    let i = iend_field;
    iend_field = fdo_end(i, istart_field, -1);
    for k in fdo(i, istart_field, -1) {
        if string_in.at(k) != b' ' {
            iend_field = k;
            break;
        }
    }
    // 240
    if ifield_type == 1 {
        chreturn.set_f(&string_in.sub(istart_field, iend_field));
    } else if ifield_type == 2 {
        let i = iend_field - istart_field + 1;
        let fmt = if i <= 9 {
            format::write_line("('(f', i1, '.0)')", &fv![i])
        } else if i <= 99 {
            format::write_line("('(f', i2, '.0)')", &fv![i])
        } else {
            *istart = -3;
            return Ok(());
        };
        let record = [string_in.sub(istart_field, iend_field).as_str()];
        let mut rec = 0usize;
        match format::read_fmt(&fmt, &record, &mut rec, &[RKind::R]) {
            Ok(v) => match v.first() {
                Some(FVal::R(x)) => *freturn = *x,
                _ => {
                    // 810
                    *istart = -5;
                }
            },
            Err(_) => {
                // 810
                *istart = -5;
            }
        }
    } else {
        *istart = -4;
        return Ok(());
    }
    Ok(())
}

/// INTEGER FUNCTION NEXTRE: number of extrema, assuming one zero point
/// outside each boundary and that the point between PARNL(NSIDE2/2) and
/// PARNL(NSIDE2/2+1) is 1-(sum over the NSIDE2 PARNL).
/// The lineshape is first smoothed with DGAUSS. An extremum is not counted if
/// it and one of its neighboring extrema are below THRLIN*(max |point|), i.e.,
/// a notch near the noisy baseline.
/// DPY is DPY(NSIDE2+3,2); DGAUSS(0:NSIDE2+2) starts at element 0.
pub fn nextre(parnl: &[f64], nside2: i32, dpy: &mut [f64], dgauss: &[f64], thrlin: f32, imethd: i32) -> i32 {
    if imethd == 2 {
        return 99;
    }
    let ld = nside2 + 3;
    let ix = |i: i32, j: i32| -> usize { ((i - 1) + ld * (j - 1)) as usize };
    let p = |j: i32| -> f64 { parnl[(j - 1) as usize] };
    let g = |k: i32| -> f64 { dgauss[k as usize] };
    dpy[ix(1, 1)] = 0.0;
    dpy[ix(nside2 + 3, 1)] = 0.0;
    let mut dsum: f64 = 1.0;
    for jpar in 1..=nside2 {
        dsum = dsum - p(jpar);
    }
    let imiddl = nside2 / 2 + 2;
    let mut jpar: i32 = 0;
    for jpy in 2..=nside2 + 2 {
        if jpy == imiddl {
            dpy[ix(jpy, 1)] = dsum;
        } else {
            jpar = jpar + 1;
            dpy[ix(jpy, 1)] = p(jpar);
        }
    }
    let mut dthr: f64 = 0.0;
    for jpy in 1..=nside2 + 3 {
        dsum = 0.0;
        for kpy in 1..=nside2 + 3 {
            dsum = dsum + dpy[ix(kpy, 1)] * g((kpy - jpy).abs());
        }
        dpy[ix(jpy, 2)] = dsum;
        dthr = dthr.max(dsum.abs());
    }
    dthr = dthr * thrlin as f64;
    let mut kextr: i32 = 1;
    dpy[ix(1, 1)] = 0.0;
    for jpar in 2..=nside2 + 2 {
        if (dpy[ix(jpar, 2)] - dpy[ix(jpar - 1, 2)]) * (dpy[ix(jpar + 1, 2)] - dpy[ix(jpar, 2)]) < 0.0 {
            kextr = kextr + 1;
            dpy[ix(kextr, 1)] = dpy[ix(jpar, 2)].abs();
        }
    }
    dpy[ix(kextr + 1, 1)] = 0.0;
    let mut nextre: i32 = 0;
    for jextr in 2..=kextr {
        if dpy[ix(jextr, 1)].max(dpy[ix(jextr + 1, 1)].min(dpy[ix(jextr - 1, 1)])) > dthr {
            nextre = nextre + 1;
        }
    }
    nextre
}

/// INTEGER FUNCTION INFLEC: number of inflection points, assuming 2 zero
/// points outside each boundary and that the point between PARNL(NSIDE2/2)
/// and PARNL(NSIDE2/2+1) is 1-(sum over the NSIDE2 PARNL).
/// The lineshape is first smoothed with DGAUSS. Inflections are only counted
/// where the smoothed point exceeds THRLIN*(max |point|).
/// DPY is DPY(NSIDE2+5,2); DGAUSS(0:NSIDE2+4) starts at element 0.
pub fn inflec(parnl: &[f64], nside2: i32, dpy: &mut [f64], dgauss: &[f64], thrlin: f32, imethd: i32) -> i32 {
    if imethd == 2 {
        return 99;
    }
    let ld = nside2 + 5;
    let ix = |i: i32, j: i32| -> usize { ((i - 1) + ld * (j - 1)) as usize };
    let p = |j: i32| -> f64 { parnl[(j - 1) as usize] };
    let g = |k: i32| -> f64 { dgauss[k as usize] };
    dpy[ix(1, 1)] = 0.0;
    dpy[ix(2, 1)] = 0.0;
    dpy[ix(nside2 + 4, 1)] = 0.0;
    dpy[ix(nside2 + 5, 1)] = 0.0;
    let mut dsum: f64 = 1.0;
    for jpar in 1..=nside2 {
        dsum = dsum - p(jpar);
    }
    let imiddl = nside2 / 2 + 3;
    let mut jpar: i32 = 0;
    for jpy in 3..=nside2 + 3 {
        if jpy == imiddl {
            dpy[ix(jpy, 1)] = dsum;
        } else {
            jpar = jpar + 1;
            dpy[ix(jpy, 1)] = p(jpar);
        }
    }
    let mut dthr: f64 = 0.0;
    for jpy in 1..=nside2 + 5 {
        dsum = 0.0;
        for kpy in 1..=nside2 + 5 {
            dsum = dsum + dpy[ix(kpy, 1)] * g((kpy - jpy).abs());
        }
        dpy[ix(jpy, 2)] = dsum;
        dthr = dthr.max(dsum.abs());
    }
    dthr = dthr * thrlin as f64;
    let mut inflec: i32 = 0;
    let mut delold: f64 = dpy[ix(3, 2)];
    for jpar in 3..=nside2 + 4 {
        let del: f64 = dpy[ix(jpar - 1, 2)] - 2.0 * dpy[ix(jpar, 2)] + dpy[ix(jpar + 1, 2)];
        if del * delold < 0.0 && dpy[ix(jpar, 2)].abs() > dthr {
            inflec = inflec + 1;
        }
        delold = del;
    }
    inflec
}
