#!/usr/bin/env python3
"""Run the native LCModel for every SPTYPE and the MYCONT option branches and
keep the head of each .PRINT file (up to INITIA's output) with MERMES=8000
(full NAMELIST /LCMODL/ dump). The default case is stored whole; the others
store only what differs from it (see tests/control_print.rs)."""
import os
import re
import subprocess

RUN = "/storage/home/ubuntu/.tmp/ctl/sp"
OUT = "/storage/github-repos/webapps/.claude/worktrees/agent-a7f827988776688b5/exes/lcmodel/tests/data/control_sptype"
os.makedirs(RUN, exist_ok=True)
subprocess.run(["rm", "-rf", OUT])
os.makedirs(OUT)
subprocess.run(["cp", "/home/ubuntu/src/mrs/lcm-test/data.raw", RUN])

BASE = """ $LCMODL
 key=210387309
 nunfil=1024
 deltat=5e-04
 hzpppm=127.786142
 filbas='missing.basis'
 filraw='data.raw'
 lprint=8
 filpri='out.print'
 filps='out.ps'
 mermes=8000
{extra} $END
"""

SPTYPES = ("breast-1 breast-10 breast-2 breast-3 breast-4 breast-5 breast-6 breast-7 breast-8 breast-9 "
           "lipid-1 lipid-10 lipid-2 lipid-3 lipid-4 lipid-5 lipid-6 lipid-7 lipid-8 lipid-9 "
           "liver-1 liver-10 liver-11 liver-2 liver-3 liver-4 liver-5 liver-6 liver-7 liver-8 liver-9 "
           "mega-press-1 mega-press-2 mega-press-3 muscle-1 muscle-2 muscle-3 muscle-4 muscle-5 "
           "only-cho-1 only-cho-2 prostate-a prostate-b prostate-c prostate-d prostate-e prostate-f "
           "prostate-g prostate-h prostate-i csf nulled tumor version5 version-5").split()

CASES = {"default": ""}
for s in SPTYPES:
    CASES[s] = f" sptype='{s}'\n"
# Inner branches: water window, room temperature, wide windows.
for s in ("liver-1", "liver-2", "liver-4", "liver-6", "liver-8", "liver-10", "lipid-1", "lipid-4", "lipid-6",
          "breast-1", "breast-4", "breast-6", "muscle-1", "muscle-3", "muscle-4", "prostate-a", "only-cho-1", "mega-press-1"):
    CASES[s + "_w"] = f" sptype='{s}'\n dowatr=T\n ppmst=5.5\n roomt=T\n ppmend=-2.\n"
    CASES[s + "_n"] = f" sptype='{s}'\n ppmst=3.7\n ppmend=-1.5\n dows=T\n doecc=T\n filh2o='x.h2o'\n"
CASES.update({
    "hifield": " hzpppm=297.2\n",
    "tumor_blank": " sptype='  Tumor'\n",
    "muscle3_hi": " sptype='muscle-3'\n ppmst=7.\n",
    "onlycho2": " sptype='only-cho-2'\n ppmst=3.9\n ppmend=2.7\n",
    "version5_te": " sptype='version5'\n echot=144.\n iauto=1\n",
    "calib": " ncalib=3\n chcali(1)='Lac'\n chcali(2)='NAA'\n chcali(3)='Cre'\n",
    "calib2": " ncalib=2\n chcali(1)='GPC'\n chcali(2)='Ins'\n",
    "reflac": " reflac=T\n useglc=T\n quick=T\n nobase=T\n absval=T\n idgppm=1\n",
    "reflac2": " reflac=T\n ppmend=1.\n chuse1(1)='Lac'\n nuse1=1\n",
    "bascal": " bascal=T\n vitro=T\n",
    "gamma": " chgam='3t'\n nchgam=2\n dkngam=.2\n hzpgam(1)=100.\n hzpgam(2)=200.\n",
    "csi": " ndrows=4\n ndcols=3\n irowst=3\n irowen=2\n icolst=2\n icolen=1\n nvoxsk=1\n irowsk(1)=2\n icolsk(1)=1\n",
    "iaverg": " iaverg=1\n filh2o='x.h2o'\n",
    "longte": " echot=60.\n fwhmba=.02\n",
    "title": " title='Title with ( and ) and % and \\\\ and many more words to push this well past the one hundred and twenty two characters of a line (((( so it splits'\n ntitle=2\n",
    "title2": " title='" + "x" * 130 + "'\n",
    "longlines": " chsimu(3)='" + "Lip @1.3 FWHM=.1 AMP=1. " * 8 + "'\n nchlin(2)=40\n owner='Some Owner'\n",
})

MEMBER = re.compile(r"^ ([A-Z][A-Z0-9_]*)=")


def split(lines):
    head, members, tail = [], {}, []
    cur = None
    state = "head"
    for l in lines:
        if state == "head":
            head.append(l)
            if l.startswith("&LCMODL"):
                state = "nml"
            continue
        if state == "nml":
            if l == " /":
                state = "tail"
                tail.append(l)
                continue
            m = MEMBER.match(l)
            if m:
                cur = m.group(1)
                members[cur] = []
            members[cur].append(l)
            continue
        tail.append(l)
    return head, members, tail


default = None
for name, extra in CASES.items():
    control = BASE.format(extra=extra)
    for f in os.listdir(RUN):
        if f != "data.raw":
            os.remove(os.path.join(RUN, f))
    r = subprocess.run(["/home/ubuntu/src/mrs/lcmodel"], input=control.encode(), cwd=RUN, capture_output=True, timeout=600)
    p = os.path.join(RUN, "out.print")
    if not os.path.exists(p):
        print(name, "no print:", r.stdout.decode(errors="replace").strip()[:200])
        continue
    lines = open(p, errors="replace").read().split("\n")
    end = None
    for k, l in enumerate(lines):
        if "Other quantities" in l:
            end = k - 3
            break
        if "FATAL ERROR" in l or "WARNING" in l and k > 400:
            end = k
            break
    if end is None:
        end = len(lines)
    lines = lines[:end]
    open(os.path.join(OUT, name + ".control"), "w").write(control)
    if name == "default":
        default = split(lines)
        open(os.path.join(OUT, name + ".print"), "w").write("\n".join(lines) + "\n")
        print(name, end)
        continue
    head, members, tail = split(lines)
    out = ["@@HEAD"] + head
    for m, ls in members.items():
        if default[1].get(m) != ls:
            out += ["@@MEMBER " + m] + ls
    out += ["@@TAIL"] + tail
    open(os.path.join(OUT, name + ".print"), "w").write("\n".join(out) + "\n")
    print(name, end, len(out))
