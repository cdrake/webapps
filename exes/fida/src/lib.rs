//! A Rust port of FID-A (Jamie Near et al., MRM 2021; BSD-3-Clause) input and
//! processing functions for single-voxel MR spectroscopy: vendor readers, coil
//! combination, removal of bad averages, spectral registration, averaging,
//! phasing and referencing, and output of LCModel .RAW files.
//!
//! `Spectra` mirrors the FID-A data structure. Each function names the FID-A
//! function it ports; they reproduce FID-A's results on the same inputs
//! (see tests/ and validation/).

pub mod io;
pub mod ops;
pub mod spectra;

pub use spectra::{Dims, Flags, Spectra};
