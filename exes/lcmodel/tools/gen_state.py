#!/usr/bin/env python3
"""Generate src/state.rs from LCModel's lcmodel.inc, BLOCK DATA and NAMELIST.

    python3 tools/gen_state.py <path/to/LCModel/source> > src/state.rs

Every COMMON variable becomes a field of `Common` with its Fortran type,
bounds and BLOCK DATA initial value, so translated subprograms read
`self.c.hzpppm` where the Fortran reads HZPPPM. The LCMODL namelist setter
is generated from nml_lcmodl.inc. Array bounds use the PARAMETER values of
lcmodel.inc except where OVERRIDES lowers them for the browser build.
"""
import re
import sys
from pathlib import Path

# The browser build does not need 64 k-point spectra; smaller bounds keep the
# WebAssembly heap small. Every array bound derives from these.
OVERRIDES = {"MUNFIL": 16384}


def statements(text):
    """Fixed-form source -> list of statements (continuations joined)."""
    out = []
    for raw in text.split("\n"):
        line = raw.rstrip("\r")
        if not line.strip():
            continue
        if line[0] in "Cc*!":
            continue
        # Inline '!' comments (outside quotes).
        cleaned = []
        q = None
        for ch in line[:72] if len(line) > 72 else line:
            if q:
                cleaned.append(ch)
                if ch == q:
                    q = None
            elif ch in "'\"":
                q = ch
                cleaned.append(ch)
            elif ch == "!":
                break
            else:
                cleaned.append(ch)
        # gfortran pads fixed-form lines to column 72, which matters for
        # character constants continued onto the next line.
        line = "".join(cleaned).ljust(72)
        if len(line) > 5 and line[5] not in " 0" and out:
            out[-1] += line[6:]
        else:
            out.append(line[6:] if len(line) > 6 else "")
    return [s.strip() for s in out if s.strip()]


def split_top(s, sep=","):
    parts, depth, q, cur = [], 0, None, ""
    for ch in s:
        if q:
            cur += ch
            if ch == q:
                q = None
            continue
        if ch in "'\"":
            q = ch
            cur += ch
            continue
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        if ch == sep and depth == 0:
            parts.append(cur.strip())
            cur = ""
        else:
            cur += ch
    if cur.strip():
        parts.append(cur.strip())
    return parts


class Params:
    def __init__(self):
        self.v = {}

    def eval(self, expr):
        e = expr.strip().lower()
        e = re.sub(r"\bmax0\b", "max", e)
        e = re.sub(r"\bmin0\b", "min", e)
        env = dict(self.v)
        return int(eval(e, {"__builtins__": {}, "max": max, "min": min}, env))


def parse_params(stmts, params):
    for s in stmts:
        m = re.match(r"(?i)parameter\s*\((.*)\)\s*$", s)
        if not m:
            continue
        for part in split_top(m.group(1)):
            name, expr = part.split("=", 1)
            name = name.strip().lower()
            if name.upper() in OVERRIDES:
                params.v[name] = OVERRIDES[name.upper()]
            else:
                params.v[name] = params.eval(expr)


def implicit_type(name):
    return "integer" if name[0].lower() in "ijklmn" else "real"


class Var:
    def __init__(self, name):
        self.name = name.lower()
        self.type = None  # integer real double complex logical character
        self.charlen = None
        self.dims = None  # list of (lb_expr, ub_expr)
        self.common = None
        self.data = None  # list of python values


def parse_decl_list(body):
    """'A(10), B*6, C(2,3)*(MCH)' -> [(name, dims_str or None, len_str or None)]."""
    res = []
    for part in split_top(body):
        m = re.match(r"(?i)^([a-z_][a-z0-9_]*)\s*(\(.*?\))?\s*(\*\s*(\(.*\)|\d+))?\s*(\(.*\))?$", part)
        if not m:
            raise ValueError(f"cannot parse declaration {part!r}")
        name, dims, _, ln, dims2 = m.groups()
        dims = dims or dims2
        if ln:
            ln = ln.strip("()")
        res.append((name, dims[1:-1] if dims else None, ln))
    return res


