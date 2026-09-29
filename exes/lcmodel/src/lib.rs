//! A Rust port of LCModel 6.3-1N (S.W. Provencher, Magn. Reson. Med.
//! 30:672-679, 1993), translated subprogram by subprogram from the
//! BSD-3-Clause Fortran 77 source. PORTING.md describes the conventions; the
//! module of each subprogram is listed there.
//!
//! The interface is LCModel's own: a control file (NAMELIST /LCMODL/) on
//! standard input and data, water and basis files by name, producing the
//! .TABLE, .COORD, .PRINT and .CSV files. `run_lcmodel` takes and returns
//! those files as strings, which is how the browser calls it.
#![allow(
    clippy::too_many_arguments,
    clippy::needless_range_loop,
    clippy::collapsible_else_if,
    clippy::collapsible_if,
    clippy::manual_range_contains,
    clippy::excessive_precision,
    clippy::approx_constant,
    non_snake_case
)]

pub mod format;
pub mod fortran;
pub mod io;
pub mod state;

pub mod basis;
pub mod control;
pub mod finout;
pub mod numerics;
pub mod solve;
pub mod startv;
pub mod tworeg;

use fortran::*;
use io::Units;
use state::Common;
use std::collections::BTreeMap;

/// Everything a running LCModel holds: the COMMON blocks, the I/O units and
/// the SAVEd locals of each module's subprograms.
pub struct Lcm {
    pub c: Common,
    pub io: Units,
    /// Text returned by `fdate` (the run date shown in the outputs).
    pub fdate: String,
    pub s_control: control::Saves,
    pub s_basis: basis::Saves,
    pub s_startv: startv::Saves,
    pub s_tworeg: tworeg::Saves,
    pub s_solve: solve::Saves,
    pub s_finout: finout::Saves,
    /// Main-program locals with DATA initialisation.
    nanalyses_done: i32,
    nvoxels_done: i32,
    nvoxels_done_in: i32,
}

/// ERRMES calls raised inside subprograms that do not touch COMMON (PNNLS,
/// BETAIN, FISHNI, ...). They queue the call; the caller replays it with
/// `Lcm::drain` right after the subprogram returns. A queued fatal error
/// (|ILEVEL| >= 4) makes the subprogram return `Err` immediately, as the
/// Fortran would have stopped there.
#[derive(Default, Debug)]
pub struct ErrQueue {
    pub calls: Vec<(i32, i32, &'static str)>,
}

impl ErrQueue {
    pub fn new() -> Self {
        Self::default()
    }
    /// Queue `CALL ERRMES (number, ilevel, chsubp)`. Returns `Err` for fatal
    /// levels so the caller can write `q.errmes(1, 4, "PNNLS")?;`.
    pub fn errmes(&mut self, number: i32, ilevel: i32, chsubp: &'static str) -> R<()> {
        self.calls.push((number, ilevel, chsubp));
        if ilevel.abs() >= 4 || ilevel.abs() < 1 {
            return stop(format!("deferred ERRMES {chsubp} {number}"));
        }
        Ok(())
    }
}

impl Default for Lcm {
    fn default() -> Self {
        Self::new()
    }
}

impl Lcm {
    pub fn new() -> Self {
        Lcm {
            c: Common::new(),
            io: Units::new(),
            fdate: String::new(),
            s_control: Default::default(),
            s_basis: Default::default(),
            s_startv: Default::default(),
            s_tworeg: Default::default(),
            s_solve: Default::default(),
            s_finout: Default::default(),
            nanalyses_done: 0,
            nvoxels_done: 0,
            nvoxels_done_in: 0,
        }
    }

    /// Replay queued ERRMES calls in order (see `ErrQueue`).
    pub fn drain(&mut self, q: ErrQueue) -> R<()> {
        for (number, ilevel, chsubp) in q.calls {
            self.errmes(number, ilevel, chsubp)?;
        }
        Ok(())
    }

    /// Call a queue-using subprogram's result through `drain`: replays the
    /// queued messages first, then propagates the subprogram's own result.
    pub fn after<T>(&mut self, q: ErrQueue, r: R<T>) -> R<T> {
        self.drain(q)?;
        r
    }

