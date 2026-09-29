# Porting conventions

This crate is a subprogram-by-subprogram translation of `LCModel.f` 6.3-1N
(upstream: [schorschinho/LCModel](https://github.com/schorschinho/LCModel) at
`c9d95ff9b1fd2e7e8b256088ba1f5cf4df5fb207`, `source/`). The goal is the same
numbers as the gfortran build, on the same inputs, so the translation keeps
LCModel's algorithm, precision and order of operations. It is not a rewrite.
Structural changes are limited to what Rust requires (control flow for GOTO,
borrowing). Comments from the Fortran that explain *why* are kept, shortened.

`tools/gen_state.py` generates `src/state.rs` from `lcmodel.inc`, BLOCK DATA
and the LCMODL namelist; do not edit it by hand.

## State

* Every COMMON variable is a field of `self.c` (`state::Common`), named as in
  the Fortran, lowercased: `HZPPPM` is `self.c.hzpppm`, `BASIST(J,K)` is
  `self.c.basist[(j, k)]`. Each field's doc comment gives its declaration.
* PARAMETERs of `lcmodel.inc` are `i32` constants in `state` (`MMETAB`, `MY`...).
  `MUNFIL` is 16384 (not 65536) to keep the WebAssembly heap small; nothing may
  depend on its exact value.
* A subprogram that INCLUDEs `lcmodel.inc` becomes `impl Lcm { pub fn name(&mut self, ...) -> R<T> }`.
  One that does not becomes a free `pub fn` in its module.
* Locals: Rust locals, zero-initialised. SAVE'd locals, locals given a DATA
  value (DATA implies SAVE), and local arrays larger than 64 KiB (gfortran
  makes those static, so they persist between calls) live in the module's
  `Saves` struct: `self.s_basis.basisf`. Initialise them in `Saves::default()`
  (implement `Default` by hand when a DATA value is non-zero).
* `CHSUBP` is a local `&str` constant, e.g. `const CHSUBP: &str = "MYBASI";`.

## Types and arithmetic

| Fortran | Rust |
| --- | --- |
| INTEGER (and implicit I-N) | `i32` |
| REAL (and implicit A-H, O-Z) | `f32` |
| DOUBLE PRECISION | `f64` |
| COMPLEX | `fortran::C32` |
| COMPLEX*16 | `fortran::C64` |
| LOGICAL | `bool` |
| CHARACTER*n | `fortran::FStr` (fixed length n) |
| array `A(n)`, `A(0:n)` | `FArr1<T>` (`FArr1::new(n)`, `FArr1::with_bounds(0, n)`) |
| array `A(m,n)` | `FArr2<T>`, index `a[(i, j)]`, column-major |

Implicit typing matters: in LCModel an undeclared `AREA` is REAL and an
undeclared `NPT` is INTEGER, in every subprogram, including those with
`IMPLICIT DOUBLE PRECISION (A-H, O-Z)` (then A-H, O-Z are f64).

Precision follows Fortran exactly:

* A REAL literal (`.1`, `2.5E-3`) is single precision. Inside a DOUBLE
  PRECISION expression it is converted after rounding: write `r2d(0.1)`
  (= `0.1f32 as f64`), not `0.1f64`. Only `D` literals (`.1D0`) are `f64`.
  Exactly representable literals (`.5`, `2.`) may be written as f64 directly.
* Mixed operands promote as Fortran does: INTEGER→REAL→DOUBLE, REAL→COMPLEX.
  `I/J` is integer division. `X*I` converts I to REAL first (`x * i as f32`).
* Assignment converts: REAL = DOUBLE rounds (`as f32`); INTEGER = REAL truncates
  (`as i32`, or `int(x)`).
* Keep the order of operations as written. `A+B+C` is `(A+B)+C`. Do not
  factor, reorder, fuse or hoist floating-point expressions; do not replace a
  loop sum with `iter().sum()` if it changes the order.
* `X**2` is `x * x` (gfortran expands small constant integer powers into
  multiplications: `X**3` is `x * x * x`). `X**N` with a variable integer is
  `powi`. `X**Y` with a real exponent is `powf` (also for `X**.5`).
* Intrinsics: `ABS`, `SQRT`, `EXP`, `ALOG`/`LOG`, `ALOG10`, `SIN`, `COS`,
  `ATAN`, `ATAN2`, `TANH` map to the Rust method of the operand type
  (`f32` for REAL, `f64` for DOUBLE: `DSQRT` is `f64::sqrt`). `AMAX1`/`MAX` of
  reals: `a.max(b)`; `MAX0`/`MIN0`: `i32::max`. `NINT` → `nint`, `IDNINT` →
  `idnint`, `INT`/`IFIX` → `int` (truncate), `FLOAT`/`REAL(I)` → `as f32`,
  `DBLE` → `as f64`, `SNGL` → `as f32`, `MOD` of integers → `%`, of reals →
  `amod`, `SIGN` → `sign`/`dsign`/`isign`, `CMPLX(A,B)` → `cmplx(a, b)`,
  `REAL(C)` → `c.re`, `AIMAG(C)` → `c.im`, `CONJG` → `.conj()`, `ABS(C)`/
  `CABS` → `.abs()`, `CEXP`/`EXP(C)` → `.exp()`. All in `fortran`.
* Complex arithmetic uses the `C32`/`C64` operators (they reproduce gfortran's
  inline product and Smith quotient). `C*R` with R REAL is `c * r`.

## Control flow

* `DO 10 J = A, B` → `for j in a..=b` when the loop variable is not used
  after the loop. Fortran evaluates the bounds once, as Rust ranges do. If the
  loop variable is read after the loop, or the step is not 1, use
  `fortran::fdo(a, b, step)` and track the final value explicitly (after a
  completed loop the variable is `a + trips*step`).
* GOTO: use labeled blocks (`'l120: { ... break 'l120; }`) and labeled loops.
  Keep the Fortran label in the block name so the correspondence stays
  visible. Arithmetic IF and computed GOTO become `match`/`if`.
* `RETURN` → `return Ok(...)`; `STOP` → `return stop("STOP")`.
* A FUNCTION's result variable is a local that the body assigns.

## Errors

* `CALL ERRMES (N, L, CHSUBP)` → `self.errmes(n, l, CHSUBP)?;`. ERRMES returns
  `Err` for fatal levels (|L| >= 4) after writing its outputs, so `?` ends the
  run just where the Fortran stops.
* Free functions cannot call `self.errmes`. They take `q: &mut ErrQueue` and
  write `q.errmes(n, l, CHSUBP)?;`. The calling method replays the queue:
  `let mut q = ErrQueue::new(); let r = pnnls(..., &mut q); self.after(q, r)?;`.

## Strings and I/O

* `CH = 'x'` → `ch.set("x")`; `CH1 = CH2` → `ch1.set_f(&ch2)`;
  `CH(I:J)` → `ch.sub(i, j)`; `CH(I:J) = S` → `ch.set_sub(i, j, s)`;
  `A // B` → `a.cat(&b)`; `INDEX(CH, 'x')` → `ch.index("x")`; `LEN` → `.len()`;
  `ILEN(CH)` → `ilen(&ch)` (control.rs; = `ch.len_trim()`);
  `CH .EQ. 'x'` → `ch.eq_str("x")`; `CH1 .EQ. CH2` → `ch1.eq_f(&ch2)`
  (blank-padded comparison). `ICHAR`/`CHAR` work on bytes (`ch.at(i)`).
* `WRITE (LPRINT, 5110) A, B` → `self.io.write(self.c.lprint, "(...)", &fv![a, b]);`
  with the FORMAT text copied verbatim from statement 5110. Implied-DO lists
  build a `Vec<FVal>`. `WRITE (*, ...)` uses unit `io::STDOUT`. An internal
  WRITE into a CHARACTER variable is `ch.set(&format::write_line(fmt, &vals))`.
* `READ (U, FMT) list` → `self.io.read(u, fmt, &[RKind::R, ...])`, matching the
  `Ok`/`Err(ReadErr::End)`/`Err(ReadErr::Bad)` results to `END=`/`ERR=`.
  Internal READs from a CHARACTER variable use `format::read_fmt` on
  `&[ch.as_str()]`.
* `READ (U, NML=GROUP)` → `let nml = self.io.read_nml(u, "GROUP")`. For a
  namelist of COMMON variables use the generated setter (`apply_lcmodl`); for
  one of locals, `nml.apply("name", &mut local)` per member, and treat names not
  in the group (`nml.unknown(&[...])`) as the `ERR=` branch, as gfortran does.
* `OPEN (U, FILE=F, STATUS='OLD', ERR=n)` → `if !self.io.open_old(u, &f.trim()) { ... }`.
  Output files: `self.io.open_new(u, &name)`. `CLOSE`, `REWIND`, `BACKSPACE`
  map to the `Units` methods of the same name.
* `call fdate(chdate)` → `self.c.chdate.set(&self.fdate.clone())`.
* The PostScript report (MAKEPS, ONEPAG and the plotting primitives) is not
  ported: plots come from the .COORD file. EXITPS follows its `LPS <= 0`
  branch. `LPS` and `FILPS` are accepted and ignored.

## Borrowing

Passing COMMON arrays to a free function is fine as long as the borrows are of
different fields (`cfft(&self.c.datat.data, &mut self.c.dataf.data, n,
&mut self.c.lwfft, &mut self.c.wfftc.data)`). When a method must receive a
COMMON array while also using `&mut self`, move it out and back:
`let mut w = std::mem::take(&mut self.c.rwork); ...; self.c.rwork = w;`. When
the Fortran passes one array as two arguments (aliasing), copy the input.

## Where each subprogram lives

| Module | Subprograms |
| --- | --- |
| `lib.rs` | LCMODL (main program) |
| `control.rs` | MYCONT, check_zero_voxels, average, getvar, restore_settings, update_priors, open_output, split_filename, icharst, chstrip_int6, split_title, LOADCH, compact_string, ERRMES, INITIA, DATAIN, ICYCLE_r, ICYCLE, MYDATA, phase_with_max_real, smooth_tail, smooth_tail_2, ecc_truncate, IGETP, remove_blank_start, toupper_lower, ILEN (MYCONT's special SPTYPE settings from `liver-1.inc`, `lipid-1.inc`, `muscle-1.inc`) |
| `basis.rs` | MYBASI, make_cgroup_shift, parse_chsimu, set_lshape_false, water_scale, areawa, areaw2, getpha, INTEGRATE, areaba, COMBIS |
| `startv.rs` | STARTV, FTDATA, SHIFTD, SETUP, setup3, PHASTA, GBACKG, merge_right, merge_left, check_chless |
| `tworeg.rs` | TWOREG, tworg1, tworeg_sav, tworg2, tworg3, r_base_sol_big, conc_prior, parse_prior, get_field, parse_sum, LDEGMX, NEXTRE, INFLEC, SSRANG |
| `solve.rs` | RFALSI, PENLTY, REPHAS, FSHSSQ, PLINLS, DUMP1, PASTEP, SOLVE, SAVBES |
| `finout.rs` | FINOUT, EXITPS, ERRTBL, REVERS (MAKEPS/ONEPAG and the PostScript primitives are not ported) |
| `numerics.rs` | FFTs (DCFFT_R, csft_r, csftin_r, SEQTOT, CFFTIN, CFFTIN_r, CFFT, CFFT_r and FFTPACK: DF2TCF ... CFFTI1), RANDOM, FISHNI, DGAMLN, BETAIN, PNNLS, DIFF, G1, G2, H12, PLPRIN, EIGVrs, tql2, tred2, pythag |

## Signatures used across modules

These are fixed so modules translated separately link together. Everything
else is private to its module.

```rust
// control.rs (impl Lcm unless marked free)
pub fn mycont(&mut self) -> R<()>
pub fn check_zero_voxels(&mut self) -> R<()>
pub fn average(&mut self) -> R<()>
pub fn restore_settings(&mut self) -> R<()>
pub fn update_priors(&mut self) -> R<()>
pub fn open_output(&mut self) -> R<()>
pub fn loadch(&mut self) -> R<()>
pub fn initia(&mut self) -> R<()>
pub fn datain(&mut self) -> R<()>
pub fn errmes(&mut self, number: i32, ilevel: i32, chsubp: &str) -> R<()>
pub fn ilen(st: &FStr) -> i32                              // free
pub fn toupper_lower(lupper_out: bool, s: &mut FStr)       // free
pub fn remove_blank_start(s: &mut FStr)                    // free
pub fn icycle(j: i32, ndata: i32) -> i32                   // free
pub fn icycle_r(j: i32, ndata: i32) -> i32                 // free

// basis.rs
pub fn mybasi(&mut self, lstage: i32) -> R<()>
pub fn combis(&mut self) -> R<()>
pub fn areawa(&mut self, istage: i32) -> R<f32>

// startv.rs
pub fn startv(&mut self, ipass: i32) -> R<()>
pub fn ftdata(&mut self, ishift: i32) -> R<()>
pub fn setup(&mut self, lstage: i32) -> R<()>
pub fn check_chless(&mut self) -> R<()>

// tworeg.rs
pub fn tworeg(&mut self) -> R<()>
pub fn ssrang(&mut self, irange: i32) -> R<()>
pub fn ldegmx(&mut self, idegmx: i32) -> R<bool>
pub fn get_field(chseparator: &str, len_chseparator: i32, ifield_type: i32, iatend: i32,
                 chreturn: &mut FStr, freturn: &mut f32, istart: &mut i32,
                 len_string_in: i32, string_in: &FStr, q: &mut ErrQueue) -> R<()>   // free
// DPY(NSIDE2+3,2) / DPY(NSIDE2+5,2): column-major slice, leading dimension nside2+3 / nside2+5.
// DGAUSS(0:NSIDE2+2): slice whose element 0 is DGAUSS(0).
pub fn nextre(parnl: &[f64], nside2: i32, dpy: &mut [f64], dgauss: &[f64], thrlin: f32, imethd: i32) -> i32  // free
pub fn inflec(parnl: &[f64], nside2: i32, dpy: &mut [f64], dgauss: &[f64], thrlin: f32, imethd: i32) -> i32  // free

// solve.rs
pub fn rfalsi(&mut self, ialpha: i32, irange: i32, lrepha: bool, alphb: f64, alphs: f64,
              assqlo: f32, aalplo: f32, assqhi: f32, aalphi: f32, aalpha: f32,
              prejok: &mut bool, prej1: &mut f32) -> R<()>
pub fn rephas(&mut self) -> R<()>
pub fn fshssq(&mut self, prej: f32, idfish: i32, nyuse: i32, refndf: f32, ssqref: f32, lprint: i32, rrange: f32) -> R<f32>
pub fn plinls(&mut self, istage: i32, ierror: &mut i32) -> R<()>
pub fn solve(&mut self, lstage: i32, dononl: bool, pmqact: f64, onlyft: bool, lerror: &mut bool) -> R<()>
pub fn savbes(&mut self, ilevel: i32) -> R<()>

// finout.rs
pub fn finout(&mut self) -> R<()>
pub fn exitps(&mut self, lstop: bool) -> R<()>

// numerics.rs (all free). Array arguments are slices starting at the actual
// argument's first element; LWFFT/LDWFFT and the work arrays are updated in place.
pub fn cfft(datat: &[C32], ft: &mut [C32], n: i32, lwfft: &mut i32, wfftc: &mut [f32])
pub fn cfft_r(datat: &[C32], ft: &mut [C32], n: i32, lwfft: &mut i32, wfftc: &mut [f32])
pub fn cfftin(ft: &[C32], ftinv: &mut [C32], n: i32, lwfft: &mut i32, wfftc: &mut [f32])
pub fn cfftin_r(ft: &[C32], ftwork: &mut [C32], ftinv: &mut [C32], n: i32, lwfft: &mut i32, wfftc: &mut [f32])
pub fn seqtot(datat: &mut [C32], dataf: &mut [C32], nunfil: i32, lwfft: &mut i32, wfftc: &mut [f32])
pub fn csft_r(datat: &[C32], ft: &mut [C32], ncap: i32)
pub fn csftin_r(ft: &[C32], ftwork: &mut [C32], ftinv: &mut [C32], ncap: i32)
pub fn dcfft_r(datat: &[C64], ft: &mut [C64], n: i32, ldwfft: &mut i32, dwfftc: &mut [f64])
pub fn random(dix: &mut f64) -> f32
pub fn fishni(f: f32, df1: f32, df2: f32, nout: i32, q: &mut ErrQueue) -> R<f32>
pub fn betain(x: f32, a: f32, b: f32, nout: i32, q: &mut ErrQueue) -> R<f32>
pub fn dgamln(xarg: f64) -> f64
pub fn diff(x: f64, y: f64) -> f64
pub fn pnnls(a: &mut [f64], mda: i32, m: i32, n: i32, b: &mut [f64], x: &mut [f64], dvar: &mut f64,
             w: &mut [f64], zz: &mut [f64], index: &mut [i32], mode: &mut i32, range: f64,
             nonneg: &[bool], dvarac: f64, nsetp: &mut i32, q: &mut ErrQueue) -> R<()>
pub fn plprin(x: &[f32], y1: &[f32], y2: &[f32], n: i32, only1: bool, nout: i32, srange: f32,
              nlinf: i32, ng: i32, my1: i32, yerr: &[f64], plterr: bool, io: &mut Units)
pub fn eigvrs(nm: i32, n: i32, a: &[f32], w: &mut [f32], z: &mut [f32], fv1: &mut [f32], fv2: &mut [f32], ierr: &mut i32)
```

When the Fortran passes an array section start such as `CALL CFFT(BASIST(1,J), ...)`,
pass `self.c.basist.tail((1, j))` (or `.col(j)` for a whole column).
