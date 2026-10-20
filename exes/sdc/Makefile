.PHONY: build test lint

build:
	cargo build --release -p sdc

test:
	cargo test --workspace --release

lint:
	cargo clippy --workspace --all-targets -- -D warnings
	cargo fmt --all --check
