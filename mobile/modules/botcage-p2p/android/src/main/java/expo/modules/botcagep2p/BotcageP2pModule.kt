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
  private var streaming: Thread? = null

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

    // Returns at once; the stream blocks on a thread of its own.
    // Returns null rather than Unit: Expo's Function expects a value.
    Function("listen") { token: String? ->
      val open = peer ?: return@Function null
      if (streaming != null) return@Function null
      streaming = thread(name = "botcage.p2p.events") {
        val sink = object : EventSink {
          override fun onFrame(name: String, data: String) {
            sendEvent("frame", mapOf("name" to name, "data" to data))
          }

          override fun onState(connected: Boolean) {
            sendEvent("state", mapOf("connected" to connected))
          }
        }
        try {
          open.listen(token, sink)
        } catch (_: Exception) {
          sendEvent("state", mapOf("connected" to false))
        } finally {
          streaming = null
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
