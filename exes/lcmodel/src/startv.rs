//! Starting values, setup, phasing and background (STARTV ... check_chless).
//!
//! Translated from LCModel.f 6.3-1N; see PORTING.md.
#![allow(unused_variables, unused_mut, unused_assignments, unused_imports, unreachable_code, unused_labels, clippy::all)]

use crate::control::{icycle_r, ilen};
use crate::format::{self, FVal, RKind, ReadErr};
use crate::fortran::*;
use crate::io::{self, Units, STDOUT};
use crate::numerics::{cfft_r, eigvrs};
use crate::state::*;
use crate::{fv, ErrQueue, Lcm};

/// SAVEd and static locals of this module's subprograms.
#[derive(Clone, Debug)]
pub struct Saves {
    /// STARTV (SAVE).
    degppm_sav_startv: f32,
    degzer_sav_startv: f32,
    ishfst: FArr1<i32>,
    lwidth: FArr1<i32>,
    /// STARTV `REAL CPY2(MDATA)` (static: over 64 KiB).
    cpy2: FArr1<f32>,
    /// PHASTA `COMPLEX DATA_PH1(MY), DATA_ZERO(MDATA)` (static: over 64 KiB).
    data_ph1: FArr1<C32>,
    data_zero: FArr1<C32>,
}

impl Default for Saves {
    fn default() -> Self {
        Saves {
            degppm_sav_startv: 0.,
            degzer_sav_startv: 0.,
            ishfst: FArr1::new(2),
            lwidth: FArr1::new(2),
            cpy2: FArr1::new(MDATA as usize),
            data_ph1: FArr1::new(MY as usize),
            data_zero: FArr1::new(MDATA as usize),
        }
    }
}

/// DIM(X, Y) for REAL: positive difference.
#[inline]
fn dim(x: f32, y: f32) -> f32 {
    if x > y {
        x - y
    } else {
        0.
    }
}

/// X**3 as gfortran expands it.
#[inline]
fn cube(x: f32) -> f32 {
    x * x * x
}

/// X**4 as gfortran expands it: (X*X)*(X*X).
#[inline]
fn pow4(x: f32) -> f32 {
    let t = x * x;
    t * t
}

/// A DOUBLE PRECISION array passed to a REAL dummy: its storage as REALs.
fn f64_as_f32_mut(d: &mut [f64]) -> &mut [f32] {
    // SAFETY: f64 storage reinterpreted as twice as many f32 (same alignment
    // requirements are weaker for f32); the borrow is exclusive.
    unsafe { std::slice::from_raw_parts_mut(d.as_mut_ptr() as *mut f32, d.len() * 2) }
}

