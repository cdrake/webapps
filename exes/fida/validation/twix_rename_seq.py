#!/usr/bin/env python3
"""Rename the sequence of a twix file in place of its header (test data only).

    python3 twix_rename_seq.py in.dat out.dat NEWNAME

Every occurrence of the sequence file name (tSequenceFileName in the
protocol) is overwritten with NEWNAME, padded with '_' to the same length, so
no header length changes. The data are untouched. This lets FID-A's
sequence-specific branches of io_loadspec_twix (PRESS/STEAM, WIP 529/859,
CMRR, Columbia sLASER, HERCULES) be exercised with FID-A as the reference.
"""
import re
import sys


def main(src, dst, new):
    b = bytearray(open(src, 'rb').read())
    m = re.search(rb'<ParamString\."SequenceFileName">\s*\{\s*"([^"]+)"', bytes(b[:4_000_000]))
    if not m:
        sys.exit('no SequenceFileName in the header')
    old = m.group(1)
    new = new.encode()
    if len(new) > len(old):
        sys.exit(f'new name longer than {old!r} ({len(old)} bytes)')
    new = new + b'_' * (len(old) - len(new))
    # a 20+ byte ASCII name cannot plausibly occur inside the float samples
    open(dst, 'wb').write(bytes(b).replace(old, new))


if __name__ == '__main__':
    main(*sys.argv[1:4])
