//! Basis set input and preparation (MYBASI ... COMBIS).
//!
//! Translated from LCModel.f 6.3-1N; see PORTING.md.
#![allow(unused_variables, unused_mut, unused_assignments, unused_imports, unreachable_code, unused_labels, clippy::all)]

use crate::control::{icycle, ilen, toupper_lower};
use crate::format::{self, FVal, RKind, ReadErr};
use crate::fortran::*;
use crate::io::{self, Namelist, NmlAssign, Units, STDOUT};
use crate::numerics::{cfft, cfft_r, cfftin, csft_r, random};
use crate::state::*;
use crate::tworeg::get_field;
use crate::{fv, ErrQueue, Lcm};

/// SAVEd and static locals of this module's subprograms.
#[derive(Clone, Debug)]
pub struct Saves {
    /// MYBASI: `COMMON BASISF(8*MDATA)` (blank COMMON).
    pub basisf: FArr1<C32>,
    /// MYBASI: `save hzpppm_basis`.
    pub hzpppm_basis: f32,
    /// AREAW2: `COMPLEX H2OT_work(MDATA)` from lcmodel.inc (a static local).
    pub h2ot_work: FArr1<C32>,
}

impl Default for Saves {
    fn default() -> Self {
        Saves { basisf: FArr1::new((8 * MDATA) as usize), hzpppm_basis: 0.0, h2ot_work: FArr1::new(MDATA as usize) }
    }
}

/// The CHRETURN/FRETURN actual argument of a GET_FIELD call in PARSE_CHSIMU.
#[derive(Clone, Copy)]
enum SimField {
    Chsim,
    Sippm(i32),
    Sisdsh,
    Sifwmn(i32),
    Sifwex,
    Sifwsd,
    Siamp(i32),
}

/// A NAMELIST output item.
enum NmlOut<'a> {
    R(f32),
    I(i32),
    S(&'a FStr),
}

/// A REAL as gfortran's NAMELIST output writes it (9 significant digits,
/// F form in a 12-wide field plus 4 blanks, else 1PE16.8E2).
fn nml_real(x: f32) -> String {
    let g = format::fmt_g(x as f64, 16, 9, Some(2), 0, false, true);
    if g.contains('E') || !x.is_finite() {
        format::fmt_e(x as f64, 16, 8, Some(2), 1, false, 'E', true)
    } else {
        g
    }
}

/// Records of `WRITE (u, NML=group)` as gfortran writes them.
fn nml_records(group: &str, items: &[(&str, NmlOut)]) -> Vec<String> {
    let mut recs = vec![format!("&{}", group.to_ascii_uppercase())];
    for (name, v) in items {
        let value = match v {
            NmlOut::R(x) => nml_real(*x),
            NmlOut::I(n) => format!("{:<11}", n),
            NmlOut::S(s) => format!("\"{}\"", s.as_str().replace('"', "\"\"")),
        };
        recs.push(format!(" {}={},", name.to_ascii_uppercase(), value));
    }
    recs.push(" /".to_string());
    recs
}

/// Apply a namelist read in input order; an unknown name is the ERR= branch.
fn nml_apply_all(nml: &Namelist, targets: &mut [(&str, &mut dyn NmlAssign)]) -> Result<(), ()> {
    for it in &nml.items {
        match targets.iter_mut().find(|(n, _)| *n == it.name) {
            Some((_, t)) => t.nml_assign(&it.subs, &it.values).map_err(|_| ())?,
            None => return Err(()),
        }
    }
    Ok(())
}

/// `(SYNUS1(1,JSYN).EQ.A .AND. SYNUS1(2,JSYN).EQ.B) .OR. (SYNUS1(2,JSYN).EQ.A .AND. SYNUS1(1,JSYN).EQ.B)`
fn syn_pair(synus1: &FArr2<FStr>, jsyn: i32, a: &FStr, b: &FStr) -> bool {
    (synus1[(1, jsyn)].eq_f(a) && synus1[(2, jsyn)].eq_f(b)) || (synus1[(2, jsyn)].eq_f(a) && synus1[(1, jsyn)].eq_f(b))
}

fn syn_blank(synus1: &FArr2<FStr>, jsyn: i32) -> bool {
    synus1[(1, jsyn)].is_blank() || synus1[(2, jsyn)].is_blank()
}

impl Lcm {
    /// ERRMES calls at labels 810-832 of MYBASI (each falls through to the next).
    fn mybasi_fail(&mut self, label: i32) -> R<()> {
        const CHSUBP: &str = "MYBASI";
        if label <= 810 {
            self.errmes(28, 4, CHSUBP)?;
        }
        if label <= 820 {
            self.errmes(29, 4, CHSUBP)?;
        }
        if label <= 830 {
            self.errmes(30, 4, CHSUBP)?;
        }
        if label <= 831 {
            self.errmes(31, 4, CHSUBP)?;
        }
        self.errmes(32, 4, CHSUBP)?;
        Ok(())
    }

    /// AREABA on the blank-COMMON BASISF.
    fn areaba_basisf(&mut self, ppminc_arg: f32, nunfil_arg: i32) -> R<f32> {
        let mut bf = std::mem::take(&mut self.s_basis.basisf);
        let r = self.areaba(&mut bf.data, ppminc_arg, nunfil_arg);
        self.s_basis.basisf = bf;
        r
    }