impl Lcm {
    /// Crude fast analysis to get starting values for fwhm (FWHMST), DEGZER,
    /// and DEGPPM, and to determine ISHIFD and NSIDES.
    pub fn startv(&mut self, ipass: i32) -> R<()> {
        const CHSUBP: &str = "STARTV";
        let mut intshf: FArr2<i32> = FArr2::new(MSHIFT as usize, 2);
        let mut lrefpk: FArr1<i32> = FArr1::new(MREFPK as usize);
        let mut lshfmn: FArr1<i32> = FArr1::new(3);
        let mut lshfmn_orig: FArr1<i32> = FArr1::new(2);
        let mut lshfmx: FArr1<i32> = FArr1::new(3);
        let mut lshfmx_orig: FArr1<i32> = FArr1::new(2);
        let mut cnvrg1 = false;
        let mut dosub_bas_ccf;
        let mut sdshbs: f64;
        let mut lgrid: i32 = 0;
        let mut lgrdmn: i32 = 0;
        let mut test: f32;
        let mut lshfbs: i32 = 0;
        let mut kshfbs: i32;
        let mut ishfus: i32 = 0;
        let mut ierror: i32 = 0;
        for j in 1..=2 {
            self.s_startv.ishfst[j] = 0;
            self.s_startv.lwidth[j] = 999999;
        }
        let mut lshfbs_fixshf: i32 = 99999;
        'l300: {
            // PPMSHF cannot shift the Analysis Window out of the spectrum: the
            // shift would require spectral data that do not exist.
            if self.c.ppmshf.abs() < 1.0e5 {
                if (self.c.ppmshf <= 0. && -self.c.ppmshf > self.c.ppminc * self.c.ldatst as f32)
                    || (self.c.ppmshf > 0. && self.c.ppmshf > self.c.ppminc * (self.c.ndata - self.c.ldaten) as f32)
                {
                    self.errmes(26, 4, CHSUBP)?;
                } else {
                    lgrid = 1;
                    self.s_startv.ishfst[1] = int(self.c.ppmshf / self.c.ppminc);
                    lshfmn[3] = self.s_startv.ishfst[1];
                    lshfmx[3] = self.s_startv.ishfst[1];
                    lgrdmn = 9999;
                    break 'l300;
                }
            }
            // FIXSHF = T (used for muscle-4) for initial CCF with PPMREF to fix
            // the referencing shift. Prel is only used for initial phasing.
            if self.c.fixshf {
                self.c.rfwhcc = 0.;
                self.c.fwhh2o = 0.;
            }
            if !(self.c.dorefs[1] || self.c.dorefs[2]) {
                self.errmes(1, 4, CHSUBP)?;
            }
            lshfmn[3] = 99999;
            lshfmx[3] = -99999;
            for jrfset in 1..=2 {
                if !self.c.dorefs[jrfset] {
                    continue;
                }
                // Reduce NREFPK(JRFSET) if a PPMREF is out of analysis window.
                let mut krefpk = self.c.nrefpk[jrfset];
                let nref = self.c.nrefpk[jrfset];
                for j in 1..=nref {
                    if j > krefpk || jrfset == 1 {
                        break;
                    }
                    test = self.c.ppmref[(j, jrfset)] + self.c.hzref[(j, jrfset)] / self.c.hzpppm;
                    if self.c.ppmst < test || self.c.ppmend > test {
                        krefpk -= 1;
                        for k in j..=krefpk {
                            self.c.ppmref[(k, jrfset)] = self.c.ppmref[(k + 1, jrfset)];
                            self.c.hzref[(k, jrfset)] = self.c.hzref[(k + 1, jrfset)];
                        }
                    }
                }
                // 108
                self.c.nrefpk[jrfset] = krefpk;
                lshfmn[jrfset] = nint(self.c.shifmn[jrfset] / self.c.ppminc);
                lshfmx[jrfset] = nint(self.c.shifmx[jrfset] / self.c.ppminc);
                lshfmn_orig[jrfset] = nint(self.c.shifmn_orig[jrfset] / self.c.ppminc);
                lshfmx_orig[jrfset] = nint(self.c.shifmx_orig[jrfset] / self.c.ppminc);
                if lshfmn[jrfset] > lshfmx[jrfset] {
                    self.errmes(2, 4, CHSUBP)?;
                }
                // DATAF = (temporarily) Gaussian-smoothed FFT of zero-filled
                // DATAT. DATAF(1+NUNFIL) corresponds to PPMCEN (rearranged).
                let rsd = 2. * self.c.pi * self.c.sdsmoo[jrfset] / (self.c.ppminc * self.c.fndata);
                let nunfil = self.c.nunfil;
                for junfil in 1..=nunfil {
                    let t = rsd * (junfil - 1) as f32;
                    self.c.dataf[junfil] = self.c.datat[junfil] * (-0.5 * (t * t)).exp();
                    self.c.dataf[nunfil + junfil] = cmplx(0., 0.);
                }
                let ndata = self.c.ndata;
                let inp = self.c.dataf.data[..ndata as usize].to_vec();
                cfft_r(&inp, &mut self.c.dataf.data, ndata, &mut self.c.lwfft, &mut self.c.wfftc.data);
                // CPY2 = smoothed power spectrum.
                for jdata in 1..=ndata {
                    let d = self.c.dataf[jdata];
                    self.s_startv.cpy2[jdata] = d.re * d.re + d.im * d.im;
                }
                // ISHFST = starting value (in grid points) for referencing shift:
                // cross-correlation function (CCF) with a sum of unit delta
                // functions at PPMREF(J,JRFSET). A positive shift shifts the data
                // spectrum to the left (larger ppm);
                // (apparent ppm)+SHIFMN < true ppm < (apparent ppm)+SHIFMX.
                // DOSUB_BAS_CCF = T to subtract a rough baseline from the smoothed
                // power spectrum; F if a reference peak is within PPM_WATER_TOL
                // of 4.68. CPY = smoothed power spectrum, baseline subtracted.
                if self.c.nrefpk[jrfset] <= 0 || self.c.nrefpk[jrfset] > MREFPK {
                    self.errmes(3, 4, CHSUBP)?;
                }
                dosub_bas_ccf = true;
                for j in 1..=self.c.nrefpk[jrfset] {
                    lrefpk[j] = nint((self.c.ppmcen - self.c.ppmref[(j, jrfset)] - self.c.hzref[(j, jrfset)] / self.c.hzpppm) / self.c.ppminc)
                        + 1
                        + nunfil;
                    dosub_bas_ccf = dosub_bas_ccf && (self.c.ppmref[(j, jrfset)] - 4.68).abs() > self.c.ppm_water_tol;
                }
                dosub_bas_ccf = dosub_bas_ccf && self.c.rfwhmst_ccf > 0. && self.c.nbas_ccf > 0;
                let lsub_start;
                if dosub_bas_ccf {
                    self.c.rfwhmst_ccf = self.c.rfwhmst_ccf.min(4.);
                    self.c.nbas_ccf = i32::min(self.c.nbas_ccf, 40);
                    lsub_start = i32::max(1, nint(self.c.rfwhmst_ccf * self.c.fwhmst / self.c.ppminc));
                } else {
                    self.c.nbas_ccf = 0;
                    lsub_start = 0;
                }
                for jdata in 1..=ndata {
                    let mut bas_sum: f32 = 0.;
                    for jsub in lsub_start..=lsub_start + self.c.nbas_ccf - 1 {
                        bas_sum = bas_sum
                            + self.s_startv.cpy2[icycle_r(jdata + jsub, ndata)]
                            + self.s_startv.cpy2[icycle_r(jdata - jsub, ndata)];
                    }
                    if dosub_bas_ccf {
                        self.c.cpy[jdata] = (0f32).max(self.s_startv.cpy2[jdata] - bas_sum / (2 * self.c.nbas_ccf) as f32);
                    } else {
                        self.c.cpy[jdata] = self.s_startv.cpy2[jdata];
                    }
                }
                // ISHFST = shift with max. correlation with the NREFPK(JRFSET)
                // reference delta-functions.
                let mut corrmx: f32;
                let mut corrmn: f32;
                'l140: loop {
                    corrmx = -self.c.rrange;
                    corrmn = self.c.rrange;
                    for jshift in lshfmn[jrfset]..=lshfmx[jrfset] {
                        let mut ccf: f32 = 0.;
                        for jrefpk in 1..=self.c.nrefpk[jrfset] {
                            ccf = ccf + self.c.cpy[icycle_r(lrefpk[jrefpk] + jshift, ndata)];
                        }
                        corrmn = corrmn.min(ccf);
                        if ccf >= corrmx {
                            corrmx = ccf;
                            self.s_startv.ishfst[jrfset] = jshift;
                        }
                    }
                    // Only make this test if the original SHIFM* are being used,
                    // not restricted SHIFM* from multi-voxel priors.
                    let ish = self.s_startv.ishfst[jrfset];
                    if (ish == lshfmn[jrfset] || ish == lshfmx[jrfset])
                        && lshfmn[jrfset] == lshfmn_orig[jrfset]
                        && lshfmx[jrfset] == lshfmx_orig[jrfset]
                    {
                        if jrfset == 1 {
                            // An extreme shift SHIFM*(1): the water peak is
                            // probably very distorted or weak.
                            self.errmes(4, 2, CHSUBP)?;
                        } else {
                            if ish == lshfmx[jrfset] {
                                // The extreme shift SHIFMX(2) is being called for.
                                self.errmes(5, 2, CHSUBP)?;
                            } else {
                                if self.c.nrefpk[jrfset] > i32::max(1, self.c.nrf2mn) {
                                    // The CCF has probably been distorted by incomplete
                                    // water suppression. Decrement NREFPK(2) (assumes
                                    // PPMREF(*,2) increasing in ppm).
                                    self.errmes(6, 1, CHSUBP)?;
                                    self.c.nrefpk[2] = self.c.nrefpk[2] - 1;
                                    continue 'l140;
                                } else {
                                    // All but NRF2MN peaks removed, and the extreme
                                    // SHIFMN(2) is still being called for.
                                    self.errmes(7, 2, CHSUBP)?;
                                }
                            }
                        }
                    }
                    break 'l140;
                }
                // FWHMCC = FWHM of CCF peak; sets limits on the shift grid search.
                // CORRMN is subtracted from CCF as a background.
                let halfmx = 0.5 * (corrmx - corrmn);
                let ish = self.s_startv.ishfst[jrfset];
                let a = ish + 1;
                let b = ish + nunfil / 2;
                let mut jshift = fdo_end(a, b, 1);
                let mut hit = false;
                for js in a..=b {
                    let mut ccf = -corrmn;
                    for jrefpk in 1..=self.c.nrefpk[jrfset] {
                        ccf = ccf + self.c.cpy[icycle_r(lrefpk[jrefpk] + js, ndata)];
                    }
                    if ccf <= halfmx {
                        jshift = js;
                        hit = true;
                        break;
                    }
                }
                if !hit {
                    self.errmes(8, 2, CHSUBP)?;
                }
                // 190
                let a = ish - 1;
                let b = ish - nunfil / 2;
                let mut kshift = fdo_end(a, b, -1);
                let mut hit = false;
                for ks in fdo(a, b, -1) {
                    let mut ccf = -corrmn;
                    for jrefpk in 1..=self.c.nrefpk[jrfset] {
                        ccf = ccf + self.c.cpy[icycle_r(lrefpk[jrefpk] + ks, ndata)];
                    }
                    if ccf <= halfmx {
                        kshift = ks;
                        hit = true;
                        break;
                    }
                }
                if !hit {
                    self.errmes(9, 2, CHSUBP)?;
                }
                // 220: 8(ln2)*SDSMOO**2 roughly corrects FWHMCC for the
                // convolution with the Gaussian (an undercorrection).
                let w = self.c.ppminc * (jshift - kshift) as f32;
                let sd = self.c.sdsmoo[jrfset];
                let fwhmcc = (0f32).max(w * w - 8. * self.c.alog2 * (sd * sd)).sqrt();
                // The starting grid will normally not extend beyond RFWHCC*FWHMCC
                // on either side of grid center; only a multimodal water peak
                // can extend this.
                let lcc = nint(self.c.rfwhcc * fwhmcc / self.c.ppminc);
                let mut lh2omn = lcc;
                let mut lh2omx = lcc;
                if self.c.nrefpk[jrfset] == 1 && (self.c.ppmref[(1, jrfset)] - 4.7).abs() < 0.1 {
                    // The residual water peak may be multimodal. Search over the
                    // ppm range FWHH2O (centered at LH2OPK) for power at least
                    // THRESH=HALFMX*2*FH2OMX (FH2OMX=.25: quarter-maximum).
                    // LH2OMN (LH2OMX) = no. of points to the left (right) where
                    // the power spectrum exceeds the threshold.
                    let lh2opk = lrefpk[1] + self.s_startv.ishfst[jrfset];
                    let thresh = halfmx * 2. * self.c.fh2omx + corrmn;
                    for jshift in 1..=nint(0.5 * self.c.fwhh2o / self.c.ppminc) {
                        if self.c.cpy[icycle_r(lh2opk - jshift, ndata)] > thresh {
                            lh2omn = jshift;
                        }
                        if self.c.cpy[icycle_r(lh2opk + jshift, ndata)] > thresh {
                            lh2omx = jshift;
                        }
                    }
                }
                let ish = self.s_startv.ishfst[jrfset];
                lshfmn[3] = i32::min(lshfmn[3], i32::max(lshfmn[jrfset], ish - lh2omn));
                lshfmx[3] = i32::max(lshfmx[3], i32::min(lshfmx[jrfset], ish + lh2omx));
                if self.c.lprint > 0 {
                    self.io.write(self.c.lprint, "(' Peak in CCF at', I4, 5X, 'Range =', 2I5)", &fv![ish, -lh2omn, lh2omx]);
                }
                self.s_startv.lwidth[jrfset] = lh2omx + lh2omn;
            }
            if self.s_startv.lwidth[1] < self.s_startv.lwidth[2] {
                lgrid = 1;
            } else {
                lgrid = 2;
            }
            lgrdmn = i32::max(1, nint(self.c.rfwhst * self.c.fwhmst / self.c.ppminc));
        }
        // 300
        if self.c.fixshf {
            lshfbs_fixshf = lshfmn[3];
            lgrid = 1;
            self.s_startv.ishfst[1] = lshfmn[3];
            lgrdmn = 9999;
        }
        // DATAF = frequency-domain data shifted by ISHFST(LGRID).
        let ish = self.s_startv.ishfst[lgrid];
        self.ftdata(ish)?;
        // Starting estimates for the 0- and 1st-order phase corrections.
        // In the 2nd pass, first restore DEGPPM & DEGZER (zeroed at the end of
        // STARTV and needed in PHASTA to set EXDEGP & EXDEGZ).
        if ipass == 1 {
            self.s_startv.degzer_sav_startv = self.c.degzer;
            self.s_startv.degppm_sav_startv = self.c.degppm;
        } else {
            self.c.degzer = self.s_startv.degzer_sav_startv;
            self.c.degppm = self.s_startv.degppm_sav_startv;
        }
        self.phasta()?;
        // Set up for calls to PLINLS and search for starting values.
        self.c.nsides = 0;
        self.setup(1)?;
        if self.c.nshift >= MSHIFT {
            self.c.nshift = MSHIFT;
            self.errmes(10, 3, CHSUBP)?;
        }
        self.c.ndegz[2] = i32::max(self.c.ndegz[2], 1);
        let ddegz = 360. / self.c.ndegz[2] as f32;
        let ddgppm: f32;
        if self.c.ndgppm[2] <= 1 {
            self.c.ndgppm[2] = 1;
            ddgppm = self.c.dgppmx - self.c.dgppmn;
        } else {
            ddgppm = (self.c.dgppmx - self.c.dgppmn) / (self.c.ndgppm[2] - 1) as f32;
            if ddgppm <= 0. {
                self.errmes(11, 4, CHSUBP)?;
            }
        }
        let dgppst = self.c.degppm;
        // PARBES(*,1) is updated to the best so far in the grid search below.
        // PARBES(*,2) overwrites PARNLN when REPHAS is called, and PARNLN must
        // be properly initialized for PLINLS.
        let (lshist, lrt2st) = (self.c.lshist, self.c.lrt2st);
        self.c.parbes[(lshist, 2)] = self.c.parnln[lshist];
        self.c.parbes[(lrt2st, 2)] = self.c.parnln[lrt2st];
        self.c.sdbest[1] = self.c.drange;
        if self.c.lprint > 0 {
            self.io.write(
                self.c.lprint,
                "(//' Preliminary search for starting phases ', 'and referencing shift with starting shifts ', 'between', I5, ' and', I5, ' and mesh of', I5, ' points')",
                &fv![lshfmn[3], lshfmx[3], lgrdmn],
            );
        }
        cnvrg1 = false;
        // Main loop of the search for starting values; original CY (with no
        // rephasing) is used.
        'l400: {
            let nshift = self.c.nshift;
            for jshift in 1..=nshift {
                sdshbs = self.c.drange;
                kshfbs = self.c.ishifd;
                let ndegz2 = self.c.ndegz[2];
                for jdegz in 1..=ndegz2 {
                    'l328: {
                        test = (self.c.degzer - self.c.exdegz).abs() % 360.;
                        if test.min(360. - test) > 4. * self.c.sddegz && !self.c.fxdegz {
                            break 'l328;
                        }
                        self.c.degppm = dgppst;
                        let ndgppm2 = self.c.ndgppm[2];
                        for jdgppm in 1..=ndgppm2 {
                            'l338: {
                                if (self.c.degppm - self.c.exdegp).abs() > 4. * self.c.sddegp && !self.c.fxdegp {
                                    break 'l338;
                                }
                                if self.c.lprint > 0 {
                                    self.io.write(self.c.lprint, "(////' Starting shift =', I5, ' points')", &fv![self.c.ishifd]);
                                }
                                let (lphast, lshist, lrt2st) = (self.c.lphast, self.c.lshist, self.c.lrt2st);
                                self.c.parnln[lphast] = (self.c.degzer * self.c.radian) as f64;
                                self.c.parnln[lphast + 1] = (self.c.degppm * self.c.radian) as f64;
                                self.c.parnln[lshist] = 0.0;
                                // Peak broadening by multiplying the time-domain data
                                // by exp{-[PARNLN(LRT2ST)*t]**2}, t in s; FWHMST in ppm.
                                if self.c.fwhmst <= 0. {
                                    self.errmes(12, 4, CHSUBP)?;
                                }
                                self.c.parnln[lrt2st] = (self.c.fwhmst / self.c.tofwhm) as f64;
                                self.plinls(1, &mut ierror)?;
                                cnvrg1 = cnvrg1 || ierror == 1;
                                if self.c.stddev < sdshbs {
                                    sdshbs = self.c.stddev;
                                    // Subtraction: ISHIFD shifts the data and
                                    // PARNLN(LSHIST) shifts the model.
                                    let lshist = self.c.lshist;
                                    kshfbs = self.c.ishifd
                                        - nint((self.c.parnln[lshist] as f32) * self.c.deltat * self.c.fndata / (2. * self.c.pi));
                                    if self.c.lprint > 0 {
                                        self.io.write(
                                            self.c.lprint,
                                            "(/' ******** Best data shift for this ', 'starting shift so far = ', I5, ' points =', 1PE10.2, ' ppm')",
                                            &fv![kshfbs, kshfbs as f32 * self.c.ppminc],
                                        );
                                    }
                                    if self.c.stddev < self.c.sdbest[1] {
                                        self.savbes(1)?;
                                        lshfbs = kshfbs;
                                        if self.c.lprint > 0 {
                                            self.io.write(
                                                self.c.lprint,
                                                "(/' ************************ Best data ', 'shift for all starting shifts so far = ', I5, ' points =', 1PE10.2, ' ppm')",
                                                &fv![lshfbs, lshfbs as f32 * self.c.ppminc],
                                            );
                                        }
                                    }
                                }
                            }
                            // 338
                            test = self.c.degppm + ddgppm;
                            if test <= self.c.dgppmx {
                                self.c.degppm = test;
                            } else {
                                // New DEGPPM would exceed DGPPMX. Set it to the
                                // endpoint chosen by how far TEST overshot.
                                if test - self.c.dgppmx <= 0.5 * ddgppm {
                                    self.c.degppm = self.c.dgppmx;
                                } else {
                                    self.c.degppm = self.c.dgppmn;
                                }
                            }
                        }
                    }
                    // 328
                    self.c.degzer = (self.c.degzer + ddegz) % 360.;
                }
                intshf[(jshift, 1)] = i32::min(kshfbs, self.c.ishifd);
                intshf[(jshift, 2)] = i32::max(kshfbs, self.c.ishifd);
                // Use the grid point farthest from the intervals already covered;
                // exit if this max. distance is less than LGRDMN.
                let mut lmax = lgrdmn - 1;
                for l in lshfmn[3]..=lshfmx[3] {
                    let mut lmin = self.c.ndata;
                    for kshift in 1..=jshift {
                        lmin = i32::min(lmin, i32::max(intshf[(kshift, 1)] - l, l - intshf[(kshift, 2)]));
                    }
                    if lmin > lmax {
                        lmax = lmin;
                        ishfus = l;
                    }
                }
                if lmax < lgrdmn {
                    break 'l400;
                }
                self.shiftd(ishfus)?;
            }
            self.errmes(13, 1, CHSUBP)?;
        }
        // 400
        if self.c.sdbest[1] >= self.c.drange {
            self.errmes(14, 4, CHSUBP)?;
        }
        // Load best values into PARNLN.
        self.savbes(2)?;
        if lshfbs != self.c.ishifd {
            self.shiftd(lshfbs)?;
            self.rephas()?;
            // Analysis with the optimal shift to get the best starting values
            // with optimally shifted and rephased data.
            let lshist = self.c.lshist;
            self.c.parnln[lshist] = 0.0;
            if self.c.lprint > 0 {
                self.io.write(self.c.lprint, "(////' Analysis with optimal data shift to get optimal', ' starting values')", &[]);
            }
            self.c.miter[1] = self.c.miter[1] * 2;
            self.plinls(1, &mut ierror)?;
            cnvrg1 = cnvrg1 || ierror == 1;
            if self.c.object >= self.c.drange {
                self.errmes(15, 4, CHSUBP)?;
            }
            self.savbes(1)?;
            self.savbes(2)?;
            let lshist = self.c.lshist;
            lshfbs = lshfbs - nint((self.c.parnln[lshist] as f32) * self.c.deltat * self.c.fndata / (2. * self.c.pi));
        }
        if !cnvrg1 {
            self.errmes(16, 2, CHSUBP)?;
        }
        let lrt2st = self.c.lrt2st;
        self.c.fwhmst = (0f32).max(self.c.tofwhm * (self.c.parbes[(lrt2st, 1)] as f32));
        self.c.fwhmst_full = self.c.fwhmst;
        if !self.c.dofull {
            // ISHIFD=LSHFBS just for final output as "Data shift" (without
            // shifting the data).
            self.c.ishifd = lshfbs;
        } else {
            if self.c.fwhmst > self.c.fwhmmx {
                self.c.fwhmst = self.c.fwhmmx;
                // With IMETHD=3, FWHMMX is set fairly low: the max. starting
                // FWHM of the (e.g., Voigt) power functions. Similarly FWHMST
                // determines SIFWMN when SCAFWH=T.
                if self.c.imethd != 3 && !self.c.scafwh {
                    self.errmes(25, 2, CHSUBP)?;
                }
            }
            let lphast = self.c.lphast;
            if lshfbs != self.c.ishifd {
                self.c.parbes[(lphast, 2)] = self.c.parbes[(lphast, 2)] + self.c.phitot[1] as f64;
                self.c.parbes[(lphast + 1, 2)] = self.c.parbes[(lphast + 1, 2)] + self.c.phitot[2] as f64;
                self.shiftd(lshfbs)?;
            }
            if self.c.fixshf && lshfbs != lshfbs_fixshf {
                lshfbs = lshfbs_fixshf;
                self.c.parbes[(lphast, 2)] = self.c.parbes[(lphast, 2)] + self.c.phitot[1] as f64;
                self.c.parbes[(lphast + 1, 2)] = self.c.parbes[(lphast + 1, 2)] + self.c.phitot[2] as f64;
                self.shiftd(lshfbs)?;
            }
            self.rephas()?;
            self.c.degzer = 0.;
            self.c.degppm = 0.;
            if self.c.scafwh || self.c.imethd == 3 {
                // SCAFWH assumes that there is no lineshape in Final.
                self.c.nsides = 0;
                self.c.nside2 = 0;
                self.c.incsid = 1;
                // FCONC_EXPECT = scale factor to multiply CONC_EXPECT to get
                // ALPHAS in constant range (only used with IMETHD=2).
                self.c.fconc_expect = 0.;
                for jmetab in 1..=self.c.nmetab {
                    self.c.fconc_expect = (self.c.fconc_expect as f64 + self.c.solbes[(jmetab, 2)]) as f32;
                }
                if self.c.imethd == 3 {
                    self.c.fwhmst = self.c.fwhmst.max(self.c.fwhmmn);
                }
            } else {
                // Compute NSIDES and INCSID, after checking their limits.
                if self.c.nsidmx > MSIDES {
                    self.c.nsidmx = MSIDES;
                    self.errmes(17, 3, CHSUBP)?;
                }
                if self.c.nsidmn <= 0 || self.c.nsidmn > self.c.nsidmx {
                    self.errmes(18, 4, CHSUBP)?;
                }
                if self.c.incsmx <= 0 || self.c.incsmx > MINCSD {
                    self.errmes(19, 3, CHSUBP)?;
                    self.c.incsmx = i32::min(MINCSD, i32::max(1, self.c.incsmx));
                }
                self.c.nsides = nint(0.5 * self.c.fwhmst * self.c.rfwhm / self.c.ppminc);
                if self.c.nsides < self.c.nsidmn {
                    self.errmes(20, 1, CHSUBP)?;
                    self.c.nsides = self.c.nsidmn;
                }
                self.c.incsid = (self.c.nsides - 1) / self.c.nsidmx + 1;
                self.c.nsides = nint((self.c.nsides as f32 + 0.001) / self.c.incsid as f32);
                if self.c.incsid > self.c.incsmx {
                    self.c.incsid = self.c.incsmx;
                    self.c.nsides = self.c.nsidmx;
                    if !self.c.nobasi {
                        self.errmes(21, 3, CHSUBP)?;
                    }
                }
                // The data with ppm < PPMCEN run from NUNFIL+1 to NDATA.
                let incdim = i32::min(self.c.ldatst - 1, self.c.ndata - self.c.ldaten - 1) / self.c.nsides;
                if incdim <= 0 {
                    self.errmes(22, 4, CHSUBP)?;
                }
                if self.c.incsid > incdim {
                    self.c.incsid = incdim;
                    self.errmes(23, 3, CHSUBP)?;
                }
                if self.c.incsid > 4 {
                    self.errmes(24, 2, CHSUBP)?;
                } else if self.c.incsid > 1 {
                    self.errmes(24, 1, CHSUBP)?;
                }
            }
            if self.c.lprint > 0 {
                self.io.write(
                    self.c.lprint,
                    "(////' Starting values for final analysis'/ ' Shift =', I5, ' points =', F7.4, ' ppm'/ ' Phi(0) =', F8.1, ' deg'/ ' Phi(1) =', F8.2, ' deg/ppm'/ ' FWHM =', F6.3, ' ppm'/ ' NSIDES =', I3,/ ' INCSID =', I2///)",
                    &fv![
                        lshfbs,
                        lshfbs as f32 * self.c.ppminc,
                        self.c.phitot[1] / self.c.radian,
                        self.c.phitot[2] / self.c.radian,
                        self.c.fwhmst_full,
                        self.c.nsides,
                        self.c.incsid
                    ],
                );
            }
        }
        Ok(())
    }

    /// DATAF = unshifted frequency-domain data (rearranged: DATAF(1+NUNFIL)
    /// corresponds to PPMCEN). CY = data shifted by ISHIFT in the analysis window.
    pub fn ftdata(&mut self, ishift: i32) -> R<()> {
        const CHSUBP: &str = "FTDATA";
        // DATAF = zero-filled time-domain data (temporarily).
        let nunfil = self.c.nunfil;
        for junfil in 1..=nunfil {
            self.c.dataf[junfil] = self.c.datat[junfil];
            self.c.dataf[junfil + nunfil] = cmplx(0., 0.);
        }
        let ndata = self.c.ndata;
        let inp = self.c.dataf.data[..ndata as usize].to_vec();
        cfft_r(&inp, &mut self.c.dataf.data, ndata, &mut self.c.lwfft, &mut self.c.wfftc.data);
        // CY = frequency-domain data in the window to be analyzed.
        self.shiftd(ishift)?;
        // RMSAMP scales the background in GBACKG, so that the Hessian columns
        // are of similar magnitude for PNNLS.
        self.c.rmsamp = 0.;
        for jy in 1..=self.c.ny {
            if !self.c.lcy_skip[jy] {
                let c = self.c.cy[jy];
                self.c.rmsamp = self.c.rmsamp + c.re * c.re + c.im * c.im;
            }
        }
        self.c.rmsamp = (self.c.rmsamp / self.c.nyuse as f32).sqrt();
        if self.c.rmsamp <= 0. {
            self.c.istago = 0;
            self.errmes(1, 4, CHSUBP)?;
        }
        Ok(())
    }

    /// SHIFTD: shift CY ISHIFT points from the original unshifted position.
    /// ISHIFD = ISHIFT = current shift.
    fn shiftd(&mut self, ishift: i32) -> R<()> {
        let mut jdata = self.c.ldatst + ishift;
        let ndata = self.c.ndata;
        for jy in 1..=self.c.ny {
            self.c.cy[jy] = self.c.dataf[icycle_r(jdata, ndata)];
            jdata += 1;
        }
        // ISTAGO = 2 when CY holds frequency-domain data (plottable in EXITPS).
        self.c.istago = 2;
        if self.c.phitot[1] != 0. || self.c.phitot[2] != 0. {
            self.c.phitot[1] = 0.;
            self.c.phitot[2] = 0.;
        }
        self.c.ishifd = ishift;
        Ok(())
    }

    /// Set up variables for calls to PLINLS.
    /// LSTAGE = 1 for initial analyses with restricted model, 2 with full model.
    pub fn setup(&mut self, lstage: i32) -> R<()> {
        const CHSUBP: &str = "SETUP";
        let mut lerror = false;
        let mut ierror: i32 = 0;
        // If SCAFWH=T, use lineshape in Prel so that FWHMST can determine the
        // number of knots in Final (and the FWHM of simulated basis spectra).
        if (self.c.scafwh || self.c.imethd == 3) && lstage == 1 {
            for j in 1..=self.c.nmetab {
                self.c.lshape[j] = true;
            }
        }
        'l200: {
            if self.c.nobase {
                break 'l200;
            }
            // NBACKG gives a knot every FWHMST_full*RBACKG(LSTAGE) ppm.
            if lstage == 1 {
                self.c.fwhmst_full = self.c.fwhmst;
            }
            let test = self.c.dkntmn[self.c.ikntmn].max(self.c.fwhmst_full * self.c.rbackg[lstage]);
            if test <= 0. {
                self.errmes(1, 4, CHSUBP)?;
            }
            let ny = self.c.ny;
            self.c.nbackg = nint((self.c.delppm[1] - self.c.delppm[ny]) / test) + 3;
            // Each gap can introduce 2 extra (external) knots.
            if self.c.nbackg > MBACKG - 2 * self.c.ngap {
                self.errmes(2, 3, CHSUBP)?;
                self.c.nbackg = MBACKG - 2 * self.c.ngap;
            }
            // BACKGR(JY,JBACKG) = background terms; REGB = (temporarily)
            // squared baseline regularizor.
            self.gbackg()?;
            // Eigenvalue decomposition of the squared regularizor (EISPACK, for
            // orthonormal eigenvectors). REGB is only of rank NBACKG-2.
            // CPY = eigenvalues, WFFTC = eigenvectors (temporarily).
            self.c.lwfft = 0;
            {
                let w = f64_as_f32_mut(&mut self.c.damat.data);
                let (fv1, fv2) = w.split_at_mut(2 * MROW as usize);
                eigvrs(MBACKG, self.c.nbackg, &self.c.regb.data, &mut self.c.cpy.data, &mut self.c.wfftc.data, fv1, fv2, &mut ierror);
            }
            if ierror != 0 {
                self.errmes(4, 4, CHSUBP)?;
            }
            // REGB = regularizor = square root of the squared regularizor.
            let nbackg = self.c.nbackg;
            for icol in 1..=nbackg {
                for irow in 1..=nbackg {
                    self.c.regb[(irow, icol)] = 0.;
                }
            }
            for icol in 1..=nbackg {
                let ipoint = (icol - 1) * MBACKG;
                if self.c.cpy[icol] > 0. {
                    let fact = self.c.cpy[icol].sqrt();
                    for jcol in 1..=nbackg {
                        let term = self.c.wfftc[ipoint + jcol] * fact;
                        for irow in 1..=nbackg {
                            self.c.regb[(irow, jcol)] = self.c.regb[(irow, jcol)] + self.c.wfftc[ipoint + irow] * term;
                        }
                    }
                }
            }
            // Scale REGB for normalized B-splines (zero denominator checked in GBACKG).
            let fnorm = pow4((nbackg - 3) as f32 / (self.c.delppm[1] - self.c.delppm[ny]));
            for icol in 1..=nbackg {
                for irow in 1..=nbackg {
                    self.c.regb[(irow, icol)] = self.c.regb[(irow, icol)] * fnorm;
                }
            }
        }
        // 200: initialize arrays for PLINLS; first the linear parameters.
        self.c.nlin = self.c.nmetab + self.c.nbackg;
        if self.c.nlin > MPAR {
            self.errmes(5, 4, CHSUBP)?;
        }
        for jpar in 1..=self.c.nlin {
            self.c.solutn[jpar] = 0.0;
        }
        // Lineshape parameters: PARNLN = normalized Gaussian with fwhm=FWHMST.
        let nsides = self.c.nsides;
        self.c.nside2 = 2 * nsides;
        self.c.nnonl = self.c.nside2;
        if self.c.nnonl > MNONL {
            self.errmes(6, 4, CHSUBP)?;
        }
        let mut rnorm: f32 = 1.;
        let ldelta = self.c.fwhmst < 0.5 * self.c.ppminc;
        let mut rexp = self.c.rrange;
        if !ldelta {
            let t = self.c.incsid as f32 * self.c.ppminc / self.c.fwhmst;
            rexp = -4. * self.c.alog2 * (t * t);
        }
        for jside in 1..=nsides {
            let term: f32;
            if ldelta {
                term = 0.;
            } else {
                let f = jside as f32;
                term = (rexp * (f * f)).exp();
            }
            self.c.parnln[nsides + 1 - jside] = term as f64;
            self.c.parnln[nsides + jside] = term as f64;
            rnorm = rnorm + 2. * term;
        }
        rnorm = 1. / rnorm;
        for jnonl in 1..=self.c.nnonl {
            self.c.parnln[jnonl] = self.c.parnln[jnonl] * rnorm as f64;
            self.c.dparmq[jnonl] = self.c.dfldmq as f64;
        }
        if lstage == 2 && self.c.imethd != 2 {
            // DGAUSS = a 1-sided normalized Gaussian profile, fwhm FWHMBA ppm.
            if self.c.fwhmba <= 0. {
                self.errmes(7, 4, CHSUBP)?;
            }
            let t = self.c.incsid as f32 * self.c.ppminc / self.c.fwhmba;
            rexp = -4. * self.c.alog2 * (t * t);
            rnorm = 1.;
            self.c.dgauss[0] = 1.0;
            for j in 1..=self.c.nside2 + 4 {
                let f = j as f32;
                let term = (rexp * (f * f)).exp();
                self.c.dgauss[j] = term as f64;
                rnorm = rnorm + 2. * term;
            }
            rnorm = 1. / rnorm;
            for j in 0..=self.c.nside2 + 4 {
                self.c.dgauss[j] = self.c.dgauss[j] * rnorm as f64;
            }
        }
        // Phase parameters.
        self.c.lphast = self.c.nnonl + 1;
        self.c.nnonl = self.c.nnonl + 2;
        if self.c.nnonl > MNONL {
            self.errmes(8, 4, CHSUBP)?;
        }
        let nnonl = self.c.nnonl;
        self.c.parnln[nnonl - 1] = (self.c.degzer * self.c.radian) as f64;
        self.c.parnln[nnonl] = (self.c.degppm * self.c.radian) as f64;
        self.c.dparmq[nnonl - 1] = (self.c.ddgzmq[lstage] * self.c.radian) as f64;
        self.c.dparmq[nnonl] = (self.c.ddgpmq[lstage] * self.c.radian) as f64;
        // Shift parameters.
        if lstage == 1 {
            self.c.alphab = 0.0;
            self.c.alphas = 0.0;
            self.c.nexpon = 1;
            // (max. step size)/FSTPMQ = RSHFMQ*(initial estimate of FWHM), in
            // ppm; convert to radians/s.
            let mut dmarq: f32 = self.c.rshfmq * self.c.fwhmst;
            dmarq = dmarq * 2. * self.c.pi * self.c.hzpppm;
            self.c.lshist = self.c.nnonl + 1;
            self.c.nnonl = self.c.nnonl + self.c.nexpon;
            if self.c.nnonl > MNONL {
                self.errmes(11, 4, CHSUBP)?;
            }
            let lshist = self.c.lshist;
            self.c.parnln[lshist] = 0.0;
            self.c.dparmq[lshist] = dmarq as f64;
        } else {
            self.c.alphab = self.c.alpbst as f64;
            if self.c.nsides <= 0 && self.c.alpsst > 0. && self.c.imethd != 2 {
                self.c.alpsst = 0.;
            }
            self.c.alphas = self.c.alpsst as f64;
            if self.c.alphab <= 0.0 || self.c.alphas < 0.0 {
                self.errmes(10, 4, CHSUBP)?;
            }
            self.c.nexpon = self.c.nmetab;
            self.c.lshist = self.c.nnonl + 1;
            self.c.nnonl = self.c.nnonl + self.c.nexpon;
            if self.c.nnonl > MNONL {
                self.errmes(11, 4, CHSUBP)?;
            }
            // (max. step size)/FSTPMQ = RSDSMQ * SDSHIF.
            let mut jmetab = 0;
            for jnonl in self.c.lshist..=self.c.nnonl {
                self.c.parnln[jnonl] = 0.0;
                jmetab += 1;
                self.c.dparmq[jnonl] = (self.c.rsdsmq * self.c.sdshif[jmetab]) as f64;
            }
        }
        // Broadening parameters.
        self.c.lrt2st = self.c.nnonl + 1;
        self.c.nnonl = self.c.nnonl + self.c.nexpon;
        if self.c.nnonl > MNONL {
            self.errmes(12, 4, CHSUBP)?;
        }
        let lrt2st = self.c.lrt2st;
        if self.c.nsides > 0 || self.c.imethd == 2 {
            let mut jmetab = 0;
            for jnonl in lrt2st..=self.c.nnonl {
                jmetab += 1;
                self.c.parnln[jnonl] = self.c.exrt2[jmetab] as f64;
                self.c.dparmq[jnonl] = (self.c.rrt2mq * self.c.exrt2[jmetab]) as f64;
            }
        } else {
            // NSIDES = 0: FWHMST is the initial estimate (input with LSTAGE=1;
            // from the initial analysis with LSTAGE=2).
            if lstage == 1 {
                // Broadening by exp{-[PARNLN(LRT2ST)*t]**2}, t in s, so
                // PARNLN(LRT2ST) in radians/s; FWHMST in ppm.
                if self.c.fwhmst <= 0. {
                    self.errmes(13, 4, CHSUBP)?;
                }
                self.c.parnln[lrt2st] = (self.c.fwhmst / self.c.tofwhm) as f64;
            } else {
                if self.c.imethd == 3 {
                    self.setup3()?;
                } else {
                    // Broadening by exp(-PARNLN*t), t in s, so PARNLN in 1/s.
                    // A Lorentzian has 1/T2 = PI*fwhm; FWHMST in ppm.
                    self.c.parnln[lrt2st] = (self.c.pi * self.c.fwhmst * self.c.hzpppm) as f64;
                }
            }
            self.c.dparmq[lrt2st] = self.c.rrt2mq as f64 * self.c.parnln[lrt2st];
            if self.c.imethd != 3 {
                // (max. step size)/FSTPMQ = RRT2MQ*(initial estimate).
                for jnonl in lrt2st + 1..=self.c.nnonl {
                    self.c.parnln[jnonl] = self.c.parnln[lrt2st];
                    self.c.dparmq[jnonl] = self.c.dparmq[lrt2st];
                }
            }
        }
        for jnonl in self.c.lrt2st..=self.c.nnonl {
            if self.c.parnln[jnonl] <= 0.0 {
                self.errmes(14, 4, CHSUBP)?;
            }
        }
        self.c.npar = self.c.nlin + self.c.nnonl;
        if self.c.npar > MPAR {
            self.errmes(15, 4, CHSUBP)?;
        }
        // NONNEG for JPAR > NLIN (1..NMETAB set in MYBASI, the background in
        // GBACKG). NONNEG for delta(1/T2) is reset in PASTEP.
        for jpar in self.c.nlin + 1..=self.c.npar {
            self.c.nonneg[jpar] = false;
        }
        if self.c.nsides > 0 {
            // 2nd-order regularizor for the lineshape coefficients with zero
            // boundary conditions. Rows start from the center and work outward;
            // the 1st 3 rows are the equality constraint that eliminated the
            // center point, with extra constants (2, -1, -1) on the rhs.
            let nsides = self.c.nsides;
            let ncolrf = self.c.nside2;
            self.c.nregf = self.c.nside2 + 3;
            for irow in 4..=self.c.nregf {
                for icol in 1..=ncolrf {
                    self.c.regf[(irow, icol)] = 0.0;
                }
            }
            for icol in 1..=ncolrf {
                self.c.regf[(1, icol)] = 2.0;
                self.c.regf[(2, icol)] = -1.0;
                self.c.regf[(3, icol)] = -1.0;
            }
            self.c.regf[(1, nsides)] = 3.0;
            self.c.regf[(1, nsides + 1)] = 3.0;
            if nsides >= 2 {
                self.c.regf[(2, nsides - 1)] = 0.0;
            }
            self.c.regf[(2, nsides)] = -3.0;
            self.c.regf[(3, nsides + 1)] = -3.0;
            if nsides >= 2 {
                self.c.regf[(3, nsides + 2)] = 0.0;
            }
            let mut irow = 3;
            for jcentr in 2..=nsides + 1 {
                irow += 1;
                let mut icol = nsides + jcentr;
                self.c.regf[(irow, icol - 1)] = 1.0;
                if jcentr <= nsides {
                    self.c.regf[(irow, icol)] = -2.0;
                }
                if jcentr < nsides {
                    self.c.regf[(irow, icol + 1)] = 1.0;
                }
                irow += 1;
                icol = nsides + 1 - jcentr;
                self.c.regf[(irow, icol + 1)] = 1.0;
                if icol >= 1 {
                    self.c.regf[(irow, icol)] = -2.0;
                }
                if icol > 1 {
                    self.c.regf[(irow, icol - 1)] = 1.0;
                }
            }
        }
        // Initialize SDREF with PMQACT=0 to avoid possible stalling in PLINLS.
        self.c.inisol = true;
        self.c.sdref = self.c.drange;
        self.solve(lstage, false, 0.0, false, &mut lerror)?;
        Ok(())
    }

    /// setup3: IMETHD=3 and LSTAGE=2. Starting values for PARNLN & DPARMQ.
    #[doc(hidden)]
    pub fn setup3(&mut self) -> R<()> {
        const CHSUBP: &str = "SETUP3";
        let mut pstart = [0f32; MMPOWR as usize + 1];
        let start1 = (self.c.pi * self.c.hzpppm * self.c.fwhmst).ln();
        let start2 = 2. * (self.c.fwhmst / self.c.tofwhm).ln();
        let ddtime = self.c.deltat as f64;
        if self.c.mpower > MMPOWR
            || self.c.mpower < 1
            || self.c.fmain_power.min(self.c.fother_power) <= -0.001
            || self.c.fmain_power.max(self.c.fother_power) >= 1.001
        {
            self.errmes(1, 4, CHSUBP)?;
        }
        for jpower in 1..=self.c.mpower {
            if self.c.power[jpower] < 0.999 || self.c.power[jpower] > 2.001 {
                self.errmes(2, 4, CHSUBP)?;
            }
            let mut dtime: f64 = 0.0;
            let p = self.c.power[jpower];
            for jdata in 1..=self.c.ndata {
                self.c.tpower[(jpower, jdata)] = dtime.powf(p);
                dtime = dtime + ddtime;
            }
            // Geometric mean.
            let term = self.c.power[jpower] as f32;
            pstart[jpower as usize] = ((2. - term) * start1 + (term - 1.) * start2).exp();
        }
        let mut ncoeff_power: i32 = 0;
        // NNONL was already incremented by NMETAB in SETUP; set it back and
        // increment it here.
        self.c.nnonl = self.c.lrt2st - 1;
        self.c.lpowen[0] = self.c.nnonl;
        for jmetab in 1..=self.c.nmetab {
            ncoeff_power += 1;
            self.c.nnonl += 1;
            let nnonl = self.c.nnonl;
            // FMAIN_POWER (FOTHER_POWER) = attenuation factor for the starting
            // PARNLN of the 1st (other) broadening terms (typically 0.6, 0.1).
            self.c.parnln[nnonl] = (self.c.fmain_power * pstart[1]) as f64;
            self.c.dparmq[nnonl] = (self.c.rpowmq * pstart[1]) as f64;
            // COEFF_POWER_SD = prior SD of power coefficient (like SDRT2). All
            // prior means are zero, to suppress excessive broadening.
            self.c.coeff_power_sd[(1, jmetab)] = (self.c.fract_power_sd[(1, jmetab)] * pstart[1]) as f64;
            for jpower in 2..=self.c.npower[jmetab] {
                ncoeff_power += 1;
                self.c.nnonl += 1;
                if self.c.nnonl > MNONL || ncoeff_power > MCOEFF_POWER {
                    self.errmes(3, 4, CHSUBP)?;
                }
                let nnonl = self.c.nnonl;
                self.c.parnln[nnonl] = (self.c.fother_power * pstart[jpower as usize]) as f64;
                self.c.dparmq[nnonl] = (self.c.rpowmq * pstart[jpower as usize]) as f64;
                self.c.coeff_power_sd[(jpower, jmetab)] = (self.c.fract_power_sd[(jpower, jmetab)] * pstart[jpower as usize]) as f64;
            }
            self.c.lpowen[jmetab] = self.c.nnonl;
        }
        Ok(())
    }

    /// PHASTA: starting estimates for the 0- and 1st-order phase corrections.
    /// NDGPPM(1) > 1: grid search over NDGPPM(1) DEGPPM in [DGPPMN,DGPPMX] and
    /// NDEGZ(1) DEGZER in [0,180] for the minimum |vertical distance|**IPOWPH
    /// travelled by the real part of the smoothed spectrum. NDGPPM(1) = 1 keeps
    /// DEGPPM; NDGPPM(1) < 1 keeps the input DEGZER and DEGPPM. SDDEGZ < 45
    /// (SDDEGP < 10) keeps the input DEGZER (DEGPPM); SDDEGZ <
    /// min(DDGZMQ)/3 (SDDEGP < min(DDGPMQ)*.4) fixes it throughout.
    fn phasta(&mut self) -> R<()> {
        const CHSUBP: &str = "PHASTA";
        self.c.sddegp = self.c.sddegp.max(0.);
        self.c.sddegz = self.c.sddegz.max(0.);
        // START* = T: DEGZER or DEGPPM used as starting values.
        // FXDEG* = T: fixed at their input values throughout.
        self.c.fxdegz = self.c.sddegz < self.c.ddgzmq[1].min(self.c.ddgzmq[2]) / 3.;
        let startz = self.c.sddegz < 45. || self.c.fxdegz || self.c.ndgppm[1] <= 0;
        if self.c.fxdegz {
            self.c.ndegz[2] = 1;
        }
        self.c.fxdegp = self.c.sddegp < self.c.ddgpmq[1].min(self.c.ddgpmq[2]) * 0.4;
        let startp = self.c.sddegp < 10. || self.c.ndgppm[1] <= 0 || self.c.fxdegp;
        if self.c.fxdegp {
            self.c.ndgppm[2] = 1;
        }
        // DEGZER and DEGPPM are the input expectation values; save them.
        self.c.degzer = self.c.degzer % 360.;
        self.c.exdegz = self.c.degzer;
        self.c.exdegp = self.c.degppm;
        // Put EXDEGP in range of DGPPM*.
        if self.c.exdegp < self.c.dgppmn {
            self.c.exdegp = self.c.dgppmn;
            self.errmes(1, 3, CHSUBP)?;
        } else if self.c.exdegp > self.c.dgppmx {
            self.c.exdegp = self.c.dgppmx;
            self.errmes(1, 3, CHSUBP)?;
        }
        if !startz || !startp {
            // Grid search for starting values for DEGZER and/or DEGPPM.
            if startp {
                self.c.ndgppm[1] = 1;
            }
            let deltpp: f32;
            if self.c.ndgppm[1] > 1 {
                deltpp = (self.c.dgppmx - self.c.dgppmn) / (self.c.ndgppm[1] - 1) as f32;
                self.c.degppm = self.c.dgppmn - deltpp;
            } else {
                deltpp = 0.;
            }
            if startz {
                self.c.ndegz[1] = 1;
            }
            let deltz: f32;
            if self.c.ndegz[1] > 1 {
                deltz = 180. / self.c.ndegz[1] as f32;
            } else {
                deltz = 0.;
            }
            // DATA_ZERO = (temporarily) Gaussian-smoothed FFT of zero-filled
            // DATAT, rearranged; SD of smoothing SDSMOO(3).
            let rsd = 2. * self.c.pi * self.c.sdsmoo[3] / (self.c.ppminc * self.c.fndata);
            let nunfil = self.c.nunfil;
            for junfil in 1..=nunfil {
                let t = rsd * (junfil - 1) as f32;
                self.s_startv.data_zero[junfil] = self.c.datat[junfil] * (-0.5 * (t * t)).exp();
                self.s_startv.data_zero[nunfil + junfil] = cmplx(0., 0.);
            }
            let ndata = self.c.ndata;
            let inp = self.s_startv.data_zero.data[..ndata as usize].to_vec();
            cfft_r(&inp, &mut self.s_startv.data_zero.data, ndata, &mut self.c.lwfft, &mut self.c.wfftc.data);
            // Main loop for phase optimization.
            let mut distmn: f64 = 1.0e300;
            let mut sumbes: f32 = 9.;
            let mut degppm_best: f32 = 999.;
            let mut degzer_best: f32 = 999.;
            for jdgppm in 1..=self.c.ndgppm[1] {
                self.c.degppm = self.c.degppm + deltpp;
                self.c.cterm[1] = cmplx(0., self.c.radian * self.c.delppm[1] * self.c.degppm).exp();
                self.c.cterm[2] = cmplx(0., -self.c.radian * self.c.ppminc * self.c.degppm).exp();
                let mut jy = 0;
                for jdata in self.c.ldatst..=self.c.ldaten {
                    jy += 1;
                    self.s_startv.data_ph1[jy] = self.s_startv.data_zero[jdata] * self.c.cterm[1];
                    self.c.cterm[1] = self.c.cterm[1] * self.c.cterm[2];
                }
                let mut degzer_try = self.c.degzer - deltz;
                for jdegz in 1..=self.c.ndegz[1] {
                    degzer_try = degzer_try + deltz;
                    self.c.cterm[3] = cmplx(0., self.c.radian * degzer_try).exp();
                    let mut dist: f64 = 0.;
                    let mut sum: f32 = 0.;
                    self.c.dterm[1] = (self.s_startv.data_ph1[1] * self.c.cterm[3]).re as f64;
                    for jy in 2..=self.c.ny {
                        self.c.dterm[2] = (self.s_startv.data_ph1[jy] * self.c.cterm[3]).re as f64;
                        if !self.c.lcy_skip[jy] {
                            dist = dist + dpowi((self.c.dterm[2] - self.c.dterm[1]).abs(), self.c.ipowph);
                            sum = sum + self.c.dterm[2] as f32;
                        }
                        self.c.dterm[1] = self.c.dterm[2];
                    }
                    if dist <= distmn {
                        distmn = dist;
                        sumbes = sum;
                        degppm_best = self.c.degppm;
                        degzer_best = degzer_try;
                    }
                }
            }
            if !startp {
                self.c.degppm = degppm_best;
            }
            if !startz {
                self.c.degzer = degzer_best;
            }
            // SUMBES < 0 implies the spectrum is the negative of the properly
            // phased one (can be wrong with a big offset or a huge DEGPPM).
            if self.c.ndegz[1] > 1 && sumbes < 0. {
                self.c.degzer = self.c.degzer - 180.;
            }
        }
        Ok(())
    }

    /// GBACKG: BACKGR(JY,JBACKG) = background terms, a cubic B-spline with
    /// NBACKG equally spaced knots on the (-DELPPM)-axis, scaled by RMSAMP.
    /// Knots 2 and NBACKG-1 correspond to PPMST and PPMEND. Also REGB.
    #[doc(hidden)]
    pub fn gbackg(&mut self) -> R<()> {
        const CHSUBP: &str = "GBACKG";
        let mut ppmmax: FArr1<f32> = FArr1::new(MGAP as usize + 1);
        let mut ppmmin: FArr1<f32> = FArr1::new(MGAP as usize + 1);
        if self.c.nbackg < self.c.nbckmn {
            if MBACKG < self.c.nbckmn {
                self.errmes(2, 4, CHSUBP)?;
            }
            self.c.nbackg = self.c.nbckmn;
        }
        let ny = self.c.ny;
        for jbackg in 1..=MBACKG {
            for jy in 1..=ny {
                self.c.backgr[(jy, jbackg)] = 0.;
            }
            for icol in 1..=MBACKG {
                self.c.regb[(jbackg, icol)] = 0.;
            }
        }
        let delta = (self.c.delppm[1] - self.c.delppm[ny]) / (self.c.nbackg - 3) as f32;
        if delta <= 0. {
            self.errmes(3, 4, CHSUBP)?;
        }
        let region_min = 4. * delta;
        let fnorm = self.c.rmsamp / (6. * pow4(delta));
        // NBACKG is recomputed below. PPMMAX(J) (PPMMIN(J)) = the left/high
        // (right/low) ppm of the Jth background region; NREGION = number of
        // regions with separate baselines (may be reduced).
        let ngap = self.c.ngap;
        for jgap in 1..=ngap {
            ppmmax[jgap + 1] = self.c.ppmgap[(2, jgap)];
            ppmmin[jgap] = self.c.ppmgap[(1, jgap)];
        }
        ppmmax[1] = self.c.delppm[1] + self.c.ppmcen;
        ppmmin[ngap + 1] = self.c.delppm[ny] + self.c.ppmcen;
        let mut nregion = ngap + 1;
        let mut nsep = 0;
        if ngap > 0 {
            // PPMSEP: separate baselines with free boundaries on each side.
            for jsep in 1..=MGAP {
                if self.c.ppmsep[jsep] >= self.c.ppmst - region_min || self.c.ppmsep[jsep] <= self.c.ppmend + region_min {
                    break;
                }
                nsep += 1;
                self.c.ppmsep[nsep] = self.c.ppmsep[jsep];
                if self.c.lprint > 0 {
                    self.io.write(self.c.lprint, "(//'PPMSEP =', f7.3/)", &fv![self.c.ppmsep[nsep]]);
                }
            }
            // 240
            if self.c.ldump[2] {
                self.io.write(STDOUT, "(/'NBACKG =', i3)", &fv![self.c.nbackg]);
                let mut v = Vec::new();
                for k in 1..=ngap {
                    for j in 1..=2 {
                        v.push(FVal::R(self.c.ppmgap[(j, k)]));
                    }
                }
                self.io.write(STDOUT, "('PPMGAP =', 5(2f8.2, 3x))", &v);
                let mut v = Vec::new();
                for j in 1..=nregion {
                    v.push(FVal::R(ppmmax[j]));
                    v.push(FVal::R(ppmmin[j]));
                }
                self.io.write(STDOUT, "('PPMMNX =',  5(2f8.2, 3x))", &v);
                let v: Vec<FVal> = (1..=nsep).map(|j| FVal::R(self.c.ppmsep[j])).collect();
                self.io.write(STDOUT, "('PPMSEP =', 10f8.2)", &v);
            }
        }
        // Merge all baseline regions without PPMSEP between them.
        let nregion_old = nregion;
        for kregion in 1..=nregion_old - 1 {
            'l250: {
                for jregion in 1..=nregion - 1 {
                    'l260: {
                        for jsep in 1..=nsep {
                            if ppmmin[jregion] >= self.c.ppmsep[jsep] && ppmmax[jregion + 1] <= self.c.ppmsep[jsep] {
                                break 'l260;
                            }
                        }
                        let mut q = ErrQueue::new();
                        let r = merge_right(jregion, &mut ppmmin, &mut ppmmax, &mut nregion, &mut q);
                        self.after(q, r)?;
                        break 'l250;
                    }
                }
            }
        }
        // A region too small to support its own baseline (4 knots) is merged
        // with a neighbour (for background only; the gaps remain), over the
        // lowest-priority PPMSEP (highest J). Typical: PPMSEP(1)=4.65 when the
        // feet of the water peak are strong.
        let nregion_old = nregion;
        for kregion in 1..=nregion_old {
            'l280: {
                for jregion in 1..=nregion {
                    let test = ppmmax[jregion] - ppmmin[jregion];
                    if test >= region_min {
                        continue;
                    }
                    // Region JREGION is too small; merge it over the lowest
                    // priority PPMSEP (there is one between all regions now).
                    let mut jsep_right;
                    if jregion >= nregion {
                        jsep_right = 0;
                    } else {
                        jsep_right = fdo_end(1, nsep, 1);
                        for js in 1..=nsep {
                            if ppmmin[jregion] >= self.c.ppmsep[js] && ppmmax[jregion + 1] <= self.c.ppmsep[js] {
                                jsep_right = js;
                                break;
                            }
                        }
                    }
                    let mut jsep_left;
                    if jregion <= 1 {
                        jsep_left = 0;
                    } else {
                        jsep_left = fdo_end(1, nsep, 1);
                        for js in 1..=nsep {
                            if ppmmin[jregion - 1] > self.c.ppmsep[js] && ppmmax[jregion] < self.c.ppmsep[js] {
                                jsep_left = js;
                                break;
                            }
                        }
                    }
                    if jsep_left > jsep_right {
                        let mut q = ErrQueue::new();
                        let r = merge_left(jregion, &mut ppmmin, &mut ppmmax, &mut nregion, &mut q);
                        self.after(q, r)?;
                    } else if jsep_right > 0 {
                        let mut q = ErrQueue::new();
                        let r = merge_right(jregion, &mut ppmmin, &mut ppmmax, &mut nregion, &mut q);
                        self.after(q, r)?;
                    }
                    break 'l280;
                }
            }
        }
        // BACKGR & REGB for each region; REGB is block-diagonal, a block per
        // region. X = -DELPPM = PPMCEN - PPM increases with JBACKG.
        self.c.nbackg = 0;
        let ppmcen = self.c.ppmcen;
        for jregion in 1..=nregion {
            let nbackg_use = i32::max(self.c.nbckmn, 3 + nint((ppmmax[jregion] - ppmmin[jregion]) / delta));
            let nbackg_start = self.c.nbackg + 1;
            let nbackg_end = self.c.nbackg + nbackg_use;
            let delta_use = (ppmmax[jregion] - ppmmin[jregion]) / (nbackg_use - 3) as f32;
            let mut xknot = ppmcen - ppmmax[jregion] - 2. * delta_use;
            'l420: for jbackg in 1..=nbackg_use {
                self.c.nbackg += 1;
                // This should have been avoided with SETUP 2.
                if self.c.nbackg > MBACKG {
                    self.errmes(4, 5, CHSUBP)?;
                }
                let nbackg = self.c.nbackg;
                xknot = xknot + delta_use;
                let xmin = xknot - 2. * delta_use;
                let xmax = xknot + 2. * delta_use;
                let xppm_knot = ppmcen - xknot;
                let jpar = self.c.nmetab + nbackg;
                self.c.nonneg[jpar] = xppm_knot <= self.c.ppmpos[1] && xppm_knot >= self.c.ppmpos[2];
                for jy in 1..=ny {
                    let x = -self.c.delppm[jy];
                    let xppm = self.c.delppm[jy] + ppmcen;
                    // This baseline is exclusively for PPM(JY) in this region.
                    // PPM & knots only coincide exactly at PPMST & PPMEND.
                    if xppm > ppmmax[jregion] + 0.001 * delta_use || xppm < ppmmin[jregion] - 0.001 * delta_use {
                        continue;
                    }
                    if x <= xmin {
                        continue;
                    }
                    if x >= xmax {
                        continue 'l420;
                    }
                    self.c.backgr[(jy, nbackg)] = (cube(dim(x, xmin)) - 4. * cube(dim(x, xmin + delta_use)) + 6. * cube(dim(x, xknot))
                        - 4. * cube(dim(x, xmax - delta_use))
                        + cube(dim(x, xmax)))
                        * fnorm;
                }
            }
            if self.c.ldump[2] {
                self.io.write(STDOUT, "(/'Region =', i2)", &fv![jregion]);
                let mut v = Vec::new();
                for j in 1..=nregion {
                    v.push(FVal::R(ppmmax[j]));
                    v.push(FVal::R(ppmmin[j]));
                }
                self.io.write(STDOUT, "('PPMMNX =',  5(2f8.2, 3x))", &v);
                self.io.write(
                    STDOUT,
                    "('NBACKG_USE =', i3/ 'DELTA_USE =', 1pe11.4/ 'delta ratio =', e11.4)",
                    &fv![nbackg_use, delta_use, delta_use / delta],
                );
            }
            // Regularizor for cubic B-splines with equally spaced knots and no
            // boundary conditions, as full matrices (upper triangle zeroed above).
            for irow in nbackg_start..=nbackg_end {
                self.c.regb[(irow, irow)] = 16.;
                if irow + 1 <= nbackg_end {
                    self.c.regb[(irow, irow + 1)] = -9.;
                }
                if irow + 3 <= nbackg_end {
                    self.c.regb[(irow, irow + 3)] = 1.;
                }
            }
            self.c.regb[(nbackg_start, nbackg_start)] = 2.;
            self.c.regb[(nbackg_end, nbackg_end)] = 2.;
            self.c.regb[(nbackg_start, nbackg_start + 1)] = -3.;
            self.c.regb[(nbackg_end - 1, nbackg_end)] = -3.;
            self.c.regb[(nbackg_start + 1, nbackg_start + 1)] = 8.;
            self.c.regb[(nbackg_end - 1, nbackg_end - 1)] = 8.;
            self.c.regb[(nbackg_start + 1, nbackg_start + 2)] = -6.;
            self.c.regb[(nbackg_end - 2, nbackg_end - 1)] = -6.;
            self.c.regb[(nbackg_start + 2, nbackg_start + 2)] = 14.;
            self.c.regb[(nbackg_end - 2, nbackg_end - 2)] = 14.;
            for irow in nbackg_start..=nbackg_end {
                for icol in irow + 1..=nbackg_end {
                    self.c.regb[(icol, irow)] = self.c.regb[(irow, icol)];
                }
            }
        }
        Ok(())
    }

    /// check_chless: OMIT_CHLESS = T if STARTV is to be repeated with all
    /// CHLESS omitted from Prel: when the summed concentration [SOLBES(*,2)]
    /// of the NACOMB with prefix CHLESS(JLESS) is at least RLESMO times that
    /// with prefix CHMORE (typically CHLESS='L09' 'L20', CHMORE='L13', to
    /// avoid Lip09 replacing Lip13 in Prel). NCHLES > 0 and RLESMO > 0 to allow it.
    pub fn check_chless(&mut self) -> R<()> {
        const CHSUBP: &str = "LESSMO";
        let mut lless: FArr1<i32> = FArr1::new(MMETAB as usize);
        let mut conc_less: FArr1<f32> = FArr1::new(MMETAB as usize);
        self.c.omit_chless = false;
        if self.c.chmore.eq_str(" ") || self.c.rlesmo <= 0. || self.c.nchles <= 0 {
            return Ok(());
        }
        if self.c.nchles > MMETAB {
            self.errmes(1, 4, CHSUBP)?;
        }
        for jless in 1..=self.c.nchles {
            if self.c.chless[jless].eq_str(" ") {
                return Ok(());
            }
            if self.c.chless[jless].eq_f(&self.c.chmore) {
                self.errmes(2, 3, CHSUBP)?;
                return Ok(());
            }
            conc_less[jless] = -1.;
            lless[jless] = ilen(&self.c.chless[jless]);
        }
        let mut conc_more: f32 = -1.;
        let lmore = ilen(&self.c.chmore);
        let mut lnot1 = self.c.nnot1;
        for jmetab in 1..=self.c.nmetab {
            for jless in 1..=self.c.nchles {
                let pre = self.c.chless[jless].sub(1, lless[jless]);
                if self.c.nacomb[jmetab].index_f(&pre) == 1 {
                    conc_less[jless] = (conc_less[jless].max(0.) as f64 + self.c.solbes[(jmetab, 2)]) as f32;
                    lnot1 += 1;
                    if lnot1 > MMETAB_EXTRA {
                        self.errmes(3, 3, CHSUBP)?;
                        return Ok(());
                    }
                    let name = self.c.nacomb[jmetab].clone();
                    self.c.chnot1[lnot1].set_f(&name);
                }
            }
            let pre = self.c.chmore.sub(1, lmore);
            if self.c.nacomb[jmetab].index_f(&pre) == 1 {
                conc_more = (conc_more.max(0.) as f64 + self.c.solbes[(jmetab, 2)]) as f32;
            }
        }
        'l320: {
            for jless in 1..=self.c.nchles {
                if conc_less[jless] > 0. {
                    break 'l320;
                }
            }
            return Ok(());
        }
        // 320
        'l400: {
            for jless in 1..=self.c.nchles {
                if conc_less[jless] >= conc_more * self.c.rlesmo {
                    break 'l400;
                }
            }
            return Ok(());
        }
        // 400
        self.c.omit_chless = true;
        self.errmes(4, 1, CHSUBP)?;
        self.c.nnot1 = lnot1;
        Ok(())
    }
}

