fn main() {
    // whisper's Metal backend is Objective-C, and its `@available` checks
    // compile to `__isPlatformVersionAtLeast` — a compiler-rt builtin. rustc
    // links with `-nodefaultlibs` and its own `compiler_builtins`, which does
    // not carry the platform-version helpers, so the symbol is simply missing
    // and the link fails with nothing to say about why.
    //
    // Only in release: the debug profile links enough differently that it
    // resolves, which is a good way to ship a tree that has never been built
    // the way it is shipped.
    #[cfg(target_os = "macos")]
    {
        let dir = std::process::Command::new("clang")
            .arg("-print-runtime-dir")
            .output()
            .ok()
            .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string())
            .filter(|dir| !dir.is_empty());

        // Asked for rather than hardcoded: the path carries the clang version,
        // so it moves with every Xcode update.
        if let Some(dir) = dir {
            if std::path::Path::new(&dir)
                .join("libclang_rt.osx.a")
                .is_file()
            {
                println!("cargo:rustc-link-search=native={dir}");
                println!("cargo:rustc-link-lib=static=clang_rt.osx");
            }
        }
    }

    tauri_build::build()
}