    /// Read the basis set (or simulate it) and put the time-domain basis
    /// vectors into BASIST(JDATA,JMETAB), scaled to unit concentrations.
    /// LSTAGE = 1 for the Preliminary Analysis, 2 for the full model.
    pub fn mybasi(&mut self, lstage: i32) -> R<()> {
        const CHSUBP: &str = "MYBASI";
        const MCHIDB: i32 = 80;
        let mut file_basout = FStr::blank(262);
        let mut fmtbas = FStr::blank(MCHFMT as usize);
        let mut id = FStr::blank(MCHID as usize);
        let mut idbasi = FStr::blank(MCHIDB as usize);
        let mut metabo = FStr::blank(MCHMET as usize);
        let mut seq = FStr::blank(5);
        let mut offset_end = C32::ZERO;
        let mut offset_start = C32::ZERO;
        let mut dix: f64 = 0.0;
        let mut corr_areaba = false;
        let mut dows_now = false;
        let mut encryp = false;
        let mut ppmmet_in_gap = [false; 2];
        let mut us1ful: FArr1<bool> = FArr1::new(MMETAB_EXTRA as usize);
        let mut badelt: f32 = 0.0;
        let mut ndatab: i32 = 0;
        let mut conc: f32 = 0.0;
        let mut tramp: f32 = 0.0;
        let mut volume: f32 = 0.0;
        let mut ishift: i32 = 0;
        let mut ndata_freq: i32 = 0;
        let mut rt2_scale: f32;
        let mut term: f32 = 0.0;

        if lstage == 1 {
            // Abort if no license and no test data; FNDATA = 0. (from DATAIN) causes abort.
            if self.c.ppminc.min(self.c.fndata).min(self.c.tofwhm) <= 0.0 || self.c.ldatst > self.c.ldaten || self.c.lwfft < 0 {
                self.errmes(self.c.lett.max(1), 4, "DEMO  ")?;
            }
            // LETT > 0 at this stage is only possible with linux with Test Data.
            if self.c.lett > 0 {
                self.errmes(self.c.lett, 1, "DEMO  ")?;
            }
        }
        if (self.c.scafwh || self.c.imethd == 3) && (!self.c.nobasi || self.c.badref) {
            self.errmes(40, 5, CHSUBP)?;
        }
        // RT2_SCALE: SDRT2 & EXRT2 are scaled by sqrt(HZPPPM / HZPPPM_RT2_REF),
        // assuming 1/T2 roughly proportional to sqrt(HZPPPM); input SDRT2
        // pertains to 2T.
        rt2_scale = (self.c.hzpppm / 85.16).sqrt();
        if lstage == 1 {
            for juse1 in 1..=self.c.nuse1 {
                us1ful[juse1] = false;
            }
        }
        // NONNEG must be later reset for all JPAR>NMETAB and Taylor terms;
        // LSHAPE when convolution with Lineshape is suppressed.
        for jmetab in 1..=MMETAB {
            self.c.nonneg[jmetab] = true;
            self.c.lshape[jmetab] = true;
        }
        self.c.nmetab = 0;
        if self.c.lprint > 0 {
            if lstage == 1 {
                self.io.write(self.c.lprint, "(/////20X, 'Basis Spectra used for the ', 'Preliminary Analysis')", &[]);
            } else {
                self.io.write(self.c.lprint, "(/////20X, 'Basis Spectra used for the ', 'Final Analysis')", &[]);
            }
        }
        'l300: {
            // NOBASI=T to skip BASIS file and only use simulated spectra.
            if self.c.nobasi {
                if self.c.bascal || self.c.ncalib > 0 || self.c.nsimul <= 0 {
                    self.errmes(27, 4, CHSUBP)?;
                }
                self.c.scasim = false;
                // Set DESDSH if not input positive (PPMINC, not PPMINC_BASIS, here).
                if self.c.desdsh <= 0.0 {
                    if self.c.rincsh <= 0.0 || self.c.sdshmn <= 0.0 || self.c.sdshmx < self.c.sdshmn {
                        self.errmes(26, 4, CHSUBP)?;
                    }
                    self.c.desdsh = self.c.sdshmx.min(self.c.sdshmn.max(self.c.rincsh * self.c.ppminc));
                }
                if self.c.lprint > 0 {
                    self.io.write(
                        self.c.lprint,
                        "(/' No.   Metabolite',3X, 'Expec[delta(1/T2)](1/s)', 3X, 'SDdelta(1/T2)]', 3X, 'Shift(Pts)', 3X, 'SD[Shift](ppm)   ID')",
                        &[],
                    );
                }
                break 'l300;
            }
            // BASISF(JDATA) = unshifted, unscaled frequency-domain basis vector.
            if self.c.lbasis <= 0 || self.c.filbas.is_blank() {
                self.errmes(33, 4, CHSUBP)?;
            }
            if !self.c.filbas.is_blank() {
                let name = self.c.filbas.trim();
                if !self.io.open_old(self.c.lbasis, &name) {
                    return self.mybasi_fail(810);
                }
            }
            // BASCAL=T for analyzing the CHBCAL basis spectrum as the data.
            self.c.bascal = self.c.bascal && lstage == 1;
            if self.c.bascal {
                if self.c.ncalib <= 0 || self.c.chbcal.is_blank() {
                    self.errmes(12, 4, CHSUBP)?;
                }
                for jcalib in 1..=self.c.ncalib {
                    if self.c.chbcal.eq_f(&self.c.chcali[jcalib]) {
                        self.errmes(13, 4, CHSUBP)?;
                    }
                }
            }
            if lstage == 1 && !self.c.bascal {
                let hzpppm_sav = self.c.hzpppm;
                self.c.hzpppm = -1.0;
                seq.set(" ");
                self.c.echot = -1.0;
                let fwhmba_sav = self.c.fwhmba;
                self.c.fwhmba = -1.0;
                let ok = match self.io.read_nml(self.c.lbasis, "SEQPAR") {
                    Ok(nml) => {
                        let c = &mut self.c;
                        nml_apply_all(&nml, &mut [("fwhmba", &mut c.fwhmba), ("hzpppm", &mut c.hzpppm), ("echot", &mut c.echot), ("seq", &mut seq)]).is_ok()
                    }
                    Err(_) => false,
                };
                if !ok {
                    // 110
                    self.io.rewind(self.c.lbasis);
                }
                // 120
                self.s_basis.hzpppm_basis = self.c.hzpppm;
                self.c.hzpppm = hzpppm_sav;
                if self.c.echot.min(self.c.echot_raw) > 0.0 {
                    let test = (self.c.echot - self.c.echot_raw).abs();
                    if test >= 3.001 {
                        self.errmes(10, 3, CHSUBP)?;
                    }
                }
                if self.c.echot <= self.c.temm
                    && self.c.ppmend > 0.6
                    && (self.c.sptype.sub(1, 1).eq_str(" ") || self.c.sptype.sub(1, 5).eq_str("tumor") || self.c.sptype.sub(1, 6).eq_str("nulled"))
                {
                    // Modify PPMMET so that MMs are also included, even though
                    // MM09 is excluded (MM20 matters for NAA, NAAG, Glx).
                    // Must be coordinated with BLOCK DATA.
                    self.errmes(41, 2, CHSUBP)?;
                    // MM12 @ 1.21; FWHM=.2
                    self.c.ppmmet[(2, 45)] = 1.21;
                    self.c.ppmmet[(3, 45)] = 1.21;
                    self.c.ppmmet[(4, 45)] = 1.01;
                    // MM14 @ 1.43; FWHM=.2
                    self.c.ppmmet[(2, 46)] = 1.43;
                    self.c.ppmmet[(3, 46)] = 1.43;
                    self.c.ppmmet[(4, 46)] = 1.23;
                    // MM17 @ 1.67; FWHM=.17
                    self.c.ppmmet[(2, 47)] = 1.67;
                    self.c.ppmmet[(3, 47)] = 1.67;
                    self.c.ppmmet[(4, 47)] = 1.50;
                    // MM20 @ 2.08 & 2.25 & 1.95; FWHM=.18
                    self.c.ppmmet[(3, 48)] = 2.43;
                    self.c.ppmmet[(4, 48)] = 1.81;
                }
                toupper_lower(true, &mut seq);
                toupper_lower(true, &mut self.c.seq_raw);
                if (seq.eq_str("PRESS") && self.c.seq_raw.eq_str("STEAM")) || (seq.eq_str("STEAM") && self.c.seq_raw.eq_str("PRESS")) {
                    self.errmes(11, 3, CHSUBP)?;
                }
                if self.c.fwhmba_in_control || self.c.fwhmba <= 0.0 {
                    self.c.fwhmba = fwhmba_sav;
                }
                // For Lorentzians FWHM_absv/FWHM_real = sqrt(3); use 2.0 to give
                // more freedom to the lineshape when ABSVAL=T.
                if !self.c.fwhmba_in_control && self.c.absval {
                    self.c.fwhmba = 2.0 * self.c.fwhmba;
                }
            }
            let ok = match self.io.read_nml(self.c.lbasis, "BASIS1") {
                Ok(nml) => nml_apply_all(&nml, &mut [("idbasi", &mut idbasi), ("fmtbas", &mut fmtbas), ("badelt", &mut badelt), ("ndatab", &mut ndatab)]).is_ok(),
                Err(_) => false,
            };
            if !ok {
                return self.mybasi_fail(820);
            }
            if self.c.lprint > 0 {
                self.io.write(
                    self.c.lprint,
                    "(/' Basis set ID = ',A//' No.   Metabolite',3X, 'Expec[delta(1/T2)](1/s)', 3X, 'SD[delta(1/T2)]', 3X, 'Shift(Pts)', 3X, 'SD[Shift](ppm)   ID')",
                    &fv![&idbasi],
                );
            }
            // ENCRYP = T to decrypt basis spectra.
            encryp = badelt < 0.0;
            badelt = badelt.abs();
            if self.c.deltat.min(badelt) <= 0.0 || self.c.ndata.min(ndatab) <= 0 || ndatab > MDATA {
                self.errmes(1, 4, CHSUBP)?;
            }
            // Compare bandwidths.  IERROR_BW = 0 if equal; 1 if BASIS_BW must be
            // converted to DATA_BW; 2 if BASIS_BW < DATA_BW and 90% of it is
            // needed for the Analysis Window; 4 if BASIS_BW < range needed by PPMEND.
            let hzpppm_basis = self.s_basis.hzpppm_basis;
            let ppminc_basis = if hzpppm_basis > 0.0 {
                1.0 / (badelt * ndatab as f32 * hzpppm_basis)
            } else {
                1.0 / (badelt * ndatab as f32 * self.c.hzpppm)
            };
            // Set DESDSH if it has not been input positive.
            if self.c.desdsh <= 0.0 {
                if self.c.rincsh <= 0.0 || self.c.sdshmn <= 0.0 || self.c.sdshmx < self.c.sdshmn {
                    self.errmes(26, 4, CHSUBP)?;
                }
                self.c.desdsh = self.c.sdshmx.min(self.c.sdshmn.max(self.c.rincsh * ppminc_basis));
            }
            let mut ierror_bw = 0;
            if (1.0 - self.c.deltat / badelt).abs() > 1.0e-4 && !self.c.bascal {
                if badelt > self.c.deltat {
                    let daten = (self.c.ppmcen - self.c.ppmend) / ppminc_basis + 1.0;
                    if daten > 0.45 * ndatab as f32 {
                        ierror_bw = 2;
                        if nint(daten) >= ndatab / 2 {
                            ierror_bw = 4;
                        }
                        if lstage == 1 && ierror_bw >= 2 {
                            self.errmes(2, ierror_bw, CHSUBP)?;
                        }
                    }
                }
            }
            corr_areaba = false;
            'l210: for _jmetab in 1..=999 {
                // TRAMP and VOLUME are the transmitter amplitude and VOI used for
                // absolute scaling; TRAMP=VOLUME=1. normalizes only to unit CONC.
                let r = self.io.read_nml(self.c.lbasis, "BASIS");
                match r {
                    Err(ReadErr::End) => break 'l210,
                    Err(ReadErr::Bad(_)) => return self.mybasi_fail(830),
                    Ok(nml) => {
                        let ok = nml_apply_all(
                            &nml,
                            &mut [("id", &mut id), ("metabo", &mut metabo), ("conc", &mut conc), ("tramp", &mut tramp), ("volume", &mut volume), ("ishift", &mut ishift)],
                        )
                        .is_ok();
                        if !ok {
                            return self.mybasi_fail(830);
                        }
                    }
                }
                if metabo.eq_str("GSH") && self.c.gshgua && self.c.nomit < MPMET {
                    self.c.nomit += 1;
                    let n = self.c.nomit;
                    self.c.chomit[n].set("Gua");
                }
                // Omit this spectrum according to CHCALI, CHKEEP, PPMMET, CHUSE1,
                // SYNUS1 or CHOMIT.
                let mut goto245 = false;
                'l219: {
                    'l216: {
                        if self.c.ncalib > 0 {
                            for j in 1..=self.c.ncalib {
                                if self.c.chcali[j].eq_f(&metabo) {
                                    break 'l216;
                                }
                            }
                            if self.c.bascal && self.c.chbcal.eq_f(&metabo) {
                                self.c.nmetab += 1;
                                goto245 = true;
                                break 'l219;
                            }
                            continue 'l210;
                        }
                        for jomit in 1..=self.c.nomit {
                            if self.c.chomit[jomit].eq_f(&metabo) {
                                continue 'l210;
                            }
                        }
                        for j in 1..=self.c.nkeep {
                            if self.c.chkeep[j].eq_f(&metabo) {
                                break 'l216;
                            }
                        }
                        for j in 1..=MPMET {
                            if self.c.chpmet[j].eq_f(&metabo) {
                                let c = &self.c;
                                if (c.ppmmet[(1, j)] > c.ppmst || c.ppmmet[(2, j)] < c.ppmend) && (c.ppmmet[(3, j)] > c.ppmst || c.ppmmet[(4, j)] < c.ppmend) {
                                    continue 'l210;
                                }
                                ppmmet_in_gap[0] = false;
                                ppmmet_in_gap[1] = false;
                                for jgap in 1..=c.ngap {
                                    ppmmet_in_gap[0] = ppmmet_in_gap[0]
                                        || (c.ppmmet[(1, j)] <= c.ppmgap[(1, jgap)] && c.ppmmet[(1, j)] >= c.ppmgap[(2, jgap)])
                                        || (c.ppmmet[(2, j)] <= c.ppmgap[(1, jgap)] && c.ppmmet[(2, j)] >= c.ppmgap[(2, jgap)]);
                                    ppmmet_in_gap[1] = ppmmet_in_gap[1]
                                        || (c.ppmmet[(3, j)] <= c.ppmgap[(1, jgap)] && c.ppmmet[(3, j)] >= c.ppmgap[(2, jgap)])
                                        || (c.ppmmet[(4, j)] <= c.ppmgap[(1, jgap)] && c.ppmmet[(4, j)] >= c.ppmgap[(2, jgap)]);
                                }
                                if ppmmet_in_gap[0] && ppmmet_in_gap[1] {
                                    continue 'l210;
                                }
                            }
                        }
                    }
                    // 216
                    if lstage == 1 {
                        'l217: for juse1 in 1..=self.c.nuse1 {
                            if us1ful[juse1] {
                                continue 'l217;
                            }
                            if self.c.chuse1[juse1].eq_f(&metabo) {
                                us1ful[juse1] = true;
                                break 'l219;
                            }
                            for jsyn in 1..=MPMET {
                                if syn_blank(&self.c.synus1, jsyn) {
                                    continue 'l217;
                                }
                                if syn_pair(&self.c.synus1, jsyn, &self.c.chuse1[juse1], &metabo) {
                                    us1ful[juse1] = true;
                                    break 'l219;
                                }
                            }
                        }
                        for j in 1..=self.c.nnot1 {
                            if self.c.chnot1[j].eq_f(&metabo) {
                                continue 'l210;
                            }
                        }
                        // BADREF = T includes every remaining metabolite in the
                        // Preliminary Analysis, with CHNOLS (no lineshape).
                        if self.c.badref && self.c.nnolsh < MMETAB_EXTRA {
                            // Never let a SYNUS1 of another METABO in.
                            'l2184: for kmetab in 1..=self.c.nmetab {
                                for jsyn in 1..=MPMET {
                                    if syn_blank(&self.c.synus1, jsyn) {
                                        continue 'l2184;
                                    }
                                    if syn_pair(&self.c.synus1, jsyn, &self.c.nacomb[kmetab], &metabo) {
                                        continue 'l210;
                                    }
                                }
                            }
                            self.c.nnolsh += 1;
                            let n = self.c.nnolsh;
                            self.c.chnols[n].set_f(&metabo);
                            break 'l219;
                        }
                        continue 'l210;
                    } else {
                        for j in 1..=self.c.nnot2 {
                            if self.c.chnot2[j].eq_f(&metabo) {
                                continue 'l210;
                            }
                        }
                    }
                }
                if !goto245 {
                    // 219
                    if self.c.nmetab >= MMETAB {
                        self.errmes(5, 4, CHSUBP)?;
                    }
                    self.c.nmetab += 1;
                    let nm = self.c.nmetab;
                    self.c.nacomb[nm].set_f(&metabo);
                    self.c.table_top[nm] = true;
                    'l232: {
                        for j in 1..=self.c.nsdsh {
                            if self.c.chsdsh[j].eq_f(&metabo) {
                                self.c.sdshif[nm] = self.c.alsdsh[j];
                                break 'l232;
                            }
                        }
                        self.c.sdshif[nm] = self.c.desdsh;
                    }
                    'l236: {
                        for j in 1..=self.c.nsdt2 {
                            if self.c.chsdt2[j].eq_f(&metabo) {
                                self.c.sdrt2[nm] = self.c.alsdt2[j];
                                break 'l236;
                            }
                        }
                        self.c.sdrt2[nm] = self.c.desdt2;
                    }
                    'l240: {
                        for j in 1..=self.c.next2 {
                            if self.c.chext2[j].eq_f(&metabo) {
                                self.c.exrt2[nm] = self.c.alext2[j];
                                break 'l240;
                            }
                        }
                        self.c.exrt2[nm] = self.c.deext2;
                    }
                    self.c.exrt2[nm] = self.c.exrt2[nm] * rt2_scale;
                    self.c.sdrt2[nm] = self.c.sdrt2[nm] * rt2_scale;
                    if self.c.lprint > 0 {
                        if lstage == 1 {
                            self.io.write(self.c.lprint, "(1X, I3, 7X, A6, I57, 20X, A20)", &fv![nm, &metabo, ishift, &id]);
                        } else {
                            let c = &self.c;
                            let v = fv![nm, &metabo, c.exrt2[nm], c.sdrt2[nm], ishift, c.sdshif[nm], &id];
                            self.io.write(self.c.lprint, "(1X, I3, 7X, A6, 1PE26.4, E18.4, I13, E17.2, 3X, A20)", &v);
                        }
                    }
                    // Convert SDSHIF from ppm to radians/s.
                    self.c.sdshif[nm] = self.c.sdshif[nm] * 2.0 * self.c.pi * self.c.hzpppm;
                    // NCOMPO(JCONC) = no. of metabolites for concentration JCONC
                    // (1 except for combinations); LCOMPO(J,JCONC) their subscripts.
                    self.c.ncompo[nm] = 1;
                    self.c.lcompo[(1, nm)] = nm;
                }
                // 245: BASISF is multiplied by SCALE=TRAMP/(VOLUME*CONC), not
                // rearranged and not shifted; dividing by CONC puts the solution
                // in concentration units.  A positive ISHIFT shifts the spectrum
                // ISHIFT points to the left (larger ppm).
                let kinds = vec![RKind::C; ndatab.max(0) as usize];
                match self.io.read(self.c.lbasis, &fmtbas.as_str(), &kinds) {
                    Ok(vals) => {
                        for (k, v) in vals.into_iter().enumerate() {
                            if let FVal::C(z) = v {
                                self.s_basis.basisf[k as i32 + 1] = z;
                            }
                        }
                    }
                    Err(_) => return self.mybasi_fail(831),
                }
                let nm = self.c.nmetab;
                if encryp {
                    dix = 1499.0;
                    for j in 1..=ndatab {
                        let f = (-20.0 * random(&mut dix) + 10.0).exp();
                        self.s_basis.basisf[j] = -self.s_basis.basisf[j] * f;
                    }
                }
                if tramp.min(volume).min(conc) <= 0.0 {
                    self.errmes(6, 4, CHSUBP)?;
                }
                let scale = tramp / (volume * conc);
                // Temporarily put the scaled, unshifted frequency-domain data into BASIST(*,NMETAB).
                for j in 1..=ndatab {
                    self.c.basist[(j, nm)] = self.s_basis.basisf[j] * scale;
                }
                // Absolute value of basis spectra; must be done here with full
                // zero-filling.  2*CABS compensates for discarding the 2nd half;
                // the 1st time point is halved to remove the offset (Notes 010819).
                if self.c.absval {
                    for j in 1..=ndatab {
                        self.s_basis.basisf[j] = cmplx(2.0 * self.c.basist[(j, nm)].abs(), 0.0);
                    }
                    cfftin(&self.s_basis.basisf.data, self.c.basist.tail_mut((1, nm)), ndatab, &mut self.c.lwfft, &mut self.c.wfftc.data);
                    self.c.basist[(1, nm)] = 0.5 * self.c.basist[(1, nm)];
                    for j in (1 + ndatab / 2)..=ndatab {
                        self.c.basist[(j, nm)] = C32::ZERO;
                    }
                    let inp: Vec<C32> = self.c.basist.tail((1, nm))[..ndatab as usize].to_vec();
                    cfft(&inp, self.c.basist.tail_mut((1, nm)), ndatab, &mut self.c.lwfft, &mut self.c.wfftc.data);
                }
                // Put shifted frequency-domain data into BASISF.
                let mut jshift = ishift + nint((4.65 - self.c.ppmcen) / ppminc_basis);
                for j in 1..=ndatab {
                    jshift += 1;
                    self.s_basis.basisf[j] = self.c.basist[(icycle(jshift, ndatab), nm)];
                }
                // AREABA_ORIG_BASISF = T normally; AREABA of the transformed BASISF
                // can be inaccurate (Notes 120929).
                'l269: {
                    if !self.c.areaba_orig_basisf {
                        break 'l269;
                    }
                    let c = &self.c;
                    dows_now = c.dows && lstage == 2 && c.havh2o && !c.bascal && c.fcalib > 0.999999 && c.fcalib < 1.000001;
                    if !(dows_now || (c.scasim && c.nsimul > 0)) {
                        break 'l269;
                    }
                    'l264: {
                        if !self.c.wsmet.eq_f(&metabo) {
                            for jsyn in 1..=MPMET {
                                if syn_blank(&self.c.synus1, jsyn) {
                                    break 'l269;
                                }
                                if syn_pair(&self.c.synus1, jsyn, &self.c.wsmet, &metabo) {
                                    break 'l264;
                                }
                            }
                        }
                    }
                    // 264
                    self.c.area_met_norm = self.areaba_basisf(ppminc_basis, ndatab / 2)?;
                    corr_areaba = true;
                }
                // 269: check (and correct for) inconsistent BWs or field strengths.
                if self.c.bascal {
                    ndata_freq = ndatab;
                } else {
                    // NDATA_FREQ is chosen so that bw_basis_new = bw_data, also
                    // compensating HZPPPM vs HZPPPM_BASIS: (1) truncate/zero-fill
                    // BASISF to NDATA_FREQ = NDATAB*BADELT*HZPPPM_BASIS/(DELTAT*HZPPPM)
                    // points; (2) zero-fill/truncate BASIST to NDATA.
                    let rndata_freq;
                    if hzpppm_basis > 0.0 {
                        rndata_freq = ndatab as f32 * badelt * hzpppm_basis / (self.c.deltat * self.c.hzpppm);
                        if lstage == 1 && self.c.nmetab == 1 {
                            // Consistency of field strengths (warning threshold .05).
                            let test = (hzpppm_basis / self.c.hzpppm - 1.0).abs();
                            if test >= 0.2 {
                                self.errmes(9, 4, CHSUBP)?;
                            } else if test >= 0.05 {
                                self.errmes(9, 2, CHSUBP)?;
                            }
                        }
                    } else {
                        rndata_freq = ndatab as f32 * badelt / self.c.deltat;
                    }
                    // NDATA_FREQ must be even.
                    ndata_freq = 2 * nint(0.5 * rndata_freq);
                    // Leave NDATA_FREQ=NDATA if their ratio is within BWTOLR.
                    if (1.0 - rndata_freq / self.c.ndata as f32).abs() <= self.c.bwtolr {
                        ndata_freq = self.c.ndata;
                    }
                    if ndata_freq > MDATA {
                        self.errmes(35, 4, CHSUBP)?;
                    }
                    // FFTs must be multiplied by sqrt(ndata_freq/ndata) (Notes 120929).
                    if corr_areaba {
                        self.c.area_met_norm = self.c.area_met_norm * (ndata_freq as f32 / self.c.ndata as f32).sqrt();
                        corr_areaba = false;
                    }
                    if ndata_freq != ndatab {
                        // Step (1): change bw_basis to bw_data, temporarily in BASIST.
                        if ndata_freq > ndatab {
                            for j in 1..=ndata_freq {
                                self.c.basist[(j, nm)] = C32::ZERO;
                            }
                        }
                        // 1st into 1st half
                        let nhalf = ndata_freq.min(ndatab) / 2;
                        for j in 1..=nhalf {
                            self.c.basist[(j, nm)] = self.s_basis.basisf[j];
                        }
                        // Now into 2nd half
                        let mut jin = ndatab;
                        for jout in fdo(ndata_freq, ndata_freq - nhalf + 1, -1) {
                            self.c.basist[(jout, nm)] = self.s_basis.basisf[jin];
                            jin -= 1;
                        }
                        // Now everything back into BASISF
                        for j in 1..=ndata_freq {
                            self.s_basis.basisf[j] = self.c.basist[(j, nm)];
                        }
                    }
                }
                // Inverse FFT of BASISF into BASIST(*,NMETAB).
                if self.c.bascal && self.c.chbcal.eq_f(&metabo) {
                    cfftin(&self.s_basis.basisf.data, &mut self.c.datat.data, ndata_freq, &mut self.c.lwfft, &mut self.c.wfftc.data);
                    self.c.nmetab -= 1;
                    continue 'l210;
                } else {
                    cfftin(&self.s_basis.basisf.data, self.c.basist.tail_mut((1, nm)), ndata_freq, &mut self.c.lwfft, &mut self.c.wfftc.data);
                }
                // Zero-fill BASIST: Step (2).
                if ndata_freq < self.c.ndata {
                    for j in (ndata_freq + 1)..=self.c.ndata {
                        self.c.basist[(j, nm)] = C32::ZERO;
                    }
                }
                // BASOUT = T to write out a modified BASIS file (not with ABSVAL=T).
                if self.c.basout && self.c.absval {
                    self.errmes(14, 3, CHSUBP)?;
                }
                if self.c.basout && ndata_freq == self.c.ndata && ndata_freq == ndatab {
                    self.errmes(15, 1, CHSUBP)?;
                }
                if self.c.basout && (ndata_freq != self.c.ndata || ndata_freq != ndatab) && lstage == 2 && !self.c.absval {
                    if self.c.nmetab == 1 {
                        let lfilbas = ilen(&self.c.filbas);
                        let mut lastdot = 0;
                        let mut lastslash = 0;
                        for j in 1..=lfilbas {
                            if self.c.filbas.at(j) == b'.' {
                                lastdot = j;
                            }
                            if self.c.filbas.at(j) == b'/' {
                                lastslash = j;
                            }
                        }
                        if lastdot > lastslash {
                            let s = self.c.filbas.sub(1, lastdot - 1).cat_str("-new-bw").cat(&self.c.filbas.sub(lastdot, lfilbas));
                            file_basout.set_f(&s);
                        } else {
                            let s = self.c.filbas.sub(1, lfilbas).cat_str("-new-bw");
                            file_basout.set_f(&s);
                        }
                        if !self.io.open_new(21, &file_basout.trim()) {
                            return self.mybasi_fail(832);
                        }
                        let recs = nml_records("seqpar", &[("fwhmba", NmlOut::R(self.c.fwhmba)), ("hzpppm", NmlOut::R(self.c.hzpppm)), ("echot", NmlOut::R(self.c.echot)), ("seq", NmlOut::S(&seq))]);
                        self.io.write_records(21, recs);
                        let j = ilen(&idbasi).min(MCHIDB - 3);
                        idbasi.set_sub(j + 2, j + 3, "BW");
                        let badelt_save = badelt;
                        badelt = self.c.deltat;
                        let ndatab_save = ndatab;
                        ndatab = self.c.ndata;
                        let recs = nml_records("basis1", &[("idbasi", NmlOut::S(&idbasi)), ("fmtbas", NmlOut::S(&fmtbas)), ("badelt", NmlOut::R(badelt)), ("ndatab", NmlOut::I(ndatab))]);
                        self.io.write_records(21, recs);
                        badelt = badelt_save;
                        ndatab = ndatab_save;
                    }
                    conc = 1.0;
                    tramp = 1.0;
                    volume = 1.0;
                    ishift = nint((self.c.ppmcen - 4.65) / self.c.ppminc);
                    let recs = nml_records(
                        "basis",
                        &[("id", NmlOut::S(&id)), ("metabo", NmlOut::S(&metabo)), ("conc", NmlOut::R(conc)), ("tramp", NmlOut::R(tramp)), ("volume", NmlOut::R(volume)), ("ishift", NmlOut::I(ishift))],
                    );
                    self.io.write_records(21, recs);
                    cfft(self.c.basist.tail((1, nm)), &mut self.s_basis.basisf.data, self.c.ndata, &mut self.c.lwfft, &mut self.c.wfftc.data);
                    let v: Vec<FVal> = (1..=self.c.ndata).map(|j| FVal::C(self.s_basis.basisf[j])).collect();
                    self.io.write(21, &fmtbas.as_str(), &v);
                }
                // Suppress convolution with Lineshape (and broaden with a Gaussian
                // with FWHM=FWHMST) according to CHNOLS when LSTAGE=1 (mainly Lac &
                // Ala with simulated lipids).
                if lstage == 1 && self.c.nnolsh > 0 {
                    for j in 1..=self.c.nnolsh {
                        if metabo.eq_f(&self.c.chnols[j]) {
                            self.set_lshape_false()?;
                            break;
                        }
                    }
                }
                // 289: try scaling, if needed.
                let c = &self.c;
                dows_now = c.dows && lstage == 2 && c.havh2o && !c.bascal && c.fcalib > 0.999999 && c.fcalib < 1.000001;
                if !(dows_now || (c.scasim && c.nsimul > 0)) {
                    continue 'l210;
                }
                if !self.c.wsmet.eq_f(&metabo) {
                    for jsyn in 1..=MPMET {
                        if syn_blank(&self.c.synus1, jsyn) {
                            continue 'l210;
                        }
                        if syn_pair(&self.c.synus1, jsyn, &self.c.wsmet, &metabo) {
                            break;
                        }
                    }
                }
                // 295: BASISF for the new BW.
                if ndata_freq != self.c.ndata {
                    cfft(self.c.basist.tail((1, nm)), &mut self.s_basis.basisf.data, self.c.ndata, &mut self.c.lwfft, &mut self.c.wfftc.data);
                }
                // Superseded; normally skipped since AREA_MET_NORM was computed above.
                if self.c.area_met_norm <= 0.0 {
                    let (ppminc, nunfil) = (self.c.ppminc, self.c.nunfil);
                    self.c.area_met_norm = self.areaba_basisf(ppminc, nunfil)?;
                }
                // Try water scaling
                if dows_now && self.c.area_met_norm > 0.0 {
                    self.water_scale()?;
                }
            }
        }
        // 300: NSIMUL = # extra model spectra to be synthesized (CHSIMU):
        // Gaussian components SIPPM, SIAMP, SIFWMN; SIFWEX/SIFWSD give EXRT2/SDRT2;
        // SISDSH the shift SD.  IMETHD=2 replaces the lineshape regularizor by a
        // linewidth regularizor (2nd component @999 carries c^0); IMETHD=3
        // broadens with exp(-PARNLN*T**POWER).  SIDUMP aborts with a dump.
        if self.c.nsimul > 0 {
            if self.c.nsimul > MMETAB - self.c.nmetab {
                self.errmes(16, 4, CHSUBP)?;
            }
            if lstage == 1 {
                self.parse_chsimu()?;
            }
            if self.c.gauss_rt2 && self.c.lprint > 0 {
                self.io.write(
                    self.c.lprint,
                    "(' No.   Metabolite', 9x, 'EXRT2', 6x, 'SIFWEX  input', 3x, 'SIFWMN', 14x, 'SDRT2', 6x, 'SIFWSD   input', 3x, 'SD[Shift](ppm)')",
                    &[],
                );
            }
            'l310: for jsimul in 1..=self.c.nsimul {
                metabo.set_f(&self.c.chsim[jsimul]);
                'l329: {
                    'l316: {
                        if self.c.ncalib > 0 {
                            for j in 1..=self.c.ncalib {
                                if self.c.chcali[j].eq_f(&metabo) {
                                    break 'l316;
                                }
                            }
                            continue 'l310;
                        }
                        // Omit spectrum according to CHOMIT.
                        for jomit in 1..=self.c.nomit {
                            if self.c.chomit[jomit].eq_f(&metabo) {
                                continue 'l310;
                            }
                        }
                        for j in 1..=self.c.nkeep {
                            if self.c.chkeep[j].eq_f(&metabo) {
                                break 'l316;
                            }
                        }
                        for j in 1..=MPMET {
                            if self.c.chpmet[j].eq_f(&metabo) {
                                let c = &self.c;
                                if (c.ppmmet[(1, j)] > c.ppmst || c.ppmmet[(2, j)] < c.ppmend) && (c.ppmmet[(3, j)] > c.ppmst || c.ppmmet[(4, j)] < c.ppmend) {
                                    continue 'l310;
                                }
                            }
                        }
                        // Omit spectrum according to SIPPM and [PPMST,PPMEND].
                        if self.c.chksim {
                            let distmx: f32 = 0.0;
                            let c = &self.c;
                            for jgau in 1..=c.ngau[jsimul] {
                                for jgap in 1..=c.ngap {
                                    if c.sippm[(jgau, jsimul)] <= c.ppmgap[(1, jgap)] && c.sippm[(jgau, jsimul)] >= c.ppmgap[(2, jgap)] {
                                        continue 'l310;
                                    }
                                }
                                if c.sippm[(jgau, jsimul)] - distmx < c.ppmst && c.sippm[(jgau, jsimul)] + distmx > c.ppmend {
                                    break 'l316;
                                }
                            }
                            continue 'l310;
                        }
                    }
                    // 316
                    if lstage == 1 {
                        // Omit spectrum according to CHNOT1 & CHUSE1.
                        for j in 1..=self.c.nnot1 {
                            if self.c.chnot1[j].eq_f(&metabo) {
                                continue 'l310;
                            }
                        }
                        'l317: for juse1 in 1..=self.c.nuse1 {
                            if us1ful[juse1] {
                                continue 'l317;
                            }
                            if self.c.chuse1[juse1].eq_f(&metabo) {
                                us1ful[juse1] = true;
                                break 'l329;
                            }
                            for jsyn in 1..=MPMET {
                                if syn_blank(&self.c.synus1, jsyn) {
                                    continue 'l317;
                                }
                                if syn_pair(&self.c.synus1, jsyn, &self.c.chuse1[juse1], &metabo) {
                                    us1ful[juse1] = true;
                                    break 'l329;
                                }
                            }
                        }
                        // BADREF = T includes every remaining metabolite (CHNOLS);
                        // SIFWSD is set arbitrarily (checked when LSTAGE=2).
                        if self.c.badref {
                            'l3184: for kmetab in 1..=self.c.nmetab {
                                for jsyn in 1..=MPMET {
                                    if syn_blank(&self.c.synus1, jsyn) {
                                        continue 'l3184;
                                    }
                                    if syn_pair(&self.c.synus1, jsyn, &self.c.nacomb[kmetab], &metabo) {
                                        continue 'l310;
                                    }
                                }
                            }
                            for j in 1..=self.c.nnot2 {
                                if self.c.chnot2[j].eq_f(&metabo) {
                                    self.c.sifwsd[jsimul] = 0.5 * self.c.sifwex[jsimul];
                                }
                            }
                            break 'l329;
                        }
                        continue 'l310;
                    } else {
                        // LSTAGE=2.  Omit spectrum according to CHNOT2.
                        for j in 1..=self.c.nnot2 {
                            if self.c.chnot2[j].eq_f(&metabo) {
                                continue 'l310;
                            }
                        }
                        if self.c.scafwh {
                            // Scale SIFW* by FWHMST from LSTAGE=1.
                            term = self.c.fwhmst.max(self.c.fwhmmn);
                            self.c.sifwmn[(1, jsimul)] = self.c.sifwmn[(1, jsimul)] * term;
                            self.c.sifwex[jsimul] = self.c.sifwex[jsimul] * term;
                            self.c.sifwsd[jsimul] = self.c.sifwsd[jsimul] * term;
                        }
                    }
                }
                // 329
                self.c.nmetab += 1;
                if self.c.nmetab > MMETAB {
                    self.errmes(25, 4, CHSUBP)?;
                }
                let nm = self.c.nmetab;
                self.c.nacomb[nm].set_f(&metabo);
                // Use Lineshape only if simulating a basis spectrum or if specified by CHLSHA.
                self.c.lshape[nm] = self.c.sifwmn[(1, jsimul)] <= 0.0;
                self.c.table_top[nm] = self.c.lshape[nm];
                if !self.c.lshape[nm] {
                    for j in 1..=self.c.nlshap {
                        if self.c.chlsha[j].eq_f(&metabo) {
                            self.c.lshape[nm] = true;
                        }
                    }
                }
                // SDRT2 & EXRT2 from the 3 SIFW*, assuming additivity of variances.
                // *_MIN avoid ill-conditioning due to too strong priors.
                if self.c.sifwmn[(1, jsimul)] <= 0.0 {
                    // Simulating basis spectra with FWHMBA and DE* priors; only
                    // CHSIM, SIPPM & SIAMP are used from CHSIMU.
                    self.c.exrt2[nm] = self.c.deext2 * rt2_scale;
                    self.c.sdrt2[nm] = self.c.desdt2 * rt2_scale;
                    self.c.sdshif[nm] = self.c.desdsh;
                } else {
                    if self.c.imethd == 3 {
                        // Special use of SIFWSD = NPOWER
                        self.c.npower[nm] = nint(self.c.sifwsd[jsimul]);
                        if !self.c.nobasi || self.c.npower[nm] < 1 || self.c.npower[nm] > MMPOWR {
                            self.errmes(39, 4, CHSUBP)?;
                        }
                    } else {
                        // SIFWMN (and all other SI*) input.
                        if self.c.sifwmn[(1, jsimul)] >= self.c.sifwex[jsimul] || self.c.sifwsd[jsimul] <= 0.0 {
                            self.errmes(18, 4, CHSUBP)?;
                        }
                        // GAUSS_RT2 = T only for the old (Gaussian) computation of EXRT2 & SDRT2.
                        let fwhm_ex;
                        if self.c.gauss_rt2 {
                            let a = self.c.sifwex[jsimul];
                            let b = self.c.sifwmn[(1, jsimul)];
                            fwhm_ex = (a * a - b * b).sqrt();
                        } else {
                            fwhm_ex = self.c.sifwex[jsimul] - self.c.sifwmn[(1, jsimul)];
                        }
                        self.c.exrt2[nm] = self.c.pi * self.c.hzpppm * fwhm_ex;
                        let exrt2_min: f32 = 0.5;
                        if self.c.exrt2[nm] < exrt2_min {
                            self.errmes(19, 2, CHSUBP)?;
                            self.c.exrt2[nm] = exrt2_min;
                        }
                        if self.c.gauss_rt2 {
                            // Solution of sqrt{SIFWMN**2 + [(EXRT2+SDRT2)/pi*HZPPPM]**2} = SIFWEX + SIFWSD.
                            let a = self.c.sifwex[jsimul] + self.c.sifwsd[jsimul];
                            let b = self.c.sifwmn[(1, jsimul)];
                            self.c.sdrt2[nm] = self.c.pi * self.c.hzpppm * (a * a - b * b).sqrt() - self.c.exrt2[nm];
                        } else {
                            self.c.sdrt2[nm] = self.c.pi * self.c.hzpppm * self.c.sifwsd[jsimul];
                        }
                        let sdrt2_min: f32 = 0.25;
                        if self.c.sdrt2[nm] < sdrt2_min {
                            self.errmes(20, 2, CHSUBP)?;
                            self.c.sdrt2[nm] = sdrt2_min;
                        }
                    }
                    // SISDSH is only necessary when LSTAGE=2 is used.
                    if self.c.sisdsh[jsimul] <= 0.0 && lstage == 2 {
                        self.errmes(21, 4, CHSUBP)?;
                    }
                    self.c.sdshif[nm] = self.c.sisdsh[jsimul];
                    // Might have to change SDSHIF_MIN for other nuclei.
                    let sdshif_min = self.c.ppminc / 10.0;
                    if self.c.sdshif[nm] < sdshif_min && lstage == 2 {
                        if !self.c.sptype.sub(1, 7).eq_str("muscle-") {
                            self.errmes(21, 2, CHSUBP)?;
                        }
                        self.c.sdshif[nm] = sdshif_min;
                    }
                }
                if self.c.lprint > 0 {
                    if lstage == 1 {
                        self.io.write(self.c.lprint, "(1X, I3, 7X, A6)", &fv![nm, &metabo]);
                    } else {
                        let c = &self.c;
                        if c.imethd == 3 {
                            let v = fv![nm, &metabo, c.npower[nm], c.sdshif[nm]];
                            self.io.write(self.c.lprint, "(1X, I3, 7X, A6, i4, f9.3)", &v);
                        } else if c.gauss_rt2 {
                            let v = fv![
                                nm,
                                &metabo,
                                c.exrt2[nm],
                                c.exrt2[nm] / (c.pi * c.hzpppm) + c.sifwmn[(1, jsimul)],
                                c.sifwex[jsimul],
                                c.sifwmn[(1, jsimul)],
                                c.sdrt2[nm],
                                c.sdrt2[nm] / (c.pi * c.hzpppm),
                                c.sifwsd[jsimul],
                                c.sdshif[nm]
                            ];
                            self.io.write(self.c.lprint, "(1X, I3, 7X, A6, f14.3, f12.3, f7.3, f9.3, f19.3, f12.4, f8.4, f17.3)", &v);
                        } else {
                            let v = fv![nm, &metabo, c.exrt2[nm], c.sdrt2[nm], c.sdshif[nm]];
                            self.io.write(self.c.lprint, "(1X, I3, 7X, A6, 1PE26.4, E18.4, 13x, E17.2)", &v);
                        }
                    }
                }
                // Convert SDSHIF from ppm to radians/s.
                self.c.sdshif[nm] = self.c.sdshif[nm] * 2.0 * self.c.pi * self.c.hzpppm;
                self.c.ncompo[nm] = 1;
                self.c.lcompo[(1, nm)] = nm;
                // Simulate (real) spectrum, as in real-spectra-only/make-raw.f.
                if self.c.ngau[jsimul] <= 0 || self.c.ngau[jsimul] > MGAU {
                    self.errmes(17, 4, CHSUBP)?;
                }
                for jdata in 1..=self.c.ndata {
                    self.s_basis.basisf[jdata] = C32::ZERO;
                }
                let expmax = 2.0 * self.c.rrange.ln();
                let mut kpower = 0;
                if self.c.imethd == 2 && self.c.ngau[jsimul] != 2 {
                    self.errmes(40, 4, CHSUBP)?;
                }
                'l350: for jgau in 1..=self.c.ngau[jsimul] {
                    let rsd;
                    if self.c.sifwmn[(1, jsimul)] <= 0.0 {
                        // Special case for simulating basis spectra.
                        if self.c.nobasi || self.c.imethd == 2 || self.c.imethd == 3 {
                            self.errmes(37, 4, CHSUBP)?;
                        }
                        rsd = 2.0 * (2.0 * 2f32.ln()).sqrt() / self.c.fwhmba;
                    } else {
                        if self.c.sifwmn[(jgau, jsimul)] <= 0.0 {
                            self.errmes(24, 4, CHSUBP)?;
                        }
                        rsd = 2.0 * (2.0 * 2f32.ln()).sqrt() / self.c.sifwmn[(jgau, jsimul)];
                    }
                    if self.c.imethd == 2 && jgau == 2 {
                        if self.c.sippm[(2, jsimul)] <= 998.0 || self.c.siamp[(2, jsimul)] <= 0.0 || !self.c.nobasi {
                            self.errmes(36, 4, CHSUBP)?;
                        }
                        if lstage == 1 {
                            self.c.conc_expect[nm] = self.c.siamp[(2, jsimul)];
                        } else {
                            if self.c.fconc_expect <= 0.0 {
                                self.errmes(38, 4, CHSUBP)?;
                            }
                            self.c.conc_expect[nm] = self.c.siamp[(2, jsimul)] * self.c.fconc_expect;
                        }
                        self.c.rt2min[nm] = self.c.pi * self.c.hzpppm * self.c.sifwmn[(1, jsimul)];
                        continue 'l350;
                    } else if self.c.imethd == 3 {
                        if self.c.sippm[(jgau, jsimul)] > 998.0 {
                            kpower += 1;
                            self.c.fract_power_sd[(kpower, nm)] = self.c.sifwmn[(jgau, jsimul)];
                        }
                    } else {
                        if self.c.siamp[(jgau, jsimul)].abs() <= 0.0 || self.c.sippm[(jgau, jsimul)].abs() > 998.0 {
                            self.errmes(22, 4, CHSUBP)?;
                        }
                    }
                    if self.c.sippm[(jgau, jsimul)] <= 998.0 {
                        let anorm = self.c.siamp[(jgau, jsimul)] * rsd / (2.0 * self.c.pi).sqrt();
                        let mut xppm = self.c.ppmcen + self.c.nunfil as f32 * self.c.ppminc;
                        let sippm = self.c.sippm[(jgau, jsimul)];
                        for jdata in 1..=self.c.ndata {
                            let t = rsd * (xppm - sippm);
                            let expon = t * t;
                            if expon < expmax {
                                term = anorm * (-0.5 * expon).exp();
                                self.s_basis.basisf[jdata] = self.s_basis.basisf[jdata] + term;
                            }
                            xppm = xppm - self.c.ppminc;
                        }
                    }
                }
                // Arrange (as BASISF normally is, i.e., "not rearranged").
                let nunfil = self.c.nunfil;
                for j in 1..=nunfil {
                    self.c.cterm[1] = self.s_basis.basisf[nunfil + j];
                    self.s_basis.basisf[nunfil + j] = self.s_basis.basisf[j];
                    self.s_basis.basisf[j] = self.c.cterm[1];
                }
                let ndata = self.c.ndata;
                if self.c.absval {
                    // Absolute value of basis spectra, then BASIST.
                    for j in 1..=ndata {
                        self.s_basis.basisf[j] = cmplx(self.s_basis.basisf[j].abs(), 0.0);
                    }
                    cfftin(&self.s_basis.basisf.data, self.c.basist.tail_mut((1, nm)), ndata, &mut self.c.lwfft, &mut self.c.wfftc.data);
                    self.c.basist[(1, nm)] = 0.5 * self.c.basist[(1, nm)];
                } else {
                    cfftin(&self.s_basis.basisf.data, self.c.basist.tail_mut((1, nm)), ndata, &mut self.c.lwfft, &mut self.c.wfftc.data);
                }
                // Replace 2nd half with zeroes; the factor of 2 compensates for
                // zeroing the 2nd half (also calibrates simulated vs basis Cr).
                for junfil in 1..=nunfil {
                    self.c.basist[(junfil, nm)] = 2.0 * self.c.basist[(junfil, nm)];
                    self.c.basist[(nunfil + junfil, nm)] = C32::ZERO;
                }
                // Correct possible remaining offset due to the finite frequency range.
                cfft_r(self.c.basist.tail((1, nm)), &mut self.s_basis.basisf.data, ndata, &mut self.c.lwfft, &mut self.c.wfftc.data);
                offset_start = C32::ZERO;
                offset_end = C32::ZERO;
                for j in 1..=5 {
                    offset_start = offset_start + self.s_basis.basisf[j];
                    offset_end = offset_end + self.s_basis.basisf[ndata - j + 1];
                }
                if offset_start.re.abs() < offset_end.re.abs() {
                    self.c.basist[(1, nm)] = self.c.basist[(1, nm)] - (0.2 * (ndata as f32).sqrt()) * offset_start;
                } else {
                    self.c.basist[(1, nm)] = self.c.basist[(1, nm)] - (0.2 * (ndata as f32).sqrt()) * offset_end;
                }
                // For a more realistic LSTAGE=1, exponentially broaden the model
                // spectrum according to EXRT2.
                if lstage == 1 && !self.c.lshape[nm] && !self.c.scafwh && self.c.imethd != 3 {
                    let factor = (-self.c.deltat * self.c.exrt2[nm]).exp();
                    term = 1.0;
                    for junfil in 1..=nunfil {
                        self.c.basist[(junfil, nm)] = term * self.c.basist[(junfil, nm)];
                        term = term * factor;
                    }
                }
                // Scale spectrum to be consistent with the Basis Set (CONC in mM
                // if total SIAMP is the number of visible protons).
                if self.c.scasim {
                    if self.c.area_met_norm <= 0.0 {
                        // Called once per simulated metabolite that cannot be scaled.
                        if !self.c.dofull {
                            self.errmes(34, 3, CHSUBP)?;
                        }
                    } else {
                        for junfil in 1..=nunfil {
                            self.c.basist[(junfil, nm)] = self.c.area_met_norm * self.c.basist[(junfil, nm)];
                        }
                    }
                }
                // Dump model spectrum for viewing absolute value.
                if self.c.sidump[jsimul] {
                    for jdata in 1..=ndata {
                        self.c.datat[jdata] = self.c.basist[(jdata, nm)];
                    }
                    self.c.istago = 1;
                    self.errmes(23, 4, CHSUBP)?;
                }
                // Add 2 BASIST for 1st-order Taylor terms for shift & broadening
                // for the Preliminary Analysis.
                if lstage == 1 && self.c.sitayl[jsimul] {
                    if nm + 2 > MMETAB {
                        self.errmes(36, 4, CHSUBP)?;
                    }
                    let mut rtime: f32 = 0.0;
                    for junfil in 1..=nunfil {
                        self.c.cterm[1] = rtime * self.c.basist[(junfil, nm)];
                        let ct = self.c.cterm[1];
                        self.c.basist[(junfil, nm + 1)] = ct;
                        self.c.basist[(junfil, nm + 2)] = cmplx(-ct.im, ct.re);
                        self.c.basist[(junfil + nunfil, nm + 1)] = C32::ZERO;
                        self.c.basist[(junfil + nunfil, nm + 2)] = C32::ZERO;
                        rtime = rtime + self.c.deltat;
                    }
                    if jsimul < 10 {
                        metabo.set(&format::write_line("('Brod-', i1)", &fv![jsimul]));
                    } else {
                        metabo.set(&format::write_line("('Brod', i2)", &fv![jsimul]));
                    }
                    self.c.nmetab += 1;
                    let n = self.c.nmetab;
                    self.c.table_top[n] = false;
                    self.c.nacomb[n].set_f(&metabo);
                    self.c.ncompo[n] = 1;
                    self.c.lcompo[(1, n)] = n;
                    self.c.nonneg[n] = false;
                    if jsimul < 10 {
                        metabo.set(&format::write_line("('Shif-', i1)", &fv![jsimul]));
                    } else {
                        metabo.set(&format::write_line("('Shif', i2)", &fv![jsimul]));
                    }
                    self.c.nmetab += 1;
                    let n = self.c.nmetab;
                    self.c.table_top[n] = false;
                    self.c.nacomb[n].set_f(&metabo);
                    self.c.ncompo[n] = 1;
                    self.c.lcompo[(1, n)] = n;
                    self.c.nonneg[n] = false;
                }
            }
        }
        if self.c.nmetab <= 0 {
            self.errmes(7, 4, CHSUBP)?;
        }
        if self.c.nmetab < self.c.nuse1 && lstage == 1 && !self.c.omit_chless {
            self.errmes(8, 2, CHSUBP)?;
        }
        // CPRIOR_SHIFT for constraining shifts of a group from its mean.
        if lstage == 2 {
            self.make_cgroup_shift()?;
        }
        // Water-scaling when NOBASI=T
        let c = &self.c;
        if c.nobasi && c.dows && lstage == 2 && c.havh2o && c.fcalib > 0.999999 && c.fcalib < 1.000001 {
            self.c.area_met_norm = 1.0;
            self.water_scale()?;
        }
        if self.c.basout && ndata_freq != self.c.ndata && lstage == 2 && !self.c.absval {
            self.io.close(21);
        }
        self.io.close(self.c.lbasis);
        Ok(())
    }

    /// MAKE_CGROUP_SHIFT: prior matrix constraining shifts of a group (CHGRSH)
    /// from its mean.
    pub fn make_cgroup_shift(&mut self) -> R<()> {
        const CHSUBP: &str = "GRPSHF";
        self.c.nrow_group_shift = 0;
        if self.c.ngrsh > MGROUP_SHIFT {
            self.errmes(1, 3, CHSUBP)?;
            self.c.ngrsh = MGROUP_SHIFT;
        }
        'l110: for jgroup in 1..=self.c.ngrsh {
            let mut nin_group = 0;
            for jmetab in 1..=self.c.nmetab {
                let lchgr = ilen(&self.c.chgrsh[jgroup]);
                if lchgr <= 0 {
                    continue;
                }
                if self.c.nacomb[jmetab].index_f(&self.c.chgrsh[jgroup].sub(1, lchgr)) == 1 {
                    nin_group += 1;
                }
            }
            if nin_group <= 1 {
                continue 'l110;
            }
            if self.c.sdgrsh[jgroup] <= 0.0 {
                self.errmes(2, 4, CHSUBP)?;
            }
            // Might have to change SDSHIF_MIN for other nuclei.
            let sdshif_min = self.c.ppminc / 50.0;
            if self.c.sdgrsh[jgroup] < sdshif_min {
                self.errmes(3, 2, CHSUBP)?;
                self.c.sdgrsh[jgroup] = sdshif_min;
            }
            let term = 1.0 / nin_group as f32;
            for kmetab in 1..=self.c.nmetab {
                let lchgr = ilen(&self.c.chgrsh[jgroup]);
                if lchgr <= 0 {
                    continue;
                }
                if self.c.nacomb[kmetab].index_f(&self.c.chgrsh[jgroup].sub(1, lchgr)) != 1 {
                    continue;
                }
                self.c.nrow_group_shift += 1;
                let nrow = self.c.nrow_group_shift;
                self.c.lmetab_shift_prior[nrow] = kmetab;
                // Convert SD from ppm to radians/s.
                self.c.sdgroup_shift_row[nrow] = self.c.sdgrsh[jgroup] * 2.0 * self.c.pi * self.c.hzpppm;
                for j in 1..=MMETAB {
                    self.c.cgroup_shift[(nrow, j)] = 0.0;
                }
                for jmetab in 1..=self.c.nmetab {
                    let lchgr = ilen(&self.c.chgrsh[jgroup]);
                    if lchgr <= 0 {
                        continue;
                    }
                    if self.c.nacomb[jmetab].index_f(&self.c.chgrsh[jgroup].sub(1, lchgr)) != 1 {
                        continue;
                    }
                    self.c.cgroup_shift[(nrow, jmetab)] = -term;
                }
                self.c.cgroup_shift[(nrow, kmetab)] = self.c.cgroup_shift[(nrow, kmetab)] + 1.0;
            }
        }
        // Dump matrix of group-shift priors (if IPDUMP >= 3).
        if self.c.nrow_group_shift.min(self.c.lprint) > 0 {
            if self.c.ipdump >= 3 {
                let v: Vec<FVal> = (1..=self.c.nmetab).map(|j| FVal::from(&self.c.nacomb[j])).collect();
                self.io.write(self.c.lprint, "(//20x, 'Prior matrix for group shifts'//(8x, (10(6x, a6))))", &v);
                for j in 1..=self.c.nrow_group_shift {
                    let mut v: Vec<FVal> = vec![FVal::from(&self.c.nacomb[self.c.lmetab_shift_prior[j]])];
                    for jmetab in 1..=self.c.nmetab {
                        v.push(FVal::R(self.c.cgroup_shift[(j, jmetab)]));
                    }
                    self.io.write(self.c.lprint, "(/2x, a6, 1p10e12.3 / (8x, 1p10e12.3))", &v);
                }
            } else {
                let v: Vec<FVal> = (1..=self.c.nrow_group_shift).map(|jrow| FVal::from(&self.c.nacomb[self.c.lmetab_shift_prior[jrow]])).collect();
                self.io.write(self.c.lprint, "(//' Group-shift priors used for:'/(a6))", &v);
            }
        }
        Ok(())
    }

    /// PARSE_CHSIMU: parse CHSIMU strings (all in one record) of the form
    /// `CHSIM @ SIPPM +- SISDSH FWHM= SIFWMN < SIFWEX +- SIFWSD AMP= SIAMP`
    /// followed by any number of `@ SIPPM FWHM= SIFWMN AMP= SIAMP`.
    pub fn parse_chsimu(&mut self) -> R<()> {
        const CHSUBP: &str = "PARSIM";
        let mut ierr: i32 = 0;
        let mut istart: i32 = 0;
        let jsimul: i32 = 'l800: {
            'l210: for jsimul in 1..=self.c.nsimul {
                self.c.ngau[jsimul] = 1;
                let len_chsimu = ilen(&self.c.chsimu[jsimul]);
                istart = 1;
                let steps: [(&str, i32, i32, i32, SimField); 7] = [
                    ("@", 1, 1, 0, SimField::Chsim),
                    ("+-", 2, 2, 0, SimField::Sippm(1)),
                    ("FWHM=", 5, 2, 0, SimField::Sisdsh),
                    ("<", 1, 2, 0, SimField::Sifwmn(1)),
                    ("+-", 2, 2, 0, SimField::Sifwex),
                    ("AMP=", 4, 2, 0, SimField::Sifwsd),
                    ("@", 1, 2, 1, SimField::Siamp(1)),
                ];
                for (k, (sep, lsep, ty, at, f)) in steps.into_iter().enumerate() {
                    self.chsimu_field(jsimul, sep, lsep, ty, at, f, &mut istart, len_chsimu)?;
                    if istart <= 0 {
                        ierr = k as i32;
                        break 'l800 jsimul;
                    }
                }
                if istart > len_chsimu {
                    continue 'l210;
                }
                for jgau in 2..=MGAU {
                    self.c.ngau[jsimul] = jgau;
                    let steps: [(&str, i32, i32, i32, SimField); 3] =
                        [("FWHM=", 5, 2, 0, SimField::Sippm(jgau)), ("AMP=", 4, 2, 0, SimField::Sifwmn(jgau)), ("@", 1, 2, 1, SimField::Siamp(jgau))];
                    for (k, (sep, lsep, ty, at, f)) in steps.into_iter().enumerate() {
                        self.chsimu_field(jsimul, sep, lsep, ty, at, f, &mut istart, len_chsimu)?;
                        if istart <= 0 {
                            ierr = 7 + k as i32;
                            break 'l800 jsimul;
                        }
                    }
                    if istart > len_chsimu {
                        continue 'l210;
                    }
                }
                // Error -- NGAU > MGAU
                if self.c.lprint > 0 {
                    self.write_chsimu_error(jsimul, istart);
                }
                self.errmes(0, 4, CHSUBP)?;
            }
            return Ok(());
        };
        // 800
        if self.c.lprint > 0 {
            self.write_chsimu_error(jsimul, istart);
        }
        self.errmes(100 * ierr + jsimul, 4, CHSUBP)?;
        Ok(())
    }

    /// One CALL GET_FIELD of PARSE_CHSIMU on CHSIMU(JSIMUL), returning into `f`.
    fn chsimu_field(&mut self, jsimul: i32, sep: &str, lsep: i32, ty: i32, at: i32, f: SimField, istart: &mut i32, len_chsimu: i32) -> R<()> {
        let mut chreturn = FStr::blank(MCHMET as usize);
        let mut freturn: f32 = 0.0;
        let c = &self.c;
        match f {
            SimField::Chsim => chreturn = c.chsim[jsimul].clone(),
            SimField::Sippm(j) => freturn = c.sippm[(j, jsimul)],
            SimField::Sisdsh => freturn = c.sisdsh[jsimul],
            SimField::Sifwmn(j) => freturn = c.sifwmn[(j, jsimul)],
            SimField::Sifwex => freturn = c.sifwex[jsimul],
            SimField::Sifwsd => freturn = c.sifwsd[jsimul],
            SimField::Siamp(j) => freturn = c.siamp[(j, jsimul)],
        }
        let mut q = ErrQueue::new();
        let r = get_field(sep, lsep, ty, at, &mut chreturn, &mut freturn, istart, len_chsimu, &self.c.chsimu[jsimul], &mut q);
        let c = &mut self.c;
        match f {
            SimField::Chsim => c.chsim[jsimul] = chreturn,
            SimField::Sippm(j) => c.sippm[(j, jsimul)] = freturn,
            SimField::Sisdsh => c.sisdsh[jsimul] = freturn,
            SimField::Sifwmn(j) => c.sifwmn[(j, jsimul)] = freturn,
            SimField::Sifwex => c.sifwex[jsimul] = freturn,
            SimField::Sifwsd => c.sifwsd[jsimul] = freturn,
            SimField::Siamp(j) => c.siamp[(j, jsimul)] = freturn,
        }
        self.after(q, r)
    }

    fn write_chsimu_error(&mut self, jsimul: i32, istart: i32) {
        let s = &self.c.chsimu[jsimul];
        let v = fv![s.sub(1, 132), s.sub(133, 264), s.sub(265, 396), s.sub(397, 528), istart];
        self.io.write(self.c.lprint, "('Incorrect CHSIMU follows:', / a132 / a132 / a132 / a132 / 'ISTART =', i3)", &v);
    }

    /// SET_LSHAPE_FALSE: no lineshape convolution for metabolite NMETAB; broaden
    /// with a Gaussian to FWHM=FWHMST instead.
    pub fn set_lshape_false(&mut self) -> R<()> {
        let nm = self.c.nmetab;
        self.c.lshape[nm] = false;
        if self.c.fwhmba >= self.c.fwhmst {
            return Ok(());
        }
        let fwhm_extra = (self.c.fwhmst * self.c.fwhmst - self.c.fwhmba * self.c.fwhmba).sqrt();
        let rsd = self.c.pi * fwhm_extra * self.c.deltat * self.c.hzpppm / (2.0 * 2f32.ln()).sqrt();
        let expmax = 2.0 * self.c.rrange.ln();
        for jdata in 1..=self.c.ndata {
            let t = rsd * (jdata - 1) as f32;
            let expon = t * t;
            if expon < expmax {
                self.c.basist[(jdata, nm)] = (-0.5 * expon).exp() * self.c.basist[(jdata, nm)];
            } else {
                self.c.basist[(jdata, nm)] = C32::ZERO;
            }
        }
        Ok(())
    }

    /// WATER_SCALE: FCALIB from the unsuppressed water area; scales DATAT, CY, RMSAMP.
    pub fn water_scale(&mut self) -> R<()> {
        const CHSUBP: &str = "WSCALE";
        let area_water;
        if self.c.iaverg == 1 || self.c.iaverg == 4 {
            area_water = 1.0;
        } else {
            area_water = self.areawa(2)?;
        }
        if self.c.lprint > 0 {
            self.io.write(self.c.lprint, "(//'Area of unsuppressed water peak =', 1pe13.5)", &fv![area_water]);
        }
        if area_water <= 0.0 {
            self.errmes(1, 3, CHSUBP)?;
            return Ok(());
        }
        if self.c.atth2o.min(self.c.wconc) <= 0.0 {
            self.errmes(2, 3, CHSUBP)?;
            return Ok(());
        }
        let water_norm = area_water / (2.0 * self.c.atth2o * self.c.wconc);
        self.c.fcalib = self.c.area_met_norm / water_norm;
        self.c.wsdone = true;
        if self.c.lprint > 0 {
            self.io.write(self.c.lprint, "('FCALIB =', 1pe15.5/)", &fv![self.c.fcalib]);
        }
        let fcalib = self.c.fcalib;
        for j in 1..=self.c.nunfil {
            self.c.datat[j] = fcalib * self.c.datat[j];
        }
        for jy in 1..=self.c.ny {
            self.c.cy[jy] = self.c.cy[jy] * fcalib;
        }
        self.c.rmsamp = self.c.rmsamp * fcalib;
        if self.c.imethd == 2 {
            for j in 1..=self.c.nmetab {
                self.c.conc_expect[j] = self.c.conc_expect[j] * fcalib;
            }
        }
        Ok(())
    }

    /// AREAWA: integral of the water peak.  ISTAGE != 2 avoids AREAW2 when
    /// called from AVERAGE (big errors with very weak water signal).
    pub fn areawa(&mut self, istage: i32) -> R<f32> {
        const CHSUBP: &str = "AREAWA";
        if self.c.iareaw == 2 && istage == 2 {
            return self.areaw2();
        }
        // Log-linear regression for water integral.
        'l800: {
            let npts = self.c.nwsend - self.c.nwsst + 1;
            if self.c.nwsst < 1 || self.c.nwsend > self.c.nunfil || npts < 10 {
                self.errmes(1, 3, CHSUBP)?;
                break 'l800;
            }
            let mut sx: f64 = 0.0;
            let mut sy: f64 = 0.0;
            let mut sxy: f64 = 0.0;
            let mut sxx: f64 = 0.0;
            for j in self.c.nwsst..=self.c.nwsend {
                let xterm = j as f32 as f64;
                let mut yterm = self.c.h2ot[j].abs() as f64;
                if yterm <= 0.0 {
                    self.errmes(4, 3, CHSUBP)?;
                    break 'l800;
                }
                yterm = (yterm as f32).ln() as f64;
                sx = sx + xterm;
                sy = sy + yterm;
                sxy = sxy + xterm * yterm;
                sxx = sxx + xterm * xterm;
            }
            let term1 = (self.c.nwsend - self.c.nwsst + 1) as f32 as f64 * sxx;
            let denom = (term1 - sx * sx) as f32;
            if denom.abs() < 1.0e-10 * term1 as f32 {
                // The difference of the two nonnegative terms lost too much precision.
                self.errmes(2, 3, CHSUBP)?;
                break 'l800;
            }
            let rnum = (sxx * sy - sx * sxy) as f32;
            // sqrt(ndata): the inverse FFT is divided by sqrt(ndata); 0.5 agrees
            // with water-scaling-2; PPMINC makes it an area.
            let expmax = self.c.rrange.ln();
            if rnum.abs() >= expmax * denom.abs() {
                self.errmes(3, 3, CHSUBP)?;
                break 'l800;
            }
            return Ok(0.5 * self.c.ppminc * (rnum / denom).exp() * ((2 * self.c.nunfil) as f32).sqrt());
        }
        Ok(-1.0)
    }

    /// AREAW2: area under the (unsuppressed) water peak in H2OF, with
    /// MakeBasis's peak phasing and AREABA's integration.
    fn areaw2(&mut self) -> R<f32> {
        const CHSUBP: &str = "AREAW2";
        // H2OF_WORK = smoothed water spectrum.  No zero-filling: divide the FTs
        // by sqrt(2), as they would be with the original NDATA points.
        let nunfil = self.c.nunfil;
        let nunfil_half = nunfil / 2;
        let ppminc2 = self.c.ppminc * 2.0;
        let rsd = 2.0 * self.c.pi * self.c.sdsmoo[4] / (ppminc2 * nunfil as f32);
        for junfil in 1..=nunfil {
            let t = rsd * (junfil - 1) as f32;
            self.s_basis.h2ot_work[junfil] = self.c.h2ot[junfil] * (-0.5 * (t * t)).exp();
        }
        csft_r(&self.s_basis.h2ot_work.data, &mut self.c.h2of_work.data, nunfil);
        csft_r(&self.c.h2ot.data, &mut self.c.h2of.data, nunfil);
        let rsqrt2 = 0.5f32.sqrt();
        for junfil in 1..=nunfil {
            self.c.h2of_work[junfil] = self.c.h2of_work[junfil] * rsqrt2;
            self.c.h2of[junfil] = self.c.h2of[junfil] * rsqrt2;
        }
        // PPMH2O_CORR = true position of water peak.
        let ppmh2o_corr;
        let c = &self.c;
        if c.ppm_water_range <= 0.0 {
            ppmh2o_corr = c.ppmh2o;
        } else {
            let kystrt = 1i32.max(nint((c.ppmcen - c.ppmh2o - c.ppm_water_range) / ppminc2) + nunfil_half + 1);
            let kyend = nunfil.min(nint((c.ppmcen - c.ppmh2o + c.ppm_water_range) / ppminc2) + nunfil_half + 1);
            let mut lmax = 0;
            let mut rmax = -c.rrange;
            for j in kystrt..=kyend {
                if c.h2of[j].abs() > rmax {
                    rmax = c.h2of[j].abs();
                    lmax = j;
                }
            }
            ppmh2o_corr = c.ppmcen - (lmax - 1 - nunfil_half) as f32 * ppminc2;
            if self.c.lprint > 0 {
                self.io.write(self.c.lprint, "(/'Corrected PPMH2O =', f8.4)", &fv![ppmh2o_corr]);
            }
        }
        let c = &self.c;
        let ly = int((c.ppmcen - ppmh2o_corr) / ppminc2 + nunfil_half as f32 + 1.0);
        let mut kystrt = nint((c.ppmcen - ppmh2o_corr - c.hwdwat[1]) / ppminc2) + nunfil_half + 1;
        let mut kyend = nint((c.ppmcen - ppmh2o_corr + c.hwdwat[1]) / ppminc2) + nunfil_half + 1;
        let mut nypeak = kyend - kystrt + 1;
        if kystrt < 3 || kyend > nunfil - 2 || nypeak <= 0 {
            self.errmes(1, 4, CHSUBP)?;
        }
        if !self.c.havh2o {
            self.errmes(2, 4, CHSUBP)?;
        }
        // H2OF_WORK is the smoothed spectrum on input to GETPHA and the phased
        // (unsmoothed) spectrum on return.
        let mut degzer_calc: f32 = 0.0;
        let mut q = ErrQueue::new();
        let r = getpha(
            &mut kystrt,
            &mut kyend,
            &self.c.h2of.data,
            &mut self.c.h2of_work.data,
            nunfil,
            self.c.radian,
            &mut nypeak,
            &mut self.c.rwork.data,
            &mut self.c.rwork2.data,
            &mut degzer_calc,
            &mut q,
        );
        self.after(q, r)?;
        if self.c.lprint > 0 {
            self.io.write(self.c.lprint, "(/'Zero-order phase correction for unsuppressed water =', f6.1/)", &fv![degzer_calc]);
        }
        let c = &self.c;
        let mut kystrt = nint((c.ppmcen - ppmh2o_corr - c.hwdwat[2]) / ppminc2) + nunfil_half + 1;
        let mut kyend = nint((c.ppmcen - ppmh2o_corr + c.hwdwat[2]) / ppminc2) + nunfil_half + 1;
        let nypeak = kyend - kystrt + 1;
        if kystrt < 3 || kyend > nunfil - 2 || nypeak <= 0 {
            self.errmes(1, 4, CHSUBP)?;
        }
        let nwndo = nint(self.c.ppmbas[2] / self.c.ppminc);
        let mut area_water: f32 = 0.0;
        integrate(&self.c.h2of_work.data, ppminc2, &mut area_water, &mut kyend, &mut kystrt, ly, nunfil, nwndo);
        Ok(area_water)
    }

    /// AREABA: normalized integral of the reference metabolite peak (divided
    /// by N1HMET and ATTMET, so it corresponds to 1 mM of protons).
    pub fn areaba(&mut self, basisf: &mut [C32], ppminc_arg: f32, nunfil_arg: i32) -> R<f32> {
        const CHSUBP: &str = "AREABA";
        let mut areaba: f32 = 0.0;
        let ndata_arg = 2 * nunfil_arg;
        let bf = |basisf: &[C32], jy: i32| basisf[(icycle(jy, ndata_arg) - 1) as usize].re;
        if self.c.sptype.sub(1, 10).eq_str("mega-press") {
            for jy in 1..=ndata_arg {
                basisf[(jy - 1) as usize] = -basisf[(jy - 1) as usize];
            }
        }
        'l800: {
            let mut ly = nint((self.c.ppmcen - self.c.wsppm) / ppminc_arg) + 1;
            // LY = corrected index of metabolite peak
            if self.c.r_areaba > 0.0 {
                let nyhalf = nint(self.c.r_areaba * self.c.desdsh / ppminc_arg);
                let kystrt = ly - nyhalf;
                let kyend = ly + nyhalf;
                if kystrt <= -nunfil_arg || kyend >= nunfil_arg {
                    self.errmes(1, 3, CHSUBP)?;
                    break 'l800;
                }
                let mut rmax = -self.c.rrange;
                for jy in kystrt..=kyend {
                    let term = bf(basisf, jy);
                    if term > rmax {
                        rmax = term;
                        ly = jy;
                    }
                }
                let term = self.c.ppmcen - (ly - 1) as f32 * ppminc_arg;
                if self.c.lprint > 0 {
                    self.io.write(self.c.lprint, "(/'Corrected WSPPM =', f8.4)", &fv![term]);
                }
            }
            let nwndo = nint(self.c.ppmbas[1] / ppminc_arg);
            let lprint = self.c.lprint;
            let dump = self.c.ldump[5];
            if dump {
                self.io.write(lprint, "('NWNDO, PPMBAS(1), PPMINC =', i4, 1p2e15.7)", &fv![nwndo, self.c.ppmbas[1], ppminc_arg]);
            }
            let mut hwdsca = 0.5 * self.c.rfwbas * self.c.fwhmba;
            // With ABSVAL=T increase HWDSCA by 1.5 for the broad absolute-value
            // tails (FWHMBA has already been doubled).
            if self.c.absval {
                hwdsca = hwdsca * 1.5;
            }
            let nyhalf = nint(hwdsca / ppminc_arg);
            let mut kystrt = ly - nyhalf;
            let mut kyend = ly + nyhalf;
            if kystrt - nwndo <= -nunfil_arg || kyend + nwndo >= nunfil_arg || nyhalf.min(nwndo) <= 0 {
                self.errmes(1, 3, CHSUBP)?;
                break 'l800;
            }
            let mut rmin: f32 = 1.0e30;
            let mut lmin = kystrt;
            for jy in kystrt..=(ly - 1) {
                let term = bf(basisf, jy);
                if dump {
                    self.io.write(lprint, "(i5, 1pe15.7)", &fv![jy, bf(basisf, jy)]);
                }
                if term < rmin {
                    rmin = term;
                    lmin = jy;
                }
            }
            let ldist_left = ly - lmin;
            if dump {
                self.io.write(lprint, "('LMIN, LDIST, LY =', 3i5)", &fv![lmin, ldist_left, ly]);
            }
            rmin = 1.0e30;
            lmin = kyend;
            for jy in (ly + 1)..=kyend {
                let term = bf(basisf, jy);
                if dump {
                    self.io.write(lprint, "(i5, 1pe15.7)", &fv![jy, bf(basisf, jy)]);
                }
                if term < rmin {
                    rmin = term;
                    lmin = jy;
                }
            }
            let ldist_right = lmin - ly;
            if dump {
                self.io.write(lprint, "('LMIN, LDIST, LY =', 3i5)", &fv![lmin, ldist_right, ly]);
            }
            let ldist_max = ldist_left.max(ldist_right);
            kystrt = ly - ldist_max;
            kyend = ly + ldist_max;
            let mut count: f32 = 0.0;
            let mut avg_left: f32 = 0.0;
            for jy in (kystrt - nwndo)..=(kystrt - 1) {
                count = count + 1.0;
                if dump {
                    self.io.write(lprint, "(i5, 1pe15.7)", &fv![jy, bf(basisf, jy)]);
                }
                if count > 0.0 {
                    avg_left = avg_left + bf(basisf, jy);
                }
            }
            avg_left = avg_left / count;
            if dump {
                self.io.write(lprint, "(i4, 1pe15.7/)", &fv![nint(count), avg_left]);
            }
            count = 0.0;
            let mut avg_right: f32 = 0.0;
            for jy in (kyend + 1)..=(kyend + nwndo) {
                count = count + 1.0;
                if dump {
                    self.io.write(lprint, "(i5, 1pe15.7)", &fv![jy, bf(basisf, jy)]);
                }
                avg_right = avg_right + bf(basisf, jy);
            }
            if count > 0.0 {
                avg_right = avg_right / count;
            }
            if dump {
                self.io.write(lprint, "(i4, 1pe15.7/)", &fv![nint(count), avg_right]);
            }
            // Subtracting AVG from every point in the peak range equals an unbiased
            // line through the bordering regions; robust to neighboring peaks.
            let avg = 0.5 * (avg_left + avg_right);
            let mut area_met: f32 = 0.0;
            for jy in kystrt..=kyend {
                area_met = area_met + bf(basisf, jy);
                if dump {
                    self.io.write(lprint, "(i5, 1pe15.7)", &fv![jy, bf(basisf, jy)]);
                }
            }
            if lprint > 0 {
                self.io.write(lprint, "('Uncorrected AREA_MET =', 1pe13.5)", &fv![area_met]);
            }
            area_met = area_met - (kyend - kystrt + 1) as f32 * avg;
            if self.c.n1hmet <= 0 || self.c.attmet <= 0.0 {
                self.errmes(2, 3, CHSUBP)?;
                break 'l800;
            }
            // PPMINC_ARG makes it an area rather than just the FFT sum.
            areaba = ppminc_arg * area_met / (self.c.n1hmet as f32 * self.c.attmet);
            if lprint > 0 {
                self.io.write(lprint, "('Normalized area of reference Basis singlet =', 1pe15.5/)", &fv![areaba]);
            }
            // If AREABA<=0, neither water-scaling nor scaling of simulated spectra is possible.
            if areaba <= 0.0 {
                self.errmes(3, 3, CHSUBP)?;
            }
        }
        // 800
        if self.c.sptype.sub(1, 10).eq_str("mega-press") {
            for jy in 1..=ndata_arg {
                basisf[(jy - 1) as usize] = -basisf[(jy - 1) as usize];
            }
        }
        Ok(areaba)
    }

    /// COMBIS: NCOMPO and LCOMPO for combinations of metabolites (CHCOMB).
    pub fn combis(&mut self) -> R<()> {
        const CHSUBP: &str = "COMBIS";
        self.c.ncombi = self.c.ncombi.min(MPMET);
        // Special case: eliminate combinations of 2's if all 3 of Cho, GPC & PCh
        // and CHCOMB=Cho+GPC+PCh are present.
        let mut ncho = 0;
        for jmetab in 1..=self.c.nmetab {
            self.c.nacom2[jmetab].set(" ");
            let n = &self.c.nacomb[jmetab];
            if n.eq_str("Cho") || n.eq_str("GPC") || n.eq_str("PCh") {
                ncho += 1;
            }
        }
        'l100: {
            if ncho >= 3 {
                'l54: {
                    for jcombi in 1..=self.c.ncombi {
                        if self.c.chcomb[jcombi].eq_str("Cho+GPC+PCh") {
                            break 'l54;
                        }
                    }
                    break 'l100;
                }
                for _jtry in 1..=3 {
                    let mut found = 0;
                    for jcombi in 1..=self.c.ncombi {
                        let c = &self.c.chcomb[jcombi];
                        if c.eq_str("GPC+PCh") || c.eq_str("GPC+Cho") || c.eq_str("PCh+Cho") {
                            found = jcombi;
                            break;
                        }
                    }
                    if found == 0 {
                        break 'l100;
                    }
                    // 57
                    self.c.ncombi -= 1;
                    for j in found..=self.c.ncombi {
                        let next = self.c.chcomb[j + 1].clone();
                        self.c.chcomb[j].set_f(&next);
                    }
                }
            }
        }
        // 100
        let mut jconc = self.c.nmetab;
        'l110: for jcombi in 1..=self.c.ncombi {
            jconc += 1;
            if jconc > MCONC {
                self.errmes(1, 4, CHSUBP)?;
            }
            let cc = self.c.chcomb[jcombi].clone();
            self.c.nacomb[jconc].set_f(&cc);
            let c2 = self.c.chcom2[jcombi].clone();
            self.c.nacom2[jconc].set_f(&c2);
            self.c.table_top[jconc] = true;
            self.c.ncompo[jconc] = 0;
            let mut istart = 1;
            for _kmetab in 1..=self.c.nmetab {
                let mut length = cc.sub_from(istart).index("+") - 1;
                let atend = length == -1;
                if atend {
                    // No more + characters.
                    length = cc.sub_from(istart).index(" ") - 1;
                    if length == -1 {
                        length = cc.len() as i32 + 1 - istart;
                    }
                }
                if length > MCHMET {
                    if self.c.lprint > 0 {
                        self.io.write(self.c.lprint, "(' Incorrect CHCOMB =',A)", &fv![&cc]);
                    }
                    self.errmes(2, 4, CHSUBP)?;
                }
                let mut jfound = 0;
                for jmetab in 1..=self.c.nmetab {
                    let n = &self.c.nacomb[jmetab];
                    if n.index(" ") - 1 == length {
                        if cc.sub(istart, istart + length - 1).eq_f(&n.sub(1, length)) {
                            jfound = jmetab;
                            break;
                        }
                    }
                }
                if jfound == 0 {
                    jconc -= 1;
                    continue 'l110;
                }
                // 135
                self.c.ncompo[jconc] += 1;
                istart = istart + length + 1;
                if self.c.ncompo[jconc] > MCOMPO {
                    if self.c.lprint > 0 {
                        self.io.write(self.c.lprint, "(' Incorrect CHCOMB =',A)", &fv![&cc]);
                    }
                    self.errmes(3, 4, CHSUBP)?;
                }
                let nc = self.c.ncompo[jconc];
                self.c.lcompo[(nc, jconc)] = jfound;
                self.c.table_top[jconc] = self.c.table_top[jconc] && self.c.table_top[jfound];
                if atend {
                    continue 'l110;
                }
            }
            jconc -= 1;
        }
        self.c.nconc = jconc;
        let mut jline = 0;
        for jconc in 1..=self.c.nconc {
            if self.c.table_top[jconc] {
                jline += 1;
                self.c.iconc_line_table[jline] = jconc;
            }
        }
        self.c.ntable_top = jline;
        for jconc in 1..=self.c.nconc {
            if !self.c.table_top[jconc] {
                jline += 1;
                self.c.iconc_line_table[jline] = jconc;
            }
        }
        Ok(())
    }
}

