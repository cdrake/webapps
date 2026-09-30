//! The browser workflow over the FID-A port: load the dropped files, run
//! FID-A's automatic pipeline for the sequence, and hand LCModel its .RAW and
//! .H2O text. Kept free of the C ABI so it is tested natively.

use fida::io::detect::{self, Format, LoadOptions, NamedFile};
use fida::io::lcm;
use fida::ops::align::{op_align_averages, AlignTo};
use fida::ops::averaging::op_averaging;
use fida::ops::basic::op_complex_conj;
use fida::ops::pipeline::{run_pressproc_auto, run_specialproc_auto, PressOptions, SpecialOptions};
use fida::ops::quality::{op_get_lw, op_get_snr};
use fida::Spectra;
use serde_json::{json, Value};

/// One metabolite acquisition with its water reference, as loaded.
pub struct Dataset {
    pub name: String,
    pub format: Format,
    pub water_name: Option<String>,
    pub metab: Spectra,
    pub water: Option<Spectra>,
}

/// Sequence families that decide the pipeline and the basis set.
pub fn family(seq: &str) -> &'static str {
    let s = seq.to_ascii_lowercase();
    if s.contains("special") {
        "SPECIAL"
    } else if s.contains("slaser") || s.contains("semi") && s.contains("laser") {
        "sLASER"
    } else if s.contains("laser") {
        "LASER"
    } else if s.contains("steam") || s.contains("svs_st") {
        "STEAM"
    } else if s.contains("mega") || s.contains("edit") {
        "MEGA-PRESS"
    } else if s.contains("press") || s.contains("svs_se") || s.contains("probe") {
        "PRESS"
    } else {
        ""
    }
}

fn size_of(s: &Spectra, dim: usize) -> usize {
    if dim == 0 {
        1
    } else {
        s.size(dim)
    }
}

/// What the interface shows about a dataset and uses to pick a basis set.
pub fn header(s: &Spectra) -> Value {
    json!({
        "points": s.n(),
        "spectralWidthHz": s.spectralwidth,
        "dwellTime": s.dwelltime,
        "hzpppm": s.txfrq / 1e6,
        "fieldT": s.bo,
        "teMs": s.te,
        "trMs": s.tr,
        "sequence": s.seq,
        "family": family(&s.seq),
        "coils": size_of(s, s.dims.coils),
        "averages": size_of(s, s.dims.averages),
        "subspectra": size_of(s, s.dims.sub_specs),
    })
}

/// Detect and load every dataset among `files`. Returns the datasets and a
/// JSON summary (including per-file problems) for the interface.
pub fn load(files: &[(String, &[u8])]) -> (Vec<Dataset>, Value) {
    let named: Vec<NamedFile> = files.iter().map(|(n, b)| NamedFile { name: n.as_str(), bytes: b }).collect();
    let (det, loaded) = detect::load_all(&named, &LoadOptions::default());
    let mut datasets = Vec::new();
    let mut summary = Vec::new();
    let mut errors = Vec::new();
    for (pair, (metab, water)) in det.pairs.iter().zip(loaded) {
        let metab = match metab {
            Ok(m) => m,
            Err(e) => {
                errors.push(json!({ "file": pair.metabolite.name, "error": e }));
                continue;
            }
        };
        let mut water_name = pair.water.as_ref().map(|w| w.name.clone());
        let water = match water {
            Some(Ok(w)) => Some(w.out),
            Some(Err(e)) => {
                errors.push(json!({ "file": water_name.clone().unwrap_or_default(), "error": e }));
                water_name = None;
                None
            }
            None => None,
        };
        // A water reference stored in the metabolite file (twix, GE frames, Bruker).
        let (water, water_name) = match (water, metab.embedded_water) {
            (Some(w), _) => (Some(w), water_name),
            (None, Some(w)) if w.n() > 0 => (Some(w), Some(format!("{} (water frames)", pair.metabolite.name))),
            _ => (None, None),
        };
        summary.push(json!({
            "index": datasets.len(),
            "name": pair.metabolite.name,
            "format": pair.metabolite.format.label(),
            "water": water_name,
            "header": header(&metab.out),
        }));
        datasets.push(Dataset { name: pair.metabolite.name.clone(), format: pair.metabolite.format, water_name, metab: metab.out, water });
    }
    let ignored: Vec<Value> = det.ignored.iter().map(|(n, why)| json!({ "file": n, "reason": why })).collect();
    let unpaired: Vec<Value> = det.unpaired_water.iter().map(|d| json!(d.name)).collect();
    (datasets, json!({ "datasets": summary, "errors": errors, "ignored": ignored, "unpairedWater": unpaired }))
}

