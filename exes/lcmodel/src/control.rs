//! Control input, data input, error messages and initialisation (MYCONT ... ILEN).
//!
//! Translated from LCModel.f 6.3-1N; see PORTING.md.
#![allow(unused_variables, unused_mut, unused_assignments, unused_imports, unreachable_code, unused_labels, clippy::all)]

use crate::format::{self, FVal, RKind, ReadErr};
use crate::fortran::*;
use crate::io::{self, Namelist, NmlAssign, Units, STDOUT};
use crate::numerics::{cfft, cfftin, csft_r, csftin_r, diff, seqtot};
use crate::state::*;
use crate::{fv, ErrQueue, Lcm};

/// LINE*(mch_line_long) in MYCONT and LOADCH.
const MCH_LINE_LONG: i32 = MCHSIMUL + 12;
/// MSAMPLES in UPDATE_PRIORS.
const MSAMPLES: i32 = 4096;
/// MCHANNEL in AVERAGE.
const MCHANNEL: i32 = 2048;
/// MDEVX in DATAIN.
const MDEVX: i32 = 400;

/// ERTYPE in ERRMES.
const ERTYPE: [&str; 5] = ["    INFORMATION", "        WARNING", "NON-FATAL ERROR", "    FATAL ERROR", " ILLOGICAL STOP"];

/// SAVEd and static locals of this module's subprograms.
#[derive(Clone, Debug)]
pub struct Saves {
    // RESTORE_SETTINGS
    chrato_sav: FArr1<FStr>,
    degppm_sav: f32,
    degzer_sav: f32,
    fcalib_sav: f32,
    fwhmst_sav: f32,
    hzref_sav: FArr2<f32>,
    lcoord_sav: i32,
    lcoraw_sav: i32,
    lprint_sav: i32,
    ltable_sav: i32,
    miter1_sav: i32,
    ndegz_sav: FArr1<i32>,
    ndgppm_sav: FArr1<i32>,
    nlin_sav: i32,
    nnolsh_sav: i32,
    nnot1_sav: i32,
    npar_sav: i32,
    nrefpk_sav: FArr1<i32>,
    ppmref_sav: FArr2<f32>,
    sdmshf_sav: f32,
    title_sav: FStr,
    // UPDATE_PRIORS
    degzer_sample: FArr1<f32>,
    initial: bool,
    nsamples: i32,
    rppminc_shift: f32,
    sddegp_min: f32,
    sddegz_min: f32,
    sum: FArr1<f32>,
    sum2: FArr1<f32>,
    // OPEN_OUTPUT
    lchcol: i32,
    lchrow: i32,
    lchslic: i32,
    lchcol_st: i32,
    lchrow_st: i32,
    lchslic_st: i32,
    splcoo: [FStr; 2],
    splcor: [FStr; 2],
    splpri: [FStr; 2],
    splps: [FStr; 2],
    spltab: [FStr; 2],
    // DATAIN
    havlin: bool,
    /// DATA'd and SAVEd in DATAIN but never used there.
    #[allow(dead_code)]
    wdone: bool,
    // MYDATA
    bruker_h2o: bool,
    bruker_raw: bool,
    fmtdat_h2o: FStr,
    fmtdat_raw: FStr,
    id: FStr,
    scale_h2o: f32,
    scale_raw: f32,
    seqacq_h2o: bool,
    seqacq_raw: bool,
    // PHASE_WITH_MAX_REAL
    sddegz_done: bool,
    // ECC_TRUNCATE: H2OT_WORK(MDATA) is a local array of every subprogram
    // including lcmodel.inc (static in gfortran); blank COMMON AWORK, H2OT_ECC.
    h2ot_work: Vec<C32>,
    awork: Vec<f32>,
    h2ot_ecc: Vec<C32>,
    // SMOOTH_TAIL: blank COMMON OUT_IMAG, OUT_REAL, WORK_IN.
    out_imag: Vec<f32>,
    out_real: Vec<f32>,
    work_in: Vec<f32>,
}

impl Default for Saves {
    fn default() -> Self {
        let lsplit = (MCHFIL + 1) as usize;
        Saves {
            chrato_sav: fstr_arr1(MMETAB as usize, 264),
            degppm_sav: 0.0,
            degzer_sav: 0.0,
            fcalib_sav: 0.0,
            fwhmst_sav: 0.0,
            hzref_sav: FArr2::new(MREFPK as usize, 2),
            lcoord_sav: 0,
            lcoraw_sav: 0,
            lprint_sav: 0,
            ltable_sav: 0,
            miter1_sav: 0,
            ndegz_sav: FArr1::new(2),
            ndgppm_sav: FArr1::new(3),
            nlin_sav: 0,
            nnolsh_sav: 0,
            nnot1_sav: 0,
            npar_sav: 0,
            nrefpk_sav: FArr1::new(2),
            ppmref_sav: FArr2::new(MREFPK as usize, 2),
            sdmshf_sav: 0.0,
            title_sav: FStr::blank(244),
            degzer_sample: FArr1::new(MSAMPLES as usize),
            initial: true,
            nsamples: 0,
            rppminc_shift: 5.0,
            sddegp_min: 1.0,
            sddegz_min: 3.0,
            sum: FArr1::new(4),
            sum2: FArr1::new(3),
            lchcol: 0,
            lchrow: 0,
            lchslic: 0,
            lchcol_st: 0,
            lchrow_st: 0,
            lchslic_st: 0,
            splcoo: [FStr::blank(lsplit), FStr::blank(lsplit)],
            splcor: [FStr::blank(lsplit), FStr::blank(lsplit)],
            splpri: [FStr::blank(lsplit), FStr::blank(lsplit)],
            splps: [FStr::blank(lsplit), FStr::blank(lsplit)],
            spltab: [FStr::blank(lsplit), FStr::blank(lsplit)],
            havlin: false,
            wdone: false,
            bruker_h2o: false,
            bruker_raw: false,
            fmtdat_h2o: FStr::blank(MCHFMT as usize),
            fmtdat_raw: FStr::blank(MCHFMT as usize),
            id: FStr::blank(MCHID as usize),
            scale_h2o: 0.0,
            scale_raw: 0.0,
            seqacq_h2o: false,
            seqacq_raw: false,
            sddegz_done: false,
            h2ot_work: vec![C32::ZERO; MDATA as usize],
            // AWORK is read up to LMAX+2 <= NDATA in ECC_TRUNCATE.
            awork: vec![0.0; MDATA as usize],
            h2ot_ecc: vec![C32::ZERO; MUNFIL as usize],
            out_imag: vec![0.0; MUNFIL as usize],
            out_real: vec![0.0; MUNFIL as usize],
            work_in: vec![0.0; MUNFIL as usize],
        }
    }
}

/// Local variables of NAMELIST /NMID/ ID, FMTDAT, TRAMP, VOLUME, SEQACQ, BRUKER.
struct Nmid {
    id: FStr,
    fmtdat: FStr,
    tramp: f32,
    volume: f32,
    seqacq: bool,
    bruker: bool,
}

impl Nmid {
    fn new() -> Self {
        Nmid { id: FStr::blank(MCHID as usize), fmtdat: FStr::blank(MCHFMT as usize), tramp: 0.0, volume: 0.0, seqacq: false, bruker: false }
    }
}

/// READ (U, NML=NMID): false for the ERR=/END= branch.
fn read_nmid(io: &mut Units, unit: i32, v: &mut Nmid) -> bool {
    let nml = match io.read_nml(unit, "NMID") {
        Ok(n) => n,
        Err(_) => return false,
    };
    for it in &nml.items {
        let r = match it.name.as_str() {
            "id" => v.id.nml_assign(&it.subs, &it.values),
            "fmtdat" => v.fmtdat.nml_assign(&it.subs, &it.values),
            "tramp" => v.tramp.nml_assign(&it.subs, &it.values),
            "volume" => v.volume.nml_assign(&it.subs, &it.values),
            "seqacq" => v.seqacq.nml_assign(&it.subs, &it.values),
            "bruker" => v.bruker.nml_assign(&it.subs, &it.values),
            other => Err(format!("{other} is not a variable of namelist NMID")),
        };
        if r.is_err() {
            return false;
        }
    }
    true
}

/// Formatted READ of N COMPLEX values: `(A(J), J=1,N)`.
fn read_complex(io: &mut Units, unit: i32, fmt: &str, n: i32, a: &mut FArr1<C32>) -> bool {
    let kinds = vec![RKind::C; n.max(0) as usize];
    match io.read(unit, fmt, &kinds) {
        Ok(vals) => {
            for (k, v) in vals.iter().enumerate() {
                if let FVal::C(c) = v {
                    a[k as i32 + 1] = *c;
                }
            }
            true
        }
        Err(_) => false,
    }
}

/// Values of one namelist member for NAMELIST output.
enum NmlOut {
    I(Vec<i32>),
    R(Vec<f32>),
    D(Vec<f64>),
    L(Vec<bool>),
    S(Vec<String>),
}

/// gfortran's list-directed REAL (kind 4) item: 1PG16.9E2 with 9 significant
/// digits in either form.
fn nml_real4(x: f32) -> String {
    if x == 0.0 {
        let s = if x.is_sign_negative() { "-0.00000000" } else { "0.00000000" };
        return format!("{:>12}    ", s);
    }
    let g = format::fmt_g(x as f64, 16, 9, Some(2), 1, false, true);
    if g.contains('E') {
        return format::fmt_e(x as f64, 16, 8, Some(2), 1, false, 'E', true);
    }
    g
}

/// gfortran's list-directed DOUBLE PRECISION item: 17 significant digits,
/// width 25, 3-digit exponent.
fn nml_real8(x: f64) -> String {
    if x == 0.0 {
        let s = if x.is_sign_negative() { "-0.0000000000000000" } else { "0.0000000000000000" };
        return format!("{:>20}     ", s);
    }
    let g = format::fmt_g(x, 25, 17, Some(3), 1, false, false);
    if g.contains('E') {
        return format::fmt_e(x, 25, 16, Some(3), 1, false, 'E', false);
    }
    g
}

/// Records of `WRITE (U, NML=GROUP)` as gfortran writes them (DELIM='QUOTE',
/// repeat counts for equal neighbours, a new line after every 6 values).
fn nml_write_records(group: &str, members: &[(&str, NmlOut)]) -> Vec<String> {
    let mut recs = Vec::new();
    let mut cur = format!("&{}", group.to_ascii_uppercase());
    for (name, vals) in members {
        recs.push(std::mem::take(&mut cur));
        cur = format!(" {}=", name.to_ascii_uppercase());
        let n = match vals {
            NmlOut::I(v) => v.len(),
            NmlOut::R(v) => v.len(),
            NmlOut::D(v) => v.len(),
            NmlOut::L(v) => v.len(),
            NmlOut::S(v) => v.len(),
        };
        // Equality as gfortran tests it: memcmp of the element.
        let same = |a: usize, b: usize| -> bool {
            match vals {
                NmlOut::I(v) => v[a] == v[b],
                NmlOut::R(v) => v[a].to_bits() == v[b].to_bits(),
                NmlOut::D(v) => v[a].to_bits() == v[b].to_bits(),
                NmlOut::L(v) => v[a] == v[b],
                NmlOut::S(v) => v[a] == v[b],
            }
        };
        let mut num = 1;
        let mut rep_ctr = 1;
        for e in 0..n {
            if e + 1 < n && same(e, e + 1) {
                rep_ctr += 1;
                continue;
            }
            let no_leading_blank = rep_ctr > 1;
            if rep_ctr > 1 {
                cur.push_str(&format!(" {}*", rep_ctr));
            }
            num += 1;
            let text = match vals {
                NmlOut::I(v) => format!("{:<11}", v[e]),
                NmlOut::R(v) => {
                    let s = nml_real4(v[e]);
                    if no_leading_blank {
                        format!("{:<16}", s.trim_start())
                    } else {
                        s
                    }
                }
                NmlOut::D(v) => {
                    let s = nml_real8(v[e]);
                    if no_leading_blank {
                        format!("{:<25}", s.trim_start())
                    } else {
                        s
                    }
                }
                NmlOut::L(v) => (if v[e] { "T" } else { "F" }).to_string(),
                NmlOut::S(v) => format!("\"{}\"", v[e].replace('"', "\"\"")),
            };
            cur.push_str(&text);
            cur.push(',');
            if num > 5 {
                num = 0;
                recs.push(std::mem::take(&mut cur));
                cur = " ".to_string();
            }
            rep_ctr = 1;
        }
    }
    recs.push(cur);
    recs.push(" /".to_string());
    recs
}

/// The Fortran unit's view of a CHARACTER*n value: `FStr::new(n, s)`.
fn fstr(n: i32, s: &str) -> FStr {
    FStr::new(n as usize, s)
}

impl Lcm {
    // ------------------------------------------------------------------------
    // MYCONT
    // ------------------------------------------------------------------------

    /// Inputs changes to Control Variables (NAMELIST /LCMODL/ on standard input).
    pub fn mycont(&mut self) -> R<()> {
        const CHSUBP: &str = "MYCONT";
        let mut is_sptype = false;
        let mut standard_refs = false;
        let mut fwhmba_sav = 0.0f32;
        // Copy LCONTR to LCONTR_SCRATCH (STDIN cannot always be rewound).
        let lcontr_scratch = self.c.lcontr_scratch;
        let lcontr = self.c.lcontr;
        self.io.open_scratch(lcontr_scratch);
        for jline in 1..=9999 {
            let text = match self.io.read_line(lcontr) {
                Ok(t) => t,
                Err(_) => break,
            };
            let line = fstr(MCH_LINE_LONG, &text);
            let llen = ilen(&line);
            self.io.write_records(lcontr_scratch, vec![line.sub(1, llen).as_str()]);
        }
        // Label 105.
        self.io.rewind(lcontr_scratch);
        self.read_lcmodl(CHSUBP)?;
        // At long TE, delete ratio prior for GSH/(Gln+GSH).
        if self.c.echot > 49.0 {
            self.c.nratio = 12;
        }
        // For high fields, reset Lip* & MM* to sharper values; remove ratio
        // constraint on Tau (assuming rodent).
        if self.c.hzpppm > self.c.hifmm {
            self.c.chsimu[1].set("Lip13a @ 1.28 +- .01 FWHM= .05 < .07 +- .02                       AMP= 2.");
            self.c.chsimu[2].set("Lip13b @ 1.28 +- .01 FWHM= .029 < .03 +- .02                      AMP= 2.");
            self.c.chsimu[3].set("Lip13c @ 1.30 +- .01 FWHM= .029 < .03 +- .02                      AMP= 2.");
            self.c.chsimu[4].set("Lip13d @ 1.26 +- .01 FWHM= .029 < .03 +- .02                      AMP= 2.");
            self.c.chsimu[5].set("Lip09 @ .89 +- .02 FWHM= .05 < .07 +- .02                         AMP= 3.");
            self.c.chsimu[6].set("MM09 @ .91 +- .02 FWHM= .05 < .06 +- .01                          AMP= 3.");
            self.c.chsimu[7].set("Lip20 @ 2.04 +- .005 FWHM=.05 < .07 +- .02                        AMP=1.33  @ 2.25 FWHM=.05 AMP=.67                                 @ 2.8 FWHM=.07 AMP=.87");
            self.c.chsimu[8].set("MM20 @ 2.08 +- .005 FWHM=.05 < .06 +- .01                         AMP=1.33  @ 2.25 FWHM=.07 AMP=.33                                 @1.95 FWHM=.05 AMP=.33  @ 3. FWHM=.07 AMP=.4");
            self.c.chsimu[9].set("MM12 @ 1.21 +- .01 FWHM= .05 < .07 +- .02 AMP= 2.");
            self.c.chsimu[10].set("MM14 @ 1.43 +- .02 FWHM= .06 < .07 +- .02 AMP= 2.");
            self.c.chsimu[11].set("MM17 @ 1.67 +- .03 FWHM= .05 < .06 +- .02 AMP= 2.");
            self.c.nnorat = 1;
            self.c.norato[1].set("Tau");
        }
        if self.c.nunfil < 64 {
            self.errmes(12, 4, CHSUBP)?;
        }
        remove_blank_start(&mut self.c.sptype);
        if self.c.nchgam > 0 && !self.c.chgam.is_blank() && self.c.dkngam > 0.0 && self.c.nchgam <= MCHGAM && self.c.sptype.is_blank() {
            if self.c.filbas.index_f(&self.c.chgam.sub(1, self.c.nchgam)) > 0 && self.c.hzpppm >= self.c.hzpgam[1] && self.c.hzpppm <= self.c.hzpgam[2] {
                self.c.dkntmn[1] = self.c.dkngam;
            }
        }
        toupper_lower(false, &mut self.c.sptype);
        is_sptype = false;
        is_sptype = false;
        if self.c.sptype.sub(1, 3).eq_str("csf") {
            is_sptype = true;
            self.c.nnorat = 5;
            self.c.norato[1].set("Asp");
            self.c.norato[2].set("GABA");
            self.c.norato[3].set("Glc");
            self.c.norato[4].set("Scyllo");
            self.c.norato[5].set("Tau");
            self.c.nratio = 13;
            self.c.reflac = true;
            self.c.useglc = true;
        }
        if self.c.sptype.sub(1, 6).eq_str("nulled") {
            is_sptype = true;
            self.c.badref = true;
            self.c.incsmx = 1;
            self.c.namrel.set("Lip13a+Lip13b");
            self.c.nobasi = true;
            self.c.nratio = 6;
            self.c.nrefpk[2] = 2;
            self.c.nsidmn = 1;
            self.c.nsidmx = 1;
            self.c.nsimul = 11;
            self.c.ppmref[(1, 2)] = 1.28_f32;
            self.c.ppmref[(2, 2)] = 0.90_f32;
            self.c.vitro = true;
        }
        if self.c.sptype.sub(1, 5).eq_str("tumor") {
            is_sptype = true;
            self.c.badref = true;
            self.c.chrato[13].set("NAAG/NAA = .15 +- .15");
            self.c.chuse1[1].set("GPC");
            self.c.chuse1[2].set("Cr");
            self.c.dkntmn[1] = 0.35_f32;
            self.c.namrel.set("GPC");
            self.c.nrefpk[2] = 4;
            self.c.nratio = 13;
            self.c.nuse1 = 2;
            self.c.ppmend = 0.2_f32;
            self.c.ppmref[(1, 2)] = 3.03_f32;
            self.c.ppmref[(2, 2)] = 3.22_f32;
            self.c.ppmref[(3, 2)] = 1.28_f32;
            self.c.ppmref[(4, 2)] = 0.90_f32;
            self.c.rbackg[1] = 12.0_f32;
            self.c.shifmn[2] = -0.07_f32;
            self.c.shifmx[2] = 0.07_f32;
        }
        self.sptype_muscle(&mut is_sptype);
        self.sptype_liver(&mut is_sptype);
        self.sptype_lipid(&mut is_sptype);
        if self.c.sptype.sub(1, 7).eq_str("muscle-") || self.c.sptype.sub(1, 6).eq_str("liver-") || self.c.sptype.sub(1, 7).eq_str("breast-") || self.c.sptype.sub(1, 6).eq_str("lipid-") {
            self.c.biglip = true;
            self.c.ppm_truncate_max = 3.5;
            self.c.ppm_truncate_min = 2.2;
        }
        if !(is_sptype || self.c.sptype.sub(1, 8).eq_str("version5") || self.c.sptype.sub(1, 9).eq_str("version-5") || self.c.sptype.sub(1, 1).eq_str(" ")) {
            self.errmes(8, 4, CHSUBP)?;
        }
        // Overwrite above defaults by rereading Namelist.
        self.io.rewind(lcontr_scratch);
        fwhmba_sav = self.c.fwhmba;
        self.c.fwhmba = -0.1;
        self.read_lcmodl(CHSUBP)?;
        // Red herring; nothing will be done here.
        if self.c.ldwfft > 0 {
            self.c.nlin = self.c.nlin + 1024;
        }
        // DOECC must be set before call to AVERAGE.
        self.c.doecc_active = self.c.doecc;
        if self.c.biglip {
            self.c.doecc = self.c.forecc;
        }
        remove_blank_start(&mut self.c.sptype);
        toupper_lower(false, &mut self.c.sptype);
        if self.c.sptype.sub(1, 8).eq_str("version5") || self.c.sptype.sub(1, 9).eq_str("version-5") {
            self.c.nratio = 0;
            self.c.nsimul = 0;
            self.c.ppmend = 1.0;
            self.c.ppmst = 3.85;
        }
        if self.c.iauto == 1 && self.c.ppmend > 9998.0 {
            if self.c.echot >= 100.0 {
                self.c.ppmend = 1.0;
                self.c.nuse1 = 4;
            }
        }
        if self.c.ppmst < -9998.0 {
            self.c.ppmst = 4.0;
        }
        if self.c.ppmend > 9998.0 {
            self.c.ppmend = 0.2;
        }
        self.c.fwhmba_in_control = self.c.fwhmba > 0.0;
        if !self.c.fwhmba_in_control {
            self.c.fwhmba = fwhmba_sav;
        }
        if self.c.sptype.sub(1, 7).eq_str("muscle-") || self.c.sptype.sub(1, 6).eq_str("liver-") || self.c.sptype.sub(1, 7).eq_str("breast-") || self.c.sptype.sub(1, 6).eq_str("lipid-") {
            if self.c.ppmend >= -0.9 {
                self.errmes(17, 2, CHSUBP)?;
            }
            if self.c.ppmst >= 5.0 {
                if self.c.ppmst <= 7.9 {
                    self.errmes(18, 2, CHSUBP)?;
                }
            } else {
                if self.c.sptype.sub(1, 6).eq_str("liver-") && (self.c.ppmst >= 4.01 || self.c.ppmst <= 3.59) {
                    self.errmes(19, 2, CHSUBP)?;
                }
                if self.c.sptype.sub(1, 7).eq_str("breast-") && (self.c.ppmst <= 3.79 || self.c.ppmst >= 4.01) {
                    self.errmes(20, 2, CHSUBP)?;
                }
                if self.c.sptype.sub(1, 6).eq_str("lipid-") && (self.c.ppmst <= 3.39 || self.c.ppmst >= 4.01) {
                    self.errmes(21, 2, CHSUBP)?;
                }
            }
        }
        if (self.c.sptype.sub(1, 10).eq_str("only-cho-1") || self.c.sptype.sub(1, 10).eq_str("only-cho-2"))
            && (self.c.ppmst <= 3.79 || self.c.ppmst >= 4.01 || self.c.ppmend >= 2.81 || self.c.ppmend <= 2.59)
        {
            self.errmes(22, 2, CHSUBP)?;
        }
        // Setup for no baseline.
        if self.c.nobase {
            self.c.alpbmx = self.c.alpbmn;
            self.c.alpbst = self.c.alpbmn as f32;
            self.c.alpbpn = (r2d(1.0001) * self.c.alpbmn) as f32;
            self.c.idgppm = -1;
            self.c.nbackg = 0;
            self.c.usemxb = false;
        }
        // Reset RBASMX & RSDGP3 (IDGPPM = -1, 0, 1, 2; see the Fortran notes).
        if self.c.idgppm > 0 {
            self.c.rsdgp3 = self.c.rsdgp3.min(1.1);
        }
        if self.c.idgppm == 1 {
            self.c.rbasmx[1] = 0.0;
        }
        // With dongle, omit "Data of:".
        let ownout = fstr(9, "Data of: ").cat(&self.c.owner);
        self.c.ownout.set_f(&ownout);
        let owner = self.c.owner.clone();
        self.c.ownout.set_f(&owner);
        self.c.fwhmst = self.c.fwhmst.min(self.c.fwhmmx);
        // USEGLC = T to add Glc to Preliminary Analysis.
        if self.c.useglc && self.c.nuse1.max(self.c.nkeep) < MMETAB_EXTRA {
            self.c.nkeep = 1.max(self.c.nkeep + 1);
            let nkeep = self.c.nkeep;
            self.c.chkeep[nkeep].set("Glc");
            'l115: {
                for juse1 in 1..=self.c.nuse1 {
                    if self.c.chuse1[juse1].eq_str("Glc") {
                        break 'l115;
                    }
                }
                self.c.nuse1 = self.c.nuse1 + 1;
                let nuse1 = self.c.nuse1;
                self.c.chuse1[nuse1].set("Glc");
            }
        }
        // REFLAC = T to use Lac for referencing and the Preliminary Analysis,
        // provided PPMEND < 1.33.
        if self.c.reflac && self.c.ppmend < 1.33 && self.c.nuse1 < MMETAB_EXTRA {
            'l125: {
                for juse1 in 1..=self.c.nuse1 {
                    if self.c.chuse1[juse1].eq_str("Lac") {
                        break 'l125;
                    }
                }
                self.c.nuse1 = self.c.nuse1 + 1;
                let nuse1 = self.c.nuse1;
                self.c.chuse1[nuse1].set("Lac");
            }
            // Label 125.
            self.c.dorefs[2] = true;
            'l140: {
                for j in 1..=self.c.nrefpk[2] {
                    if (self.c.ppmref[(j, 2)] - 1.33).abs() <= 0.01 && (self.c.hzref[(j, 2)] - 3.6).abs() <= 0.1 {
                        break 'l140;
                    }
                }
                self.c.nrefpk[2] = MREFPK.min(2.max(self.c.nrefpk[2] + 2));
                let n = self.c.nrefpk[2];
                for j in fdo(n, 3, -1) {
                    self.c.ppmref[(j, 2)] = self.c.ppmref[(j - 2, 2)];
                    self.c.hzref[(j, 2)] = self.c.hzref[(j - 2, 2)];
                }
                self.c.ppmref[(1, 2)] = 1.33;
                self.c.ppmref[(2, 2)] = 1.33;
                self.c.hzref[(1, 2)] = -3.6;
                self.c.hzref[(2, 2)] = 3.6;
            }
        }
        if self.c.quick {
            self.c.ndegz[2] = 3;
            self.c.ndgppm[2] = 1;
            self.c.nshift = 1;
            self.c.dorefs[1] = false;
            self.c.nrefpk[2] = 3;
            self.c.ppmref[(1, 2)] = 2.01;
            self.c.ppmref[(2, 2)] = 3.03;
            self.c.ppmref[(3, 2)] = 3.22;
            self.c.hzref[(1, 2)] = 0.0;
            self.c.hzref[(2, 2)] = 0.0;
            self.c.hzref[(3, 2)] = 0.0;
            self.c.dofull = false;
        }
        // Change CV's for calibration.
        if self.c.ncalib > 0 {
            self.c.nratio = 0;
            self.c.dorefs[2] = true;
            self.c.ncalib = self.c.ncalib.min(MMETAB);
            self.c.nuse1 = self.c.ncalib;
            self.c.vitro = true;
            self.c.dkntmn[2] = 99.0;
            standard_refs = true;
            for j in 1..=self.c.ncalib {
                let ch = self.c.chcali[j].clone();
                self.c.chuse1[j].set_f(&ch);
                standard_refs = standard_refs
                    && (ch.eq_str("Lac") || ch.eq_str("NAA") || ch.eq_str("Cr") || ch.eq_str("Cre") || ch.eq_str("GPC") || ch.eq_str("PCh") || ch.eq_str("Cho"));
            }
            if standard_refs {
                self.c.nrefpk[2] = 0;
                for j in 1..=self.c.ncalib {
                    let ch = self.c.chcali[j].clone();
                    if ch.eq_str("Lac") {
                        self.c.nrefpk[2] = self.c.nrefpk[2] + 2;
                        let n = self.c.nrefpk[2];
                        self.c.ppmref[(n - 1, 2)] = 1.33;
                        self.c.ppmref[(n, 2)] = 1.33;
                        self.c.hzref[(n - 1, 2)] = -3.6;
                        self.c.hzref[(n, 2)] = 3.6;
                    } else if ch.eq_str("NAA") {
                        self.c.nrefpk[2] = self.c.nrefpk[2] + 1;
                        let n = self.c.nrefpk[2];
                        self.c.ppmref[(n, 2)] = 2.01;
                        self.c.hzref[(n, 2)] = 0.0;
                    } else if ch.eq_str("Cr") || ch.eq_str("Cre") {
                        self.c.nrefpk[2] = self.c.nrefpk[2] + 1;
                        let n = self.c.nrefpk[2];
                        self.c.ppmref[(n, 2)] = 3.03;
                        self.c.hzref[(n, 2)] = 0.0;
                    } else if ch.eq_str("Cho") || ch.eq_str("GPC") || ch.eq_str("PCh") {
                        self.c.nrefpk[2] = self.c.nrefpk[2] + 1;
                        let n = self.c.nrefpk[2];
                        self.c.ppmref[(n, 2)] = 3.22;
                        self.c.hzref[(n, 2)] = 0.0;
                    }
                }
            }
        }
        // Change CV's for Basis calibration when BASCAL=T.
        if self.c.bascal {
            self.c.sddegz = self.c.sddegz.min(3.0);
            self.c.sddegp = self.c.sddegp.min(1.0);
            self.c.doecc = false;
            self.c.absval = false;
            self.c.nsimul = 0;
            self.c.nratio = 0;
            self.c.ndslic = 1;
            self.c.ndrows = 1;
            self.c.ndcols = 1;
        }
        // Set IKNTMN DKNTMN & ALPB* for special cases.
        self.c.ikntmn = 1;
        if self.c.vitro {
            self.c.ikntmn = 2;
        }
        let ikntmn = self.c.ikntmn;
        if self.c.dkntmn[ikntmn] <= 0.0 {
            self.errmes(25, 4, CHSUBP)?;
        }
        // Bring DKNTMN into a reasonable range, so that ALPBMX is reasonable.
        if self.c.nbckmn < 4 {
            self.errmes(24, 4, CHSUBP)?;
        }
        self.c.dkntmn[ikntmn] = ((self.c.ppmst - self.c.ppmend) / (self.c.nbckmn - 3) as f32).min(self.c.dkntmn[ikntmn]);
        // The scaling of alphaB with knot spacing is still not invariant; the
        // ALPB* are originally set for DKNTMN_STANDARD.
        let t = self.c.dkntmn[ikntmn] / self.c.dkntmn_standard;
        let scale = t * t * t;
        self.c.alpbmx = self.c.alpbmx * scale as f64;
        self.c.alpbmn = self.c.alpbmn * scale as f64;
        self.c.alpbst = self.c.alpbst * scale;
        self.c.alpbpn = self.c.alpbpn * scale;
        // Fix phases for absolute-value spectra.
        if self.c.absval {
            self.c.fwhmst = 3.0f32.sqrt() * self.c.fwhmst;
            self.c.fwhmmx = 3.0f32.sqrt() * self.c.fwhmmx;
            self.c.degzer = 0.0;
            self.c.degppm = 0.0;
            self.c.sddegz = 0.0;
            self.c.sddegp = 0.0;
        }
        self.c.sddegp_input = self.c.sddegp;
        // Red herring; nothing will be done here.
        if self.c.lwfft > 0 {
            self.c.npar = self.c.npar + 32;
        }
        // Set DOWS according to IAVERG.
        let iaverg = self.c.iaverg;
        if iaverg == 1 || iaverg == 4 {
            self.c.dows = true;
        } else if iaverg == 2 {
            self.c.dows = false;
        } else if iaverg != 0 && iaverg != 3 && iaverg != 31 && iaverg != 32 {
            self.errmes(13, 4, CHSUBP)?;
        }
        // Check and order dimensions ND* I* *SK.
        {
            let c = &self.c;
            let m = c.ndrows.min(c.ndcols).min(c.ndslic).min(c.icolst).min(c.icolen).min(c.irowst).min(c.irowen).min(c.islice);
            if m <= 0 {
                self.errmes(9, 4, CHSUBP)?;
            }
        }
        let mut i1 = self.c.irowst;
        self.c.irowst = self.c.irowst.min(self.c.irowen);
        self.c.irowen = i1.max(self.c.irowen);
        i1 = self.c.icolst;
        self.c.icolst = self.c.icolst.min(self.c.icolen);
        self.c.icolen = i1.max(self.c.icolen);
        if self.c.icolen > self.c.ndcols || self.c.irowen > self.c.ndrows || self.c.islice > self.c.ndslic {
            self.errmes(10, 4, CHSUBP)?;
        }
        self.c.nvoxsk = self.c.nvoxsk.min(MVOXSK);
        for j in 1..=self.c.nvoxsk {
            let c = &self.c;
            if c.irowsk[j].min(c.icolsk[j]) <= 0 || c.irowsk[j] > c.ndrows || c.icolsk[j] > c.ndcols {
                self.errmes(14, 4, CHSUBP)?;
            }
        }
        // Check L* & FIL* (except FILBAS).
        if self.c.lps > 0 && self.c.filps.is_blank() {
            self.errmes(3, -4, CHSUBP)?;
        }
        if self.c.lcoord > 0 && self.c.filcoo.is_blank() {
            self.errmes(4, 4, CHSUBP)?;
        }
        if self.c.lcoraw > 0 && self.c.filcor.is_blank() {
            self.errmes(11, 4, CHSUBP)?;
        }
        if self.c.lcsv > 0 && self.c.filcsv.is_blank() {
            self.errmes(15, 4, CHSUBP)?;
        }
        if self.c.ltable > 0 && self.c.filtab.is_blank() {
            self.errmes(5, 4, CHSUBP)?;
        }
        if self.c.lraw <= 0 || self.c.filraw.is_blank() {
            self.errmes(6, 4, CHSUBP)?;
        }
        if (self.c.dows || self.c.doecc || self.c.unsupr) && (self.c.lh2o <= 0 || self.c.filh2o.is_blank()) {
            self.errmes(7, 4, CHSUBP)?;
        }
        if self.c.imethd == 2 && (self.c.ipowrg != 1 && self.c.ipowrg != 2) {
            self.errmes(23, 4, CHSUBP)?;
        }
        self.c.linerr_mycont = self.c.linerr;
        Ok(())
    }

    /// `READ (LCONTR_SCRATCH, NML=LCMODL, end=801, err=802)`.
    fn read_lcmodl(&mut self, chsubp: &str) -> R<()> {
        let u = self.c.lcontr_scratch;
        let ok = match self.io.read_nml(u, "LCMODL") {
            Err(ReadErr::End) => {
                // Label 801.
                self.errmes(1, -4, chsubp)?;
                false
            }
            Err(ReadErr::Bad(_)) => false,
            Ok(nml) => self.c.apply_lcmodl(&nml).is_ok(),
        };
        if !ok {
            // Label 802.
            self.errmes(2, -4, chsubp)?;
        }
        Ok(())
    }

    /// MYCONT's statements from muscle-1.inc.
    fn sptype_muscle(&mut self, is_sptype: &mut bool) {
        if self.c.sptype.sub(1, 8).eq_str("muscle-1") {
            *is_sptype = true;
            self.c.badref = true;
            self.c.chcomb[1].set("I13d+I13c+I13b+I13a");
            self.c.chcomb[2].set("E15d+E15c+E15b+E15a");
            self.c.chcomb[3].set("Cr2+Cr1");
            self.c.chcomb[4].set("tau5+tau4+tau3+tau2+tau1");
            self.c.chcomb[5].set("cho4+cho3+cho2+cho1");
            self.c.chcomb[6].set("cr28e+cr28d+cr28c+cr28b+cr28a");
            self.c.chcomb[7].set("I09");
            self.c.chcomb[8].set("E11");
            self.c.chcomb[9].set("I21");
            self.c.chcomb[10].set("E23");
            self.c.chcom2[1].set("IMCL13");
            self.c.chcom2[2].set("EMCL15");
            self.c.chcom2[3].set("Cr");
            self.c.chcom2[4].set("tau");
            self.c.chcom2[5].set("cho");
            self.c.chcom2[6].set("cr28");
            self.c.chcom2[7].set("I09");
            self.c.chcom2[8].set("E11");
            self.c.chcom2[9].set("I21");
            self.c.chcom2[10].set("E23");
            self.c.chgrsh[1].set("E15");
            self.c.chgrsh[2].set("I13");
            self.c.chgrsh[3].set("Cr");
            self.c.chnot1[1].set("tau1");
            self.c.chnot1[2].set("tau2");
            self.c.chnot1[3].set("tau3");
            self.c.chnot1[4].set("tau4");
            self.c.chnot1[5].set("tau5");
            self.c.chnot2[1].set("E15e");
            self.c.chnot2[2].set("E15f");
            self.c.chnot2[3].set("I13e");
            self.c.chnot2[4].set("I13f");
            self.c.chsimu[1].set("E15a @1.52+-.01 FWHM=.19<.2+-.006 AMP=2.");
            self.c.chsimu[2].set("E15b @1.52+-.01 FWHM=.16<.17+-.006 AMP=2.");
            self.c.chsimu[3].set("E15c @1.52+-.01 FWHM=.13<.14+-.006 AMP=2.");
            self.c.chsimu[4].set("E15d @1.52+-.01 FWHM=.10<.11+-.006 AMP=2.");
            self.c.chsimu[5].set("E15e @1.54+-.01 FWHM=.16<.17+-.03 AMP=2.");
            self.c.chsimu[6].set("E15f @1.50+-.01 FWHM=.16<.17+-.03 AMP=2.");
            self.c.chsimu[7].set("I13a @1.27+-.01 FWHM=.13<.14+-.004 AMP=2.");
            self.c.chsimu[8].set("I13b @1.27+-.01 FWHM=.10<.11+-.004 AMP=2.");
            self.c.chsimu[9].set("I13c @1.27+-.01 FWHM=.07<.08+-.004 AMP=2.");
            self.c.chsimu[10].set("I13d @1.27+-.01 FWHM=.04<.05+-.004AMP=2.");
            self.c.chsimu[11].set("I13e @1.29+-.01 FWHM=.10<.11+-.02 AMP=2.");
            self.c.chsimu[12].set("I13f @1.25+-.01 FWHM=.10<.11+-.02 AMP=2.");
            self.c.chsimu[13].set("E11 @1.07+-.02 FWHM=.07<.08+-.02 AMP=3.");
            self.c.chsimu[14].set("I09 @.89+-.02 FWHM=.07<.08+-.02 AMP=3.");
            self.c.chsimu[15].set("E23 @2.33+-.03 FWHM=.25<.3+-.03 AMP=1.                             @1.8 FWHM=.74 AMP=1.");
            self.c.chsimu[16].set("I21 @2.15+-.03 FWHM=.23<.28+-.03 AMP=1.1111                       @1.6 FWHM=.74 AMP=.8889");
            self.c.chsimu[17].set("cr28a @2.90+-.004 FWHM=.03<.04+-.004 AMP=3.");
            self.c.chsimu[18].set("cr28b @2.86+-.004 FWHM=.03<.04+-.004 AMP=3.");
            self.c.chsimu[19].set("cr28c @2.82+-.004 FWHM=.03<.04+-.004 AMP=3.");
            self.c.chsimu[20].set("cr28d @2.78+-.004 FWHM=.03<.04+-.004 AMP=3.");
            self.c.chsimu[21].set("cr28e @2.74+-.004 FWHM=.03<.04+-.004 AMP=3.");
            self.c.chsimu[22].set("cho1@3.24+-.003 FWHM=.025<.03+-.003  AMP=9.");
            self.c.chsimu[23].set("cho2@3.21+-.003 FWHM=.025<.03+-.003  AMP=9.");
            self.c.chsimu[24].set("cho3@3.18+-.003 FWHM=.025<.03+-.003  AMP=9.");
            self.c.chsimu[25].set("cho4@3.15+-.003 FWHM=.025<.03+-.003  AMP=9.");
            self.c.chsimu[26].set("Cr1@3.03+-.004 FWHM=.025<.03+-.003  AMP=3.");
            self.c.chsimu[27].set("Cr2@3.03+-.004 FWHM=.03<.04+-.005  AMP=3.");
            self.c.chsimu[28].set("tau1 @3.58+-.006 FWHM=.04<.06+-.01 AMP=3.");
            self.c.chsimu[29].set("tau2 @3.52+-.006 FWHM=.04<.06+-.01 AMP=3.");
            self.c.chsimu[30].set("tau3 @3.46+-.006 FWHM=.04<.06+-.01 AMP=3.");
            self.c.chsimu[31].set("tau4 @3.40+-.006 FWHM=.04<.06+-.01 AMP=3.");
            self.c.chsimu[32].set("tau5 @3.34+-.006 FWHM=.04<.06+-.01 AMP=3.");
            self.c.endpha = true;
            self.c.incsmx = 1;
            self.c.namrel.set("Cr");
            self.c.ncombi = 10;
            self.c.ngrsh = 3;
            self.c.nnot1 = 5;
            self.c.nnot2 = 4;
            self.c.nobasi = true;
            self.c.nratio = 0;
            self.c.nrefpk[2] = 1;
            self.c.nsidmn = 1;
            self.c.nsidmx = 1;
            self.c.nsimul = 32;
            self.c.onlyco = true;
            self.c.ppmend = -1.0_f32;
            self.c.ppmref[(1, 2)] = 3.03_f32;
            self.c.ppmst = 3.8_f32;
            self.c.sdgrsh[1] = 0.002_f32;
            self.c.sdgrsh[2] = 0.002_f32;
            self.c.sdgrsh[3] = 0.001_f32;
            self.c.vitro = true;
        }
        if self.c.sptype.sub(1, 8).eq_str("muscle-2") {
            *is_sptype = true;
            self.c.badref = true;
            self.c.chcom2[1].set("IMCL13");
            self.c.chcom2[2].set("EMCL15");
            self.c.chcom2[3].set("Cr");
            self.c.chcom2[4].set("tau");
            self.c.chcom2[5].set("cho");
            self.c.chcom2[6].set("cr28");
            self.c.chcom2[7].set("I09");
            self.c.chcom2[8].set("E11");
            self.c.chcom2[9].set("I21");
            self.c.chcom2[10].set("E23");
            self.c.chcomb[1].set("I13e+I13d+I13c+I13b+I13a");
            self.c.chcomb[2].set("E15g+E15f+E15e+E15d+E15c+E15b+E15a");
            self.c.chcomb[3].set("Cr2+Cr1");
            self.c.chcomb[4].set("tau5+tau4+tau3+tau2+tau1");
            self.c.chcomb[5].set("cho4+cho3+cho2+cho1");
            self.c.chcomb[6].set("cr28e+cr28d+cr28c+cr28b+cr28a");
            self.c.chcomb[7].set("I09a+I09b");
            self.c.chcomb[8].set("E11");
            self.c.chcomb[9].set("I21a+I21b+I21c+I21d+I21e");
            self.c.chcomb[10].set("E23a+E23b+E23c+E23d+E23e");
            self.c.chgrsh[1].set("E15");
            self.c.chgrsh[2].set("I13");
            self.c.chgrsh[3].set("Cr");
            self.c.chgrsh[4].set("E23");
            self.c.chgrsh[5].set("I21");
            self.c.chgrsh[6].set("I09");
            self.c.chnot1[1].set("tau1");
            self.c.chnot1[2].set("tau2");
            self.c.chnot1[3].set("tau3");
            self.c.chnot1[4].set("tau4");
            self.c.chnot1[5].set("tau5");
            self.c.chnot2[1].set("E15h");
            self.c.chnot2[2].set("E15i");
            self.c.chnot2[3].set("I13f");
            self.c.chnot2[4].set("I13g");
            self.c.chsimu[1].set("E15a @1.52+-.03 FWHM=.03<.04+-.006 AMP=2.");
            self.c.chsimu[2].set("E15b @1.52+-.03 FWHM=.06<.07+-.006 AMP=2.");
            self.c.chsimu[3].set("E15c @1.52+-.03 FWHM=.09<.10+-.006 AMP=2.");
            self.c.chsimu[4].set("E15d @1.52+-.03 FWHM=.12<.13+-.006 AMP=2.");
            self.c.chsimu[5].set("E15e @1.52+-.03 FWHM=.15<.16+-.006 AMP=2.");
            self.c.chsimu[6].set("E15f @1.52+-.03 FWHM=.18<.19+-.006 AMP=2.");
            self.c.chsimu[7].set("E15g @1.52+-.03 FWHM=.21<.22+-.006 AMP=2.");
            self.c.chsimu[8].set("E15h @1.54+-.03 FWHM=.16<.18+-.03 AMP=2.");
            self.c.chsimu[9].set("E15i @1.50+-.03 FWHM=.16<.18+-.03 AMP=2.");
            self.c.chsimu[10].set("I13a @1.27+-.03 FWHM=.03<.04+-.006 AMP=2.");
            self.c.chsimu[11].set("I13b @1.27+-.03 FWHM=.06<.07+-.006 AMP=2.");
            self.c.chsimu[12].set("I13c @1.27+-.03 FWHM=.09<.10+-.006 AMP=2.");
            self.c.chsimu[13].set("I13d @1.27+-.03 FWHM=.12<.13+-.006 AMP=2.");
            self.c.chsimu[14].set("I13e @1.27+-.03 FWHM=.15<.16+-.006 AMP=2.");
            self.c.chsimu[15].set("I13f @1.29+-.03 FWHM=.09<.11+-.02 AMP=2.");
            self.c.chsimu[16].set("I13g @1.25+-.03 FWHM=.09<.11+-.02 AMP=2.");
            self.c.chsimu[17].set("E11 @1.07+-.02 FWHM=.07<.08+-.02 AMP=3.");
            self.c.chsimu[18].set("I09a @.89+-.02 FWHM=.05<.06+-.01 AMP=3.");
            self.c.chsimu[19].set("I09b @.89+-.02 FWHM=.08<.09+-.01 AMP=3.");
            self.c.chsimu[20].set("E23a @2.33+-.03 FWHM=.04<.06+-.02 AMP=1.                          @1.8 FWHM=.59 AMP=1.");
            self.c.chsimu[21].set("E23b @2.33+-.03 FWHM=.10<.12+-.02 AMP=1.                          @1.8 FWHM=.59 AMP=1.");
            self.c.chsimu[22].set("E23c @2.33+-.03 FWHM=.16<.18+-.02 AMP=1.                          @1.8 FWHM=.69 AMP=1.");
            self.c.chsimu[23].set("E23d @2.33+-.03 FWHM=.22<.24+-.02 AMP=1.                          @1.8 FWHM=.79 AMP=1.");
            self.c.chsimu[24].set("E23e @2.33+-.03 FWHM=.28<.30+-.02 AMP=1.                          @1.8 FWHM=.79 AMP=1.");
            self.c.chsimu[25].set("I21a @2.15+-.03 FWHM=.04<.06+-.02 AMP=1.1111                      @1.6 FWHM=.61 AMP=.8889");
            self.c.chsimu[26].set("I21b @2.15+-.03 FWHM=.10<.12+-.02 AMP=1.1111                      @1.6 FWHM=.61 AMP=.8889");
            self.c.chsimu[27].set("I21c @2.15+-.03 FWHM=.16<.18+-.02 AMP=1.1111                      @1.6 FWHM=.71 AMP=.8889");
            self.c.chsimu[28].set("I21d @2.15+-.03 FWHM=.22<.24+-.02 AMP=1.1111                      @1.6 FWHM=.71 AMP=.8889");
            self.c.chsimu[29].set("I21e @2.15+-.03 FWHM=.28<.30+-.02 AMP=1.1111                      @1.6 FWHM=.71 AMP=.8889");
            self.c.chsimu[30].set("cr28a @2.90+-.004 FWHM=.03<.04+-.004 AMP=3.");
            self.c.chsimu[31].set("cr28b @2.86+-.004 FWHM=.03<.04+-.004 AMP=3.");
            self.c.chsimu[32].set("cr28c @2.82+-.004 FWHM=.03<.04+-.004 AMP=3.");
            self.c.chsimu[33].set("cr28d @2.78+-.004 FWHM=.03<.04+-.004 AMP=3.");
            self.c.chsimu[34].set("cr28e @2.74+-.004 FWHM=.03<.04+-.004 AMP=3.");
            self.c.chsimu[35].set("cho1 @3.24+-.003 FWHM=.025<.03+-.003  AMP=9.");
            self.c.chsimu[36].set("cho2 @3.21+-.003 FWHM=.025<.03+-.003  AMP=9.");
            self.c.chsimu[37].set("cho3 @3.18+-.003 FWHM=.025<.03+-.003  AMP=9.");
            self.c.chsimu[38].set("cho4 @3.15+-.003 FWHM=.025<.03+-.003  AMP=9.");
            self.c.chsimu[39].set("Cr1 @3.03+-.02 FWHM=.025<.035+-.01  AMP=3.");
            self.c.chsimu[40].set("Cr2 @3.03+-.02 FWHM=.045<.055+-.01  AMP=3.");
            self.c.chsimu[41].set("tau1 @3.58+-.006 FWHM=.04<.06+-.01 AMP=3.");
            self.c.chsimu[42].set("tau2 @3.52+-.006 FWHM=.04<.06+-.01 AMP=3.");
            self.c.chsimu[43].set("tau3 @3.46+-.006 FWHM=.04<.06+-.01 AMP=3.");
            self.c.chsimu[44].set("tau4 @3.40+-.006 FWHM=.04<.06+-.01 AMP=3.");
            self.c.chsimu[45].set("tau5 @3.34+-.006 FWHM=.04<.06+-.01 AMP=3.");
            self.c.dkntmn[2] = 2.4_f32;
            self.c.idgppm = 2;
            self.c.incsmx = 1;
            self.c.namrel.set("Cr");
            self.c.ncombi = 10;
            self.c.ngrsh = 6;
            self.c.nnot1 = 5;
            self.c.nnot2 = 4;
            self.c.nobasi = true;
            self.c.nratio = 0;
            self.c.nrefpk[2] = 1;
            self.c.nsidmn = 1;
            self.c.nsidmx = 1;
            self.c.nsimul = 45;
            self.c.onlyco = true;
            self.c.ppmend = -1.0_f32;
            self.c.ppmref[(1, 2)] = 3.03_f32;
            self.c.ppmst = 3.8_f32;
            self.c.prmnmx[(1, 1)] = 0.5_f32;
            self.c.prmnmx[(2, 1)] = 0.95_f32;
            self.c.ralinc = 1.4_f32;
            self.c.rrt2mq = 0.25_f32;
            self.c.sdgrsh[1] = 0.002_f32;
            self.c.sdgrsh[2] = 0.002_f32;
            self.c.sdgrsh[3] = 0.001_f32;
            self.c.sdgrsh[4] = 0.004_f32;
            self.c.sdgrsh[5] = 0.004_f32;
            self.c.sdgrsh[6] = 0.002_f32;
            self.c.useany = true;
            self.c.vitro = true;
        }
        if self.c.sptype.sub(1, 8).eq_str("muscle-3") {
            *is_sptype = true;
            self.c.atth2o = 1.0_f32;
            self.c.badref = true;
            self.c.chcom2[1].set("IMCL13");
            self.c.chcom2[2].set("EMCL15");
            self.c.chcom2[3].set("Cr");
            self.c.chcom2[4].set("E55+I53");
            self.c.chcom2[5].set("I09");
            self.c.chcom2[6].set("E11");
            self.c.chcom2[7].set("cho");
            self.c.chcom2[8].set("I21");
            self.c.chcom2[9].set("E23");
            self.c.chcom2[10].set("tau");
            self.c.chcom2[11].set("cr39");
            self.c.chcom2[12].set("cr28");
            self.c.chcom2[13].set("E55");
            self.c.chcom2[14].set("I53");
            self.c.chcom2[15].set("Water");
            self.c.chcomb[1].set("I13d+I13c+I13b+I13a");
            self.c.chcomb[2].set("E15e+E15d+E15c+E15b+E15a");
            self.c.chcomb[3].set("Cr2+Cr1");
            self.c.chcomb[4].set("E55a+E55b+E55c+E55d+I53a+I53b+I53c+I53d");
            self.c.chcomb[5].set("I09a+I09b+I09c");
            self.c.chcomb[6].set("E11a+E11b+E11c");
            self.c.chcomb[7].set("cho4+cho3+cho2+cho1");
            self.c.chcomb[8].set("I21a+I21b+I21c+I21d+I21e");
            self.c.chcomb[9].set("E23a+E23b+E23c+E23d+E23e");
            self.c.chcomb[10].set("tau5+tau4+tau3+tau2+tau1");
            self.c.chcomb[11].set("cr39a+cr39b");
            self.c.chcomb[12].set("cr28e+cr28d+cr28c+cr28b+cr28a");
            self.c.chcomb[13].set("E55a+E55b+E55c+E55d");
            self.c.chcomb[14].set("I53a+I53b+I53c+I53d");
            self.c.chcomb[15].set("W1+W2+W3+W4+W5+W6+W7");
            self.c.chgrsh[1].set("E15");
            self.c.chgrsh[2].set("I13");
            self.c.chgrsh[3].set("Cr");
            self.c.chgrsh[4].set("I09");
            self.c.chgrsh[5].set("E11");
            self.c.chgrsh[6].set("I21");
            self.c.chgrsh[7].set("E23");
            self.c.chgrsh[8].set("cr39");
            self.c.chgrsh[9].set("E55");
            self.c.chgrsh[10].set("I53");
            self.c.chgrsh[11].set("W");
            self.c.chnot1[1].set("tau1");
            self.c.chnot1[2].set("tau2");
            self.c.chnot1[3].set("tau3");
            self.c.chnot1[4].set("tau4");
            self.c.chnot1[5].set("tau5");
            self.c.chnot1[6].set("cho1");
            self.c.chnot1[7].set("cho2");
            self.c.chnot1[8].set("cho3");
            self.c.chnot1[9].set("cho4");
            self.c.chnot1[10].set("cr28a");
            self.c.chnot1[11].set("cr28b");
            self.c.chnot1[12].set("cr28c");
            self.c.chnot1[13].set("cr28d");
            self.c.chnot1[14].set("cr28e");
            self.c.chnot1[15].set("E11a");
            self.c.chnot1[16].set("E11b");
            self.c.chnot1[17].set("E11c");
            self.c.chnot1[18].set("I09a");
            self.c.chnot1[19].set("I09b");
            self.c.chnot1[20].set("I09c");
            self.c.chnot2[1].set("E15f");
            self.c.chnot2[2].set("E15g");
            self.c.chnot2[3].set("I13e");
            self.c.chnot2[4].set("I13f");
            self.c.chsimu[1].set("E15a @1.52+-.01 FWHM=.03<.04+-.005 AMP=1.");
            self.c.chsimu[2].set("E15b @1.52+-.01 FWHM=.06<.07+-.005 AMP=1.");
            self.c.chsimu[3].set("E15c @1.52+-.01 FWHM=.13<.14+-.005 AMP=1.");
            self.c.chsimu[4].set("E15d @1.52+-.01 FWHM=.20<.21+-.005 AMP=1.");
            self.c.chsimu[5].set("E15e @1.52+-.01 FWHM=.27<.28+-.005 AMP=1.");
            self.c.chsimu[6].set("E15f @1.54+-.01 FWHM=.16<.18+-.02 AMP=1.");
            self.c.chsimu[7].set("E15g @1.50+-.01 FWHM=.16<.18+-.02 AMP=1.");
            self.c.chsimu[8].set("I13a @1.27+-.01 FWHM=.03<.04+-.005 AMP=1.");
            self.c.chsimu[9].set("I13b @1.27+-.01 FWHM=.06<.07+-.005 AMP=1.");
            self.c.chsimu[10].set("I13c @1.27+-.01 FWHM=.13<.14+-.005 AMP=1.");
            self.c.chsimu[11].set("I13d @1.27+-.01 FWHM=.20<.21+-.005 AMP=1.");
            self.c.chsimu[12].set("I13e @1.29+-.01 FWHM=.09<.11+-.02 AMP=1.");
            self.c.chsimu[13].set("I13f @1.25+-.01 FWHM=.09<.11+-.02 AMP=1.");
            self.c.chsimu[14].set("E11a @1.09+-.01 FWHM=.05<.06+-.005 AMP=1.");
            self.c.chsimu[15].set("E11b @1.09+-.01 FWHM=.11<.12+-.005 AMP=1.");
            self.c.chsimu[16].set("E11c @1.09+-.01 FWHM=.17<.18+-.005 AMP=1.");
            self.c.chsimu[17].set("I09a @.89+-.01 FWHM=.05<.06+-.005 AMP=1.");
            self.c.chsimu[18].set("I09b @.89+-.01 FWHM=.12<.13+-.005 AMP=1.");
            self.c.chsimu[19].set("I09c @.89+-.01 FWHM=.19<.20+-.005 AMP=1.");
            self.c.chsimu[20].set("E23a @2.33+-.03 FWHM=.04<.05+-.005 AMP=.5                         @1.8 FWHM=.59 AMP=.5");
            self.c.chsimu[21].set("E23b @2.33+-.03 FWHM=.11<.12+-.005 AMP=.5                         @1.8 FWHM=.59 AMP=.5");
            self.c.chsimu[22].set("E23c @2.33+-.03 FWHM=.18<.19+-.005 AMP=.5                         @1.8 FWHM=.69 AMP=.5");
            self.c.chsimu[23].set("E23d @2.33+-.03 FWHM=.25<.26+-.005 AMP=.5                         @1.8 FWHM=.79 AMP=.5");
            self.c.chsimu[24].set("E23e @2.33+-.03 FWHM=.32<.33+-.005 AMP=.5                         @1.8 FWHM=.79 AMP=.5");
            self.c.chsimu[25].set("I21a @2.15+-.03 FWHM=.04<.05+-.005 AMP=.556                       @1.8 FWHM=.59 AMP=.444");
            self.c.chsimu[26].set("I21b @2.15+-.03 FWHM=.11<.12+-.005 AMP=.556                       @1.8 FWHM=.59 AMP=.444");
            self.c.chsimu[27].set("I21c @2.15+-.03 FWHM=.18<.19+-.005 AMP=.556                       @1.8 FWHM=.69 AMP=.444");
            self.c.chsimu[28].set("I21d @2.15+-.03 FWHM=.25<.26+-.005 AMP=.556                       @1.8 FWHM=.79 AMP=.444");
            self.c.chsimu[29].set("I21e @2.15+-.03 FWHM=.32<.33+-.005 AMP=.556                       @1.8 FWHM=.79 AMP=.444");
            self.c.chsimu[30].set("cr39a @3.93+-.02 FWHM=.025<.035+-.005  AMP=1.");
            self.c.chsimu[31].set("cr39b @3.93+-.02 FWHM=.055<.065+-.005  AMP=1.");
            self.c.chsimu[32].set("cr28a @2.90+-.004 FWHM=.03<.04+-.004 AMP=1.");
            self.c.chsimu[33].set("cr28b @2.86+-.004 FWHM=.03<.04+-.004 AMP=1.");
            self.c.chsimu[34].set("cr28c @2.82+-.004 FWHM=.03<.04+-.004 AMP=1.");
            self.c.chsimu[35].set("cr28d @2.78+-.004 FWHM=.03<.04+-.004 AMP=1.");
            self.c.chsimu[36].set("cr28e @2.74+-.004 FWHM=.03<.04+-.004 AMP=1.");
            self.c.chsimu[37].set("cho1 @3.24+-.003 FWHM=.025<.03+-.003  AMP=1.");
            self.c.chsimu[38].set("cho2 @3.21+-.003 FWHM=.025<.03+-.003  AMP=1.");
            self.c.chsimu[39].set("cho3 @3.18+-.003 FWHM=.025<.03+-.003  AMP=1.");
            self.c.chsimu[40].set("cho4 @3.15+-.003 FWHM=.025<.03+-.003  AMP=1.");
            self.c.chsimu[41].set("Cr1 @3.03+-.02 FWHM=.025<.035+-.005  AMP=1.");
            self.c.chsimu[42].set("Cr2 @3.03+-.02 FWHM=.055<.065+-.005  AMP=1.");
            self.c.chsimu[43].set("tau1 @3.58+-.006 FWHM=.04<.06+-.01 AMP=1.");
            self.c.chsimu[44].set("tau2 @3.52+-.006 FWHM=.04<.06+-.01 AMP=1.");
            self.c.chsimu[45].set("tau3 @3.46+-.006 FWHM=.04<.06+-.01 AMP=1.");
            self.c.chsimu[46].set("tau4 @3.40+-.006 FWHM=.04<.06+-.01 AMP=1.");
            self.c.chsimu[47].set("tau5 @3.34+-.006 FWHM=.04<.06+-.01 AMP=1.");
            self.c.chsimu[48].set("E55a @5.52+-.01 FWHM=.06<.07+-.005 AMP=1.");
            self.c.chsimu[49].set("E55b @5.52+-.01 FWHM=.13<.14+-.005 AMP=1.");
            self.c.chsimu[50].set("E55c @5.52+-.01 FWHM=.20<.21+-.005 AMP=1.");
            self.c.chsimu[51].set("E55d @5.52+-.01 FWHM=.27<.28+-.005 AMP=1.");
            self.c.chsimu[52].set("I53a @5.30+-.01 FWHM=.06<.07+-.005 AMP=1.");
            self.c.chsimu[53].set("I53b @5.30+-.01 FWHM=.13<.14+-.005 AMP=1.");
            self.c.chsimu[54].set("I53c @5.30+-.01 FWHM=.20<.21+-.005 AMP=1.");
            self.c.chsimu[55].set("I53d @5.30+-.01 FWHM=.27<.28+-.005 AMP=1.");
            if self.c.roomt {
                self.c.chsimu[56].set("W1 @4.83+-.02 FWHM=.03<.04+-.005 AMP=1.");
                self.c.chsimu[57].set("W2 @4.83+-.02 FWHM=.06<.07+-.005 AMP=1.");
                self.c.chsimu[58].set("W3 @4.83+-.02 FWHM=.14<.15+-.005 AMP=1.");
                self.c.chsimu[59].set("W4 @4.83+-.02 FWHM=.22<.23+-.005 AMP=1.");
                self.c.chsimu[60].set("W5 @4.83+-.02 FWHM=.30<.31+-.005 AMP=1.");
                self.c.chsimu[61].set("W6 @4.83+-.02 FWHM=.38<.39+-.005 AMP=1.");
                self.c.chsimu[62].set("W7 @4.83+-.02 FWHM=.46<.47+-.005 AMP=1.");
                self.c.ppmcen = 4.83_f32;
                self.c.ppmref[(1, 1)] = 4.83_f32;
            } else {
                self.c.chsimu[56].set("W1 @4.65+-.02 FWHM=.03<.04+-.005 AMP=1.");
                self.c.chsimu[57].set("W2 @4.65+-.02 FWHM=.06<.07+-.005 AMP=1.");
                self.c.chsimu[58].set("W3 @4.65+-.02 FWHM=.14<.15+-.005 AMP=1.");
                self.c.chsimu[59].set("W4 @4.65+-.02 FWHM=.22<.23+-.005 AMP=1.");
                self.c.chsimu[60].set("W5 @4.65+-.02 FWHM=.30<.31+-.005 AMP=1.");
                self.c.chsimu[61].set("W6 @4.65+-.02 FWHM=.38<.39+-.005 AMP=1.");
                self.c.chsimu[62].set("W7 @4.65+-.02 FWHM=.46<.47+-.005 AMP=1.");
            }
            self.c.dkntmn[2] = 2.4_f32;
            self.c.endpha = true;
            self.c.fwhmmx = 0.21_f32;
            self.c.fwhmst = 0.2_f32;
            self.c.gauss_rt2 = false;
            self.c.idgppm = 2;
            self.c.incsmx = 1;
            self.c.isdbol = 5;
            self.c.mrepha[1] = 1;
            self.c.namrel.set("Cr");
            self.c.ncombi = 15;
            self.c.ngrsh = 11;
            self.c.nnot1 = 16;
            self.c.nnot2 = 4;
            self.c.nobasi = true;
            self.c.nratio = 0;
            self.c.nrefpk[2] = 1;
            self.c.nsidmn = 1;
            self.c.nsidmx = 1;
            self.c.nsimul = 62;
            self.c.onlyco = true;
            self.c.ppmref[(1, 2)] = 3.03_f32;
            if self.c.ppmst < -9998.0_f32 {
                self.c.ppmst = 3.8_f32;
            }
            if self.c.ppmend > 9998.0_f32 {
                self.c.ppmend = -2.0_f32;
            }
            if (self.c.ppmst - self.c.ppmend) >= 6.4_f32 {
                self.c.nsubtk = 5;
                self.c.xstep = 1.0_f32;
            }
            self.c.prmnmx[(1, 1)] = 0.5_f32;
            self.c.prmnmx[(2, 1)] = 0.95_f32;
            self.c.ralinc = 1.4_f32;
            self.c.rrt2mq = 0.25_f32;
            self.c.sdgrsh[1] = 0.002_f32;
            self.c.sdgrsh[2] = 0.002_f32;
            self.c.sdgrsh[3] = 0.002_f32;
            self.c.sdgrsh[4] = 0.002_f32;
            self.c.sdgrsh[5] = 0.002_f32;
            self.c.sdgrsh[6] = 0.004_f32;
            self.c.sdgrsh[7] = 0.004_f32;
            self.c.sdgrsh[8] = 0.002_f32;
            self.c.sdgrsh[9] = 0.002_f32;
            self.c.sdgrsh[10] = 0.002_f32;
            self.c.sdgrsh[11] = 0.007_f32;
            self.c.useany = true;
            self.c.vitro = true;
            self.c.wconc = 0.5_f32;
        }
        if self.c.sptype.sub(1, 8).eq_str("muscle-4") || self.c.sptype.sub(1, 8).eq_str("muscle-5") {
            *is_sptype = true;
            if self.c.sptype.sub(1, 8).eq_str("muscle-5") {
                self.c.asymlp = true;
            }
            self.c.atth2o = 1.0_f32;
            self.c.chcom2[1].set("IMCL13");
            self.c.chcom2[2].set("EMCL15");
            self.c.chcom2[3].set("Cr");
            self.c.chcom2[4].set("I09");
            self.c.chcom2[5].set("E11");
            self.c.chcom2[6].set("Water");
            self.c.chcom2[7].set("I53");
            self.c.chcom2[8].set("E55");
            self.c.chcom2[9].set("I53+E55");
            self.c.chcom2[10].set("cho");
            self.c.chcom2[11].set("I21");
            self.c.chcom2[12].set("E23");
            self.c.chcom2[13].set("tau");
            self.c.chcom2[14].set("cr39");
            self.c.chcom2[15].set("cr28");
            self.c.chcomb[1].set("xIMC13+xIM13a");
            self.c.chcomb[2].set("xEMC15+xEM15a");
            self.c.chcomb[3].set("Cr");
            self.c.chcomb[4].set("xI09");
            self.c.chcomb[5].set("xE11");
            self.c.chcomb[6].set("Water+Water2");
            self.c.chcomb[7].set("yI53");
            self.c.chcomb[8].set("yE55");
            self.c.chcomb[9].set("yI53+yE55");
            self.c.chcomb[10].set("cho4+cho3+cho2+cho1");
            self.c.chcomb[11].set("I21");
            self.c.chcomb[12].set("E23");
            self.c.chcomb[13].set("tau5+tau4+tau3+tau2+tau1");
            self.c.chcomb[14].set("cr39");
            self.c.chcomb[15].set("cr28e+cr28d+cr28c+cr28b+cr28a");
            self.c.chgrsh[1].set("x");
            self.c.chgrsh[2].set("y");
            self.c.chsimu[1].set("xIMC13 @1.27+-.025 FWHM=.03<9.+-2. AMP=1.                         @999. FWHM=.5 AMP=-1.                                             @999. FWHM=.05 AMP=-1.                                            @999. FWHM=.1 AMP=-1.");
            self.c.chsimu[2].set("xIM13a @1.28+-.025 FWHM=.03<9.+-2. AMP=1.                         @999. FWHM=.5 AMP=-1.                                             @999. FWHM=.05 AMP=-1.                                            @999. FWHM=.1 AMP=-1.");
            self.c.chsimu[3].set("xEMC15 @1.52+-.025 FWHM=.03<9.+-2. AMP=1.                         @999. FWHM=.5 AMP=-1.                                             @999. FWHM=.05 AMP=-1.                                            @999. FWHM=.1 AMP=-1.");
            self.c.chsimu[4].set("xEM15a @1.51+-.025 FWHM=.03<9.+-2. AMP=1.                         @999. FWHM=.5 AMP=-1.                                             @999. FWHM=.05 AMP=-1.                                            @999. FWHM=.1 AMP=-1.");
            if !self.c.asymlp {
                self.c.chcomb[1].set("xIMC13");
                self.c.chcomb[2].set("xEMC15");
                self.c.chomit[1].set("xIM13a");
                self.c.chomit[2].set("xEM15a");
                self.c.chsimu[1].set("xIMC13 @1.27+-.025 FWHM=.03<9.+-3. AMP=1.                         @999. FWHM=.5 AMP=-1.                                             @999. FWHM=.05 AMP=-1.                                            @999. FWHM=.1 AMP=-1.");
                self.c.chsimu[3].set("xEMC15 @1.52+-.025 FWHM=.03<9.+-3. AMP=1.                         @999. FWHM=.5 AMP=-1.                                             @999. FWHM=.05 AMP=-1.                                            @999. FWHM=.1 AMP=-1.");
                self.c.nomit = 2;
            }
            self.c.chsimu[5].set("Cr @3.03+-.02 FWHM=.02<9.+-2. AMP=1.                              @999. FWHM=.5 AMP=-1.                                             @999. FWHM=.05 AMP=-1.                                            @999. FWHM=.1 AMP=-1.");
            self.c.chsimu[6].set("xI09 @.89+-.025 FWHM=.05<9.+-1. AMP=1.                            @999. FWHM=.5 AMP=-1.                                             @999. FWHM=.05 AMP=-1.                                            @999. FWHM=.1 AMP=-1.");
            self.c.chsimu[7].set("xE11 @1.09+-.025 FWHM=.05<9.+-1. AMP=1.                           @999. FWHM=.5 AMP=-1.                                             @999. FWHM=.05 AMP=-1.                                            @999. FWHM=.1 AMP=-1.");
            self.c.chsimu[8].set("cho1 @3.24+-.003 FWHM=.03<9.+-1. AMP=1.                           @999. FWHM=.05 AMP=-1.                                            @999. FWHM=.05 AMP=-1.");
            self.c.chsimu[9].set("cho2 @3.21+-.003 FWHM=.03<9.+-1. AMP=1.                           @999. FWHM=.05 AMP=-1.                                            @999. FWHM=.05 AMP=-1.");
            self.c.chsimu[10].set("cho3 @3.18+-.003 FWHM=.03<9.+-1. AMP=1.                          @999. FWHM=.05 AMP=-1.                                            @999. FWHM=.05 AMP=-1.");
            self.c.chsimu[11].set("cho4 @3.15+-.003 FWHM=.03<9.+-1. AMP=1.                          @999. FWHM=.05 AMP=-1.                                            @999. FWHM=.05 AMP=-1.");
            self.c.chsimu[12].set("I21 @2.15+-.03 FWHM=.04<9.+-1. AMP=.556                           @1.6 FWHM=.50 AMP=.444                                            @999. FWHM=1. AMP=-1.                                             @999. FWHM=.05 AMP=-1.                                            @999. FWHM=.1 AMP=-1.");
            self.c.chsimu[13].set("E23 @2.33+-.03 FWHM=.04<9.+-1. AMP=.556                           @1.8 FWHM=.50 AMP=.444                                            @999. FWHM=1. AMP=-1.                                             @999. FWHM=.05 AMP=-1.                                            @999. FWHM=.1 AMP=-1.");
            self.c.chsimu[14].set("tau1 @3.58+-.006 FWHM=.06<9.+-1. AMP=1.                           @999. FWHM=.05 AMP=-1.                                            @999. FWHM=.05 AMP=-1.");
            self.c.chsimu[15].set("tau2 @3.52+-.006 FWHM=.06<9.+-1. AMP=1.                           @999. FWHM=.05 AMP=-1.                                            @999. FWHM=.05 AMP=-1.");
            self.c.chsimu[16].set("tau3 @3.46+-.006 FWHM=.06<9.+-1. AMP=1.                           @999. FWHM=.05 AMP=-1.                                            @999. FWHM=.05 AMP=-1.");
            self.c.chsimu[17].set("tau4 @3.40+-.006 FWHM=.06<9.+-1. AMP=1.                           @999. FWHM=.05 AMP=-1.                                            @999. FWHM=.05 AMP=-1.");
            self.c.chsimu[18].set("tau5 @3.34+-.006 FWHM=.06<9.+-1. AMP=1.                           @999. FWHM=.05 AMP=-1.                                            @999. FWHM=.05 AMP=-1.");
            self.c.chsimu[19].set("cr39 @3.93+-.02 FWHM=.025<9.+-1. AMP=1.                           @999. FWHM=.5 AMP=-1.                                             @999. FWHM=.05 AMP=-1.                                            @999. FWHM=.1 AMP=-1.");
            self.c.chsimu[20].set("cr28a @2.90+-.004 FWHM=.04<9.+-1. AMP=1.                          @999. FWHM=.05 AMP=-1.                                            @999. FWHM=.05 AMP=-1.");
            self.c.chsimu[21].set("cr28b @2.86+-.004 FWHM=.04<9.+-1. AMP=1.                          @999. FWHM=.05 AMP=-1.                                            @999. FWHM=.05 AMP=-1.");
            self.c.chsimu[22].set("cr28c @2.82+-.004 FWHM=.04<9.+-1. AMP=1.                          @999. FWHM=.05 AMP=-1.                                            @999. FWHM=.05 AMP=-1.");
            self.c.chsimu[23].set("cr28d @2.78+-.004 FWHM=.04<9.+-1. AMP=1.                          @999. FWHM=.05 AMP=-1.                                            @999. FWHM=.05 AMP=-1.");
            self.c.chsimu[24].set("cr28e @2.74+-.004 FWHM=.04<9.+-1. AMP=1.                          @999. FWHM=.05 AMP=-1.                                            @999. FWHM=.05 AMP=-1.");
            self.c.chsimu[25].set("yE55 @5.52+-.01 FWHM=.06<9.+-1. AMP=1.                            @999. FWHM=.5 AMP=-1.                                             @999. FWHM=.05 AMP=-1.                                            @999. FWHM=.1 AMP=-1.");
            self.c.chsimu[26].set("yI53 @5.30+-.01 FWHM=.06<9.+-1. AMP=1.                            @999. FWHM=.5 AMP=-1.                                             @999. FWHM=.05 AMP=-1.                                            @999. FWHM=.1 AMP=-1.");
            if self.c.roomt {
                self.c.chsimu[27].set("Water @4.83+-.02 FWHM=.03<9.+-2. AMP=1.                           @999. FWHM=.5 AMP=-1.                                             @999. FWHM=.1 AMP=-1.                                             @999. FWHM=.1 AMP=-1.");
                self.c.chsimu[28].set("Water2 @4.82+-.02 FWHM=.03<9.+-2. AMP=1.                          @999. FWHM=.5 AMP=-1.                                             @999. FWHM=.1 AMP=-1.                                             @999. FWHM=.1 AMP=-1.");
                self.c.ppmcen = 4.83_f32;
                self.c.ppmref[(1, 1)] = 4.83_f32;
            } else {
                self.c.chsimu[27].set("Water @4.65+-.02 FWHM=.03<9.+-2. AMP=1.                           @999. FWHM=.5 AMP=-1.                                             @999. FWHM=.1 AMP=-1.                                             @999. FWHM=.1 AMP=-1.");
                self.c.chsimu[28].set("Water2 @4.66+-.02 FWHM=.03<9.+-2. AMP=1.                          @999. FWHM=.5 AMP=-1.                                             @999. FWHM=.1 AMP=-1.                                             @999. FWHM=.1 AMP=-1.");
            }
            self.c.chuse1[1].set("xIMC13");
            self.c.chuse1[2].set("xEMC15");
            self.c.chuse1[3].set("Cr");
            self.c.chuse1[4].set("I21");
            self.c.chuse1[5].set("E23");
            self.c.chuse1[6].set("cr39");
            self.c.chuse1[7].set("Water");
            self.c.chuse1[8].set("yE55");
            self.c.chuse1[9].set("yI53");
            self.c.dkntmn[2] = 2.4_f32;
            self.c.endpha = true;
            self.c.fixshf = true;
            self.c.fwhmmx = 0.21_f32;
            self.c.fwhmst = 0.2_f32;
            self.c.gauss_rt2 = false;
            self.c.idgppm = 2;
            self.c.imethd = 3;
            self.c.incsmx = 1;
            self.c.isdbol = 5;
            self.c.mpower = 2;
            if !self.c.asymlp {
                self.c.mpower = 3;
            }
            self.c.mrepha[1] = 1;
            self.c.namrel.set("Cr");
            self.c.ncombi = 15;
            self.c.ngrsh = 2;
            self.c.nobasi = true;
            self.c.nratio = 0;
            self.c.nrefpk[2] = 4;
            self.c.nsidmn = 1;
            self.c.nsidmx = 1;
            self.c.nsimul = 28;
            self.c.onlyco = true;
            self.c.ppmref[(1, 2)] = 3.2_f32;
            self.c.ppmref[(2, 2)] = 3.03_f32;
            self.c.ppmref[(3, 2)] = 1.52_f32;
            self.c.ppmref[(4, 2)] = 1.27_f32;
            if self.c.ppmst < -9998.0_f32 {
                self.c.ppmst = 3.8_f32;
            }
            if self.c.ppmend > 9998.0_f32 {
                self.c.ppmend = -2.0_f32;
            }
            if self.c.ppmst < 4.0_f32 {
                self.c.nuse1 = 5;
            } else if self.c.ppmst < 6.0_f32 {
                self.c.nuse1 = 6;
            } else {
                self.c.nuse1 = 9;
            }
            if (self.c.ppmst - self.c.ppmend) >= 6.4_f32 {
                self.c.nsubtk = 5;
                self.c.xstep = 1.0_f32;
            }
            self.c.prmnmx[(1, 1)] = 0.05_f32;
            self.c.prmnmx[(2, 1)] = 0.9_f32;
            self.c.ralinc = 1.4_f32;
            self.c.rpowmq = 0.1_f32;
            self.c.sdgrsh[1] = 0.004_f32;
            self.c.sdgrsh[2] = 0.004_f32;
            self.c.useany = true;
            self.c.vitro = true;
            self.c.wconc = 0.5_f32;
        }
    }

    /// MYCONT's statements from liver-1.inc.
    fn sptype_liver(&mut self, is_sptype: &mut bool) {
        if (((((((((self.c.sptype.sub(1, 8).eq_str("liver-1 ") || self.c.sptype.sub(1, 8).eq_str("lipid-1 ")) || self.c.sptype.sub(1, 9).eq_str("breast-1 ")) || self.c.sptype.sub(1, 7).eq_str("liver-2")) || self.c.sptype.sub(1, 7).eq_str("lipid-2")) || self.c.sptype.sub(1, 8).eq_str("breast-2")) || self.c.sptype.sub(1, 10).eq_str("only-cho-1")) || self.c.sptype.sub(1, 7).eq_str("lipid-3")) || self.c.sptype.sub(1, 7).eq_str("liver-3")) || self.c.sptype.sub(1, 8).eq_str("breast-3")) || self.c.sptype.sub(1, 10).eq_str("only-cho-2") {
            *is_sptype = true;
            if (self.c.sptype.sub(1, 8).eq_str("liver-1 ") || self.c.sptype.sub(1, 8).eq_str("lipid-1 ")) || self.c.sptype.sub(1, 9).eq_str("breast-1 ") {
                if self.c.ppmst < -9998.0_f32 {
                    self.c.ppmst = 4.2_f32;
                }
                if self.c.ppmend > 9998.0_f32 {
                    self.c.ppmend = -2.0_f32;
                }
                if self.c.ppmst >= 6.0_f32 {
                    self.c.namrel.set("Water");
                    self.c.nrefpk[2] = 2;
                    self.c.ppmref[(2, 2)] = 4.65_f32;
                } else {
                    self.c.namrel.set("Lip09+Lip13");
                    self.c.nrefpk[2] = 1;
                }
                if (self.c.ppmst - self.c.ppmend) > 6.3_f32 {
                    self.c.nsubtk = 5;
                    self.c.xstep = 1.0_f32;
                }
            }
            self.c.atth2o = 1.0_f32;
            self.c.badref = true;
            self.c.chcomb[1].set("L20a+L20b+L20c+L20d+L20e+L20f+L13a+L13b+L13c+L13d+L13e+L13f+L13g+L13h+L13i+L13j+L09a+L09b+L09c+L09d+L09e+L09f+L09g");
            self.c.chcomb[2].set("L13j+L13i+L13h+L09g+L13g+L09f+L13f+L09e+L13e+L09d+L13d+L09c+L13c+L09b+L13b+L09a+L13a");
            self.c.chcomb[3].set("L13j+L13i+L13h+L13g+L13f+L13e+L13d+L13c+L13b+L13a");
            self.c.chcomb[4].set("L09g+L09f+L09e+L09d+L09c+L09b+L09a");
            self.c.chcomb[5].set("L20f+L20e+L20d+L20c+L20b+L20a");
            self.c.chcomb[6].set("L53f+L53e+L53d+L53c+L53b+L53a");
            self.c.chcomb[7].set("W11+W10+W9+W8+L53f+W7+L53e+W6+L53d+W5+L53c+W4+L53b+W3+L53a+W2+W1");
            self.c.chcomb[8].set("W11+W10+W9+W8+W7+W6+W5+W4+W3+W2+W1");
            self.c.chcomb[9].set("cho1+cho2+cho3+cho4+cho5+cho6");
            self.c.chcomb[10].set("glycg1+glycg2+glycg3+glycg4+glycg5+glycg6+glycg7");
            self.c.chcom2[1].set("L20+L13+L09");
            self.c.chcom2[2].set("Lip09+Lip13");
            self.c.chcom2[3].set("Lip13");
            self.c.chcom2[4].set("Lip09");
            self.c.chcom2[5].set("Lip20");
            self.c.chcom2[6].set("Lip53");
            self.c.chcom2[7].set("Lip53+Water");
            self.c.chcom2[8].set("Water");
            self.c.chcom2[9].set("Cho");
            self.c.chcom2[10].set("Glycg");
            self.c.chgrsh[1].set("L53");
            self.c.chgrsh[2].set("L20");
            self.c.chgrsh[3].set("L13");
            self.c.chgrsh[4].set("L09");
            self.c.chgrsh[5].set("cho");
            self.c.chnot1[1].set("L53a");
            self.c.chnot1[2].set("L53b");
            self.c.chnot1[3].set("L53c");
            self.c.chnot1[4].set("L53d");
            self.c.chnot1[5].set("L53e");
            self.c.chnot1[6].set("L53f");
            self.c.chnot1[7].set("L20a");
            self.c.chnot1[8].set("L20b");
            self.c.chnot1[9].set("L20c");
            self.c.chnot1[10].set("L20d");
            self.c.chnot1[11].set("L20e");
            self.c.chnot1[12].set("L20f");
            self.c.chnot1[13].set("L13d");
            self.c.chnot1[14].set("L13e");
            self.c.chnot1[15].set("L13f");
            self.c.chnot1[16].set("L13g");
            self.c.chnot1[17].set("L13h");
            self.c.chnot1[18].set("L13i");
            self.c.chnot1[19].set("L13j");
            self.c.chnot1[20].set("L09a");
            self.c.chnot1[21].set("L09b");
            self.c.chnot1[22].set("L09c");
            self.c.chnot1[23].set("L09d");
            self.c.chnot1[24].set("L09e");
            self.c.chnot1[25].set("L09f");
            self.c.chnot1[26].set("L09g");
            self.c.chnot1[27].set("cho1");
            self.c.chnot1[28].set("cho2");
            self.c.chnot1[29].set("cho3");
            self.c.chnot1[30].set("cho4");
            self.c.chnot1[31].set("cho5");
            self.c.chnot1[32].set("cho6");
            self.c.chnot1[33].set("glycg1");
            self.c.chnot1[34].set("glycg2");
            self.c.chnot1[35].set("glycg3");
            self.c.chnot1[36].set("glycg4");
            self.c.chnot1[37].set("glycg5");
            self.c.chnot1[38].set("glycg6");
            self.c.chnot1[39].set("glycg7");
            self.c.chsimu[1].set("L53a @ 5.33+-.02 FWHM=.2<.23+-.03 AMP=1.");
            self.c.chsimu[2].set("L53b @ 5.33+-.02 FWHM=.3<.33+-.03 AMP=1.");
            self.c.chsimu[3].set("L53c @ 5.33+-.02 FWHM=.4<.43+-.03 AMP=1.");
            self.c.chsimu[4].set("L53d @ 5.33+-.02 FWHM=.5<.53+-.03 AMP=1.");
            self.c.chsimu[5].set("L53e @ 5.33+-.02 FWHM=.6<.63+-.03 AMP=1.");
            self.c.chsimu[6].set("L53f @ 5.33+-.02 FWHM=.7<.73+-.03 AMP=1.");
            self.c.chsimu[7].set("W1 @ 4.65+-.05 FWHM=.01<.04+-.03 AMP=1.");
            self.c.chsimu[8].set("W2 @ 4.65+-.05 FWHM=.05<.08+-.03 AMP=1.");
            self.c.chsimu[9].set("W3 @ 4.65+-.05 FWHM=.15<.18+-.03 AMP=1.");
            self.c.chsimu[10].set("W4 @ 4.65+-.05 FWHM=.25<.28+-.03 AMP=1.");
            self.c.chsimu[11].set("W5 @ 4.65+-.05 FWHM=.35<.38+-.03 AMP=1.");
            self.c.chsimu[12].set("W6 @ 4.65+-.05 FWHM=.45<.48+-.03 AMP=1.");
            self.c.chsimu[13].set("W7 @ 4.65+-.05 FWHM=.55<.58+-.03 AMP=1.");
            self.c.chsimu[14].set("W8 @ 4.65+-.05 FWHM=.65<.68+-.03 AMP=1.");
            self.c.chsimu[15].set("W9 @ 4.65+-.05 FWHM=.75<.78+-.03 AMP=1.");
            self.c.chsimu[16].set("W10 @ 4.65+-.05 FWHM=.85<.88+-.03 AMP=1.");
            self.c.chsimu[17].set("W11 @ 4.65+-.05 FWHM=.95<.98+-.03 AMP=1.");
            self.c.chsimu[18].set("L20a @ 2.06+-.02 FWHM=.1<.13+-.03 AMP=.58                         @ 2.25 FWHM=.1 AMP=.29  @ 2.7 FWHM=.15 AMP=.13");
            self.c.chsimu[19].set("L20b @ 2.06+-.02 FWHM=.2<.23+-.03 AMP=.58                         @ 2.25 FWHM=.2 AMP=.29  @ 2.7 FWHM=.25 AMP=.13");
            self.c.chsimu[20].set("L20c @ 2.06+-.02 FWHM=.3<.33+-.03 AMP=.58                         @ 2.25 FWHM=.3 AMP=.29  @ 2.7 FWHM=.35 AMP=.13");
            self.c.chsimu[21].set("L20d @ 2.06+-.02 FWHM=.4<.43+-.03 AMP=.58                         @ 2.25 FWHM=.4 AMP=.29  @ 2.7 FWHM=.45 AMP=.13");
            self.c.chsimu[22].set("L20e @ 2.06+-.02 FWHM=.5<.53+-.03 AMP=.58                         @ 2.25 FWHM=.5 AMP=.29  @ 2.7 FWHM=.55 AMP=.13");
            self.c.chsimu[23].set("L20f @ 2.06+-.02 FWHM=.6<.63+-.03 AMP=.58                         @ 2.25 FWHM=.6 AMP=.29  @ 2.7 FWHM=.65 AMP=.13");
            self.c.chsimu[24].set("L13a @ 1.28+-.02 FWHM=.05<.08+-.03 AMP=1.");
            self.c.chsimu[25].set("L13b @ 1.28+-.02 FWHM=.15<.18+-.03 AMP=1.");
            self.c.chsimu[26].set("L13c @ 1.28+-.02 FWHM=.25<.28+-.03 AMP=1.");
            self.c.chsimu[27].set("L13d @ 1.28+-.02 FWHM=.35<.38+-.03 AMP=1.");
            self.c.chsimu[28].set("L13e @ 1.28+-.02 FWHM=.45<.48+-.03 AMP=1.");
            self.c.chsimu[29].set("L13f @ 1.28+-.02 FWHM=.55<.58+-.03 AMP=1.");
            self.c.chsimu[30].set("L13g @ 1.28+-.02 FWHM=.65<.68+-.03 AMP=1.");
            self.c.chsimu[31].set("L13h @ 1.28+-.02 FWHM=.75<.78+-.03 AMP=1.");
            self.c.chsimu[32].set("L13i @ 1.28+-.02 FWHM=.85<.88+-.03 AMP=1.");
            self.c.chsimu[33].set("L13j @ 1.28+-.02 FWHM=.95<.98+-.03 AMP=1.");
            self.c.chsimu[34].set("L09a @ .87+-.02 FWHM=.15<.18+-.03 AMP=1.");
            self.c.chsimu[35].set("L09b @ .87+-.02 FWHM=.25<.28+-.03 AMP=1.");
            self.c.chsimu[36].set("L09c @ .87+-.02 FWHM=.35<.38+-.03 AMP=1.");
            self.c.chsimu[37].set("L09d @ .87+-.02 FWHM=.45<.48+-.03 AMP=1.");
            self.c.chsimu[38].set("L09e @ .87+-.02 FWHM=.55<.58+-.03 AMP=1.");
            self.c.chsimu[39].set("L09f @ .87+-.02 FWHM=.65<.68+-.03 AMP=1.");
            self.c.chsimu[40].set("L09g @ .87+-.02 FWHM=.75<.78+-.03 AMP=1.");
            self.c.chsimu[41].set("cho1 @ 3.18+-.01 FWHM=.06<.08+-.01 AMP=1.");
            self.c.chsimu[42].set("cho2 @ 3.18+-.01 FWHM=.08<.10+-.01 AMP=1.");
            self.c.chsimu[43].set("cho3 @ 3.18+-.01 FWHM=.10<.12+-.01 AMP=1.");
            self.c.chsimu[44].set("cho4 @ 3.18+-.01 FWHM=.12<.14+-.01 AMP=1.");
            self.c.chsimu[45].set("cho5 @ 3.18+-.01 FWHM=.14<.16+-.01 AMP=1.");
            self.c.chsimu[46].set("cho6 @ 3.18+-.01 FWHM=.16<.18+-.01 AMP=1.");
            self.c.chsimu[47].set("glycg1 @ 3.82+-.01 FWHM=.09<.11+-.01 AMP=1.");
            self.c.chsimu[48].set("glycg2 @ 3.75+-.01 FWHM=.09<.11+-.01 AMP=1.");
            self.c.chsimu[49].set("glycg3 @ 3.68+-.01 FWHM=.09<.11+-.01 AMP=1.");
            self.c.chsimu[50].set("glycg4 @ 3.61+-.01 FWHM=.09<.11+-.01 AMP=1.");
            self.c.chsimu[51].set("glycg5 @ 3.54+-.01 FWHM=.09<.11+-.01 AMP=1.");
            self.c.chsimu[52].set("glycg6 @ 3.47+-.01 FWHM=.09<.11+-.01 AMP=1.");
            self.c.chsimu[53].set("glycg7 @ 3.40+-.01 FWHM=.09<.11+-.01 AMP=1.");
            self.c.dkntmn[2] = 2.4_f32;
            self.c.endpha = true;
            self.c.fwhmmx = 0.4_f32;
            self.c.fwhmst = 0.3_f32;
            self.c.gauss_rt2 = false;
            self.c.incsmx = 1;
            self.c.ncombi = 10;
            self.c.ngrsh = 5;
            self.c.nnot1 = 39;
            self.c.nobasi = true;
            self.c.nratio = 0;
            self.c.nsidmn = 1;
            self.c.nsidmx = 1;
            self.c.nsimul = 53;
            self.c.nuse1 = 0;
            self.c.onlyco = true;
            self.c.ppmref[(1, 2)] = 1.28_f32;
            self.c.sdgrsh[1] = 0.003_f32;
            self.c.sdgrsh[2] = 0.004_f32;
            self.c.sdgrsh[3] = 0.003_f32;
            self.c.sdgrsh[4] = 0.003_f32;
            self.c.sdgrsh[5] = 0.002_f32;
            self.c.shifmn[2] = -1.0_f32;
            self.c.shifmx[2] = 1.0_f32;
            self.c.vitro = true;
            self.c.wconc = 0.5_f32;
        }
        if ((((((self.c.sptype.sub(1, 7).eq_str("liver-2") || self.c.sptype.sub(1, 7).eq_str("lipid-2")) || self.c.sptype.sub(1, 8).eq_str("breast-2")) || self.c.sptype.sub(1, 10).eq_str("only-cho-1")) || self.c.sptype.sub(1, 7).eq_str("lipid-3")) || self.c.sptype.sub(1, 7).eq_str("liver-3")) || self.c.sptype.sub(1, 8).eq_str("breast-3")) || self.c.sptype.sub(1, 10).eq_str("only-cho-2") {
            self.c.chcomb[1].set("L20a+L20b+L20c+L20d+L20e+L20f+L13a+L13b+L13c+L13d+L13e+L13f+L13g+L13h+L09a+L09b+L09c+L09d+L09e+L09f");
            self.c.chcomb[2].set("L13h+L13g+L09f+L13f+L09e+L13e+L09d+L13d+L09c+L13c+L09b+L13b+L09a+L13a");
            self.c.chcomb[3].set("L13h+L13g+L13f+L13e+L13d+L13c+L13b+L13a");
            self.c.chcomb[4].set("L09f+L09e+L09d+L09c+L09b+L09a");
            self.c.chcomb[9].set("cho1+cho2+cho3+cho4+cho5+cho6+cho7");
            self.c.chcomb[10].set("glycg1+glycg2+glycg3+glycg4");
            for j in 13..=17 {
                self.c.chnot1[j].set("xqlytc");
            }
            self.c.chnot1[27].set("cho7");
            self.c.chnot1[28].set("xqlytc");
            self.c.chnot1[29].set("xqlytc");
            self.c.chsimu[18].set("L20a @ 2.02+-.03 FWHM=.1<.13+-.03 AMP=.58                         @ 2.23 FWHM=.1 AMP=.29  @ 2.76 FWHM=.15 AMP=.13");
            self.c.chsimu[19].set("L20b @ 2.02+-.03 FWHM=.2<.23+-.03 AMP=.58                         @ 2.23 FWHM=.2 AMP=.29  @ 2.76 FWHM=.25 AMP=.13");
            self.c.chsimu[20].set("L20c @ 2.02+-.03 FWHM=.3<.33+-.03 AMP=.58                         @ 2.23 FWHM=.3 AMP=.29  @ 2.76 FWHM=.35 AMP=.13");
            self.c.chsimu[21].set("L20d @ 2.02+-.03 FWHM=.4<.43+-.03 AMP=.58                         @ 2.23 FWHM=.4 AMP=.29  @ 2.76 FWHM=.45 AMP=.13");
            self.c.chsimu[22].set("L20e @ 2.02+-.03 FWHM=.5<.53+-.03 AMP=.58                         @ 2.23 FWHM=.5 AMP=.29  @ 2.76 FWHM=.55 AMP=.13");
            self.c.chsimu[23].set("L20f @ 2.02+-.03 FWHM=.6<.63+-.03 AMP=.58                         @ 2.23 FWHM=.6 AMP=.29  @ 2.76 FWHM=.65 AMP=.13");
            self.c.chsimu[24].set("L13a @ 1.28+-.02 FWHM=.04<.08+-.03 AMP=1.");
            self.c.chsimu[32].set("L09a @ .87+-.02 FWHM=.15<.18+-.03 AMP=1.");
            self.c.chsimu[33].set("L09b @ .87+-.02 FWHM=.25<.28+-.03 AMP=1.");
            self.c.chsimu[34].set("L09c @ .87+-.02 FWHM=.35<.38+-.03 AMP=1.");
            self.c.chsimu[35].set("L09d @ .87+-.02 FWHM=.45<.48+-.03 AMP=1.");
            self.c.chsimu[36].set("L09e @ .87+-.02 FWHM=.55<.58+-.03 AMP=1.");
            self.c.chsimu[37].set("L09f @ .87+-.02 FWHM=.65<.68+-.03 AMP=1.");
            self.c.chsimu[38].set("cho1 @ 3.185+-.01 FWHM=.030<.050+-.012 AMP=1.");
            self.c.chsimu[39].set("cho2 @ 3.185+-.01 FWHM=.074<.086+-.012 AMP=1.");
            self.c.chsimu[40].set("cho3 @ 3.185+-.01 FWHM=.110<.122+-.012 AMP=1.");
            self.c.chsimu[41].set("cho4 @ 3.185+-.01 FWHM=.146<.158+-.012 AMP=1.");
            self.c.chsimu[42].set("cho5 @ 3.185+-.01 FWHM=.182<.194+-.012 AMP=1.");
            self.c.chsimu[43].set("cho6 @ 3.185+-.01 FWHM=.218<.230+-.012 AMP=1.");
            self.c.chsimu[44].set("cho7 @ 3.185+-.01 FWHM=.254<.266+-.012 AMP=1.");
            self.c.chsimu[45].set("glycg1 @ 3.82+-.01 FWHM=.09<.11+-.01 AMP=1.");
            self.c.chsimu[46].set("glycg2 @ 3.75+-.01 FWHM=.09<.11+-.01 AMP=1.");
            self.c.chsimu[47].set("glycg3 @ 3.68+-.01 FWHM=.09<.11+-.01 AMP=1.");
            self.c.chsimu[48].set("glycg4 @ 3.61+-.01 FWHM=.09<.11+-.01 AMP=1.");
            if self.c.ppmst < -9998.0_f32 {
                self.c.ppmst = 3.6_f32;
            }
            if self.c.ppmend > 9998.0_f32 {
                self.c.ppmend = -2.0_f32;
            }
            if (self.c.ppmst - self.c.ppmend) >= 6.4_f32 {
                self.c.nsubtk = 5;
                self.c.xstep = 1.0_f32;
            }
            if self.c.ppmst >= 5.0_f32 {
                self.c.namrel.set("Water");
            } else {
                if (self.c.sptype.sub(1, 7).eq_str("liver-2") || self.c.sptype.sub(1, 8).eq_str("breast-2")) || self.c.sptype.sub(1, 10).eq_str("only-cho-1") {
                    self.c.idgppm = 1;
                }
                self.c.namrel.set("Lip09+Lip13");
                self.c.nchles = 2;
                self.c.nnot1 = 0;
                self.c.ralinc = 1.4_f32;
                self.c.rfwhcc = 0.0_f32;
                self.c.rrt2mq = 0.25_f32;
            }
            if ((self.c.sptype.sub(1, 7).eq_str("lipid-3") || self.c.sptype.sub(1, 7).eq_str("liver-3")) || self.c.sptype.sub(1, 8).eq_str("breast-3")) || self.c.sptype.sub(1, 10).eq_str("only-cho-2") {
                self.c.idgppm = 2;
            }
            self.c.nrefpk[2] = 1;
            self.c.nsimul = 48;
            self.c.prmnmx[(1, 1)] = 0.5_f32;
            self.c.prmnmx[(2, 1)] = 0.95_f32;
            self.c.sdgrsh[2] = 0.006_f32;
            self.c.sdsmoo[3] = 0.03_f32;
            self.c.shifmn[1] = -4.0_f32;
            self.c.shifmn[2] = -1.0_f32;
            self.c.shifmx[1] = 1.0_f32;
            self.c.shifmx[2] = 2.5_f32;
            self.c.useany = true;
        }
        if (self.c.sptype.sub(1, 7).eq_str("lipid-4") || self.c.sptype.sub(1, 7).eq_str("liver-4")) || self.c.sptype.sub(1, 8).eq_str("breast-4") {
            *is_sptype = true;
            self.c.atth2o = 1.0_f32;
            self.c.chcomb[1].set("L20a+L20b+L20c+L20d+L20e+L20f+L16a+L16b+L16c+L13a+L13b+L13c+L13d+L13e+L13f+L13g+L13h+L13i+L09a+L09b+L09c+L09d+L09e+L09f");
            self.c.chcomb[2].set("L16a+L16b+L16c+L13a+L13b+L13c+L13d+L13e+L13f+L13g+L13h+L13i+L09a+L09b+L09c+L09d+L09e+L09f");
            self.c.chcomb[3].set("L16a+L16b+L16c+L13a+L13b+L13c+L13d+L13e+L13f+L13g+L13h+L13i");
            self.c.chcomb[4].set("L13i+L13h+L13g+L13f+L13e+L13d+L13c+L13b+L13a");
            self.c.chcomb[5].set("L09f+L09e+L09d+L09c+L09b+L09a");
            self.c.chcomb[6].set("L16a+L16b+L16c");
            self.c.chcomb[7].set("L20f+L20e+L20d+L20c+L20b+L20a");
            self.c.chcomb[8].set("L53f+L53e+L53d+L53c+L53b+L53a");
            self.c.chcomb[9].set("L53a+L53b+L53c+L53d+L53e+L53f+W1+W2+W3+W4+W5+W6+W7+W8+W9+W10+W11");
            self.c.chcomb[10].set("W1+W2+W3+W4+W5+W6+W7+W8+W9+W10+W11");
            self.c.chcomb[11].set("cho1+cho2+cho3+cho4+cho5+cho6+cho7");
            self.c.chcomb[12].set("glycg1+glycg2+glycg3+glycg4");
            self.c.chcom2[1].set("L20+L16+L09+L13");
            self.c.chcom2[2].set("L16+L09+L13");
            self.c.chcom2[3].set("Lip16+Lip13");
            self.c.chcom2[4].set("Lip13");
            self.c.chcom2[5].set("Lip09");
            self.c.chcom2[6].set("Lip16");
            self.c.chcom2[7].set("Lip20");
            self.c.chcom2[8].set("Lip53");
            self.c.chcom2[9].set("Lip53+Water");
            self.c.chcom2[10].set("Water");
            self.c.chcom2[11].set("Cho");
            self.c.chcom2[12].set("Glycg");
            self.c.chgrsh[1].set("L53");
            self.c.chgrsh[2].set("L20");
            self.c.chgrsh[3].set("L13");
            self.c.chgrsh[4].set("L09");
            self.c.chgrsh[5].set("cho");
            self.c.chgrsh[6].set("L16");
            self.c.chsimu[1].set("L53a @ 5.33+-.02 FWHM=.2<.23+-.03 AMP=1.");
            self.c.chsimu[2].set("L53b @ 5.33+-.02 FWHM=.3<.33+-.03 AMP=1.");
            self.c.chsimu[3].set("L53c @ 5.33+-.02 FWHM=.4<.43+-.03 AMP=1.");
            self.c.chsimu[4].set("L53d @ 5.33+-.02 FWHM=.5<.53+-.03 AMP=1.");
            self.c.chsimu[5].set("L53e @ 5.33+-.02 FWHM=.6<.63+-.03 AMP=1.");
            self.c.chsimu[6].set("L53f @ 5.33+-.02 FWHM=.7<.73+-.03 AMP=1.");
            self.c.chsimu[7].set("W1 @ 4.65+-.05 FWHM=.01<.04+-.03 AMP=1.");
            self.c.chsimu[8].set("W2 @ 4.65+-.05 FWHM=.05<.08+-.03 AMP=1.");
            self.c.chsimu[9].set("W3 @ 4.65+-.05 FWHM=.15<.18+-.03 AMP=1.");
            self.c.chsimu[10].set("W4 @ 4.65+-.05 FWHM=.25<.28+-.03 AMP=1.");
            self.c.chsimu[11].set("W5 @ 4.65+-.05 FWHM=.35<.38+-.03 AMP=1.");
            self.c.chsimu[12].set("W6 @ 4.65+-.05 FWHM=.45<.48+-.03 AMP=1.");
            self.c.chsimu[13].set("W7 @ 4.65+-.05 FWHM=.55<.58+-.03 AMP=1.");
            self.c.chsimu[14].set("W8 @ 4.65+-.05 FWHM=.65<.68+-.03 AMP=1.");
            self.c.chsimu[15].set("W9 @ 4.65+-.05 FWHM=.75<.78+-.03 AMP=1.");
            self.c.chsimu[16].set("W10 @ 4.65+-.05 FWHM=.85<.88+-.03 AMP=1.");
            self.c.chsimu[17].set("W11 @ 4.65+-.05 FWHM=.95<.98+-.03 AMP=1.");
            self.c.chsimu[18].set("L20a @ 2.02+-.03 FWHM=.07<.1+-.03 AMP=.58                        @ 2.23 FWHM=.07 AMP=.29  @ 2.75 FWHM=.060 AMP=.13");
            self.c.chsimu[19].set("L20b @ 2.02+-.03 FWHM=.17<.2+-.03 AMP=.58                        @ 2.23 FWHM=.17 AMP=.29  @ 2.75 FWHM=.146 AMP=.13");
            self.c.chsimu[20].set("L20c @ 2.02+-.03 FWHM=.27<.3+-.03 AMP=.58                        @ 2.23 FWHM=.27 AMP=.29  @ 2.75 FWHM=.231 AMP=.13");
            self.c.chsimu[21].set("L20d @ 2.02+-.03 FWHM=.37<.4+-.03 AMP=.58                        @ 2.23 FWHM=.37 AMP=.29  @ 2.75 FWHM=.317 AMP=.13");
            self.c.chsimu[22].set("L20e @ 2.02+-.03 FWHM=.47<.5+-.03 AMP=.58                        @ 2.23 FWHM=.47 AMP=.29  @ 2.75 FWHM=.403 AMP=.13");
            self.c.chsimu[23].set("L20f @ 2.02+-.03 FWHM=.57<.6+-.03 AMP=.58                        @ 2.23 FWHM=.57 AMP=.29  @ 2.75 FWHM=.488 AMP=.13");
            self.c.chsimu[24].set("L16a @ 1.58+-.01 FWHM=.06<.09+-.03 AMP=1.");
            self.c.chsimu[25].set("L16b @ 1.58+-.01 FWHM=.16<.19+-.03 AMP=1.");
            self.c.chsimu[26].set("L16c @ 1.58+-.01 FWHM=.26<.29+-.03 AMP=1.");
            self.c.chsimu[27].set("L13a @ 1.28+-.02 FWHM=.04<.05+-.01 AMP=1.");
            self.c.chsimu[28].set("L13b @ 1.28+-.02 FWHM=.07<.09+-.02 AMP=1.");
            self.c.chsimu[29].set("L13c @ 1.28+-.02 FWHM=.13<.16+-.03 AMP=1.");
            self.c.chsimu[30].set("L13d @ 1.28+-.02 FWHM=.23<.26+-.03 AMP=1.");
            self.c.chsimu[31].set("L13e @ 1.28+-.02 FWHM=.33<.36+-.03 AMP=1.");
            self.c.chsimu[32].set("L13f @ 1.28+-.02 FWHM=.43<.46+-.03 AMP=1.");
            self.c.chsimu[33].set("L13g @ 1.28+-.02 FWHM=.53<.56+-.03 AMP=1.");
            self.c.chsimu[34].set("L13h @ 1.28+-.02 FWHM=.63<.66+-.03 AMP=1.");
            self.c.chsimu[35].set("L13i @ 1.28+-.02 FWHM=.73<.76+-.03 AMP=1.");
            self.c.chsimu[36].set("L09a @ .87+-.02 FWHM=.1<.13+-.03 AMP=1.");
            self.c.chsimu[37].set("L09b @ .87+-.02 FWHM=.2<.23+-.03 AMP=1.");
            self.c.chsimu[38].set("L09c @ .87+-.02 FWHM=.3<.33+-.03 AMP=1.");
            self.c.chsimu[39].set("L09d @ .87+-.02 FWHM=.4<.43+-.03 AMP=1.");
            self.c.chsimu[40].set("L09e @ .87+-.02 FWHM=.5<.53+-.03 AMP=1.");
            self.c.chsimu[41].set("L09f @ .87+-.02 FWHM=.6<.63+-.03 AMP=1.");
            self.c.chsimu[42].set("cho1 @ 3.185+-.01 FWHM=.030<.050+-.012 AMP=1.");
            self.c.chsimu[43].set("cho2 @ 3.185+-.01 FWHM=.074<.086+-.012 AMP=1.");
            self.c.chsimu[44].set("cho3 @ 3.185+-.01 FWHM=.110<.122+-.012 AMP=1.");
            self.c.chsimu[45].set("cho4 @ 3.185+-.01 FWHM=.146<.158+-.012 AMP=1.");
            self.c.chsimu[46].set("cho5 @ 3.185+-.01 FWHM=.182<.194+-.012 AMP=1.");
            self.c.chsimu[47].set("cho6 @ 3.185+-.01 FWHM=.218<.230+-.012 AMP=1.");
            self.c.chsimu[48].set("cho7 @ 3.185+-.01 FWHM=.254<.266+-.012 AMP=1.");
            self.c.chsimu[49].set("glycg1 @ 3.82+-.01 FWHM=.09<.11+-.01 AMP=1.");
            self.c.chsimu[50].set("glycg2 @ 3.75+-.01 FWHM=.09<.11+-.01 AMP=1.");
            self.c.chsimu[51].set("glycg3 @ 3.68+-.01 FWHM=.09<.11+-.01 AMP=1.");
            self.c.chsimu[52].set("glycg4 @ 3.61+-.01 FWHM=.09<.11+-.01 AMP=1.");
            self.c.dkntmn[2] = 2.4_f32;
            self.c.endpha = true;
            self.c.fwhmmx = 0.4_f32;
            self.c.fwhmst = 0.3_f32;
            self.c.gauss_rt2 = false;
            self.c.incsmx = 1;
            self.c.idgppm = 2;
            self.c.ncombi = 12;
            self.c.ngrsh = 6;
            self.c.nobasi = true;
            self.c.nratio = 0;
            self.c.nrefpk[2] = 1;
            self.c.nsidmn = 1;
            self.c.nsidmx = 1;
            self.c.nsimul = 52;
            self.c.onlyco = true;
            self.c.ppmref[(1, 2)] = 1.28_f32;
            if self.c.ppmst < -9998.0_f32 {
                self.c.ppmst = 3.6_f32;
            }
            if self.c.ppmend > 9998.0_f32 {
                self.c.ppmend = -1.0_f32;
            }
            if (self.c.ppmst - self.c.ppmend) >= 6.4_f32 {
                self.c.nsubtk = 5;
                self.c.xstep = 1.0_f32;
            }
            if self.c.ppmst < 5.0_f32 {
                self.c.badref = true;
                self.c.chless[1].set("L09");
                self.c.chless[2].set("L20");
                self.c.chnot1[1].set("L16a");
                self.c.chnot1[2].set("L16b");
                self.c.chnot1[3].set("L16c");
                self.c.namrel.set("L16+L09+L13");
                self.c.nchles = 2;
                self.c.nnot1 = 3;
                self.c.ralinc = 1.4_f32;
                self.c.rfwhcc = 0.0_f32;
                self.c.rrt2mq = 0.25_f32;
            } else {
                self.c.chuse1[1].set("L13a");
                self.c.chuse1[2].set("L13b");
                self.c.chuse1[3].set("L13c");
                self.c.chuse1[4].set("L13d");
                self.c.chuse1[5].set("L13e");
                self.c.chuse1[6].set("L13f");
                self.c.chuse1[7].set("L13g");
                self.c.chuse1[8].set("L13h");
                self.c.chuse1[9].set("L13i");
                self.c.chuse1[10].set("W1");
                self.c.chuse1[11].set("W2");
                self.c.chuse1[12].set("W3");
                self.c.chuse1[13].set("W4");
                self.c.chuse1[14].set("W5");
                self.c.chuse1[15].set("W6");
                self.c.chuse1[16].set("W7");
                self.c.chuse1[17].set("W8");
                self.c.chuse1[18].set("W9");
                self.c.chuse1[19].set("W10");
                self.c.chuse1[20].set("W11");
                self.c.namrel.set("Water");
                self.c.nuse1 = 20;
            }
            self.c.prmnmx[(1, 1)] = 0.5_f32;
            self.c.prmnmx[(2, 1)] = 0.95_f32;
            self.c.sdgrsh[1] = 0.003_f32;
            self.c.sdgrsh[2] = 0.006_f32;
            self.c.sdgrsh[3] = 0.003_f32;
            self.c.sdgrsh[4] = 0.003_f32;
            self.c.sdgrsh[5] = 0.002_f32;
            self.c.sdgrsh[6] = 0.003_f32;
            self.c.sdsmoo[3] = 0.03_f32;
            self.c.shifmn[1] = -4.0_f32;
            self.c.shifmn[2] = -1.0_f32;
            self.c.shifmx[1] = 1.0_f32;
            self.c.shifmx[2] = 2.5_f32;
            self.c.useany = true;
            self.c.vitro = true;
            self.c.wconc = 0.5_f32;
        }
        if (self.c.sptype.sub(1, 7).eq_str("lipid-5") || self.c.sptype.sub(1, 8).eq_str("breast-5")) || self.c.sptype.sub(1, 7).eq_str("liver-5") {
            *is_sptype = true;
            self.c.atth2o = 1.0_f32;
            self.c.chcomb[1].set("L16a+L16b+L16c+L16d+L13a+L13b+L13c+L13d+L13e+L13f+L09a+L09b+L09c+L09d+L09e");
            self.c.chcomb[2].set("L16a+L16b+L16c+L16d+L13a+L13b+L13c+L13d+L13e+L13f");
            self.c.chcomb[3].set("L28a+L28b+L28c+L28d+L23a+L23b+L23c+L23d+L21a+L21b+L21c+L21d");
            self.c.chcomb[4].set("L13f+L13e+L13d+L13c+L13b+L13a");
            self.c.chcomb[5].set("L09e+L09d+L09c+L09b+L09a");
            self.c.chcomb[6].set("L16a+L16b+L16c+L16d");
            self.c.chcomb[7].set("L21a+L21b+L21c+L21d");
            self.c.chcomb[8].set("L23a+L23b+L23c+L23d");
            self.c.chcomb[9].set("L28a+L28b+L28c+L28d");
            self.c.chcomb[10].set("L53a+L53b+L53c+L53d+L52a+L52b+L52c+L52d");
            self.c.chcomb[11].set("L53a+L53b+L53c+L53d+L52a+L52b+L52c+L52d+W1+W2+W3+W4+W5+W6+W7+W8+W9");
            self.c.chcomb[12].set("W1+W2+W3+W4+W5+W6+W7+W8+W9");
            self.c.chcomb[13].set("cho1+cho2+cho3+cho4+cho5");
            self.c.chcomb[14].set("glycg1+glycg2+glycg3+glycg4");
            self.c.chcom2[1].set("L16+L09+L13");
            self.c.chcom2[2].set("Lip16+Lip13");
            self.c.chcom2[3].set("L28+L23+L21");
            self.c.chcom2[4].set("Lip13");
            self.c.chcom2[5].set("Lip09");
            self.c.chcom2[6].set("Lip16");
            self.c.chcom2[7].set("Lip21");
            self.c.chcom2[8].set("Lip23");
            self.c.chcom2[9].set("Lip28");
            self.c.chcom2[10].set("Lip53+Lip52");
            self.c.chcom2[11].set("L53+L52+Water");
            self.c.chcom2[12].set("Water");
            self.c.chcom2[13].set("Cho");
            self.c.chcom2[14].set("Glycg");
            self.c.chgrsh[1].set("L28");
            self.c.chgrsh[2].set("L23");
            self.c.chgrsh[3].set("L21");
            self.c.chgrsh[4].set("L13");
            self.c.chgrsh[5].set("L09");
            self.c.chgrsh[6].set("cho");
            self.c.chgrsh[7].set("L16");
            self.c.chless[1].set("L09");
            self.c.chless[2].set("L20");
            self.c.chnot2[1].set("L20a");
            self.c.chnot2[2].set("L20b");
            self.c.chnot2[3].set("L20c");
            self.c.chsimu[1].set("L53a @ 5.31+-.02 FWHM=.06<.095+-.0175 AMP=1.");
            self.c.chsimu[2].set("L53b @ 5.31+-.02 FWHM=.13<.165+-.0175 AMP=1.");
            self.c.chsimu[3].set("L53c @ 5.31+-.02 FWHM=.20<.235+-.0175 AMP=1.");
            self.c.chsimu[4].set("L53d @ 5.31+-.02 FWHM=.27<.290+-.0100 AMP=1.");
            self.c.chsimu[5].set("L52a @ 5.21+-.02 FWHM=.06<.095+-.0175 AMP=1.");
            self.c.chsimu[6].set("L52b @ 5.21+-.02 FWHM=.13<.165+-.0175 AMP=1.");
            self.c.chsimu[7].set("L52c @ 5.21+-.02 FWHM=.20<.235+-.0175 AMP=1.");
            self.c.chsimu[8].set("L52d @ 5.21+-.02 FWHM=.27<.290+-.0100 AMP=1.");
            if self.c.roomt {
                self.c.chsimu[9].set("W1 @ 4.83+-.05 FWHM=.01<.04+-.03 AMP=1.");
                self.c.chsimu[10].set("W2 @ 4.83+-.05 FWHM=.05<.08+-.03 AMP=1.");
                self.c.chsimu[11].set("W3 @ 4.83+-.05 FWHM=.15<.18+-.03 AMP=1.");
                self.c.chsimu[12].set("W4 @ 4.83+-.05 FWHM=.25<.28+-.03 AMP=1.");
                self.c.chsimu[13].set("W5 @ 4.83+-.05 FWHM=.35<.38+-.03 AMP=1.");
                self.c.chsimu[14].set("W6 @ 4.83+-.05 FWHM=.45<.48+-.03 AMP=1.");
                self.c.chsimu[15].set("W7 @ 4.83+-.05 FWHM=.55<.58+-.03 AMP=1.");
                self.c.chsimu[16].set("W8 @ 4.83+-.05 FWHM=.65<.68+-.03 AMP=1.");
                self.c.chsimu[17].set("W9 @ 4.83+-.05 FWHM=.75<.78+-.03 AMP=1.");
            } else {
                self.c.chsimu[9].set("W1 @ 4.65+-.05 FWHM=.01<.04+-.03 AMP=1.");
                self.c.chsimu[10].set("W2 @ 4.65+-.05 FWHM=.05<.08+-.03 AMP=1.");
                self.c.chsimu[11].set("W3 @ 4.65+-.05 FWHM=.15<.18+-.03 AMP=1.");
                self.c.chsimu[12].set("W4 @ 4.65+-.05 FWHM=.25<.28+-.03 AMP=1.");
                self.c.chsimu[13].set("W5 @ 4.65+-.05 FWHM=.35<.38+-.03 AMP=1.");
                self.c.chsimu[14].set("W6 @ 4.65+-.05 FWHM=.45<.48+-.03 AMP=1.");
                self.c.chsimu[15].set("W7 @ 4.65+-.05 FWHM=.55<.58+-.03 AMP=1.");
                self.c.chsimu[16].set("W8 @ 4.65+-.05 FWHM=.65<.68+-.03 AMP=1.");
                self.c.chsimu[17].set("W9 @ 4.65+-.05 FWHM=.75<.78+-.03 AMP=1.");
            }
            self.c.chsimu[18].set("L28a @ 2.75+-.01 FWHM=.06<.095+-.0175 AMP=1.");
            self.c.chsimu[19].set("L28b @ 2.75+-.01 FWHM=.13<.165+-.0175 AMP=1.");
            self.c.chsimu[20].set("L28c @ 2.75+-.01 FWHM=.20<.235+-.0175 AMP=1.");
            self.c.chsimu[21].set("L28d @ 2.75+-.01 FWHM=.27<.290+-.0100 AMP=1.");
            self.c.chsimu[22].set("L23a @ 2.23+-.01 FWHM=.06<.095+-.0175 AMP=1.");
            self.c.chsimu[23].set("L23b @ 2.23+-.01 FWHM=.13<.165+-.0175 AMP=1.");
            self.c.chsimu[24].set("L23c @ 2.23+-.01 FWHM=.20<.235+-.0175 AMP=1.");
            self.c.chsimu[25].set("L23d @ 2.23+-.01 FWHM=.27<.290+-.0100 AMP=1.");
            self.c.chsimu[26].set("L21a @ 2.02+-.01 FWHM=.06<.095+-.0175 AMP=1.");
            self.c.chsimu[27].set("L21b @ 2.02+-.01 FWHM=.13<.165+-.0175 AMP=1.");
            self.c.chsimu[28].set("L21c @ 2.02+-.01 FWHM=.20<.235+-.0175 AMP=1.");
            self.c.chsimu[29].set("L21d @ 2.02+-.01 FWHM=.27<.290+-.0100 AMP=1.");
            self.c.chsimu[30].set("L20a @ 2.02+-.03 FWHM=.07<.1+-.03 AMP=.58                        @ 2.23 FWHM=.07 AMP=.29  @ 2.75 FWHM=.060 AMP=.13");
            self.c.chsimu[31].set("L20b @ 2.02+-.03 FWHM=.17<.2+-.03 AMP=.58                        @ 2.23 FWHM=.17 AMP=.29  @ 2.75 FWHM=.146 AMP=.13");
            self.c.chsimu[32].set("L20c @ 2.02+-.03 FWHM=.27<.3+-.03 AMP=.58                        @ 2.23 FWHM=.27 AMP=.29  @ 2.75 FWHM=.231 AMP=.13");
            self.c.chsimu[33].set("L16a @ 1.58+-.01 FWHM=.06<.095+-.0175 AMP=1.");
            self.c.chsimu[34].set("L16b @ 1.58+-.01 FWHM=.13<.165+-.0175 AMP=1.");
            self.c.chsimu[35].set("L16c @ 1.58+-.01 FWHM=.20<.235+-.0175 AMP=1.");
            self.c.chsimu[36].set("L16d @ 1.58+-.01 FWHM=.27<.290+-.0100 AMP=1.");
            self.c.chsimu[37].set("L13a @ 1.28+-.02 FWHM=.03<.050+-.0100 AMP=1.");
            self.c.chsimu[38].set("L13b @ 1.28+-.02 FWHM=.07<.105+-.0175 AMP=1.");
            self.c.chsimu[39].set("L13c @ 1.28+-.02 FWHM=.14<.175+-.0175 AMP=1.");
            self.c.chsimu[40].set("L13d @ 1.28+-.02 FWHM=.21<.245+-.0175 AMP=1.");
            self.c.chsimu[41].set("L13e @ 1.28+-.02 FWHM=.28<.315+-.0175 AMP=1.");
            self.c.chsimu[42].set("L13f @ 1.28+-.02 FWHM=.35<.370+-.0100 AMP=1.");
            self.c.chsimu[43].set("L09a @ .87+-.02 FWHM=.06<.095+-.0175 AMP=1.");
            self.c.chsimu[44].set("L09b @ .87+-.02 FWHM=.13<.165+-.0175 AMP=1.");
            self.c.chsimu[45].set("L09c @ .87+-.02 FWHM=.20<.235+-.0175 AMP=1.");
            self.c.chsimu[46].set("L09d @ .87+-.02 FWHM=.27<.305+-.0175 AMP=1.");
            self.c.chsimu[47].set("L09e @ .87+-.02 FWHM=.34<.360+-.0100 AMP=1.");
            self.c.chsimu[48].set("cho1 @ 3.185+-.01 FWHM=.03<.05+-.01 AMP=1.");
            self.c.chsimu[49].set("cho2 @ 3.185+-.01 FWHM=.07<.09+-.01 AMP=1.");
            self.c.chsimu[50].set("cho3 @ 3.185+-.01 FWHM=.11<.13+-.01 AMP=1.");
            self.c.chsimu[51].set("cho4 @ 3.185+-.01 FWHM=.15<.17+-.01 AMP=1.");
            self.c.chsimu[52].set("cho5 @ 3.185+-.01 FWHM=.19<.21+-.01 AMP=1.");
            self.c.chsimu[53].set("glycg1 @ 3.82+-.01 FWHM=.09<.11+-.01 AMP=1.");
            self.c.chsimu[54].set("glycg2 @ 3.75+-.01 FWHM=.09<.11+-.01 AMP=1.");
            self.c.chsimu[55].set("glycg3 @ 3.68+-.01 FWHM=.09<.11+-.01 AMP=1.");
            self.c.chsimu[56].set("glycg4 @ 3.61+-.01 FWHM=.09<.11+-.01 AMP=1.");
            self.c.dkntmn[2] = 99.0_f32;
            self.c.endpha = true;
            self.c.fwhmmx = 0.4_f32;
            self.c.fwhmst = 0.3_f32;
            self.c.gauss_rt2 = false;
            self.c.incsmx = 1;
            self.c.idgppm = 2;
            self.c.ncombi = 14;
            self.c.ngrsh = 7;
            self.c.nnot2 = 3;
            self.c.nobasi = true;
            self.c.nratio = 0;
            self.c.nrefpk[2] = 1;
            self.c.nsidmn = 1;
            self.c.nsidmx = 1;
            self.c.nsimul = 56;
            self.c.onlyco = true;
            self.c.ppmref[(1, 2)] = 1.28_f32;
            if self.c.ppmst < -9998.0_f32 {
                self.c.ppmst = 3.6_f32;
            }
            if self.c.ppmend > 9998.0_f32 {
                self.c.ppmend = -1.0_f32;
            }
            if (self.c.ppmst - self.c.ppmend) >= 6.4_f32 {
                self.c.nsubtk = 5;
                self.c.xstep = 1.0_f32;
            }
            if self.c.dowatr && self.c.ppmst >= 5.0_f32 {
                self.c.chuse1[1].set("L13a");
                self.c.chuse1[2].set("L13b");
                self.c.chuse1[3].set("L13c");
                self.c.chuse1[4].set("L13d");
                self.c.chuse1[5].set("L13e");
                self.c.chuse1[6].set("L13f");
                self.c.chuse1[7].set("W1");
                self.c.chuse1[8].set("W2");
                self.c.chuse1[9].set("W3");
                self.c.chuse1[10].set("W4");
                self.c.chuse1[11].set("W5");
                self.c.chuse1[12].set("W6");
                self.c.chuse1[13].set("W7");
                self.c.chuse1[14].set("W8");
                self.c.chuse1[15].set("W9");
                self.c.namrel.set("Water");
                self.c.nuse1 = 15;
            } else {
                self.c.chuse1[1].set("L20a");
                self.c.chuse1[2].set("L20b");
                self.c.chuse1[3].set("L20c");
                self.c.chuse1[4].set("L13a");
                self.c.chuse1[5].set("L13b");
                self.c.chuse1[6].set("L13c");
                self.c.chuse1[7].set("L13d");
                self.c.chuse1[8].set("L13e");
                self.c.chuse1[9].set("L13f");
                self.c.chuse1[10].set("L09a");
                self.c.chuse1[11].set("L09b");
                self.c.chuse1[12].set("L09c");
                self.c.chuse1[13].set("L09d");
                self.c.chuse1[14].set("L09e");
                self.c.nchles = 2;
                self.c.nuse1 = 14;
                if self.c.ppmst >= 5.0_f32 {
                    self.c.namrel.set("Lip09");
                    self.c.ppmgap[(1, 1)] = 5.0_f32;
                    self.c.ppmgap[(2, 1)] = 3.6_f32;
                } else {
                    self.c.namrel.set("Lip23");
                    self.c.ralinc = 1.4_f32;
                    self.c.rfwhcc = 0.0_f32;
                    self.c.rrt2mq = 0.25_f32;
                }
            }
            self.c.prmnmx[(1, 1)] = 0.5_f32;
            self.c.prmnmx[(2, 1)] = 0.95_f32;
            self.c.sdgrsh[1] = 0.003_f32;
            self.c.sdgrsh[2] = 0.003_f32;
            self.c.sdgrsh[3] = 0.003_f32;
            self.c.sdgrsh[4] = 0.003_f32;
            self.c.sdgrsh[5] = 0.003_f32;
            self.c.sdgrsh[6] = 0.002_f32;
            self.c.sdgrsh[7] = 0.003_f32;
            self.c.sdsmoo[3] = 0.03_f32;
            self.c.shifmn[1] = -4.0_f32;
            self.c.shifmn[2] = -1.0_f32;
            self.c.shifmx[1] = 1.0_f32;
            self.c.shifmx[2] = 2.5_f32;
            self.c.useany = true;
            self.c.vitro = true;
            self.c.wconc = 0.5_f32;
        }
        if (self.c.sptype.sub(1, 7).eq_str("lipid-6") || self.c.sptype.sub(1, 7).eq_str("liver-6")) || self.c.sptype.sub(1, 8).eq_str("breast-6") {
            *is_sptype = true;
            self.c.atth2o = 1.0_f32;
            self.c.chcomb[1].set("L16a+L16b+L16c+L16d+L13a+L13b+L13c+L13d+L13e+L13f+L09a+L09b+L09c+L09d+L09e");
            self.c.chcomb[2].set("L16a+L16b+L16c+L16d+L13a+L13b+L13c+L13d+L13e+L13f");
            self.c.chcomb[3].set("L28a+L28b+L28c+L28d+L23a+L23b+L23c+L23d+L21a+L21b+L21c+L21d");
            self.c.chcomb[4].set("L13f+L13e+L13d+L13c+L13b+L13a");
            self.c.chcomb[5].set("L09e+L09d+L09c+L09b+L09a");
            self.c.chcomb[6].set("L16a+L16b+L16c+L16d");
            self.c.chcomb[7].set("L21a+L21b+L21c+L21d");
            self.c.chcomb[8].set("L23a+L23b+L23c+L23d");
            self.c.chcomb[9].set("L28a+L28b+L28c+L28d");
            self.c.chcomb[10].set("L53a+L53b+L53c+L53d+L52a+L52b+L52c+L52d");
            self.c.chcomb[11].set("W1+W2+W3+W4+W5+W6+W7+W8+W9");
            self.c.chcomb[12].set("cho1+cho2+cho3+cho4+cho5");
            self.c.chcomb[13].set("L43a+L43b");
            self.c.chcomb[14].set("L41a+L41b");
            self.c.chcomb[15].set("glycg1+glycg2+glycg3+glycg4");
            self.c.chcomb[16].set("L53a+L53b+L53c+L53d");
            self.c.chcomb[17].set("L52a+L52b+L52c+L52d");
            self.c.chcom2[1].set("L16+L09+L13");
            self.c.chcom2[2].set("Lip16+Lip13");
            self.c.chcom2[3].set("L28+L23+L21");
            self.c.chcom2[4].set("Lip13");
            self.c.chcom2[5].set("Lip09");
            self.c.chcom2[6].set("Lip16");
            self.c.chcom2[7].set("Lip21");
            self.c.chcom2[8].set("Lip23");
            self.c.chcom2[9].set("Lip28");
            self.c.chcom2[10].set("Lip53+Lip52");
            self.c.chcom2[11].set("Water");
            self.c.chcom2[12].set("Cho");
            self.c.chcom2[13].set("Lip43");
            self.c.chcom2[14].set("Lip41");
            self.c.chcom2[15].set("Glycg");
            self.c.chcom2[16].set("Lip53");
            self.c.chcom2[17].set("Lip52");
            self.c.chgrsh[1].set("L28");
            self.c.chgrsh[2].set("L23");
            self.c.chgrsh[3].set("L21");
            self.c.chgrsh[4].set("L13");
            self.c.chgrsh[5].set("L09");
            self.c.chgrsh[6].set("cho");
            self.c.chgrsh[7].set("L16");
            self.c.chgrsh[8].set("L43");
            self.c.chgrsh[9].set("L41");
            self.c.chgrsh[10].set("W");
            self.c.chless[1].set("L09");
            self.c.chless[2].set("L20");
            self.c.chnot2[1].set("L20a");
            self.c.chnot2[2].set("L20b");
            self.c.chnot2[3].set("L20c");
            self.c.chrato[1].set("L41a/L43a = 1. +- .02");
            self.c.chrato[2].set("L41b/L43b = 1. +- .02");
            self.c.chsimu[1].set("L53a @ 5.31+-.02 FWHM=.06<.095+-.0175 AMP=1.");
            self.c.chsimu[2].set("L53b @ 5.31+-.02 FWHM=.13<.165+-.0175 AMP=1.");
            self.c.chsimu[3].set("L53c @ 5.31+-.02 FWHM=.20<.235+-.0175 AMP=1.");
            self.c.chsimu[4].set("L53d @ 5.31+-.02 FWHM=.27<.290+-.0100 AMP=1.");
            self.c.chsimu[5].set("L52a @ 5.21+-.02 FWHM=.06<.095+-.0175 AMP=1.");
            self.c.chsimu[6].set("L52b @ 5.21+-.02 FWHM=.13<.165+-.0175 AMP=1.");
            self.c.chsimu[7].set("L52c @ 5.21+-.02 FWHM=.20<.235+-.0175 AMP=1.");
            self.c.chsimu[8].set("L52d @ 5.21+-.02 FWHM=.27<.290+-.0100 AMP=1.");
            if self.c.roomt {
                self.c.chsimu[9].set("W1 @ 4.83+-.03 FWHM=.01<.04+-.015 AMP=1.");
                self.c.chsimu[10].set("W2 @ 4.83+-.03 FWHM=.05<.1+-.025 AMP=1.");
                self.c.chsimu[11].set("W3 @ 4.83+-.03 FWHM=.15<.2+-.025 AMP=1.");
                self.c.chsimu[12].set("W4 @ 4.83+-.03 FWHM=.25<.3+-.025 AMP=1.");
                self.c.chsimu[13].set("W5 @ 4.83+-.03 FWHM=.35<.4+-.025 AMP=1.");
                self.c.chsimu[14].set("W6 @ 4.83+-.03 FWHM=.45<.5+-.025 AMP=1.");
                self.c.chsimu[15].set("W7 @ 4.83+-.03 FWHM=.55<.6+-.025 AMP=1.");
                self.c.chsimu[16].set("W8 @ 4.83+-.03 FWHM=.65<.7+-.025 AMP=1.");
                self.c.chsimu[17].set("W9 @ 4.83+-.03 FWHM=.75<.8+-.025 AMP=1.");
            } else {
                self.c.chsimu[9].set("W1 @ 4.65+-.03 FWHM=.01<.04+-.015 AMP=1.");
                self.c.chsimu[10].set("W2 @ 4.65+-.03 FWHM=.05<.1+-.025 AMP=1.");
                self.c.chsimu[11].set("W3 @ 4.65+-.03 FWHM=.15<.2+-.025 AMP=1.");
                self.c.chsimu[12].set("W4 @ 4.65+-.03 FWHM=.25<.3+-.025 AMP=1.");
                self.c.chsimu[13].set("W5 @ 4.65+-.03 FWHM=.35<.4+-.025 AMP=1.");
                self.c.chsimu[14].set("W6 @ 4.65+-.03 FWHM=.45<.5+-.025 AMP=1.");
                self.c.chsimu[15].set("W7 @ 4.65+-.03 FWHM=.55<.6+-.025 AMP=1.");
                self.c.chsimu[16].set("W8 @ 4.65+-.03 FWHM=.65<.7+-.025 AMP=1.");
                self.c.chsimu[17].set("W9 @ 4.65+-.03 FWHM=.75<.8+-.025 AMP=1.");
            }
            self.c.chsimu[18].set("L43a@4.28+-.004 FWHM=.04<.08+-.02 AMP=1.");
            self.c.chsimu[19].set("L43b@4.28+-.004 FWHM=.12<.16+-.02 AMP=1.");
            self.c.chsimu[20].set("L41a@4.08+-.004 FWHM=.04<.08+-.02 AMP=1.");
            self.c.chsimu[21].set("L41b@4.08+-.004 FWHM=.12<.16+-.02 AMP=1.");
            self.c.chsimu[22].set("L28a @ 2.75+-.01 FWHM=.06<.095+-.0175 AMP=1.");
            self.c.chsimu[23].set("L28b @ 2.75+-.01 FWHM=.13<.165+-.0175 AMP=1.");
            self.c.chsimu[24].set("L28c @ 2.75+-.01 FWHM=.20<.235+-.0175 AMP=1.");
            self.c.chsimu[25].set("L28d @ 2.75+-.01 FWHM=.27<.290+-.0100 AMP=1.");
            self.c.chsimu[26].set("L23a @ 2.23+-.01 FWHM=.06<.095+-.0175 AMP=1.");
            self.c.chsimu[27].set("L23b @ 2.23+-.01 FWHM=.13<.165+-.0175 AMP=1.");
            self.c.chsimu[28].set("L23c @ 2.23+-.01 FWHM=.20<.235+-.0175 AMP=1.");
            self.c.chsimu[29].set("L23d @ 2.23+-.01 FWHM=.27<.290+-.0100 AMP=1.");
            self.c.chsimu[30].set("L21a @ 2.02+-.01 FWHM=.06<.095+-.0175 AMP=1.");
            self.c.chsimu[31].set("L21b @ 2.02+-.01 FWHM=.13<.165+-.0175 AMP=1.");
            self.c.chsimu[32].set("L21c @ 2.02+-.01 FWHM=.20<.235+-.0175 AMP=1.");
            self.c.chsimu[33].set("L21d @ 2.02+-.01 FWHM=.27<.290+-.0100 AMP=1.");
            self.c.chsimu[34].set("L20a @ 2.02+-.03 FWHM=.07<.1+-.03 AMP=.58                        @ 2.23 FWHM=.07 AMP=.29  @ 2.75 FWHM=.060 AMP=.13");
            self.c.chsimu[35].set("L20b @ 2.02+-.03 FWHM=.17<.2+-.03 AMP=.58                        @ 2.23 FWHM=.17 AMP=.29  @ 2.75 FWHM=.146 AMP=.13");
            self.c.chsimu[36].set("L20c @ 2.02+-.03 FWHM=.27<.3+-.03 AMP=.58                        @ 2.23 FWHM=.27 AMP=.29  @ 2.75 FWHM=.231 AMP=.13");
            self.c.chsimu[37].set("L16a @ 1.58+-.01 FWHM=.06<.095+-.0175 AMP=1.");
            self.c.chsimu[38].set("L16b @ 1.58+-.01 FWHM=.13<.165+-.0175 AMP=1.");
            self.c.chsimu[39].set("L16c @ 1.58+-.01 FWHM=.20<.235+-.0175 AMP=1.");
            self.c.chsimu[40].set("L16d @ 1.58+-.01 FWHM=.27<.290+-.0100 AMP=1.");
            self.c.chsimu[41].set("L13a @ 1.28+-.02 FWHM=.03<.050+-.0100 AMP=1.");
            self.c.chsimu[42].set("L13b @ 1.28+-.02 FWHM=.07<.105+-.0175 AMP=1.");
            self.c.chsimu[43].set("L13c @ 1.28+-.02 FWHM=.14<.175+-.0175 AMP=1.");
            self.c.chsimu[44].set("L13d @ 1.28+-.02 FWHM=.21<.245+-.0175 AMP=1.");
            self.c.chsimu[45].set("L13e @ 1.28+-.02 FWHM=.28<.315+-.0175 AMP=1.");
            self.c.chsimu[46].set("L13f @ 1.28+-.02 FWHM=.35<.370+-.0100 AMP=1.");
            self.c.chsimu[47].set("L09a @ .87+-.02 FWHM=.06<.095+-.0175 AMP=1.");
            self.c.chsimu[48].set("L09b @ .87+-.02 FWHM=.13<.165+-.0175 AMP=1.");
            self.c.chsimu[49].set("L09c @ .87+-.02 FWHM=.20<.235+-.0175 AMP=1.");
            self.c.chsimu[50].set("L09d @ .87+-.02 FWHM=.27<.305+-.0175 AMP=1.");
            self.c.chsimu[51].set("L09e @ .87+-.02 FWHM=.34<.360+-.0100 AMP=1.");
            self.c.chsimu[52].set("cho1 @ 3.185+-.01 FWHM=.03<.05+-.01 AMP=1.");
            self.c.chsimu[53].set("cho2 @ 3.185+-.01 FWHM=.07<.09+-.01 AMP=1.");
            self.c.chsimu[54].set("cho3 @ 3.185+-.01 FWHM=.11<.13+-.01 AMP=1.");
            self.c.chsimu[55].set("cho4 @ 3.185+-.01 FWHM=.15<.17+-.01 AMP=1.");
            self.c.chsimu[56].set("cho5 @ 3.185+-.01 FWHM=.19<.21+-.01 AMP=1.");
            self.c.chsimu[57].set("glycg1 @ 3.82+-.01 FWHM=.09<.11+-.01 AMP=1.");
            self.c.chsimu[58].set("glycg2 @ 3.75+-.01 FWHM=.09<.11+-.01 AMP=1.");
            self.c.chsimu[59].set("glycg3 @ 3.68+-.01 FWHM=.09<.11+-.01 AMP=1.");
            self.c.chsimu[60].set("glycg4 @ 3.61+-.01 FWHM=.09<.11+-.01 AMP=1.");
            self.c.dkntmn[2] = 1.867_f32;
            self.c.endpha = true;
            self.c.fwhmmx = 0.4_f32;
            self.c.fwhmst = 0.3_f32;
            self.c.gauss_rt2 = false;
            self.c.incsmx = 1;
            self.c.isdbol = 5;
            self.c.ncombi = 17;
            self.c.ngrsh = 10;
            self.c.nnot2 = 3;
            self.c.nobasi = true;
            self.c.nratio = 2;
            self.c.nrefpk[2] = 1;
            self.c.nsidmn = 1;
            self.c.nsidmx = 1;
            self.c.nsimul = 60;
            self.c.onlyco = true;
            self.c.ppmref[(1, 2)] = 1.28_f32;
            if self.c.ppmst < -9998.0_f32 {
                self.c.ppmst = 3.6_f32;
            }
            if self.c.ppmend > 9998.0_f32 {
                self.c.ppmend = -2.0_f32;
            }
            if (self.c.ppmst - self.c.ppmend) >= 6.4_f32 {
                self.c.nsubtk = 5;
                self.c.xstep = 1.0_f32;
            }
            if self.c.dowatr && self.c.ppmst >= 5.0_f32 {
                self.c.chuse1[1].set("L13a");
                self.c.chuse1[2].set("L13b");
                self.c.chuse1[3].set("L13c");
                self.c.chuse1[4].set("L13d");
                self.c.chuse1[5].set("L13e");
                self.c.chuse1[6].set("L13f");
                self.c.chuse1[7].set("W1");
                self.c.chuse1[8].set("W2");
                self.c.chuse1[9].set("W3");
                self.c.chuse1[10].set("W4");
                self.c.chuse1[11].set("W5");
                self.c.chuse1[12].set("W6");
                self.c.chuse1[13].set("W7");
                self.c.chuse1[14].set("W8");
                self.c.chuse1[15].set("W9");
                self.c.namrel.set("Water");
                self.c.nuse1 = 15;
            } else {
                self.c.chuse1[1].set("L13a");
                self.c.chuse1[2].set("L13b");
                self.c.chuse1[3].set("L13c");
                self.c.chuse1[4].set("L13d");
                self.c.chuse1[5].set("L13e");
                self.c.chuse1[6].set("L13f");
                self.c.chuse1[7].set("L09a");
                self.c.chuse1[8].set("L09b");
                self.c.chuse1[9].set("L09c");
                self.c.chuse1[10].set("L09d");
                self.c.chuse1[11].set("L09e");
                self.c.chuse1[12].set("cho1");
                self.c.chuse1[13].set("cho2");
                self.c.chuse1[14].set("cho3");
                self.c.chuse1[15].set("cho4");
                self.c.chuse1[16].set("cho5");
                self.c.chuse1[17].set("L20a");
                self.c.chuse1[18].set("L20b");
                self.c.chuse1[19].set("L20c");
                self.c.namrel.set("Lip13");
                self.c.nchles = 1;
                self.c.nuse1 = 16;
                self.c.rlesmo = 1.5_f32;
                if self.c.ppmst >= 5.0_f32 {
                    self.c.ppmgap[(1, 1)] = 5.0_f32;
                    self.c.ppmgap[(2, 1)] = 3.6_f32;
                    self.c.ppmsep[1] = 4.3_f32;
                } else {
                    self.c.ralinc = 1.4_f32;
                    self.c.rfwhcc = 0.0_f32;
                    self.c.rrt2mq = 0.25_f32;
                }
            }
            if self.c.ppmst < 5.0_f32 {
                self.c.idgppm = 2;
            }
            self.c.prmnmx[(1, 1)] = 0.5_f32;
            self.c.prmnmx[(2, 1)] = 0.95_f32;
            self.c.sdgrsh[1] = 0.003_f32;
            self.c.sdgrsh[2] = 0.003_f32;
            self.c.sdgrsh[3] = 0.003_f32;
            self.c.sdgrsh[4] = 0.003_f32;
            self.c.sdgrsh[5] = 0.003_f32;
            self.c.sdgrsh[6] = 0.002_f32;
            self.c.sdgrsh[7] = 0.003_f32;
            self.c.sdgrsh[8] = 0.003_f32;
            self.c.sdgrsh[9] = 0.003_f32;
            self.c.sdgrsh[10] = 0.01_f32;
            self.c.sdsmoo[3] = 0.03_f32;
            self.c.shifmn[1] = -4.0_f32;
            self.c.shifmn[2] = -1.0_f32;
            self.c.shifmx[1] = 1.0_f32;
            self.c.shifmx[2] = 2.5_f32;
            self.c.useany = true;
            self.c.vitro = true;
            self.c.wconc = 0.5_f32;
        }
        if (((((self.c.sptype.sub(1, 7).eq_str("lipid-7") || self.c.sptype.sub(1, 7).eq_str("liver-7")) || self.c.sptype.sub(1, 8).eq_str("breast-7")) || self.c.sptype.sub(1, 7).eq_str("lipid-8")) || self.c.sptype.sub(1, 7).eq_str("liver-8")) || self.c.sptype.sub(1, 8).eq_str("breast-8")) || self.c.sptype.sub(1, 8).eq_str("liver-11") {
            *is_sptype = true;
            self.c.accept_step2 = true;
            self.c.alpsmn = 1.0e-6_f64;
            self.c.alpsmx = 2.0e0_f64;
            self.c.alpsst = (1.0e-4_f64) as f32;
            self.c.atth2o = 1.0_f32;
            self.c.chcomb[1].set("L16a+L16b+L16c+L13a+L13b+L13c+L13d+L13e+L09a+L09b+L09c+L09d");
            self.c.chcomb[2].set("L16a+L16b+L16c+L13a+L13b+L13c+L13d+L13e");
            self.c.chcomb[3].set("L28a+L28b+L28c+L23a+L23b+L23c+L21a+L21b+L21c");
            self.c.chcomb[4].set("L13e+L13d+L13c+L13b+L13a");
            self.c.chcomb[5].set("L09d+L09c+L09b+L09a");
            self.c.chcomb[6].set("L16a+L16b+L16c");
            self.c.chcomb[7].set("L21a+L21b+L21c");
            self.c.chcomb[8].set("L23a+L23b+L23c");
            self.c.chcomb[9].set("L28a+L28b+L28c");
            self.c.chcomb[10].set("L53a+L53b+L53c+L52a+L52b+L52c");
            self.c.chcomb[11].set("W1+W2+W3+W4+W5+W6");
            self.c.chcomb[12].set("cho1+cho2+cho3");
            self.c.chcomb[13].set("L43a+L43b");
            self.c.chcomb[14].set("L41a+L41b");
            self.c.chcomb[15].set("glycg1+glycg2+glycg3+glycg4");
            self.c.chcomb[16].set("L53a+L53b+L53c");
            self.c.chcomb[17].set("L52a+L52b+L52c");
            self.c.chcom2[1].set("L16+L09+L13");
            self.c.chcom2[2].set("Lip16+Lip13");
            self.c.chcom2[3].set("L28+L23+L21");
            self.c.chcom2[4].set("Lip13");
            self.c.chcom2[5].set("Lip09");
            self.c.chcom2[6].set("Lip16");
            self.c.chcom2[7].set("Lip21");
            self.c.chcom2[8].set("Lip23");
            self.c.chcom2[9].set("Lip28");
            self.c.chcom2[10].set("Lip53+Lip52");
            self.c.chcom2[11].set("Water");
            self.c.chcom2[12].set("Cho");
            self.c.chcom2[13].set("Lip43");
            self.c.chcom2[14].set("Lip41");
            self.c.chcom2[15].set("Glycg");
            self.c.chcom2[16].set("Lip53");
            self.c.chcom2[17].set("Lip52");
            self.c.chgrsh[1].set("L28");
            self.c.chgrsh[2].set("L23");
            self.c.chgrsh[3].set("L21");
            self.c.chgrsh[4].set("L13");
            self.c.chgrsh[5].set("L09");
            self.c.chgrsh[6].set("cho");
            self.c.chgrsh[7].set("L16");
            self.c.chgrsh[8].set("L43");
            self.c.chgrsh[9].set("L41");
            self.c.chgrsh[10].set("W");
            self.c.chnot2[1].set("W1pre");
            self.c.chnot2[2].set("L13pre");
            self.c.chrato[1].set("L41a/L43a = 1. +- .02");
            self.c.chrato[2].set("L41b/L43b = 1. +- .02");
            self.c.chsimu[1].set("L53a @ 5.31+-.02 FWHM=.2<.4+-.0667 AMP=1.                         @999. FWHM=1. AMP=.07");
            self.c.chsimu[2].set("L53b @ 5.31+-.02 FWHM=.8<1.+-.0667 AMP=1.                         @999. FWHM=1. AMP=.07");
            self.c.chsimu[3].set("L53c @ 5.31+-.02 FWHM=1.4<1.6+-.0667 AMP=1.                       @999. FWHM=1. AMP=.07");
            self.c.chsimu[4].set("L52a @ 5.21+-.02 FWHM=.2<.4+-.0667 AMP=1.                         @999. FWHM=1. AMP=.07");
            self.c.chsimu[5].set("L52b @ 5.21+-.02 FWHM=.8<1.+-.0667 AMP=1.                         @999. FWHM=1. AMP=.07");
            self.c.chsimu[6].set("L52c @ 5.21+-.02 FWHM=1.4<1.6+-.0667 AMP=1.                       @999. FWHM=1. AMP=.07");
            if self.c.roomt {
                self.c.chsimu[7].set("W1pre @ 4.83+-.03 FWHM=.03<.04+-.005 AMP=1.                    @999. FWHM=1. AMP=10.");
                self.c.chsimu[8].set("W1 @ 4.83+-.03 FWHM=.2<.3+-.025 AMP=1.                         @999. FWHM=1. AMP=10.");
                self.c.chsimu[9].set("W2 @ 4.83+-.03 FWHM=.4<.6+-.0667 AMP=1.                        @999. FWHM=1. AMP=10.");
                self.c.chsimu[10].set("W3 @ 4.83+-.03 FWHM=1.<1.2+-.0667 AMP=1.                      @999. FWHM=1. AMP=10.");
                self.c.chsimu[11].set("W4 @ 4.83+-.03 FWHM=1.6<1.8+-.0667 AMP=1.                     @999. FWHM=1. AMP=10.");
                self.c.chsimu[12].set("W5 @ 4.83+-.03 FWHM=2.2<2.4+-.0667 AMP=1.                     @999. FWHM=1. AMP=10.");
                self.c.chsimu[13].set("W6 @ 4.83+-.03 FWHM=2.8<3.+-.0667 AMP=1.                      @999. FWHM=1. AMP=10.");
                self.c.ppmcen = 4.83_f32;
                self.c.ppmref[(1, 1)] = 4.83_f32;
            } else {
                self.c.chsimu[7].set("W1pre @ 4.65+-.03 FWHM=.03<.04+-.005 AMP=1.                    @999. FWHM=1. AMP=10.");
                self.c.chsimu[8].set("W1 @ 4.65+-.03 FWHM=.2<.3+-.025 AMP=1.                         @999. FWHM=1. AMP=10.");
                self.c.chsimu[9].set("W2 @ 4.65+-.03 FWHM=.4<.6+-.0667 AMP=1.                        @999. FWHM=1. AMP=10.");
                self.c.chsimu[10].set("W3 @ 4.65+-.03 FWHM=1.<1.2+-.0667 AMP=1.                      @999. FWHM=1. AMP=10.");
                self.c.chsimu[11].set("W4 @ 4.65+-.03 FWHM=1.6<1.8+-.0667 AMP=1.                     @999. FWHM=1. AMP=10.");
                self.c.chsimu[12].set("W5 @ 4.65+-.03 FWHM=2.2<2.4+-.0667 AMP=1.                     @999. FWHM=1. AMP=10.");
                self.c.chsimu[13].set("W6 @ 4.65+-.03 FWHM=2.8<3.+-.0667 AMP=1.                      @999. FWHM=1. AMP=10.");
            }
            self.c.chsimu[14].set("L43a @ 4.28+-.004 FWHM=.2<.4+-.0667 AMP=1.                       @999. FWHM=1. AMP=.035");
            self.c.chsimu[15].set("L43b @ 4.28+-.004 FWHM=.8<1.+-.0667 AMP=1.                       @999. FWHM=1. AMP=.035");
            self.c.chsimu[16].set("L41a @ 4.08+-.004 FWHM=.2<.4+-.0667 AMP=1.                       @999. FWHM=1. AMP=.035");
            self.c.chsimu[17].set("L41b @ 4.08+-.004 FWHM=.8<1.+-.0667 AMP=1.                       @999. FWHM=1. AMP=.035");
            self.c.chsimu[18].set("L28a @ 2.75+-.01 FWHM=.2<.4+-.0667 AMP=1.                        @999. FWHM=1. AMP=.035");
            self.c.chsimu[19].set("L28b @ 2.75+-.01 FWHM=.8<1.+-.0667 AMP=1.                        @999. FWHM=1. AMP=.035");
            self.c.chsimu[20].set("L28c @ 2.75+-.01 FWHM=1.4<1.6+-.0667 AMP=1.                      @999. FWHM=1. AMP=.035");
            self.c.chsimu[21].set("L23a @ 2.23+-.01 FWHM=.2<.4+-.0667 AMP=1.                        @999. FWHM=1. AMP=.07");
            self.c.chsimu[22].set("L23b @ 2.23+-.01 FWHM=.8<1.+-.0667 AMP=1.                        @999. FWHM=1. AMP=.07");
            self.c.chsimu[23].set("L23c @ 2.23+-.01 FWHM=1.4<1.6+-.0667 AMP=1.                      @999. FWHM=1. AMP=.07");
            self.c.chsimu[24].set("L21a @ 2.02+-.01 FWHM=.2<.4+-.0667 AMP=1.                        @999. FWHM=1. AMP=.1");
            self.c.chsimu[25].set("L21b @ 2.02+-.01 FWHM=.8<1.+-.0667 AMP=1.                        @999. FWHM=1. AMP=.1");
            self.c.chsimu[26].set("L21c @ 2.02+-.01 FWHM=1.4<1.6+-.0667 AMP=1.                      @999. FWHM=1. AMP=.1");
            self.c.chsimu[27].set("L16a @ 1.58+-.01 FWHM=.2<.4+-.0667 AMP=1.                        @999. FWHM=1. AMP=.07");
            self.c.chsimu[28].set("L16b @ 1.58+-.01 FWHM=.8<1.+-.0667 AMP=1.                        @999. FWHM=1. AMP=.07");
            self.c.chsimu[29].set("L16c @ 1.58+-.01 FWHM=1.4<1.6+-.0667 AMP=1.                      @999. FWHM=1. AMP=.07");
            self.c.chsimu[30].set("L13pre @ 1.28+-.02 FWHM=.03<.04+-.005 AMP=1.                     @999. FWHM=1. AMP=1.");
            self.c.chsimu[31].set("L13a @ 1.28+-.02 FWHM=.2<.3+-.025 AMP=1.                         @999. FWHM=1. AMP=1.");
            self.c.chsimu[32].set("L13b @ 1.28+-.02 FWHM=.4<.6+-.0667 AMP=1.                        @999. FWHM=1. AMP=1.");
            self.c.chsimu[33].set("L13c @ 1.28+-.02 FWHM=1.<1.2+-.0667 AMP=1.                       @999. FWHM=1. AMP=1.");
            self.c.chsimu[34].set("L13d @ 1.28+-.02 FWHM=1.6<1.8+-.0667 AMP=1.                      @999. FWHM=1. AMP=1.");
            self.c.chsimu[35].set("L13e @ 1.28+-.02 FWHM=2.2<2.4+-.0667 AMP=1.                      @999. FWHM=1. AMP=1.");
            self.c.chsimu[36].set("L09a @ .87+-.02 FWHM=.2<.4+-.0667 AMP=1.                         @999. FWHM=1. AMP=.13");
            self.c.chsimu[37].set("L09b @ .87+-.02 FWHM=.8<1.+-.0667 AMP=1.                         @999. FWHM=1. AMP=.13");
            self.c.chsimu[38].set("L09c @ .87+-.02 FWHM=1.4<1.6+-.0667 AMP=1.                       @999. FWHM=1. AMP=.13");
            self.c.chsimu[39].set("L09d @ .87+-.02 FWHM=2.<2.2+-.0667 AMP=1.                        @999. FWHM=1. AMP=.13");
            self.c.chsimu[40].set("cho1 @ 3.2+-.01 FWHM=.2<.3+-.025 AMP=1.                          @999. FWHM=1. AMP=.2");
            self.c.chsimu[41].set("cho2 @ 3.2+-.01 FWHM=.4<.6+-.0667 AMP=1.                         @999. FWHM=1. AMP=.2");
            self.c.chsimu[42].set("cho3 @ 3.2+-.01 FWHM=1.<1.2+-.0667 AMP=1.                        @999. FWHM=1. AMP=.2");
            self.c.chsimu[43].set("glycg1 @ 3.82+-.01 FWHM=.5<.75+-.0625 AMP=1.                     @999. FWHM=1. AMP=.1");
            self.c.chsimu[44].set("glycg2 @ 3.75+-.01 FWHM=.5<.75+-.0625 AMP=1.                     @999. FWHM=1. AMP=.1");
            self.c.chsimu[45].set("glycg3 @ 3.68+-.01 FWHM=.5<.75+-.0625 AMP=1.                     @999. FWHM=1. AMP=.1");
            self.c.chsimu[46].set("glycg4 @ 3.61+-.01 FWHM=.5<.75+-.0625 AMP=1.                     @999. FWHM=1. AMP=.1");
            self.c.chuse1[1].set("L13pre");
            self.c.degmax[1] = 2.0_f32;
            self.c.dkntmn[1] = 0.45_f32;
            self.c.fwhmmn = 0.1_f32;
            self.c.fwhmmx = 0.3_f32;
            self.c.fwhmst = 0.15_f32;
            self.c.gauss_rt2 = false;
            self.c.idgppm = 2;
            self.c.imethd = 2;
            self.c.ipowrg = 2;
            self.c.isdbol = 5;
            self.c.mrepha[1] = 1;
            self.c.nbas_ccf = 0;
            self.c.ncombi = 17;
            self.c.ngrsh = 10;
            self.c.nnot2 = 2;
            self.c.nobasi = true;
            self.c.nratio = 0;
            if self.c.ppmst >= 4.28_f32 {
                self.c.nratio = 2;
            }
            self.c.nrefpk[2] = 1;
            self.c.nsimul = 46;
            self.c.onlyco = true;
            self.c.ppmref[(1, 2)] = 1.28_f32;
            if self.c.ppmst < -9998.0_f32 {
                self.c.ppmst = 3.6_f32;
            }
            if self.c.ppmend > 9998.0_f32 {
                self.c.ppmend = -2.0_f32;
            }
            if (self.c.ppmst - self.c.ppmend) >= 6.4_f32 {
                self.c.nsubtk = 5;
                self.c.xstep = 1.0_f32;
            }
            self.c.namrel.set("L16+L09+L13");
            if self.c.dowatr && self.c.ppmst >= 5.0_f32 {
                self.c.chuse1[2].set("W1pre");
                if !(self.c.dows || self.c.doecc) {
                    self.c.namrel.set("Water");
                }
                self.c.nuse1 = 2;
            } else {
                self.c.nuse1 = 1;
                if self.c.ppmst >= 5.0_f32 {
                    self.c.ppmgap[(1, 1)] = 5.0_f32;
                    self.c.ppmgap[(2, 1)] = 3.6_f32;
                    self.c.ppmsep[1] = 4.3_f32;
                } else {
                    self.c.rfwhcc = 0.0_f32;
                    self.c.rrt2mq = 0.25_f32;
                }
            }
            self.c.prmnmx[(1, 1)] = 0.2_f32;
            self.c.prmnmx[(2, 1)] = 0.5_f32;
            self.c.prmnmx[(1, 2)] = 0.7_f32;
            self.c.prmnmx[(2, 2)] = 0.9_f32;
            self.c.prmnmx[(1, 3)] = 0.3_f32;
            self.c.prmnmx[(2, 3)] = 0.69_f32;
            self.c.rbackg[1] = 22.2_f32;
            self.c.rbackg[2] = 11.1_f32;
            self.c.rlrntz = 2.0_f32;
            self.c.scafwh = true;
            self.c.sdgrsh[1] = 0.003_f32;
            self.c.sdgrsh[2] = 0.003_f32;
            self.c.sdgrsh[3] = 0.003_f32;
            self.c.sdgrsh[4] = 0.003_f32;
            self.c.sdgrsh[5] = 0.003_f32;
            self.c.sdgrsh[6] = 0.002_f32;
            self.c.sdgrsh[7] = 0.003_f32;
            self.c.sdgrsh[8] = 0.003_f32;
            self.c.sdgrsh[9] = 0.003_f32;
            self.c.sdgrsh[10] = 0.01_f32;
            self.c.sdsmoo[3] = 0.03_f32;
            self.c.shifmn[1] = -4.0_f32;
            self.c.shifmn[2] = -1.0_f32;
            self.c.shifmx[1] = 1.0_f32;
            self.c.shifmx[2] = 2.5_f32;
            self.c.useany = true;
            self.c.wconc = 0.5_f32;
        }
        if ((self.c.sptype.sub(1, 7).eq_str("lipid-8") || self.c.sptype.sub(1, 7).eq_str("liver-8")) || self.c.sptype.sub(1, 8).eq_str("breast-8")) || self.c.sptype.sub(1, 8).eq_str("liver-11") {
            self.c.alpsmn = 2.0e-4_f64;
            self.c.alpsmx = 1.0e1_f64;
            self.c.alpsst = (1.0e-2_f64) as f32;
            self.c.chcomb[15].set("L53a+L53b+L53c");
            self.c.chcomb[16].set("L52a+L52b+L52c");
            self.c.chcom2[15].set("Lip53");
            self.c.chcom2[16].set("Lip52");
            if self.c.roomt {
                self.c.chsimu[7].set("W1pre @ 4.83+-.02 FWHM=.03<.04+-.005 AMP=1.                    @999. FWHM=1. AMP=10.");
                self.c.chsimu[8].set("W1 @ 4.83+-.02 FWHM=.2<.3+-.025 AMP=1.                         @999. FWHM=1. AMP=10.");
                self.c.chsimu[9].set("W2 @ 4.83+-.02 FWHM=.4<.6+-.0667 AMP=1.                        @999. FWHM=1. AMP=10.");
                self.c.chsimu[10].set("W3 @ 4.83+-.02 FWHM=1.<1.2+-.0667 AMP=1.                      @999. FWHM=1. AMP=10.");
                self.c.chsimu[11].set("W4 @ 4.83+-.02 FWHM=1.6<1.8+-.0667 AMP=1.                     @999. FWHM=1. AMP=10.");
                self.c.chsimu[12].set("W5 @ 4.83+-.02 FWHM=2.2<2.4+-.0667 AMP=1.                     @999. FWHM=1. AMP=10.");
                self.c.chsimu[13].set("W6 @ 4.83+-.02 FWHM=2.8<3.+-.0667 AMP=1.                      @999. FWHM=1. AMP=10.");
                self.c.ppmcen = 4.83_f32;
                self.c.ppmref[(1, 1)] = 4.83_f32;
            } else {
                self.c.chsimu[7].set("W1pre @ 4.65+-.02 FWHM=.03<.04+-.005 AMP=1.                    @999. FWHM=1. AMP=10.");
                self.c.chsimu[8].set("W1 @ 4.65+-.02 FWHM=.2<.3+-.025 AMP=1.                         @999. FWHM=1. AMP=10.");
                self.c.chsimu[9].set("W2 @ 4.65+-.02 FWHM=.4<.6+-.0667 AMP=1.                        @999. FWHM=1. AMP=10.");
                self.c.chsimu[10].set("W3 @ 4.65+-.02 FWHM=1.<1.2+-.0667 AMP=1.                      @999. FWHM=1. AMP=10.");
                self.c.chsimu[11].set("W4 @ 4.65+-.02 FWHM=1.6<1.8+-.0667 AMP=1.                     @999. FWHM=1. AMP=10.");
                self.c.chsimu[12].set("W5 @ 4.65+-.02 FWHM=2.2<2.4+-.0667 AMP=1.                     @999. FWHM=1. AMP=10.");
                self.c.chsimu[13].set("W6 @ 4.65+-.02 FWHM=2.8<3.+-.0667 AMP=1.                      @999. FWHM=1. AMP=10.");
            }
            self.c.chsimu[14].set("L43a @ 4.27+-.005 FWHM=.2<.4+-.0667 AMP=1.                       @999. FWHM=1. AMP=.035");
            self.c.chsimu[15].set("L43b @ 4.27+-.005 FWHM=.8<1.+-.0667 AMP=1.                       @999. FWHM=1. AMP=.035");
            self.c.chsimu[16].set("L41a @ 4.07+-.005 FWHM=.2<.4+-.0667 AMP=1.                       @999. FWHM=1. AMP=.035");
            self.c.chsimu[17].set("L41b @ 4.07+-.005 FWHM=.8<1.+-.0667 AMP=1.                       @999. FWHM=1. AMP=.035");
            self.c.degmax[1] = 12.5_f32;
            self.c.dkntmn[1] = 1.0_f32;
            self.c.endpha = true;
            self.c.fwhmmx = 0.4_f32;
            self.c.ipowrg = 1;
            self.c.ncombi = 16;
            self.c.nsimul = 42;
            self.c.prmnmx[(1, 1)] = 0.02_f32;
            self.c.prmnmx[(2, 1)] = 0.08_f32;
            self.c.prmnmx[(1, 2)] = 0.081_f32;
            self.c.prmnmx[(2, 2)] = 0.25_f32;
            self.c.prmnmx[(1, 3)] = 0.02_f32;
            self.c.prmnmx[(2, 3)] = 0.08_f32;
            self.c.rlrntz = 1.0_f32;
            self.c.skip_step3 = true;
        }
        if (self.c.sptype.sub(1, 7).eq_str("lipid-9") || self.c.sptype.sub(1, 7).eq_str("liver-9")) || self.c.sptype.sub(1, 8).eq_str("breast-9") {
            *is_sptype = true;
            self.c.atth2o = 1.0_f32;
            self.c.chcom2[1].set("L16+L09+L13");
            self.c.chcom2[2].set("Lip16+Lip13");
            self.c.chcom2[3].set("L28+L23+L21");
            self.c.chcom2[4].set("Lip13");
            self.c.chcom2[5].set("Lip09");
            self.c.chcom2[6].set("Lip16");
            self.c.chcom2[7].set("Lip21");
            self.c.chcom2[8].set("Lip23");
            self.c.chcom2[9].set("Lip28");
            self.c.chcom2[10].set("Lip53+Lip52");
            self.c.chcom2[11].set("Water");
            self.c.chcom2[12].set("Cho");
            self.c.chcom2[13].set("Lip43");
            self.c.chcom2[14].set("Lip41");
            self.c.chcom2[15].set("Glycg");
            self.c.chcom2[16].set("Lip53");
            self.c.chcom2[17].set("Lip52");
            self.c.chcomb[1].set("L16+L13a+L13b+L09");
            self.c.chcomb[2].set("L16+L13a+L13b");
            self.c.chcomb[3].set("L28+L23+L21");
            self.c.chcomb[4].set("L13a+L13b");
            self.c.chcomb[5].set("L09");
            self.c.chcomb[6].set("L16");
            self.c.chcomb[7].set("L21");
            self.c.chcomb[8].set("L23");
            self.c.chcomb[9].set("L28");
            self.c.chcomb[10].set("L53+L52");
            self.c.chcomb[11].set("W1+W2+W3");
            self.c.chcomb[12].set("Cho");
            self.c.chcomb[13].set("L43");
            self.c.chcomb[14].set("L41");
            self.c.chcomb[15].set("glycg1+glycg2+glycg3+glycg4");
            self.c.chcomb[16].set("L53");
            self.c.chcomb[17].set("L52");
            self.c.chgrsh[1].set("L13");
            self.c.chgrsh[2].set("L5");
            self.c.chgrsh[3].set("L4");
            self.c.chrato[1].set("L41/L43 = 1. +- .02");
            self.c.chsimu[1].set("L53 @ 5.31+-.02 FWHM=.05<9.+-2. AMP=1.                             @999. FWHM=.4 AMP=-1.                                             @999. FWHM=.08 AMP=-1.");
            self.c.chsimu[2].set("L52 @ 5.21+-.02 FWHM=.05<9.+-2. AMP=1.                             @999. FWHM=.4 AMP=-1.                                             @999. FWHM=.08 AMP=-1.");
            if self.c.roomt {
                self.c.chsimu[3].set("W1 @4.83+-.02 FWHM=.02<9.+-2. AMP=1.                               @999. FWHM=.5 AMP=-1.                                             @999. FWHM=.1 AMP=-1.");
                self.c.chsimu[4].set("W2 @4.82+-.02 FWHM=.02<9.+-2. AMP=1.                               @999. FWHM=.5 AMP=-1.                                             @999. FWHM=.1 AMP=-1.");
                self.c.chsimu[5].set("W3 @4.81+-.02 FWHM=.02<9.+-2. AMP=1.                               @999. FWHM=.5 AMP=-1.                                             @999. FWHM=.1 AMP=-1.");
                self.c.ppmcen = 4.83_f32;
                self.c.ppmref[(1, 1)] = 4.83_f32;
            } else {
                self.c.chsimu[3].set("W1 @4.65+-.02 FWHM=.02<9.+-2. AMP=1.                               @999. FWHM=.5 AMP=-1.                                             @999. FWHM=.1 AMP=-1.");
                self.c.chsimu[4].set("W2 @4.66+-.02 FWHM=.02<9.+-2. AMP=1.                               @999. FWHM=.5 AMP=-1.                                             @999. FWHM=.1 AMP=-1.");
                self.c.chsimu[5].set("W3 @4.67+-.02 FWHM=.02<9.+-2. AMP=1.                               @999. FWHM=.5 AMP=-1.                                             @999. FWHM=.1 AMP=-1.");
            }
            self.c.chsimu[6].set("L43 @ 4.25+-.01 FWHM=.05<9.+-1. AMP=1.                             @999. FWHM=.4 AMP=-1.");
            self.c.chsimu[7].set("L41 @ 4.05+-.01 FWHM=.05<9.+-1. AMP=1.                             @999. FWHM=.4 AMP=-1.");
            self.c.chsimu[8].set("L28 @ 2.75+-.015 FWHM=.05<9.+-2. AMP=1.                            @999. FWHM=.5 AMP=-1.                                             @999. FWHM=.1 AMP=-1.");
            self.c.chsimu[9].set("L23 @ 2.23+-.015 FWHM=.05<9.+-2. AMP=1.                            @999. FWHM=.5 AMP=-1.                                             @999. FWHM=.1 AMP=-1.");
            self.c.chsimu[10].set("L21 @ 2.02+-.015 FWHM=.05<9.+-2. AMP=1.                           @999. FWHM=.5 AMP=-1.                                             @999. FWHM=.1 AMP=-1.");
            self.c.chsimu[11].set("L16 @ 1.58+-.015 FWHM=.05<9.+-1. AMP=1.                           @999. FWHM=.5 AMP=-1.                                             @999. FWHM=.1 AMP=-1.");
            self.c.chsimu[12].set("L13a @ 1.28+-.02 FWHM=.02<9.+-2. AMP=1.                           @999. FWHM=.5 AMP=-1.                                             @999. FWHM=.1 AMP=-1.");
            self.c.chsimu[13].set("L13b @ 1.27+-.02 FWHM=.02<9.+-2. AMP=1.                           @999. FWHM=.5 AMP=-1.                                             @999. FWHM=.1 AMP=-1.");
            self.c.chsimu[14].set("L09 @ .87+-.02 FWHM=.05<9.+-2. AMP=1.                             @999. FWHM=.5 AMP=-1.                                             @999. FWHM=.1 AMP=-1.");
            self.c.chsimu[15].set("Cho @ 3.2+-.01 FWHM=.02<9.+-2. AMP=1.                             @999. FWHM=.25 AMP=-1.                                            @999. FWHM=.05 AMP=-1.");
            self.c.chsimu[16].set("glycg1 @ 3.82+-.01 FWHM=.1<9.+-1. AMP=1.                          @999. FWHM=.25 AMP=-1.");
            self.c.chsimu[17].set("glycg2 @ 3.75+-.01 FWHM=.1<9.+-1. AMP=1.                          @999. FWHM=.25 AMP=-1.");
            self.c.chsimu[18].set("glycg3 @ 3.68+-.01 FWHM=.1<9.+-1. AMP=1.                          @999. FWHM=.25 AMP=-1.");
            self.c.chsimu[19].set("glycg4 @ 3.61+-.01 FWHM=.1<9.+-1. AMP=1.                          @999. FWHM=.25 AMP=-1.");
            self.c.chuse1[1].set("L13a");
            self.c.dkntmn[2] = 1.867_f32;
            self.c.endpha = true;
            self.c.fwhmmn = 0.02_f32;
            self.c.fwhmmx = 0.36_f32;
            self.c.fwhmst = 0.2_f32;
            self.c.gauss_rt2 = false;
            self.c.idgppm = 2;
            self.c.imethd = 3;
            self.c.incsmx = 1;
            self.c.isdbol = 5;
            self.c.mpower = 2;
            self.c.mrepha[1] = 1;
            self.c.nbas_ccf = 0;
            self.c.ncombi = 17;
            self.c.ngrsh = 3;
            self.c.nobasi = true;
            self.c.nratio = 0;
            if self.c.ppmst >= 4.25_f32 {
                self.c.nratio = 1;
            }
            self.c.nrefpk[2] = 1;
            self.c.nsidmn = 1;
            self.c.nsidmx = 1;
            self.c.nsimul = 19;
            self.c.onlyco = true;
            self.c.ppmref[(1, 2)] = 1.28_f32;
            if self.c.ppmst < -9998.0_f32 {
                self.c.ppmst = 3.6_f32;
            }
            if self.c.ppmend > 9998.0_f32 {
                self.c.ppmend = -2.0_f32;
            }
            if (self.c.ppmst - self.c.ppmend) >= 6.4_f32 {
                self.c.nsubtk = 5;
                self.c.xstep = 1.0_f32;
            }
            self.c.namrel.set("L16+L09+L13");
            if self.c.dowatr && self.c.ppmst >= 5.0_f32 {
                self.c.chuse1[2].set("W1");
                if !(self.c.dows || self.c.doecc) {
                    self.c.namrel.set("Water");
                }
                self.c.nuse1 = 2;
            } else {
                self.c.nuse1 = 1;
                if self.c.ppmst >= 5.0_f32 {
                    self.c.ppmgap[(1, 1)] = 5.0_f32;
                    self.c.ppmgap[(2, 1)] = 3.6_f32;
                    self.c.ppmsep[1] = 4.3_f32;
                } else {
                    self.c.rfwhcc = 0.0_f32;
                    self.c.rrt2mq = 0.25_f32;
                }
            }
            self.c.prmnmx[(1, 1)] = 0.05_f32;
            self.c.prmnmx[(2, 1)] = 0.9_f32;
            self.c.ralinc = 1.4_f32;
            self.c.rpowmq = 0.1_f32;
            self.c.sdgrsh[1] = 0.003_f32;
            self.c.sdgrsh[2] = 0.008_f32;
            self.c.sdgrsh[3] = 0.008_f32;
            self.c.useany = true;
            self.c.vitro = true;
            self.c.wconc = 0.5_f32;
        }
        if (self.c.sptype.sub(1, 8).eq_str("lipid-10") || self.c.sptype.sub(1, 8).eq_str("liver-10")) || self.c.sptype.sub(1, 9).eq_str("breast-10") {
            *is_sptype = true;
            self.c.atth2o = 1.0_f32;
            self.c.chcomb[1].set("L16a+L16b+L16c+L13a+L13b+L13c+L13d+L13e+L09a+L09b+L09c+L09d");
            self.c.chcomb[2].set("L16a+L16b+L16c+L13a+L13b+L13c+L13d+L13e");
            self.c.chcomb[3].set("L28a+L28b+L28c+L23a+L23b+L23c+L21a+L21b+L21c");
            self.c.chcomb[4].set("L13e+L13d+L13c+L13b+L13a");
            self.c.chcomb[5].set("L09d+L09c+L09b+L09a");
            self.c.chcomb[6].set("L16a+L16b+L16c");
            self.c.chcomb[7].set("L21a+L21b+L21c");
            self.c.chcomb[8].set("L23a+L23b+L23c");
            self.c.chcomb[9].set("L28a+L28b+L28c");
            self.c.chcomb[10].set("L53a+L53b+L53c+L52a+L52b+L52c");
            self.c.chcomb[11].set("W1+W2+W3+W4+W5+W6");
            self.c.chcomb[12].set("cho1+cho2+cho3");
            self.c.chcomb[13].set("L43a+L43b");
            self.c.chcomb[14].set("L41a+L41b");
            self.c.chcomb[15].set("glycg1+glycg2+glycg3+glycg4");
            self.c.chcomb[16].set("L53a+L53b+L53c");
            self.c.chcomb[17].set("L52a+L52b+L52c");
            self.c.chcom2[1].set("L16+L09+L13");
            self.c.chcom2[2].set("Lip16+Lip13");
            self.c.chcom2[3].set("L28+L23+L21");
            self.c.chcom2[4].set("Lip13");
            self.c.chcom2[5].set("Lip09");
            self.c.chcom2[6].set("Lip16");
            self.c.chcom2[7].set("Lip21");
            self.c.chcom2[8].set("Lip23");
            self.c.chcom2[9].set("Lip28");
            self.c.chcom2[10].set("Lip53+Lip52");
            self.c.chcom2[11].set("Water");
            self.c.chcom2[12].set("Cho");
            self.c.chcom2[13].set("Lip43");
            self.c.chcom2[14].set("Lip41");
            self.c.chcom2[15].set("Glycg");
            self.c.chcom2[16].set("Lip53");
            self.c.chcom2[17].set("Lip52");
            self.c.chgrsh[1].set("L28");
            self.c.chgrsh[2].set("L23");
            self.c.chgrsh[3].set("L21");
            self.c.chgrsh[4].set("L13");
            self.c.chgrsh[5].set("L09");
            self.c.chgrsh[6].set("cho");
            self.c.chgrsh[7].set("L16");
            self.c.chgrsh[8].set("L43");
            self.c.chgrsh[9].set("L41");
            self.c.chgrsh[10].set("L4");
            self.c.chgrsh[11].set("W");
            self.c.chnot2[1].set("W1pre");
            self.c.chnot2[2].set("L13pre");
            self.c.chrato[1].set("L41a/L43a = 1. +- .02");
            self.c.chrato[2].set("L41b/L43b = 1. +- .02");
            self.c.chsimu[1].set("L53a @ 5.31+-.02 FWHM=.2<.4+-.0667 AMP=1.");
            self.c.chsimu[2].set("L53b @ 5.31+-.02 FWHM=.8<1.+-.0667 AMP=1.");
            self.c.chsimu[3].set("L53c @ 5.31+-.02 FWHM=1.4<1.6+-.0381 AMP=1.");
            self.c.chsimu[4].set("L52a @ 5.21+-.02 FWHM=.2<.4+-.0667 AMP=1.");
            self.c.chsimu[5].set("L52b @ 5.21+-.02 FWHM=.8<1.+-.0667 AMP=1.");
            self.c.chsimu[6].set("L52c @ 5.21+-.02 FWHM=1.4<1.6+-.0381 AMP=1.");
            if self.c.roomt {
                self.c.chsimu[7].set("W1pre @ 4.83+-.03 FWHM=.03<.04+-.005 AMP=1.");
                self.c.chsimu[8].set("W1 @ 4.83+-.03 FWHM=.2<.3+-.025 AMP=1.");
                self.c.chsimu[9].set("W2 @ 4.83+-.03 FWHM=.4<.6+-.0667 AMP=1.");
                self.c.chsimu[10].set("W3 @ 4.83+-.03 FWHM=1.<1.2+-.0667 AMP=1.");
                self.c.chsimu[11].set("W4 @ 4.83+-.03 FWHM=1.6<1.8+-.0667 AMP=1.");
                self.c.chsimu[12].set("W5 @ 4.83+-.03 FWHM=2.2<2.4+-.0667 AMP=1.");
                self.c.chsimu[13].set("W6 @ 4.83+-.03 FWHM=2.8<3.+-.0381 AMP=1.");
                self.c.ppmcen = 4.83_f32;
                self.c.ppmref[(1, 1)] = 4.83_f32;
            } else {
                self.c.chsimu[7].set("W1pre @ 4.65+-.03 FWHM=.03<.04+-.005 AMP=1.");
                self.c.chsimu[8].set("W1 @ 4.65+-.03 FWHM=.2<.3+-.025 AMP=1.");
                self.c.chsimu[9].set("W2 @ 4.65+-.03 FWHM=.4<.6+-.0667 AMP=1.");
                self.c.chsimu[10].set("W3 @ 4.65+-.03 FWHM=1.<1.2+-.0667 AMP=1.");
                self.c.chsimu[11].set("W4 @ 4.65+-.03 FWHM=1.6<1.8+-.0667 AMP=1.");
                self.c.chsimu[12].set("W5 @ 4.65+-.03 FWHM=2.2<2.4+-.0667 AMP=1.");
                self.c.chsimu[13].set("W6 @ 4.65+-.03 FWHM=2.8<3.+-.0381 AMP=1.");
            }
            self.c.chsimu[14].set("L43a @ 4.26+-.006 FWHM=.2<.4+-.0667 AMP=1.");
            self.c.chsimu[15].set("L43b @ 4.26+-.006 FWHM=.8<1.+-.0667 AMP=1.");
            self.c.chsimu[16].set("L41a @ 4.06+-.006 FWHM=.2<.4+-.0667 AMP=1.");
            self.c.chsimu[17].set("L41b @ 4.06+-.006 FWHM=.8<1.+-.0381 AMP=1.");
            self.c.chsimu[18].set("L28a @ 2.75+-.015 FWHM=.2<.4+-.0667 AMP=1.");
            self.c.chsimu[19].set("L28b @ 2.75+-.015 FWHM=.8<1.+-.0667 AMP=1.");
            self.c.chsimu[20].set("L28c @ 2.75+-.015 FWHM=1.4<1.6+-.0381 AMP=1.");
            self.c.chsimu[21].set("L23a @ 2.23+-.015 FWHM=.2<.4+-.0667 AMP=1.");
            self.c.chsimu[22].set("L23b @ 2.23+-.015 FWHM=.8<1.+-.0667 AMP=1.");
            self.c.chsimu[23].set("L23c @ 2.23+-.015 FWHM=1.4<1.6+-.0381 AMP=1.");
            self.c.chsimu[24].set("L21a @ 2.02+-.015 FWHM=.2<.4+-.0667 AMP=1.");
            self.c.chsimu[25].set("L21b @ 2.02+-.015 FWHM=.8<1.+-.0667 AMP=1.");
            self.c.chsimu[26].set("L21c @ 2.02+-.015 FWHM=1.4<1.6+-.0381 AMP=1.");
            self.c.chsimu[27].set("L16a @ 1.58+-.015 FWHM=.2<.4+-.0667 AMP=1.");
            self.c.chsimu[28].set("L16b @ 1.58+-.015 FWHM=.8<1.+-.0667 AMP=1.");
            self.c.chsimu[29].set("L16c @ 1.58+-.015 FWHM=1.4<1.6+-.0667 AMP=1.");
            self.c.chsimu[30].set("L13pre @ 1.28+-.02 FWHM=.03<.04+-.005 AMP=1.");
            self.c.chsimu[31].set("L13a @ 1.28+-.02 FWHM=.2<.3+-.025 AMP=1.");
            self.c.chsimu[32].set("L13b @ 1.28+-.02 FWHM=.4<.6+-.0667 AMP=1.");
            self.c.chsimu[33].set("L13c @ 1.28+-.02 FWHM=1.<1.2+-.0667 AMP=1.");
            self.c.chsimu[34].set("L13d @ 1.28+-.02 FWHM=1.6<1.8+-.0667 AMP=1.");
            self.c.chsimu[35].set("L13e @ 1.28+-.02 FWHM=2.2<2.4+-.0381 AMP=1.");
            self.c.chsimu[36].set("L09a @ .87+-.02 FWHM=.2<.4+-.0667 AMP=1.");
            self.c.chsimu[37].set("L09b @ .87+-.02 FWHM=.8<1.+-.0667 AMP=1.");
            self.c.chsimu[38].set("L09c @ .87+-.02 FWHM=1.4<1.6+-.0667 AMP=1.");
            self.c.chsimu[39].set("L09d @ .87+-.02 FWHM=2.<2.2+-.0381 AMP=1.");
            self.c.chsimu[40].set("cho1 @ 3.2+-.01 FWHM=.2<.3+-.025 AMP=1.");
            self.c.chsimu[41].set("cho2 @ 3.2+-.01 FWHM=.4<.6+-.0667 AMP=1.");
            self.c.chsimu[42].set("cho3 @ 3.2+-.01 FWHM=1.<1.2+-.0381 AMP=1.");
            self.c.chsimu[43].set("glycg1 @ 3.82+-.01 FWHM=.5<.75+-.0625 AMP=1.");
            self.c.chsimu[44].set("glycg2 @ 3.75+-.01 FWHM=.5<.75+-.0625 AMP=1.");
            self.c.chsimu[45].set("glycg3 @ 3.68+-.01 FWHM=.5<.75+-.0625 AMP=1.");
            self.c.chsimu[46].set("glycg4 @ 3.61+-.01 FWHM=.5<.75+-.0625 AMP=1.");
            self.c.chuse1[1].set("L13pre");
            self.c.dkntmn[2] = 1.867_f32;
            self.c.endpha = true;
            self.c.fwhmmn = 0.1_f32;
            self.c.fwhmmx = 0.4_f32;
            self.c.fwhmst = 0.15_f32;
            self.c.gauss_rt2 = false;
            self.c.idgppm = 2;
            self.c.isdbol = 5;
            self.c.mrepha[1] = 1;
            self.c.nbas_ccf = 0;
            self.c.ncombi = 17;
            self.c.ngrsh = 11;
            self.c.nnot2 = 2;
            self.c.nobasi = true;
            self.c.nratio = 0;
            if self.c.ppmst >= 4.28_f32 {
                self.c.nratio = 2;
            }
            self.c.nrefpk[2] = 1;
            self.c.nsimul = 46;
            self.c.onlyco = true;
            self.c.ppmref[(1, 2)] = 1.28_f32;
            if self.c.ppmst < -9998.0_f32 {
                self.c.ppmst = 3.6_f32;
            }
            if self.c.ppmend > 9998.0_f32 {
                self.c.ppmend = -2.0_f32;
            }
            if (self.c.ppmst - self.c.ppmend) >= 6.4_f32 {
                self.c.nsubtk = 5;
                self.c.xstep = 1.0_f32;
            }
            self.c.namrel.set("L16+L09+L13");
            if self.c.dowatr && self.c.ppmst >= 5.0_f32 {
                self.c.chuse1[2].set("W1pre");
                if !(self.c.dows || self.c.doecc) {
                    self.c.namrel.set("Water");
                }
                self.c.nuse1 = 2;
            } else {
                self.c.nuse1 = 1;
                if self.c.ppmst >= 5.0_f32 {
                    self.c.ppmgap[(1, 1)] = 5.0_f32;
                    self.c.ppmgap[(2, 1)] = 3.6_f32;
                    self.c.ppmsep[1] = 4.3_f32;
                } else {
                    self.c.rfwhcc = 0.0_f32;
                    self.c.rrt2mq = 0.25_f32;
                }
            }
            self.c.prmnmx[(1, 1)] = 0.05_f32;
            self.c.prmnmx[(2, 1)] = 0.9_f32;
            self.c.rbackg[1] = 22.2_f32;
            self.c.scafwh = true;
            self.c.sdgrsh[1] = 0.003_f32;
            self.c.sdgrsh[2] = 0.003_f32;
            self.c.sdgrsh[3] = 0.003_f32;
            self.c.sdgrsh[4] = 0.003_f32;
            self.c.sdgrsh[5] = 0.003_f32;
            self.c.sdgrsh[6] = 0.002_f32;
            self.c.sdgrsh[7] = 0.003_f32;
            self.c.sdgrsh[8] = 0.003_f32;
            self.c.sdgrsh[9] = 0.003_f32;
            self.c.sdgrsh[10] = 0.005_f32;
            self.c.sdgrsh[11] = 0.01_f32;
            self.c.sdsmoo[3] = 0.03_f32;
            self.c.shifmn[1] = -4.0_f32;
            self.c.shifmn[2] = -1.0_f32;
            self.c.shifmx[1] = 1.0_f32;
            self.c.shifmx[2] = 2.5_f32;
            self.c.useany = true;
            self.c.vitro = true;
            self.c.wconc = 0.5_f32;
        }
        if self.c.sptype.sub(1, 8).eq_str("liver-11") {
            self.c.chcom2[17].set("Glycg");
            self.c.chcomb[17].set("glycg1+glycg2+glycg3+glycg4+glycg5+glycg6+glycg7");
            self.c.chsimu[43].set("glycg1 @ 3.89+-.01 FWHM=.5<.75+-.0625 AMP=1.                      @999.0 FWHM=1.0 AMP=0.1");
            self.c.chsimu[44].set("glycg2 @ 3.82+-.01 FWHM=.5<.75+-.0625 AMP=1.                      @999.0 FWHM=1.0 AMP=0.1");
            self.c.chsimu[45].set("glycg3 @ 3.75+-.01 FWHM=.5<.75+-.0625 AMP=1.                      @999.0 FWHM=1.0 AMP=0.1");
            self.c.chsimu[46].set("glycg4 @ 3.68+-.01 FWHM=.5<.75+-.0625 AMP=1.                      @999.0 FWHM=1.0 AMP=0.1");
            self.c.chsimu[47].set("glycg5 @ 3.61+-.01 FWHM=.5<.75+-.0625 AMP=1.                      @999.0 FWHM=1.0 AMP=0.1");
            self.c.chsimu[48].set("glycg6 @ 3.54+-.01 FWHM=.5<.75+-.0625 AMP=1.                      @999.0 FWHM=1.0 AMP=0.1");
            self.c.chsimu[49].set("glycg7 @ 3.47+-.01 FWHM=.5<.75+-.0625 AMP=1.                      @999.0 FWHM=1.0 AMP=0.1");
            self.c.ncombi = 17;
            self.c.nsimul = 49;
            if !self.c.dowatr && self.c.ppmst >= 5.0_f32 {
                self.c.ppmgap[(2, 1)] = 4.0_f32;
            }
            self.c.ppmst = 4.0_f32;
        }
    }

    /// MYCONT's statements from lipid-1.inc.
    fn sptype_lipid(&mut self, is_sptype: &mut bool) {
        if self.c.sptype.sub(1, 9).eq_str("breast-1 ") || self.c.sptype.sub(1, 8).eq_str("lipid-1 ") {
            self.c.chnot1[27].set("cho4");
            self.c.chnot1[28].set("cho5");
            self.c.chnot1[29].set("cho6");
            self.c.chsimu[41].set("cho1 @ 3.20+-.015 FWHM=.06<.08+-.01 AMP=1.");
            self.c.chsimu[42].set("cho2 @ 3.20+-.015 FWHM=.08<.10+-.01 AMP=1.");
            self.c.chsimu[43].set("cho3 @ 3.20+-.015 FWHM=.10<.12+-.01 AMP=1.");
            self.c.chsimu[44].set("cho4 @ 3.20+-.015 FWHM=.12<.14+-.01 AMP=1.");
            self.c.chsimu[45].set("cho5 @ 3.20+-.015 FWHM=.14<.16+-.01 AMP=1.");
            self.c.chsimu[46].set("cho6 @ 3.20+-.015 FWHM=.16<.18+-.01 AMP=1.");
            self.c.nnot1 = 29;
            self.c.nsimul = 46;
            self.c.ppmst = 4.0_f32;
        }
        if ((self.c.sptype.sub(1, 8).eq_str("breast-2") || self.c.sptype.sub(1, 10).eq_str("only-cho-1")) || self.c.sptype.sub(1, 8).eq_str("breast-3")) || self.c.sptype.sub(1, 10).eq_str("only-cho-2") {
            self.c.chsimu[38].set("cho1 @ 3.185+-.015 FWHM=.030<.050+-.012 AMP=1.");
            self.c.chsimu[39].set("cho2 @ 3.185+-.015 FWHM=.074<.086+-.012 AMP=1.");
            self.c.chsimu[40].set("cho3 @ 3.185+-.015 FWHM=.110<.122+-.012 AMP=1.");
            self.c.chsimu[41].set("cho4 @ 3.185+-.015 FWHM=.146<.158+-.012 AMP=1.");
            self.c.chsimu[42].set("cho5 @ 3.185+-.015 FWHM=.182<.194+-.012 AMP=1.");
            self.c.chsimu[43].set("cho6 @ 3.185+-.015 FWHM=.218<.230+-.012 AMP=1.");
            self.c.chsimu[44].set("cho7 @ 3.185+-.015 FWHM=.254<.266+-.012 AMP=1.");
            if self.c.ppmst < 5.0_f32 {
                self.c.nrefpk[2] = 2;
                self.c.ppmref[(1, 2)] = 3.185_f32;
                self.c.ppmref[(2, 2)] = 1.28_f32;
                self.c.shifmn[2] = -0.7_f32;
                self.c.shifmx[2] = 1.0_f32;
            }
            self.c.nsimul = 44;
            self.c.ppmst = 3.8_f32;
            if self.c.sptype.sub(1, 10).eq_str("only-cho-1") || self.c.sptype.sub(1, 10).eq_str("only-cho-2") {
                self.c.chomit[1].set("L20a");
                self.c.chomit[2].set("L20b");
                self.c.chomit[3].set("L20c");
                self.c.chomit[4].set("L20d");
                self.c.chomit[5].set("L20e");
                self.c.chomit[6].set("L20f");
                self.c.dorefs[1] = true;
                self.c.dorefs[2] = false;
                self.c.fh2omx = 0.8_f32;
                self.c.namrel.set("Cho");
                self.c.nomit = 6;
                self.c.nrefpk[2] = 1;
                self.c.ppmend = 2.7_f32;
                self.c.rsdgp3 = 1.05_f32;
            }
        }
        if self.c.sptype.sub(1, 7).eq_str("lipid-1") {
            self.c.nsimul = 40;
            self.c.ppmst = 3.4_f32;
        }
        if self.c.sptype.sub(1, 7).eq_str("lipid-2") || self.c.sptype.sub(1, 7).eq_str("lipid-3") {
            if self.c.ppmst < 5.0_f32 {
                self.c.idgppm = 0;
            }
            self.c.nsimul = 37;
            self.c.ppmst = 3.6_f32;
        }
        if self.c.sptype.sub(1, 8).eq_str("breast-4") {
            self.c.chsimu[42].set("cho1 @ 3.185+-.015 FWHM=.030<.050+-.012 AMP=1.");
            self.c.chsimu[43].set("cho2 @ 3.185+-.015 FWHM=.074<.086+-.012 AMP=1.");
            self.c.chsimu[44].set("cho3 @ 3.185+-.015 FWHM=.110<.122+-.012 AMP=1.");
            self.c.chsimu[45].set("cho4 @ 3.185+-.015 FWHM=.146<.158+-.012 AMP=1.");
            self.c.chsimu[46].set("cho5 @ 3.185+-.015 FWHM=.182<.194+-.012 AMP=1.");
            self.c.chsimu[47].set("cho6 @ 3.185+-.015 FWHM=.218<.230+-.012 AMP=1.");
            self.c.chsimu[48].set("cho7 @ 3.185+-.015 FWHM=.254<.266+-.012 AMP=1.");
            if self.c.ppmst < 5.0_f32 {
                self.c.nrefpk[2] = 2;
                self.c.ppmref[(1, 2)] = 3.185_f32;
                self.c.ppmref[(2, 2)] = 1.28_f32;
                self.c.shifmn[2] = -0.7_f32;
                self.c.shifmx[2] = 1.0_f32;
            }
            self.c.nsimul = 48;
            self.c.ppmst = 3.8_f32;
        }
        if self.c.sptype.sub(1, 7).eq_str("lipid-4") {
            self.c.nsimul = 41;
        }
        if ((((self.c.sptype.sub(1, 8).eq_str("breast-5") || self.c.sptype.sub(1, 8).eq_str("breast-6")) || self.c.sptype.sub(1, 8).eq_str("breast-7")) || self.c.sptype.sub(1, 8).eq_str("breast-8")) || self.c.sptype.sub(1, 8).eq_str("breast-9")) || self.c.sptype.sub(1, 9).eq_str("breast-10") {
            if self.c.sptype.sub(1, 8).eq_str("breast-5") {
                self.c.chsimu[48].set("cho1 @ 3.185+-.015 FWHM=.03<.05+-.01 AMP=1.");
                self.c.chsimu[49].set("cho2 @ 3.185+-.015 FWHM=.07<.09+-.01 AMP=1.");
                self.c.chsimu[50].set("cho3 @ 3.185+-.015 FWHM=.11<.13+-.01 AMP=1.");
                self.c.chsimu[51].set("cho4 @ 3.185+-.015 FWHM=.15<.17+-.01 AMP=1.");
                self.c.chsimu[52].set("cho5 @ 3.185+-.015 FWHM=.19<.21+-.01 AMP=1.");
                self.c.nsimul = 52;
                self.c.ppmref[(1, 2)] = 3.185_f32;
            } else if self.c.sptype.sub(1, 8).eq_str("breast-6") {
                self.c.chsimu[52].set("cho1 @ 3.185+-.015 FWHM=.03<.05+-.01 AMP=1.");
                self.c.chsimu[53].set("cho2 @ 3.185+-.015 FWHM=.07<.09+-.01 AMP=1.");
                self.c.chsimu[54].set("cho3 @ 3.185+-.015 FWHM=.11<.13+-.01 AMP=1.");
                self.c.chsimu[55].set("cho4 @ 3.185+-.015 FWHM=.15<.17+-.01 AMP=1.");
                self.c.chsimu[56].set("cho5 @ 3.185+-.015 FWHM=.19<.21+-.01 AMP=1.");
                self.c.nsimul = 56;
                self.c.ppmref[(1, 2)] = 3.185_f32;
            } else if (self.c.sptype.sub(1, 8).eq_str("breast-7") || self.c.sptype.sub(1, 8).eq_str("breast-8")) || self.c.sptype.sub(1, 9).eq_str("breast-10") {
                self.c.nsimul = 42;
                self.c.ppmref[(1, 2)] = 3.2_f32;
            } else if self.c.sptype.sub(1, 8).eq_str("breast-9") {
                self.c.nsimul = 15;
                self.c.ppmref[(1, 2)] = 3.2_f32;
            }
            self.c.nrefpk[2] = 2;
            self.c.ppmref[(2, 2)] = 1.28_f32;
            self.c.shifmn[2] = -0.7_f32;
            self.c.shifmx[2] = 1.0_f32;
            if !self.c.dowatr {
                self.c.ppmgap[(2, 1)] = 3.8_f32;
            }
            self.c.ppmst = 3.8_f32;
        }
        if self.c.sptype.sub(1, 7).eq_str("lipid-5") {
            self.c.nsimul = 47;
        }
        if self.c.sptype.sub(1, 7).eq_str("lipid-6") {
            self.c.nsimul = 51;
            if !self.c.dowatr || self.c.ppmst < 5.0_f32 {
                self.c.nuse1 = 11;
            }
        }
        if (self.c.sptype.sub(1, 7).eq_str("lipid-7") || self.c.sptype.sub(1, 7).eq_str("lipid-8")) || self.c.sptype.sub(1, 8).eq_str("lipid-10") {
            self.c.nsimul = 39;
        }
        if self.c.sptype.sub(1, 7).eq_str("lipid-9") {
            self.c.nsimul = 14;
        }
        if (((self.c.sptype.sub(1, 10).eq_str("prostate-a") || self.c.sptype.sub(1, 10).eq_str("prostate-b")) || self.c.sptype.sub(1, 10).eq_str("prostate-c")) || self.c.sptype.sub(1, 10).eq_str("prostate-d")) || self.c.sptype.sub(1, 10).eq_str("prostate-e") {
            *is_sptype = true;
            self.c.atth2o = 1.0_f32;
            self.c.badref = true;
            self.c.chcom2[1].set("Cho");
            self.c.chcom2[2].set("Cr");
            self.c.chcom2[3].set("PA");
            self.c.chcom2[4].set("Cit");
            self.c.chcom2[5].set("PA+Cr");
            self.c.chcom2[6].set("Cho+Cr");
            self.c.chcom2[7].set("Cho+PA+Cr");
            self.c.chcomb[1].set("Cho1+Cho2");
            self.c.chcomb[2].set("Cr1+Cr2");
            self.c.chcomb[3].set("PA1+PA2+PA3+PA4");
            self.c.chcomb[4].set("Cit1a+Cit2a+Cit3a+Cit4a+Cit1b+Cit2b+Cit3b+Cit4b+Cit1c+Cit2c+Cit3c+Cit4c");
            self.c.chcomb[5].set("PA1+PA2+PA3+PA4+Cr1+Cr2");
            self.c.chcomb[6].set("Cho1+Cho2+Cr1+Cr2");
            self.c.chcomb[7].set("Cho1+Cho2+PA1+PA2+PA3+PA4+Cr1+Cr2");
            self.c.chgrsh[1].set("Cit1");
            self.c.chgrsh[2].set("Cit2");
            self.c.chgrsh[3].set("Cit3");
            self.c.chgrsh[4].set("Cit4");
            self.c.chgrsh[5].set("PA");
            self.c.chgrsh[6].set("Cho");
            self.c.chgrsh[7].set("Cr");
            self.c.chnot1[1].set("Cit1b");
            self.c.chnot1[2].set("Cit2b");
            self.c.chnot1[3].set("Cit3b");
            self.c.chnot1[4].set("Cit4b");
            self.c.chnot1[5].set("Cit1c");
            self.c.chnot1[6].set("Cit2c");
            self.c.chnot1[7].set("Cit3c");
            self.c.chnot1[8].set("Cit4c");
            self.c.chnot1[9].set("PA1");
            self.c.chnot1[10].set("PA2");
            self.c.chnot1[11].set("PA3");
            self.c.chnot1[12].set("PA4");
            self.c.chnot1[13].set("Cho2");
            self.c.chnot1[14].set("Cr2");
            self.c.chnot2[1].set("PA0");
            self.c.chsimu[1].set("Cho1 @ 3.2 +- 0.015 FWHM= 0.03 < 0.04 +- 0.01 AMP=1.0");
            self.c.chsimu[2].set("Cho2 @ 3.2 +- 0.015 FWHM= 0.06 < 0.07 +- 0.01 AMP=1.0");
            self.c.chsimu[3].set("Cr1 @ 3.03 +- 0.015 FWHM= 0.03 < 0.04 +- 0.01 AMP=1.0");
            self.c.chsimu[4].set("Cr2 @ 3.03 +- 0.015 FWHM= 0.06 < 0.07 +- 0.01 AMP=1.0");
            self.c.chsimu[5].set("PA0 @ 3.11 +- 0.015 FWHM= 0.03 < 0.04 +- 0.01 AMP=1.0");
            self.c.chsimu[6].set("PA1 @ 3.11 +- 0.015 FWHM= 0.04 < 0.06 +- 0.01 AMP=1.0");
            self.c.chsimu[7].set("PA2 @ 3.11 +- 0.015 FWHM= 0.08 < 0.10 +- 0.01 AMP=1.0");
            self.c.chsimu[8].set("PA3 @ 3.11 +- 0.015 FWHM= 0.12 < 0.14 +- 0.01 AMP=1.0");
            self.c.chsimu[9].set("PA4 @ 3.11 +- 0.015 FWHM= 0.16 < 0.18 +- 0.01 AMP=1.0");
            self.c.chsimu[10].set("Cit1a @ 2.81 +- 0.03 FWHM= 0.03 < 0.05+-0.01 AMP=1.0");
            self.c.chsimu[11].set("Cit1b @ 2.81 +- 0.03 FWHM= 0.07 < 0.09+-0.01 AMP=1.0");
            self.c.chsimu[12].set("Cit1c @ 2.81 +- 0.03 FWHM= 0.11 < 0.13+-0.01 AMP=1.0");
            self.c.chsimu[13].set("Cit2a @ 2.66 +- 0.03 FWHM= 0.03 < 0.05+-0.01 AMP=1.0");
            self.c.chsimu[14].set("Cit2b @ 2.66 +- 0.03 FWHM= 0.07 < 0.09+-0.01 AMP=1.0");
            self.c.chsimu[15].set("Cit2c @ 2.66 +- 0.03 FWHM= 0.11 < 0.13+-0.01 AMP=1.0");
            self.c.chsimu[16].set("Cit3a @ 2.62 +- 0.03 FWHM= 0.03 < 0.05+-0.01 AMP=1.0");
            self.c.chsimu[17].set("Cit3b @ 2.62 +- 0.03 FWHM= 0.07 < 0.09+-0.01 AMP=1.0");
            self.c.chsimu[18].set("Cit3c @ 2.62 +- 0.03 FWHM= 0.11 < 0.13+-0.01 AMP=1.0");
            self.c.chsimu[19].set("Cit4a @ 2.47 +- 0.03 FWHM= 0.03 < 0.05+-0.01 AMP=1.0");
            self.c.chsimu[20].set("Cit4b @ 2.47 +- 0.03 FWHM= 0.07 < 0.09+-0.01 AMP=1.0");
            self.c.chsimu[21].set("Cit4c @ 2.47 +- 0.03 FWHM= 0.11 < 0.13+-0.01 AMP=1.0");
            self.c.dorefs[1] = true;
            self.c.dorefs[2] = false;
            self.c.endpha = true;
            self.c.gauss_rt2 = false;
            self.c.incsmx = 1;
            self.c.namrel.set("Cit");
            self.c.ncombi = 7;
            self.c.ngrsh = 7;
            self.c.nnot1 = 14;
            self.c.nnot2 = 1;
            self.c.nobasi = true;
            self.c.nsidmn = 1;
            self.c.nsidmx = 1;
            self.c.nsimul = 21;
            self.c.onlyco = true;
            self.c.ppmend = 2.1_f32;
            self.c.ppmst = 4.0_f32;
            self.c.sddegp = 6.0_f32;
            self.c.sdgrsh[1] = 0.002_f32;
            self.c.sdgrsh[2] = 0.002_f32;
            self.c.sdgrsh[3] = 0.002_f32;
            self.c.sdgrsh[4] = 0.002_f32;
            self.c.sdgrsh[5] = 0.004_f32;
            self.c.sdgrsh[6] = 0.002_f32;
            self.c.sdgrsh[7] = 0.002_f32;
            self.c.vitro = true;
            self.c.wconc = 0.5_f32;
        }
        if self.c.sptype.sub(1, 10).eq_str("prostate-b") {
            self.c.chcomb[4].set("Cit1a+Cit1b+Cit1c+Cit2a+Cit2b+Cit2c");
            self.c.chgrsh[1].set("Cit1");
            self.c.chgrsh[2].set("Cit2");
            self.c.chgrsh[3].set("PA");
            self.c.chgrsh[4].set("Cho");
            self.c.chgrsh[5].set("Cr");
            self.c.chrato[1].set("Cit1a/Cit2a = 1. +- .1");
            self.c.chrato[2].set("Cit1b/Cit2b = 1. +- .1");
            self.c.chrato[3].set("Cit1c/Cit2c = 1. +- .1");
            self.c.chsimu[10].set("Cit1a @ 2.67 +- .03 FWHM=.02 < .04 +- .01 AMP=1.");
            self.c.chsimu[11].set("Cit1b @ 2.67 +- .03 FWHM=.06 < .08 +- .01 AMP=1.");
            self.c.chsimu[12].set("Cit1c @ 2.67 +- .03 FWHM=.10 < .12 +- .01 AMP=1.");
            self.c.chsimu[13].set("Cit2a @ 2.61 +- .03 FWHM=.02 < .04 +- .01 AMP=1.");
            self.c.chsimu[14].set("Cit2b @ 2.61 +- .03 FWHM=.06 < .08 +- .01 AMP=1.");
            self.c.chsimu[15].set("Cit2c @ 2.61 +- .03 FWHM=.10 < .12 +- .01 AMP=1.");
            self.c.idgppm = 2;
            self.c.ngrsh = 5;
            self.c.nratio = 3;
            self.c.nsimul = 15;
            self.c.ppmend = 2.1_f32;
            self.c.ppmst = 3.85_f32;
            self.c.sddegp = 6.0_f32;
            self.c.sdgrsh[1] = 0.002_f32;
            self.c.sdgrsh[2] = 0.002_f32;
            self.c.sdgrsh[3] = 0.004_f32;
            self.c.sdgrsh[4] = 0.002_f32;
            self.c.sdgrsh[5] = 0.002_f32;
        }
        if self.c.sptype.sub(1, 10).eq_str("prostate-c") {
            self.c.chcomb[4].set("Cir1a+Cir2a+Cir3a+Cir4a+Cir5a+Cir6a+Cit7a+Cit8a+Cir1b+Cir2b+Cir3b+Cir4b+Cir5b+Cir6b+Cit7b+Cit8b+Cir1c+Cir2c+Cir3c+Cir4c+Cir5c+Cir6c+Cit7c+Cit8c");
            self.c.chgrsh[1].set("PA");
            self.c.chgrsh[2].set("Cho");
            self.c.chgrsh[3].set("Cr");
            self.c.chgrsh[4].set("Cir");
            self.c.chgrsh[5].set("Cit7");
            self.c.chgrsh[6].set("Cit8");
            self.c.chgrsh[7].set("Cit");
            self.c.chgrsh[8].set("Ci");
            self.c.chsimu[10].set("Cir1a @ 2.830 +- 0.03 FWHM= 0.03 < 0.05+-0.01                  AMP=0.5  @ 2.450 FWHM=0.03 AMP=0.5");
            self.c.chsimu[11].set("Cir1b @ 2.830 +- 0.03 FWHM= 0.07 < 0.09+-0.01                  AMP=0.5  @ 2.450 FWHM=0.07 AMP=0.5");
            self.c.chsimu[12].set("Cir1c @ 2.830 +- 0.03 FWHM= 0.11 < 0.13+-0.01                  AMP=0.5  @ 2.450 FWHM=0.11 AMP=0.5");
            self.c.chsimu[13].set("Cir2a @ 2.815 +- 0.03 FWHM= 0.03 < 0.05+-0.01                  AMP=0.5  @ 2.465 FWHM=0.03 AMP=0.5");
            self.c.chsimu[14].set("Cir2b @ 2.815 +- 0.03 FWHM= 0.07 < 0.09+-0.01                  AMP=0.5  @ 2.465 FWHM=0.07 AMP=0.5");
            self.c.chsimu[15].set("Cir2c @ 2.815 +- 0.03 FWHM= 0.11 < 0.13+-0.01                 AMP=0.5  @ 2.465 FWHM=0.11 AMP=0.5");
            self.c.chsimu[16].set("Cir3a @ 2.800 +- 0.03 FWHM= 0.03 < 0.05+-0.01                  AMP=0.5  @ 2.480 FWHM=0.03 AMP=0.5");
            self.c.chsimu[17].set("Cir3b @ 2.800 +- 0.03 FWHM= 0.07 < 0.09+-0.01                  AMP=0.5  @ 2.480 FWHM=0.07 AMP=0.5");
            self.c.chsimu[18].set("Cir3c @ 2.800 +- 0.03 FWHM= 0.11 < 0.13+-0.01                 AMP=0.5  @ 2.480 FWHM=0.11 AMP=0.5");
            self.c.chsimu[19].set("Cir4a @ 2.785 +- 0.03 FWHM= 0.03 < 0.05+-0.01                  AMP=0.5  @ 2.495 FWHM=0.03 AMP=0.5");
            self.c.chsimu[20].set("Cir4b @ 2.785 +- 0.03 FWHM= 0.07 < 0.09+-0.01                  AMP=0.5  @ 2.495 FWHM=0.07 AMP=0.5");
            self.c.chsimu[21].set("Cir4c @ 2.785 +- 0.03 FWHM= 0.11 < 0.13+-0.01                  AMP=0.5  @ 2.495 FWHM=0.11 AMP=0.5");
            self.c.chsimu[22].set("Cir5a @ 2.770 +- 0.03 FWHM= 0.03 < 0.05+-0.01                  AMP=0.5  @ 2.510 FWHM=0.03 AMP=0.5");
            self.c.chsimu[23].set("Cir5b @ 2.770 +- 0.03 FWHM= 0.07 < 0.09+-0.01                  AMP=0.5  @ 2.510 FWHM=0.07 AMP=0.5");
            self.c.chsimu[24].set("Cir5c @ 2.770 +- 0.03 FWHM= 0.11 < 0.13+-0.01                  AMP=0.5  @ 2.510 FWHM=0.11 AMP=0.5");
            self.c.chsimu[25].set("Cir6a @ 2.755 +- 0.03 FWHM= 0.03 < 0.05+-0.01                  AMP=0.5  @ 2.525 FWHM=0.03 AMP=0.5");
            self.c.chsimu[26].set("Cir6b @ 2.755 +- 0.03 FWHM= 0.07 < 0.09+-0.01                  AMP=0.5  @ 2.525 FWHM=0.07 AMP=0.5");
            self.c.chsimu[27].set("Cir6c @ 2.755 +- 0.03 FWHM= 0.11 < 0.13+-0.01                  AMP=0.5  @ 2.525 FWHM=0.11 AMP=0.5");
            self.c.chsimu[28].set("Cit7a @ 2.660 +- 0.03 FWHM= 0.03 < 0.05+-0.01                     AMP=1.0");
            self.c.chsimu[29].set("Cit7b @ 2.660 +- 0.03 FWHM= 0.07 < 0.09+-0.01                     AMP=1.0");
            self.c.chsimu[30].set("Cit7c @ 2.660 +- 0.03 FWHM= 0.11 < 0.13+-0.01                     AMP=1.0");
            self.c.chsimu[31].set("Cit8a @ 2.620 +- 0.03 FWHM= 0.03 < 0.05+-0.01                     AMP=1.0");
            self.c.chsimu[32].set("Cit8b @ 2.620 +- 0.03 FWHM= 0.07 < 0.09+-0.01                     AMP=1.0");
            self.c.chsimu[33].set("Cit8c @ 2.620 +- 0.03 FWHM= 0.11 < 0.13+-0.01                     AMP=1.0");
            self.c.ddegp3 = 20.0_f32;
            self.c.degppm = 90.0_f32;
            self.c.dgppmn = 30.0_f32;
            self.c.dgppmx = 150.0_f32;
            self.c.fh2omx = 0.8_f32;
            self.c.idgppm = 1;
            self.c.ndgppm[2] = 5;
            self.c.ngrsh = 8;
            self.c.nsimul = 33;
            self.c.ppmend = 2.1_f32;
            self.c.ppmst = 3.85_f32;
            self.c.rfwhcc = 0.125_f32;
            self.c.rsdgp3 = 1.05_f32;
            self.c.sddegp = 20.0_f32;
            self.c.sdgrsh[1] = 0.004_f32;
            self.c.sdgrsh[2] = 0.002_f32;
            self.c.sdgrsh[3] = 0.002_f32;
            self.c.sdgrsh[4] = 0.0005_f32;
            self.c.sdgrsh[5] = 0.002_f32;
            self.c.sdgrsh[6] = 0.002_f32;
            self.c.sdgrsh[7] = 0.008_f32;
            self.c.sdgrsh[8] = 0.010_f32;
            self.c.sptype.set("prostate-a");
            self.c.useany = true;
        }
        if self.c.sptype.sub(1, 10).eq_str("prostate-d") {
            self.c.badref = false;
            self.c.chcomb[4].set("Lef1a+Lef2a+Cit3a+Cit4a+Rgt5a+Rgt6a+Lef1b+Lef2b+Cit3b+Cit4b+Rgt5b+Rgt6b+Lef1c+Lef2c+Cit3c+Cit4c+Rgt5c+Rgt6c");
            self.c.chgrsh[1].set("PA");
            self.c.chgrsh[2].set("Cho");
            self.c.chgrsh[3].set("Cr");
            self.c.chgrsh[4].set("Lef1");
            self.c.chgrsh[5].set("Lef2");
            self.c.chgrsh[6].set("Cit3");
            self.c.chgrsh[7].set("Cit4");
            self.c.chgrsh[8].set("Rgt5");
            self.c.chgrsh[9].set("Rgt6");
            self.c.chgrsh[10].set("Lef");
            self.c.chgrsh[11].set("Cit");
            self.c.chgrsh[12].set("Rgt");
            self.c.chnot2[2].set("Cit0");
            self.c.chnot2[3].set("Cit7");
            self.c.chsimu[10].set("Lef1a @ 2.82 +- 0.03 FWHM= 0.03 < 0.05+-0.01 AMP=1.0");
            self.c.chsimu[11].set("Lef1b @ 2.82 +- 0.03 FWHM= 0.07 < 0.09+-0.01 AMP=1.0");
            self.c.chsimu[12].set("Lef1c @ 2.82 +- 0.03 FWHM= 0.11 < 0.13+-0.01 AMP=1.0");
            self.c.chsimu[13].set("Lef2a @ 2.77 +- 0.03 FWHM= 0.03 < 0.05+-0.01 AMP=1.0");
            self.c.chsimu[14].set("Lef2b @ 2.77 +- 0.03 FWHM= 0.07 < 0.09+-0.01 AMP=1.0");
            self.c.chsimu[15].set("Lef2c @ 2.77 +- 0.03 FWHM= 0.11 < 0.13+-0.01 AMP=1.0");
            self.c.chsimu[16].set("Cit3a @ 2.66 +- 0.03 FWHM= 0.03 < 0.05+-0.01 AMP=1.0");
            self.c.chsimu[17].set("Cit3b @ 2.66 +- 0.03 FWHM= 0.07 < 0.09+-0.01 AMP=1.0");
            self.c.chsimu[18].set("Cit3c @ 2.66 +- 0.03 FWHM= 0.11 < 0.13+-0.01 AMP=1.0");
            self.c.chsimu[19].set("Cit4a @ 2.62 +- 0.03 FWHM= 0.03 < 0.05+-0.01 AMP=1.0");
            self.c.chsimu[20].set("Cit4b @ 2.62 +- 0.03 FWHM= 0.07 < 0.09+-0.01 AMP=1.0");
            self.c.chsimu[21].set("Cit4c @ 2.62 +- 0.03 FWHM= 0.11 < 0.13+-0.01 AMP=1.0");
            self.c.chsimu[22].set("Rgt5a @ 2.51 +- 0.03 FWHM= 0.03 < 0.05+-0.01 AMP=1.0");
            self.c.chsimu[23].set("Rgt5b @ 2.51 +- 0.03 FWHM= 0.07 < 0.09+-0.01 AMP=1.0");
            self.c.chsimu[24].set("Rgt5c @ 2.51 +- 0.03 FWHM= 0.11 < 0.13+-0.01 AMP=1.0");
            self.c.chsimu[25].set("Rgt6a @ 2.46 +- 0.03 FWHM= 0.03 < 0.05+-0.01 AMP=1.0");
            self.c.chsimu[26].set("Rgt6b @ 2.46 +- 0.03 FWHM= 0.07 < 0.09+-0.01 AMP=1.0");
            self.c.chsimu[27].set("Rgt6c @ 2.46 +- 0.03 FWHM= 0.11 < 0.13+-0.01 AMP=1.0");
            self.c.chsimu[28].set("Cit0 @ 2.79 +- 0.03 FWHM= 0.03 < 0.05+-0.01 AMP=1.0");
            self.c.chsimu[29].set("Cit7 @ 2.49 +- 0.03 FWHM= 0.03 < 0.05+-0.01 AMP=1.0");
            self.c.chuse1[1].set("Cho1");
            self.c.chuse1[2].set("PA0");
            self.c.chuse1[3].set("Cr1");
            self.c.chuse1[4].set("Cit0");
            self.c.chuse1[5].set("Cit3a");
            self.c.chuse1[6].set("Cit4a");
            self.c.chuse1[7].set("Cit7");
            self.c.ddegp3 = 20.0_f32;
            self.c.degppm = 90.0_f32;
            self.c.dgppmn = 30.0_f32;
            self.c.dgppmx = 150.0_f32;
            self.c.fh2omx = 0.8_f32;
            self.c.idgppm = 1;
            self.c.ndgppm[2] = 5;
            self.c.ngrsh = 12;
            self.c.nnot1 = 0;
            self.c.nnot2 = 3;
            self.c.nsimul = 29;
            self.c.nuse1 = 7;
            self.c.ppmend = 2.1_f32;
            self.c.ppmst = 3.85_f32;
            self.c.rfwhcc = 0.125_f32;
            self.c.rsdgp3 = 1.05_f32;
            self.c.sddegp = 20.0_f32;
            self.c.sdgrsh[1] = 0.004_f32;
            self.c.sdgrsh[2] = 0.002_f32;
            self.c.sdgrsh[3] = 0.002_f32;
            self.c.sdgrsh[4] = 0.002_f32;
            self.c.sdgrsh[5] = 0.002_f32;
            self.c.sdgrsh[6] = 0.002_f32;
            self.c.sdgrsh[7] = 0.002_f32;
            self.c.sdgrsh[8] = 0.002_f32;
            self.c.sdgrsh[9] = 0.002_f32;
            self.c.sdgrsh[10] = 0.008_f32;
            self.c.sdgrsh[11] = 0.007_f32;
            self.c.sdgrsh[12] = 0.008_f32;
            self.c.sptype.set("prostate-a");
            self.c.useany = true;
        }
        if self.c.sptype.sub(1, 10).eq_str("prostate-e") {
            self.c.badref = false;
            self.c.chcom2[8].set("Lip24");
            self.c.chcomb[4].set("Cit1a+Cit1b+Cit1c+Cit1d");
            self.c.chcomb[8].set("L24a+L24b+L24c+L24d");
            self.c.chgrsh[1].set("Cit1");
            self.c.chgrsh[2].set("L24");
            self.c.chgrsh[3].set("PA");
            self.c.chgrsh[4].set("Cho");
            self.c.chgrsh[5].set("Cr");
            self.c.chsimu[10].set("Cit1a @ 2.64 +- .03 FWHM=.03 < .05 +- .01 AMP=1.");
            self.c.chsimu[11].set("Cit1b @ 2.64 +- .03 FWHM=.07 < .09 +- .01 AMP=1.");
            self.c.chsimu[12].set("Cit1c @ 2.64 +- .03 FWHM=.11 < .13 +- .01 AMP=1.");
            self.c.chsimu[13].set("Cit1d @ 2.64 +- .03 FWHM=.15 < .17 +- .01 AMP=1.");
            self.c.chsimu[14].set("L24a @ 2.35 +- .03 FWHM=.03 < .05 +- .01 AMP=1.");
            self.c.chsimu[15].set("L24b @ 2.35 +- .03 FWHM=.07 < .09 +- .01 AMP=1.");
            self.c.chsimu[16].set("L24c @ 2.35 +- .03 FWHM=.11 < .13 +- .01 AMP=1.");
            self.c.chsimu[17].set("L24d @ 2.35 +- .03 FWHM=.15 < .17 +- .01 AMP=1.");
            self.c.chuse1[1].set("Cho1");
            self.c.chuse1[2].set("PA0");
            self.c.chuse1[3].set("Cr1");
            self.c.chuse1[4].set("Cit1a");
            self.c.chuse1[5].set("L24a");
            self.c.ddegp3 = 15.0_f32;
            self.c.degppm = 45.0_f32;
            self.c.dgppmn = 0.0_f32;
            self.c.dgppmx = 90.0_f32;
            self.c.fh2omx = 1.0_f32;
            self.c.idgppm = 2;
            self.c.ncombi = 8;
            self.c.ndgppm[2] = 4;
            self.c.ngrsh = 5;
            self.c.nsimul = 17;
            self.c.nuse1 = 5;
            self.c.ppmend = 2.1_f32;
            self.c.ppmst = 3.85_f32;
            self.c.rfwhcc = 0.0_f32;
            self.c.rsdgp3 = 1.05_f32;
            self.c.sddegp = 20.0_f32;
            self.c.sdgrsh[1] = 0.004_f32;
            self.c.sdgrsh[2] = 0.004_f32;
            self.c.sdgrsh[3] = 0.004_f32;
            self.c.sdgrsh[4] = 0.002_f32;
            self.c.sdgrsh[5] = 0.002_f32;
        }
        if self.c.sptype.sub(1, 10).eq_str("prostate-f") {
            *is_sptype = true;
            self.c.atth2o = 1.0_f32;
            self.c.badref = true;
            self.c.chcom2[1].set("Cho");
            self.c.chcom2[2].set("Cr");
            self.c.chcom2[3].set("PA");
            self.c.chcom2[4].set("Cit");
            self.c.chcom2[5].set("PA+Cr");
            self.c.chcom2[6].set("Cho+Cr");
            self.c.chcom2[7].set("Cho+PA+Cr");
            self.c.chcomb[1].set("Cho1+Cho2+Cho3+Cho4+Cho5");
            self.c.chcomb[2].set("Cr1+Cr2");
            self.c.chcomb[3].set("PA1+PA2+PA3+PA4");
            self.c.chcomb[4].set("Cit1a+Cit1b+Cit1c+Cit1d+Cit1e+Cit1f+Cit2a+Cit2b+Cit2c+Cit2d+Cit2e+Cit2f");
            self.c.chcomb[5].set("PA1+PA2+PA3+PA4+Cr1+Cr2");
            self.c.chcomb[6].set("Cho1+Cho2+Cho3+Cho4+Cho5+Cr1+Cr2");
            self.c.chcomb[7].set("Cho1+Cho2+Cho3+Cho4+Cho5+PA1+PA2+PA3+PA4+Cr1+Cr2");
            self.c.chgrsh[1].set("Cit1");
            self.c.chgrsh[2].set("Cit2");
            self.c.chgrsh[3].set("PA");
            self.c.chgrsh[4].set("Cho");
            self.c.chgrsh[5].set("Cr");
            self.c.chnot1[1].set("Cit1a");
            self.c.chnot1[2].set("Cit1b");
            self.c.chnot1[3].set("Cit1c");
            self.c.chnot1[4].set("Cit1d");
            self.c.chnot1[5].set("Cit1e");
            self.c.chnot1[6].set("Cit1f");
            self.c.chnot1[7].set("Cit2a");
            self.c.chnot1[8].set("Cit2b");
            self.c.chnot1[9].set("Cit2c");
            self.c.chnot1[10].set("Cit2d");
            self.c.chnot1[11].set("Cit2e");
            self.c.chnot1[12].set("Cit2f");
            self.c.chnot2[1].set("PA0");
            self.c.chnot2[2].set("Cita");
            self.c.chnot2[3].set("Citb");
            self.c.chnot2[4].set("Citc");
            self.c.chnot2[5].set("Citd");
            self.c.chnot2[6].set("Cite");
            self.c.chnot2[7].set("Citf");
            self.c.chrato[1].set("Cit1a/Cit2a = 1. +- .1");
            self.c.chrato[2].set("Cit1b/Cit2b = 1. +- .1");
            self.c.chrato[3].set("Cit1c/Cit2c = 1. +- .1");
            self.c.chrato[4].set("Cit1d/Cit2d = 1. +- .1");
            self.c.chrato[5].set("Cit1e/Cit2e = 1. +- .1");
            self.c.chrato[6].set("Cit1f/Cit2f = 1. +- .1");
            self.c.chsimu[1].set("Cho1 @ 3.21 +- 0.02 FWHM= 0.03 < 0.04 +- 0.01                     AMP=1.0");
            self.c.chsimu[2].set("Cho2 @ 3.21 +- 0.02 FWHM= 0.06 < 0.07 +- 0.01                     AMP=1.0");
            self.c.chsimu[3].set("Cho3 @ 3.21 +- 0.02 FWHM= 0.09 < 0.10 +- 0.01                     AMP=1.0");
            self.c.chsimu[4].set("Cho4 @ 3.21 +- 0.02 FWHM= 0.12 < 0.14 +- 0.01                     AMP=1.0");
            self.c.chsimu[5].set("Cho5 @ 3.21 +- 0.02 FWHM= 0.16 < 0.18 +- 0.01                     AMP=1.0");
            self.c.chsimu[6].set("Cr1 @ 3.03 +- 0.02 FWHM= 0.03 < 0.04 +- 0.01                      AMP=1.0");
            self.c.chsimu[7].set("Cr2 @ 3.03 +- 0.02 FWHM= 0.06 < 0.07 +- 0.01                      AMP=1.0");
            self.c.chsimu[8].set("PA0 @ 3.11 +- 0.02 FWHM= 0.03 < 0.04 +- 0.01                      AMP=1.0");
            self.c.chsimu[9].set("PA1 @ 3.11 +- 0.02 FWHM= 0.04 < 0.06 +- 0.01                      AMP=1.0");
            self.c.chsimu[10].set("PA2 @ 3.11 +- 0.02 FWHM= 0.08 < 0.10 +- 0.01                      AMP=1.0");
            self.c.chsimu[11].set("PA3 @ 3.11 +- 0.02 FWHM= 0.12 < 0.14 +- 0.01                      AMP=1.0");
            self.c.chsimu[12].set("PA4 @ 3.11 +- 0.02 FWHM= 0.16 < 0.18 +- 0.01                      AMP=1.0");
            self.c.chsimu[13].set("Cit1a @ 2.67 +- .02 FWHM=.02 < .04 +- .01 AMP=1.");
            self.c.chsimu[14].set("Cit1b @ 2.67 +- .02 FWHM=.06 < .08 +- .01 AMP=1.");
            self.c.chsimu[15].set("Cit1c @ 2.67 +- .02 FWHM=.10 < .12 +- .01 AMP=1.");
            self.c.chsimu[16].set("Cit1d @ 2.67 +- .02 FWHM=.14 < .16 +- .01 AMP=1.");
            self.c.chsimu[17].set("Cit1e @ 2.67 +- .02 FWHM=.18 < .20 +- .01 AMP=1.");
            self.c.chsimu[18].set("Cit1f @ 2.67 +- .02 FWHM=.22 < .24 +- .01 AMP=1.");
            self.c.chsimu[19].set("Cit2a @ 2.61 +- .02 FWHM=.02 < .04 +- .01 AMP=1.");
            self.c.chsimu[20].set("Cit2b @ 2.61 +- .02 FWHM=.06 < .08 +- .01 AMP=1.");
            self.c.chsimu[21].set("Cit2c @ 2.61 +- .02 FWHM=.10 < .12 +- .01 AMP=1.");
            self.c.chsimu[22].set("Cit2d @ 2.61 +- .02 FWHM=.14 < .16 +- .01 AMP=1.");
            self.c.chsimu[23].set("Cit2e @ 2.61 +- .02 FWHM=.18 < .20 +- .01 AMP=1.");
            self.c.chsimu[24].set("Cit2f @ 2.61 +- .02 FWHM=.22 < .24 +- .01 AMP=1.");
            self.c.chsimu[25].set("Cita@2.67+-.02 FWHM=.02<.04+-.01 AMP=.5                               @2.61 FWHM=.02 AMP=.5");
            self.c.chsimu[26].set("Citb@2.67+-.02 FWHM=.06<.08+-.01 AMP=.5                               @2.61 FWHM=.06 AMP=.5");
            self.c.chsimu[27].set("Citc@2.67+-.02 FWHM=.10<.12+-.01 AMP=.5                               @2.61 FWHM=.10 AMP=.5");
            self.c.chsimu[28].set("Citd@2.67+-.02 FWHM=.14<.16+-.01 AMP=.5                              @2.61 FWHM=.14 AMP=.5");
            self.c.chsimu[29].set("Cite@2.67+-.02 FWHM=.18<.20+-.01 AMP=.5                               @2.61 FWHM=.18 AMP=.5");
            self.c.chsimu[30].set("Citf@2.67+-.02 FWHM=.22<.24+-.01 AMP=.5                               @2.61 FWHM=.22 AMP=.5");
            self.c.dorefs[1] = true;
            self.c.dorefs[2] = false;
            self.c.endpha = true;
            self.c.fh2omx = 1.0_f32;
            self.c.fwhmst = 0.1_f32;
            self.c.gauss_rt2 = false;
            self.c.idgppm = 2;
            self.c.incsmx = 1;
            self.c.namrel.set("Cit");
            self.c.ncombi = 7;
            self.c.ngrsh = 5;
            self.c.nnot1 = 12;
            self.c.nnot2 = 7;
            self.c.nratio = 6;
            self.c.nobasi = true;
            self.c.nsidmn = 1;
            self.c.nsidmx = 1;
            self.c.nsimul = 30;
            self.c.onlyco = true;
            self.c.ppmend = 2.1_f32;
            self.c.ppmst = 3.85_f32;
            self.c.rfwhcc = 0.0_f32;
            self.c.sddegp = 6.0_f32;
            self.c.sdgrsh[1] = 0.005_f32;
            self.c.sdgrsh[2] = 0.005_f32;
            self.c.sdgrsh[3] = 0.010_f32;
            self.c.sdgrsh[4] = 0.005_f32;
            self.c.sdgrsh[5] = 0.005_f32;
            self.c.vitro = true;
            self.c.wconc = 0.5_f32;
        }
        if self.c.sptype.sub(1, 10).eq_str("prostate-g") {
            *is_sptype = true;
            self.c.atth2o = 1.0_f32;
            self.c.chcom2[1].set("Cho");
            self.c.chcom2[2].set("Cr");
            self.c.chcom2[3].set("PA");
            self.c.chcom2[4].set("Cit");
            self.c.chcom2[5].set("PA+Cr");
            self.c.chcom2[6].set("Cho+Cr");
            self.c.chcom2[7].set("Cho+PA+Cr");
            self.c.chcomb[1].set("Cho1+Cho2+Cho3");
            self.c.chcomb[2].set("Cr1+Cr2+Cr3");
            self.c.chcomb[3].set("PA1+PA2+PA3");
            self.c.chcomb[4].set("Lef1a+Lef2a+Cit3a+Cit4a+Rgt5a+Rgt6a+Lef1b+Lef2b+Cit3b+Cit4b+Rgt5b+Rgt6b+Lef1c+Lef2c+Cit3c+Cit4c+Rgt5c+Rgt6c");
            self.c.chcomb[5].set("PA1+PA2+PA3+Cr1+Cr2+Cr3");
            self.c.chcomb[6].set("Cho1+Cho2+Cho3+Cr1+Cr2+Cr3");
            self.c.chcomb[7].set("Cho1+Cho2+Cho3+PA1+PA2+PA3+Cr1+Cr2+Cr3");
            self.c.chgrsh[1].set("PA");
            self.c.chgrsh[2].set("Cho");
            self.c.chgrsh[3].set("Cr");
            self.c.chgrsh[4].set("Lef1");
            self.c.chgrsh[5].set("Lef2");
            self.c.chgrsh[6].set("Cit3");
            self.c.chgrsh[7].set("Cit4");
            self.c.chgrsh[8].set("Rgt5");
            self.c.chgrsh[9].set("Rgt6");
            self.c.chgrsh[10].set("Lef");
            self.c.chgrsh[11].set("Cit");
            self.c.chgrsh[12].set("Rgt");
            self.c.chnot2[1].set("PA0");
            self.c.chsimu[1].set("Cho1 @ 3.2 +- 0.015 FWHM= 0.03 < 0.04+-0.01 AMP=1.0");
            self.c.chsimu[2].set("Cho2 @ 3.2 +- 0.015 FWHM= 0.06 < 0.07+-0.01 AMP=1.0");
            self.c.chsimu[3].set("Cho3 @ 3.2 +- 0.015 FWHM= 0.09 < 0.11+-0.01 AMP=1.0");
            self.c.chsimu[4].set("Cr1 @ 3.03 +- 0.015 FWHM= 0.03 < 0.04 +- 0.01 AMP=1.0");
            self.c.chsimu[5].set("Cr2 @ 3.03 +- 0.015 FWHM= 0.06 < 0.07 +- 0.01 AMP=1.0");
            self.c.chsimu[6].set("Cr3 @ 3.03 +- 0.015 FWHM= 0.09 < 0.11 +- 0.01 AMP=1.0");
            self.c.chsimu[7].set("PA0 @ 3.11 +- 0.015 FWHM= 0.03 < 0.04 +- 0.01 AMP=1.0");
            self.c.chsimu[8].set("PA1 @ 3.11 +- 0.015 FWHM= 0.04 < 0.06 +- 0.01 AMP=1.0");
            self.c.chsimu[9].set("PA2 @ 3.11 +- 0.015 FWHM= 0.08 < 0.10 +- 0.01 AMP=1.0");
            self.c.chsimu[10].set("PA3 @ 3.11 +- 0.015 FWHM= 0.12 < 0.14+-0.01 AMP=1.0");
            self.c.chsimu[11].set("Lef1a @ 2.82 +- 0.03 FWHM= 0.03 < 0.05+-0.01 AMP=1.0");
            self.c.chsimu[12].set("Lef1b @ 2.82 +- 0.03 FWHM= 0.07 < 0.09+-0.01 AMP=1.0");
            self.c.chsimu[13].set("Lef1c @ 2.82 +- 0.03 FWHM= 0.11 < 0.13+-0.01 AMP=1.0");
            self.c.chsimu[14].set("Lef2a @ 2.77 +- 0.03 FWHM= 0.03 < 0.05+-0.01 AMP=1.0");
            self.c.chsimu[15].set("Lef2b @ 2.77 +- 0.03 FWHM= 0.07 < 0.09+-0.01 AMP=1.0");
            self.c.chsimu[16].set("Lef2c @ 2.77 +- 0.03 FWHM= 0.11 < 0.13+-0.01 AMP=1.0");
            self.c.chsimu[17].set("Cit3a @ 2.66 +- 0.03 FWHM= 0.03 < 0.05+-0.01 AMP=1.0");
            self.c.chsimu[18].set("Cit3b @ 2.66 +- 0.03 FWHM= 0.07 < 0.09+-0.01 AMP=1.0");
            self.c.chsimu[19].set("Cit3c @ 2.66 +- 0.03 FWHM= 0.11 < 0.13+-0.01 AMP=1.0");
            self.c.chsimu[20].set("Cit4a @ 2.62 +- 0.03 FWHM= 0.03 < 0.05+-0.01 AMP=1.0");
            self.c.chsimu[21].set("Cit4b @ 2.62 +- 0.03 FWHM= 0.07 < 0.09+-0.01 AMP=1.0");
            self.c.chsimu[22].set("Cit4c @ 2.62 +- 0.03 FWHM= 0.11 < 0.13+-0.01 AMP=1.0");
            self.c.chsimu[23].set("Rgt5a @ 2.51 +- 0.03 FWHM= 0.03 < 0.05+-0.01 AMP=1.0");
            self.c.chsimu[24].set("Rgt5b @ 2.51 +- 0.03 FWHM= 0.07 < 0.09+-0.01 AMP=1.0");
            self.c.chsimu[25].set("Rgt5c @ 2.51 +- 0.03 FWHM= 0.11 < 0.13+-0.01 AMP=1.0");
            self.c.chsimu[26].set("Rgt6a @ 2.46 +- 0.03 FWHM= 0.03 < 0.05+-0.01 AMP=1.0");
            self.c.chsimu[27].set("Rgt6b @ 2.46 +- 0.03 FWHM= 0.07 < 0.09+-0.01 AMP=1.0");
            self.c.chsimu[28].set("Rgt6c @ 2.46 +- 0.03 FWHM= 0.11 < 0.13+-0.01 AMP=1.0");
            self.c.chuse1[1].set("Cho1");
            self.c.chuse1[2].set("PA0");
            self.c.chuse1[3].set("Cr1");
            self.c.chuse1[4].set("Cit3a");
            self.c.chuse1[5].set("Cit4a");
            self.c.ddegp3 = 10.0_f32;
            self.c.dorefs[1] = true;
            self.c.dorefs[2] = false;
            self.c.fh2omx = 0.8_f32;
            self.c.gauss_rt2 = false;
            self.c.idgppm = 2;
            self.c.incsmx = 1;
            self.c.namrel.set("Cit");
            self.c.ncombi = 7;
            self.c.ndgppm[2] = 5;
            self.c.ngrsh = 12;
            self.c.nnot2 = 1;
            self.c.nobasi = true;
            self.c.nsidmn = 1;
            self.c.nsidmx = 1;
            self.c.nsimul = 28;
            self.c.nuse1 = 5;
            self.c.onlyco = true;
            self.c.ppmend = 2.1_f32;
            self.c.ppmst = 3.85_f32;
            self.c.rfwhcc = 0.125_f32;
            self.c.rsdgp3 = 1.05_f32;
            self.c.sdgrsh[1] = 0.008_f32;
            self.c.sdgrsh[2] = 0.004_f32;
            self.c.sdgrsh[3] = 0.004_f32;
            self.c.sdgrsh[4] = 0.004_f32;
            self.c.sdgrsh[5] = 0.004_f32;
            self.c.sdgrsh[6] = 0.004_f32;
            self.c.sdgrsh[7] = 0.004_f32;
            self.c.sdgrsh[8] = 0.004_f32;
            self.c.sdgrsh[9] = 0.004_f32;
            self.c.sdgrsh[10] = 0.010_f32;
            self.c.sdgrsh[11] = 0.008_f32;
            self.c.sdgrsh[12] = 0.010_f32;
            self.c.useany = true;
            self.c.vitro = true;
            self.c.wconc = 0.5_f32;
        }
        if self.c.sptype.sub(1, 10).eq_str("prostate-h") || self.c.sptype.sub(1, 10).eq_str("prostate-i") {
            *is_sptype = true;
            self.c.atth2o = 1.0_f32;
            self.c.chcom2[1].set("Cho");
            self.c.chcom2[2].set("Cr");
            self.c.chcom2[3].set("PA");
            self.c.chcom2[4].set("Cit");
            self.c.chcom2[5].set("PA+Cr");
            self.c.chcom2[6].set("Cho+Cr");
            self.c.chcom2[7].set("Cho+PA+Cr");
            self.c.chcomb[1].set("Cho1+Cho2+Cho3");
            self.c.chcomb[2].set("Cr1+Cr2+Cr3");
            self.c.chcomb[3].set("PA1+PA2+PA3");
            self.c.chcomb[4].set("Cir1a+Cir2a+Cir3a+Cir4a+Cir5a+Cir6a+Cit7a+Cit8a+Cir1b+Cir2b+Cir3b+Cir4b+Cir5b+Cir6b+Cit7b+Cit8b+Cir1c+Cir2c+Cir3c+Cir4c+Cir5c+Cir6c+Cit7c+Cit8c");
            self.c.chcomb[5].set("PA1+PA2+PA3+Cr1+Cr2+Cr3");
            self.c.chcomb[6].set("Cho1+Cho2+Cho3+Cr1+Cr2+Cr3");
            self.c.chcomb[7].set("Cho1+Cho2+Cho3+PA1+PA2+PA3+Cr1+Cr2+Cr3");
            self.c.chgrsh[1].set("PA");
            self.c.chgrsh[2].set("Cho");
            self.c.chgrsh[3].set("Cr");
            self.c.chgrsh[4].set("Cir");
            self.c.chgrsh[5].set("Cit7");
            self.c.chgrsh[6].set("Cit8");
            self.c.chgrsh[7].set("Cit");
            self.c.chgrsh[8].set("Ci");
            self.c.chnot2[1].set("PA0");
            self.c.chnot2[2].set("Cit0");
            self.c.chrato[1].set("Cit7a/Cit8a = 1. +- .1");
            self.c.chrato[2].set("Cit7b/Cit8b = 1. +- .1");
            self.c.chrato[3].set("Cit7c/Cit8c = 1. +- .1");
            self.c.chsimu[1].set("Cho1 @ 3.2 +- 0.015 FWHM= 0.03 < 0.04+-0.01 AMP=1.0");
            self.c.chsimu[2].set("Cho2 @ 3.2 +- 0.015 FWHM= 0.06 < 0.07+-0.01 AMP=1.0");
            self.c.chsimu[3].set("Cho3 @ 3.2 +- 0.015 FWHM= 0.09 < 0.11+-0.01 AMP=1.0");
            self.c.chsimu[4].set("Cr1 @ 3.03 +- 0.015 FWHM= 0.03 < 0.04 +- 0.01 AMP=1.0");
            self.c.chsimu[5].set("Cr2 @ 3.03 +- 0.015 FWHM= 0.06 < 0.07 +- 0.01 AMP=1.0");
            self.c.chsimu[6].set("Cr3 @ 3.03 +- 0.015 FWHM= 0.09 < 0.11 +- 0.01 AMP=1.0");
            self.c.chsimu[7].set("PA0 @ 3.11 +- 0.015 FWHM= 0.03 < 0.04 +- 0.01 AMP=1.0");
            self.c.chsimu[8].set("PA1 @ 3.11 +- 0.015 FWHM= 0.04 < 0.06 +- 0.01 AMP=1.0");
            self.c.chsimu[9].set("PA2 @ 3.11 +- 0.015 FWHM= 0.08 < 0.10 +- 0.01 AMP=1.0");
            self.c.chsimu[10].set("PA3 @ 3.11 +- 0.015 FWHM= 0.12 < 0.14+-0.01 AMP=1.0");
            self.c.chsimu[11].set("Cir1a @ 2.830 +- 0.03 FWHM= 0.03 < 0.05+-0.01                  AMP=0.5  @ 2.450 FWHM=0.03 AMP=0.5");
            self.c.chsimu[12].set("Cir1b @ 2.830 +- 0.03 FWHM= 0.07 < 0.09+-0.01                  AMP=0.5  @ 2.450 FWHM=0.07 AMP=0.5");
            self.c.chsimu[13].set("Cir1c @ 2.830 +- 0.03 FWHM= 0.11 < 0.13+-0.01                  AMP=0.5  @ 2.450 FWHM=0.11 AMP=0.5");
            self.c.chsimu[14].set("Cir2a @ 2.815 +- 0.03 FWHM= 0.03 < 0.05+-0.01                  AMP=0.5  @ 2.465 FWHM=0.03 AMP=0.5");
            self.c.chsimu[15].set("Cir2b @ 2.815 +- 0.03 FWHM= 0.07 < 0.09+-0.01                  AMP=0.5  @ 2.465 FWHM=0.07 AMP=0.5");
            self.c.chsimu[16].set("Cir2c @ 2.815 +- 0.03 FWHM= 0.11 < 0.13+-0.01                 AMP=0.5  @ 2.465 FWHM=0.11 AMP=0.5");
            self.c.chsimu[17].set("Cir3a @ 2.800 +- 0.03 FWHM= 0.03 < 0.05+-0.01                  AMP=0.5  @ 2.480 FWHM=0.03 AMP=0.5");
            self.c.chsimu[18].set("Cir3b @ 2.800 +- 0.03 FWHM= 0.07 < 0.09+-0.01                  AMP=0.5  @ 2.480 FWHM=0.07 AMP=0.5");
            self.c.chsimu[19].set("Cir3c @ 2.800 +- 0.03 FWHM= 0.11 < 0.13+-0.01                 AMP=0.5  @ 2.480 FWHM=0.11 AMP=0.5");
            self.c.chsimu[20].set("Cir4a @ 2.785 +- 0.03 FWHM= 0.03 < 0.05+-0.01                  AMP=0.5  @ 2.495 FWHM=0.03 AMP=0.5");
            self.c.chsimu[21].set("Cir4b @ 2.785 +- 0.03 FWHM= 0.07 < 0.09+-0.01                  AMP=0.5  @ 2.495 FWHM=0.07 AMP=0.5");
            self.c.chsimu[22].set("Cir4c @ 2.785 +- 0.03 FWHM= 0.11 < 0.13+-0.01                  AMP=0.5  @ 2.495 FWHM=0.11 AMP=0.5");
            self.c.chsimu[23].set("Cir5a @ 2.770 +- 0.03 FWHM= 0.03 < 0.05+-0.01                  AMP=0.5  @ 2.510 FWHM=0.03 AMP=0.5");
            self.c.chsimu[24].set("Cir5b @ 2.770 +- 0.03 FWHM= 0.07 < 0.09+-0.01                  AMP=0.5  @ 2.510 FWHM=0.07 AMP=0.5");
            self.c.chsimu[25].set("Cir5c @ 2.770 +- 0.03 FWHM= 0.11 < 0.13+-0.01                  AMP=0.5  @ 2.510 FWHM=0.11 AMP=0.5");
            self.c.chsimu[26].set("Cir6a @ 2.755 +- 0.03 FWHM= 0.03 < 0.05+-0.01                  AMP=0.5  @ 2.525 FWHM=0.03 AMP=0.5");
            self.c.chsimu[27].set("Cir6b @ 2.755 +- 0.03 FWHM= 0.07 < 0.09+-0.01                  AMP=0.5  @ 2.525 FWHM=0.07 AMP=0.5");
            self.c.chsimu[28].set("Cir6c @ 2.755 +- 0.03 FWHM= 0.11 < 0.13+-0.01                  AMP=0.5  @ 2.525 FWHM=0.11 AMP=0.5");
            self.c.chsimu[29].set("Cit7a @ 2.660 +- 0.03 FWHM= 0.03 < 0.05+-0.01                     AMP=1.0");
            self.c.chsimu[30].set("Cit7b @ 2.660 +- 0.03 FWHM= 0.07 < 0.09+-0.01                     AMP=1.0");
            self.c.chsimu[31].set("Cit7c @ 2.660 +- 0.03 FWHM= 0.11 < 0.13+-0.01                     AMP=1.0");
            self.c.chsimu[32].set("Cit8a @ 2.620 +- 0.03 FWHM= 0.03 < 0.05+-0.01                     AMP=1.0");
            self.c.chsimu[33].set("Cit8b @ 2.620 +- 0.03 FWHM= 0.07 < 0.09+-0.01                     AMP=1.0");
            self.c.chsimu[34].set("Cit8c @ 2.620 +- 0.03 FWHM= 0.11 < 0.13+-0.01                     AMP=1.0");
            self.c.chsimu[35].set("Cit0 @ 2.640 +- 0.03 FWHM= 0.03 < 0.05+-0.01                      AMP=1.0");
            self.c.chuse1[1].set("Cho1");
            self.c.chuse1[2].set("PA0");
            self.c.chuse1[3].set("Cr1");
            self.c.chuse1[4].set("Cit0");
            self.c.ddegp3 = 20.0_f32;
            self.c.degppm = 90.0_f32;
            self.c.dgppmn = 30.0_f32;
            self.c.dgppmx = 150.0_f32;
            self.c.dorefs[1] = true;
            self.c.dorefs[2] = false;
            self.c.fh2omx = 0.8_f32;
            self.c.gauss_rt2 = false;
            self.c.idgppm = 1;
            self.c.incsmx = 1;
            self.c.namrel.set("Cit");
            self.c.ncombi = 7;
            self.c.ndgppm[2] = 5;
            self.c.ngrsh = 8;
            self.c.nnot2 = 2;
            self.c.nobasi = true;
            self.c.nratio = 3;
            self.c.nsidmn = 1;
            self.c.nsidmx = 1;
            self.c.nsimul = 35;
            self.c.nuse1 = 4;
            self.c.onlyco = true;
            self.c.ppmend = 2.1_f32;
            self.c.ppmst = 3.85_f32;
            self.c.rfwhcc = 0.125_f32;
            self.c.rsdgp3 = 1.05_f32;
            self.c.sdgrsh[1] = 0.006_f32;
            self.c.sdgrsh[2] = 0.003_f32;
            self.c.sdgrsh[3] = 0.003_f32;
            self.c.sdgrsh[4] = 0.00075_f32;
            self.c.sdgrsh[5] = 0.003_f32;
            self.c.sdgrsh[6] = 0.003_f32;
            self.c.sdgrsh[7] = 0.012_f32;
            self.c.sdgrsh[8] = 0.015_f32;
            self.c.useany = true;
            self.c.vitro = true;
            self.c.wconc = 0.5_f32;
        }
        if self.c.sptype.sub(1, 10).eq_str("prostate-i") {
            self.c.ddegp3 = 10.0_f32;
            self.c.degmax[1] = 5.0_f32;
            self.c.degppm = 0.0_f32;
            self.c.dgppmn = -60.0_f32;
            self.c.dgppmx = 60.0_f32;
            self.c.isdbol = 5;
            self.c.mrepha[1] = 1;
        }
        if (self.c.sptype.sub(1, 12).eq_str("mega-press-1") || self.c.sptype.sub(1, 12).eq_str("mega-press-2")) || self.c.sptype.sub(1, 12).eq_str("mega-press-3") {
            *is_sptype = true;
            self.c.alsdsh[1] = 0.004_f32;
            self.c.alsdsh[2] = 0.008_f32;
            self.c.atth2o = 0.4_f32;
            self.c.chrato[1].set("NAAG/NAA = .15 +- .15");
            self.c.chuse1[1].set("NAA");
            self.c.chuse1[2].set("Glu");
            self.c.isdbol = 5;
            self.c.namrel.set("NAA+NAAG");
            self.c.nobase = true;
            self.c.nratio = 1;
            self.c.nrefpk[2] = 1;
            self.c.nsimul = 11;
            self.c.nuse1 = 2;
            self.c.ppmend = 1.9_f32;
            self.c.ppmst = 4.2_f32;
            self.c.ratipm = 10.0_f32;
            self.c.sddegp = 1.0_f32;
            self.c.wsmet.set("NAA");
            self.c.wsppm = 2.01_f32;
        }
        if self.c.sptype.sub(1, 12).eq_str("mega-press-2") || self.c.sptype.sub(1, 12).eq_str("mega-press-3") {
            self.c.alsdsh[2] = 0.01_f32;
            self.c.atth2o = 0.43_f32;
            self.c.chcomb[17].set("GSH+Glu+Gln");
            self.c.chsimu[1].set("MM09 @ .91 +- .02 FWHM=.12 < .15 +- .015 AMP=3.");
            self.c.dgppmn = -15.0_f32;
            self.c.dgppmx = 15.0_f32;
            self.c.ncombi = 17;
            self.c.nsimul = 1;
            self.c.sddegp = 4.0_f32;
            self.c.shifmn[2] = -1.3_f32;
            self.c.shifmx[2] = 1.3_f32;
        }
        if self.c.sptype.sub(1, 12).eq_str("mega-press-3") {
            self.c.chsdsh[3].set("GABA");
            self.c.ppmend = 1.95_f32;
        }
    }

    // ------------------------------------------------------------------------
    // CHECK_ZERO_VOXELS
    // ------------------------------------------------------------------------

    /// Go through all voxels of the RAW file and set ZERO_VOXEL(IVOXEL)=T for
    /// zero voxels.
    pub fn check_zero_voxels(&mut self) -> R<()> {
        const CHSUBP: &str = "ZEROVX";
        let mut v = Nmid::new();
        let lraw = self.c.lraw;
        'l803: {
            'l804: {
                'l805: {
                    if !self.c.filraw.is_blank() {
                        let name = self.c.filraw.trim();
                        if !self.io.open_old(lraw, &name) {
                            break 'l803;
                        }
                    }
                    // Read time-domain data into DATAT.
                    if !read_nmid(&mut self.io, lraw, &mut v) {
                        break 'l804;
                    }
                    if v.fmtdat.is_blank() {
                        self.errmes(1, 4, CHSUBP)?;
                    }
                    let fmt = v.fmtdat.trim();
                    let mut ivoxel = 0;
                    let (ndslic, ndrows, ndcols) = (self.c.ndslic, self.c.ndrows, self.c.ndcols);
                    for idslic in 1..=ndslic {
                        self.c.idslic = idslic;
                        for idrow in 1..=ndrows {
                            self.c.idrow = idrow;
                            'l130: for idcol in 1..=ndcols {
                                self.c.idcol = idcol;
                                ivoxel = ivoxel + 1;
                                if ivoxel > MVOXEL {
                                    self.errmes(2, 4, CHSUBP)?;
                                }
                                self.c.zero_voxel[ivoxel] = false;
                                let nunfil = self.c.nunfil;
                                if !read_complex(&mut self.io, lraw, &fmt, nunfil, &mut self.c.datat) {
                                    break 'l805;
                                }
                                for j in 1..=nunfil {
                                    let d = self.c.datat[j];
                                    if d.re * d.re + d.im * d.im > 0.0 {
                                        continue 'l130;
                                    }
                                }
                                self.c.zero_voxel[ivoxel] = true;
                            }
                            self.c.idcol = ndcols.max(0) + 1;
                        }
                        self.c.idrow = ndrows.max(0) + 1;
                    }
                    self.c.idslic = ndslic.max(0) + 1;
                    self.io.rewind(lraw);
                    return Ok(());
                }
                // Label 805.
                return self.errmes(5, 4, CHSUBP);
            }
            // Label 804.
            self.errmes(4, 4, CHSUBP)?;
            return self.errmes(5, 4, CHSUBP);
        }
        // Label 803.
        self.errmes(3, 4, CHSUBP)?;
        self.errmes(4, 4, CHSUBP)?;
        self.errmes(5, 4, CHSUBP)
    }

    // ------------------------------------------------------------------------
    // AVERAGE
    // ------------------------------------------------------------------------

    /// Called when IAVERG>=1. Averages (phased-array) spectra stored in CSI
    /// format in DATAT, puts the average in DATAT and sets NDCOLS, etc. to
    /// single-voxel values. Weights come from AREAWA (signal) and GETVAR (noise).
    pub fn average(&mut self) -> R<()> {
        const CHSUBP: &str = "AVERAG";
        let mut channel_rms: FArr1<f32> = FArr1::new(MCHANNEL as usize);
        let mut channel_signal: FArr1<f32> = FArr1::new(MCHANNEL as usize);
        // PPMINC, NDATA, FNDATA & RADIAN are needed by AREAWA.
        self.c.ppminc = self.c.deltat * (2 * self.c.nunfil) as f32 * self.c.hzpppm;
        if self.c.ppminc <= 0.0 {
            self.errmes(1, 4, CHSUBP)?;
        }
        self.c.ppminc = 1.0 / self.c.ppminc;
        self.c.pi = 3.141592654f64 as f32;
        self.c.radian = self.c.pi / 180.0;
        self.c.ndata = 2 * self.c.nunfil;
        self.c.fndata = self.c.ndata as f32;
        self.c.voxel1 = true;
        self.c.lraw_at_top = true;
        let lprint_sav = self.c.lprint;
        self.c.lprint = 0;
        let nterm = self.c.nback[1] - self.c.nback[2] + 1;
        if nterm < 20 || self.c.nback[1].min(self.c.nback[2]) < 0 {
            self.errmes(2, 4, CHSUBP)?;
        }
        let mut jvoxel = 0;
        let mut nchannel_used = 0;
        let iaverg = self.c.iaverg;
        let mut avgh2o = (iaverg == 3 || iaverg == 31 || iaverg == 32) && (self.c.doecc || self.c.dows);
        // DATAT_WORK: weighted DATAT accumulated here. H2OF_WORK: unweighted
        // sum of H2OTs when IAVERG=3, 31 or 32.
        for junfil in 1..=self.c.nunfil {
            self.c.datat_work[junfil] = cmplx(0.0, 0.0);
            self.c.h2of_work[junfil] = cmplx(0.0, 0.0);
        }
        let mut sumwt = 0.0f32;
        let (ndslic, ndrows, ndcols) = (self.c.ndslic, self.c.ndrows, self.c.ndcols);
        for idslic in 1..=ndslic {
            self.c.idslic = idslic;
            for idrow in 1..=ndrows {
                self.c.idrow = idrow;
                'l230: for idcol in 1..=ndcols {
                    self.c.idcol = idcol;
                    jvoxel = jvoxel + 1;
                    self.mydata()?;
                    avgh2o = avgh2o && self.c.havh2o;
                    // DOWS=T is set in MYCONT if IAVERG=1 or 4.
                    if !self.c.havh2o && (iaverg == 1 || iaverg == 4) {
                        self.errmes(3, 4, CHSUBP)?;
                    }
                    self.c.voxel1 = false;
                    self.c.lraw_at_top = false;
                    {
                        let c = &self.c;
                        if idrow < c.irowst || idrow > c.irowen || idcol < c.icolst || idcol > c.icolen || idslic != c.islice || c.zero_voxel[jvoxel] {
                            continue 'l230;
                        }
                        for j in 1..=c.nvoxsk {
                            if idrow == c.irowsk[j] && idcol == c.icolsk[j] {
                                continue 'l230;
                            }
                        }
                    }
                    if iaverg == 31 && jvoxel % 2 == 0 {
                        continue 'l230;
                    }
                    if iaverg == 32 && jvoxel % 2 == 1 {
                        continue 'l230;
                    }
                    nchannel_used = nchannel_used + 1;
                    if nchannel_used > MCHANNEL {
                        self.errmes(4, 4, CHSUBP)?;
                    }
                    if iaverg == 1 || iaverg == 4 {
                        channel_signal[nchannel_used] = self.areawa(1)?;
                    } else {
                        channel_signal[nchannel_used] = 1.0;
                    }
                    if channel_signal[nchannel_used] <= 0.0 {
                        self.errmes(5, 4, CHSUBP)?;
                    }
                    // Normalize DATAT.
                    for j in 1..=self.c.nunfil {
                        self.c.datat[j] = self.c.datat[j] / channel_signal[nchannel_used];
                    }
                    if iaverg > 2 {
                        channel_rms[nchannel_used] = 1.0;
                    } else {
                        let term = self.getvar();
                        if term <= 0.0 {
                            self.errmes(6, 4, CHSUBP)?;
                        }
                        channel_rms[nchannel_used] = (term / (2 * nterm - 4) as f32).sqrt();
                        if channel_rms[nchannel_used] <= 0.0 {
                            self.errmes(7, 4, CHSUBP)?;
                        }
                    }
                    let term = channel_rms[nchannel_used] * channel_rms[nchannel_used];
                    if term <= 0.0 {
                        self.errmes(9, 4, CHSUBP)?;
                    }
                    let channel_wt = 1.0 / term;
                    // (Wright & Wald's weighting proportional to signal would be
                    // channel_wt = channel_signal**2.)
                    sumwt = sumwt + channel_wt;
                    for junfil in 1..=self.c.nunfil {
                        self.c.datat_work[junfil] = self.c.datat_work[junfil] + channel_wt * self.c.datat[junfil];
                        if avgh2o {
                            self.c.h2of_work[junfil] = self.c.h2of_work[junfil] + self.c.h2ot[junfil];
                        }
                    }
                }
                self.c.idcol = ndcols.max(0) + 1;
            }
            self.c.idrow = ndrows.max(0) + 1;
        }
        self.c.idslic = ndslic.max(0) + 1;
        if iaverg == 31 || iaverg == 32 {
            if nchannel_used < self.c.ndrows * self.c.ndcols / 2 {
                self.errmes(8, 2, CHSUBP)?;
            }
        } else if nchannel_used < self.c.ndrows * self.c.ndcols {
            self.errmes(8, 2, CHSUBP)?;
        }
        if self.c.ldump[1] {
            let mut vals = Vec::new();
            for j in 1..=nchannel_used {
                vals.push(FVal::I(j));
                vals.push(FVal::R(channel_signal[j]));
                vals.push(FVal::R(channel_rms[j]));
                vals.push(FVal::R(1.0 / channel_rms[j]));
            }
            self.io.write(6, "('ch#', 8x, 'areawa', 11x, 'rms', 4x, 'sgnl/noise' / (i3, 1p3e14.4))", &vals);
        }
        // SUMWT = 0 would most likely be caused by excluding all (non-zero) voxels.
        if sumwt <= 0.0 {
            self.errmes(10, 4, CHSUBP)?;
        }
        for j in 1..=self.c.nunfil {
            self.c.datat[j] = self.c.datat_work[j] / sumwt;
            if avgh2o {
                self.c.h2ot[j] = self.c.h2of_work[j] / sumwt;
            }
        }
        if self.c.doecc && avgh2o {
            self.ecc_truncate()?;
        }
        self.c.lprint = lprint_sav;
        self.c.ndslic = 1;
        self.c.ndrows = 1;
        self.c.ndcols = 1;
        self.c.islice = 1;
        self.c.irowst = 1;
        self.c.irowen = 1;
        self.c.icolst = 1;
        self.c.icolen = 1;
        Ok(())
    }

    /// GETVAR: variance of the noise near the end of DATAT (set by NBACK),
    /// from the SSQ of a linear regression (Draper & Smith, p 16).
    fn getvar(&mut self) -> f32 {
        let mut sy = [0.0f64; 3];
        let mut sxy = [0.0f64; 3];
        let mut syy = [0.0f64; 3];
        let mut yv = [0.0f64; 3];
        for k in 1..=2 {
            sy[k] = 0.0;
            sxy[k] = 0.0;
            syy[k] = 0.0;
        }
        let mut sx = 0.0f64;
        let mut sxx = 0.0f64;
        let mut dnterm = 0.0f64;
        let c = &self.c;
        for junfil in (c.nunfil - c.nback[1])..=(c.nunfil - c.nback[2]) {
            dnterm = dnterm + 1.0;
            sx = sx + dnterm;
            sxx = sxx + dnterm * dnterm;
            yv[1] = c.datat[junfil].re as f64;
            yv[2] = c.datat[junfil].im as f64;
            for k in 1..=2 {
                sy[k] = sy[k] + yv[k];
                sxy[k] = sxy[k] + dnterm * yv[k];
                syy[k] = syy[k] + yv[k] * yv[k];
            }
        }
        let mut getvar = 0.0f32;
        let drn = 1.0 / dnterm;
        for k in 1..=2 {
            let t = sxy[k] - drn * sx * sy[k];
            getvar = (getvar as f64 + syy[k] - drn * (sy[k] * sy[k]) - (t * t) / (sxx - drn * (sx * sx))) as f32;
        }
        getvar
    }

    // ------------------------------------------------------------------------
    // RESTORE_SETTINGS
    // ------------------------------------------------------------------------

    /// When VOXEL1 = T, saves settings that will be changed; otherwise restores them.
    pub fn restore_settings(&mut self) -> R<()> {
        let s = &mut self.s_control;
        let c = &mut self.c;
        if c.voxel1 {
            for j in 1..=c.nratio {
                s.chrato_sav[j].set_f(&c.chrato[j]);
            }
            s.degppm_sav = c.degppm;
            s.degzer_sav = c.degzer;
            // DGPPM*_ORIG will be used globally and not reset (or restored).
            c.dgppmn_orig = c.dgppmn;
            c.dgppmx_orig = c.dgppmx;
            s.fcalib_sav = c.fcalib;
            s.fwhmst_sav = c.fwhmst;
            s.lcoord_sav = c.lcoord;
            s.lcoraw_sav = c.lcoraw;
            s.lprint_sav = c.lprint;
            s.ltable_sav = c.ltable;
            s.miter1_sav = c.miter[1];
            s.nlin_sav = c.nlin;
            s.nnolsh_sav = c.nnolsh;
            s.nnot1_sav = c.nnot1;
            s.npar_sav = c.npar;
            s.sdmshf_sav = c.sdmshf;
            for jset in 1..=2 {
                s.ndegz_sav[jset] = c.ndegz[jset];
                s.ndgppm_sav[jset] = c.ndgppm[jset];
                s.nrefpk_sav[jset] = c.nrefpk[jset];
                for jpeak in 1..=MREFPK.min(c.nrefpk[jset]) {
                    s.hzref_sav[(jpeak, jset)] = c.hzref[(jpeak, jset)];
                    s.ppmref_sav[(jpeak, jset)] = c.ppmref[(jpeak, jset)];
                }
                // SHIFM*_ORIG will be used globally and not reset (or restored).
                c.shifmn_orig[jset] = c.shifmn[jset];
                c.shifmx_orig[jset] = c.shifmx[jset];
            }
            s.title_sav.set_f(&c.title);
        } else {
            for j in 1..=c.nratio {
                c.chrato[j].set_f(&s.chrato_sav[j]);
            }
            // DEGPPM & DEGZER = 0 at the end of an analysis (REPHAS). Restore
            // them unless UPDATE_PRIORS has set them for this analysis.
            if c.degppm.abs().max(c.degzer.abs()) < 1.0e-5 {
                c.degppm = s.degppm_sav;
                c.degzer = s.degzer_sav;
            }
            c.fcalib = s.fcalib_sav;
            c.fwhmst = s.fwhmst_sav;
            c.lcoord = s.lcoord_sav;
            c.lcoraw = s.lcoraw_sav;
            c.linerr = c.linerr_mycont;
            c.linetc = 0;
            c.lintbl = 0;
            c.lprint = s.lprint_sav;
            c.ltable = s.ltable_sav;
            c.miter[1] = s.miter1_sav;
            c.nermes = c.linerr_mycont;
            c.nlin = s.nlin_sav;
            c.nnolsh = s.nnolsh_sav;
            c.nnot1 = s.nnot1_sav;
            c.npar = s.npar_sav;
            c.sdmshf = s.sdmshf_sav;
            for jset in 1..=2 {
                c.ndegz[jset] = s.ndegz_sav[jset];
                c.ndgppm[jset] = s.ndgppm_sav[jset];
                c.nrefpk[jset] = s.nrefpk_sav[jset];
                for jpeak in 1..=MREFPK.min(c.nrefpk[jset]) {
                    c.hzref[(jpeak, jset)] = s.hzref_sav[(jpeak, jset)];
                    c.ppmref[(jpeak, jset)] = s.ppmref_sav[(jpeak, jset)];
                }
            }
            for j in (c.linerr_mycont + 1)..=MMERM9 {
                c.nerror[j] = 0;
            }
            c.title.set_f(&s.title_sav);
        }
        c.area_met_norm = 0.0;
        c.istago = 0;
        c.nratio_used = 0;
        c.wsdone = false;
        for j in 1..=2 {
            c.phitot[j] = 0.0;
        }
        Ok(())
    }

    // ------------------------------------------------------------------------
    // UPDATE_PRIORS
    // ------------------------------------------------------------------------

    /// Use sample variances to update priors for DEGZER, DEGPPM & SHIFM*.
    /// SUM(J) & SUM2(J): J = 1 shift, 2 DEGPPM, 3 cos(DEGZER) (no SUM2),
    /// 4 sin(DEGZER). SDDEGZ comes from the mean angle.
    pub fn update_priors(&mut self) -> R<()> {
        const CHSUBP: &str = "UPDPRI";
        let mut sd = [0.0f32; 3];
        let mut smean = [0.0f32; 3];
        if self.s_control.nsamples >= MSAMPLES {
            return Ok(());
        }
        if self.c.lcsi_sav_2 == 13 && self.s_control.initial {
            self.s_control.initial = false;
            'l160: {
                'l150: {
                    match self.io.read(13, "(i5)", &[RKind::I]) {
                        Ok(v) => {
                            if let Some(FVal::I(n)) = v.first() {
                                self.s_control.nsamples = *n;
                            }
                        }
                        Err(ReadErr::End) => break 'l160,
                        Err(ReadErr::Bad(_)) => break 'l150,
                    }
                    let ns = self.s_control.nsamples;
                    let kinds = vec![RKind::R; (7 + ns.max(0)) as usize];
                    match self.io.read(13, "(1p5e16.6)", &kinds) {
                        Ok(v) => {
                            let s = &mut self.s_control;
                            for (k, x) in v.iter().enumerate() {
                                let x = if let FVal::R(x) = x { *x } else { 0.0 };
                                let k = k as i32;
                                if k < 4 {
                                    s.sum[k + 1] = x;
                                } else if k < 7 {
                                    s.sum2[k - 3] = x;
                                } else {
                                    s.degzer_sample[k - 6] = x;
                                }
                            }
                            break 'l160;
                        }
                        Err(_) => break 'l150,
                    }
                }
                // Label 150.
                self.errmes(1, 4, CHSUBP)?;
            }
        }
        // Label 160.
        let c = &mut self.c;
        let s = &mut self.s_control;
        s.nsamples = s.nsamples + 1;
        let mut term = c.ppminc * c.ishifd as f32;
        s.sum[1] = s.sum[1] + term;
        s.sum2[1] = s.sum2[1] + term * term;

        s.sum[2] = s.sum[2] + c.phitot[2];
        s.sum2[2] = s.sum2[2] + c.phitot[2] * c.phitot[2];

        s.degzer_sample[s.nsamples] = c.phitot[1];
        term = (c.radian * c.phitot[1]).cos();
        s.sum[3] = s.sum[3] + term;
        term = (c.radian * c.phitot[1]).sin();
        s.sum[4] = s.sum[4] + term;

        if c.lcsi_sav_2 == 13 {
            self.io.rewind(13);
            self.io.write(13, "(i5)", &fv![s.nsamples]);
            let mut vals = Vec::new();
            for j in 1..=4 {
                vals.push(FVal::R(s.sum[j]));
            }
            for j in 1..=3 {
                vals.push(FVal::R(s.sum2[j]));
            }
            for j in 1..=s.nsamples {
                vals.push(FVal::R(s.degzer_sample[j]));
            }
            self.io.write(13, "(1p5e16.6)", &vals);
        }

        if s.nsamples < 2.max(c.mnsamp) {
            return Ok(());
        }

        // J = 1 for shift; J = 2 for DEGPPM.
        let ns = s.nsamples as f32;
        for j in 1..=2 {
            smean[j] = s.sum[j as i32] / ns;
            sd[j] = c.rsdsam[j as i32] * (0.0f32.max((s.sum2[j as i32] - smean[j] * smean[j] * ns) / (s.nsamples - 1) as f32)).sqrt();
        }
        sd[1] = (s.rppminc_shift * c.ppminc).max(sd[1]);
        // Keep SHIFM* within bounds of SHIFM*, to avoid excessive shift ranges.
        for j in 1..=2 {
            c.shifmn[j] = c.shifmx_orig[j].min((smean[1] - sd[1]).max(c.shifmn_orig[j]));
            c.shifmx[j] = c.shifmn_orig[j].max((smean[1] + sd[1]).min(c.shifmx_orig[j]));
        }
        c.degppm = smean[2];
        c.dgppmx = c.degppm.max(c.dgppmx_orig);
        c.dgppmn = c.degppm.min(c.dgppmn_orig);
        // Do not allow SDDEGP to exceed SDDEGP_INPUT (Notes of 090201).
        c.sddegp = c.sddegp_input.min(sd[2].max(s.sddegp_min));
        // DEGZER, made between 0 and 360 (as DEGZER_SAMPLE already is).
        c.degzer = s.sum[4].atan2(s.sum[3]) / c.radian;
        if c.degzer < 0.0 {
            c.degzer = c.degzer + 360.0;
        }
        s.sum2[3] = 0.0;
        for j in 1..=s.nsamples {
            term = s.degzer_sample[j] - c.degzer;
            let m = term.abs().min((term + 360.0).abs()).min((term - 360.0).abs());
            s.sum2[3] = s.sum2[3] + m * m;
        }
        sd[1] = c.rsdsam[3] * (s.sum2[3] / (s.nsamples - 1) as f32).sqrt();
        c.sddegz = sd[1].max(s.sddegz_min);

        if c.lcsi_sav_1 == 12 {
            self.io.rewind(12);
            if self.io.read(12, "(i5)", &[RKind::I]).is_err() {
                return stop("Fortran runtime error: READ (12, 5150) in UPDATE_PRIORS");
            }
            let c = &self.c;
            self.io.write(12, "(1p5e16.6)", &fv![c.degppm, c.degzer, c.dgppmn, c.dgppmx, c.sddegp, c.sddegz, c.shifmn[1], c.shifmn[2], c.shifmx[1], c.shifmx[2]]);
        }
        Ok(())
    }

    // ------------------------------------------------------------------------
    // OPEN_OUTPUT
    // ------------------------------------------------------------------------

    /// Adds the voxel coordinates to TITLE and the output file names (CSI),
    /// opens the output files and writes their headers. The PostScript file is
    /// not produced; its name is still derived.
    pub fn open_output(&mut self) -> R<()> {
        const CHSUBP: &str = "OPENOU";
        let mut jtitle = [0i32; 3];
        let chstr = FStr::blank(40);
        // Get date & time info.
        self.c.chdate.set(" ");
        let d = self.fdate.clone();
        self.c.chdate.set(&d);
        // Modify TITLE and filenames to include the voxel coordinates, unless
        // the data set is a single-voxel one.
        if !self.c.single_voxel {
            if self.c.voxel1 {
                let c = &self.c;
                let s = &mut self.s_control;
                if c.lcoord > 0 {
                    split_filename(&c.filcoo, "coord", "COORD", "Coord", 5, &mut s.splcoo);
                }
                if c.lcoraw > 0 {
                    split_filename(&c.filcor, "coraw", "CORAW", "Coraw", 5, &mut s.splcor);
                }
                if c.lprint > 0 {
                    split_filename(&c.filpri, "print", "PRINT", "Print", 5, &mut s.splpri);
                }
                if c.lps > 0 {
                    split_filename(&c.filps, "ps", "PS", "Ps", 2, &mut s.splps);
                }
                if c.ltable > 0 {
                    split_filename(&c.filtab, "table", "TABLE", "Table", 5, &mut s.spltab);
                }
                s.lchslic_st = icharst(&c.chslic, c.chslic.len() as i32);
                s.lchrow_st = icharst(&c.chrow, c.chrow.len() as i32);
                s.lchcol_st = icharst(&c.chcol, c.chcol.len() as i32);
                s.lchcol = ilen(&c.chcol);
                s.lchrow = ilen(&c.chrow);
                s.lchslic = ilen(&c.chslic);
            }
            let (chidcol, lidcol) = chstrip_int6(self.c.idcol);
            let (chidrow, lidrow) = chstrip_int6(self.c.idrow);
            let (chidslic, lidslic) = chstrip_int6(self.c.idslic);
            let mut ch256 = FStr::blank(256);
            if self.c.ndslic > 1 {
                ch256.set_f(
                    &FStr::lit("Slice#")
                        .cat(&chidslic.sub(1, lidslic))
                        .cat_str(" Row#")
                        .cat(&chidrow.sub(1, lidrow))
                        .cat_str(" Col#")
                        .cat(&chidcol.sub(1, lidcol))
                        .cat_str("  ")
                        .cat(&self.c.title),
                );
            } else {
                ch256.set_f(&FStr::lit("Row#").cat(&chidrow.sub(1, lidrow)).cat_str(" Col#").cat(&chidcol.sub(1, lidcol)).cat_str("  ").cat(&self.c.title));
            }
            self.c.title.set_f(&ch256);

            let s = &self.s_control;
            let c = &self.c;
            let mut chinsert = FStr::blank(36);
            if s.lchslic_st > 0 {
                chinsert.set_f(&c.chslic.sub(s.lchslic_st, s.lchslic).cat(&chidslic.sub(1, lidslic)));
            } else {
                chinsert.set_f(&chidslic.sub(1, lidslic));
            }
            if s.lchrow_st > 0 {
                let lstr = ilen(&chinsert);
                chinsert = fstr(36, &chinsert.sub(1, lstr).cat(&c.chrow.sub(s.lchrow_st, s.lchrow)).as_str());
            }
            let mut lstr = ilen(&chinsert);
            chinsert = fstr(36, &chinsert.sub(1, lstr).cat(&chidrow.sub(1, lidrow)).as_str());
            if s.lchcol_st > 0 {
                lstr = ilen(&chinsert);
                chinsert = fstr(36, &chinsert.sub(1, lstr).cat(&c.chcol.sub(s.lchcol_st, s.lchcol)).as_str());
            }
            lstr = ilen(&chinsert);
            chinsert = fstr(36, &chinsert.sub(1, lstr).cat(&chidcol.sub(1, lidcol)).as_str());
            let linsert = ilen(&chinsert);

            let ins = chinsert.sub(1, linsert);
            if self.c.lcoord > 0 {
                let sp = self.s_control.splcoo.clone();
                let f = self.insert_name(&sp, &ins, CHSUBP)?;
                self.c.filcoo.set_f(&f);
            }
            if self.c.lcoraw > 0 {
                let sp = self.s_control.splcor.clone();
                let f = self.insert_name(&sp, &ins, CHSUBP)?;
                self.c.filcor.set_f(&f);
            }
            if self.c.lprint > 0 {
                let sp = self.s_control.splpri.clone();
                let f = self.insert_name(&sp, &ins, CHSUBP)?;
                self.c.filpri.set_f(&f);
            }
            if self.c.lps > 0 {
                let sp = self.s_control.splps.clone();
                let f = self.insert_name(&sp, &ins, CHSUBP)?;
                self.c.filps.set_f(&f);
            }
            if self.c.ltable > 0 {
                let sp = self.s_control.spltab.clone();
                let f = self.insert_name(&sp, &ins, CHSUBP)?;
                self.c.filtab.set_f(&f);
            }
        }
        if self.c.skip_voxel {
            // Temporarily prevent opening output files and return. LPS is left
            // unchanged (it would only be produced on an error exit).
            self.c.lcoord = 0;
            self.c.lcoraw = 0;
            self.c.lprint = 0;
            self.c.ltable = 0;
            return Ok(());
        }
        // NLIN = 16384.
        if self.c.nratio_used > 0 {
            self.c.nlin = 4 * self.c.nlin + 8192;
        } else {
            self.c.nlin = 4 * self.c.nlin + 16384;
        }
        // Split TITLE into TITLE_LINE(1) & TITLE_LINE(2).
        self.split_title();
        let jowner = ilen(&self.c.ownout);
        let jdate = ilen(&self.c.chdate);
        let jversi = self.c.versio.index("Copyright") - 2;
        jtitle[1] = ilen(&self.c.title_line[1]);
        jtitle[2] = ilen(&self.c.title_line[2]);
        if self.c.lprint > 0 {
            let lprint = self.c.lprint;
            if !self.c.filpri.is_blank() {
                let name = self.c.filpri.trim();
                self.io.open_new(lprint, &name);
            }
            let c = &self.c;
            if c.nlines_title == 1 {
                let v = fv![&c.versio, c.title_line[1].sub(1, jtitle[1]), c.ownout.sub(1, jowner), c.chdate.sub(1, jdate)];
                self.io.write(lprint, "(///10X,A//1X,A//1X,A//1X,A////)", &v);
            } else {
                let v = fv![&c.versio, c.title_line[1].sub(1, jtitle[1]), c.title_line[2].sub(1, jtitle[2]), c.ownout.sub(1, jowner), c.chdate.sub(1, jdate)];
                self.io.write(lprint, "(///10X,A//1X,A/1x,a//1X,A//1X,A////)", &v);
            }
            if self.c.mermes == 8000 {
                self.c.mermes = MMERMS;
                self.write_nml(lprint, "LCMODL", NML_LCMODL);
            } else {
                self.write_nml(lprint, "LCMODeL", NML_LCMODEL);
            }
        }
        if self.c.lcoord > 0 {
            let lcoord = self.c.lcoord;
            if !self.c.filcoo.is_blank() {
                let name = self.c.filcoo.trim();
                self.io.open_new(lcoord, &name);
            }
            let c = &self.c;
            let mut v = fv![&c.versio];
            for j in 1..=c.nlines_title {
                v.push(FVal::from(c.title_line[j].sub(1, jtitle[j as usize])));
            }
            self.io.write(lcoord, "(1X, A)", &v);
        }
        if self.c.lcoraw > 0 {
            let lcoraw = self.c.lcoraw;
            if !self.c.filcor.is_blank() {
                let name = self.c.filcor.trim();
                self.io.open_new(lcoraw, &name);
            }
        }
        if self.c.ltable > 0 {
            let ltable = self.c.ltable;
            if !self.c.filtab.is_blank() {
                let name = self.c.filtab.trim();
                self.io.open_new(ltable, &name);
            }
            let c = &self.c;
            let mut v = fv![c.versio.sub(1, jversi)];
            for j in 1..=c.nlines_title {
                v.push(FVal::from(c.title_line[j].sub(1, jtitle[j as usize])));
            }
            self.io.write(ltable, "(1X, A)", &v);
        }
        // NPAR = 20.
        if self.c.ldwfft > 0 {
            self.c.npar = 2 * self.c.npar + 40;
        } else {
            self.c.npar = self.c.npar + 20;
        }
        Ok(())
    }

    /// `FIL = SPLIT(1)(:LSPLIT1) // CHINSERT(:LINSERT) // SPLIT(2)(:LSPLIT2)`
    /// with the MCHFIL check of OPEN_OUTPUT.
    fn insert_name(&mut self, split: &[FStr; 2], ins: &FStr, chsubp: &str) -> R<FStr> {
        let lsplit1 = ilen(&split[0]);
        let lsplit2 = ilen(&split[1]);
        if lsplit1 + ins.len() as i32 + lsplit2 > MCHFIL {
            self.errmes(1, 4, chsubp)?;
        }
        Ok(split[0].sub(1, lsplit1).cat(ins).cat(&split[1].sub(1, lsplit2)))
    }

    /// `WRITE (U, NML=GROUP)`.
    fn write_nml(&mut self, unit: i32, group: &str, names: &[&str]) {
        let members: Vec<(&str, NmlOut)> = names.iter().map(|n| (*n, nml_member(&self.c, n))).collect();
        let recs = nml_write_records(group, &members);
        self.io.write_records(unit, recs);
    }

    // ------------------------------------------------------------------------
    // SPLIT_TITLE
    // ------------------------------------------------------------------------

    /// Split TITLE into TITLE_LINE(1) & TITLE_LINE(2); TITLE_LINE(1), after
    /// escaping in STRCHK, will not have more than 122 characters.
    fn split_title(&mut self) {
        let c = &mut self.c;
        let ltitle = ilen(&c.title);
        // STRCHK can at most double the number of characters.
        if c.ntitle == 1 || ltitle <= 61 {
            c.nlines_title = 1;
            let t = c.title.clone();
            c.title_line[1].set_f(&t);
            return;
        }
        let mut iend_line1 = ltitle.min(122);
        // NESCAPE1 = extra escape characters that will be added to BUFOUT.
        let mut nescape = 0;
        let mut nescape1 = 0;
        for i in 1..=ltitle {
            let ch = c.title.at(i);
            if ch == b'(' || ch == b')' || ch == b'%' || ch == b'\\' {
                nescape = nescape + 1;
                if i <= iend_line1 {
                    nescape1 = nescape1 + 1;
                }
            }
        }
        if ltitle + nescape <= 122 {
            c.nlines_title = 1;
            let t = c.title.clone();
            c.title_line[1].set_f(&t);
            return;
        }
        // Go backwards on TITLE_LINE(1) to find a space for a break.
        let max_back = 244 - ltitle - nescape;
        iend_line1 = iend_line1 - nescape1;
        let mut ibreak = iend_line1;
        let mut istart2 = iend_line1 + 1;
        for i in fdo(iend_line1, 4.max(iend_line1 - max_back), -1) {
            if c.title.at(i) == b' ' {
                ibreak = i - 1;
                istart2 = i + 1;
                break;
            }
        }
        // Label 150.
        c.nlines_title = 2;
        let t1 = c.title.sub(1, ibreak);
        let t2 = c.title.sub(istart2, ltitle);
        c.title_line[1].set_f(&t1);
        c.title_line[2].set_f(&t2);
    }

    // ------------------------------------------------------------------------
    // LOADCH
    // ------------------------------------------------------------------------

    /// Loads changes input in standard input into CHANGE for later output.
    pub fn loadch(&mut self) -> R<()> {
        const CHSUBP: &str = "LOADCH";
        let dollar = b'$';
        let mut ch = FStr::blank(MCHLIN as usize);
        let mut chlong = FStr::blank(MCH_LINE_LONG as usize);
        let mut line = FStr::blank(MCH_LINE_LONG as usize);
        let mut line_compact = FStr::blank(MCH_LINE_LONG as usize);
        let mut atend;
        if self.c.mermes > MMERMS {
            self.errmes(1, 3, CHSUBP)?;
            self.c.mermes = MMERMS;
        }
        // NLIN = 4 * 16384 - 1 = 65535.
        if self.c.lwfft > 0 {
            self.c.nlin = 2 * self.c.nlin - 3;
        } else {
            self.c.nlin = 4 * self.c.nlin - 1;
        }
        let scratch = self.c.lcontr_scratch;
        let ucase = |b: u8| b.to_ascii_uppercase();
        for jpage in 1..=2 {
            // Put NCHLIN within the limits fixed below.
            self.c.nchlin[jpage] = MCHLIN.min(30.max(self.c.nchlin[jpage]));
            let nchlin = self.c.nchlin[jpage];
            self.io.rewind(scratch);
            atend = false;
            self.c.linchg[jpage] = 0;
            let mut l = 0;
            'l120: {
                for jline in 1..=9999 {
                    match self.io.read_line(scratch) {
                        Ok(t) => line.set(&t),
                        Err(_) => return self.errmes(2, 4, CHSUBP),
                    }
                    l = line.index("$");
                    if l >= 1 && l <= MCH_LINE_LONG - 6 {
                        let w: Vec<u8> = (1..=6).map(|k| ucase(line.at(l + k))).collect();
                        if w == b"LCMODL" {
                            break 'l120;
                        }
                    }
                }
                return Ok(());
            }
            // $LCMODL has been found; $ is at position L.
            let mut lend = ilen(&line);
            'l200: {
                for jline in 1..=MLINES {
                    if jline > 1 || l + 6 == lend {
                        match self.io.read_line(scratch) {
                            Ok(t) => line.set(&t),
                            Err(_) => break 'l200,
                        }
                    }
                    if ilen(&line) <= 1 && line.at(1) == b' ' {
                        continue;
                    }
                    let len_compact = compact_string(&line, &mut line_compact);
                    if self.c.ldump[3] {
                        let j = ilen(&line);
                        self.io.write(6, "(5x, a/ i3, 2x, a/)", &fv![line.sub(1, j), len_compact, line_compact.sub(1, len_compact)]);
                    }
                    let keys = ["TITLE=", "title=", "Title=", "OWNER=", "owner=", "Owner=", "KEY=", "key=", "Key="];
                    if keys.iter().map(|k| line_compact.index(k)).max().unwrap_or(0) > 0 {
                        continue;
                    }
                    if line.index("/.lcmodel/temp/") > 0 {
                        let f = ["filcoo=", "filh2o=", "filpri=", "filps=", "filraw=", "filtab=", "filcor=", "filcsv=", "lcsi_sav", "filcsi_sav"];
                        if f.iter().map(|k| line.index(k)).max().unwrap_or(0) > 0 {
                            continue;
                        }
                    }
                    l = line.index("$");
                    if l >= 1 && l <= MCH_LINE_LONG - 3 {
                        let w: Vec<u8> = (1..=3).map(|k| ucase(line.at(l + k))).collect();
                        if w == b"END" {
                            if l <= 2 {
                                break 'l200;
                            }
                            chlong.set_f(&line.sub(1, l - 1));
                            if ilen(&chlong) <= 1 {
                                break 'l200;
                            }
                            line.set_f(&chlong);
                            atend = true;
                        }
                    }
                    lend = ilen(&line);
                    if lend <= 1 && line.at(1) == b' ' {
                        continue;
                    }
                    let nparts = if lend <= nchlin { 1 } else { (lend - nchlin - 1) / (nchlin - 3) + 2 };
                    self.c.linchg[jpage] = self.c.linchg[jpage] + nparts;
                    if self.c.linchg[jpage] > MLINES {
                        break 'l200;
                    }
                    let linchg = self.c.linchg[jpage];
                    let mut lstop = nchlin.min(lend);
                    self.c.change[(linchg, jpage)].set_f(&line.sub(1, lstop));
                    for jchg in fdo(linchg - 1, linchg - nparts + 1, -1) {
                        let lstart = lstop + 1;
                        lstop = lend.min(lstart + nchlin - 4);
                        self.c.change[(jchg, jpage)].set_f(&FStr::lit("   ").cat(&line.sub(lstart, lstop)));
                    }
                    if atend {
                        break 'l200;
                    }
                }
            }
            // Label 200: reverse order in CHANGE.
            let mut k = self.c.linchg[jpage];
            for j in 1..=self.c.linchg[jpage] / 2 {
                ch.set_f(&self.c.change[(k, jpage)]);
                let cj = self.c.change[(j, jpage)].clone();
                self.c.change[(k, jpage)].set_f(&cj);
                self.c.change[(j, jpage)].set_f(&ch);
                k = k - 1;
            }
        }
        // NPAR = 2 * 20 + 10 = 50.
        if self.c.lwfft > 0 {
            self.c.npar = 3 * self.c.npar + 40;
        } else {
            self.c.npar = 2 * self.c.npar + 10;
        }
        if self.c.lprint > 0 {
            let mut v = Vec::new();
            for j in 1..=self.c.linchg[2] {
                v.push(FVal::from(&self.c.change[(j, 2)]));
            }
            let lprint = self.c.lprint;
            self.io.write(lprint, "(/// 10X, 'Input changes to Control Variables'/ (1X,A))", &v);
        }
        Ok(())
    }

    // ------------------------------------------------------------------------
    // ERRMES
    // ------------------------------------------------------------------------

    /// Prints an error message and, if |ILEVEL| = 4 or 5, aborts (first calling
    /// EXITPS if ILEVEL > 0). |ILEVEL| = 1 information, 2 warning, 3 non-fatal
    /// error, 4 fatal error, 5 illogical stop; ILEVEL < 0 means EXITPS cannot be
    /// called (the message goes to LPRINT only).
    pub fn errmes(&mut self, number: i32, ilevel: i32, chsubp: &str) -> R<()> {
        let chsubp6 = fstr(6, chsubp);
        'l120: {
            for jerr in 1..=self.c.linerr {
                let c = &mut self.c;
                if c.cherr[jerr].eq_f(&chsubp6) && c.ierrno[jerr] == number && c.leverr[jerr] == ilevel {
                    c.nerror[jerr] = c.nerror[jerr] + 1;
                    break 'l120;
                }
            }
            // Normal case.
            let c = &mut self.c;
            c.linerr = c.linerr + 1;
            let l = c.linerr;
            c.nerror[l] = 1;
            c.cherr[l].set_f(&chsubp6);
            c.ierrno[l] = number;
            c.leverr[l] = ilevel;
        }
        // Label 120: illogical stop.
        let lprint = self.c.lprint;
        if ilevel.abs() < 1 || ilevel.abs() > 5 {
            let f5000 = "(/' Illogical Stop In ERRMES.  ',A6,I3)";
            if lprint > 0 {
                self.io.write(lprint, f5000, &fv![&chsubp6, number]);
            }
            self.io.write(STDOUT, f5000, &fv![&chsubp6, number]);
            let c = &mut self.c;
            c.linerr = c.linerr + 1;
            let l = c.linerr;
            c.nerror[l] = 1;
            c.cherr[l].set("ERRMES");
            c.ierrno[l] = 1;
            c.leverr[l] = 5;
            let msg = format!("ILLOGICAL STOP {} {}", chsubp6.trim(), number);
            if ilevel < 0 {
                self.write_5050(ilevel, &chsubp6, number);
                return stop(msg);
            }
            return self.exitps_stop(msg);
        }
        // Normal case.
        let et = ertype(ilevel.abs());
        if lprint > 0 {
            self.io.write(lprint, "(1X,A15,2X,A6,I3,'.   (Check LCModel Manual).  ',36(2H**)/)", &fv![&et, &chsubp6, number]);
        }
        self.c.nermes = self.c.nermes + 1;
        // Maximum error messages.
        if self.c.nermes >= self.c.mermes {
            if lprint > 0 {
                let m = self.c.mermes;
                self.io.write(lprint, "(//' Stopping after',I5,' diagnostic messages.')", &fv![m]);
            }
            let c = &mut self.c;
            c.linerr = c.linerr + 1;
            let l = c.linerr;
            c.nerror[l] = 1;
            c.cherr[l].set("ERRMES");
            c.ierrno[l] = 2;
            c.leverr[l] = 4;
            let msg = format!("FATAL ERROR ERRMES 2 (stopping after {} diagnostic messages; last: {} {} {})", self.c.mermes, et.as_str().trim(), chsubp6.trim(), number);
            if ilevel < 0 {
                self.write_5050(ilevel, &chsubp6, number);
                return stop(msg);
            }
            return self.exitps_stop(msg);
        }
        // Abort on FATAL.
        if ilevel.abs() >= 4 {
            let msg = format!("{} {} {}", et.as_str().trim(), chsubp6.trim(), number);
            if ilevel < 0 {
                self.write_5050(ilevel, &chsubp6, number);
                return stop(msg);
            }
            return self.exitps_stop(msg);
        }
        Ok(())
    }

    /// FORMAT 5050 of ERRMES, on LPRINT and standard output.
    fn write_5050(&mut self, ilevel: i32, chsubp6: &FStr, number: i32) {
        let f5050 = "('***  ',A15,2X,A6,I3,/ '     This error occurred before the plot could ', 'be produced.'/ '     See the Diagnostics list in the LCModel ', 'Manual.  ***')";
        let et = ertype(ilevel.abs());
        let lprint = self.c.lprint;
        if lprint > 0 {
            self.io.write(lprint, f5050, &fv![&et, chsubp6, number]);
        }
        self.io.write(STDOUT, f5050, &fv![&et, chsubp6, number]);
    }

    /// `CALL EXITPS (.TRUE.)`: EXITPS ends with STOP, reported as `msg`.
    fn exitps_stop(&mut self, msg: String) -> R<()> {
        match self.exitps(true) {
            Err(e) if e.message != "STOP" => Err(e),
            _ => stop(msg),
        }
    }

    // ------------------------------------------------------------------------
    // INITIA
    // ------------------------------------------------------------------------

    /// Initialization at start of run (DELPPM, PPM, gaps, PRECIS, ...).
    pub fn initia(&mut self) -> R<()> {
        const CHSUBP: &str = "INITIA";
        self.c.pi = 3.141592654f64 as f32;
        self.c.radian = self.c.pi / 180.0;
        self.c.ndata = 2 * self.c.nunfil;
        self.c.fndata = self.c.ndata as f32;
        // NLIN = 65535 + 14 = 65549.
        if self.c.ldwfft > 0 {
            self.c.nlin = 2 * self.c.nlin + 15;
        } else {
            self.c.nlin = self.c.nlin + 14;
        }
        self.c.ppminc = self.c.deltat * self.c.fndata * self.c.hzpppm;
        if self.c.ppminc <= 0.0 {
            self.errmes(1, 4, CHSUBP)?;
        }
        self.c.ppminc = 1.0 / self.c.ppminc;
        if self.c.ppminc <= 0.0 || self.c.nunfil > MUNFIL {
            if self.c.lprint > 0 {
                let j = MUNFIL;
                let lprint = self.c.lprint;
                let nunfil = self.c.nunfil;
                self.io.write(lprint, "(//' NUNFIL =', I6, ';   it cannot exceed', I6/)", &fv![nunfil, j]);
            }
            self.errmes(2, 4, CHSUBP)?;
        }
        {
            let c = &mut self.c;
            c.ldatst = nint((c.ppmcen - c.ppmst) / c.ppminc) + 1 + c.nunfil;
            c.ldaten = nint((c.ppmcen - c.ppmend) / c.ppminc) + 1 + c.nunfil;
            c.ny = c.ldaten - c.ldatst + 1;
        }
        if self.c.ldatst <= 0 || self.c.ldaten > self.c.ndata {
            self.errmes(3, 4, CHSUBP)?;
        }
        if self.c.ldatst >= self.c.ldaten || self.c.ny > MY {
            self.errmes(4, 4, CHSUBP)?;
        }
        {
            let c = &mut self.c;
            c.delppm[1] = -c.ppminc * (c.ldatst - 1 - c.nunfil) as f32;
            c.ppm[1] = c.ppmst;
            for jy in 2..=c.ny {
                c.delppm[jy] = c.delppm[jy - 1] - c.ppminc;
                c.ppm[jy] = c.ppm[jy - 1] - c.ppminc;
            }
        }
        // Count & order PPMGAP (in the usual descending order in ppm).
        // LCY_SKIP(JY) = T if CY(JY) is to be skipped because it is in a gap.
        self.c.ngap = 0;
        for jgap in 1..=MGAP {
            let gmax = self.c.ppmgap[(1, jgap)].max(self.c.ppmgap[(2, jgap)]);
            if gmax > 9.0e36 {
                break;
            }
            self.c.ngap = self.c.ngap + 1;
            let gmin = self.c.ppmgap[(1, jgap)].min(self.c.ppmgap[(2, jgap)]);
            self.c.ppmgap[(1, jgap)] = gmax;
            self.c.ppmgap[(2, jgap)] = gmin;
            if jgap > 1 {
                if gmax >= self.c.ppmgap[(2, jgap - 1)] {
                    self.errmes(9, 4, CHSUBP)?;
                }
            }
            let c = &mut self.c;
            for jy in 1..=c.ny {
                c.lcy_skip[jy] = c.lcy_skip[jy] || (c.ppm[jy] <= gmax && c.ppm[jy] >= gmin);
            }
        }
        // Label 115. NYUSE = # points in Analysis Window actually used; compact
        // PPM with the gaps removed.
        {
            let c = &mut self.c;
            c.nyuse = 0;
            for jy in 1..=c.ny {
                if c.lcy_skip[jy] {
                    continue;
                }
                c.nyuse = c.nyuse + 1;
                let n = c.nyuse;
                c.ppm[n] = c.ppm[jy];
            }
        }
        if self.c.nyuse < 64 {
            self.errmes(8, 3, CHSUBP)?;
        }
        // Convert SDMSHF from ppm to radians/s.
        {
            let c = &mut self.c;
            c.sdmshf = c.sdmshf * 2.0 * c.pi * c.hzpppm;
            c.alog2 = 2.0f32.ln();
            c.tofwhm = (4.0 * c.alog2).sqrt() / (c.pi * c.hzpppm);
            // NPAR = 2 * 50 + 20 = 120.
            if c.ldwfft > 0 {
                c.npar = 4 * c.npar + 60;
            } else {
                c.npar = 2 * c.npar + 20;
            }
        }
        self.c.precis = 1.0e-6;
        'l125: {
            for j in 1..=100 {
                if diff(1.0 + self.c.precis, 1.0) <= 0.0 {
                    break 'l125;
                }
                self.c.precis = 0.1 * self.c.precis;
            }
            self.errmes(5, 5, CHSUBP)?;
        }
        self.c.precis = 100.0 * self.c.precis;
        if self.c.lprint > 0 {
            let lprint = self.c.lprint;
            let c = &self.c;
            let v = fv![c.ppminc, c.nyuse, c.precis];
            self.io.write(lprint, "(///10X, ' Other quantities'/ ' PPMINC =', 1PE10.3/ ' NY =', I5/ ' PRECIS =', E9.2)", &v);
        }
        if self.c.precis >= 0.99e-10 {
            self.errmes(6, 2, CHSUBP)?;
        }
        if self.c.precis >= 0.99e-5 {
            self.errmes(7, 4, CHSUBP)?;
        }
        Ok(())
    }

    // ------------------------------------------------------------------------
    // DATAIN
    // ------------------------------------------------------------------------

    /// Gets the time-domain data (MYDATA), makes absolute-value spectra when
    /// ABSVAL, computes DATAF (FTDATA) and runs the (disabled) license test.
    pub fn datain(&mut self) -> R<()> {
        const CHSUBP: &str = "DATAIN";
        let _ = CHSUBP;
        let mut ldev: FArr1<i32> = FArr1::new(MDEV as usize);
        let mut ldevx: FArr1<i32> = FArr1::new(MDEVX as usize);
        let mut idevx = 0i32;
        let mut knum3 = 0i32;
        let mut knum2 = 0i32;
        // Get time-domain data, scale them, and get non-H2O-suppressed data.
        if self.c.iaverg <= 0 {
            self.mydata()?;
        }
        // ISTAGO = 1 when DATAT is loaded with time-domain data.
        self.c.istago = 1;
        if self.c.skip_voxel {
            return Ok(());
        }
        // Absolute-value spectra. Zero-filling avoids huge high-frequency
        // oscillations; 2*CABS compensates for discarding the 2nd half; the 1st
        // point is halved to remove the offset (Notes of 010819).
        if self.c.absval {
            let c = &mut self.c;
            for j in (c.nunfil + 1)..=c.ndata {
                c.datat[j] = cmplx(0.0, 0.0);
            }
            cfft(&c.datat.data, &mut c.dataf.data, c.ndata, &mut c.lwfft, &mut c.wfftc.data);
            for j in 1..=c.ndata {
                c.dataf[j] = cmplx(2.0 * c.dataf[j].abs(), 0.0);
            }
            cfftin(&c.dataf.data, &mut c.datat.data, c.ndata, &mut c.lwfft, &mut c.wfftc.data);
            c.datat[1] = c.datat[1] * 0.5;
        }
        self.ftdata(0)?;
        'l200: {
            'l195: {
                // Skip license tests with Intel Windows version & dongle.
                if self.c.nlin > 0 {
                    break 'l200;
                }
                // Check for Master KEY.
                if self.c.key[1] == 210387309 {
                    break 'l200;
                }
                self.c.lline = false;
                self.c.noline = false;
                // The numerical year & month below should be updated to foil backdating.
                if self.c.knum[3] < 100 {
                    self.c.knum[3] = self.c.knum[3] + 2000;
                }
                if self.c.knum[3] < 2018 || (self.c.knum[3] == 2018 && self.c.knum[2] < 7) {
                    break 'l195;
                }
                // HAVLIN=T if a valid Linux license was found; skip a 2nd test.
                if self.s_control.havlin {
                    break 'l200;
                }
                for j in 1..=MDEVX {
                    ldevx[j] = -2;
                }
                let ndevx = 999999;
                if self.c.nlin > 0 {
                    // LETT = 0 for a valid license (GETFFT is not called).
                    let len_owner = 0;
                    if len_owner > 0 {
                        let ownout = self.c.owner.sub(1, len_owner).cat_str(" ");
                        self.c.ownout.set_f(&ownout);
                        let o = self.c.ownout.clone();
                        self.c.owner.set_f(&o);
                        let o = FStr::lit("Data of: ").cat(&self.c.owner.sub(1, len_owner));
                        self.c.ownout.set_f(&o);
                        let jowner = ilen(&self.c.ownout);
                        let jdate = ilen(&self.c.chdate);
                        let v = fv![self.c.ownout.sub(1, jowner), self.c.chdate.sub(1, jdate)];
                        if self.c.ltable > 0 {
                            let u = self.c.ltable;
                            self.io.write(u, "(1x, a)", &v);
                        }
                        if self.c.lcoord > 0 {
                            let u = self.c.lcoord;
                            self.io.write(u, "(1x, a)", &v);
                        }
                    }
                    // LDEVX has only MDEVX elements; the Fortran reads past them.
                    for j in 1..=ndevx.min(MDEVX) {
                        if idevx == ldevx[j] {
                            self.c.lett = 40;
                        }
                    }
                    if self.c.lett == 0 {
                        if self.c.knum[3] > knum3 || (self.c.knum[3] == knum3 && self.c.knum[2] > knum2) {
                            self.c.lett = 50;
                        }
                    }
                    self.s_control.havlin = self.c.lett == 0;
                    if self.s_control.havlin {
                        break 'l200;
                    }
                } else {
                    let ndev = 1;
                    let l = 0;
                    ldev[1] = l;
                    // Initialize LDEV1 to only output NDEV LDEV1 values.
                    for jdev in 2..=MDEV {
                        self.c.ldev1[jdev] = -1;
                    }
                    for jdev in 1..=ndev {
                        self.c.ldev1[jdev] = igetp(34481 + ldev[jdev].abs(), 35);
                        // Reject license if LDEV1 is on blacklist in LDEVX.
                        for jdevx in 1..=ndevx.min(MDEVX) {
                            if self.c.ldev1[jdev] == ldevx[jdevx] {
                                break 'l195;
                            }
                        }
                        ldev[jdev] = self.c.ldev1[jdev];
                        // Modify LDEV(JDEV) with OWNER info.
                        for j in 1..=ilen(&self.c.owner) {
                            ldev[jdev] = ldev[jdev] - (j + 9) * self.c.owner.at(j) as i32;
                        }
                        ldev[jdev] = ldev[jdev].abs();
                        // Test LDEV(JDEV) for lifetime license.
                        let k = igetp(ldev[jdev] + 8829, 59);
                        for j in 1..=MKEY {
                            if self.c.key[j] == k {
                                break 'l200;
                            }
                        }
                        // Test host identification number for the next 25 months.
                        let mut kj = 100 * (self.c.knum[3] - 1997);
                        let mut km = self.c.knum[2] - 1;
                        'l191: for jpar in 1..=25 {
                            km = km + 1;
                            if km > 12 {
                                km = km - 12;
                                kj = kj + 100;
                            }
                            let k = igetp(ldev[jdev] + (kj + km) * 3678, 41);
                            for j in 1..=MKEY {
                                if self.c.key[j] == 0 {
                                    continue 'l191;
                                }
                                if self.c.key[j] == k {
                                    break 'l200;
                                }
                            }
                        }
                    }
                }
            }
            // Label 195: there is no license. Check if this is demo data.
            let c = &mut self.c;
            c.noline = true;
            let mut ppm1 = 3.4f32;
            let mut ppm2 = 2.8f32;
            let mut suml = 0.0f32;
            for j in (nint((4.65 - ppm1) / c.ppminc) + 1 + c.nunfil)..=(nint((4.65 - ppm2) / c.ppminc) + 1 + c.nunfil) {
                suml = suml.max(c.dataf[j].abs());
            }
            ppm1 = 2.8;
            ppm2 = 2.2;
            let mut summ = 0.0f32;
            for j in (nint((4.65 - ppm1) / c.ppminc) + 1 + c.nunfil)..=(nint((4.65 - ppm2) / c.ppminc) + 1 + c.nunfil) {
                summ = summ.max(c.dataf[j].abs());
            }
            ppm1 = 2.2;
            ppm2 = 1.8;
            let mut sumr = 0.0f32;
            for j in (nint((4.65 - ppm1) / c.ppminc) + 1 + c.nunfil)..=(nint((4.65 - ppm2) / c.ppminc) + 1 + c.nunfil) {
                sumr = sumr.max(c.dataf[j].abs());
            }
            let mut test = suml - summ;
            c.lline = test.abs() <= 0.0;
            if !c.lline {
                test = (sumr - summ) / test;
                c.lline = test < 2.16 || test > 2.17;
            }
            // LLINE = T aborts the run (no license, not the Test Data):
            // FNDATA = 0 makes MYBASI abort.
            if c.lline {
                c.fndata = 0.0;
            }
        }
        // Label 200.
        Ok(())
    }

    // ------------------------------------------------------------------------
    // MYDATA
    // ------------------------------------------------------------------------

    /// Reads the NUNFIL complex time-domain data into DATAT and scales them;
    /// reads the non-H2O-suppressed data into H2OT; ECC if DOECC.
    fn mydata(&mut self) -> R<()> {
        const CHSUBP: &str = "MYDATA";
        let mut v = Nmid::new();
        let mut seq = FStr::blank(5);
        let lraw = self.c.lraw;
        if self.c.voxel1 {
            // If not present in SEQPAR, echot_raw = -1. and seq_raw = ' '.
            let hzpppm_sav = self.c.hzpppm;
            self.c.hzpppm = -1.0;
            seq.set(" ");
            self.c.echot = -1.0;
            if let Ok(nml) = self.io.read_nml(lraw, "SEQPAR") {
                for it in &nml.items {
                    let r = match it.name.as_str() {
                        "hzpppm" => self.c.hzpppm.nml_assign(&it.subs, &it.values),
                        "echot" => self.c.echot.nml_assign(&it.subs, &it.values),
                        "seq" => seq.nml_assign(&it.subs, &it.values),
                        other => Err(format!("{other} is not a variable of namelist SEQPAR")),
                    };
                    if r.is_err() {
                        break;
                    }
                }
            }
            // Label 102.
            self.io.rewind(lraw);
            if self.c.hzpppm > 0.0 {
                if (hzpppm_sav / self.c.hzpppm - 1.0).abs() > 0.05 {
                    self.errmes(4, 2, CHSUBP)?;
                }
            }
            self.c.hzpppm = hzpppm_sav;
            self.c.echot_raw = self.c.echot;
            self.c.seq_raw.set_f(&seq);
        }
        if self.c.voxel1 || self.c.lraw_at_top {
            // Read NMID.
            v.tramp = 1.0;
            v.volume = 1.0;
            v.id.set(" ");
            v.fmtdat.set(" ");
            v.bruker = false;
            v.seqacq = false;
            if !read_nmid(&mut self.io, lraw, &mut v) {
                return self.mydata_err(807);
            }
            self.s_control.id.set_f(&v.id);
            if v.fmtdat.is_blank() {
                self.errmes(1, 4, CHSUBP)?;
            }
            self.s_control.fmtdat_raw.set_f(&v.fmtdat);
            self.s_control.bruker_raw = v.bruker;
            self.s_control.seqacq_raw = v.seqacq;
        }
        let fmt = self.s_control.fmtdat_raw.trim();
        let nunfil = self.c.nunfil;
        if !read_complex(&mut self.io, lraw, &fmt, nunfil, &mut self.c.datat) {
            return self.mydata_err(808);
        }
        if self.c.lprint > 0 {
            let lprint = self.c.lprint;
            let c = &self.c;
            if c.nlines_title == 1 {
                self.io.write(lprint, "(1X,A//' Data set ID = ',A////)", &fv![&c.title_line[1], &self.s_control.id]);
            } else {
                self.io.write(lprint, "(1X,A/1x,a//' Data set ID = ',A////)", &fv![&c.title_line[1], &c.title_line[2], &self.s_control.id]);
            }
        }
        // TRAMP and VOLUME (transmitter amplitude and VOI) scale the spectra
        // for absolute concentrations; they default to 1.
        if self.c.voxel1 {
            if v.tramp.min(v.volume).min(self.c.fcalib) <= 0.0 {
                self.errmes(2, 4, CHSUBP)?;
            }
            self.s_control.scale_raw = self.c.fcalib * v.tramp / v.volume;
        }
        'l190: {
            if self.c.skip_voxel {
                break 'l190;
            }
            let scale_raw = self.s_control.scale_raw;
            let c = &mut self.c;
            for jdata in 1..=c.nunfil {
                c.datat[jdata] = c.datat[jdata] * scale_raw;
            }
            if c.fwhmsm > 0.0 {
                let rsd = c.pi * c.fwhmsm * c.deltat * c.hzpppm / (2.0 * 2.0f32.ln()).sqrt();
                for junfil in 1..=c.nunfil {
                    let t = rsd * (junfil - 1) as f32;
                    c.datat[junfil] = c.datat[junfil] * (-(0.5 * (t * t))).exp();
                }
            }
            if self.s_control.seqacq_raw {
                seqtot(&mut c.datat.data, &mut c.dataf.data, c.nunfil, &mut c.lwfft, &mut c.wfftc.data);
            } else if self.s_control.bruker_raw {
                for jdata in 1..=c.nunfil {
                    c.datat[jdata] = c.datat[jdata].conj();
                }
            }
            if self.c.smtail {
                let mut d = std::mem::take(&mut self.c.datat);
                self.smooth_tail(&mut d);
                self.c.datat = d;
            }
        }
        // Label 190.
        self.c.havh2o = false;
        'l800: {
            if !self.c.filh2o.is_blank() {
                let lh2o = self.c.lh2o;
                if self.c.voxel1 {
                    // Read time-domain non-H2O-suppressed data into H2OT.
                    let name = self.c.filh2o.trim();
                    if !self.io.open_old(lh2o, &name) {
                        break 'l800;
                    }
                }
                if self.c.voxel1 || self.c.lraw_at_top {
                    v.fmtdat.set(" ");
                    v.bruker = false;
                    v.seqacq = false;
                    if !read_nmid(&mut self.io, lh2o, &mut v) {
                        return self.mydata_err(809);
                    }
                    // ID (SAVEd) is also a member of the water file's NMID.
                    self.s_control.id.set_f(&v.id);
                    if v.fmtdat.is_blank() {
                        self.errmes(3, 4, CHSUBP)?;
                    }
                    self.s_control.fmtdat_h2o.set_f(&v.fmtdat);
                    self.s_control.bruker_h2o = v.bruker;
                    self.s_control.seqacq_h2o = v.seqacq;
                }
                let fmt = self.s_control.fmtdat_h2o.trim();
                if !read_complex(&mut self.io, lh2o, &fmt, nunfil, &mut self.c.h2ot) {
                    return self.mydata_err(810);
                }
                self.c.havh2o = true;
                if self.c.voxel1 {
                    if v.tramp.min(v.volume) <= 0.0 {
                        // This could cause an error in water-scaling, if
                        // water-reference & suppressed TRAMP & VOLUME do not match.
                        if self.c.dows {
                            self.errmes(11, 2, CHSUBP)?;
                        }
                        self.s_control.scale_h2o = self.s_control.scale_raw;
                    } else {
                        self.s_control.scale_h2o = v.tramp / v.volume;
                    }
                }
                if self.c.skip_voxel {
                    break 'l800;
                }
                let scale_h2o = self.s_control.scale_h2o;
                let c = &mut self.c;
                for jdata in 1..=c.nunfil {
                    c.h2ot[jdata] = c.h2ot[jdata] * scale_h2o;
                }
                if self.s_control.seqacq_h2o {
                    seqtot(&mut c.h2ot.data, &mut c.dataf.data, c.nunfil, &mut c.lwfft, &mut c.wfftc.data);
                } else if self.s_control.bruker_h2o {
                    for jdata in 1..=c.nunfil {
                        c.h2ot[jdata] = c.h2ot[jdata].conj();
                    }
                }
                if self.c.smtail {
                    let mut h = std::mem::take(&mut self.c.h2ot);
                    self.smooth_tail(&mut h);
                    self.c.h2ot = h;
                }
                let c = &mut self.c;
                if c.fwhmsm > 0.0 {
                    let rsd = c.pi * c.fwhmsm * c.deltat * c.hzpppm / (2.0 * 2.0f32.ln()).sqrt();
                    for junfil in 1..=c.nunfil {
                        let t = rsd * (junfil - 1) as f32;
                        c.h2ot[junfil] = c.h2ot[junfil] * (-(0.5 * (t * t))).exp();
                    }
                }
                // UNSUPR = T to use H2OT as DATAT (not with phased arrays,
                // because DOECC=F would sum incoherently).
                if c.unsupr {
                    c.doecc = false;
                    for jdata in 1..=c.nunfil {
                        c.datat[jdata] = c.h2ot[jdata];
                    }
                }
            }
            if self.c.havh2o && self.c.biglip && self.c.iaverg > 0 && !self.c.doecc {
                self.phase_with_max_real()?;
            } else if self.c.doecc_active && !self.c.doecc {
                self.c.doecc_active = false;
                self.c.sddegz = 999.0f32.min(333.0 * self.c.sddegz);
            }
            let ia = self.c.iaverg;
            if self.c.doecc && self.c.havh2o && (ia != 3 && ia != 31 && ia != 32) {
                self.ecc_truncate()?;
            }
        }
        // Label 800.
        if !self.c.havh2o && (self.c.doecc || self.c.dows) {
            self.errmes(5, 3, CHSUBP)?;
            self.c.doecc = false;
            self.c.dows = false;
        }
        if !self.c.havh2o && self.c.unsupr {
            self.errmes(12, 4, CHSUBP)?;
        }
        Ok(())
    }

    /// MYDATA's error labels 807-810 (each falls through to the next).
    fn mydata_err(&mut self, label: i32) -> R<()> {
        const CHSUBP: &str = "MYDATA";
        for (l, n) in [(807, 7), (808, 8), (809, 9), (810, 10)] {
            if label <= l {
                self.errmes(n, 4, CHSUBP)?;
            }
        }
        Ok(())
    }

    // ------------------------------------------------------------------------
    // PHASE_WITH_MAX_REAL
    // ------------------------------------------------------------------------

    /// Zero-order phase DATAT & H2OT so that the integral of the real part of
    /// H2OF from PPMST_PHALIP to PPMEND_PHALIP is maximal (H2OT assumed
    /// positive, as with lipid spectra).
    fn phase_with_max_real(&mut self) -> R<()> {
        const CHSUBP: &str = "PHALIP";
        // Account for increased uncertainty in DEGZER compared to using ECC.
        if !self.s_control.sddegz_done {
            self.s_control.sddegz_done = true;
            self.c.sddegz = 2.0 * self.c.sddegz;
        }
        // PPMINC, NDATA, FNDATA & RADIAN initialized in AVERAGE.
        {
            let c = &mut self.c;
            for jdata in (c.nunfil + 1)..=c.ndata {
                c.h2ot[jdata] = cmplx(0.0, 0.0);
            }
            csft_r(&c.h2ot.data, &mut c.h2of.data, c.ndata);
        }
        // Increment is 1 degree.
        let delta_cfact = cmplx(0.0, self.c.radian).exp();
        let mut cfact = cmplx(1.0, 0.0);
        let mut cfact_best = cfact;
        {
            let c = &mut self.c;
            c.ldatst = 1.max(nint((c.ppmcen - c.ppmst_phalip) / c.ppminc) + 1 + c.nunfil);
            c.ldaten = c.ndata.min(nint((c.ppmcen - c.ppmend_phalip) / c.ppminc) + 1 + c.nunfil);
        }
        if self.c.ldaten <= self.c.ldatst {
            self.errmes(1, 4, CHSUBP)?;
        }
        let c = &mut self.c;
        let mut sum_best = -1.0e30f32;
        let mut ldeg = -1;
        for jdeg in 0..=359 {
            let mut sum = 0.0f32;
            for jdata in c.ldatst..=c.ldaten {
                sum = sum + (c.h2of[jdata] * cfact).re;
            }
            if sum >= sum_best {
                sum_best = sum;
                cfact_best = cfact;
                ldeg = jdeg;
            }
            cfact = cfact * delta_cfact;
        }
        for junfil in 1..=c.nunfil {
            c.datat[junfil] = c.datat[junfil] * cfact_best;
            c.h2ot[junfil] = c.h2ot[junfil] * cfact_best;
        }
        Ok(())
    }

    // ------------------------------------------------------------------------
    // SMOOTH_TAIL
    // ------------------------------------------------------------------------

    /// Smooth the tail to get rid of oscillations at the end of Siemens (and
    /// sometimes Bruker) time-domain data. CDATAT = DATAT or H2OT.
    fn smooth_tail(&mut self, cdatat: &mut FArr1<C32>) {
        let nunfil = self.c.nunfil;
        let lprint = self.c.lprint;
        let voxel1 = self.c.voxel1;
        let s = &mut self.s_control;
        for j in 1..=nunfil {
            s.work_in[(j - 1) as usize] = cdatat[j].re;
        }
        smooth_tail_2(&s.work_in, &mut s.out_real, MUNFIL, nunfil, lprint, voxel1, &mut self.io);
        for j in 1..=nunfil {
            s.work_in[(j - 1) as usize] = cdatat[j].im;
        }
        smooth_tail_2(&s.work_in, &mut s.out_imag, MUNFIL, nunfil, lprint, voxel1, &mut self.io);
        for j in 1..=nunfil {
            cdatat[j] = cmplx(s.out_real[(j - 1) as usize], s.out_imag[(j - 1) as usize]);
        }
    }

    // ------------------------------------------------------------------------
    // ECC_TRUNCATE
    // ------------------------------------------------------------------------

    /// Eddy-current correction (Klose) of DATAT with H2OT, whose spectrum is
    /// first truncated at the minimum between PPM_TRUNCATE_MAX and _MIN.
    fn ecc_truncate(&mut self) -> R<()> {
        const CHSUBP: &str = "ECC";
        let mut ppminc2 = self.c.deltat * self.c.nunfil as f32 * self.c.hzpppm;
        if ppminc2 <= 0.0 {
            self.errmes(1, 4, CHSUBP)?;
        }
        ppminc2 = 1.0 / ppminc2;
        let nunfil = self.c.nunfil;
        let nunfil_half = nunfil / 2;
        if self.c.ppm_truncate_max < 0.0 || self.c.ppm_truncate_min > self.c.ppmh2o {
            for junfil in 1..=nunfil {
                self.s_control.h2ot_ecc[(junfil - 1) as usize] = self.c.h2ot[junfil];
            }
        } else {
            let lmin = int((nunfil_half + 1) as f32 + (self.c.ppmcen - self.c.ppm_truncate_max) / ppminc2);
            let lmax = int((nunfil_half + 1) as f32 + (self.c.ppmcen - self.c.ppm_truncate_min) / ppminc2);
            if lmin < 3 || lmax > self.c.ndata - 2 || lmin >= lmax {
                self.errmes(2, 4, CHSUBP)?;
            }
            {
                let c = &mut self.c;
                csft_r(&c.h2ot.data, &mut c.h2of_work.data, nunfil);
            }
            let s = &mut self.s_control;
            let c = &mut self.c;
            for j in 1..=nunfil {
                s.awork[(j - 1) as usize] = c.h2of_work[j].abs();
            }
            let aw = |j: i32| s.awork[(j - 1) as usize];
            let mut absmin = 1.0e30f32;
            let mut ltruncate = 0;
            for j in lmin..=lmax {
                // TEST = least-squares line at j (Hildebrand, p 295).
                let test = aw(j - 2) + aw(j - 1) + aw(j) + aw(j + 1) + aw(j + 2);
                if test < absmin {
                    absmin = test;
                    ltruncate = j;
                }
            }
            let ppm_truncate = c.ppmcen - (ltruncate - nunfil_half - 1) as f32 * ppminc2;
            if c.lprint > 0 {
                self.io.write(c.lprint, "(/'Truncated at ', f6.3, ' ppm for ECC')", &fv![ppm_truncate]);
            }
            for j in (ltruncate + 1)..=nunfil {
                c.h2of_work[j] = cmplx(0.0, 0.0);
            }
            csftin_r(&c.h2of_work.data, &mut s.h2ot_work, &mut s.h2ot_ecc, nunfil);
        }
        // Klose's eddy-current correction.
        let s = &self.s_control;
        let c = &mut self.c;
        for junfil in 1..=nunfil {
            let xx = s.h2ot_ecc[(junfil - 1) as usize].re;
            let yy = s.h2ot_ecc[(junfil - 1) as usize].im;
            let abssq = xx * xx + yy * yy;
            if abssq > 0.0 {
                // Zero points can occur when SEQACQ=T, only at the end of the
                // t-range, and are therefore not serious.
                c.datat[junfil] = c.datat[junfil] * cmplx(xx, -yy) / abssq.sqrt();
            }
        }
        Ok(())
    }
}

/// SMOOTH_TAIL_2: average over next neighbours as long as the zig-zag pattern
/// holds; J = point at which the pattern is broken (OUT(J) is not computed).
fn smooth_tail_2(work_in: &[f32], out: &mut [f32], munfil: i32, nunfil: i32, lprint: i32, voxel1: bool, io: &mut Units) {
    let w = |j: i32| work_in[(j - 1) as usize];
    let mut j = nunfil - 1;
    'l210: {
        while j >= 2 {
            if (w(j + 1) - w(j)) * (w(j) - w(j - 1)) > 0.0 {
                break 'l210;
            }
            out[(j - 1) as usize] = 0.5 * w(j) + 0.25 * (w(j + 1) + w(j - 1));
            j -= 1;
        }
        j = 1;
    }
    // Label 210.
    if j < nunfil - 1 {
        out[(nunfil - 1) as usize] = out[(nunfil - 2) as usize];
    } else {
        out[(nunfil - 1) as usize] = w(nunfil);
    }
    for junfil in 1..=j {
        out[(junfil - 1) as usize] = w(junfil);
    }
    if lprint > 0 && voxel1 {
        io.write(lprint, "(/i4, ' points in tail smoothed')", &fv![nunfil - j]);
    }
}

/// ERTYPE(I). Out-of-range I (only reachable for an illegal ILEVEL) gives blanks.
fn ertype(i: i32) -> FStr {
    if (1..=5).contains(&i) {
        FStr::lit(ERTYPE[(i - 1) as usize])
    } else {
        FStr::blank(15)
    }
}

/// SPLIT_FILENAME: splits FILENAME into SPLIT(1) and SPLIT(2) for insertion
/// of the voxel identifier. CHTYPE1-3 are the usual variations of the file
/// type (ps PS Ps), all LCHTYPE long.
fn split_filename(filename: &FStr, chtype1: &str, chtype2: &str, chtype3: &str, lchtype: i32, split: &mut [FStr; 2]) {
    let chtype1 = fstr(5, chtype1);
    let chtype2 = fstr(5, chtype2);
    let chtype3 = fstr(5, chtype3);
    let lfile = ilen(filename);
    let ichtype = lfile - lchtype + 1;
    // FILENAME(ICHTYPE:) and FILENAME(ICHTYPE-1:ICHTYPE-1) are outside the
    // string when ICHTYPE < 2; the Fortran then reads a byte before it.
    if ichtype >= 2 {
        let tail = filename.sub_from(ichtype);
        let m = tail.index_f(&chtype1.sub(1, lchtype)).max(tail.index_f(&chtype2.sub(1, lchtype))).max(tail.index_f(&chtype3.sub(1, lchtype)));
        if m == 1 {
            // CHTYPE is at the end of FILENAME, as it normally should be.
            let islash_dot = ichtype - 1;
            let ch = filename.at(islash_dot);
            if ch == b'/' {
                // (1) Default LCMgui FILENAME, (...)/ps -> (...)/(chinsert).ps
                split[0].set_f(&filename.sub(1, islash_dot));
                split[1].set_f(&FStr::lit(".").cat(&filename.sub_from(ichtype)));
                return;
            }
            if ch == b'.' {
                // (2) Alternate LCMgui FILENAME, (...).ps -> (...)_(chinsert).ps
                split[0].set_f(&filename.sub(1, islash_dot - 1).cat_str("_"));
                split[1].set_f(&filename.sub_from(islash_dot));
                return;
            }
        }
    }
    // (3) Exceptional FILENAME (...) -> (...)_(chinsert)
    split[0].set_f(&filename.sub(1, lfile).cat_str("_"));
    split[1].set(" ");
}

/// ICHARST: index of the first non-space character in CH(1:LCH), -1 if none.
fn icharst(ch: &FStr, lch: i32) -> i32 {
    for j in 1..=lch {
        if ch.at(j) != b' ' {
            return j;
        }
    }
    -1
}

/// CHSTRIP_INT6: IARG as a string without spaces (CHI*6) and its length LENI,
/// restricted to -99999 <= value <= 999999.
fn chstrip_int6(iarg: i32) -> (FStr, i32) {
    let mut chi = FStr::blank(6);
    let i = (-99999).max(999999.min(iarg));
    let (fmt, leni) = if i >= 0 && i <= 9 {
        ("(i1)", 1)
    } else if i >= -9 && i <= 99 {
        ("(i2)", 2)
    } else if i >= -99 && i <= 999 {
        ("(i3)", 3)
    } else if i >= -999 && i <= 9999 {
        ("(i4)", 4)
    } else if i >= -9999 && i <= 99999 {
        ("(i5)", 5)
    } else {
        ("(i6)", 6)
    };
    chi.set(&format::write_line(fmt, &fv![i]));
    (chi, leni)
}

/// COMPACT_STRING: remove all white space before, after and within STR_IN.
/// Characters of STR_OUT beyond the returned length keep their old values.
fn compact_string(str_in: &FStr, str_out: &mut FStr) -> i32 {
    let len_in = ilen(str_in);
    let mut len_out = len_in;
    str_out.set_sub_f(1, len_in, &str_in.sub(1, len_in));
    for jtest in fdo(len_in, 1, -1) {
        if str_in.at(jtest) == b' ' {
            for k in jtest..=(len_out - 1) {
                let b = str_out.at(k + 1);
                str_out.set_at(k, b);
            }
            len_out = len_out - 1;
        }
    }
    len_out
}

/// IGETP: encodes ISTART with RANDOM's recursion (L. Schrage, ACM TOMS 5, 132
/// (1979)) to produce IGETP (max. 9 digits) for hostid tests.
fn igetp(istart: i32, niter: i32) -> i32 {
    // 7**5, 2**15, 2**16, 2**31-1
    let a = 16807.0f64;
    let b15 = 32768.0f64;
    let b16 = 65536.0f64;
    let p = 2147483647.0f64;
    if istart == 8829 {
        // Special return for hostid=0.
        return 0;
    }
    let mut dix = 1.max(istart.wrapping_abs() % 2147483647) as f64;
    for jiter in 1..=1.max(niter) {
        // 15 hi order bits of DIX.
        let mut xhi = dix / b16;
        xhi = xhi - xhi % 1.0;
        // 16 lo bits of DIX and lo product.
        let xalo = (dix - xhi * b16) * a;
        // 15 hi order bits of lo product.
        let mut leftlo = xalo / b16;
        leftlo = leftlo - leftlo % 1.0;
        // The 31 highest bits of the full product.
        let fhi = xhi * a + leftlo;
        // Overflow past the 31st bit of the full product.
        let mut k = fhi / b15;
        k = k - k % 1.0;
        // Assemble all the parts and presubtract P (the parentheses are essential).
        dix = (((xalo - leftlo * b16) - p) + (fhi - k * b15) * b16) + k;
        if dix < 0.0 {
            dix = dix + p;
        }
    }
    // Multiply by 1/(2**31-1).
    dix = dix * 4.656612875e-10;
    (1.0e9 * dix) as i32
}

/// ILEN: length of ST without trailing blanks; 1 for an all-blank string.
pub fn ilen(st: &FStr) -> i32 {
    let b = st.bytes();
    let mut ilen = b.len() as i32;
    for _ in 1..=ilen.abs() {
        if b[(ilen - 1) as usize] != b' ' {
            return ilen;
        }
        ilen = ilen - 1;
    }
    1
}

/// TOUPPER_LOWER: LUPPER_OUT = T to put STR in all upper case, F lower.
pub fn toupper_lower(lupper_out: bool, s: &mut FStr) {
    const CH: [&[u8; 26]; 2] = [b"abcdefghijklmnopqrstuvwxyz", b"ABCDEFGHIJKLMNOPQRSTUVWXYZ"];
    let (iin, iout) = if lupper_out { (0, 1) } else { (1, 0) };
    for jstr in 1..=s.len() as i32 {
        for jalpha in 0..26 {
            if s.at(jstr) == CH[iin][jalpha] {
                s.set_at(jstr, CH[iout][jalpha]);
                break;
            }
        }
    }
}

/// REMOVE_BLANK_START: shift STR left over its leading blanks. The last
/// NBLANKS characters before the trailing blanks are left as they were.
pub fn remove_blank_start(s: &mut FStr) {
    let length = ilen(s);
    let mut nblanks = length + 1;
    for k in 1..=length {
        if s.at(k) != b' ' {
            nblanks = k;
            break;
        }
    }
    // Label 200.
    nblanks = nblanks - 1;
    if nblanks > 0 {
        for j in 1..=(length - nblanks) {
            let b = s.at(j + nblanks);
            s.set_at(j, b);
        }
    }
}

/// ICYCLE: subscript from J for a cyclic array of length NDATA
/// (J > -NDATA must hold).
pub fn icycle(j: i32, ndata: i32) -> i32 {
    let k = j - 1 + ndata;
    if k < 0 {
        // CALL ERRMES (1, 4, 'ICYCLE'): a free function cannot stop the run.
        panic!("FATAL ERROR ICYCLE 1");
    }
    k % ndata + 1
}

/// ICYCLE_r: subscript from J for a rearranged array of length NDATA;
/// extensions beyond the array are set to the endpoint.
pub fn icycle_r(j: i32, ndata: i32) -> i32 {
    1.max(ndata.min(j))
}

/// Members of NAMELIST /LCMODL/, in declaration order.
const NML_LCMODL: &[&str] = &["chbcal", "chcali", "chcol", "chcomb", "chcom2", "chext2", "chgam", "chgrsh", "chkeep", "chless", "chlsha", "chmore", "chnols", "chnot1", "chnot2", "chomit", "chpmet", "chrato", "chrow", "chsdsh", "chsdt2", "chsimu", "chslic", "chuse1", "filbas", "filcoo", "filcor", "filcsi_sav_1", "filcsi_sav_2", "filcsv", "filh2o", "filpri", "filps", "filraw", "filtab", "nameac", "namrel", "norato", "owner", "pgnorm", "savdir", "sptype", "srch2o", "srcraw", "synus1", "title", "wsmet", "power", "iareaw", "iauto", "iaverg", "icolen", "icolsk", "icolst", "idgppm", "idump", "ietcou", "imethd", "incsmx", "ipage2", "ipdump", "ipowph", "ipowrg", "irowen", "irowsk", "irowst", "isdbol", "islice", "iter_dump", "key", "lbasis", "lcoord", "lcoraw", "lcsi_sav_1", "lcsi_sav_2", "lcsv", "lh2o", "lprint", "lps", "lraw", "ltable", "mdalpb", "mdegp3", "mermes", "mfndal", "minter", "miter", "mnsamp", "mpower", "mrepha", "n1hmet", "nback", "nbas_ccf", "nbckmn", "ncalib", "nchgam", "nchles", "nchlin", "ncombi", "ndcols", "ndegz", "ndgppm", "ndrows", "ndslic", "neach", "next2", "ngrsh", "nkeep", "nlshap", "nnolsh", "nnorat", "nomit", "nnot1", "nnot2", "nratio", "nrefpk", "nrf2mn", "nsdsh", "nsdt2", "nshift", "nsidmn", "nsidmx", "nsimul", "nsubtk", "ntitle", "nunfil", "nuse1", "nvoxsk", "nwsend", "nwsst", "absval", "accept_alpbmn", "accept_step2", "areaba_orig_basisf", "asymlp", "badref", "bascal", "basout", "ccntrl", "chksim", "conc3f", "doecc", "dofull", "dorefs", "dowatr", "dows", "dozero", "eccdon", "endpha", "fixshf", "forecc", "gauss_rt2", "gshgua", "landsc", "ldump", "nobase", "nobasi", "onlyco", "plprft", "quick", "reflac", "roomt", "scasim", "sidump", "sitayl", "skip_step3", "smtail", "subbas", "unsupr", "useany", "useglc", "usemxb", "usinfl", "vitro", "year4d", "alext2", "alpbmn", "alpbmx", "alpbpn", "alpbst", "alphab_dump", "alphas_dump", "alpsmn", "alpsmx", "alpsst", "alsdsh", "alsdt2", "atth2o", "attmet", "bwtolr", "conrel", "cosmin", "ddegp3", "ddgpmq", "ddgzmq", "deext2", "degmax", "degppm", "degzer", "deltat", "desdsh", "desdt2", "dfldmq", "dgppmn", "dgppmx", "dkngam", "dkntmn", "dshpat", "echot", "exrt2", "fcalib", "fcsum", "fh2omx", "fmain_power", "fother_power", "frepha", "fstpmq", "fwhh2o", "fwhmba", "fwhmmn", "fwhmmx", "fwhmsm", "fwhmst", "hifmm", "hwdwat", "hzpgam", "hzpppm", "hzref", "pageht", "pagewd", "pmqst", "pmqstl", "pnalpb", "ppmbas", "ppmend", "ppmcen", "ppmend_phalip", "ppmgap", "ppmh2o", "ppmmet", "ppmpos", "ppmref", "ppmsep", "ppmshf", "ppmsig", "ppmst", "ppmst_phalip", "ppm_truncate_max", "ppm_truncate_min", "ppm_water_range", "ppm_water_tol", "prmnmx", "ptlabl", "ptoutp", "pttitl", "ralimn", "ralinc", "r_areaba", "ratipm", "rbackg", "rbasmx", "rconvr", "rdalpb", "rfwbas", "rfwhcc", "rfwhm", "rfwhmst_ccf", "rfwhst", "rgbbol", "rgberr", "rgblin", "rgbrat", "rhlabl", "rhoutp", "rhtitl", "rhvers", "rincrs", "rincsh", "rlesmo", "rlrntz", "rmqdec", "rmqinc", "rpenmx", "rpmqmn", "rpowmq", "rrt2mq", "rsdgp3", "rsdsam", "rsdsmq", "rshfmq", "rstpmn", "rstpmx", "rwfont", "sddegp", "sddegz", "sdgrsh", "sdmshf", "sdshmn", "sdshmx", "sdsmoo", "shifmn", "shifmx", "thrlin", "wconc", "wdline", "wsppm", "xleft", "xright", "xstep", "xtrpmx", "ybott", "ytop"];

/// Members of NAMELIST /LCMODeL/, in declaration order.
const NML_LCMODEL: &[&str] = &["chbcal", "chcali", "chcol", "chext2", "chgam", "chkeep", "chless", "chlsha", "chmore", "chnols", "chomit", "chpmet", "chrow", "chsdsh", "chsdt2", "chslic", "filbas", "filcoo", "filcor", "filcsi_sav_1", "filcsi_sav_2", "filcsv", "filh2o", "filpri", "filps", "filraw", "filtab", "nameac", "namrel", "norato", "owner", "pgnorm", "savdir", "sptype", "srch2o", "srcraw", "synus1", "title", "wsmet", "power", "iareaw", "iauto", "iaverg", "icolen", "icolsk", "icolst", "idgppm", "idump", "ietcou", "imethd", "incsmx", "ipage2", "ipdump", "ipowph", "ipowrg", "irowen", "irowsk", "irowst", "isdbol", "islice", "iter_dump", "key", "lbasis", "lcoord", "lcoraw", "lcsi_sav_1", "lcsi_sav_2", "lcsv", "lh2o", "lprint", "lps", "lraw", "ltable", "mdalpb", "mdegp3", "mermes", "mfndal", "minter", "miter", "mnsamp", "mpower", "mrepha", "n1hmet", "nback", "nbas_ccf", "nbckmn", "ncalib", "nchgam", "nchles", "nchlin", "ncombi", "ndcols", "ndegz", "ndgppm", "ndrows", "ndslic", "neach", "next2", "ngrsh", "nkeep", "nlshap", "nnolsh", "nnorat", "nomit", "nnot1", "nnot2", "nrefpk", "nrf2mn", "nsdsh", "nsdt2", "nshift", "nsidmn", "nsidmx", "nsubtk", "ntitle", "nunfil", "nuse1", "nvoxsk", "nwsend", "nwsst", "absval", "accept_alpbmn", "accept_step2", "areaba_orig_basisf", "asymlp", "badref", "bascal", "basout", "ccntrl", "chksim", "conc3f", "doecc", "dofull", "dorefs", "dowatr", "dows", "dozero", "eccdon", "endpha", "fixshf", "forecc", "gauss_rt2", "gshgua", "landsc", "ldump", "nobase", "nobasi", "onlyco", "plprft", "quick", "reflac", "roomt", "scasim", "sidump", "sitayl", "skip_step3", "smtail", "subbas", "unsupr", "useany", "useglc", "usemxb", "usinfl", "year4d", "alext2", "alpbmn", "alpbmx", "alpbpn", "alpbst", "alphab_dump", "alphas_dump", "alpsmn", "alpsmx", "alpsst", "alsdsh", "alsdt2", "atth2o", "attmet", "bwtolr", "conrel", "cosmin", "ddegp3", "ddgpmq", "ddgzmq", "deext2", "degmax", "degppm", "degzer", "deltat", "desdsh", "desdt2", "dfldmq", "dgppmn", "dgppmx", "dkngam", "dshpat", "echot", "exrt2", "fcalib", "fcsum", "fh2omx", "fmain_power", "fother_power", "frepha", "fstpmq", "fwhh2o", "fwhmba", "fwhmmn", "fwhmmx", "fwhmsm", "fwhmst", "hifmm", "hwdwat", "hzpgam", "hzpppm", "hzref", "pageht", "pagewd", "pmqst", "pmqstl", "pnalpb", "ppmbas", "ppmend", "ppmend_phalip", "ppmcen", "ppmgap", "ppmh2o", "ppmmet", "ppmpos", "ppmsep", "ppmshf", "ppmsig", "ppmst", "ppmst_phalip", "ppm_truncate_max", "ppm_truncate_min", "ppm_water_range", "ppm_water_tol", "prmnmx", "ptlabl", "ptoutp", "pttitl", "ralimn", "ralinc", "r_areaba", "ratipm", "rbasmx", "rconvr", "rdalpb", "rfwbas", "rfwhcc", "rfwhm", "rfwhmst_ccf", "rfwhst", "rgbbol", "rgberr", "rgblin", "rgbrat", "rhlabl", "rhoutp", "rhtitl", "rhvers", "rincrs", "rincsh", "rlesmo", "rlrntz", "rmqdec", "rmqinc", "rpenmx", "rpmqmn", "rpowmq", "rrt2mq", "rsdgp3", "rsdsam", "rsdsmq", "rshfmq", "rstpmn", "rstpmx", "rwfont", "sddegp", "sddegz", "sdgrsh", "sdmshf", "sdshmn", "sdshmx", "sdsmoo", "shifmn", "shifmx", "thrlin", "wconc", "wdline", "wsppm", "xleft", "xright", "xstep", "xtrpmx", "ybott", "ytop"];

/// Values of a namelist member, for NAMELIST output.
fn nml_member(c: &Common, name: &str) -> NmlOut {
    match name {
        "absval" => NmlOut::L(vec![c.absval]),
        "accept_alpbmn" => NmlOut::L(vec![c.accept_alpbmn]),
        "accept_step2" => NmlOut::L(vec![c.accept_step2]),
        "alext2" => NmlOut::R(c.alext2.data.clone()),
        "alpbmn" => NmlOut::D(vec![c.alpbmn]),
        "alpbmx" => NmlOut::D(vec![c.alpbmx]),
        "alpbpn" => NmlOut::R(vec![c.alpbpn]),
        "alpbst" => NmlOut::R(vec![c.alpbst]),
        "alphab_dump" => NmlOut::R(vec![c.alphab_dump]),
        "alphas_dump" => NmlOut::R(vec![c.alphas_dump]),
        "alpsmn" => NmlOut::D(vec![c.alpsmn]),
        "alpsmx" => NmlOut::D(vec![c.alpsmx]),
        "alpsst" => NmlOut::R(vec![c.alpsst]),
        "alsdsh" => NmlOut::R(c.alsdsh.data.clone()),
        "alsdt2" => NmlOut::R(c.alsdt2.data.clone()),
        "areaba_orig_basisf" => NmlOut::L(vec![c.areaba_orig_basisf]),
        "asymlp" => NmlOut::L(vec![c.asymlp]),
        "atth2o" => NmlOut::R(vec![c.atth2o]),
        "attmet" => NmlOut::R(vec![c.attmet]),
        "badref" => NmlOut::L(vec![c.badref]),
        "bascal" => NmlOut::L(vec![c.bascal]),
        "basout" => NmlOut::L(vec![c.basout]),
        "bwtolr" => NmlOut::R(vec![c.bwtolr]),
        "ccntrl" => NmlOut::L(vec![c.ccntrl]),
        "chbcal" => NmlOut::S(vec![c.chbcal.as_str()]),
        "chcali" => NmlOut::S(c.chcali.data.iter().map(|s| s.as_str()).collect()),
        "chcol" => NmlOut::S(vec![c.chcol.as_str()]),
        "chcom2" => NmlOut::S(c.chcom2.data.iter().map(|s| s.as_str()).collect()),
        "chcomb" => NmlOut::S(c.chcomb.data.iter().map(|s| s.as_str()).collect()),
        "chext2" => NmlOut::S(c.chext2.data.iter().map(|s| s.as_str()).collect()),
        "chgam" => NmlOut::S(vec![c.chgam.as_str()]),
        "chgrsh" => NmlOut::S(c.chgrsh.data.iter().map(|s| s.as_str()).collect()),
        "chkeep" => NmlOut::S(c.chkeep.data.iter().map(|s| s.as_str()).collect()),
        "chksim" => NmlOut::L(vec![c.chksim]),
        "chless" => NmlOut::S(c.chless.data.iter().map(|s| s.as_str()).collect()),
        "chlsha" => NmlOut::S(c.chlsha.data.iter().map(|s| s.as_str()).collect()),
        "chmore" => NmlOut::S(vec![c.chmore.as_str()]),
        "chnols" => NmlOut::S(c.chnols.data.iter().map(|s| s.as_str()).collect()),
        "chnot1" => NmlOut::S(c.chnot1.data.iter().map(|s| s.as_str()).collect()),
        "chnot2" => NmlOut::S(c.chnot2.data.iter().map(|s| s.as_str()).collect()),
        "chomit" => NmlOut::S(c.chomit.data.iter().map(|s| s.as_str()).collect()),
        "chpmet" => NmlOut::S(c.chpmet.data.iter().map(|s| s.as_str()).collect()),
        "chrato" => NmlOut::S(c.chrato.data.iter().map(|s| s.as_str()).collect()),
        "chrow" => NmlOut::S(vec![c.chrow.as_str()]),
        "chsdsh" => NmlOut::S(c.chsdsh.data.iter().map(|s| s.as_str()).collect()),
        "chsdt2" => NmlOut::S(c.chsdt2.data.iter().map(|s| s.as_str()).collect()),
        "chsimu" => NmlOut::S(c.chsimu.data.iter().map(|s| s.as_str()).collect()),
        "chslic" => NmlOut::S(vec![c.chslic.as_str()]),
        "chuse1" => NmlOut::S(c.chuse1.data.iter().map(|s| s.as_str()).collect()),
        "conc3f" => NmlOut::L(vec![c.conc3f]),
        "conrel" => NmlOut::R(vec![c.conrel]),
        "cosmin" => NmlOut::R(c.cosmin.data.clone()),
        "ddegp3" => NmlOut::R(vec![c.ddegp3]),
        "ddgpmq" => NmlOut::R(c.ddgpmq.data.clone()),
        "ddgzmq" => NmlOut::R(c.ddgzmq.data.clone()),
        "deext2" => NmlOut::R(vec![c.deext2]),
        "degmax" => NmlOut::R(c.degmax.data.clone()),
        "degppm" => NmlOut::R(vec![c.degppm]),
        "degzer" => NmlOut::R(vec![c.degzer]),
        "deltat" => NmlOut::R(vec![c.deltat]),
        "desdsh" => NmlOut::R(vec![c.desdsh]),
        "desdt2" => NmlOut::R(vec![c.desdt2]),
        "dfldmq" => NmlOut::R(vec![c.dfldmq]),
        "dgppmn" => NmlOut::R(vec![c.dgppmn]),
        "dgppmx" => NmlOut::R(vec![c.dgppmx]),
        "dkngam" => NmlOut::R(vec![c.dkngam]),
        "dkntmn" => NmlOut::R(c.dkntmn.data.clone()),
        "doecc" => NmlOut::L(vec![c.doecc]),
        "dofull" => NmlOut::L(vec![c.dofull]),
        "dorefs" => NmlOut::L(c.dorefs.data.clone()),
        "dowatr" => NmlOut::L(vec![c.dowatr]),
        "dows" => NmlOut::L(vec![c.dows]),
        "dozero" => NmlOut::L(c.dozero.data.clone()),
        "dshpat" => NmlOut::R(c.dshpat.data.clone()),
        "eccdon" => NmlOut::L(vec![c.eccdon]),
        "echot" => NmlOut::R(vec![c.echot]),
        "endpha" => NmlOut::L(vec![c.endpha]),
        "exrt2" => NmlOut::R(c.exrt2.data.clone()),
        "fcalib" => NmlOut::R(vec![c.fcalib]),
        "fcsum" => NmlOut::R(vec![c.fcsum]),
        "fh2omx" => NmlOut::R(vec![c.fh2omx]),
        "filbas" => NmlOut::S(vec![c.filbas.as_str()]),
        "filcoo" => NmlOut::S(vec![c.filcoo.as_str()]),
        "filcor" => NmlOut::S(vec![c.filcor.as_str()]),
        "filcsi_sav_1" => NmlOut::S(vec![c.filcsi_sav_1.as_str()]),
        "filcsi_sav_2" => NmlOut::S(vec![c.filcsi_sav_2.as_str()]),
        "filcsv" => NmlOut::S(vec![c.filcsv.as_str()]),
        "filh2o" => NmlOut::S(vec![c.filh2o.as_str()]),
        "filpri" => NmlOut::S(vec![c.filpri.as_str()]),
        "filps" => NmlOut::S(vec![c.filps.as_str()]),
        "filraw" => NmlOut::S(vec![c.filraw.as_str()]),
        "filtab" => NmlOut::S(vec![c.filtab.as_str()]),
        "fixshf" => NmlOut::L(vec![c.fixshf]),
        "fmain_power" => NmlOut::R(vec![c.fmain_power]),
        "forecc" => NmlOut::L(vec![c.forecc]),
        "fother_power" => NmlOut::R(vec![c.fother_power]),
        "frepha" => NmlOut::R(vec![c.frepha]),
        "fstpmq" => NmlOut::R(vec![c.fstpmq]),
        "fwhh2o" => NmlOut::R(vec![c.fwhh2o]),
        "fwhmba" => NmlOut::R(vec![c.fwhmba]),
        "fwhmmn" => NmlOut::R(vec![c.fwhmmn]),
        "fwhmmx" => NmlOut::R(vec![c.fwhmmx]),
        "fwhmsm" => NmlOut::R(vec![c.fwhmsm]),
        "fwhmst" => NmlOut::R(vec![c.fwhmst]),
        "gauss_rt2" => NmlOut::L(vec![c.gauss_rt2]),
        "gshgua" => NmlOut::L(vec![c.gshgua]),
        "hifmm" => NmlOut::R(vec![c.hifmm]),
        "hwdwat" => NmlOut::R(c.hwdwat.data.clone()),
        "hzpgam" => NmlOut::R(c.hzpgam.data.clone()),
        "hzpppm" => NmlOut::R(vec![c.hzpppm]),
        "hzref" => NmlOut::R(c.hzref.data.clone()),
        "iareaw" => NmlOut::I(vec![c.iareaw]),
        "iauto" => NmlOut::I(vec![c.iauto]),
        "iaverg" => NmlOut::I(vec![c.iaverg]),
        "icolen" => NmlOut::I(vec![c.icolen]),
        "icolsk" => NmlOut::I(c.icolsk.data.clone()),
        "icolst" => NmlOut::I(vec![c.icolst]),
        "idgppm" => NmlOut::I(vec![c.idgppm]),
        "idump" => NmlOut::I(c.idump.data.clone()),
        "ietcou" => NmlOut::I(vec![c.ietcou]),
        "imethd" => NmlOut::I(vec![c.imethd]),
        "incsmx" => NmlOut::I(vec![c.incsmx]),
        "ipage2" => NmlOut::I(vec![c.ipage2]),
        "ipdump" => NmlOut::I(vec![c.ipdump]),
        "ipowph" => NmlOut::I(vec![c.ipowph]),
        "ipowrg" => NmlOut::I(vec![c.ipowrg]),
        "irowen" => NmlOut::I(vec![c.irowen]),
        "irowsk" => NmlOut::I(c.irowsk.data.clone()),
        "irowst" => NmlOut::I(vec![c.irowst]),
        "isdbol" => NmlOut::I(vec![c.isdbol]),
        "islice" => NmlOut::I(vec![c.islice]),
        "iter_dump" => NmlOut::I(vec![c.iter_dump]),
        "key" => NmlOut::I(c.key.data.clone()),
        "landsc" => NmlOut::L(vec![c.landsc]),
        "lbasis" => NmlOut::I(vec![c.lbasis]),
        "lcoord" => NmlOut::I(vec![c.lcoord]),
        "lcoraw" => NmlOut::I(vec![c.lcoraw]),
        "lcsi_sav_1" => NmlOut::I(vec![c.lcsi_sav_1]),
        "lcsi_sav_2" => NmlOut::I(vec![c.lcsi_sav_2]),
        "lcsv" => NmlOut::I(vec![c.lcsv]),
        "ldump" => NmlOut::L(c.ldump.data.clone()),
        "lh2o" => NmlOut::I(vec![c.lh2o]),
        "lprint" => NmlOut::I(vec![c.lprint]),
        "lps" => NmlOut::I(vec![c.lps]),
        "lraw" => NmlOut::I(vec![c.lraw]),
        "ltable" => NmlOut::I(vec![c.ltable]),
        "mdalpb" => NmlOut::I(vec![c.mdalpb]),
        "mdegp3" => NmlOut::I(vec![c.mdegp3]),
        "mermes" => NmlOut::I(vec![c.mermes]),
        "mfndal" => NmlOut::I(vec![c.mfndal]),
        "minter" => NmlOut::I(c.minter.data.clone()),
        "miter" => NmlOut::I(c.miter.data.clone()),
        "mnsamp" => NmlOut::I(vec![c.mnsamp]),
        "mpower" => NmlOut::I(vec![c.mpower]),
        "mrepha" => NmlOut::I(c.mrepha.data.clone()),
        "n1hmet" => NmlOut::I(vec![c.n1hmet]),
        "nameac" => NmlOut::S(c.nameac.data.iter().map(|s| s.as_str()).collect()),
        "namrel" => NmlOut::S(vec![c.namrel.as_str()]),
        "nback" => NmlOut::I(c.nback.data.clone()),
        "nbas_ccf" => NmlOut::I(vec![c.nbas_ccf]),
        "nbckmn" => NmlOut::I(vec![c.nbckmn]),
        "ncalib" => NmlOut::I(vec![c.ncalib]),
        "nchgam" => NmlOut::I(vec![c.nchgam]),
        "nchles" => NmlOut::I(vec![c.nchles]),
        "nchlin" => NmlOut::I(c.nchlin.data.clone()),
        "ncombi" => NmlOut::I(vec![c.ncombi]),
        "ndcols" => NmlOut::I(vec![c.ndcols]),
        "ndegz" => NmlOut::I(c.ndegz.data.clone()),
        "ndgppm" => NmlOut::I(c.ndgppm.data.clone()),
        "ndrows" => NmlOut::I(vec![c.ndrows]),
        "ndslic" => NmlOut::I(vec![c.ndslic]),
        "neach" => NmlOut::I(vec![c.neach]),
        "next2" => NmlOut::I(vec![c.next2]),
        "ngrsh" => NmlOut::I(vec![c.ngrsh]),
        "nkeep" => NmlOut::I(vec![c.nkeep]),
        "nlshap" => NmlOut::I(vec![c.nlshap]),
        "nnolsh" => NmlOut::I(vec![c.nnolsh]),
        "nnorat" => NmlOut::I(vec![c.nnorat]),
        "nnot1" => NmlOut::I(vec![c.nnot1]),
        "nnot2" => NmlOut::I(vec![c.nnot2]),
        "nobase" => NmlOut::L(vec![c.nobase]),
        "nobasi" => NmlOut::L(vec![c.nobasi]),
        "nomit" => NmlOut::I(vec![c.nomit]),
        "norato" => NmlOut::S(c.norato.data.iter().map(|s| s.as_str()).collect()),
        "nratio" => NmlOut::I(vec![c.nratio]),
        "nrefpk" => NmlOut::I(c.nrefpk.data.clone()),
        "nrf2mn" => NmlOut::I(vec![c.nrf2mn]),
        "nsdsh" => NmlOut::I(vec![c.nsdsh]),
        "nsdt2" => NmlOut::I(vec![c.nsdt2]),
        "nshift" => NmlOut::I(vec![c.nshift]),
        "nsidmn" => NmlOut::I(vec![c.nsidmn]),
        "nsidmx" => NmlOut::I(vec![c.nsidmx]),
        "nsimul" => NmlOut::I(vec![c.nsimul]),
        "nsubtk" => NmlOut::I(vec![c.nsubtk]),
        "ntitle" => NmlOut::I(vec![c.ntitle]),
        "nunfil" => NmlOut::I(vec![c.nunfil]),
        "nuse1" => NmlOut::I(vec![c.nuse1]),
        "nvoxsk" => NmlOut::I(vec![c.nvoxsk]),
        "nwsend" => NmlOut::I(vec![c.nwsend]),
        "nwsst" => NmlOut::I(vec![c.nwsst]),
        "onlyco" => NmlOut::L(vec![c.onlyco]),
        "owner" => NmlOut::S(vec![c.owner.as_str()]),
        "pageht" => NmlOut::R(vec![c.pageht]),
        "pagewd" => NmlOut::R(vec![c.pagewd]),
        "pgnorm" => NmlOut::S(vec![c.pgnorm.as_str()]),
        "plprft" => NmlOut::L(vec![c.plprft]),
        "pmqst" => NmlOut::R(c.pmqst.data.clone()),
        "pmqstl" => NmlOut::R(c.pmqstl.data.clone()),
        "pnalpb" => NmlOut::R(vec![c.pnalpb]),
        "power" => NmlOut::D(c.power.data.clone()),
        "ppm_truncate_max" => NmlOut::R(vec![c.ppm_truncate_max]),
        "ppm_truncate_min" => NmlOut::R(vec![c.ppm_truncate_min]),
        "ppm_water_range" => NmlOut::R(vec![c.ppm_water_range]),
        "ppm_water_tol" => NmlOut::R(vec![c.ppm_water_tol]),
        "ppmbas" => NmlOut::R(c.ppmbas.data.clone()),
        "ppmcen" => NmlOut::R(vec![c.ppmcen]),
        "ppmend" => NmlOut::R(vec![c.ppmend]),
        "ppmend_phalip" => NmlOut::R(vec![c.ppmend_phalip]),
        "ppmgap" => NmlOut::R(c.ppmgap.data.clone()),
        "ppmh2o" => NmlOut::R(vec![c.ppmh2o]),
        "ppmmet" => NmlOut::R(c.ppmmet.data.clone()),
        "ppmpos" => NmlOut::R(c.ppmpos.data.clone()),
        "ppmref" => NmlOut::R(c.ppmref.data.clone()),
        "ppmsep" => NmlOut::R(c.ppmsep.data.clone()),
        "ppmshf" => NmlOut::R(vec![c.ppmshf]),
        "ppmsig" => NmlOut::R(c.ppmsig.data.clone()),
        "ppmst" => NmlOut::R(vec![c.ppmst]),
        "ppmst_phalip" => NmlOut::R(vec![c.ppmst_phalip]),
        "prmnmx" => NmlOut::R(c.prmnmx.data.clone()),
        "ptlabl" => NmlOut::R(vec![c.ptlabl]),
        "ptoutp" => NmlOut::R(vec![c.ptoutp]),
        "pttitl" => NmlOut::R(vec![c.pttitl]),
        "quick" => NmlOut::L(vec![c.quick]),
        "r_areaba" => NmlOut::R(vec![c.r_areaba]),
        "ralimn" => NmlOut::R(vec![c.ralimn]),
        "ralinc" => NmlOut::R(vec![c.ralinc]),
        "ratipm" => NmlOut::R(vec![c.ratipm]),
        "rbackg" => NmlOut::R(c.rbackg.data.clone()),
        "rbasmx" => NmlOut::R(c.rbasmx.data.clone()),
        "rconvr" => NmlOut::R(c.rconvr.data.clone()),
        "rdalpb" => NmlOut::R(vec![c.rdalpb]),
        "reflac" => NmlOut::L(vec![c.reflac]),
        "rfwbas" => NmlOut::R(vec![c.rfwbas]),
        "rfwhcc" => NmlOut::R(vec![c.rfwhcc]),
        "rfwhm" => NmlOut::R(vec![c.rfwhm]),
        "rfwhmst_ccf" => NmlOut::R(vec![c.rfwhmst_ccf]),
        "rfwhst" => NmlOut::R(vec![c.rfwhst]),
        "rgbbol" => NmlOut::R(c.rgbbol.data.clone()),
        "rgberr" => NmlOut::R(c.rgberr.data.clone()),
        "rgblin" => NmlOut::R(c.rgblin.data.clone()),
        "rgbrat" => NmlOut::R(c.rgbrat.data.clone()),
        "rhlabl" => NmlOut::R(vec![c.rhlabl]),
        "rhoutp" => NmlOut::R(vec![c.rhoutp]),
        "rhtitl" => NmlOut::R(vec![c.rhtitl]),
        "rhvers" => NmlOut::R(vec![c.rhvers]),
        "rincrs" => NmlOut::R(c.rincrs.data.clone()),
        "rincsh" => NmlOut::R(vec![c.rincsh]),
        "rlesmo" => NmlOut::R(vec![c.rlesmo]),
        "rlrntz" => NmlOut::R(vec![c.rlrntz]),
        "rmqdec" => NmlOut::R(c.rmqdec.data.clone()),
        "rmqinc" => NmlOut::R(c.rmqinc.data.clone()),
        "roomt" => NmlOut::L(vec![c.roomt]),
        "rpenmx" => NmlOut::R(vec![c.rpenmx]),
        "rpmqmn" => NmlOut::R(c.rpmqmn.data.clone()),
        "rpowmq" => NmlOut::R(vec![c.rpowmq]),
        "rrt2mq" => NmlOut::R(vec![c.rrt2mq]),
        "rsdgp3" => NmlOut::R(vec![c.rsdgp3]),
        "rsdsam" => NmlOut::R(c.rsdsam.data.clone()),
        "rsdsmq" => NmlOut::R(vec![c.rsdsmq]),
        "rshfmq" => NmlOut::R(vec![c.rshfmq]),
        "rstpmn" => NmlOut::R(c.rstpmn.data.clone()),
        "rstpmx" => NmlOut::R(c.rstpmx.data.clone()),
        "rwfont" => NmlOut::R(vec![c.rwfont]),
        "savdir" => NmlOut::S(vec![c.savdir.as_str()]),
        "scasim" => NmlOut::L(vec![c.scasim]),
        "sddegp" => NmlOut::R(vec![c.sddegp]),
        "sddegz" => NmlOut::R(vec![c.sddegz]),
        "sdgrsh" => NmlOut::R(c.sdgrsh.data.clone()),
        "sdmshf" => NmlOut::R(vec![c.sdmshf]),
        "sdshmn" => NmlOut::R(vec![c.sdshmn]),
        "sdshmx" => NmlOut::R(vec![c.sdshmx]),
        "sdsmoo" => NmlOut::R(c.sdsmoo.data.clone()),
        "shifmn" => NmlOut::R(c.shifmn.data.clone()),
        "shifmx" => NmlOut::R(c.shifmx.data.clone()),
        "sidump" => NmlOut::L(c.sidump.data.clone()),
        "sitayl" => NmlOut::L(c.sitayl.data.clone()),
        "skip_step3" => NmlOut::L(vec![c.skip_step3]),
        "smtail" => NmlOut::L(vec![c.smtail]),
        "sptype" => NmlOut::S(vec![c.sptype.as_str()]),
        "srch2o" => NmlOut::S(vec![c.srch2o.as_str()]),
        "srcraw" => NmlOut::S(vec![c.srcraw.as_str()]),
        "subbas" => NmlOut::L(vec![c.subbas]),
        "synus1" => NmlOut::S(c.synus1.data.iter().map(|s| s.as_str()).collect()),
        "thrlin" => NmlOut::R(vec![c.thrlin]),
        "title" => NmlOut::S(vec![c.title.as_str()]),
        "unsupr" => NmlOut::L(vec![c.unsupr]),
        "useany" => NmlOut::L(vec![c.useany]),
        "useglc" => NmlOut::L(vec![c.useglc]),
        "usemxb" => NmlOut::L(vec![c.usemxb]),
        "usinfl" => NmlOut::L(vec![c.usinfl]),
        "vitro" => NmlOut::L(vec![c.vitro]),
        "wconc" => NmlOut::R(vec![c.wconc]),
        "wdline" => NmlOut::R(c.wdline.data.clone()),
        "wsmet" => NmlOut::S(vec![c.wsmet.as_str()]),
        "wsppm" => NmlOut::R(vec![c.wsppm]),
        "xleft" => NmlOut::R(vec![c.xleft]),
        "xright" => NmlOut::R(vec![c.xright]),
        "xstep" => NmlOut::R(vec![c.xstep]),
        "xtrpmx" => NmlOut::R(vec![c.xtrpmx]),
        "ybott" => NmlOut::R(vec![c.ybott]),
        "year4d" => NmlOut::L(vec![c.year4d]),
        "ytop" => NmlOut::R(vec![c.ytop]),
        other => unreachable!("{other} is not a namelist member"),
    }
}

#[cfg(test)]
mod tests {
    //! Reference outputs from gfortran (-std=legacy -O2) running the Fortran
    //! subprograms: tests/data/control_gfortran.f and control_nml_gfortran.f.
    use super::*;

    const STRINGS: [&str; 12] = ["  tumor", "MUSCLE-1", "   ", "abc  def ", " x y z ", "out.table", "dir/table", "dir/ps", "noext", "a.PS", " Liver-2 X", "Q"];

    #[test]
    fn pure_subprograms_match_gfortran() {
        let expected = include_str!("../tests/data/control_gfortran.txt");
        let mut got = Vec::new();
        for (k, s0) in STRINGS.iter().enumerate() {
            let j = k + 1;
            let s = FStr::new(40, s0);
            let mut t = s.clone();
            remove_blank_start(&mut t);
            got.push(format!("RBS{:3} [{}]", j, t.as_str()));
            let mut t = s.clone();
            toupper_lower(true, &mut t);
            got.push(format!("TUP{:3} [{}]", j, t.as_str()));
            let mut t = s.clone();
            toupper_lower(false, &mut t);
            got.push(format!("TLO{:3} [{}]", j, t.as_str()));
            got.push(format!("ILEN{:3}{:6}{:6}", j, ilen(&s), icharst(&s, 40)));
            let mut comp = FStr::new(40, &"z".repeat(40));
            let lc = compact_string(&s, &mut comp);
            got.push(format!("COMP{:3}{:4} [{}]", j, lc, comp.as_str()));
            let mut split = [FStr::blank(41), FStr::blank(41)];
            split_filename(&s, "table", "TABLE", "Table", 5, &mut split);
            got.push(format!("SPLT{:3} [{}] [{}]", j, split[0].as_str(), split[1].as_str()));
            split_filename(&s, "ps", "PS", "Ps", 2, &mut split);
            got.push(format!("SPLP{:3} [{}] [{}]", j, split[0].as_str(), split[1].as_str()));
        }
        for j in -12i32..=12 {
            let iarg = isign(3i32.pow(j.unsigned_abs()), j);
            let (chi, leni) = chstrip_int6(iarg);
            got.push(format!("CHS{:8}{:3} [{}]", iarg, leni, chi.as_str()));
        }
        for j in 1..=30 {
            let istart = 7919 * j * j + 8829 * (j - 15);
            got.push(format!("IGETP{:12}{:12}{:12}{:12}", istart, igetp(istart, 35), igetp(istart, 59), igetp(istart + 3678, 41)));
        }
        let lines: Vec<&str> = expected.lines().collect();
        let n = got.len();
        for (a, b) in got.iter().zip(lines.iter()) {
            assert_eq!(a, b);
        }
        // SMOOTH_TAIL_2 on the bit patterns written by the driver.
        let ints: Vec<i32> = lines[n..].iter().filter(|l| !l.starts_with('W') && !l.starts_with('O')).flat_map(|l| l.split_whitespace().map(|x| x.parse::<i32>().unwrap())).collect();
        let w: Vec<f32> = ints[..40].iter().map(|&b| f32::from_bits(b as u32)).collect();
        let want: Vec<f32> = ints[40..80].iter().map(|&b| f32::from_bits(b as u32)).collect();
        let mut out = vec![0.0f32; 40];
        let mut io = Units::new();
        smooth_tail_2(&w, &mut out, 40, 40, 0, false, &mut io);
        for k in 0..40 {
            assert_eq!(out[k].to_bits(), want[k].to_bits(), "OUT({})", k + 1);
        }
        assert_eq!(ilen(&FStr::blank(0)), 1);
        assert_eq!(icycle(0, 8), 8);
        assert_eq!(icycle(9, 8), 1);
        assert_eq!(icycle_r(9, 8), 8);
        assert_eq!(icycle_r(-3, 8), 1);
    }

    #[test]
    fn namelist_output_matches_gfortran() {
        let text = include_str!("../tests/data/control_nml_gfortran.txt");
        let (bits, nml) = text.split_once("NAMELIST\n").unwrap();
        let ints: Vec<i32> = bits.split_whitespace().map(|x| x.parse().unwrap()).collect();
        let f = |k: usize| f32::from_bits(ints[k] as u32);
        let d = |k: usize| f64::from_bits((ints[k] as u32 as u64) | ((ints[k + 1] as u32 as u64) << 32));
        let ra: Vec<f32> = (0..60).map(f).collect();
        let rb = f(60);
        let r2: Vec<f32> = (61..73).map(f).collect();
        let da: Vec<f64> = (0..40).map(|j| d(73 + 2 * j)).collect();
        let db = d(153);
        let mut ch = vec!["      ".to_string(); 14];
        for j in 0..3 {
            ch[j] = "Cr    ".into();
        }
        ch[8] = "NAA+x ".into();
        let cs = vec![format!("{:<20}", "a\"b'c"), " ".repeat(20), format!("{:<20}", " lead")];
        let ia: Vec<i32> = (1..=23).map(|j: i32| if j > 15 && j < 20 { 7 } else { (j - 11).pow(3) * 1000 }).collect();
        let la: Vec<bool> = (1..=13).map(|j| j % 4 == 0).collect();
        let members = vec![
            ("ch", NmlOut::S(ch)),
            ("cs", NmlOut::S(cs)),
            ("one", NmlOut::S(vec![format!("{:<9}", "x")])),
            ("ia", NmlOut::I(ia)),
            ("ib", NmlOut::I(vec![-2147483647])),
            ("ra", NmlOut::R(ra)),
            ("rb", NmlOut::R(vec![rb])),
            ("r2", NmlOut::R(r2)),
            ("da", NmlOut::D(da)),
            ("db", NmlOut::D(vec![db])),
            ("la", NmlOut::L(la)),
            ("lb", NmlOut::L(vec![true])),
        ];
        let recs = nml_write_records("TestGrp", &members);
        let want: Vec<&str> = nml.lines().collect();
        assert_eq!(recs.len(), want.len());
        for (a, b) in recs.iter().zip(want.iter()) {
            assert_eq!(a, b);
        }
    }

    #[test]
    fn mycont_reads_the_test_control_file() {
        let mut lcm = Lcm::new();
        lcm.io.set_stdin(" $LCMODL\n key=210387309\n nunfil=1024\n deltat=5e-04\n hzpppm=127.786142\n filbas='3t.basis'\n filraw='data.raw'\n filps='out.ps'\n lcoord=9\n filcoo='out.coord'\n ltable=7\n filtab='out.table'\n $END\n");
        lcm.mycont().unwrap();
        assert_eq!(lcm.c.nunfil, 1024);
        assert_eq!(lcm.c.ppmst, 4.0);
        assert_eq!(lcm.c.ppmend, 0.2);
        lcm.c.voxel1 = true;
        lcm.c.single_voxel = true;
        lcm.restore_settings().unwrap();
        lcm.open_output().unwrap();
        lcm.loadch().unwrap();
        assert!(lcm.c.linchg[2] > 0);
        assert!(lcm.c.change[(1, 2)].trim().contains("nunfil=1024") || lcm.c.change[(lcm.c.linchg[2], 2)].trim().len() > 0);
    }
}

