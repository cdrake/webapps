// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of
// the MPL was not distributed with this file, You can obtain one at http://mozilla.org/MPL/2.0/.

//! Runs the port on raw little-endian float32 voxels, for comparison with MRtrix `mrdegibbs`:
//! cargo run --release -p dwi-degibbs --example raw -- IN OUT NX NY NZ FRAMES
use dwi_degibbs::{Options, unring_volume};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let [_, input, output, nx, ny, nz, frames] = args.as_slice() else {
        panic!("usage: raw IN OUT NX NY NZ FRAMES");
    };
    let dims = [nx, ny, nz].map(|v| v.parse::<usize>().unwrap());
    let frames: usize = frames.parse().unwrap();
    let bytes = std::fs::read(input).unwrap();
    let data: Vec<f32> = bytes
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .collect();
    let start = std::time::Instant::now();
    let out = unring_volume(&data, dims, frames, [0, 1], Options::default());
    eprintln!("{} slices in {:?}", dims[2] * frames, start.elapsed());
    let bytes: Vec<u8> = out.iter().flat_map(|v| v.to_le_bytes()).collect();
    std::fs::write(output, bytes).unwrap();
}
