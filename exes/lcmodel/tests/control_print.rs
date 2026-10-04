//! MYCONT, RESTORE_SETTINGS, OPEN_OUTPUT and LOADCH against the native
//! gfortran build: the head of its .PRINT file (title block, NAMELIST
//! /LCMODeL/ dump and the table of input changes), up to the output of INITIA.
//! Reference: `lcmodel < tests/data/control_print.control` (lcm-test data).

#[test]
fn print_file_head_matches_gfortran() {
    let control = include_str!("data/control_print.control");
    let expected = include_str!("data/control_print_head.txt");
    let mut lcm = lcmodel::Lcm::new();
    lcm.fdate = "Tue Sep 29 17:44:38 2026".to_string();
    lcm.io.set_stdin(control);
    // Set by the main program before MYCONT.
    lcm.c.version_lcm.set("6.3-1N");
    lcm.c.versio.set("LCModel (Version 6.3-1N) Copyright: S.W. Provencher.          Ref.: Magn. Reson. Med. 30:672-679 (1993).");
    lcm.mycont().unwrap();
    lcm.c.single_voxel = true;
    lcm.c.voxel1 = true;
    lcm.restore_settings().unwrap();
    lcm.open_output().unwrap();
    lcm.loadch().unwrap();
    lcm.io.finish();
    let got = lcm.io.outputs.get("out.print").expect("out.print written");
    let got: Vec<&str> = got.lines().collect();
    let want: Vec<&str> = expected.lines().collect();
    assert_eq!(got.len(), want.len());
    for (k, (a, b)) in got.iter().zip(want.iter()).enumerate() {
        assert_eq!(a, b, "line {}", k + 1);
    }
    // Header lines of .COORD and .TABLE.
    let coord = &lcm.io.outputs["out.coord"];
    assert!(coord.starts_with(" LCModel (Version 6.3-1N) Copyright"));
    let table = &lcm.io.outputs["out.table"];
    assert_eq!(table.lines().next().unwrap(), " LCModel (Version 6.3-1N)");
}

/// The reference files store runs of 4 or more blanks as `~N~`.
fn expand_blanks(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut parts = s.split('~');
    out.push_str(parts.next().unwrap());
    while let Some(n) = parts.next() {
        out.push_str(&" ".repeat(n.parse().unwrap()));
        out.push_str(parts.next().unwrap());
    }
    out
}

/// Head, NAMELIST members (in order) and tail of a .PRINT head.
type Parts = (Vec<String>, Vec<(String, Vec<String>)>, Vec<String>);

fn split_print(lines: &[&str]) -> Parts {
    let mut head = Vec::new();
    let mut members: Vec<(String, Vec<String>)> = Vec::new();
    let mut tail = Vec::new();
    let mut state = 0;
    for l in lines {
        match state {
            0 => {
                head.push(l.to_string());
                if l.starts_with("&LCMODL") {
                    state = 1;
                }
            }
            1 => {
                if *l == " /" {
                    state = 2;
                    tail.push(l.to_string());
                    continue;
                }
                let is_member = l.len() > 1 && l.as_bytes()[1].is_ascii_uppercase() && l.find('=').map(|e| l[1..e].bytes().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == b'_')).unwrap_or(false);
                if is_member {
                    let name = l[1..l.find('=').unwrap()].to_string();
                    members.push((name, Vec::new()));
                }
                members.last_mut().unwrap().1.push(l.to_string());
            }
            _ => tail.push(l.to_string()),
        }
    }
    (head, members, tail)
}