/// merge_right: merge region LREGION with LREGION+1 (assumes LREGION < NREGION).
fn merge_right(lregion: i32, ppmmin: &mut FArr1<f32>, ppmmax: &mut FArr1<f32>, nregion: &mut i32, q: &mut ErrQueue) -> R<()> {
    const CHSUBP: &str = "MERGRT";
    if lregion >= *nregion {
        q.errmes(1, 5, CHSUBP)?;
    }
    *nregion -= 1;
    ppmmin[lregion] = ppmmin[lregion + 1];
    for jregion in lregion + 1..=*nregion {
        ppmmax[jregion] = ppmmax[jregion + 1];
        ppmmin[jregion] = ppmmin[jregion + 1];
    }
    Ok(())
}

/// merge_left: merge region LREGION with LREGION-1 (assumes 1 < LREGION).
fn merge_left(lregion: i32, ppmmin: &mut FArr1<f32>, ppmmax: &mut FArr1<f32>, nregion: &mut i32, q: &mut ErrQueue) -> R<()> {
    const CHSUBP: &str = "MERGLF";
    if lregion <= 1 {
        q.errmes(1, 5, CHSUBP)?;
    }
    *nregion -= 1;
    ppmmin[lregion - 1] = ppmmin[lregion];
    for jregion in lregion..=*nregion {
        ppmmax[jregion] = ppmmax[jregion + 1];
        ppmmin[jregion] = ppmmin[jregion + 1];
    }
    Ok(())
}
