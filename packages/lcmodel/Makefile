# The .wasm is committed (as packages/synthseg/src/synthseg.wasm), so this only runs
# when exes/lcmodel, exes/fida or wasm/src change.
CRATE = wasm/target/wasm32-unknown-unknown/release/lcmodel_wasm.wasm

.PHONY: wasm test
wasm:
	cd wasm && RUSTFLAGS="-C link-arg=--max-memory=4294967296" cargo build --release --target wasm32-unknown-unknown
	wasm-opt -O3 $(CRATE) -o src/lcmodel.wasm
	@ls -l src/lcmodel.wasm

test:
	node --test test/*.test.js
