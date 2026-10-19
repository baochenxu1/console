/**
 * FaceDEV Neck Bridge WebSocket client（facedev-neck-v1）· Phase 2 connectivity。
 * - 仅用户点击 Connect 才访问 localhost
 * - heartbeat 与 Timeline/target 独立
 * - STALE 停 target，需显式 Resume
 * - target latest-wins + bufferedAmount backpressure
 * - control / heartbeat 不受 target backlog 阻塞
 */

import { normalizeNeckPose } from "./neckPose.js"
import {
  FACEDEV_NECK_PROTOCOL_VERSION,
  NECK_BRIDGE_CLIENT_STATES,
  NECK_BRIDGE_DEFAULT_HTTP,
  NECK_BRIDGE_DEFAULT_WS,
  NECK_BRIDGE_UI_STATES,
  createClientHello,
  createNeckConnectMessage,
  createNeckDisconnectMessage,
  createNeckTargetMessage,
  createSessionHeartbeat,
  createSessionResume,
  isServerHelloAccepted,
  NECK_TARGET_DISPATCH_DECISIONS,
} from "./neckBridgeProtocol.js"
import {
  NECK_BRIDGE_ERROR_CODES,
  classifyCapabilitiesFailure,
  classifyHealthFailure,
  classifyHelloRejection,
  classifyWebSocketFailure,
  createNeckBridgeError,
} from "./neckBridgeErrors.js"
import {
  PERMISSION_STATES,
  detectLocalBridgeEnvironment,
  isNeckLocalHardwareSupported,
  queryLocalNetworkPermission,
} from "./neckLocalBridgeCapability.js"
import {
  createNeckBrowserShadow,
  resolveBrowserCoreShadowEnabled,
  resolveBrowserProtocolShadowEnabled,
} from "./neckBrowserShadow.js"

/** 超过该 bufferedAmount 时暂停塞入 target（仍保留 latest pending） */
export const NECK_TARGET_BUFFERED_AMOUNT_SOFT_LIMIT = 8 * 1024

let _sharedClient = null
let _sharedRefCount = 0
let _nextInstanceSerial = 1
let _activeSocketCount = 0

function createSessionId() {
  return `ns_${Date.now().toString(16)}_${Math.random().toString(16).slice(2, 8)}`
}

function createInstanceId() {
  const n = _nextInstanceSerial++
  return `nbc_${n}_${Math.random().toString(16).slice(2, 6)}`
}

function createWsConnectionId() {
  return `ws_${Date.now().toString(16)}_${Math.random().toString(16).slice(2, 6)}`
}

function nowMs() {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now()
}

/**
 * 页面级唯一 NeckBridgeClient（Panel / Editor / Timeline 共享）。
 */
export function getSharedNeckBridgeClient(options = {}) {
  if (!_sharedClient) {
    _sharedClient = createNeckBridgeClient({ ...options, _shared: true })
    _sharedRefCount = 0
  }
  _sharedRefCount += 1
  return _sharedClient
}

/** 释放共享引用；最后一个引用释放时 disconnect。 */
export function releaseSharedNeckBridgeClient() {
  if (!_sharedClient) return
  _sharedRefCount = Math.max(0, _sharedRefCount - 1)
  if (_sharedRefCount === 0) {
    try {
      _sharedClient.disconnect()
    } catch {
      //
    }
    _sharedClient = null
  }
}

export function getActiveNeckSocketCount() {
  return _activeSocketCount
}

/** 测试辅助 */
export function _resetNeckBridgeClientSingletonsForTest() {
  try {
    _sharedClient?.disconnect?.()
  } catch {
    //
  }
  _sharedClient = null
  _sharedRefCount = 0
  _activeSocketCount = 0
}

function mapUiState(state, errorCode) {
  if (errorCode === NECK_BRIDGE_ERROR_CODES.UNSUPPORTED_BROWSER) {
    return NECK_BRIDGE_UI_STATES.UNSUPPORTED_BROWSER
  }
  if (errorCode === NECK_BRIDGE_ERROR_CODES.LOCAL_NETWORK_PERMISSION_DENIED) {
    return NECK_BRIDGE_UI_STATES.PERMISSION_DENIED
  }
  if (errorCode === NECK_BRIDGE_ERROR_CODES.LOCAL_NETWORK_PERMISSION_REQUIRED) {
    return NECK_BRIDGE_UI_STATES.PERMISSION_REQUIRED
  }
  if (errorCode === NECK_BRIDGE_ERROR_CODES.BRIDGE_NOT_RUNNING) {
    return NECK_BRIDGE_UI_STATES.BRIDGE_NOT_FOUND
  }
  if (errorCode === NECK_BRIDGE_ERROR_CODES.BRIDGE_BUSY) {
    return NECK_BRIDGE_UI_STATES.BUSY
  }
  if (state === NECK_BRIDGE_CLIENT_STATES.STALE) return NECK_BRIDGE_UI_STATES.STALE
  if (state === NECK_BRIDGE_CLIENT_STATES.SESSION_ACTIVE) return NECK_BRIDGE_UI_STATES.SESSION_ACTIVE
  if (state === NECK_BRIDGE_CLIENT_STATES.CONNECTED) return NECK_BRIDGE_UI_STATES.CONNECTED
  if (state === NECK_BRIDGE_CLIENT_STATES.CONNECTING) return NECK_BRIDGE_UI_STATES.CONNECTING
  if (state === NECK_BRIDGE_CLIENT_STATES.ERROR) return NECK_BRIDGE_UI_STATES.ERROR
  return NECK_BRIDGE_UI_STATES.DISCONNECTED
}