/// Every SPTYPE and the MYCONT option branches, with MERMES=8000 so that the
/// full NAMELIST /LCMODL/ is dumped after MYCONT. References from the native
/// build (tests/data/control_sptype, written by tests/data/control_sptype.py): default.print is whole; the other .print files hold the head,
/// the members that differ from default and the tail.
#[test]
fn sptype_settings_match_gfortran() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/data/control_sptype");
    let default_text = expand_blanks(&std::fs::read_to_string(dir.join("default.print")).unwrap());
    let default_lines: Vec<&str> = default_text.lines().collect();
    let (_, default_members, _) = split_print(&default_lines);
    let mut n = 0;
    let mut names: Vec<_> = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().path()).filter(|p| p.extension().map(|e| e == "control").unwrap_or(false)).collect();
    names.sort();
    for path in names {
        let control = std::fs::read_to_string(&path).unwrap();
        let stored = expand_blanks(&std::fs::read_to_string(path.with_extension("print")).unwrap());
        let want: Vec<String> = if stored.starts_with("@@HEAD") {
            let mut sections: Vec<(String, Vec<String>)> = Vec::new();
            for l in stored.lines() {
                if let Some(tag) = l.strip_prefix("@@") {
                    sections.push((tag.to_string(), Vec::new()));
                } else {
                    sections.last_mut().unwrap().1.push(l.to_string());
                }
            }
            let mut out = sections[0].1.clone();
            for (name, lines) in &default_members {
                let tag = format!("MEMBER {name}");
                match sections.iter().find(|(t, _)| *t == tag) {
                    Some((_, l)) => out.extend(l.iter().cloned()),
                    None => out.extend(lines.iter().cloned()),
                }
            }
            out.extend(sections.last().unwrap().1.iter().cloned());
            out
        } else {
            stored.lines().map(|l| l.to_string()).collect()
        };
        let mut lcm = lcmodel::Lcm::new();
        // The run date of the reference.
        lcm.fdate = want.iter().find(|l| l.ends_with(" 2026")).unwrap().trim().to_string();
        lcm.io.set_stdin(&control);
        lcm.c.version_lcm.set("6.3-1N");
        lcm.c.versio.set("LCModel (Version 6.3-1N) Copyright: S.W. Provencher.          Ref.: Magn. Reson. Med. 30:672-679 (1993).");
        lcm.mycont().unwrap();
        lcm.c.single_voxel = true;
        lcm.c.voxel1 = true;
        lcm.restore_settings().unwrap();
        lcm.open_output().unwrap();
        lcm.loadch().unwrap();
        lcm.io.finish();
        let got = &lcm.io.outputs["out.print"];
        let got: Vec<&str> = got.lines().collect();
        assert!(got.len() <= want.len(), "{path:?}: {} lines, expected {}", got.len(), want.len());
        for (k, (a, b)) in got.iter().zip(want.iter()).enumerate() {
            assert_eq!(a, b, "{path:?} line {}", k + 1);
        }
        assert!(want.len() - got.len() <= 3, "{path:?}: {} of {} lines", got.len(), want.len());
        n += 1;
    }
    assert!(n >= 20);
}

#[test]
fn check_zero_voxels_flags_empty_voxels() {
    let mut raw = String::from(" $NMID\n ID='two voxels', FMTDAT='(2E15.6)'\n $END\n");
    for v in 0..3 {
        for j in 0..64 {
            let x = if v == 1 { 0.0 } else { 1.0e-3 * (j as f32 + 1.0) };
            raw.push_str(&format!("{:15.6E}{:15.6E}\n", x, -x));
        }
    }
    let control = " $LCMODL\n nunfil=64\n deltat=5e-04\n hzpppm=127.786142\n filbas='b'\n filraw='d.raw'\n ndcols=3\n icolen=3\n lps=0\n $END\n";
    let mut lcm = lcmodel::Lcm::new();
    lcm.io.set_stdin(control);
    lcm.io.add_file("d.raw", raw.into_bytes());
    lcm.mycont().unwrap();
    lcm.check_zero_voxels().unwrap();
    assert_eq!((lcm.c.zero_voxel[1], lcm.c.zero_voxel[2], lcm.c.zero_voxel[3]), (false, true, false));
    assert_eq!(lcm.c.datat[64].re, 6.4e-2);
}

#[test]
fn fatal_errmes_before_exitps_matches_gfortran() {
    // LPS > 0 with FILPS blank: ERRMES (3, -4, 'MYCONT'), LPRINT = 6.
    let mut lcm = lcmodel::Lcm::new();
    lcm.io.set_stdin(include_str!("data/control_err.control"));
    let e = lcm.mycont().unwrap_err();
    assert_eq!(e.message, "FATAL ERROR MYCONT 3");
    assert_eq!(lcm.io.stdout, include_str!("data/control_err.stdout"));
}