/// GETPHA: optimal 0-order phase correction, the one minimizing the sum of
/// absolute differences of spectral values equally distant from the maximum
/// of the smoothed real spectrum between KYSTRT and KYEND, normalized by
/// abs(max - min).  DATAW holds the smoothed spectrum (PPMINC2 spacing) on
/// input and the phased DATAF on output.
pub fn getpha(
    kystrt: &mut i32,
    kyend: &mut i32,
    dataf: &[C32],
    dataw: &mut [C32],
    nunfil: i32,
    radian: f32,
    nypeak: &mut i32,
    yorig: &mut [f32],
    yinterp: &mut [f32],
    degzer_calc: &mut f32,
    q: &mut ErrQueue,
) -> R<()> {
    const CHSUBP: &str = "GETPHA";
    const NINTERP: i32 = 10;
    let mut dataw = V1Mut::new(dataw);
    let dataf = V1::new(dataf);
    let mut yorig = V1Mut::new(yorig);
    let mut yinterp = V1Mut::new(yinterp);
    // Main loop through 0-order phase angles.
    let cfinc = cmplx(0.0, radian).exp();
    let mut cfact = cmplx(1.0, 0.0);
    let mut cfact_best = cfact;
    let mut absmin: f32 = 1.0e30;
    let mut kystrt_best = 999999;
    let mut kyend_best = -999999;
    'l110: for jdeg in 1..=360 {
        cfact = cfact * cfinc;
        // YORIG = real part of spectrum with trial 0-order phase.
        for jy in 1i32.max(*kystrt - 2 - *nypeak)..=nunfil.min(*kyend + 2 + *nypeak) {
            yorig[jy] = (dataw[jy] * cfact).re;
        }
        // LY is at max in a smoothed YORIG
        let mut rmin: f32 = 1.0e37;
        let mut rmax: f32 = -1.0e37;
        let mut ly = 999999;
        for jy in *kystrt..=*kyend {
            let term = yorig[jy];
            if term > rmax {
                rmax = term;
                ly = jy;
            }
            if term < rmin {
                rmin = term;
            }
        }
        if rmax + rmin <= 0.0 {
            continue 'l110;
        }
        // Center test region at LY
        let kystrt_new = ly - *nypeak / 2;
        let kyend_new = ly + *nypeak / 2;
        if kystrt_new <= 2 || kyend_new >= nunfil - 1 {
            q.errmes(1, 4, CHSUBP)?;
        }
        *nypeak = kyend_new - kystrt_new + 1;
        // YINTERP = YORIG linearly interpolated at NINTERP points on each side,
        // since the peak may not be at the center of symmetry on the grid.
        let mut fract: f32 = 1.0;
        let rinterp = NINTERP as f32;
        let delta_fract = 0.5 / rinterp;
        for jinterp in 1..=(2 * NINTERP + 1) {
            fract = fract - delta_fract;
            let fract2 = 1.0 - fract;
            if jinterp == NINTERP {
                fract = 1.0;
            }
            if jinterp < NINTERP {
                for jy in (kystrt_new - 1)..=(kyend_new + 1) {
                    yinterp[jy] = fract * yorig[jy] + fract2 * yorig[jy - 1];
                }
            } else {
                for jy in (kystrt_new - 1)..=(kyend_new + 1) {
                    yinterp[jy] = fract * yorig[jy] + fract2 * yorig[jy + 1];
                }
            }
            rmax = yorig[ly];
            rmin = rmax;
            let mut sum: f32 = 0.0;
            for jyrel in 1..=(*nypeak / 2) {
                rmax = rmax.max(yinterp[ly + jyrel]).max(yinterp[ly - jyrel]);
                rmin = rmin.min(yinterp[ly + jyrel]).min(yinterp[ly - jyrel]);
                sum = sum + (jyrel as f32).sqrt() * (yinterp[ly + jyrel] - yinterp[ly - jyrel]).abs();
            }
            let span = rmax - rmin;
            if span <= 0.0 {
                continue 'l110;
            }
            let acrit = sum / span;
            if acrit < absmin {
                kystrt_best = kystrt_new;
                kyend_best = kyend_new;
                absmin = acrit;
                *degzer_calc = jdeg as f32;
                cfact_best = cfact;
            }
        }
    }
    *kystrt = kystrt_best;
    *kyend = kyend_best;
    *nypeak = *kyend - *kystrt + 1;
    for j in 1..=nunfil {
        dataw[j] = dataf[j] * cfact_best;
    }
    Ok(())
}