/// Preprocessing choices from the interface (FID-A defaults when absent).
#[derive(Clone, Debug)]
pub struct Options {
    pub remove_bad_averages: bool,
    pub bad_average_sd: Option<f64>,
    pub drift_correction: bool,
    pub phase_and_reference: bool,
}

impl Options {
    pub fn from_json(v: &Value) -> Options {
        Options {
            remove_bad_averages: v["removeBadAverages"].as_bool().unwrap_or(true),
            bad_average_sd: v["badAverageSd"].as_f64(),
            drift_correction: v["driftCorrection"].as_bool().unwrap_or(true),
            phase_and_reference: v["phaseAndReference"].as_bool().unwrap_or(true),
        }
    }
}

pub struct Processed {
    pub metab: Spectra,
    pub water: Option<Spectra>,
    pub unprocessed: Spectra,
    pub report: Value,
}

/// Run FID-A's pipeline for the dataset's sequence.
pub fn process(ds: &Dataset, opts: &Options, progress: &mut dyn FnMut(&str, f32), cancelled: &dyn Fn() -> bool) -> Result<Processed, String> {
    // run_pressproc_GEauto conjugates GE data after reading (GE files are
    // small; other data are used in place, since twix data can be ~300 MB).
    let conj = ds.format == Format::GePfile;
    let conj_metab;
    let conj_water;
    let (metab, water): (&Spectra, Option<&Spectra>) = if conj {
        conj_metab = op_complex_conj(&ds.metab);
        conj_water = ds.water.as_ref().map(op_complex_conj);
        (&conj_metab, conj_water.as_ref())
    } else {
        (&ds.metab, ds.water.as_ref())
    };
    let fam = family(&ds.metab.seq);
    let has_coils = metab.dims.coils > 0 && metab.size(metab.dims.coils) > 1;
    if !has_coils {
        return process_combined(metab, water, opts, progress);
    }
    if metab.dims.sub_specs > 0 && fam != "SPECIAL" {
        return Err("These data have subspectra (edited MEGA-PRESS?). Only non-edited and SPECIAL data can be preprocessed here; export the edit-off or summed spectrum as NIfTI-MRS or .RAW.".into());
    }
    let out = if fam == "SPECIAL" {
        let mut o = SpecialOptions::default();
        o.rm_bad_averages.enabled = opts.remove_bad_averages;
        if let Some(sd) = opts.bad_average_sd {
            o.rm_bad_averages.nsd = sd;
        }
        o.drift.enabled = opts.drift_correction;
        apply_phase_ref_special(&mut o, opts.phase_and_reference);
        run_specialproc_auto(metab, water, &o, progress, cancelled)?
    } else {
        let mut o = PressOptions::default();
        o.rm_bad_averages.enabled = opts.remove_bad_averages;
        if let Some(sd) = opts.bad_average_sd {
            o.rm_bad_averages.nsd = sd;
        }
        o.drift.enabled = opts.drift_correction;
        o.autophase = opts.phase_and_reference;
        o.ppmref = opts.phase_and_reference;
        run_pressproc_auto(metab, water, &o, progress, cancelled)?
    };
    let mut report = out.report.to_json();
    report["conjugated"] = json!(conj);
    Ok(Processed { metab: out.out, water: out.outw, unprocessed: out.out_noproc, report })
}

fn apply_phase_ref_special(o: &mut SpecialOptions, on: bool) {
    o.autophase = on;
    o.ppmref = on;
}

/// Data that arrive coil-combined (RDA, DICOM, NIfTI-MRS, .RAW): align and
/// average transients if there are several; LCModel phases and references.
fn process_combined(metab: &Spectra, water: Option<&Spectra>, opts: &Options, progress: &mut dyn FnMut(&str, f32)) -> Result<Processed, String> {
    let mut warnings = Vec::new();
    let averages = size_of(&metab, metab.dims.averages);
    let unprocessed = op_averaging(metab);
    let mut drift = Value::Null;
    let aligned = if averages > 1 && opts.drift_correction {
        progress("Aligning averages", 0.3);
        let a = op_align_averages(metab, Some(0.25), AlignTo::Best)?;
        drift = json!({ "frequencyHz": a.fs, "phaseDeg": a.phs });
        a.out
    } else {
        metab.clone()
    };
    progress("Averaging", 0.8);
    let out = op_averaging(&aligned);
    let water = water.map(op_averaging);
    if averages <= 1 {
        warnings.push("The data are already coil-combined and averaged; they are fitted as they are.".to_string());
    } else {
        warnings.push("The data are already coil-combined; averages were aligned and averaged.".to_string());
    }
    let report = json!({
        "pipeline": "combined",
        "averagesRaw": averages,
        "drift": drift,
        "snr": op_get_snr(&out, 1.8, 2.2, -2.0, 0.0).ok().map(|s| s.snr),
        "linewidthHz": op_get_lw(&out, 1.8, 2.2, 8.0).ok(),
        "waterLinewidthHz": water.as_ref().and_then(|w| op_get_lw(w, 4.4, 5.0, 8.0).ok()),
        "warnings": warnings,
        "conjugated": false,
    });
    Ok(Processed { metab: out, water, unprocessed, report })
}

