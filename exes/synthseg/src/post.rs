#![allow(clippy::needless_range_loop)]
// SynthSeg posterior handling: GaussianBlur(sigma=0.5), left/right flip averaging and postprocess().
// Posteriors are channel-major: `post[c * voxels + mi(x, y, z, dims)]`, 33 channels.
use crate::nifti::Affine;
use crate::volume::{mi, Prepared};

pub const N: usize = 33;
pub const LABELS: [i32; N] = [
    0, 2, 3, 4, 5, 7, 8, 10, 11, 12, 13, 14, 15, 16, 17, 18, 24, 26, 28, 41, 42, 43, 44, 46, 47,
    49, 50, 51, 52, 53, 54, 58, 60,
];
// get_flip_indices(labels, n_neutral_labels=19): channel of the contralateral structure.
const FLIP: [usize; N] = [
    0, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 11, 12, 13, 29, 30, 16, 31, 32, 1, 2, 3, 4, 5, 6, 7,
    8, 9, 10, 14, 15, 17, 18,
];
// synthseg_topological_classes_2.0.npy[unique_idx]; class 0 is exempt.
const TOPOLOGY: [u8; N] = [
    0, 4, 4, 4, 4, 5, 5, 6, 7, 8, 9, 1, 2, 3, 10, 11, 0, 12, 13, 14, 14, 14, 14, 15, 15, 16, 17,
    18, 19, 20, 21, 22, 23,
];

/// GaussianBlur(sigma=0.5): 3x3x3 kernel with zero padding, per channel, in place. The kernel is an
/// outer product of the 1-D kernel, so three separable passes; channels run on all cores.
pub fn blur(post: &mut [f32], d: &[usize; 3], threads: usize) {
    let side = (-1.0f64 / (2.0 * 0.25)).exp();
    let k = [
        (side / (1.0 + 2.0 * side)) as f32,
        (1.0 / (1.0 + 2.0 * side)) as f32,
    ];
    let voxels = d[0] * d[1] * d[2];
    let strides = [d[1] * d[2], d[2], 1];
    let per = N.div_ceil(threads.max(1));
    // wasm32 has no threads, so a single-threaded run must not reach std::thread::spawn.
    if threads <= 1 {
        for chunk in post.chunks_mut(per * voxels) {
            blur_chunk(chunk, d, &strides, k, voxels);
        }
        return;
    }
    std::thread::scope(|s| {
        for chunk in post.chunks_mut(per * voxels) {
            s.spawn(move || blur_chunk(chunk, d, &strides, k, voxels));
        }
    });
}

fn blur_chunk(chunk: &mut [f32], d: &[usize; 3], strides: &[usize; 3], k: [f32; 2], voxels: usize) {
    let mut tmp = vec![0f32; voxels];
    for dst in chunk.chunks_mut(voxels) {
        for axis in 0..3 {
            let (n, stride) = (d[axis], strides[axis]);
            for (i, t) in tmp.iter_mut().enumerate() {
                let pos = i / stride % n;
                let mut v = dst[i] * k[1];
                if pos > 0 {
                    v += dst[i - stride] * k[0];
                }
                if pos + 1 < n {
                    v += dst[i + stride] * k[0];
                }
                *t = v;
            }
            dst.copy_from_slice(&tmp);
        }
    }
}

/// post = 0.5 * (post + flipped_back_and_reordered(other)); `other` came from the x-flipped input.
pub fn average_flipped(post: &mut [f32], other: &[f32], d: &[usize; 3]) {
    let voxels = d[0] * d[1] * d[2];
    let slab = d[1] * d[2];
    for c in 0..N {
        let src = &other[FLIP[c] * voxels..(FLIP[c] + 1) * voxels];
        let dst = &mut post[c * voxels..(c + 1) * voxels];
        for x in 0..d[0] {
            let (a, b) = (x * slab, (d[0] - 1 - x) * slab);
            for i in 0..slab {
                dst[a + i] = 0.5 * (dst[a + i] + src[b + i]);
            }
        }
    }
}

