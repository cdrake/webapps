//! FFTs (FFTPACK), PNNLS, the incomplete beta function, eigenvalues and other numerical kernels.
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

pub fn cfft(datat: &[C32], ft: &mut [C32], n: i32, lwfft: &mut i32, wfftc: &mut [f32]) { todo!("CFFT") }
pub fn cfft_r(datat: &[C32], ft: &mut [C32], n: i32, lwfft: &mut i32, wfftc: &mut [f32]) { todo!("CFFT_r") }
pub fn cfftin(ft: &[C32], ftinv: &mut [C32], n: i32, lwfft: &mut i32, wfftc: &mut [f32]) { todo!("CFFTIN") }
pub fn cfftin_r(ft: &[C32], ftwork: &mut [C32], ftinv: &mut [C32], n: i32, lwfft: &mut i32, wfftc: &mut [f32]) { todo!("CFFTIN_r") }
pub fn seqtot(datat: &mut [C32], dataf: &mut [C32], nunfil: i32, lwfft: &mut i32, wfftc: &mut [f32]) { todo!("SEQTOT") }
pub fn csft_r(datat: &[C32], ft: &mut [C32], ncap: i32) { todo!("csft_r") }
pub fn csftin_r(ft: &[C32], ftwork: &mut [C32], ftinv: &mut [C32], ncap: i32) { todo!("csftin_r") }
pub fn dcfft_r(datat: &[C64], ft: &mut [C64], n: i32, ldwfft: &mut i32, dwfftc: &mut [f64]) { todo!("DCFFT_R") }
pub fn random(dix: &mut f64) -> f32 { todo!("RANDOM") }
pub fn fishni(f: f32, df1: f32, df2: f32, nout: i32, q: &mut ErrQueue) -> R<f32> { todo!("FISHNI") }
pub fn betain(x: f32, a: f32, b: f32, nout: i32, q: &mut ErrQueue) -> R<f32> { todo!("BETAIN") }
pub fn dgamln(xarg: f64) -> f64 { todo!("DGAMLN") }
pub fn diff(x: f64, y: f64) -> f64 { todo!("DIFF") }
pub fn pnnls(a: &mut [f64], mda: i32, m: i32, n: i32, b: &mut [f64], x: &mut [f64], dvar: &mut f64, w: &mut [f64], zz: &mut [f64], index: &mut [i32], mode: &mut i32, range: f64, nonneg: &[bool], dvarac: f64, nsetp: &mut i32, q: &mut ErrQueue) -> R<()> { todo!("PNNLS") }
pub fn plprin(x: &[f32], y1: &[f32], y2: &[f32], n: i32, only1: bool, nout: i32, srange: f32, nlinf: i32, ng: i32, my1: i32, yerr: &[f64], plterr: bool, io: &mut Units) { todo!("PLPRIN") }
pub fn eigvrs(nm: i32, n: i32, a: &[f32], w: &mut [f32], z: &mut [f32], fv1: &mut [f32], fv2: &mut [f32], ierr: &mut i32) { todo!("EIGVrs") }
