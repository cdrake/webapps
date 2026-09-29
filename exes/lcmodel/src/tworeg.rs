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

impl Lcm {
    pub fn tworeg(&mut self) -> R<()> { todo!("TWOREG") }
    pub fn ssrang(&mut self, irange: i32) -> R<()> { todo!("SSRANG") }
    pub fn ldegmx(&mut self, idegmx: i32) -> R<bool> { todo!("LDEGMX") }
}

pub fn get_field(chseparator: &str, len_chseparator: i32, ifield_type: i32, iatend: i32, chreturn: &mut FStr, freturn: &mut f32, istart: &mut i32, len_string_in: i32, string_in: &FStr, q: &mut ErrQueue) -> R<()> { todo!("get_field") }
pub fn nextre(parnl: &[f64], nside2: i32, dpy: &mut [f64], dgauss: &[f64], thrlin: f32, imethd: i32) -> i32 { todo!("NEXTRE") }
pub fn inflec(parnl: &[f64], nside2: i32, dpy: &mut [f64], dgauss: &[f64], thrlin: f32, imethd: i32) -> i32 { todo!("INFLEC") }