def dims_of(dstr, params):
    out = []
    for d in split_top(dstr):
        if ":" in d:
            lb, ub = d.split(":", 1)
            out.append((params.eval(lb), params.eval(ub)))
        else:
            out.append((1, params.eval(d)))
    return out


def parse_include(stmts, params):
    vars_ = {}
    order = []

    def get(name):
        n = name.lower()
        if n not in vars_:
            vars_[n] = Var(n)
        return vars_[n]

    for s in stmts:
        m = re.match(r"(?i)^(character|complex|double\s+precision|logical|integer|real)\b\s*(\*\s*\d+|\*\s*\(.*?\))?\s*(.*)$", s)
        if m and not s.lower().startswith("common"):
            kind = re.sub(r"\s+", " ", m.group(1).lower())
            default_len = m.group(2)
            body = m.group(3)
            kind = {"double precision": "double"}.get(kind, kind)
            for name, dims, ln in parse_decl_list(body):
                v = get(name)
                v.type = kind
                if kind == "character":
                    lnexpr = ln or (default_len.lstrip("*").strip().strip("()") if default_len else "1")
                    v.charlen = params.eval(lnexpr)
                if dims:
                    v.dims = dims_of(dims, params)
            continue
        m = re.match(r"(?i)^common\s*/\s*(\w+)\s*/\s*(.*)$", s)
        if m:
            block = m.group(1).lower()
            for name, dims, _ in parse_decl_list(m.group(2)):
                v = get(name)
                v.common = block
                if dims:
                    v.dims = dims_of(dims, params)
                if v.name not in order:
                    order.append(v.name)
    for v in vars_.values():
        if v.type is None:
            v.type = implicit_type(v.name)
    return vars_, order


# ---------------------------------------------------------------------------
# DATA statements
# ---------------------------------------------------------------------------

def parse_constant(tok):
    t = tok.strip()
    if t.startswith("'"):
        return t[1:-1].replace("''", "'")
    low = t.lower()
    if low in (".true.", ".t."):
        return True
    if low in (".false.", ".f."):
        return False
    low = low.replace("d", "e")
    if re.match(r"^[+-]?\d+$", low):
        return int(low)
    return float(low)


def expand_values(vs, params):
    out = []
    for item in split_top(vs):
        m = re.match(r"(?i)^([a-z_][a-z0-9_]*|\d+)\s*\*\s*(.+)$", item)
        if m and not item.startswith("'"):
            cnt = m.group(1)
            n = params.v[cnt.lower()] if not cnt.isdigit() else int(cnt)
            out.extend([parse_constant(m.group(2))] * n)
        else:
            out.append(parse_constant(item))
    return out


def parse_data(stmt, vars_, params):
    body = re.sub(r"(?i)^data\s+", "", stmt)
    # name-list/values/ pairs, separated by optional commas.
    i = 0
    while i < len(body):
        while i < len(body) and body[i] in " ,":
            i += 1
        if i >= len(body):
            break
        j = body.index("/", i)
        names = body[i:j].strip()
        # Find the closing slash (outside quotes).
        k = j + 1
        q = None
        while k < len(body):
            ch = body[k]
            if q:
                if ch == q:
                    q = None
            elif ch == "'":
                q = ch
            elif ch == "/":
                break
            k += 1
        values = expand_values(body[j + 1:k], params)
        i = k + 1
        name_list = split_top(names)
        pos = 0
        for nm in name_list:
            m = re.match(r"(?i)^(\w+)\s*(\((.*)\))?$", nm)
            v = vars_.get(m.group(1).lower())
            if v is None:
                raise ValueError(f"DATA for unknown {nm}")
            size = 1
            if v.dims and not m.group(2):
                size = 1
                for lb, ub in v.dims:
                    size *= ub - lb + 1
            v.data = values[pos:pos + size]
            if len(v.data) != size:
                raise ValueError(f"DATA size mismatch for {v.name}: {len(v.data)} vs {size}")
            pos += size
        if pos != len(values):
            raise ValueError(f"DATA leftover values for {names}: {pos} of {len(values)}")


