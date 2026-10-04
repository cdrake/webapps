//! The FORMAT interpreter against records written by gfortran 13 from
//! tests/data/gfortran_format.f (`gfortran -std=legacy`).
use lcmodel::format::{write_fmt, FVal};

#[test]
fn matches_gfortran_records() {
    let expected: Vec<&str> = include_str!("data/gfortran_format.txt").lines().collect();
    let xs: [f32; 12] = [1234.5, 0.0839, -0.0839, 1.2e-6, 0., 1.5, 1.5e6, 0.125, 2.5, 99.95, 1.0e-38, 0.05];
    let ds: [f64; 6] = [1234.5, 1.0e-120, 0.0, 1.0, 2.5e-3, 1.25];
    let mut got = Vec::new();
    for x in xs {
        let v: Vec<FVal> = (0..10).map(|_| FVal::R(x)).collect();
        got.extend(write_fmt("('[',E12.4,'|',F6.3,'|',F4.3,'|',1PE9.2,'|',G12.4,'|',F5.2,'|',F4.1,'|',1PE10.3,'|',0PF8.2,'|',G10.3,']')", &v));
    }
    for d in ds {
        let v: Vec<FVal> = (0..5).map(|_| FVal::D(d)).collect();
        got.extend(write_fmt("('[',E12.4,'|',1P5E16.6,'|',0PE10.3,'|',F10.4,'|',G14.6,']')", &v));
    }
    got.extend(write_fmt("(I3, 2X, A)", &[FVal::I(12345), FVal::S("abc".into())]));
    got.extend(write_fmt("(1X,'a=',I3,' b=',I3)", &[FVal::I(5)]));
    for (k, (g, e)) in got.iter().zip(expected.iter()).enumerate() {
        assert_eq!(g, e, "record {k}");
    }
}
