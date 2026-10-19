/**
 * FaceDEV same-origin WebSocket ↔ Xinqi /api/realtime 代理。
 */

import { WebSocketServer, WebSocket } from "ws"
import {
  XINQI_BACKPRESSURE_BYTES,
  XINQI_BROWSER_TO_UPSTREAM_TYPES,
  XINQI_INPUT_FRAME_BYTES,
  XINQI_UPSTREAM_TO_BROWSER_TYPES,
  XINQI_WS_MAX_PAYLOAD,
} from "./xinqiConfig.js"
import { XINQI_ERROR_CODES } from "./xinqiErrors.js"

function safeSendJson(socket, payload) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false
  try {
    socket.send(JSON.stringify(payload))
    return true
  } catch {
    return false
  }
}

function closeQuiet(socket, code = 1000, reason = "done") {
  if (!socket) return
  try {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close(code, String(reason || "done").slice(0, 120))
    }
  } catch {
    /* ignore */
  }
}

function exceedsBackpressure(socket) {
  return Boolean(socket && typeof socket.bufferedAmount === "number"
    && socket.bufferedAmount > XINQI_BACKPRESSURE_BYTES)
}

function reasonText(reason) {
  if (reason == null) return ""
  if (Buffer.isBuffer(reason)) return reason.toString("utf8")
  return String(reason)
}

/**
 * @param {object} options
 * @param {import('node:http').Server} options.httpServer
 * @param {ReturnType<import('./xinqiGatewaySession.js').createXinqiGatewaySessionStore>} options.sessionStore
 * @param {() => string} options.getUpstreamWsBaseUrl
 * @param {() => string} options.getUpstreamOrigin
 * @param {typeof WebSocket} [options.WebSocketImpl]
 * @param {string} [options.pathPrefix]
 * @param {(req: import('node:http').IncomingMessage) => { ok: boolean, code?: string, reason?: string }|null|undefined} [options.authorizeUpgrade]
 */
