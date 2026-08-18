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

  # A Rust static library cannot declare what it needs from the system, so its
  # dependencies are named here: iroh reads the device's DNS servers and network
  # state through SystemConfiguration, and reaches the keychain through Security.
  s.frameworks = 'SystemConfiguration', 'Security'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    # Where CocoaPods unpacks the xcframework's slice. Without this the
    # generated bindings' `#if canImport(botcage_p2pFFI)` quietly fails and
    # every Rust symbol goes missing at compile time — a silent guard around a
    # missing search path, which is a miserable thing to debug.
    'SWIFT_INCLUDE_PATHS' => '"$(PODS_XCFRAMEWORKS_BUILD_DIR)/BotcageP2p"',
    'LIBRARY_SEARCH_PATHS' => '"$(PODS_XCFRAMEWORKS_BUILD_DIR)/BotcageP2p"',
  }

  # The app target does the final link, and CocoaPods only puts the pod's own
  # build directory on its search path — not the one the xcframework's slice is
  # unpacked into. Without this the link fails with "library 'botcage_p2p' not
  # found" even though the framework is present and correctly declared.
  s.user_target_xcconfig = {
    'LIBRARY_SEARCH_PATHS' => '"$(PODS_XCFRAMEWORKS_BUILD_DIR)/BotcageP2p"',
  }

  # Everything except the xcframework's own contents: sweeping its headers into
  # source_files makes CocoaPods try to compile them.
  s.source_files = "*.{h,m,mm,swift,hpp,cpp}"
  s.exclude_files = "BotcageP2P.xcframework/**/*"
  s.preserve_paths = "BotcageP2P.xcframework/**/*"

  # Linked by hand rather than through `vendored_frameworks`.
  #
  # That option describes *frameworks*: CocoaPods writes a copy phase whose
  # declared output is `BotcageP2P.framework`, which this xcframework does not
  # contain — it wraps a static library — so the phase quietly produces nothing
  # and the app fails to link against a library that was never unpacked.
  #
  # Naming the slice per SDK is unambiguous and needs no copy phase at all.
  # -force_load because the Rust symbols are reached through a module map rather
  # than referenced directly, and the linker would otherwise drop the archive.
  xcframework = '$(PODS_ROOT)/../../modules/botcage-p2p/ios/BotcageP2P.xcframework'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_INCLUDE_PATHS[sdk=iphonesimulator*]' => "\"#{xcframework}/ios-arm64_x86_64-simulator/Headers\"",
    'SWIFT_INCLUDE_PATHS[sdk=iphoneos*]' => "\"#{xcframework}/ios-arm64/Headers\"",
  }

  # $(inherited) is not optional: an SDK-conditional assignment replaces the
  # value for that SDK, so leaving it out drops every other linker flag —
  # including the one that links this pod — and the build then fails on a
  # missing protocol conformance rather than on anything to do with the library
  # being added here.
  s.user_target_xcconfig = {
    'OTHER_LDFLAGS[sdk=iphonesimulator*]' =>
      "$(inherited) -force_load \"#{xcframework}/ios-arm64_x86_64-simulator/libbotcage_p2p.a\"",
    'OTHER_LDFLAGS[sdk=iphoneos*]' =>
      "$(inherited) -force_load \"#{xcframework}/ios-arm64/libbotcage_p2p.a\"",
  }
end
