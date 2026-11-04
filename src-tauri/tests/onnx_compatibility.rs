//! Explicit smoke test for the downloadable ONNX Runtime, without personal TTS data.
#![cfg(all(target_os = "linux", target_arch = "x86_64"))]

#[test]
#[ignore = "requires the verified runtime fixture; see tests/fixtures/README.md"]
fn downloaded_runtime_runs_sessions_with_the_current_bindings() {
    let environment = ort::init_from("tests/fixtures/onnx-runtime/libonnxruntime.so")
        .expect("load the verified 1.22 runtime fixture")
        .build()
        .expect("build environment");
    for _ in 0..3 {
        let mut session = ort::session::Session::builder(&environment)
            .expect("session builder")
            .with_intra_threads(1)
            .expect("limit inference threads")
            .commit_from_memory(include_bytes!("fixtures/identity.onnx"))
            .expect("load identity model");
        let values = vec![0.0_f32, -1.5, 2.0, f32::MAX];
        let input =
            ort::value::Tensor::from_array(([1, 1, 2, 2], values.clone())).expect("input tensor");
        let output = session.run(ort::inputs![input]).expect("inference");
        let (_, actual) = output[0]
            .try_extract_tensor::<f32>()
            .expect("output tensor");
        assert_eq!(actual, values);
    }
}
