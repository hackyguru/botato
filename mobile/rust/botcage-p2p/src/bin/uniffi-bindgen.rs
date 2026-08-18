// Generates the Swift and Kotlin bindings from the Rust below. Kept in-tree so
// the bindings always match the crate they were generated from.
fn main() {
    uniffi::uniffi_bindgen_main()
}
