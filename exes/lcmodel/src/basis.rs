//! Basis set input and preparation (MYBASI ... COMBIS).
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
    pub fn mybasi(&mut self, lstage: i32) -> R<()> { todo!("MYBASI") }
    pub fn combis(&mut self) -> R<()> { todo!("COMBIS") }
    pub fn areawa(&mut self, istage: i32) -> R<f32> { todo!("areawa") }
}
