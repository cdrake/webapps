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

/// Tissue classes of the GM, WM and CSF probability maps, by FreeSurfer label, after FreeSurfer's
/// convention. GM is cerebral and cerebellar cortex plus the structures that FreeSurfer's
/// SubCortGrayVol counts: thalamus, caudate, putamen, pallidum, hippocampus, amygdala, accumbens and
/// ventral DC. Ventral DC is mostly grey nuclei (hypothalamus, substantia nigra, red nucleus) with
/// some white matter; it is GM here because SubCortGrayVol counts it. WM is cerebral and cerebellar
/// white matter plus the brainstem, which is mostly white matter; FreeSurfer counts the brainstem in
/// no tissue total. CSF is the ventricles and the extracerebral CSF label. Together the three lists
/// cover every channel except background, so GM + WM + CSF = 1 - P(background).
pub const GM_LABELS: [i32; 20] = [
    3, 42, 8, 47, 10, 49, 11, 50, 12, 51, 13, 52, 17, 53, 18, 54, 26, 58, 28, 60,
];
pub const WM_LABELS: [i32; 5] = [2, 41, 7, 46, 16];
pub const CSF_LABELS: [i32; 7] = [4, 43, 5, 44, 14, 15, 24];
/// File suffixes of the three maps, in `Segmentation::tissues` order.
pub const TISSUES: [&str; 3] = ["gm", "wm", "csf"];

/// Tissue of each channel: 0 GM, 1 WM, 2 CSF, 3 none (background).
fn tissue(label: i32) -> usize {
    [&GM_LABELS[..], &WM_LABELS, &CSF_LABELS]
        .iter()
        .position(|group| group.contains(&label))
        .unwrap_or(3)
}

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
    /// With `tissues`: P(GM), P(WM) and P(CSF) on the label grid (`mi` order over `p.aligned`), the
    /// sums of the normalised posteriors that give the volumes, over GM_LABELS, WM_LABELS, CSF_LABELS.
    pub tissues: Option<[Vec<f32>; 3]>,
}

/// SynthSeg postprocess() on padded posteriors. `tissues` also keeps the GM, WM and CSF maps; the
/// labels and volumes are the same either way.
pub fn segment(post: Vec<f32>, p: &Prepared, fast: bool, tissues: bool) -> Segmentation {
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
    let group = LABELS.map(tissue);
    let mut maps = tissues.then(|| std::array::from_fn(|_| vec![0f32; voxels]));
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
                let mut voxel = [0f64; 4];
                for c in 1..N {
                    let share = post[c * voxels + v] as f64 / total;
                    sums[c] += share;
                    voxel[group[c]] += share;
                }
                if let Some(maps) = maps.as_mut() {
                    for (map, value) in maps.iter_mut().zip(voxel) {
                        map[v] = value as f32;
                    }
                }
            }
            LABELS[best]
        })
        .collect();
    Segmentation {
        labels,
        volumes_mm3: volumes(sums, voxel_mm3(&p.affine)),
        tissues: maps,
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
        let seg = segment(post, &prepared(d, affine), true, false);
        assert!(seg.tissues.is_none());
        assert_eq!(seg.labels, vec![LABELS[1]; voxels]);
        let voxel = 2.0 * 1.0 * 1.5;
        assert!((seg.volumes_mm3[1] - 8.0 * 0.45 * voxel).abs() < 1e-3);
        assert!((seg.volumes_mm3[2] - 8.0 * 0.3 * voxel).abs() < 1e-3);
        assert!((seg.volumes_mm3[0] - 8.0 * 0.75 * voxel).abs() < 1e-3);
        assert!(seg.volumes_mm3[3..].iter().all(|&v| v == 0.0));
    }

    #[test]
    fn tissue_groups_cover_every_foreground_channel_once() {
        for label in GM_LABELS.iter().chain(&WM_LABELS).chain(&CSF_LABELS) {
            assert!(
                LABELS.contains(label),
                "label {label} is not a SynthSeg channel"
            );
        }
        let mut count = [0usize; 4];
        for &label in &LABELS[1..] {
            count[tissue(label)] += 1;
        }
        assert_eq!(count, [20, 5, 7, 0]);
        assert_eq!(tissue(0), 3);
        assert_eq!(tissue(16), 1, "brainstem is WM");
        assert_eq!(tissue(28), 0, "ventral DC is GM");
    }

    // A deterministic pseudo-random posterior: every voxel has its own mix of all 33 channels.
    fn synthetic(voxels: usize) -> Vec<f32> {
        let mut state = 0x2545_f491u32;
        (0..N * voxels)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 17;
                state ^= state << 5;
                (state >> 8) as f32 / (1u32 << 24) as f32
            })
            .collect()
    }

    #[test]
    fn tissue_maps_are_probabilities_that_agree_with_the_labels() {
        let d = [4, 3, 5];
        let voxels = 60;
        let mut post = synthetic(voxels);
        // One empty voxel: every channel zero, so the maps must be zero there too.
        for c in 0..N {
            post[c * voxels + 7] = 0.0;
        }
        let affine = [
            [1.0, 0.0, 0.0, 0.0],
            [0.0, 1.0, 0.0, 0.0],
            [0.0, 0.0, 1.0, 0.0],
        ];
        let p = prepared(d, affine);
        let plain = segment(post.clone(), &p, true, false);
        let seg = segment(post.clone(), &p, true, true);
        assert_eq!(seg.labels, plain.labels);
        assert_eq!(seg.volumes_mm3, plain.volumes_mm3);
        let maps = seg.tissues.expect("tissue maps");
        // Recompute the postprocessed posteriors the maps came from (fast mode: mask, then threshold).
        let mut kept = post;
        mask_foreground(&mut kept, &d);
        for value in kept[voxels..].iter_mut() {
            if *value <= 0.2 {
                *value = 0.0;
            }
        }
        let mut sums = [0f64; 3];
        for v in 0..voxels {
            let values = [maps[0][v], maps[1][v], maps[2][v]];
            assert!(values.iter().all(|x| (0.0..=1.0).contains(x)), "{values:?}");
            assert!(values.iter().sum::<f32>() <= 1.0 + 1e-5);
            let total: f64 = (0..N).map(|c| kept[c * voxels + v] as f64).sum();
            if total == 0.0 {
                assert_eq!(values, [0.0; 3]);
                continue;
            }
            let background = kept[v] as f64 / total;
            assert!(
                (values.iter().map(|&x| x as f64).sum::<f64>() - (1.0 - background)).abs() < 1e-5
            );
            // The labelled channel's own share is part of its tissue's map.
            let label = seg.labels[v];
            if label != 0 {
                let c = LABELS.iter().position(|&l| l == label).unwrap();
                let share = kept[c * voxels + v] as f64 / total;
                assert!(values[tissue(label)] as f64 >= share - 1e-6);
            }
            for (sum, x) in sums.iter_mut().zip(values) {
                *sum += x as f64;
            }
        }
        // The maps sum to the soft volumes of their structures.
        for (t, sum) in sums.iter().enumerate() {
            let expected: f64 = (1..N)
                .filter(|&c| tissue(LABELS[c]) == t)
                .map(|c| seg.volumes_mm3[c])
                .sum();
            assert!(
                (sum - expected).abs() < 0.02,
                "tissue {t}: {sum} != {expected}"
            );
        }
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
