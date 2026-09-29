//! Starting values, setup, phasing and background (STARTV ... check_chless).
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
    pub fn startv(&mut self, ipass: i32) -> R<()> { todo!("STARTV") }
    pub fn ftdata(&mut self, ishift: i32) -> R<()> { todo!("FTDATA") }
    pub fn setup(&mut self, lstage: i32) -> R<()> { todo!("SETUP") }
    pub fn check_chless(&mut self) -> R<()> { todo!("check_chless") }
}
