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
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"

  # The Rust library and the bindings generated from it. Built by
  # ../rust/build.sh, which regenerates both together so they cannot disagree.
  s.vendored_frameworks = 'BotcageP2P.xcframework'
end
