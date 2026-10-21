//! `sdc`: reverse phase-encoding distortion correction from the command line, with the same
//! core as the sdc web app.

use flate2::read::MultiGzDecoder;
use flate2::write::GzEncoder;
use neurodesk_nifti::Nifti1Header;
use neurodesk_nifti::accept::parse;
use sdc_core::{Pair, hysco};
use serde_json::{Value, json};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

const USAGE: &str = "usage: sdc pyhysco <image1.nii[.gz]> <image2.nii[.gz]> <output-prefix>
  [--pe1 i|i-|j|j-] [--pe2 i|i-|j|j-] [--trt seconds]

Estimates the susceptibility field from two b0 images with opposite phase-encoding
directions (PyHySCO 0.0.4 defaults). PhaseEncodingDirection and TotalReadoutTime come
from each image's BIDS sidecar (.json next to it) unless given. A 4D input is averaged
over its volumes, without motion correction: those with b <= 50 when a .bval is next to
it. Image 2 must be in the space of image 1.

Writes <prefix>_fieldmap.nii.gz (Hz) with its sidecar, and <prefix>_corrected1/2.nii.gz
(quality control, PyHySCO's normalized intensities).";

struct Image {
    dims: [usize; 3],
    affine: [[f64; 4]; 3],
    data: Vec<f64>,
    volumes: usize,
    used: usize,
}

/// Volumes with b at or below this are b = 0, as in the app.
const B0_MAX: f64 = 50.0;

/// The image, averaged over the volumes `keep` selects (all when it is `None`).
fn decode(bytes: &[u8], keep: Option<&[bool]>) -> Result<Image, String> {
    let inflated;
    let bytes = if bytes.starts_with(&[0x1f, 0x8b]) {
        let mut out = vec![];
        MultiGzDecoder::new(bytes)
            .read_to_end(&mut out)
            .map_err(|e| format!("corrupt gzip: {e}"))?;
        inflated = out;
        &inflated[..]
    } else {
        bytes
    };
    let h = parse(bytes)?;
    let raw = Nifti1Header::decode(bytes[..348].try_into().unwrap());
    if h.shape.len() < 3 || h.shape.len() > 4 {
        return Err(format!(
            "expected a 3D or 4D image, got shape {:?}",
            h.shape
        ));
    }
    let dims = [h.shape[0], h.shape[1], h.shape[2]];
    let volumes = h.shape.get(3).copied().unwrap_or(1);
    let n: usize = dims.iter().product();
    let count = n.checked_mul(volumes).ok_or("image too large")?;
    let (width, scalar) = raw.scalar_decoder()?;
    let offset = raw.vox_offset as usize;
    if !raw.vox_offset.is_finite()
        || raw.vox_offset < 348.0
        || offset
            .checked_add(count * width)
            .is_none_or(|end| end > bytes.len())
    {
        return Err("voxel data is truncated or vox_offset is invalid".into());
    }
    let (slope, inter) = (raw.scl_slope as f64, raw.scl_inter as f64);
    let scaled = slope.is_finite() && slope != 0.0 && (slope != 1.0 || inter != 0.0);
    if let Some(keep) = keep
        && keep.len() != volumes
    {
        return Err(format!(
            "the bval has {} values for {volumes} volumes",
            keep.len()
        ));
    }
    let used = keep.map_or(volumes, |k| k.iter().filter(|&&b| b).count());
    if used == 0 {
        return Err(format!("no volume with b <= {B0_MAX}"));
    }
    let mut data = vec![0.0; n];
    for (k, c) in bytes[offset..offset + count * width]
        .chunks_exact(width)
        .enumerate()
    {
        if keep.is_some_and(|keep| !keep[k / n]) {
            continue;
        }
        let v = scalar(c);
        data[k % n] += if scaled { v * slope + inter } else { v };
    }
    if used > 1 {
        data.iter_mut().for_each(|v| *v /= used as f64);
    }
    Ok(Image {
        dims,
        affine: h.affine,
        data,
        volumes,
        used,
    })
}

/// float32 NIfTI-1, gzipped: sform from the affine, qform unset.
fn encode(img: &Image, data: &[f64]) -> Vec<u8> {
    let mut b = vec![0u8; 352];
    let put16 = |b: &mut Vec<u8>, o: usize, v: i16| b[o..o + 2].copy_from_slice(&v.to_le_bytes());
    let put32 = |b: &mut Vec<u8>, o: usize, v: f32| b[o..o + 4].copy_from_slice(&v.to_le_bytes());
    b[0..4].copy_from_slice(&348i32.to_le_bytes());
    for (i, d) in [3, img.dims[0], img.dims[1], img.dims[2], 1, 1, 1, 1]
        .iter()
        .enumerate()
    {
        put16(&mut b, 40 + 2 * i, *d as i16);
    }
    put16(&mut b, 70, 16);
    put16(&mut b, 72, 32);
    let zooms = voxel(&img.affine);
    put32(&mut b, 76, 1.0);
    (0..3).for_each(|j| put32(&mut b, 80 + 4 * j, zooms[j] as f32));
    for j in 4..8 {
        put32(&mut b, 76 + 4 * j, 1.0);
    }
    put32(&mut b, 108, 352.0);
    put32(&mut b, 112, 1.0);
    b[123] = 2; // mm
    put16(&mut b, 254, 2);
    for (k, v) in img.affine.iter().flatten().enumerate() {
        put32(&mut b, 280 + 4 * k, *v as f32);
    }
    b[344..348].copy_from_slice(b"n+1\0");
    b.extend(data.iter().flat_map(|v| (*v as f32).to_le_bytes()));
    let mut z = GzEncoder::new(Vec::new(), flate2::Compression::new(6));
    z.write_all(&b)
        .and_then(|_| z.finish())
        .expect("gzip into memory")
}

/// The affine's column lengths, as nibabel's `affine` gives PyHySCO its voxel size.
fn voxel(a: &[[f64; 4]; 3]) -> [f64; 3] {
    std::array::from_fn(|j| (a[0][j].powi(2) + a[1][j].powi(2) + a[2][j].powi(2)).sqrt())
}

fn stem(path: &Path) -> String {
    let name = path.to_string_lossy();
    name.strip_suffix(".nii.gz")
        .or_else(|| name.strip_suffix(".nii"))
        .unwrap_or(&name)
        .to_string()
}

fn sidecar(path: &Path) -> Value {
    std::fs::read_to_string(format!("{}.json", stem(path)))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or(Value::Null)
}

/// The b = 0 volumes from the `.bval` next to the image, if there is one.
fn b0_volumes(path: &Path) -> Result<Option<Vec<bool>>, String> {
    let Ok(text) = std::fs::read_to_string(format!("{}.bval", stem(path))) else {
        return Ok(None);
    };
    text.split_whitespace()
        .map(|v| {
            v.parse::<f64>()
                .map(|b| b <= B0_MAX)
                .map_err(|e| format!("{}.bval: {e}", stem(path)))
        })
        .collect::<Result<Vec<_>, _>>()
        .map(Some)
}

/// "j-" → (1, -1)
fn direction(code: &str) -> Result<(usize, f64), String> {
    let axis = match code.trim_end_matches('-') {
        "i" => 0,
        "j" => 1,
        "k" => return Err("the phase-encoding direction must be i or j, not k".into()),
        _ => return Err(format!("unknown phase-encoding direction {code:?}")),
    };
    Ok((axis, if code.ends_with('-') { -1.0 } else { 1.0 }))
}

fn run(args: &[String]) -> Result<(), String> {
    let mut positional = vec![];
    let (mut pe1, mut pe2, mut trt) = (None, None, None);
    let mut k = 0;
    while k < args.len() {
        let value = || {
            args.get(k + 1)
                .cloned()
                .ok_or(format!("{} needs a value", args[k]))
        };
        match args[k].as_str() {
            "--pe1" => pe1 = Some(value()?),
            "--pe2" => pe2 = Some(value()?),
            "--trt" => trt = Some(value()?.parse::<f64>().map_err(|e| format!("--trt: {e}"))?),
            "-h" | "--help" => return Err(USAGE.into()),
            a => {
                positional.push(a.to_string());
                k += 1;
                continue;
            }
        }
        k += 2;
    }
    let [method, p1, p2, prefix] = positional.as_slice() else {
        return Err(USAGE.into());
    };
    if method != "pyhysco" {
        return Err(format!("unknown method {method:?}\n\n{USAGE}"));
    }
    let (path1, path2) = (PathBuf::from(p1), PathBuf::from(p2));
    let (meta1, meta2) = (sidecar(&path1), sidecar(&path2));
    let text = |v: &Value, key: &str| v.get(key).and_then(Value::as_str).map(str::to_string);
    let pe1 = pe1
        .or_else(|| text(&meta1, "PhaseEncodingDirection"))
        .ok_or("image 1 has no PhaseEncodingDirection: give --pe1")?;
    let pe2 = pe2
        .or_else(|| text(&meta2, "PhaseEncodingDirection"))
        .ok_or("image 2 has no PhaseEncodingDirection: give --pe2")?;
    let readout = |meta: &Value, image| {
        let value = trt.or_else(|| meta.get("TotalReadoutTime").and_then(Value::as_f64));
        value
            .filter(|value| value.is_finite() && *value > 0.0)
            .ok_or_else(|| {
                format!("image {image} needs a finite positive TotalReadoutTime: give --trt")
            })
    };
    let trt1 = readout(&meta1, 1)?;
    let trt2 = readout(&meta2, 2)?;
    if trt1 != trt2 {
        return Err("the images need the same TotalReadoutTime: PyHySCO assumes equal and opposite displacements".into());
    }
    let trt = trt1;
    let (axis1, sign1) = direction(&pe1)?;
    let (axis2, sign2) = direction(&pe2)?;
    if axis1 != axis2 || sign1 == sign2 {
        return Err(format!(
            "the images need opposite directions on one axis, not {pe1} and {pe2}"
        ));
    }
    let read = |p: &Path| {
        std::fs::read(p)
            .map_err(|e| format!("{}: {e}", p.display()))
            .and_then(|b| {
                let keep = b0_volumes(p)?;
                decode(&b, keep.as_deref()).map_err(|e| format!("{}: {e}", p.display()))
            })
    };
    let (im1, im2) = (read(&path1)?, read(&path2)?);
    if im1.dims != im2.dims {
        return Err(format!(
            "image sizes differ: {:?} and {:?}",
            im1.dims, im2.dims
        ));
    }
    for (name, img) in [("image 1", &im1), ("image 2", &im2)] {
        if img.volumes > 1 {
            eprintln!(
                "{name}: averaged {} of {} volumes (b <= {B0_MAX} when a .bval is next to it), without motion correction",
                img.used, img.volumes
            );
        }
    }
    let pair = Pair {
        image1: &im1.data,
        image2: &im2.data,
        dims: im1.dims,
        voxel: voxel(&im1.affine),
        pe: axis1,
        pe_sign: sign1,
        total_readout_time: trt,
    };
    let out = sdc_core::pyhysco(&pair, &hysco::Options::default())?;
    eprintln!(
        "PyHySCO: {} Gauss-Newton iterations, loss {:.6e} -> {:.6e}",
        out.loss.len() - 1,
        out.loss[0],
        out.loss[out.loss.len() - 1]
    );
    let write = |suffix: &str, bytes: &[u8]| {
        let path = format!("{prefix}{suffix}");
        std::fs::write(&path, bytes).map_err(|e| format!("{path}: {e}"))
    };
    write("_fieldmap.nii.gz", &encode(&im1, &out.field_hz))?;
    let meta = json!({
        "Units": "Hz",
        "PhaseEncodingDirection": pe1,
        "TotalReadoutTime": trt,
        "Description": "Susceptibility field from a reverse phase-encoding pair, PyHySCO 0.0.4 defaults, sdc. Sign as FSL topup: image 1 corrected is image1(x + field * TotalReadoutTime * PE sign) voxels.",
    });
    write(
        "_fieldmap.json",
        format!("{}\n", serde_json::to_string_pretty(&meta).unwrap()).as_bytes(),
    )?;
    write("_corrected1.nii.gz", &encode(&im1, &out.corrected1))?;
    write("_corrected2.nii.gz", &encode(&im1, &out.corrected2))?;
    Ok(())
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match run(&args) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("{e}");
            ExitCode::FAILURE
        }
    }
}