export function attachXinqiRealtimeGateway({
  httpServer,
  sessionStore,
  getUpstreamWsBaseUrl,
  getUpstreamOrigin,
  WebSocketImpl = WebSocket,
  pathPrefix = "/api/voice/xinqi/realtime",
  authorizeUpgrade = null,
} = {}) {
  if (!httpServer) throw new Error("attachXinqiRealtimeGateway requires httpServer")
  if (!sessionStore) throw new Error("attachXinqiRealtimeGateway requires sessionStore")

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: XINQI_WS_MAX_PAYLOAD,
  })

  function handleBrowserConnection(browserWs, gatewaySessionId) {
    let upstream = null
    let cleaned = false
    let ready = false
    let firstClose = null
    const openedAt = Date.now()
    const relayStats = {
      upstreamMsg: 0,
      upstreamAudio: 0,
      upstreamAudioDone: 0,
      browserAudioTx: 0,
      browserAudioDoneTx: 0,
      browserAudioBytesTx: 0,
      droppedType: 0,
      droppedBinary: 0,
    }

    const recordFirstClose = (side, code, reason, cleanupReason) => {
      if (firstClose) return firstClose
      firstClose = {
        side,
        code: Number.isInteger(code) ? code : null,
        reason: reasonText(reason).slice(0, 120),
        cleanupReason: String(cleanupReason || "").slice(0, 80),
        at: Date.now(),
        connectionMs: Date.now() - openedAt,
      }
      console.info("[xinqi-gw] first close", {
        gatewaySessionId: String(gatewaySessionId || "").slice(0, 8),
        side: firstClose.side,
        code: firstClose.code,
        reason: firstClose.reason,
        cleanupReason: firstClose.cleanupReason,
        connectionMs: firstClose.connectionMs,
      })
      return firstClose
    }

    const notifyBrowserClose = (side, code, reason, cleanupReason) => {
      const info = recordFirstClose(side, code, reason, cleanupReason)
      safeSendJson(browserWs, {
        type: "error",
        code: side === "upstream"
          ? XINQI_ERROR_CODES.UpstreamUnavailable
          : XINQI_ERROR_CODES.ConnectFailed,
        message: side === "upstream"
          ? "Xinqi 上游 realtime 连接已关闭。"
          : "Browser realtime 连接已关闭。",
        closeSide: info.side,
        closeCode: info.code,
        closeReason: info.reason,
        cleanupReason: info.cleanupReason,
        connectionMs: info.connectionMs,
      })
    }

    const cleanup = (cleanupReason = "cleanup", details = {}) => {
      if (cleaned) return
      cleaned = true
      const side = details.side || (firstClose?.side) || "gateway"
      const info = recordFirstClose(
        side,
        details.code,
        details.reason,
        cleanupReason,
      )
      console.info("[xinqi-gw] relay summary", {
        gatewaySessionId: String(gatewaySessionId || "").slice(0, 8),
        ...relayStats,
        cleanupReason: String(cleanupReason || "").slice(0, 80),
      })
      sessionStore.remove(gatewaySessionId)
      closeQuiet(upstream, 1000, cleanupReason)
      // Prefer a descriptive close reason for the browser when we initiated cleanup.
      if (browserWs.readyState === WebSocket.OPEN || browserWs.readyState === WebSocket.CONNECTING) {
        const browserReason = [
          info.side,
          info.code != null ? `code=${info.code}` : "",
          info.reason || cleanupReason,
        ].filter(Boolean).join(" ").slice(0, 120)
        closeQuiet(browserWs, 1000, browserReason || cleanupReason)
      }
      upstream = null
    }

    const fail = (code, message, details = {}) => {
      safeSendJson(browserWs, {
        type: "error",
        code,
        message,
        closeSide: details.side || "gateway",
        closeCode: details.code ?? null,
        closeReason: reasonText(details.reason).slice(0, 120),
        cleanupReason: String(code || "").slice(0, 80),
        connectionMs: Date.now() - openedAt,
        expectedBytes: details.expectedBytes ?? null,
        actualBytes: details.actualBytes ?? null,
        dataType: details.dataType ? String(details.dataType).slice(0, 40) : "",
        byteOffset: Number.isInteger(details.byteOffset) ? details.byteOffset : null,
        stage: "gateway_browser_message",
      })
      cleanup(code, { side: details.side || "gateway", code: details.code, reason: details.reason || message })
    }

    const bound = sessionStore.markWsBound(gatewaySessionId)
    if (bound.status !== 200) {
      fail(bound.body?.error?.code || XINQI_ERROR_CODES.SessionNotFound, bound.body?.error?.message || "session invalid")
      return
    }

    const session = bound.session
    const wsPath = session.protocol?.websocketPath || "/api/realtime"
    const upstreamUrl = `${getUpstreamWsBaseUrl()}${wsPath.startsWith("/") ? wsPath : `/${wsPath}`}`
    const origin = getUpstreamOrigin()

    try {
      upstream = new WebSocketImpl(upstreamUrl, {
        headers: {
          Origin: origin,
        },
        maxPayload: XINQI_WS_MAX_PAYLOAD,
      })
    } catch (error) {
      console.error("[xinqi-gw] upstream construct failed", error?.name || error)
      fail(XINQI_ERROR_CODES.UpstreamUnavailable, "无法建立 Xinqi realtime 连接。")
      return
    }

    upstream.on("open", () => {
      if (cleaned) return
      safeSendJson(upstream, {
        type: "start",
        token: session.upstreamToken,
        sessionId: session.sessionId,
        microphone: true,
      })
    })

    upstream.on("message", (data, isBinary) => {
      if (cleaned) return
      if (exceedsBackpressure(browserWs)) {
        fail(XINQI_ERROR_CODES.Backpressure, "Browser WebSocket 背压过高。", { side: "gateway" })
        return
      }
      if (isBinary) {
        // Xinqi 当前 realtime 主要是 JSON；binary 默认不转发
        relayStats.droppedBinary += 1
        return
      }
      const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data)
      let msg
      try {
        msg = JSON.parse(text)
      } catch {
        return
      }
      const type = String(msg?.type || "")
      relayStats.upstreamMsg += 1
      if (!XINQI_UPSTREAM_TO_BROWSER_TYPES.includes(type)) {
        relayStats.droppedType += 1
        return
      }
      if (type === "ready") ready = true
      if (type === "audio") relayStats.upstreamAudio += 1
      if (type === "audio.done") relayStats.upstreamAudioDone += 1
      try {
        browserWs.send(text)
        if (type === "audio") {
          relayStats.browserAudioTx += 1
          relayStats.browserAudioBytesTx += Buffer.byteLength(text, "utf8")
          if (relayStats.browserAudioTx === 1 || relayStats.browserAudioTx % 20 === 0) {
            console.info("[xinqi-gw] audio relay", {
              gatewaySessionId: String(gatewaySessionId || "").slice(0, 8),
              upstreamAudio: relayStats.upstreamAudio,
              browserAudioTx: relayStats.browserAudioTx,
              browserAudioBytesTx: relayStats.browserAudioBytesTx,
              audioDoneTx: relayStats.browserAudioDoneTx,
              msgChars: text.length,
              hasData: typeof msg?.data === "string" && msg.data.length > 0,
              dataChars: typeof msg?.data === "string" ? msg.data.length : 0,
            })
          }
        }
        if (type === "audio.done") {
          relayStats.browserAudioDoneTx += 1
          console.info("[xinqi-gw] audio.done relay", {
            gatewaySessionId: String(gatewaySessionId || "").slice(0, 8),
            upstreamAudio: relayStats.upstreamAudio,
            browserAudioTx: relayStats.browserAudioTx,
            browserAudioDoneTx: relayStats.browserAudioDoneTx,
          })
        }
      } catch (error) {
        console.error("[xinqi-gw] browser send failed", error?.name || error)
        cleanup("browser_send_failed", { side: "browser", reason: "browser_send_failed" })
      }
    })

    upstream.on("error", (error) => {
      console.error("[xinqi-gw] upstream error", error?.name || error)
      if (!cleaned) {
        fail(XINQI_ERROR_CODES.UpstreamUnavailable, "Xinqi realtime 连接错误。", {
          side: "upstream",
          reason: error?.message || "upstream_error",
        })
      }
    })

    upstream.on("close", (code, reason) => {
      if (cleaned) return
      notifyBrowserClose("upstream", code, reason, "upstream_close")
      cleanup("upstream_close", { side: "upstream", code, reason })
    })

    browserWs.on("message", (data, isBinary) => {
      if (cleaned) return
      if (!upstream || upstream.readyState !== WebSocket.OPEN) return

      if (exceedsBackpressure(upstream)) {
        fail(XINQI_ERROR_CODES.Backpressure, "Xinqi WebSocket 背压过高。", { side: "gateway" })
        return
      }

      // ws 文本帧的 data 也是 Buffer；只能用 isBinary 区分 PCM 与 control JSON。
      if (isBinary) {
        let buf
        let byteOffset = 0
        if (Buffer.isBuffer(data)) {
          buf = data
          byteOffset = data.byteOffset || 0
        } else if (data instanceof ArrayBuffer) {
          buf = Buffer.from(data)
        } else if (ArrayBuffer.isView(data)) {
          buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
          byteOffset = data.byteOffset
        } else {
          fail(XINQI_ERROR_CODES.InvalidAudioFrame, "收到无法解析的二进制音频帧。", {
            side: "gateway",
            reason: "unsupported_binary_type",
            expectedBytes: XINQI_INPUT_FRAME_BYTES,
            actualBytes: null,
            dataType: typeof data,
          })
          return
        }
        const actualBytes = buf.byteLength
        const dataType = Buffer.isBuffer(data)
          ? "Buffer"
          : data instanceof ArrayBuffer
            ? "ArrayBuffer"
            : ArrayBuffer.isView(data)
              ? data.constructor?.name || "TypedArray"
              : typeof data
        if (actualBytes !== XINQI_INPUT_FRAME_BYTES) {
          console.info("[xinqi-gw] reject binary frame", {
            gatewaySessionId: String(gatewaySessionId || "").slice(0, 8),
            ready,
            actualBytes,
            expectedBytes: XINQI_INPUT_FRAME_BYTES,
            dataType,
            byteOffset,
            upstreamState: upstream.readyState,
          })
          fail(
            XINQI_ERROR_CODES.InvalidAudioFrame,
            `音频帧必须为 ${XINQI_INPUT_FRAME_BYTES} 字节，实际 ${actualBytes}（${dataType}）。`,
            {
              side: "gateway",
              reason: "byte_length_mismatch",
              expectedBytes: XINQI_INPUT_FRAME_BYTES,
              actualBytes,
              dataType,
              byteOffset,
            },
          )
          return
        }
        if (!ready) {
          fail(XINQI_ERROR_CODES.MessageRejected, "Xinqi 尚未 ready，拒绝音频帧。", {
            side: "gateway",
            reason: "not_ready",
            expectedBytes: XINQI_INPUT_FRAME_BYTES,
            actualBytes,
            dataType,
          })
          return
        }
        try {
          upstream.send(buf)
        } catch (error) {
          console.error("[xinqi-gw] upstream binary send failed", error?.name || error)
          cleanup("upstream_send_failed", { side: "upstream", reason: "upstream_send_failed" })
        }
        return
      }

      const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data)
      let msg
      try {
        msg = JSON.parse(text)
      } catch {
        fail(XINQI_ERROR_CODES.MessageRejected, "仅允许 JSON control 或 3200B PCM。", {
          side: "gateway",
          reason: "invalid_json",
          actualBytes: Buffer.isBuffer(data) ? data.byteLength : text.length,
          dataType: Buffer.isBuffer(data) ? "Buffer(text)" : typeof data,
        })
        return
      }
      const type = String(msg?.type || "")
      if (!XINQI_BROWSER_TO_UPSTREAM_TYPES.includes(type)) {
        fail(XINQI_ERROR_CODES.MessageRejected, `不允许的 control message：${type || "unknown"}`, {
          side: "gateway",
          reason: "control_rejected",
        })
        return
      }
      // 禁止浏览器注入 token
      if ("token" in msg) {
        fail(XINQI_ERROR_CODES.MessageRejected, "Browser 不得提交 upstream token。", {
          side: "gateway",
          reason: "token_injection",
        })
        return
      }
      try {
        upstream.send(JSON.stringify(msg))
      } catch (error) {
        console.error("[xinqi-gw] upstream json send failed", error?.name || error)
        cleanup("upstream_send_failed", { side: "upstream", reason: "upstream_send_failed" })
      }
    })

    browserWs.on("close", (code, reason) => {
      if (cleaned) return
      recordFirstClose("browser", code, reason, "browser_close")
      cleanup("browser_close", { side: "browser", code, reason })
    })

    browserWs.on("error", (error) => {
      console.error("[xinqi-gw] browser error", error?.name || error)
      if (!cleaned) cleanup("browser_error", { side: "browser", reason: error?.message || "browser_error" })
    })
  }

  const onUpgrade = (req, socket, head) => {
    const host = req.headers.host || "localhost"
    let url
    try {
      url = new URL(req.url || "/", `http://${host}`)
    } catch {
      return
    }
    if (url.pathname !== pathPrefix) return

    if (typeof authorizeUpgrade === "function") {
      let auth
      try {
        auth = authorizeUpgrade(req)
      } catch {
        auth = { ok: false, reason: "authorize_threw" }
      }
      if (!auth?.ok) {
        try {
          const reason = String(auth?.reason || auth?.code || "forbidden").slice(0, 64)
          socket.write(
            "HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n"
            + reason,
          )
        } catch { /* ignore */ }
        try { socket.destroy() } catch { /* ignore */ }
        return
      }
    }

    const gatewaySessionId = url.searchParams.get("session") || ""
    wss.handleUpgrade(req, socket, head, (ws) => {
      handleBrowserConnection(ws, gatewaySessionId)
    })
  }

  httpServer.on("upgrade", onUpgrade)

  return {
    close() {
      httpServer.off("upgrade", onUpgrade)
      try { wss.close() } catch { /* ignore */ }
    },
  }
}
