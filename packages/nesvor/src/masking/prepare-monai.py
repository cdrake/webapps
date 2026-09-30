"""Unpack the original MONAI architecture with a Python 3.12+ import shim."""
import argparse
import hashlib
from pathlib import Path
import zipfile

parser = argparse.ArgumentParser()
parser.add_argument("wheel", type=Path)
parser.add_argument("destination", type=Path)
args = parser.parse_args()
expected = "a1a5333f53201574de61b1a3479070b88ec5753cad27e10d034abe96f9976864"
if hashlib.sha256(args.wheel.read_bytes()).hexdigest() != expected:
    raise RuntimeError("Expected the original MONAI 0.3.0 wheel.")
with zipfile.ZipFile(args.wheel) as archive:
    archive.extractall(args.destination)
loader = args.destination / "monai/utils/module.py"
loader.write_text(loader.read_text().replace("importer.find_module(name).load_module(name)", "import_module(name)"))
print(args.destination.resolve())
