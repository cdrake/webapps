# Greedy reference fixtures

From the `greedy-rs` directory, run
`./scripts/make_reference.sh /path/to/greedy` to create one-thread reference
outputs for the v1 SSD/NMI workflows in Greedy's `-float` and default double
precision. Affine runs disable Greedy's default jitter (`-jitter 0`), which
also works with the 1.3 reference that predates `-seed`.

The float-versus-double spread is the acceptance tolerance: greedy-rs must be
at least as close to the double result as Greedy's own float build is.
Compare with `scripts/compare_reference.py mat|warp|img RUST_OUTPUT REFERENCE`.

The two 2 mm NMI affine matrices are committed because they are tiny and back
the optional `GREEDY_BENCH_DIR` compatibility test. The 1 mm warp fixtures are
deliberately not committed; CI should fetch a versioned fixture archive or run
this script on a machine with greedy.

The whole-head gate (`masked_nmi_affine_on_a_whole_head_pair_matches_greedy`,
issue #623) runs when `GREEDY_T1_TEMPLATE_DIR` holds, decompressed to `.nii`,
`bison/examples/ds007522/sub-HML0541/ses-01/anat/sub-HML0541_ses-01_rec-defaced_T1w.nii.gz`
and `bison/templates/mni_icbm152_t1_tal_nlin_sym_09c{,_mask}.nii.gz` from the
Hugging Face dataset `neurodeskorg/webapps`. Greedy 1.4 gives a determinant of
0.73 with the mask and 0.62 without; the bounds are a few percent around them.
