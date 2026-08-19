// The Android side of botcage's peer-to-peer link. A mirror of the iOS module:
// the Rust library does the work, this hands its results to JavaScript.
package expo.modules.botcagep2p

import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlin.concurrent.thread
import uniffi.botcage_p2p.EventSink
import uniffi.botcage_p2p.Peer

class NotConnectedException :
  CodedException("this phone is not connected to a botcage yet")

class BotcageP2pModule : Module() {
  private var peer: Peer? = null

  /** Counts attempts to open the event stream, so a stale one can be ignored
   *  rather than blocking its own replacement. */
  private var generation = 0

  override fun definition() = ModuleDefinition {
    Name("BotcageP2p")
    Events("frame", "state")

    AsyncFunction("connect") { address: String ->
      val opened = Peer.connect(address)
      peer = opened
      opened.id()
    }

    AsyncFunction("request") { method: String, path: String, token: String?, body: String? ->
      val open = peer ?: throw NotConnectedException()
      val response = open.request(method, path, token, body)
      mapOf("status" to response.status.toInt(), "body" to response.body)
    }

    // Never refused because one is already running: the previous stream is
    // usually still unwinding when a retry arrives, and turning the retry away
    // silently leaves nothing to try again on.
    Function("listen") { token: String? ->
      val open = peer ?: return@Function null
      generation += 1
      val mine = generation
      open.stop()

      thread(name = "botcage.p2p.events") {
        val sink = object : EventSink {
          override fun onFrame(name: String, data: String) {
            if (mine == generation) sendEvent("frame", mapOf("name" to name, "data" to data))
          }

          override fun onState(connected: Boolean) {
            if (mine == generation) sendEvent("state", mapOf("connected" to connected))
          }
        }
        try {
          open.listen(token, sink)
        } catch (_: Exception) {
          if (mine == generation) sendEvent("state", mapOf("connected" to false))
        }
      }
      null
    }

    Function("stop") {
      peer?.stop()
      null
    }

    Function("isConnected") {
      peer != null
    }
  }
}