/// The real part of a spectrum between `lo` and `hi` ppm, for plotting.
pub fn spectrum_trace(s: &Spectra, lo: f64, hi: f64) -> Value {
    let spec = fida::spectra::spec_of(s.fid(0));
    let mut ppm = Vec::new();
    let mut re = Vec::new();
    for (k, p) in s.ppm.iter().enumerate() {
        if *p >= lo && *p <= hi {
            ppm.push((*p * 1e4).round() / 1e4);
            re.push(spec[k].re);
        }
    }
    json!({ "ppm": ppm, "real": re })
}

/// LCModel inputs for a processed dataset: .RAW text, .H2O text and the
/// acquisition numbers the control file needs.
pub fn lcmodel_inputs(p: &Processed) -> Result<Value, String> {
    let (raw, mut warnings) = lcm::lcm_text_with_warnings(&p.metab, p.metab.te)?;
    let h2o = match &p.water {
        Some(w) => {
            let (t, w2) = lcm::lcm_text_with_warnings(w, w.te)?;
            warnings.extend(w2);
            if w.n() != p.metab.n() || (w.dwelltime - p.metab.dwelltime).abs() > 1e-12 {
                warnings.push("The water reference has a different length or dwell time; it is not used.".into());
                Value::Null
            } else {
                json!(t)
            }
        }
        None => Value::Null,
    };
    Ok(json!({
        "raw": raw,
        "h2o": h2o,
        "nunfil": p.metab.n(),
        "deltat": p.metab.dwelltime,
        "hzpppm": p.metab.txfrq / 1e6,
        "teMs": p.metab.te,
        "warnings": warnings,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn example(rel: &str) -> Option<Vec<u8>> {
        let root = std::env::var("FIDA_EXAMPLES").unwrap_or_else(|_| "/home/ubuntu/src/mrs/FID-A/exampleData".into());
        std::fs::read(format!("{root}/{rel}")).ok()
    }

    #[test]
    fn ge_press_example_runs_through_fida_and_lcmodel() {
        let Some(bytes) = example("GE/sample01_press/press/P17920.7") else {
            eprintln!("skipping: FID-A example data not found");
            return;
        };
        let files = vec![("P17920.7".to_string(), bytes.as_slice())];
        let (ds, summary) = load(&files);
        assert_eq!(ds.len(), 1, "{summary}");
        assert!(ds[0].water.is_some(), "GE water frames: {summary}");
        let p = process(&ds[0], &Options::from_json(&json!({"phaseAndReference": std::env::var("NOREF").is_err()})), &mut |_, _| {}, &|| false).unwrap();
        let inputs = lcmodel_inputs(&p).unwrap();
        assert!(inputs["h2o"].is_string());
        let basis = std::fs::read(format!("{}/basis-out/press-3t-te35.basis", std::env::var("TMPDIR").unwrap_or_default()));
        let Ok(basis) = basis else {
            eprintln!("skipping the fit: no basis set in $TMPDIR/basis-out");
            return;
        };
        let control = format!(
            " $LCMODL\n key=210387309\n lps=0\n nunfil={}\n deltat={:e}\n hzpppm={}\n filbas='b.basis'\n filraw='m.raw'\n filh2o='w.h2o'\n dows=T\n doecc=T\n lcoord=9\n filcoo='out.coord'\n ltable=7\n filtab='out.table'\n $END\n",
            inputs["nunfil"], inputs["deltat"].as_f64().unwrap(), inputs["hzpppm"]
        );
        let raw = inputs["raw"].as_str().unwrap().as_bytes().to_vec();
        let h2o = inputs["h2o"].as_str().unwrap().as_bytes().to_vec();
        let r = lcmodel::run_lcmodel(&control, &[("b.basis", &basis), ("m.raw", &raw), ("w.h2o", &h2o)], "");
        assert!(r.error.is_none(), "{:?}", r.error);
        let table = &r.outputs["out.table"];
        std::fs::write(format!("{}/ge.coord", std::env::var("TMPDIR").unwrap()), &r.outputs["out.coord"]).ok();
        std::fs::write(format!("{}/ge.raw", std::env::var("TMPDIR").unwrap()), &raw).ok();
        eprintln!("{table}");
        assert!(table.contains("NAA"));
    }
}
