//! Final output: tables, .COORD, .CSV, and the diagnostics table (FINOUT, EXITPS, ERRTBL).
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

impl Lcm {
    pub fn finout(&mut self) -> R<()> { todo!("FINOUT") }
    pub fn exitps(&mut self, lstop: bool) -> R<()> { todo!("EXITPS") }
}