// scipy.ndimage.label with the default (6-connected) structure, keeping the largest component.
fn largest_component(mask: &mut [bool], d: &[usize; 3]) {
    let n = mask.len();
    let mut comp = vec![0u32; n];
    let (mut best, mut best_id, mut id) = (0usize, 0u32, 0u32);
    let mut stack = Vec::new();
    for s in 0..n {
        if !mask[s] || comp[s] != 0 {
            continue;
        }
        id += 1;
        comp[s] = id;
        stack.push(s);
        let mut size = 0;
        while let Some(i) = stack.pop() {
            size += 1;
            let (z, rest) = (i % d[2], i / d[2]);
            let (y, x) = (rest % d[1], rest / d[1]);
            let mut visit = |j: usize| {
                if mask[j] && comp[j] == 0 {
                    comp[j] = id;
                    stack.push(j);
                }
            };
            if x > 0 {
                visit(i - d[1] * d[2]);
            }
            if x + 1 < d[0] {
                visit(i + d[1] * d[2]);
            }
            if y > 0 {
                visit(i - d[2]);
            }
            if y + 1 < d[1] {
                visit(i + d[2]);
            }
            if z > 0 {
                visit(i - 1);
            }
            if z + 1 < d[2] {
                visit(i + 1);
            }
        }
        if size > best {
            best = size;
            best_id = id;
        }
    }
    for i in 0..n {
        mask[i] = comp[i] == best_id && best_id != 0;
    }
}

fn crop(post: &[f32], p: &Prepared) -> Vec<f32> {
    let (pd, al, o) = (&p.padded, &p.aligned, &p.offsets);
    let (pv, av) = (pd[0] * pd[1] * pd[2], al[0] * al[1] * al[2]);
    let mut out = vec![0f32; N * av];
    for c in 0..N {
        for x in 0..al[0] {
            for y in 0..al[1] {
                let src = c * pv + mi(x + o[0], y + o[1], o[2], pd);
                let dst = c * av + mi(x, y, 0, al);
                out[dst..dst + al[2]].copy_from_slice(&post[src..src + al[2]]);
            }
        }
    }
    out
}

fn mask_foreground(post: &mut [f32], d: &[usize; 3]) {
    let voxels = d[0] * d[1] * d[2];
    let mut mask: Vec<bool> = (0..voxels)
        .map(|v| (1..N).map(|c| post[c * voxels + v]).sum::<f32>() > 0.25)
        .collect();
    largest_component(&mut mask, d);
    for c in 1..N {
        for v in 0..voxels {
            if !mask[v] {
                post[c * voxels + v] = 0.0;
            }
        }
    }
}

/// Labels in aligned space (`mi` order) and mri_synthseg `--vol` volumes in its CSV column order:
/// total intracranial first, then each non-background label in `LABELS[1..]` order, in mm³.
pub struct Segmentation {
    pub labels: Vec<i32>,
    pub volumes_mm3: [f64; N],
}

