//! Vendor readers and LCModel file output (FID-A inputOutput).
//!
//! Every reader takes the file contents as bytes (never a path) so it runs in
//! WebAssembly, and returns `Err(String)` with a message a user can act on.

pub mod common;
pub mod ge;
pub mod lcm;
pub mod lcmraw;
pub mod sdat;
pub mod twix;
