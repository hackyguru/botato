Pod::Spec.new do |s|
  s.name           = 'BotcageP2p'
  s.version        = '1.0.0'
  s.summary        = "botcage's peer-to-peer link"
  s.description    = 'Reaches a botcage on your own machine by public key, over QUIC.'
  s.author         = 'botcage'
  s.homepage       = 'https://github.com/hackyguru/botcage'
  s.platforms      = {
    :ios => '16.4',
    :tvos => '16.4'
  }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    # Where CocoaPods unpacks the xcframework's slice. Without this the
    # generated bindings' `#if canImport(botcage_p2pFFI)` quietly fails and
    # every Rust symbol goes missing at compile time — a silent guard around a
    # missing search path, which is a miserable thing to debug.
    'SWIFT_INCLUDE_PATHS' => '"$(PODS_XCFRAMEWORKS_BUILD_DIR)/BotcageP2p"',
  }

  # Everything except the xcframework's own contents: sweeping its headers into
  # source_files makes CocoaPods pass -lbotcage_p2p instead of linking the
  # framework, and the build then fails with "library not found".
  s.source_files = "*.{h,m,mm,swift,hpp,cpp}"
  s.exclude_files = "BotcageP2P.xcframework/**/*"

  # The Rust library and the bindings generated from it. Built by
  # ../rust/build.sh, which regenerates both together so they cannot disagree.
  s.vendored_frameworks = 'BotcageP2P.xcframework'
end