    /// PROGRAM LCMODL.
    pub fn lcmodl(&mut self) -> R<()> {
        let chsubp = "MAIN";
        let _ = chsubp;
        self.c.version_lcm.set("6.3-1N");
        let lversion_lcm = self.c.version_lcm.len_trim() as i32;
        let versio = format!(
            "LCModel (Version {}) Copyright: S.W. Provencher.          Ref.: Magn. Reson. Med. 30:672-679 (1993).",
            self.c.version_lcm.sub(1, lversion_lcm).as_str()
        );
        self.c.versio.set(&versio);
        // Get changes to Control Variables.
        self.mycont()?;
        // Load ZERO_VOXEL array; skip if BASCAL=T.
        if !self.c.bascal {
            self.check_zero_voxels()?;
            if self.c.iaverg >= 1 {
                self.average()?;
            }
        }
        // Restarting a CSI run from LCSI_SAV_1/2 files is not supported: those
        // files are specific to long command-line CSI runs.
        if self.c.lcsi_sav_1 == 12 {
            return self.errmes(1, -4, "MAIN");
        }
        self.nvoxels_done_in = 0;
        self.nanalyses_done = 0;
        self.c.ioffset_current_in = 0;
        // Label 40.
        if self.c.lcsv > 0 && !self.c.filcsv.is_blank() {
            let name = self.c.filcsv.trim();
            self.io.open_new(self.c.lcsv, &name);
        }
        // Label 50: main loop for all analyses of all voxels.
        let c = &self.c;
        let mut center_whole = (c.ndrows + 1) as f32 / 2.0;
        let mut i1 = (c.irowst + c.irowen) / 2;
        let mut i2 = (c.irowst + c.irowen + 1) / 2;
        let irow_center = if (i1 as f32 - center_whole).abs() < (i2 as f32 - center_whole).abs() { i1 } else { i2 };
        center_whole = (c.ndcols + 1) as f32 / 2.0;
        i1 = (c.icolst + c.icolen) / 2;
        i2 = (c.icolst + c.icolen + 1) / 2;
        let icol_center = if (i1 as f32 - center_whole).abs() < (i2 as f32 - center_whole).abs() { i1 } else { i2 };
        self.c.single_voxel = self.c.ndslic.max(self.c.ndrows).max(self.c.ndcols) == 1;
        let c = &self.c;
        let noffset = (c.irowen - irow_center).max(irow_center - c.irowst).max(c.icolen - icol_center).max(icol_center - c.icolst);
        // With only one voxel, force an analysis.
        if noffset <= 0 {
            self.c.zero_voxel[1] = false;
        }
        self.c.voxel1 = true;
        for ioffset in self.c.ioffset_current_in..=noffset {
            if !self.c.voxel1 {
                let lraw = self.c.lraw;
                self.io.rewind(lraw);
                self.c.lraw_at_top = true;
                if !self.c.filh2o.is_blank() {
                    let lh2o = self.c.lh2o;
                    self.io.rewind(lh2o);
                }
            }
            if ioffset > self.c.ioffset_current_in {
                self.nvoxels_done_in = 0;
            }
            let mut ivoxel = 0;
            for idslic in 1..=self.c.ndslic {
                self.c.idslic = idslic;
                for idrow in 1..=self.c.ndrows {
                    self.c.idrow = idrow;
                    for idcol in 1..=self.c.ndcols {
                        self.c.idcol = idcol;
                        ivoxel += 1;
                        let ir = (idrow - irow_center).abs();
                        let ic = (idcol - icol_center).abs();
                        let iok = (ir == ioffset && ic <= ioffset) || (ir <= ioffset && ic == ioffset);
                        let c = &self.c;
                        let mut skip_voxel = !iok
                            || idrow < c.irowst
                            || idrow > c.irowen
                            || idcol < c.icolst
                            || idcol > c.icolen
                            || idslic != c.islice
                            || c.zero_voxel[ivoxel]
                            || ivoxel <= self.nvoxels_done_in;
                        for j in 1..=c.nvoxsk {
                            skip_voxel = skip_voxel || (idrow == c.irowsk[j] && idcol == c.icolsk[j]);
                        }
                        self.c.skip_voxel = skip_voxel;
                        self.restore_settings()?;
                        // Open output files.
                        self.open_output()?;
                        if !self.c.skip_voxel {
                            // Load changes to Control Variables in CHANGE for later output.
                            self.loadch()?;
                            // Initialize global quantities (DELPPM, ...).
                            self.initia()?;
                        }
                        // Get DATAT = raw time-domain data.
                        if !self.c.bascal {
                            self.datain()?;
                        }
                        self.c.voxel1 = false;
                        self.c.lraw_at_top = false;
                        if self.c.skip_voxel {
                            continue;
                        }
                        self.c.initialize_solve = true;
                        // BASIST = time-domain basis vectors.
                        self.mybasi(1)?;
                        // NCOMPO and LCOMPO for combinations of metabolites.
                        self.combis()?;
                        // Preliminary analysis: starting phases and referencing shift.
                        self.startv(1)?;
                        // Repeat the preliminary analysis with fewer metabolites.
                        self.check_chless()?;
                        if self.c.omit_chless {
                            self.mybasi(1)?;
                            self.combis()?;
                            self.startv(2)?;
                        }
                        // Analyses with Regula Falsi searches for ALPHAB and ALPHAS.
                        if self.c.dofull {
                            self.mybasi(2)?;
                            self.combis()?;
                            self.tworeg()?;
                        }
                        // Final output.
                        self.finout()?;
                        if !self.c.single_voxel {
                            self.update_priors()?;
                        }
                    }
                }
            }
        }
        if self.c.lcsv > 0 {
            let lcsv = self.c.lcsv;
            self.io.close(lcsv);
        }
        Ok(())
    }
}

/// The files a run reads and writes, as text.
#[derive(Debug, Default, Clone)]
pub struct LcmResult {
    /// Output files by the names given in the control file.
    pub outputs: BTreeMap<String, String>,
    /// Text LCModel writes to standard output.
    pub stdout: String,
    /// Set when the run stopped on a fatal error.
    pub error: Option<String>,
}

/// Run LCModel on a control file with the named input files available.
/// `fdate` is the run date written into the outputs.
pub fn run_lcmodel(control: &str, files: &[(&str, &[u8])], fdate: &str) -> LcmResult {
    let mut lcm = Lcm::new();
    lcm.fdate = fdate.to_string();
    lcm.io.set_stdin(control);
    for (name, bytes) in files {
        lcm.io.add_file(name, bytes.to_vec());
    }
    let r = lcm.lcmodl();
    lcm.io.finish();
    let error = match r {
        Ok(()) => None,
        Err(e) if e.message == "STOP" => None,
        Err(e) => Some(e.message),
    };
    LcmResult { outputs: std::mem::take(&mut lcm.io.outputs), stdout: std::mem::take(&mut lcm.io.stdout), error }
}
