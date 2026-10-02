//! `lcmodel < control.file`, like the Fortran program: reads the control
//! file on standard input, the files it names from disk, and writes the
//! output files it names.
use std::io::Read;

fn main() {
    let mut control = String::new();
    std::io::stdin().read_to_string(&mut control).expect("read control file from stdin");
    let mut lcm = lcmodel::Lcm::new();
    lcm.fdate = fdate();
    lcm.io.set_stdin(&control);
    // Offer every input file the control file can name.
    for name in referenced_files(&control) {
        if let Ok(bytes) = std::fs::read(&name) {
            lcm.io.add_file(&name, bytes);
        }
    }
    let r = lcm.lcmodl();
    lcm.io.finish();
    print!("{}", lcm.io.stdout);
    for (name, text) in &lcm.io.outputs {
        if let Err(e) = std::fs::write(name, text) {
            eprintln!("cannot write {name}: {e}");
        }
    }
    if let Err(e) = r {
        if e.message != "STOP" {
            eprintln!("{}", e.message);
            std::process::exit(1);
        }
    }
}

/// Quoted values in the control file: FILRAW, FILBAS, FILH2O and friends.
fn referenced_files(control: &str) -> Vec<String> {
    let mut out = Vec::new();
    for part in control.split('\'').skip(1).step_by(2) {
        let p = part.trim();
        if !p.is_empty() && std::path::Path::new(p).is_file() {
            out.push(p.to_string());
        }
    }
    out
}

/// The run date as `fdate` writes it ("Tue Sep 29 03:26:46 2026").
fn fdate() -> String {
    if let Ok(d) = std::env::var("LCMODEL_FDATE") {
        return d;
    }
    let out = std::process::Command::new("date").arg("+%a %b %e %H:%M:%S %Y").output();
    match out {
        Ok(o) => String::from_utf8_lossy(&o.stdout).trim().to_string(),
        Err(_) => String::new(),
    }
}
