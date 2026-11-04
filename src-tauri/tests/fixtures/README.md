# ONNX compatibility fixture

`identity.onnx` is the 115-byte Identity backend test from ONNX v1.17.0
(Apache-2.0):
https://github.com/onnx/onnx/blob/v1.17.0/onnx/backend/test/data/node/test_identity/model.onnx
SHA-256: `b922cf665b299ab35bb265df4dee148b3655075b10cf7bf1d12d354d0f679acc`.

The runtime is deliberately not committed. From `src-tauri/` on Linux x86_64:

```sh
mkdir -p tests/fixtures/onnx-runtime
curl --fail --location --output tests/fixtures/onnx-runtime/libonnxruntime.so \
  https://github.com/fundaments-work/supertonic-assets/releases/download/v1/libonnxruntime-linux-x64-1.22.0.so
printf '%s\n' '3da6146e14e7b8aaec625dde11d6114c7457c87a5f93d744897da8781e35c673  tests/fixtures/onnx-runtime/libonnxruntime.so' | sha256sum --check
cargo test --test onnx_compatibility -- --ignored
```

This runs repeated sessions against the same verified runtime as the app,
without reading any installed voices, models or personal application data.
