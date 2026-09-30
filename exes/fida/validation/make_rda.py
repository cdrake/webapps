#!/usr/bin/env python3
"""Write synthetic Siemens .rda files (test data for io_loadspec_rda).

    python3 make_rda.py OUTDIR

No public RDA file was available, so these follow the syngo RDA layout: a
text header between '>>> Begin of header <<<' and '>>> End of header <<<'
('Key: value' lines, CRLF) followed by VectorSize complex points as
little-endian float64 (real, imag) pairs. The FID is a sum of damped
sinusoids. FID-A's io_loadspec_rda is then run on them for the reference.
"""
import math
import os
import struct
import sys

HEADER = [
    ('PatientName', 'Phantom^Test'),
    ('PatientID', 'fida-rs'),
    ('StudyDate', '20100101'),
    ('StudyTime', '12:34:56.000000'),
    ('SeriesDescription', 'svs_se_30 synthetic'),
    ('ProtocolName', 'svs_se_30'),
    ('SequenceName', '*svs_se'),
    ('SequenceDescription', 'svs_se_30'),
    ('SoftwareVersion[0]', 'syngo MR B17'),
    ('Nucleus', '1H'),
    ('TR', '2000.000000'),
    ('TE', '30.000000'),
    ('TM', '0.000000'),
    ('NumberOfAverages', '128.000000'),
    ('MRFrequency', '123.252000'),
    ('MagneticFieldStrength', '2.893620'),
    ('FlipAngle', '90.000000'),
    ('NumberOfRows', '1'),
    ('NumberOfColumns', '1'),
    ('DwellTime', '500'),
    ('VectorSize', '1024'),
    ('CSIMatrixSize[0]', '1'),
    ('CSIMatrixSize[1]', '1'),
    ('CSIMatrixSize[2]', '1'),
    ('PositionVector[0]', '-12.5'),
    ('PositionVector[1]', '20.25'),
    ('PositionVector[2]', '8.0'),
]


def fid(n, dwell):
    peaks = [(0.0, 1.0, 8.0), (-280.0, 0.6, 6.0), (150.0, 0.3, 10.0)]
    out = []
    for k in range(n):
        t = k * dwell
        re = im = 0.0
        for f, a, lw in peaks:
            d = a * math.exp(-math.pi * lw * t)
            re += d * math.cos(2 * math.pi * f * t)
            im += d * math.sin(2 * math.pi * f * t)
        out.append((1e-4 * re, 1e-4 * im))
    return out


def write(path, eol):
    hdr = '>>> Begin of header <<<' + eol
    for k, v in HEADER:
        hdr += f'{k}: {v}{eol}'
    hdr += '>>> End of header <<<' + eol
    data = b''.join(struct.pack('<dd', re, im) for re, im in fid(1024, 500e-6))
    with open(path, 'wb') as f:
        f.write(hdr.encode('latin-1') + data)


if __name__ == '__main__':
    out = sys.argv[1]
    os.makedirs(out, exist_ok=True)
    write(os.path.join(out, 'synthetic_crlf.rda'), '\r\n')
    write(os.path.join(out, 'synthetic_lf.rda'), '\n')
