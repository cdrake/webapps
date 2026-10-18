use dwi_amico::Dictionary;
use dwi_gradients::Gradients;

#[test]
fn normalisation_uses_the_shared_strict_b0_threshold() {
    let bvals = vec![0.0, 49.9, 50.0, 1000.0, 2000.0];
    let bvecs = vec![
        [0.0, 0.0, 0.0],
        [0.0, 0.0, 0.0],
        [1.0, 0.0, 0.0],
        [0.0, 1.0, 0.0],
        [0.0, 0.0, 1.0],
    ];
    let gradients = Gradients::new(bvals.clone(), bvecs.clone()).unwrap();
    assert_eq!(gradients.b0_volumes(), vec![0, 1]);
    let dictionary = Dictionary::new(&bvals, &bvecs).unwrap();
    let normalised = dictionary
        .normalise(&[1000.0, 800.0, 100.0, 500.0, 400.0])
        .unwrap();
    // Only b = 0 and 49.9 contribute to the mean b0 of 900.
    assert!((normalised[0] - 1000.0 / 900.0).abs() < 1e-10);
    assert!((normalised[2] - 100.0 / 900.0).abs() < 1e-10);
    assert!(dictionary.iso(2) < 1.0, "b = 50 must attenuate the signal");
}