/// INTEGRATE: crude integration of a peak (PPMINC2 spacing) between KYSTRT
/// and KYEND, with the baseline the line through the means over the two
/// bordering regions NWNDO wide.  The range is shrunk symmetrically to 1 point
/// beyond the max distance (over both sides) of the min from the peak.
pub fn integrate(dataf: &[C32], ppminc2: f32, rinteg: &mut f32, kyend: &mut i32, kystrt: &mut i32, ly: i32, nunfil: i32, nwndo: i32) {
    let dataf = V1::new(dataf);
    let mut rmin: f32 = 1.0e30;
    let mut lmin = *kystrt;
    for jy in *kystrt..=(ly - 1) {
        let term = dataf[jy].re;
        if term < rmin {
            rmin = term;
            lmin = jy;
        }
    }
    let ldist_left = ly - lmin;
    rmin = 1.0e30;
    lmin = *kyend;
    for jy in (ly + 1)..=*kyend {
        let term = dataf[jy].re;
        if term < rmin {
            rmin = term;
            lmin = jy;
        }
    }
    let ldist_right = lmin - ly;
    let ldist_max = ldist_left.max(ldist_right);
    *kystrt = ly - ldist_max;
    *kyend = ly + ldist_max;
    let mut count: f32 = 0.0;
    let mut avg_left: f32 = 0.0;
    for jy in 1i32.max(*kystrt - nwndo)..=(*kystrt - 1) {
        count = count + 1.0;
        avg_left = avg_left + dataf[jy].re;
    }
    avg_left = avg_left / count;
    count = 0.0;
    let mut avg_right: f32 = 0.0;
    for jy in (*kyend + 1)..=nunfil.min(*kyend + nwndo) {
        count = count + 1.0;
        avg_right = avg_right + dataf[jy].re;
    }
    avg_right = avg_right / count;
    // Subtracting AVG equals an unbiased line through the bordering regions.
    let avg = 0.5 * (avg_left + avg_right);
    *rinteg = 0.0;
    for jy in *kystrt..=*kyend {
        *rinteg = *rinteg + dataf[jy].re;
    }
    *rinteg = *rinteg - (*kyend - *kystrt + 1) as f32 * avg;
    *rinteg = *rinteg * ppminc2;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn namelist_output_matches_gfortran() {
        let seq = FStr::new(5, "PRESS");
        let recs = nml_records("seqpar", &[("fwhmba", NmlOut::R(0.1)), ("hzpppm", NmlOut::R(127.786142)), ("echot", NmlOut::R(-1.0)), ("seq", NmlOut::S(&seq))]);
        assert_eq!(recs, vec!["&SEQPAR", " FWHMBA= 0.100000001    ,", " HZPPPM=  127.786140    ,", " ECHOT= -1.00000000    ,", " SEQ=\"PRESS\",", " /"]);
        assert_eq!(nml_real(5e-4), "  5.00000024E-04");
        assert_eq!(nml_real(1.0e-20), "  9.99999968E-21");
        assert_eq!(nml_real(123456789.0), "  123456792.    ");
        assert_eq!(nml_real(0.0), "  0.00000000    ");
        assert_eq!(nml_real(1.5e10), "  1.50000005E+10");
        assert_eq!(nml_real(-3.25e-7), " -3.25000002E-07");
        assert_eq!(nml_real(99999.99), "  99999.9922    ");
        assert_eq!(nml_real(0.001), "  1.00000005E-03");
        assert_eq!(nml_real(1.0e7), "  10000000.0    ");
        assert_eq!(nml_real(1.0e8), "  100000000.    ");
        assert_eq!(nml_real(1.0e9), "  1.00000000E+09");
        let r = nml_records("basis", &[("ishift", NmlOut::I(-12)), ("ndatab", NmlOut::I(1024))]);
        assert_eq!(r[1], " ISHIFT=-12        ,");
        assert_eq!(r[2], " NDATAB=1024       ,");
    }

    #[test]
    fn combis_builds_combinations() {
        let mut l = Lcm::new();
        let names = ["Cho", "GPC", "PCh", "NAA", "NAAG", "Cr"];
        l.c.nmetab = names.len() as i32;
        for (k, n) in names.iter().enumerate() {
            l.c.nacomb[k as i32 + 1].set(n);
            l.c.table_top[k as i32 + 1] = true;
        }
        let combs = ["GPC+PCh", "NAA+NAAG", "Cho+GPC+PCh", "Cr+PCr"];
        l.c.ncombi = combs.len() as i32;
        for (k, n) in combs.iter().enumerate() {
            l.c.chcomb[k as i32 + 1].set(n);
        }
        l.combis().unwrap();
        // GPC+PCh removed; Cr+PCr dropped because PCr is absent.
        assert_eq!(l.c.ncombi, 3);
        assert_eq!(l.c.nconc, 8);
        assert_eq!(l.c.nacomb[7].trim(), "NAA+NAAG");
        assert_eq!(l.c.nacomb[8].trim(), "Cho+GPC+PCh");
        assert_eq!(l.c.ncompo[8], 3);
        assert_eq!((l.c.lcompo[(1, 8)], l.c.lcompo[(2, 8)], l.c.lcompo[(3, 8)]), (1, 2, 3));
        assert_eq!(l.c.ntable_top, 8);
    }
}