# ---------------------------------------------------------------------------
# Rust emission
# ---------------------------------------------------------------------------

RUST_T = {"integer": "i32", "real": "f32", "double": "f64", "complex": "C32", "logical": "bool", "character": "FStr"}


def lit(v, t):
    if t == "character":
        return f"FStr::new({{L}}, {rust_str(v)})"
    if t == "logical":
        return "true" if v else "false"
    if t == "integer":
        return str(int(v))
    if t in ("real", "double"):
        x = float(v)
        r = repr(x)
        if "e" not in r and "." not in r and "inf" not in r:
            r += ".0"
        return r + ("_f32" if t == "real" else "_f64")
    if t == "complex":
        return f"C32::new({float(v)!r}_f32, 0.0)"
    raise ValueError(t)


def rust_str(s):
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'


def fortran_decl(v):
    t = {"double": "DOUBLE PRECISION"}.get(v.type, v.type.upper())
    if v.type == "character":
        t += f"*{v.charlen}"
    d = ""
    if v.dims:
        d = "(" + ", ".join(f"{lb}:{ub}" if lb != 1 else str(ub) for lb, ub in v.dims) + ")"
    return f"{t} {v.name.upper()}{d}"


def rust_field_type(v):
    base = RUST_T[v.type]
    if not v.dims:
        return base
    return {1: "FArr1", 2: "FArr2", 3: "FArr3"}[len(v.dims)] + f"<{base}>"


def ctor(v):
    t = v.type
    base = RUST_T[t]
    if not v.dims:
        if v.data is not None:
            s = lit(v.data[0], t)
            return s.replace("{L}", str(v.charlen))
        if t == "character":
            return f"FStr::blank({v.charlen})"
        return {"i32": "0", "f32": "0.0", "f64": "0.0", "C32": "C32::ZERO", "bool": "false"}[base]
    dims = v.dims
    if len(dims) == 1:
        (lb, ub), = dims
        if t == "character":
            e = f"fstr_arr1({ub - lb + 1}, {v.charlen})"
            if lb != 1:
                e = f"{{ let mut a = {e}; a.lb = {lb}; a }}"
        else:
            e = f"FArr1::<{base}>::with_bounds({lb}, {ub})"
    elif len(dims) == 2:
        (a, b), (c, d) = dims
        if t == "character":
            e = f"fstr_arr2({b - a + 1}, {d - c + 1}, {v.charlen})"
        else:
            e = f"FArr2::<{base}>::with_bounds({a}, {b}, {c}, {d})"
    else:
        e = f"FArr3::<{base}>::with_bounds([" + ", ".join(f"({a}, {b})" for a, b in dims) + "])"
    if v.data is None:
        return e
    vals = [lit(x, t).replace("{L}", str(v.charlen)) for x in v.data]
    # Compress runs.
    if all(x == vals[0] for x in vals):
        if vals[0] in ("0", "0.0_f32", "0.0_f64", "false") or (t == "character" and v.data[0].strip() == ""):
            return e
        return f"{{ let mut a = {e}; a.fill({vals[0]}); a }}"
    body = ", ".join(vals)
    return f"{{ let mut a = {e}; let v = vec![{body}]; a.data.clone_from_slice(&v); a }}"


