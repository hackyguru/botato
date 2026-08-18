#!/bin/bash
# Builds the peer-to-peer native library for iOS and Android, and generates the
# Swift and Kotlin bindings from it.
#
# The output goes straight into the Expo module, so the checked-in bindings
# always match the library they were generated from — a mismatch between the two
# is a crash at a call site rather than a compile error, which is a bad way to
# find out.
#
#   ./build.sh            # everything
#   ./build.sh ios        # or one platform at a time
#   ./build.sh android
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
crate="$here/botcage-p2p"
module="$here/../modules/botcage-p2p"
want="${1:-all}"

cd "$crate"

generate_bindings () {
  echo "→ bindings"
  cargo build --release
  rm -rf bindings
  cargo run --release --bin uniffi-bindgen -- generate \
    --library target/release/libbotcage_p2p.dylib --language swift --out-dir bindings/swift
  cargo run --release --bin uniffi-bindgen -- generate \
    --library target/release/libbotcage_p2p.dylib --language kotlin --out-dir bindings/kotlin --no-format
}

build_ios () {
  echo "→ ios"
  for target in aarch64-apple-ios aarch64-apple-ios-sim; do
    rustup target add "$target" >/dev/null 2>&1 || true
    cargo build --release --target "$target"
  done

  # xcodebuild wants headers in a directory with the modulemap under its
  # conventional name, not uniffi's.
  local headers="$crate/target/xcframework-headers"
  rm -rf "$headers" "$crate/target/BotcageP2P.xcframework"
  mkdir -p "$headers"
  cp bindings/swift/botcage_p2pFFI.h "$headers/"
  cp bindings/swift/botcage_p2pFFI.modulemap "$headers/module.modulemap"

  xcodebuild -create-xcframework \
    -library "target/aarch64-apple-ios/release/libbotcage_p2p.a" -headers "$headers" \
    -library "target/aarch64-apple-ios-sim/release/libbotcage_p2p.a" -headers "$headers" \
    -output "target/BotcageP2P.xcframework" >/dev/null

  mkdir -p "$module/ios"
  rm -rf "$module/ios/BotcageP2P.xcframework"
  cp -R "target/BotcageP2P.xcframework" "$module/ios/"
  cp bindings/swift/botcage_p2p.swift "$module/ios/"
  # The C header goes in the pod as well, so CocoaPods puts it in the umbrella
  # and the Rust symbols are visible to the generated Swift without depending on
  # the xcframework's own module being importable — which it is not, and which
  # fails silently because the generated code guards it with canImport.
  cp bindings/swift/botcage_p2pFFI.h "$module/ios/"
}

build_android () {
  echo "→ android"
  : "${ANDROID_NDK_HOME:=$HOME/Library/Android/sdk/ndk/27.1.12297006}"
  export ANDROID_NDK_HOME
  for target in aarch64-linux-android armv7-linux-androideabi x86_64-linux-android; do
    rustup target add "$target" >/dev/null 2>&1 || true
  done

  rm -rf jniLibs
  cargo ndk -t arm64-v8a -t armeabi-v7a -t x86_64 -o ./jniLibs build --release
  # cargo-ndk copies dependency dylibs beside ours; only ours is loaded.
  find jniLibs -name "*.so" ! -name "libbotcage_p2p.so" -delete

  mkdir -p "$module/android/src/main/jniLibs" "$module/android/src/main/java"
  rm -rf "$module/android/src/main/jniLibs"/*
  cp -R jniLibs/* "$module/android/src/main/jniLibs/"
  mkdir -p "$module/android/src/main/java/uniffi/botcage_p2p"
  cp bindings/kotlin/uniffi/botcage_p2p/botcage_p2p.kt \
     "$module/android/src/main/java/uniffi/botcage_p2p/"
}

generate_bindings
case "$want" in
  ios) build_ios ;;
  android) build_android ;;
  all) build_ios; build_android ;;
  *) echo "usage: build.sh [ios|android|all]" >&2; exit 1 ;;
esac

echo "done — artefacts are in $module"
