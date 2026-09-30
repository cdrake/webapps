//! LCModel for the browser: the Rust port in exes/lcmodel behind a C ABI.
//! A request and its reply are JSON in linear memory:
//!   request  {"control": "...", "files": {"name": "text", ...}, "fdate": "..."}
//!   reply    {"outputs": {"name": "text"}, "stdout": "...", "error": null | "..."}
//! LCModel's inputs (control, .RAW, .H2O, .BASIS) and outputs are all text.

use std::cell::RefCell;

thread_local!(static REPLY: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) });

#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let mut bytes = Vec::<u8>::with_capacity(len);
    let ptr = bytes.as_mut_ptr();
    std::mem::forget(bytes);
    ptr
}

/// # Safety
/// `ptr`/`len` must come from a matching `alloc`.
#[no_mangle]
pub unsafe extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    drop(Vec::from_raw_parts(ptr, 0, len));
}

#[no_mangle]
pub extern "C" fn reply_ptr() -> *const u8 {
    REPLY.with(|r| r.borrow().as_ptr())
}

#[no_mangle]
pub extern "C" fn reply_len() -> usize {
    REPLY.with(|r| r.borrow().len())
}

fn reply(value: serde_json::Value) {
    REPLY.with(|r| *r.borrow_mut() = value.to_string().into_bytes());
}

/// Run LCModel on the JSON request at `ptr`/`len`; the reply is at
/// `reply_ptr()`/`reply_len()` until the next call.
///
/// # Safety
/// `ptr`/`len` must describe a readable byte range.
#[no_mangle]
pub unsafe extern "C" fn lcmodel_run(ptr: *const u8, len: usize) {
    let bytes = std::slice::from_raw_parts(ptr, len);
    let request: serde_json::Value = match serde_json::from_slice(bytes) {
        Ok(v) => v,
        Err(e) => return reply(serde_json::json!({ "outputs": {}, "stdout": "", "error": format!("bad request: {e}") })),
    };
    let control = request["control"].as_str().unwrap_or("");
    let fdate = request["fdate"].as_str().unwrap_or("");
    let files: Vec<(String, Vec<u8>)> = request["files"]
        .as_object()
        .map(|m| m.iter().map(|(k, v)| (k.clone(), v.as_str().unwrap_or("").as_bytes().to_vec())).collect())
        .unwrap_or_default();
    let refs: Vec<(&str, &[u8])> = files.iter().map(|(k, v)| (k.as_str(), v.as_slice())).collect();
    let result = lcmodel::run_lcmodel(control, &refs, fdate);
    reply(serde_json::json!({ "outputs": result.outputs, "stdout": result.stdout, "error": result.error }));
}