/// SynthSeg postprocess() on padded posteriors.
pub fn segment(post: Vec<f32>, p: &Prepared, fast: bool) -> Segmentation {
    let mut post = post;
    let mut d = p.padded;
    if fast {
        post = crop(&post, p);
        d = p.aligned;
    }
    mask_foreground(&mut post, &d);
    let voxels = d[0] * d[1] * d[2];
    if fast {
        for v in voxels..N * voxels {
            if post[v] <= 0.2 {
                post[v] = 0.0;
            }
        }
    } else {
        let mut mask = vec![false; voxels];
        for class in 1..=*TOPOLOGY.iter().max().unwrap() {
            let channels: Vec<usize> = (0..N).filter(|&c| TOPOLOGY[c] == class).collect();
            for v in 0..voxels {
                mask[v] = channels.iter().any(|&c| post[c * voxels + v] > 0.25);
            }
            largest_component(&mut mask, &d);
            for &c in &channels {
                for v in 0..voxels {
                    if !mask[v] {
                        post[c * voxels + v] = 0.0;
                    }
                }
            }
        }
        post = crop(&post, p);
        d = p.aligned;
    }
    let voxels = d[0] * d[1] * d[2];
    let mut sums = [0f64; N];
    // Dividing by the channel sum does not move the argmax; an all-zero voxel is NaN in NumPy and argmax gives 0.
    let labels = (0..voxels)
        .map(|v| {
            let mut best = 0;
            let mut total = post[v] as f64;
            for c in 1..N {
                total += post[c * voxels + v] as f64;
                if post[c * voxels + v] > post[best * voxels + v] {
                    best = c;
                }
            }
            if total > 0.0 {
                for c in 1..N {
                    sums[c] += post[c * voxels + v] as f64 / total;
                }
            }
            LABELS[best]
        })
        .collect();
    Segmentation {
        labels,
        volumes_mm3: volumes(sums, voxel_mm3(&p.affine)),
    }
}

// The output grid's voxel volume: 1 mm³ after resampling, otherwise the input's own spacing.
fn voxel_mm3(affine: &Affine) -> f64 {
    (0..3)
        .map(|a| {
            (0..3)
                .map(|r| affine[r][a] * affine[r][a])
                .sum::<f64>()
                .sqrt()
        })
        .product()
}

// postprocess(): volumes = np.around(sum of normalised posteriors * prod(im_res), 3); index 0 holds
// the total intracranial volume, the sum of every non-background channel.
fn volumes(sums: [f64; N], voxel_mm3: f64) -> [f64; N] {
    let round = |v: f64| (v * voxel_mm3 * 1000.0).round() / 1000.0;
    let mut out = sums.map(round);
    out[0] = round(sums[1..].iter().sum());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn prepared(aligned: [usize; 3], affine: Affine) -> Prepared {
        Prepared {
            input: Vec::new(),
            padded: aligned,
            aligned,
            offsets: [0; 3],
            axes: [0, 1, 2],
            flips: [false; 3],
            dims: aligned,
            affine,
            codes: [0, 2],
            units: 2,
        }
    }

    #[test]
    fn volumes_sum_normalised_posteriors_times_voxel_volume() {
        let d = [2, 2, 2];
        let voxels = 8;
        let mut post = vec![0f32; N * voxels];
        // Channel sums of 2 per voxel, so normalisation halves every posterior.
        for v in 0..voxels {
            post[v] = 0.5;
            post[voxels + v] = 0.9;
            post[2 * voxels + v] = 0.6;
        }
        let affine = [
            [2.0, 0.0, 0.0, 0.0],
            [0.0, 0.0, 1.5, 0.0],
            [0.0, 1.0, 0.0, 0.0],
        ];
        let seg = segment(post, &prepared(d, affine), true);
        assert_eq!(seg.labels, vec![LABELS[1]; voxels]);
        let voxel = 2.0 * 1.0 * 1.5;
        assert!((seg.volumes_mm3[1] - 8.0 * 0.45 * voxel).abs() < 1e-3);
        assert!((seg.volumes_mm3[2] - 8.0 * 0.3 * voxel).abs() < 1e-3);
        assert!((seg.volumes_mm3[0] - 8.0 * 0.75 * voxel).abs() < 1e-3);
        assert!(seg.volumes_mm3[3..].iter().all(|&v| v == 0.0));
    }

    #[test]
    fn volumes_round_to_three_decimals() {
        let mut sums = [0f64; N];
        sums[1] = 1.23456;
        sums[2] = 2.00004;
        let v = volumes(sums, 1.0);
        assert_eq!(v[1], 1.235);
        assert_eq!(v[2], 2.0);
        assert_eq!(v[0], 3.235);
    }
}
