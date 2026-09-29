//! Control input, data input, error messages and initialisation (MYCONT ... ILEN).
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
    pub fn mycont(&mut self) -> R<()> { todo!("MYCONT") }
    pub fn check_zero_voxels(&mut self) -> R<()> { todo!("check_zero_voxels") }
    pub fn average(&mut self) -> R<()> { todo!("average") }
    pub fn restore_settings(&mut self) -> R<()> { todo!("restore_settings") }
    pub fn update_priors(&mut self) -> R<()> { todo!("update_priors") }
    pub fn open_output(&mut self) -> R<()> { todo!("open_output") }
    pub fn loadch(&mut self) -> R<()> { todo!("LOADCH") }
    pub fn initia(&mut self) -> R<()> { todo!("INITIA") }
    pub fn datain(&mut self) -> R<()> { todo!("DATAIN") }
    pub fn errmes(&mut self, number: i32, ilevel: i32, chsubp: &str) -> R<()> { todo!("ERRMES") }
}

pub fn ilen(st: &FStr) -> i32 { st.len_trim() as i32 }
pub fn toupper_lower(lupper_out: bool, s: &mut FStr) { todo!("toupper_lower") }
pub fn remove_blank_start(s: &mut FStr) { todo!("remove_blank_start") }
pub fn icycle(j: i32, ndata: i32) -> i32 { todo!("ICYCLE") }
pub fn icycle_r(j: i32, ndata: i32) -> i32 { todo!("ICYCLE_r") }
