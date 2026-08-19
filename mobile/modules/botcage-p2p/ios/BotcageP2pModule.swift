// The iOS side of botcage's peer-to-peer link.
//
// Everything here is plumbing: the Rust library below does the work, and this
// hands its results to JavaScript. Requests run on Expo's background queue, and
// the event stream gets a thread of its own because it blocks until it ends.
import ExpoModulesCore

private final class Frames: EventSink {
  private weak var module: BotcageP2pModule?

  init(module: BotcageP2pModule) {
    self.module = module
  }

  func onFrame(name: String, data: String) {
    module?.emit(name: name, data: data)
  }

  func onState(connected: Bool) {
    module?.emit(connected: connected)
  }
}

public class BotcageP2pModule: Module {
  private var peer: Peer?
  private var streaming: Thread?

  func emit(name: String, data: String) {
    sendEvent("frame", ["name": name, "data": data])
  }

  func emit(connected: Bool) {
    sendEvent("state", ["connected": connected])
  }

  public func definition() -> ModuleDefinition {
    Name("BotcageP2p")
    Events("frame", "state")

    AsyncFunction("connect") { (address: String) -> String in
      do {
        let peer = try Peer.connect(address: address)
        self.peer = peer
        return peer.id()
      } catch {
        throw LinkFailed(error)
      }
    }

    AsyncFunction("request") { (method: String, path: String, token: String?, body: String?) -> [String: Any] in
      guard let peer = self.peer else {
        throw NotConnected()
      }
      do {
        let response = try peer.request(method: method, path: path, token: token, body: body)
        return ["status": Int(response.status), "body": response.body]
      } catch {
        throw LinkFailed(error)
      }
    }

    // Not async: it returns at once and the stream runs on its own thread, so
    // the JavaScript side is never left holding a promise for hours.
    Function("listen") { (token: String?) in
      guard let peer = self.peer, self.streaming == nil else { return }
      let sink = Frames(module: self)
      let thread = Thread {
        do {
          try peer.listen(token: token, sink: sink)
        } catch {
          // Whatever went wrong, the stream is not running — and the app can
          // only retry if it is told so.
          self.emit(connected: false)
        }
        self.streaming = nil
      }
      thread.name = "botcage.p2p.events"
      self.streaming = thread
      thread.start()
    }

    Function("stop") {
      self.peer?.stop()
    }

    Function("isConnected") { () -> Bool in
      self.peer != nil
    }
  }
}

private final class NotConnected: Exception {
  override var reason: String {
    "this phone is not connected to a botcage yet"
  }
}

/// Carries a Rust error's own words across to JavaScript.
///
/// Without this, Expo wraps anything it does not recognise as
/// `UnexpectedException: BotcageP2p.P2pError.Unreachable(reason: "…")` — the
/// sentence is in there, buried in a type name and a file position that mean
/// nothing to whoever is holding the phone.
private final class LinkFailed: Exception {
  private let why: String

  init(_ error: Error) {
    if let p2p = error as? P2pError {
      switch p2p {
      case let .Unreachable(reason): why = reason
      case let .Failed(reason): why = reason
      }
    } else {
      why = String(describing: error)
    }
    super.init()
  }

  required init() {
    why = "something went wrong"
    super.init()
  }

  override var reason: String { why }
}
