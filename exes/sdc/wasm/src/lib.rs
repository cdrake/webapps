//! C ABI for the sdc app. JavaScript copies two Float64 volumes in and reads the field in Hz and
//! the two corrected images back.

use sdc_core::{Pair, hysco};

#[unsafe(no_mangle)]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let mut bytes = Vec::<u8>::with_capacity(len);
    let ptr = bytes.as_mut_ptr();
    std::mem::forget(bytes);
    ptr
}

/// # Safety
/// `ptr`/`len` must come from a matching `alloc`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    drop(unsafe { Vec::from_raw_parts(ptr, 0, len) });
}

/// Runs PyHySCO on two `nx` × `ny` × `nz` volumes (first index fastest) with opposite
/// phase-encoding directions along axis `pe` (0 or 1). `pe_sign` is image 1's direction (+1 or
/// -1), `trt` its TotalReadoutTime in seconds and `vx`, `vy`, `vz` the voxel sizes in mm.
/// Returns the number of Gauss-Newton iterations, or 0 for invalid input.
///
/// # Safety
/// `image1`, `image2`, `field`, `corrected1` and `corrected2` must each address
/// `nx * ny * nz` f64 values.
#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn pyhysco(
    image1: *const f64,
    image2: *const f64,
    nx: usize,
    ny: usize,
    nz: usize,
    vx: f64,
    vy: f64,
    vz: f64,
    pe: usize,
    pe_sign: f64,
    trt: f64,
    field: *mut f64,
    corrected1: *mut f64,
    corrected2: *mut f64,
) -> u32 {
    let n = nx * ny * nz;
    let pair = Pair {
        image1: unsafe { std::slice::from_raw_parts(image1, n) },
        image2: unsafe { std::slice::from_raw_parts(image2, n) },
        dims: [nx, ny, nz],
        voxel: [vx, vy, vz],
        pe,
        pe_sign,
        total_readout_time: trt,
    };
    let Ok(out) = sdc_core::pyhysco(&pair, &hysco::Options::default()) else {
        return 0;
    };
    unsafe { std::slice::from_raw_parts_mut(field, n) }.copy_from_slice(&out.field_hz);
    unsafe { std::slice::from_raw_parts_mut(corrected1, n) }.copy_from_slice(&out.corrected1);
    unsafe { std::slice::from_raw_parts_mut(corrected2, n) }.copy_from_slice(&out.corrected2);
    (out.loss.len() - 1).max(1) as u32
}
