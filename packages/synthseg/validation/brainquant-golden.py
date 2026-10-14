# Writes test/fixtures/brainquant-golden.json, the reference numbers for src/brainquant.js.
#
# The fixture was produced by running brainquant.py and brainquant_norms.json from
# neurodesk/neurocontainers commit b23bda1938a5e95e073e34176c1ada526f2382cd
# (recipes/synthseg/) on FreeSurfer 8.2.0's T1_head_fast_vol.csv
# (Hugging Face neurodeskorg/webapps commit 87db4f0297be57eb7f280c629b1bbd2c95b235db,
# synthseg/validation/T1_head_fast_vol.csv). brainquant.py needs numpy and scipy.
#
#   python3 -I brainquant-golden.py <dir with brainquant.py and brainquant_norms.json> <vol.csv> > fixture
import json, sys
sys.path.insert(0, sys.argv[1])
import brainquant as bq
norms = bq.load_norms(sys.argv[1] + "/brainquant_norms.json")
vols = bq.read_volumes(sys.argv[2])
cases = []
for age, sex in [(45, "female"), (72, "male"), (None, None), (30, None), (95, "female")]:
    s = bq.Subject(age=age, sex=sex, age_source="x", sex_source="x")
    r = bq.assess(norms, vols, s)
    cases.append({"age": age, "sex": sex, "icv_mm3": r.icv_mm3, "results": [
        {"id": x.structure.id, "volume_mm3": x.volume_mm3, "adjusted_mm3": x.adjusted_mm3,
         "z": x.z, "percentile": x.percentile, "flag": x.flag} for x in r.results]})
m = norms.structures[0].models["female"]
a = norms.scaled_age([20, 50, 86.3])
curves = {q: [float(v) for v in m.centile(a, q)] for q in (0.05, 0.25, 0.5, 0.75, 0.95)}
print(json.dumps({"cases": cases, "hippocampus_left_female_centiles_at_20_50_86.3": curves}, indent=1))