def main():
    src = Path(sys.argv[1])
    inc = (src / "lcmodel.inc").read_text(errors="replace")
    main_f = (src / "LCModel.f").read_text(errors="replace")
    params = Params()
    inc_stmts = statements(inc)
    parse_params(inc_stmts, params)
    vars_, order = parse_include(inc_stmts, params)
    # BLOCK DATA: statements between "BLOCK DATA" and its END.
    all_stmts = statements(main_f)
    in_bd = False
    for s in all_stmts:
        if re.match(r"(?i)^block\s+data", s):
            in_bd = True
            continue
        if in_bd:
            if re.match(r"(?i)^end$", s):
                break
            if re.match(r"(?i)^data\b", s):
                parse_data(s, vars_, params)
    # NAMELIST /LCMODL/
    nml_stmts = statements((src / "nml_lcmodl.inc").read_text(errors="replace"))
    nml_names = []
    for s in nml_stmts:
        m = re.match(r"(?i)^namelist\s*/\s*(\w+)\s*/\s*(.*)$", s)
        if m:
            nml_names += [n.strip().lower() for n in split_top(m.group(2))]

    w = []
    w.append("//! Generated by tools/gen_state.py from LCModel's lcmodel.inc, BLOCK DATA")
    w.append("//! and nml_lcmodl.inc. Do not edit; rerun the generator.")
    w.append("//!")
    w.append("//! `Common` holds every COMMON-block variable with its Fortran bounds and")
    w.append("//! BLOCK DATA initial value. Doc comments give the Fortran declaration.")
    w.append("#![allow(clippy::all)]")
    w.append("")
    w.append("use crate::fortran::*;")
    w.append("use crate::io::{Namelist, NmlAssign};")
    w.append("")
    w.append("// PARAMETER constants of lcmodel.inc" + (f" (overridden: {OVERRIDES})" if OVERRIDES else "") + ".")
    for k, v in params.v.items():
        w.append(f"pub const {k.upper()}: i32 = {v};")
    w.append("")
    w.append("#[derive(Clone, Debug)]")
    w.append("pub struct Common {")
    for name in order:
        v = vars_[name]
        w.append(f"    /// `{fortran_decl(v)}` in /{v.common.upper()}/")
        w.append(f"    pub {rust_ident(name)}: {rust_field_type(v)},")
    w.append("}")
    w.append("")
    w.append("impl Common {")
    w.append("    /// All variables at their BLOCK DATA values (zero/blank/false otherwise).")
    w.append("    pub fn new() -> Self {")
    w.append("        Common {")
    for name in order:
        v = vars_[name]
        w.append(f"            {rust_ident(name)}: {ctor(v)},")
    w.append("        }")
    w.append("    }")
    w.append("")
    w.append("    /// Apply NAMELIST /LCMODL/ input.")
    w.append("    pub fn apply_lcmodl(&mut self, nml: &Namelist) -> Result<(), String> {")
    w.append("        for item in &nml.items {")
    w.append("            match item.name.as_str() {")
    for n in nml_names:
        if n not in vars_:
            raise ValueError(f"namelist variable {n} is not in COMMON")
        w.append(f"                \"{n}\" => self.{rust_ident(n)}.nml_assign(&item.subs, &item.values)?,")
    w.append("                other => return Err(format!(\"{other} is not a variable of namelist LCMODL\")),")
    w.append("            }")
    w.append("        }")
    w.append("        Ok(())")
    w.append("    }")
    w.append("}")
    w.append("")
    w.append("impl Default for Common {")
    w.append("    fn default() -> Self {")
    w.append("        Self::new()")
    w.append("    }")
    w.append("}")
    w.append("")
    w.append("/// Names in NAMELIST /LCMODL/.")
    w.append("pub const LCMODL_NAMES: &[&str] = &[" + ", ".join(f'"{n}"' for n in nml_names) + "];")
    print("\n".join(w))


RUST_KEYWORDS = {"type", "loop", "match", "move", "ref", "self", "fn", "impl", "use", "mod", "in", "as", "box", "where", "while", "for", "if", "else", "let", "mut", "pub", "static", "const", "struct", "enum", "trait", "true", "false", "return", "break", "continue", "crate", "super", "extern", "unsafe", "dyn", "async", "await", "yield", "abstract", "final", "override", "macro", "priv", "typeof", "unsized", "virtual", "do", "try"}


def rust_ident(n):
    return f"r#{n}" if n in RUST_KEYWORDS else n


if __name__ == "__main__":
    main()
