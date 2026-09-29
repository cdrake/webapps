//! The nonlinear least-squares analysis (RFALSI ... SAVBES).
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
    pub fn rfalsi(&mut self, ialpha: i32, irange: i32, lrepha: bool, alphb: f64, alphs: f64, assqlo: f32, aalplo: f32, assqhi: f32, aalphi: f32, aalpha: f32, prejok: &mut bool, prej1: &mut f32) -> R<()> { todo!("RFALSI") }
    pub fn rephas(&mut self) -> R<()> { todo!("REPHAS") }
    pub fn fshssq(&mut self, prej: f32, idfish: i32, nyuse: i32, refndf: f32, ssqref: f32, lprint: i32, rrange: f32) -> R<f32> { todo!("FSHSSQ") }
    pub fn plinls(&mut self, istage: i32, ierror: &mut i32) -> R<()> { todo!("PLINLS") }
    pub fn solve(&mut self, lstage: i32, dononl: bool, pmqact: f64, onlyft: bool, lerror: &mut bool) -> R<()> { todo!("SOLVE") }
    pub fn savbes(&mut self, ilevel: i32) -> R<()> { todo!("SAVBES") }
}
