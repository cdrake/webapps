#!/usr/bin/env python3
"""Rewrite a VB twix file in the VD/VE multi-RAID layout (test data only).

    python3 twix_vb_to_vd.py in_vb.dat out_vd.dat

The output holds two measurements, as VD+ files do: a small dummy one (the
header only, followed by ACQEND) and the real one, so readers must take the
last measurement. Every VB mdh (128 bytes per channel) becomes a 192-byte VD
scan header plus a 32-byte channel header per channel; the loop counters,
evaluation mask, cut-off, ICE and free parameters and the samples are copied
unchanged. The protocol header is copied byte for byte, so the result is not a
real VE file: it exercises the VD file and mdh layout, and FID-A's 'vd' code
paths, with FID-A as the reference.
"""
import struct
import sys


def vb_mdhs(b, start):
    """Yield (offset, mdh bytes, data blocks) like mapVBVD's loop_mdh_read for VB."""
    pos = start
    while pos + 128 <= len(b):
        m = b[pos:pos + 128]
        mask = m[20]
        dma = struct.unpack('<I', m[0:3] + bytes([m[3] & 1]))[0]
        if m[0:3] == b'\0\0\0' or mask & 1:
            if dma == 0 or mask & 1:
                return
        if mask & 0x20:
            pos += dma
            continue
        ncol, ncha = struct.unpack('<HH', m[28:32])
        blocks = []
        for c in range(ncha):
            o = pos + c * (128 + 8 * ncol)
            blocks.append((b[o:o + 128], b[o + 128:o + 128 + 8 * ncol]))
        yield m, blocks
        pos += (8 * ncol + 128) * ncha


def vd_scan(m, blocks):
    ncol, ncha = struct.unpack('<HH', m[28:32])
    h = bytearray(192)
    h[4:20] = m[4:20]                       # MeasUID, ScanCounter, TimeStamp, PMUTimeStamp
    h[40:48] = m[20:28]                     # aulEvalInfoMask
    h[48:52] = m[28:32]                     # samples, channels
    h[52:80] = m[32:60]                     # sLC
    h[80:84] = m[60:64]                     # sCutOff
    h[84:100] = m[64:80]                    # centre column .. centre partition
    h[100:128] = m[96:124]                  # sSliceData
    h[128:136] = m[80:88]                   # aushIceProgramPara[0..3]
    h[176:184] = m[88:96]                   # aushFreePara
    length = 192 + ncha * (32 + 8 * ncol)
    h[0:4] = struct.pack('<I', length)
    out = bytearray(h)
    for c, (cm, data) in enumerate(blocks):
        ch = bytearray(32)
        ch[0:4] = struct.pack('<I', 32 + 8 * ncol)
        ch[4:12] = m[4:12]
        ch[24:26] = cm[124:126]             # channel id
        out += ch + data
    return out


def acqend():
    h = bytearray(192)
    h[0:4] = struct.pack('<I', 192)
    h[40] = 1
    return h


def pad512(buf):
    if len(buf) % 512:
        buf += bytes(512 - len(buf) % 512)
    return buf


def main(src, dst):
    b = open(src, 'rb').read()
    hdr_len = struct.unpack('<I', b[:4])[0]
    header = b[4:hdr_len]
    meas = []
    for real in (False, True):
        m = bytearray(struct.pack('<I', hdr_len)) + header
        for mdh, blocks in vb_mdhs(b, hdr_len):
            if real:
                m += vd_scan(mdh, blocks)
            else:
                # the dummy (adjustment) measurement: one noise scan
                s = vd_scan(mdh, blocks)
                s[40:48] = struct.pack('<II', 1 << 25, 0)
                m += s
                break
        m += acqend()
        meas.append(pad512(m))
    file_hdr = bytearray(10240)
    struct.pack_into('<IIII', file_hdr, 0, 0, len(meas), 1, 1)
    off = len(file_hdr)
    for k, m in enumerate(meas):
        struct.pack_into('<QQ', file_hdr, 16 + 152 * k, off, len(m))
        off += len(m)
    with open(dst, 'wb') as f:
        f.write(file_hdr)
        for m in meas:
            f.write(m)


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