/**
 * @param {object} [options]
 */
export function createNeckBridgeClient(options = {}) {
  const httpBase = String(options.httpBase || NECK_BRIDGE_DEFAULT_HTTP).replace(/\/$/, "")
  const wsUrl = String(options.wsUrl || NECK_BRIDGE_DEFAULT_WS)
  const heartbeatIntervalMs = Math.max(50, Number(options.heartbeatIntervalMs) || 100)
  const staleAfterMs = Math.max(heartbeatIntervalMs * 3, Number(options.staleAfterMs) || 500)
  const bufferedAmountSoftLimit =
    Number(options.bufferedAmountSoftLimit) || NECK_TARGET_BUFFERED_AMOUNT_SOFT_LIMIT
  const fetchImpl = options.fetch || (typeof fetch !== "undefined" ? fetch.bind(globalThis) : null)
  const WebSocketImpl = options.WebSocket || (typeof WebSocket !== "undefined" ? WebSocket : null)
  const permissionsDep = options.permissions
  const envOverride = options.environment || null
  const browserShadow = createNeckBrowserShadow({
    enabled: resolveBrowserCoreShadowEnabled(options),
    protocolShadow: resolveBrowserProtocolShadowEnabled(options),
  })
  let lastShadowPlan = null

  const neckClientInstanceId = createInstanceId()

  let state = NECK_BRIDGE_CLIENT_STATES.DISCONNECTED
  let uiState = NECK_BRIDGE_UI_STATES.DISCONNECTED
  let socket = null
  let wsConnectionId = null
  let sessionId = ""
  let sequence = 0
  let capabilities = null
  let lastError = null
  let lastErrorObj = null
  let heartbeatTimer = null
  let staleTimer = null
  let pendingTarget = null
  let hardwarePreview = Boolean(options.hardwarePreview)
  let lastTargetPose = normalizeNeckPose({})
  let lastTimelineTimeMs = 0
  let lastAcceptedSequence = 0
  let targetDispatchEnabled = false
  let listeners = new Set()

  /** 同步门闩：必须在任何 await 之前置位，防止双击 Connect 双开 socket */
  let connectInFlight = false
  let connectAttemptCount = 0
  let lastServerHelloAccepted = null
  let lastServerHelloReason = null

  let healthAccess = "idle"
  let capabilitiesAccess = "idle"
  let websocketAccess = "idle"
  let permissionDiag = {
    supported: false,
    name: null,
    state: PERMISSION_STATES.UNSUPPORTED,
  }

  let lastHeartbeatSentAt = null
  let lastTargetSentAt = null
  let lastBufferedAmount = 0
  let bufferedAmountSamples = []
  /** @type {object|null} 最近一次 neck.state 的 state（不 console.log） */
  let lastNeckState = null
  let lastNeckStateUiEmitAt = -Infinity
  const neckStateUiEmitMinMs = Math.max(50, Number(options.neckStateUiEmitMinMs) || 200)
  /** @type {Map<string, { resolve: Function, timer: any, type: string }>} */
  let pendingCommandResults = new Map()
  /** @type {object|null} 最近一次 neck.connect / disconnect / enable Result */
  let lastHardwareCommandResult = null
  let lastHardwarePorts = []
  /** @type {string|null} */
  let lastTargetDispatchDecision = null
  /** @type {string|null} */
  let lastTargetDispatchReason = null
  let lastTargetDispatchSource = null
  let lastTargetDispatchEmitAt = -Infinity
  let streamStats = {
    targetPrepared: 0,
    targetPreparedCount: 0,
    targetSendAttemptCount: 0,
    targetSent: 0,
    targetSentCount: 0,
    bridgeAccepted: 0,
    sequenceGaps: 0,
    staleCount: 0,
    reconnectCount: 0,
    droppedDueToBackpressure: 0,
  }

  let pageHideBound = false
  let pageHideHandler = null
  let disposed = false

  function visibilityState() {
    return typeof document !== "undefined" ? document.visibilityState : "unknown"
  }

  function emit() {
    const snap = getSnapshot()
    for (const fn of listeners) {
      try {
        fn(snap)
      } catch {
        //
      }
    }
  }

  function setErrorState(errObj, clientState = NECK_BRIDGE_CLIENT_STATES.ERROR) {
    lastErrorObj = errObj
    lastError = errObj?.message || String(errObj)
    state = clientState
    uiState = mapUiState(state, errObj?.code)
    emit()
  }

  function setState(next, err = null) {
    state = next
    if (err != null) {
      if (typeof err === "object" && err.code) {
        lastErrorObj = err
        lastError = err.message
      } else {
        lastError = err
        lastErrorObj = createNeckBridgeError(NECK_BRIDGE_ERROR_CODES.UNKNOWN_ERROR, {
          detail: String(err),
        })
      }
    }
    uiState = mapUiState(state, lastErrorObj?.code)
    emit()
  }

  function clearTimers() {
    if (heartbeatTimer != null) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = null
    }
    if (staleTimer != null) {
      clearTimeout(staleTimer)
      staleTimer = null
    }
  }

  function bumpStaleWatch() {
    if (staleTimer != null) clearTimeout(staleTimer)
    staleTimer = setTimeout(() => {
      if (
        state === NECK_BRIDGE_CLIENT_STATES.SESSION_ACTIVE ||
        state === NECK_BRIDGE_CLIENT_STATES.CONNECTED
      ) {
        targetDispatchEnabled = false
        streamStats.staleCount += 1
        setState(
          NECK_BRIDGE_CLIENT_STATES.STALE,
          createNeckBridgeError(NECK_BRIDGE_ERROR_CODES.UNKNOWN_ERROR, {
            detail: "Neck Safe Hold / Stale",
          })
        )
        uiState = NECK_BRIDGE_UI_STATES.STALE
        emit()
      }
    }, staleAfterMs)
  }

  function readBufferedAmount() {
    const n = Number(socket?.bufferedAmount)
    lastBufferedAmount = Number.isFinite(n) ? n : 0
    return lastBufferedAmount
  }

  function sampleBufferedAmount() {
    const n = readBufferedAmount()
    bufferedAmountSamples.push(n)
    if (bufferedAmountSamples.length > 3000) bufferedAmountSamples.shift()
    return n
  }

  /** Control / heartbeat：不受 target backpressure 限制 */
  function sendControl(obj) {
    if (!socket || socket.readyState !== 1) return false
    try {
      socket.send(JSON.stringify(obj))
      return true
    } catch (err) {
      lastError = err?.message || String(err)
      return false
    }
  }

  function isSessionLive() {
    return (
      Boolean(sessionId) &&
      (state === NECK_BRIDGE_CLIENT_STATES.SESSION_ACTIVE ||
        state === NECK_BRIDGE_CLIENT_STATES.STALE)
    )
  }

  /** Bridge↔Hardware：以 neck.state.connected 为准（非 Browser↔Bridge session） */
  function isHardwareConnected() {
    return Boolean(lastNeckState && lastNeckState.connected === true)
  }

  function createCommandId(prefix) {
    return `${prefix}_${Date.now().toString(16)}_${Math.random().toString(16).slice(2, 6)}`
  }

  function settleCommandResult(msg) {
    const typ = String(msg?.type || "")
    if (!typ.endsWith("Result")) return false
    const id = msg.id != null ? String(msg.id) : ""
    const waiter = id ? pendingCommandResults.get(id) : null
    lastHardwareCommandResult = {
      type: typ,
      ok: msg.ok !== false && msg.accepted !== false,
      reason: msg.reason != null ? String(msg.reason) : null,
      id: id || null,
      raw: msg,
    }
    if (waiter) {
      pendingCommandResults.delete(id)
      if (waiter.timer != null) clearTimeout(waiter.timer)
      waiter.resolve(lastHardwareCommandResult)
      return true
    }
    // 无 id 的 Result：仍写入 snapshot，供 UI 显示
    emit()
    return false
  }

  function awaitCommandResult(type, extra = {}, timeoutMs = 8000) {
    const id = String(extra.id || createCommandId("cmd"))
    const payload = { ...extra, id }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingCommandResults.delete(id)
        const failed = {
          type: `${type}Result`,
          ok: false,
          reason: "TIMEOUT",
          id,
          raw: null,
        }
        lastHardwareCommandResult = failed
        emit()
        resolve(failed)
      }, timeoutMs)
      pendingCommandResults.set(id, { resolve, timer, type })
      const sent = sendSessionCommand(type, payload)
      if (!sent) {
        clearTimeout(timer)
        pendingCommandResults.delete(id)
        const failed = {
          type: `${type}Result`,
          ok: false,
          reason: "SEND_FAILED",
          id,
          raw: null,
        }
        lastHardwareCommandResult = failed
        emit()
        resolve(failed)
      }
    })
  }

  function flushTarget() {
    if (!pendingTarget) return
    if (!targetDispatchEnabled || state !== NECK_BRIDGE_CLIENT_STATES.SESSION_ACTIVE) {
      return
    }
    const buffered = sampleBufferedAmount()
    if (buffered > bufferedAmountSoftLimit) {
      streamStats.droppedDueToBackpressure += 1
      // 保留 pendingTarget（latest-wins），不把历史塞进 socket
      return
    }
    const msg = pendingTarget
    pendingTarget = null
    streamStats.targetSendAttemptCount += 1
    const ok = sendControl(msg)
    if (ok) {
      streamStats.targetSent += 1
      streamStats.targetSentCount += 1
      streamStats.bridgeAccepted += 1
      lastAcceptedSequence = msg.sequence
      lastTargetSentAt = nowMs()
      bumpStaleWatch()
      emit()
    }
    if (pendingTarget) {
      queueMicrotask(() => flushTarget())
    }
  }

  function startHeartbeat() {
    if (heartbeatTimer != null) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = null
    }
    heartbeatTimer = setInterval(() => {
      if (!sessionId) return
      // Pause Timeline 不停 heartbeat
      const ok = sendControl(createSessionHeartbeat({ sessionId, sequence }))
      if (ok) {
        lastHeartbeatSentAt = nowMs()
        bumpStaleWatch()
      }
      sampleBufferedAmount()
      emit()
    }, heartbeatIntervalMs)
    bumpStaleWatch()
  }

  async function probeHttp(path) {
    if (!fetchImpl) {
      return { ok: false, networkError: true, status: null, body: null }
    }
    try {
      const res = await fetchImpl(`${httpBase}${path}`, {
        method: "GET",
        mode: "cors",
        cache: "no-store",
      })
      let body = null
      try {
        body = await res.json()
      } catch {
        body = null
      }
      return {
        ok: res.ok,
        networkError: false,
        status: res.status,
        body,
      }
    } catch {
      return { ok: false, networkError: true, status: null, body: null }
    }
  }

  function bindPageHide() {
    if (pageHideBound || typeof window === "undefined") return
    pageHideBound = true
    pageHideHandler = () => {
      try {
        socket?.close?.()
      } catch {
        //
      }
    }
    window.addEventListener("pagehide", pageHideHandler)
    window.addEventListener("beforeunload", pageHideHandler)
  }

  function unbindPageHide() {
    if (!pageHideBound || typeof window === "undefined") return
    if (pageHideHandler) {
      window.removeEventListener("pagehide", pageHideHandler)
      window.removeEventListener("beforeunload", pageHideHandler)
    }
    pageHideBound = false
    pageHideHandler = null
  }

  function closeSocketQuietly() {
    if (!socket) return
    try {
      socket.onopen = null
      socket.onmessage = null
      socket.onerror = null
      socket.onclose = null
      socket.close()
    } catch {
      //
    }
    if (_activeSocketCount > 0) _activeSocketCount -= 1
    socket = null
    wsConnectionId = null
  }

  /**
   * 用户明确 Connect Neck 才调用。不在 page load 自动执行。
   * 幂等：CONNECTING / SESSION_ACTIVE / CONNECTED / in-flight → 不创建第二条 socket。
   */
  async function connect() {
    if (disposed) {
      return getSnapshot()
    }

    // 同步幂等门闩（必须在任何 await 之前）
    if (
      connectInFlight ||
      state === NECK_BRIDGE_CLIENT_STATES.CONNECTING ||
      state === NECK_BRIDGE_CLIENT_STATES.SESSION_ACTIVE ||
      state === NECK_BRIDGE_CLIENT_STATES.CONNECTED
    ) {
      return {
        ...getSnapshot(),
        alreadyConnected: true,
      }
    }
    connectInFlight = true
    connectAttemptCount += 1

    try {
      const env = envOverride || detectLocalBridgeEnvironment()
      if (!isNeckLocalHardwareSupported(env)) {
        setErrorState(createNeckBridgeError(NECK_BRIDGE_ERROR_CODES.UNSUPPORTED_BROWSER))
        return getSnapshot()
      }

      lastError = null
      lastErrorObj = null
      lastServerHelloAccepted = null
      lastServerHelloReason = null
      healthAccess = "pending"
      capabilitiesAccess = "idle"
      websocketAccess = "idle"
      targetDispatchEnabled = false
      setState(NECK_BRIDGE_CLIENT_STATES.CONNECTING)

      permissionDiag = await queryLocalNetworkPermission({ permissions: permissionsDep })
      if (permissionDiag.state === PERMISSION_STATES.DENIED) {
        healthAccess = "blocked"
        setErrorState(createNeckBridgeError(NECK_BRIDGE_ERROR_CODES.LOCAL_NETWORK_PERMISSION_DENIED))
        return getSnapshot()
      }

      const health = await probeHttp("/v1/health")
      if (!health.ok) {
        healthAccess = "failed"
        const err = classifyHealthFailure({
          httpStatus: health.status,
          permissionState: permissionDiag.state,
          networkError: health.networkError,
          healthOk: health.body?.ok,
          healthBody: health.body,
        })
        setErrorState(err)
        return getSnapshot()
      }
      if (health.body && health.body.ok === false) {
        healthAccess = "failed"
        setErrorState(createNeckBridgeError(NECK_BRIDGE_ERROR_CODES.BRIDGE_UNHEALTHY))
        return getSnapshot()
      }
      healthAccess = "ok"

      capabilitiesAccess = "pending"
      const caps = await probeHttp("/v1/capabilities")
      if (!caps.ok) {
        capabilitiesAccess = "failed"
        setErrorState(
          classifyCapabilitiesFailure({
            httpStatus: caps.status,
            networkError: caps.networkError,
          })
        )
        return getSnapshot()
      }
      capabilities = caps.body
      const proto =
        capabilities?.protocolVersion ||
        capabilities?.protocol ||
        capabilities?.neckProtocolVersion
      if (proto && String(proto) !== FACEDEV_NECK_PROTOCOL_VERSION) {
        capabilitiesAccess = "failed"
        setErrorState(
          createNeckBridgeError(NECK_BRIDGE_ERROR_CODES.PROTOCOL_MISMATCH, {
            detail: String(proto),
          })
        )
        return getSnapshot()
      }
      capabilitiesAccess = "ok"

      if (!WebSocketImpl) {
        websocketAccess = "failed"
        setErrorState(createNeckBridgeError(NECK_BRIDGE_ERROR_CODES.WEBSOCKET_FAILED))
        return getSnapshot()
      }

      if (sessionId) streamStats.reconnectCount += 1
      sessionId = createSessionId()
      sequence = 0
      websocketAccess = "pending"
      bindPageHide()
      closeSocketQuietly()

      return await new Promise((resolve) => {
        let settled = false
        const finish = (snap) => {
          if (settled) return
          settled = true
          resolve(snap)
        }

        try {
          socket = new WebSocketImpl(wsUrl)
          wsConnectionId = createWsConnectionId()
          _activeSocketCount += 1
        } catch (err) {
          websocketAccess = "failed"
          setErrorState(
            createNeckBridgeError(NECK_BRIDGE_ERROR_CODES.WEBSOCKET_FAILED, {
              detail: err?.message || String(err),
            })
          )
          finish(getSnapshot())
          return
        }

        const failWs = (errObj) => {
          clearTimers()
          closeSocketQuietly()
          websocketAccess = "failed"
          targetDispatchEnabled = false
          setErrorState(errObj)
          finish(getSnapshot())
        }

        socket.onopen = () => {
          websocketAccess = "open"
          setState(NECK_BRIDGE_CLIENT_STATES.CONNECTED)
          sendControl(createClientHello({ sessionId }))
        }

        socket.onmessage = (ev) => {
          let msg
          try {
            msg = JSON.parse(String(ev.data || "{}"))
          } catch {
            return
          }
          if (msg?.type === "server.hello") {
            lastServerHelloAccepted = Boolean(isServerHelloAccepted(msg))
            lastServerHelloReason = msg.reason != null ? String(msg.reason) : null
            if (!isServerHelloAccepted(msg)) {
              failWs(classifyHelloRejection(msg))
              return
            }
            websocketAccess = "ok"
            targetDispatchEnabled = true
            setState(NECK_BRIDGE_CLIENT_STATES.SESSION_ACTIVE)
            startHeartbeat()
            finish(getSnapshot())
            return
          }
          if (msg?.type === "session.resume.ack" || msg?.type === "server.resume") {
            if (msg.accepted === false) {
              lastErrorObj = createNeckBridgeError(NECK_BRIDGE_ERROR_CODES.SESSION_REJECTED, {
                detail: msg.reason || "resume rejected",
              })
              lastError = lastErrorObj.message
              emit()
              return
            }
            targetDispatchEnabled = true
            setState(NECK_BRIDGE_CLIENT_STATES.SESSION_ACTIVE)
            flushTarget()
            return
          }
          if (msg?.type === "server.error") {
            lastError = msg.message || "server.error"
            emit()
          }
          if (msg?.type && String(msg.type).endsWith("Result")) {
            settleCommandResult(msg)
            if (msg.ok === false || msg.accepted === false) {
              const reason = msg.reason != null ? String(msg.reason) : "command failed"
              const code =
                msg.type === "neck.connectResult"
                  ? NECK_BRIDGE_ERROR_CODES.HARDWARE_CONNECT_FAILED
                  : NECK_BRIDGE_ERROR_CODES.UNKNOWN_ERROR
              lastErrorObj = createNeckBridgeError(code, {
                detail: `${msg.type}: ${reason}`,
              })
              lastError = lastErrorObj.message
              emit()
            }
            bumpStaleWatch()
            return
          }
          if (msg?.type === "neck.state") {
            // 只保留最新 snapshot；不 console.log；UI emit 节流，避免 20Hz setState 风暴
            lastNeckState =
              msg.state && typeof msg.state === "object" ? msg.state : null
            const tEmit = nowMs()
            if (tEmit - lastNeckStateUiEmitAt >= neckStateUiEmitMinMs) {
              lastNeckStateUiEmitAt = tEmit
              emit()
            }
            bumpStaleWatch()
            return
          }
          bumpStaleWatch()
        }

        socket.onerror = () => {
          // onclose 收尾
        }

        socket.onclose = (ev) => {
          clearTimers()
          const wasSession =
            state === NECK_BRIDGE_CLIENT_STATES.SESSION_ACTIVE ||
            state === NECK_BRIDGE_CLIENT_STATES.CONNECTED ||
            state === NECK_BRIDGE_CLIENT_STATES.STALE
          if (socket) {
            if (_activeSocketCount > 0) _activeSocketCount -= 1
          }
          socket = null
          wsConnectionId = null
          targetDispatchEnabled = false
          if (!settled) {
            websocketAccess = "failed"
            failWs(
              classifyWebSocketFailure({
                closeCode: ev?.code,
                wasClean: ev?.wasClean,
              })
            )
            return
          }
          if (state !== NECK_BRIDGE_CLIENT_STATES.ERROR) {
            setState(NECK_BRIDGE_CLIENT_STATES.DISCONNECTED)
          } else if (wasSession) {
            emit()
          }
        }
      })
    } finally {
      connectInFlight = false
    }
  }

  function disconnect() {
    clearTimers()
    pendingTarget = null
    targetDispatchEnabled = false
    connectInFlight = false
    for (const [, waiter] of pendingCommandResults) {
      if (waiter.timer != null) clearTimeout(waiter.timer)
      waiter.resolve({
        type: `${waiter.type}Result`,
        ok: false,
        reason: "DISCONNECTED",
        id: null,
        raw: null,
      })
    }
    pendingCommandResults.clear()
    closeSocketQuietly()
    unbindPageHide()
    sessionId = ""
    lastError = null
    lastErrorObj = null
    healthAccess = "idle"
    capabilitiesAccess = "idle"
    websocketAccess = "idle"
    lastNeckState = null
    lastNeckStateUiEmitAt = -Infinity
    lastHardwareCommandResult = null
    setState(NECK_BRIDGE_CLIENT_STATES.DISCONNECTED)
  }

  function dispose() {
    disposed = true
    disconnect()
    listeners = new Set()
  }

  function recordDispatchDecision(decision, reason, source, { forceEmit = false } = {}) {
    lastTargetDispatchDecision = decision
    lastTargetDispatchReason = reason
    lastTargetDispatchSource = source
    const t = nowMs()
    if (
      forceEmit ||
      t - lastTargetDispatchEmitAt >= neckStateUiEmitMinMs
    ) {
      lastTargetDispatchEmitAt = t
      emit()
    }
  }

  /**
   * 发送 semantic neck.target。
   * @param {{ pose?: object, timelineTimeMs?: number, fromScrub?: boolean, source?: 'editor'|'timeline'|'control' }} [opts]
   * - editor / fromScrub：需要 Hardware Preview ON
   * - timeline / control：不检查 Hardware Preview
   * - 不检查 productionReady / hardwareExecutionEnabled（Luvia 权威）
   * - 最小前置：SESSION_ACTIVE、Hardware Connected、Enabled
   */
  function offerTarget({ pose, timelineTimeMs, fromScrub = false, source = null } = {}) {
    const src =
      source === "editor" || source === "timeline" || source === "control"
        ? source
        : fromScrub
          ? "editor"
          : "timeline"
    const requirePreview = src === "editor"

    if (state === NECK_BRIDGE_CLIENT_STATES.STALE || !targetDispatchEnabled) {
      if (state === NECK_BRIDGE_CLIENT_STATES.STALE) {
        recordDispatchDecision(
          NECK_TARGET_DISPATCH_DECISIONS.SKIPPED_STALE,
          "session STALE — Resume required",
          src,
          { forceEmit: true }
        )
        return false
      }
      recordDispatchDecision(
        NECK_TARGET_DISPATCH_DECISIONS.SKIPPED_SESSION_INACTIVE,
        `targetDispatchEnabled=false state=${state}`,
        src,
        { forceEmit: true }
      )
      return false
    }

    if (state !== NECK_BRIDGE_CLIENT_STATES.SESSION_ACTIVE) {
      recordDispatchDecision(
        NECK_TARGET_DISPATCH_DECISIONS.SKIPPED_SESSION_INACTIVE,
        `state=${state}`,
        src,
        { forceEmit: true }
      )
      return false
    }

    if (!isHardwareConnected()) {
      recordDispatchDecision(
        NECK_TARGET_DISPATCH_DECISIONS.SKIPPED_HARDWARE_DISCONNECTED,
        "neck.state.connected !== true",
        src,
        { forceEmit: true }
      )
      return false
    }

    if (!(lastNeckState && lastNeckState.enabled === true)) {
      recordDispatchDecision(
        NECK_TARGET_DISPATCH_DECISIONS.SKIPPED_NOT_ENABLED,
        "neck.state.enabled !== true",
        src,
        { forceEmit: true }
      )
      return false
    }

    if (requirePreview && !hardwarePreview) {
      recordDispatchDecision(
        NECK_TARGET_DISPATCH_DECISIONS.SKIPPED_HARDWARE_PREVIEW_OFF,
        "Hardware Preview OFF (editor/scrub only)",
        src,
        { forceEmit: true }
      )
      return false
    }

    // 明确不 gate：productionReady / hardwareExecutionEnabled / runtimeSafetyMode
    sequence += 1
    streamStats.targetPrepared += 1
    streamStats.targetPreparedCount += 1
    lastTargetPose = normalizeNeckPose(pose)
    lastTimelineTimeMs = Math.max(0, Math.round(Number(timelineTimeMs) || 0))
    // R1 shadow: plan only — never send browser-core output to hardware
    if (browserShadow.isEnabled()) {
      const shadowSnap = browserShadow.observePose(lastTargetPose)
      if (shadowSnap && !shadowSnap.throttled) {
        lastShadowPlan = shadowSnap
      } else if (shadowSnap) {
        lastShadowPlan = shadowSnap
      }
    }
    pendingTarget = createNeckTargetMessage({
      sessionId,
      sequence,
      timelineTimeMs: lastTimelineTimeMs,
      pose: lastTargetPose,
    })
    const beforeSent = streamStats.targetSentCount
    flushTarget()
    const sentNow = streamStats.targetSentCount > beforeSent
    if (!sentNow && pendingTarget) {
      // 保留在 pending（backpressure）；仍算已受理准备
      recordDispatchDecision(
        NECK_TARGET_DISPATCH_DECISIONS.SENT,
        "prepared (pending backpressure)",
        src
      )
      return true
    }
    if (!sentNow && !pendingTarget) {
      // flush 尝试过但 send 失败
      const buffered = readBufferedAmount()
      if (buffered > bufferedAmountSoftLimit) {
        recordDispatchDecision(
          NECK_TARGET_DISPATCH_DECISIONS.SENT,
          "prepared (backpressure hold)",
          src
        )
        return true
      }
      recordDispatchDecision(
        NECK_TARGET_DISPATCH_DECISIONS.FAILED_SOCKET,
        "socket send failed",
        src,
        { forceEmit: true }
      )
      return false
    }
    recordDispatchDecision(NECK_TARGET_DISPATCH_DECISIONS.SENT, "neck.target sent", src)
    return true
  }

  function setHardwarePreview(on) {
    hardwarePreview = Boolean(on)
    emit()
  }

  function sendSessionCommand(type, extra = {}) {
    if (!sessionId) return false
    return sendControl({ type, sessionId, sequence, ...extra })
  }

  /**
   * Bridge → Physical Hardware（COM/CANable）。
   * 正式 schema：{ type:"neck.connect", channel, virtual, id?, sessionId, sequence }
   * 成功不自动 enable。
   */
  async function connectHardware({ channel = "", virtual = false } = {}) {
    if (!isSessionLive()) {
      const err = createNeckBridgeError(NECK_BRIDGE_ERROR_CODES.SESSION_INACTIVE)
      lastErrorObj = err
      lastError = err.message
      emit()
      return { ok: false, reason: err.code }
    }
    const ch = String(channel || "").trim()
    const useVirtual = Boolean(virtual)
    if (!useVirtual && !ch) {
      const err = createNeckBridgeError(NECK_BRIDGE_ERROR_CODES.CHANNEL_REQUIRED)
      lastErrorObj = err
      lastError = err.message
      emit()
      return { ok: false, reason: err.code }
    }
    const id = createCommandId("hwc")
    const msg = createNeckConnectMessage({
      sessionId,
      sequence,
      channel: ch,
      virtual: useVirtual,
      id,
    })
    // 走统一 await（sendSessionCommand 字段一致）
    const result = await awaitCommandResult("neck.connect", {
      channel: msg.channel,
      virtual: msg.virtual,
      id,
    })
    if (!result.ok) {
      lastErrorObj = createNeckBridgeError(NECK_BRIDGE_ERROR_CODES.HARDWARE_CONNECT_FAILED, {
        detail: result.reason || "",
      })
      lastError = lastErrorObj.message
      emit()
    } else {
      // 清掉硬件相关错误；connected 以后续 neck.state 为准
      if (lastErrorObj?.code === NECK_BRIDGE_ERROR_CODES.HARDWARE_NOT_CONNECTED) {
        lastErrorObj = null
        lastError = null
      }
      emit()
    }
    return result
  }

  async function disconnectHardware() {
    if (!isSessionLive()) {
      const err = createNeckBridgeError(NECK_BRIDGE_ERROR_CODES.SESSION_INACTIVE)
      lastErrorObj = err
      lastError = err.message
      emit()
      return { ok: false, reason: err.code }
    }
    const id = createCommandId("hwd")
    return awaitCommandResult("neck.disconnect", { id })
  }

  /** GET /v1/ports — Bridge 语义端口列表；失败时 UI 可回退手动输入 */
  async function listHardwarePorts() {
    const res = await probeHttp("/v1/ports")
    if (!res.ok) {
      return {
        ok: false,
        ports: [],
        reason: res.networkError ? "PORTS_UNAVAILABLE" : `HTTP_${res.status}`,
      }
    }
    const ports = Array.isArray(res.body?.ports)
      ? res.body.ports.map((p) => String(p))
      : []
    lastHardwarePorts = ports
    emit()
    return { ok: res.body?.ok !== false, ports, reason: res.body?.reason || null }
  }

  function enable() {
    if (!sessionId) return false
    if (!isHardwareConnected()) {
      lastErrorObj = createNeckBridgeError(NECK_BRIDGE_ERROR_CODES.HARDWARE_NOT_CONNECTED)
      lastError = lastErrorObj.message
      emit()
      return false
    }
    return sendSessionCommand("neck.enable")
  }

  function disable() {
    return sendSessionCommand("neck.disable")
  }

  function estop() {
    return sendSessionCommand("neck.estop")
  }

  function hold() {
    return sendSessionCommand("neck.hold")
  }

  function neutral() {
    const pose = normalizeNeckPose({})
    lastTargetPose = pose
    if (targetDispatchEnabled && state === NECK_BRIDGE_CLIENT_STATES.SESSION_ACTIVE) {
      offerTarget({ pose, timelineTimeMs: lastTimelineTimeMs, source: "control" })
    }
    return sendSessionCommand("neck.neutral")
  }

  /** 显式 Resume：session.resume → 恢复 target 流；不自动调用 */
  function resume() {
    if (!sessionId) return false
    if (state !== NECK_BRIDGE_CLIENT_STATES.STALE && state !== NECK_BRIDGE_CLIENT_STATES.SESSION_ACTIVE) {
      return false
    }
    return sendControl(createSessionResume({ sessionId, sequence }))
  }

  function getStreamStats() {
    const samples = bufferedAmountSamples.slice()
    const sorted = [...samples].sort((a, b) => a - b)
    const pct = (p) => {
      if (!sorted.length) return 0
      const i = Math.min(sorted.length - 1, Math.floor((p / 100) * (sorted.length - 1)))
      return sorted[i]
    }
    return {
      ...streamStats,
      lastTargetSequence: sequence,
      lastTargetTimelineTimeMs: lastTimelineTimeMs,
      lastTargetPose: { ...lastTargetPose },
      bufferedAmount: {
        mean: samples.length ? samples.reduce((a, b) => a + b, 0) / samples.length : 0,
        p95: pct(95),
        max: sorted.length ? sorted[sorted.length - 1] : 0,
      },
    }
  }

  function getSessionDiagnostics() {
    return {
      neckClientInstanceId,
      wsConnectionId,
      connectAttemptCount,
      activeSocketCount: _activeSocketCount,
      sessionId,
      lastServerHelloAccepted,
      lastServerHelloReason,
      connectInFlight,
      state,
      uiState,
    }
  }

  function getTargetDiagnostics() {
    return {
      targetPreparedCount: streamStats.targetPreparedCount,
      targetSendAttemptCount: streamStats.targetSendAttemptCount,
      targetSentCount: streamStats.targetSentCount,
      lastTargetSequence: sequence,
      lastTargetTimelineTimeMs: lastTimelineTimeMs,
      lastTargetPose: { ...lastTargetPose },
      lastTargetSentAt,
      lastTargetDispatchDecision,
      lastTargetDispatchReason,
      lastTargetDispatchSource,
    }
  }

  function getSnapshot() {
    const t = nowMs()
    return {
      state,
      uiState,
      protocolVersion: FACEDEV_NECK_PROTOCOL_VERSION,
      httpBase,
      wsUrl,
      sessionId,
      sequence,
      lastAcceptedSequence,
      capabilities,
      productionReady: Boolean(capabilities?.productionReady),
      runtimeSafetyMode: capabilities?.runtimeSafetyMode || null,
      actualPoseAvailable: Boolean(capabilities?.actualPoseAvailable),
      lastError,
      lastErrorObj,
      hardwarePreview,
      lastTargetPose: { ...lastTargetPose },
      lastTimelineTimeMs,
      actualPose: null,
      actualPoseUnavailable: !capabilities?.actualPoseAvailable,
      targetDispatchEnabled,
      access: {
        health: healthAccess,
        capabilities: capabilitiesAccess,
        websocket: websocketAccess,
      },
      permission: { ...permissionDiag },
      visibilityState: visibilityState(),
      lastHeartbeatSentAt,
      lastHeartbeatSendAgeMs:
        lastHeartbeatSentAt == null ? null : Math.max(0, t - lastHeartbeatSentAt),
      lastTargetSentAt,
      lastTargetSendAgeMs: lastTargetSentAt == null ? null : Math.max(0, t - lastTargetSentAt),
      bufferedAmount: readBufferedAmount(),
      streamStats: getStreamStats(),
      sessionDiagnostics: getSessionDiagnostics(),
      targetDiagnostics: getTargetDiagnostics(),
      neckClientInstanceId,
      wsConnectionId,
      connectAttemptCount,
      activeSocketCount: _activeSocketCount,
      lastServerHelloAccepted,
      lastServerHelloReason,
      /** Luvia neck.state 原始 state（Physical Debug 只读） */
      neckState: lastNeckState,
      /** A: Browser↔Bridge；B: Bridge↔Hardware */
      runtimeConnected: isSessionLive(),
      hardwareConnected: isHardwareConnected(),
      hardwareChannel:
        lastNeckState?.transport?.channel != null
          ? String(lastNeckState.transport.channel)
          : "",
      hardwarePorts: lastHardwarePorts.slice(),
      lastHardwareCommandResult,
      hardwareExecutionEnabled: Boolean(lastNeckState?.hardwareExecutionEnabled),
      /**
       * hardwareExecutionEnabled 语义说明（只读提示）：
       * CAD/production readiness diagnostic，不是 EXTERNAL_DIRECT commissioning TX 硬门。
       */
      hardwareExecutionNote:
        "CAD/production readiness diagnostic — not EXTERNAL_DIRECT commissioning TX gate",
      lastTargetDispatchDecision,
      lastTargetDispatchReason,
      lastTargetDispatchSource,
      /** R1 Browser Core shadow (null when disabled) */
      browserCoreShadowEnabled: browserShadow.isEnabled(),
      /** R2 protocol canFrame/slcan diagnostics (default OFF) */
      browserProtocolShadowEnabled: browserShadow.isProtocolShadowEnabled(),
      lastShadowPlan: lastShadowPlan || browserShadow.getLastShadowPlan(),
    }
  }

  function subscribe(fn) {
    listeners.add(fn)
    return () => listeners.delete(fn)
  }

  return {
    connect,
    disconnect,
    dispose,
    offerTarget,
    setHardwarePreview,
    connectHardware,
    disconnectHardware,
    listHardwarePorts,
    enable,
    disable,
    estop,
    hold,
    neutral,
    resume,
    getSnapshot,
    getStreamStats,
    getSessionDiagnostics,
    getTargetDiagnostics,
    subscribe,
    get instanceId() {
      return neckClientInstanceId
    },
    _forceSequence(n) {
      sequence = Math.max(0, Number(n) || 0)
    },
    _forceStale() {
      targetDispatchEnabled = false
      streamStats.staleCount += 1
      setState(NECK_BRIDGE_CLIENT_STATES.STALE)
      uiState = NECK_BRIDGE_UI_STATES.STALE
    },
    _setTargetDispatchEnabled(on) {
      targetDispatchEnabled = Boolean(on)
    },
    _injectNeckState(stateObj) {
      lastNeckState = stateObj && typeof stateObj === "object" ? stateObj : null
      emit()
    },
    _injectSocket(mockSocket) {
      if (socket && socket !== mockSocket) {
        closeSocketQuietly()
      }
      socket = mockSocket
      if (mockSocket) {
        wsConnectionId = createWsConnectionId()
        _activeSocketCount += 1
      }
    },
  }
}
