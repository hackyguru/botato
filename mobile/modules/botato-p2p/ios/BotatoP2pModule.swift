// The iOS side of botato's peer-to-peer link.
//
// Everything here is plumbing: the Rust library below does the work, and this
// hands its results to JavaScript. Requests run on Expo's background queue, and
// the event stream gets a thread of its own because it blocks until it ends.
import ExpoModulesCore

private final class Frames: EventSink {
  private weak var module: BotatoP2pModule?
  /// Which attempt this sink belongs to. A stream that is still unwinding must
  /// not report anything about the one that replaced it.
  private let generation: Int

  init(module: BotatoP2pModule, generation: Int) {
    self.module = module
    self.generation = generation
  }

  func onFrame(name: String, data: String) {
    module?.emit(name: name, data: data, from: generation)
  }

  func onState(connected: Bool) {
    module?.emit(connected: connected, from: generation)
  }
}

public class BotatoP2pModule: Module {
  private var peer: Peer?
  /// Counts attempts to open the event stream, so a stale one can be ignored
  /// rather than blocking its own replacement.
  private var generation = 0

  func emit(name: String, data: String, from: Int) {
    guard from == generation else { return }
    sendEvent("frame", ["name": name, "data": data])
  }

  func emit(connected: Bool, from: Int) {
    guard from == generation else { return }
    sendEvent("state", ["connected": connected])
  }

  public func definition() -> ModuleDefinition {
    Name("BotatoP2p")
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
    //
    // Never refused because one is already running. The previous stream is
    // usually still unwinding when a retry arrives — blocked in a read, or in a
    // dial that has not timed out — and turning the retry away silently was
    // what left the light amber after a laptop came back: there was no stream,
    // and no event to try again on.
    Function("listen") { (token: String?) in
      guard let peer = self.peer else { return }
      self.generation += 1
      let mine = self.generation
      peer.stop()

      let sink = Frames(module: self, generation: mine)
      let thread = Thread {
        do {
          try peer.listen(token: token, sink: sink)
        } catch {
          // Whatever went wrong, the stream is not running — and the app can
          // only retry if it is told so.
          self.emit(connected: false, from: mine)
        }
      }
      thread.name = "botato.p2p.events"
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
    "this phone is not connected to a botato yet"
  }
}

/// Carries a Rust error's own words across to JavaScript.
///
/// Without this, Expo wraps anything it does not recognise as
/// `UnexpectedException: BotatoP2p.P2pError.Unreachable(reason: "…")` — the
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
