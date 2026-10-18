// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of
// the MPL was not distributed with this file, You can obtain one at http://mozilla.org/MPL/2.0/.

//! C ABI for the degibbs app. JavaScript copies Float32 voxels in, one or more volumes at a time,
//! and reads the corrected voxels back.

use dwi_degibbs::{Options, unring_volume};

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

/// Removes Gibbs ringing from `frames` volumes of `nx` × `ny` × `nz` voxels (first index
/// fastest), with in-plane axes `axis_a` and `axis_b`. Returns non-zero for invalid axes or
/// options.
///
/// # Safety
/// `data` and `out` must each address `nx * ny * nz * frames` f32 values.
#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn degibbs(
    data: *const f32,
    nx: usize,
    ny: usize,
    nz: usize,
    frames: usize,
    axis_a: usize,
    axis_b: usize,
    nshifts: usize,
    min_w: usize,
    max_w: usize,
    out: *mut f32,
) -> u32 {
    if axis_a > 2 || axis_b > 2 || axis_a == axis_b || nshifts == 0 || min_w >= max_w {
        return 1;
    }
    let len = nx * ny * nz * frames;
    let data = unsafe { std::slice::from_raw_parts(data, len) };
    let options = Options {
        nshifts,
        min_w,
        max_w,
    };
    let fixed = unring_volume(data, [nx, ny, nz], frames, [axis_a, axis_b], options);
    unsafe { std::slice::from_raw_parts_mut(out, len) }.copy_from_slice(&fixed);
    0
}
