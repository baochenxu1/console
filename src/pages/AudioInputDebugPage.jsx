/**
 * Voice Interaction Console — layout-stable production page.
 * UI / presentation only; Audio Runtime / Provider / Backend 行为不变。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { VoiceTooltip, VoiceTooltipProvider } from "../components/VoiceTooltip.jsx"
import {
  formatDeviceLabel,
  listAudioInputDevices,
  listAudioOutputDevices,
  audioOutputSelectionSupported,
  listPhysicalAudioInputs,
  normalizeAudioInputDevice,
  requestMicrophonePermission,
  shortAudioInputLabel,
  shortDeviceId,
  stopMediaStream,
  subscribeDeviceChange,
} from "../sdk/audio/audioDevices.js"
import {
  AUDIO_CAPTURE_CONSTRAINTS,
  AUDIO_CHANNEL_MODE_LABELS,
  AUDIO_CHANNEL_MODES,
  formatSettingValue,
  requestedChannelCountForMode,
} from "../sdk/audio/audioCapture.js"
import { AUDIO_ERROR_CODES, classifyAudioError } from "../sdk/audio/audioErrors.js"
import { loadPreferredAudioInput, savePreferredAudioInput } from "../sdk/audio/audioPreferences.js"
import {
  buildVoiceConnectPlan,
  DEVICE_RESOLVE_CODES,
  SELECTION_SOURCES,
  summarizeDeviceResolution,
} from "../sdk/audio/resolvePreferredAudioInput.js"
import { VOICE_AUDIO_FORMAT } from "../sdk/audio/audioFrame.js"
import { listVoiceProviders } from "../sdk/voice/voiceProviderRegistry.js"
import { createVoiceSession, VOICE_SESSION_STATES } from "../sdk/voice/voiceSession.js"
import {
  COMPANION_DEFAULT_PORT,
  COMPANION_STATUS,
} from "../sdk/voice/companion/companionConstants.js"
import {
  buildXinqiCompanionTransport,
  companionStatusTone,
  discoverLocalCompanion,
  pairWithCompanion,
  resetCompanionPairing,
} from "../sdk/voice/companion/companionDiscovery.js"
import {
  clearCompanionPairingToken,
  loadCompanionPreferences,
  saveCompanionAdvancedOpen,
  saveCompanionBaseUrl,
  saveCompanionPort,
} from "../sdk/voice/companion/companionPreferences.js"
import { isLoopbackHostname } from "../sdk/voice/companion/companionUrl.js"
import {
  VOICE_HELP,
  authTooltip,
  formatAuthLabel,
  formatStreamingLabel,
  fullDeviceLabel,
  primaryActionLabel as resolvePrimaryActionLabel,
  providerDisplayInfo,
  runtimeFrameMeta,
  sessionDisplayInfo,
  shortDeviceDisplayName,
  shortErrorSummary,
  transportDisplayInfo,
  transportPolicyLabel,
} from "./voiceConsolePresentation.js"
import "../styles/audio-input-debug.css"

const PERMISSION = Object.freeze({
  UNKNOWN: "UNKNOWN",
  GRANTED: "GRANTED",
  DENIED: "DENIED",
})

function isRetryableStartError(code) {
  return code === AUDIO_ERROR_CODES.NotReadableError || code === "AbortError"
}

function voiceConnectLog(message, detail) {
  if (typeof console === "undefined" || typeof console.info !== "function") return
  if (detail != null) console.info(`[VoiceConnect] ${message}`, detail)
  else console.info(`[VoiceConnect] ${message}`)
}

const ACTIVITY_BAR_COUNT = 20

function formatDuration(ms) {
  const total = Math.max(0, Math.floor(Number(ms) / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
}

function levelPercent(rms) {
  const value = Math.max(0, Math.min(1, Number(rms) || 0))
  return Math.round(Math.min(100, value * 280))
}

function formatMetric(value, digits = 4) {
  if (value == null || !Number.isFinite(Number(value))) return "N/A"
  return Number(value).toFixed(digits)
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(2)} MB`
}

function formatWallClock(ms) {
  if (ms == null || !Number.isFinite(Number(ms))) return "--:--:--"
  try {
    return new Date(Number(ms)).toLocaleTimeString()
  } catch {
    return "--:--:--"
  }
}

function formatCount(value) {
  const n = Number(value) || 0
  return n.toLocaleString("en-US")
}

function toneForStatus(value) {
  const v = String(value || "").toUpperCase()
  if (["ERROR", "DENIED", "FAILED"].some((key) => v.includes(key))) return "danger"
  if (["CONNECTING", "STARTING", "STOPPING", "REQUESTING", "DISCONNECTING"].some((key) => v.includes(key))) {
    return "warn"
  }
  if (
    ["RUNNING", "CONNECTED", "ACTIVE", "GRANTED", "TEMP_TOKEN", "READY", "LIVE", "LISTENING"].some((key) =>
      v.includes(key),
    )
  ) {
    return "ok"
  }
  return "neutral"
}

/** Deterministic Input Activity bars from RMS/Peak — not a fake waveform history. */
function activityBarScales(rms, peak, active) {
  const level = active
    ? Math.max(0, Math.min(1, Number(rms) * 2.6 + Number(peak) * 0.35))
    : 0
  return Array.from({ length: ACTIVITY_BAR_COUNT }, (_, i) => {
    const t = i / (ACTIVITY_BAR_COUNT - 1)
    const envelope = 0.32 + 0.68 * Math.sin(t * Math.PI)
    const texture = 0.78 + 0.22 * Math.abs(Math.sin(i * 2.15 + level * 4.5))
    const profile = envelope * texture
    if (!active) {
      return Math.max(0.1, Math.min(0.2, profile * 0.16))
    }
    return Math.max(0.14, Math.min(1, profile * (0.12 + level * 0.88)))
  })
}

function StatusBadge({ label, value, tone, tip }) {
  const resolved = tone || toneForStatus(value)
  const badge = (
    <span
      className={`voice-status-badge voice-status-badge--${resolved}`}
      tabIndex={tip ? 0 : undefined}
      aria-label={`${label}: ${value}`}
    >
      <span className="voice-status-badge__dot" aria-hidden="true" />
      <span className="voice-status-badge__text">{value}</span>
    </span>
  )
  return tip ? <VoiceTooltip content={tip}>{badge}</VoiceTooltip> : badge
}

function InspectorRow({ label, value, warn = false, tip }) {
  const row = (
    <div className={`voice-insp-row${warn ? " voice-insp-row--warn" : ""}`} tabIndex={tip ? 0 : undefined}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  )
  return tip ? <VoiceTooltip content={tip}>{row}</VoiceTooltip> : row
}

export default function AudioInputDebugPage() {
  const providers = useMemo(() => listVoiceProviders(), [])
  const [permission, setPermission] = useState(PERMISSION.UNKNOWN)
  const [devices, setDevices] = useState([])
  const [selectedDeviceId, setSelectedDeviceId] = useState("")
  const [channelMode, setChannelMode] = useState(AUDIO_CHANNEL_MODES.mono)
  const [providerId, setProviderId] = useState(providers[0]?.id || "mock")
  const [sessionState, setSessionState] = useState(VOICE_SESSION_STATES.IDLE)
  const [errorText, setErrorText] = useState("")
  const [errorCode, setErrorCode] = useState("")
  const [showErrorDetail, setShowErrorDetail] = useState(false)
  const [rms, setRms] = useState(0)
  const [peak, setPeak] = useState(0)
  const [rms0, setRms0] = useState(0)
  const [rms1, setRms1] = useState(null)
  const [correlationLabel, setCorrelationLabel] = useState("N/A")
  const [differenceLabel, setDifferenceLabel] = useState("N/A")
  const [diagnosticHint, setDiagnosticHint] = useState("")
  const [stats, setStats] = useState(null)
  const [busy, setBusy] = useState(false)
  const [autoScroll, setAutoScroll] = useState(true)
  const [deviceResolution, setDeviceResolution] = useState(null)
  const [outputDevices, setOutputDevices] = useState([])
  const [outputDeviceId, setOutputDeviceId] = useState("")
  const outputDeviceIdRef = useRef("")
  const companionPrefsSeed = loadCompanionPreferences()
  const [companionDiscovery, setCompanionDiscovery] = useState(null)
  const [companionBusy, setCompanionBusy] = useState(false)
  const [companionPairCode, setCompanionPairCode] = useState("")
  const [companionAdvancedOpen, setCompanionAdvancedOpen] = useState(companionPrefsSeed.advancedOpen)
  const [companionPortDraft, setCompanionPortDraft] = useState(String(companionPrefsSeed.port || COMPANION_DEFAULT_PORT))
  const [companionBaseDraft, setCompanionBaseDraft] = useState(companionPrefsSeed.baseUrl || "")
  const [companionMessage, setCompanionMessage] = useState("")
  const [companionRepairOpen, setCompanionRepairOpen] = useState(false)
  const companionDiscoveryRef = useRef(null)

  const sessionRef = useRef(null)
  const selectedDeviceIdRef = useRef(selectedDeviceId)
  const selectionSourceRef = useRef(SELECTION_SOURCES.None)
  const historyRef = useRef(null)
  selectedDeviceIdRef.current = selectedDeviceId
  outputDeviceIdRef.current = outputDeviceId

  if (sessionRef.current == null) {
    sessionRef.current = createVoiceSession({
      onStateChange: (next) => setSessionState(next),
      onStats: (next) => setStats(next),
      onLevel: (level) => {
        if (!level) return
        setRms(level.rms)
        setPeak(level.peak)
        setRms0(level.rms0)
        setRms1(level.rms1)
        setCorrelationLabel(level.correlationLabel)
        setDifferenceLabel(level.differenceLabel)
        setDiagnosticHint(level.hint || "")
      },
    })
  }

  const preferredAudio = loadPreferredAudioInput()
  const physicalDevices = useMemo(() => listPhysicalAudioInputs(devices), [devices])
  const selectedDevice = useMemo(
    () => physicalDevices.find((item) => item.deviceId === selectedDeviceId)
      || devices.find((item) => item.deviceId === selectedDeviceId)
      || null,
    [devices, physicalDevices, selectedDeviceId],
  )
  const selectedProvider = useMemo(
    () => providers.find((item) => item.id === providerId) || null,
    [providers, providerId],
  )
  const running = sessionState === VOICE_SESSION_STATES.RUNNING
  const starting = sessionState === VOICE_SESSION_STATES.STARTING
  const stopping = sessionState === VOICE_SESSION_STATES.STOPPING
  const errored = sessionState === VOICE_SESSION_STATES.ERROR
  const locked = running || starting || stopping
  const plannedRequestedChannels = requestedChannelCountForMode(channelMode)
  const percent = levelPercent(rms)
  const trackSettings = stats?.trackSettings
  const finalHistory = stats?.finalHistory || []
  const partialText = stats?.partialText || ""
  const conversation = stats?.conversation || []
  const assistantDraft = stats?.assistantDraft || ""
  const dropped = Number(stats?.droppedFrames) || 0
  const invalid = Number(stats?.invalidFrames) || 0
  const micShort = shortDeviceDisplayName(selectedDevice, {
    preferredDeviceId: preferredAudio?.deviceId || "",
  })
  const micFull = fullDeviceLabel(selectedDevice)
  const listening = running && percent > 2
  const sessionInfo = sessionDisplayInfo(sessionState, {
    listening,
    errorSummary: errorText,
  })
  const providerInfo = providerDisplayInfo(providerId)
  const transportInfo = transportDisplayInfo(providerId, stats)
  const frameMeta = runtimeFrameMeta()
  const primaryActionLabel = resolvePrimaryActionLabel(sessionState)
  const voiceStateLabel = listening ? "Listening" : running ? "Quiet" : starting ? "Connecting" : "Idle"
  const showTranscriptSurface = running || starting || stopping || partialText || finalHistory.length > 0 || errored
  const showIdle = !showTranscriptSurface
  const activityScales = useMemo(
    () => activityBarScales(rms, peak, running),
    [rms, peak, running],
  )
  const inputSrLabel = stats?.inputSampleRate == null
    ? "48,000 Hz"
    : `${formatCount(stats.inputSampleRate)} Hz`
  const statusMessage = stats?.playbackState === "Error" && stats?.playbackError
    ? shortErrorSummary(stats.playbackError, 64)
    : starting
      ? `正在连接 ${selectedProvider?.label || providerId}`
      : errored && errorText
        ? shortErrorSummary(errorText, 64)
        : ""
  const statusMessageVisible = Boolean(statusMessage)

  const clearError = () => {
    setErrorText("")
    setErrorCode("")
    setShowErrorDetail(false)
  }

  const showError = (code, message) => {
    setErrorCode(code || AUDIO_ERROR_CODES.Unknown)
    setErrorText(message || "未知错误")
  }

  const refreshDevices = useCallback(async ({ keepSelection = true } = {}) => {
    const listed = await listAudioInputDevices()
    const outputs = await listAudioOutputDevices()
    if (outputs.ok) setOutputDevices(outputs.devices)
    if (!listed.ok) {
      showError(AUDIO_ERROR_CODES.Unknown, listed.error || "枚举设备失败")
      return []
    }
    const freshDevices = listed.devices
    setDevices(freshDevices)
    setDeviceResolution(summarizeDeviceResolution(freshDevices))

    const physicals = listPhysicalAudioInputs(freshDevices)
    const prev = selectedDeviceIdRef.current
    const prevStillThere = Boolean(prev && physicals.some((item) => item.deviceId === prev))

    if (keepSelection && prevStillThere) {
      // RUNNING / 已有 physical 选择：不因 list reorder 改写 selection
      return freshDevices
    }

    const preferred = loadPreferredAudioInput()
    const plan = buildVoiceConnectPlan({
      freshDevices,
      selectedDeviceId: "",
      selectionSource: SELECTION_SOURCES.None,
      preferred,
    })
    if (plan.resolved.ok) {
      setSelectedDeviceId(plan.deviceId)
      selectedDeviceIdRef.current = plan.deviceId
      selectionSourceRef.current = plan.selectionSource || SELECTION_SOURCES.Auto
    } else {
      // 未授权 / 无 physical：保持空选择，禁止写入 default alias
      setSelectedDeviceId("")
      selectedDeviceIdRef.current = ""
      selectionSourceRef.current = SELECTION_SOURCES.None
    }
    return freshDevices
  }, [])

  const handleRequestPermission = async () => {
    clearError()
    setBusy(true)
    try {
      const result = await requestMicrophonePermission()
      if (!result.ok) {
        const classified = classifyAudioError(result.error)
        console.error("[VoiceDebug] permission failed", result.error)
        setPermission(PERMISSION.DENIED)
        showError(classified.code, classified.message)
        return
      }
      stopMediaStream(result.stream)
      setPermission(PERMISSION.GRANTED)
      await refreshDevices({ keepSelection: false })
    } finally {
      setBusy(false)
    }
  }

  const refreshCompanionDiscovery = useCallback(async () => {
    if (providerId !== "xinqi") return null
    setCompanionBusy(true)
    setCompanionMessage("")
    try {
      const result = await discoverLocalCompanion()
      setCompanionDiscovery(result)
      companionDiscoveryRef.current = result
      return result
    } finally {
      setCompanionBusy(false)
    }
  }, [providerId])

  useEffect(() => {
    if (providerId !== "xinqi") {
      setCompanionDiscovery(null)
      companionDiscoveryRef.current = null
      return undefined
    }
    let cancelled = false
    ;(async () => {
      const result = await discoverLocalCompanion()
      if (cancelled) return
      setCompanionDiscovery(result)
      companionDiscoveryRef.current = result
    })()
    const timer = setInterval(() => {
      void refreshCompanionDiscovery()
    }, 12000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [providerId, refreshCompanionDiscovery])

  const handleCompanionPair = async () => {
    const baseUrl = companionDiscovery?.baseUrl || loadCompanionPreferences().baseUrl
    setCompanionBusy(true)
    setCompanionMessage("")
    try {
      // 用户手势内再探测一次，便于弹出 Chrome/Edge 本机网络授权
      const probed = await discoverLocalCompanion()
      setCompanionDiscovery(probed)
      companionDiscoveryRef.current = probed
      if (
        probed.status === COMPANION_STATUS.BROWSER_PERMISSION_DENIED
        || probed.status === COMPANION_STATUS.BROWSER_PERMISSION_PROMPT
      ) {
        setCompanionMessage(
          "请先在浏览器弹窗中允许「访问本地网络 / 环回地址」，然后再点配对。",
        )
      }
      if (
        probed.status === COMPANION_STATUS.COMPANION_OFFLINE
        || probed.status === COMPANION_STATUS.BROWSER_PERMISSION_PROMPT
      ) {
        // 仍尝试配对：若仅是状态误判且 Companion 已起，pair 可能成功
      }
      const result = await pairWithCompanion({ baseUrl, code: companionPairCode })
      if (!result.ok) {
        setCompanionMessage(result.message || "配对失败")
        return
      }
      setCompanionPairCode("")
      setCompanionRepairOpen(false)
      setCompanionMessage("配对已完成，正在刷新本机服务状态…")
      await refreshCompanionDiscovery()
    } finally {
      setCompanionBusy(false)
    }
  }

  const handleCompanionRepair = async () => {
    // 先打开配对区，避免 discover 落在 LNA prompt 时输入框消失
    setCompanionRepairOpen(true)
    setCompanionBusy(true)
    setCompanionMessage("")
    setCompanionPairCode("")
    try {
      clearCompanionPairingToken()
      const result = await resetCompanionPairing()
      setCompanionDiscovery(result)
      companionDiscoveryRef.current = result
      if (
        result.status === COMPANION_STATUS.BROWSER_PERMISSION_PROMPT
        || result.status === COMPANION_STATUS.BROWSER_PERMISSION_DENIED
      ) {
        setCompanionMessage(
          "已清除本地授权。若浏览器弹出本机网络访问，请点「允许」；然后输入 PAIRING_CODE.txt 中的配对码。",
        )
      } else if (result.status === COMPANION_STATUS.COMPANION_OFFLINE) {
        setCompanionMessage(
          "已清除本地授权，但未探测到 Companion。请确认已运行 start-with-facedev.cmd，再输入配对码或点「重新发现」。",
        )
      } else {
        setCompanionMessage(
          "已清除浏览器本地授权。请查看 Companion 窗口或 %USERPROFILE%\\.facedev\\companion\\PAIRING_CODE.txt，输入配对码。",
        )
      }
    } finally {
      setCompanionBusy(false)
    }
  }

  const handleCompanionAllowLocal = async () => {
    setCompanionBusy(true)
    setCompanionMessage("正在请求本机网络访问…")
    try {
      // 用户点击手势内发起 loopback 请求，触发 Chromium LNA 提示
      const result = await discoverLocalCompanion()
      setCompanionDiscovery(result)
      companionDiscoveryRef.current = result
      if (result.status === COMPANION_STATUS.PAIRING_REQUIRED) {
        setCompanionRepairOpen(true)
        setCompanionMessage("本机访问已可用。请输入配对码完成配对。")
      } else if (result.status === COMPANION_STATUS.PAIRING_COMPLETE) {
        setCompanionRepairOpen(false)
        setCompanionMessage("本机访问正常，配对仍然有效。")
      } else if (
        result.status === COMPANION_STATUS.BROWSER_PERMISSION_PROMPT
        || result.status === COMPANION_STATUS.BROWSER_PERMISSION_DENIED
      ) {
        setCompanionMessage(
          "仍未获得本机网络权限。请检查地址栏右侧权限，或在浏览器设置中允许此站点访问本地网络。",
        )
      } else {
        setCompanionMessage(result.label || "已重新探测")
      }
    } finally {
      setCompanionBusy(false)
    }
  }

  const handleCompanionAdvancedSave = () => {
    const portSaved = saveCompanionPort(companionPortDraft)
    setCompanionPortDraft(String(portSaved.port))
    if (companionBaseDraft.trim()) {
      const baseSaved = saveCompanionBaseUrl(companionBaseDraft.trim())
      if (!baseSaved.ok) {
        setCompanionMessage(baseSaved.message || "地址无效")
        return
      }
      setCompanionBaseDraft(baseSaved.baseUrl)
    } else {
      setCompanionBaseDraft(portSaved.baseUrl)
    }
    setCompanionMessage("已保存本机连接目标（仍须通过 Origin / 配对校验）")
    void refreshCompanionDiscovery()
  }

  const handleConnectAndStart = async () => {
    if (providerId === "xinqi") {
      sessionRef.current.primeOutput({ sinkId: outputDeviceIdRef.current || "" })
    }
    clearError()
    setBusy(true)
    const providerIdSnapshot = providerId
    const channelModeSnapshot = channelMode
    let startAttempts = 0
    let lastDeviceError = "none"
    try {
      let xinqiProviderOptions = null
      if (providerIdSnapshot === "xinqi") {
        const discovery = await refreshCompanionDiscovery()
        const pageHost = typeof location !== "undefined" ? location.hostname : ""
        const onLoopbackPage = isLoopbackHostname(pageHost)
        const transport = buildXinqiCompanionTransport(discovery || loadCompanionPreferences())
        const ready = discovery?.status === COMPANION_STATUS.PAIRING_COMPLETE
        if (ready && transport.ok) {
          xinqiProviderOptions = {
            sessionUrl: transport.sessionUrl,
            realtimeUrl: transport.realtimeUrl,
            sessionHeaders: transport.sessionHeaders,
          }
        } else if (!onLoopbackPage) {
          const label = discovery?.label || "本机 Companion 未就绪"
          if (discovery?.status === COMPANION_STATUS.PAIRING_REQUIRED) {
            clearCompanionPairingToken()
            showError(
              "PAIRING_REQUIRED",
              "需要首次配对或配对已过期。请点击「重新配对」，输入 Companion 当前配对码后再连接。",
            )
          } else {
            showError("COMPANION_NOT_READY", `${label}。云端页必须通过本机 Companion（127.0.0.1）连接 Xinqi。`)
          }
          return
        }
        // 本机 Vite 开发：Companion 未就绪时回退 same-origin Gateway
      }

      const permissionResult = await requestMicrophonePermission()
      if (!permissionResult.ok) {
        const classified = classifyAudioError(permissionResult.error)
        console.error("[VoiceDebug] permission failed", permissionResult.error)
        setPermission(PERMISSION.DENIED)
        showError(classified.code, classified.message)
        return
      }
      stopMediaStream(permissionResult.stream)
      setPermission(PERMISSION.GRANTED)
      voiceConnectLog("permission granted")

      const runAttempt = async (attempt) => {
        const listed = await listAudioInputDevices()
        if (!listed.ok) {
          return {
            ok: false,
            code: AUDIO_ERROR_CODES.Unknown,
            message: listed.error || "枚举设备失败",
          }
        }
        const freshDevices = listed.devices
        setDevices(freshDevices)
        voiceConnectLog(`devices refreshed: ${freshDevices.length}`)

        const preferred = loadPreferredAudioInput()
        const selectedPhysicalId = listPhysicalAudioInputs(freshDevices).some(
          (item) => item.deviceId === selectedDeviceIdRef.current,
        )
          ? selectedDeviceIdRef.current
          : ""

        const connectPlan = buildVoiceConnectPlan({
          freshDevices,
          selectedDeviceId: selectedPhysicalId,
          selectionSource: selectedPhysicalId
            ? (selectionSourceRef.current || SELECTION_SOURCES.User)
            : SELECTION_SOURCES.None,
          preferred,
          providerId: providerIdSnapshot,
          channelMode: channelModeSnapshot,
        })

        setDeviceResolution({
          ...connectPlan.diagnostics,
          preferredLabel: preferred?.label || (preferred?.deviceId ? shortDeviceId(preferred.deviceId) : "none"),
          resolvedLabel: connectPlan.resolved.device?.displayName
            || shortAudioInputLabel(connectPlan.resolved.device)
            || "none",
          selectionSource: connectPlan.selectionSource,
          startAttempts: attempt,
          lastDeviceError,
          requestedDeviceId: connectPlan.deviceId,
          actualDeviceId: null,
        })

        if (!connectPlan.resolved.ok) {
          if (connectPlan.resolved.code === DEVICE_RESOLVE_CODES.NoAudioInput) {
            return { ok: false, code: AUDIO_ERROR_CODES.NoAudioInput, message: connectPlan.resolved.message }
          }
          if (connectPlan.resolved.code === DEVICE_RESOLVE_CODES.MultiplePreferredDevices) {
            return {
              ok: false,
              code: AUDIO_ERROR_CODES.MultiplePreferredDevices,
              message: connectPlan.resolved.message,
            }
          }
          return {
            ok: false,
            code: AUDIO_ERROR_CODES.Unknown,
            message: connectPlan.resolved.message || "无法解析麦克风",
          }
        }

        const resolvedDeviceId = connectPlan.deviceId
        const resolvedDevice = connectPlan.resolved.device
        voiceConnectLog(`resolved physical input: ${shortAudioInputLabel(resolvedDevice)}`)

        // UI only — start 使用 local snapshot，不读 React state
        setSelectedDeviceId(resolvedDeviceId)
        selectedDeviceIdRef.current = resolvedDeviceId
        selectionSourceRef.current = connectPlan.selectionSource

        voiceConnectLog(`start attempt ${attempt}`)
        const startResult = await sessionRef.current.start({
          deviceId: resolvedDeviceId,
          channelMode: connectPlan.channelMode,
          providerId: connectPlan.providerId,
          outputDeviceId: outputDeviceIdRef.current || "",
          providerOptions: xinqiProviderOptions,
        })
        startAttempts = attempt

        if (!startResult.ok) {
          lastDeviceError = startResult.error?.code || startResult.code || "error"
          const failCode = startResult.error?.code || startResult.code || ""
          const failMsg = startResult.error?.message || startResult.message || ""
          if (
            failCode === "PAIRING_REQUIRED"
            || /配对|PAIRING/i.test(String(failCode))
            || /首次配对|配对已过期/i.test(String(failMsg))
          ) {
            clearCompanionPairingToken()
            void refreshCompanionDiscovery()
          }
          return {
            ok: false,
            ...startResult,
            code: failCode,
            message: failMsg,
            connectPlan,
            attempt,
          }
        }

        const actualId = String(startResult.trackSettings?.deviceId || resolvedDeviceId).trim()
        const actualPhysical = listPhysicalAudioInputs(freshDevices).find((item) => item.deviceId === actualId)
          || (actualId === resolvedDeviceId ? resolvedDevice : null)
          || normalizeAudioInputDevice({
            deviceId: actualId || resolvedDeviceId,
            label: resolvedDevice?.label || "",
            groupId: resolvedDevice?.groupId || "",
          })

        const uiDeviceId = actualPhysical?.isPhysical ? actualPhysical.deviceId : resolvedDeviceId
        setSelectedDeviceId(uiDeviceId)
        selectedDeviceIdRef.current = uiDeviceId

        setDeviceResolution({
          ...connectPlan.diagnostics,
          preferredLabel: preferred?.label || (preferred?.deviceId ? shortDeviceId(preferred.deviceId) : "none"),
          resolvedLabel: shortAudioInputLabel(resolvedDevice),
          selectionSource: connectPlan.selectionSource,
          startAttempts: attempt,
          lastDeviceError: "none",
          requestedDeviceId: resolvedDeviceId,
          actualDeviceId: actualId || resolvedDeviceId,
        })

        savePreferredAudioInput({
          deviceId: uiDeviceId,
          label: shortAudioInputLabel(actualPhysical || resolvedDevice) || resolvedDevice?.label || "",
          groupId: actualPhysical?.groupId || resolvedDevice?.groupId || "",
        })

        voiceConnectLog("running")
        return { ok: true, connectPlan, attempt, actualId: actualId || resolvedDeviceId }
      }

      let result = await runAttempt(1)
      if (!result.ok && isRetryableStartError(result.code)) {
        voiceConnectLog("retry after transient open failure", result.code)
        await sessionRef.current.stop({ reason: "retry_cleanup" }).catch(() => {})
        result = await runAttempt(2)
      }

      if (!result.ok) {
        if (isRetryableStartError(result.code)) {
          showError(
            result.code,
            "无法打开 ReSpeaker Lite，请检查设备是否被其他程序占用。",
          )
        } else {
          showError(result.code, result.message)
        }
        setDeviceResolution((prev) => ({
          ...(prev || {}),
          startAttempts: startAttempts || result.attempt || 1,
          lastDeviceError: result.code || lastDeviceError,
        }))
        return
      }

      setAutoScroll(true)
    } finally {
      setBusy(false)
    }
  }

  const handleStopSession = async () => {
    clearError()
    setBusy(true)
    try {
      await sessionRef.current.stop({ reason: "manual" })
      setRms(0)
      setPeak(0)
      setRms0(0)
      setRms1(null)
      setCorrelationLabel("N/A")
      setDifferenceLabel("N/A")
      setDiagnosticHint("")
    } finally {
      setBusy(false)
    }
  }

  const handlePrimaryAction = () => {
    if (running || stopping) {
      void handleStopSession()
      return
    }
    void handleConnectAndStart()
  }

  useEffect(() => {
    void refreshDevices()
    const unsubscribe = subscribeDeviceChange(() => {
      void refreshDevices({ keepSelection: true }).then((nextDevices) => {
        const currentId = selectedDeviceIdRef.current
        const active = sessionRef.current.getState()
        if (
          (active === VOICE_SESSION_STATES.RUNNING || active === VOICE_SESSION_STATES.STARTING)
          && currentId
          && !nextDevices.some((item) => item.deviceId === currentId)
        ) {
          void sessionRef.current.stop({
            reason: AUDIO_ERROR_CODES.DeviceDisconnected,
            asError: true,
          })
          showError(AUDIO_ERROR_CODES.DeviceDisconnected, "当前麦克风已断开。可点击「重新连接」后重试。")
        }
      })
    })
    return () => {
      unsubscribe()
      void sessionRef.current.stop({ reason: "unmount" })
    }
  }, [refreshDevices])

  useEffect(() => {
    if (sessionState === VOICE_SESSION_STATES.ERROR && stats?.lastError) {
      showError(stats.lastError.code, stats.lastError.message)
    }
  }, [sessionState, stats?.lastError])

  useEffect(() => {
    if (!autoScroll || !historyRef.current) return
    historyRef.current.scrollTop = historyRef.current.scrollHeight
  }, [finalHistory.length, partialText, conversation.length, assistantDraft, autoScroll])

  const handleHistoryScroll = () => {
    const el = historyRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 56
    setAutoScroll(nearBottom)
  }

  const jumpToLatest = () => {
    setAutoScroll(true)
    if (historyRef.current) {
      historyRef.current.scrollTop = historyRef.current.scrollHeight
    }
  }

  return (
    <VoiceTooltipProvider delay={400}>
      <section className="audio-input-debug voice-console" data-voice-page="audioInput">
        <header className="voice-console__header" data-voice-region="header">
          <div className="voice-console__header-main">
            <p className="voice-console__eyebrow">Voice Interaction Console</p>
            <div className="voice-console__title-row">
              <h2>语音交互调试</h2>
              <VoiceTooltip content={VOICE_HELP.pageTitle}>
                <button type="button" className="voice-info-trigger" aria-label="页面说明">
                  ⓘ
                </button>
              </VoiceTooltip>
            </div>
          </div>
          <div className="voice-console__env" aria-label="环境摘要">
            <div className="voice-env-cluster">
              <VoiceTooltip content={micFull}>
                <span className="voice-env-item voice-env-item--mic">{micShort}</span>
              </VoiceTooltip>
              <span aria-hidden="true">·</span>
              <VoiceTooltip content={providerInfo.tip}>
                <span className="voice-env-item voice-env-item--provider">{providerInfo.label}</span>
              </VoiceTooltip>
              <span aria-hidden="true">·</span>
              <VoiceTooltip content={VOICE_HELP.pcm16k}>
                <span className="voice-env-item">16 kHz PCM</span>
              </VoiceTooltip>
            </div>
            <VoiceTooltip content={sessionInfo.tip}>
              <div className={`voice-live-pill voice-live-pill--${sessionInfo.tone}`}>
                <span className="voice-live-pill__dot" aria-hidden="true" />
                <span className="voice-live-pill__text">{sessionInfo.live}</span>
              </div>
            </VoiceTooltip>
          </div>
        </header>

        <section className="voice-toolbar" aria-label="会话控制" data-voice-region="toolbar">
          <label className="voice-field voice-toolbar__mic">
            <span className="voice-field__label">Microphone</span>
            <VoiceTooltip content={micFull}>
              <select
                value={selectedDeviceId}
                disabled={busy || locked}
                onChange={(event) => {
                  const next = event.target.value
                  setSelectedDeviceId(next)
                  selectedDeviceIdRef.current = next
                  selectionSourceRef.current = next ? SELECTION_SOURCES.User : SELECTION_SOURCES.None
                }}
              >
                {physicalDevices.length === 0 ? (
                  <option value="">（无物理麦克风，请先连接）</option>
                ) : null}
                {physicalDevices.map((device) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {shortDeviceDisplayName(device, { preferredDeviceId: preferredAudio?.deviceId || "" })}
                  </option>
                ))}
              </select>
            </VoiceTooltip>
          </label>

          <label className="voice-field voice-toolbar__provider">
            <span className="voice-field__label">Provider</span>
            <VoiceTooltip content={providerInfo.tip}>
              <select
                value={providerId}
                disabled={busy || locked}
                onChange={(event) => setProviderId(event.target.value)}
              >
                {providers.map((item) => (
                  <option key={item.id} value={item.id}>{item.label}</option>
                ))}
              </select>
            </VoiceTooltip>
          </label>

          <div className="voice-toolbar__status">
            <span className="voice-field__label">Status</span>
            <div className="voice-toolbar__status-slot">
              <StatusBadge
                label="Session"
                value={sessionInfo.badge}
                tone={sessionInfo.tone}
                tip={sessionInfo.tip}
              />
            </div>
          </div>

          <div className="voice-toolbar__actions">
            <span className="voice-field__label" aria-hidden="true">&nbsp;</span>
            <button
              type="button"
              className={`voice-console__btn voice-console__btn--action ${running || stopping ? "voice-console__btn--danger" : "voice-console__btn--primary"}`}
              disabled={busy || starting || stopping}
              onClick={handlePrimaryAction}
              data-voice-action="primary"
            >
              {primaryActionLabel}
            </button>
          </div>
        </section>

        {providerId === "xinqi" ? (
          <section className="voice-companion" aria-label="本机 Companion" data-voice-region="companion">
            <div className="voice-companion__row">
              <div className="voice-companion__status">
                <span className="voice-field__label">本机 Xinqi Companion</span>
                <span
                  className={`voice-companion__pill voice-companion__pill--${companionStatusTone(companionDiscovery?.status)}`}
                >
                  {companionBusy && !companionDiscovery
                    ? "正在发现…"
                    : (companionDiscovery?.label || "尚未探测")}
                </span>
                {companionDiscovery?.secondaryLabel ? (
                  <span className="voice-companion__sub">{companionDiscovery.secondaryLabel}</span>
                ) : null}
              </div>
              <div className="voice-companion__actions">
                <button
                  type="button"
                  className="voice-console__btn voice-console__btn--ghost"
                  disabled={companionBusy || locked}
                  onClick={() => void refreshCompanionDiscovery()}
                >
                  重新发现
                </button>
                <button
                  type="button"
                  className="voice-console__btn voice-console__btn--ghost"
                  disabled={companionBusy || locked}
                  onClick={() => void handleCompanionRepair()}
                >
                  重新配对
                </button>
                {(companionDiscovery?.status === COMPANION_STATUS.BROWSER_PERMISSION_PROMPT
                  || companionDiscovery?.status === COMPANION_STATUS.BROWSER_PERMISSION_DENIED) ? (
                  <button
                    type="button"
                    className="voice-console__btn voice-console__btn--primary"
                    disabled={companionBusy || locked}
                    onClick={() => void handleCompanionAllowLocal()}
                  >
                    授权本机访问
                  </button>
                ) : null}
                <button
                  type="button"
                  className="voice-console__btn voice-console__btn--ghost"
                  disabled={locked}
                  onClick={() => {
                    const next = !companionAdvancedOpen
                    setCompanionAdvancedOpen(next)
                    saveCompanionAdvancedOpen(next)
                  }}
                >
                  {companionAdvancedOpen ? "隐藏高级" : "高级连接"}
                </button>
              </div>
            </div>

            {companionRepairOpen
              || companionDiscovery?.status === COMPANION_STATUS.PAIRING_REQUIRED
              || companionDiscovery?.canRepair ? (
              <div className="voice-companion__pair">
                <p className="voice-companion__hint">
                  在 Companion 窗口或 %USERPROFILE%\.facedev\companion\PAIRING_CODE.txt 查看 6 位配对码。
                  若提示本机网络权限：先点「授权本机访问」并允许浏览器弹窗，再输入配对码。
                </p>
                <div className="voice-companion__pair-row">
                  <input
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={8}
                    placeholder="配对码"
                    value={companionPairCode}
                    disabled={companionBusy || locked}
                    onChange={(event) => setCompanionPairCode(event.target.value)}
                  />
                  <button
                    type="button"
                    className="voice-console__btn voice-console__btn--primary"
                    disabled={companionBusy || locked || !companionPairCode.trim()}
                    onClick={() => void handleCompanionPair()}
                  >
                    配对
                  </button>
                </div>
              </div>
            ) : null}

            {companionAdvancedOpen ? (
              <div className="voice-companion__advanced">
                <p className="voice-companion__hint">
                  仅接受 127.0.0.1 / localhost。不可填写公网 URL 或 Robot API Key。
                </p>
                <div className="voice-companion__advanced-grid">
                  <label className="voice-field">
                    <span className="voice-field__label">本机端口</span>
                    <input
                      type="number"
                      min={1}
                      max={65535}
                      value={companionPortDraft}
                      disabled={locked}
                      onChange={(event) => setCompanionPortDraft(event.target.value)}
                    />
                  </label>
                  <label className="voice-field">
                    <span className="voice-field__label">本机 Gateway 地址</span>
                    <input
                      type="text"
                      placeholder="http://127.0.0.1:18740"
                      value={companionBaseDraft}
                      disabled={locked}
                      onChange={(event) => setCompanionBaseDraft(event.target.value)}
                    />
                  </label>
                  <div className="voice-companion__advanced-save">
                    <button
                      type="button"
                      className="voice-console__btn voice-console__btn--ghost"
                      disabled={locked}
                      onClick={handleCompanionAdvancedSave}
                    >
                      保存目标
                    </button>
                  </div>
                </div>
              </div>
            ) : null}

            {companionMessage ? (
              <p className="voice-companion__message">{companionMessage}</p>
            ) : null}
          </section>
        ) : null}

        <div
          className={`voice-status-slot${statusMessageVisible ? " is-visible" : ""}${errored ? " is-error" : ""}`}
          data-voice-region="status-slot"
          role={errored ? "alert" : undefined}
        >
          <div className="voice-status-slot__inner">
            {statusMessageVisible ? (
              <>
                <span className="voice-status-slot__text">{statusMessage}</span>
                {errored ? (
                  <button
                    type="button"
                    className="voice-console__btn voice-console__btn--ghost"
                    onClick={() => setShowErrorDetail((prev) => !prev)}
                  >
                    {showErrorDetail ? "收起" : "详情"}
                  </button>
                ) : null}
              </>
            ) : (
              <span className="voice-status-slot__placeholder" aria-hidden="true">&nbsp;</span>
            )}
          </div>
          {errored && showErrorDetail ? (
            <pre className="voice-status-slot__detail">
              {[
                errorCode ? `code: ${errorCode}` : null,
                stats?.lastError?.stage || stats?.startStage
                  ? `stage: ${stats?.lastError?.stage || stats.startStage}`
                  : null,
                stats?.lastError?.message ? `message: ${stats.lastError.message}` : `message: ${errorText}`,
                stats?.lastError?.expectedBytes != null ? `expectedBytes: ${stats.lastError.expectedBytes}` : null,
                stats?.lastError?.actualBytes != null ? `actualBytes: ${stats.lastError.actualBytes}` : null,
                stats?.lastError?.dataType ? `dataType: ${stats.lastError.dataType}` : null,
                stats?.lastError?.closeSide ? `closeSide: ${stats.lastError.closeSide}` : null,
              ].filter(Boolean).join("\n")}
            </pre>
          ) : null}
        </div>

        <div className="voice-console__workspace" data-voice-region="workspace-grid">
          <section className="voice-workspace" aria-label="语音工作区" data-voice-region="workspace">
            {showIdle ? (
              <div className="voice-idle">
                <div className="voice-idle__glyph" aria-hidden="true">
                  <span className="voice-idle__core" />
                  <span className="voice-idle__ring voice-idle__ring--a" />
                  <span className="voice-idle__ring voice-idle__ring--b" />
                </div>
                <strong>等待语音会话</strong>
                <p>点击「连接并开始」开始。</p>
              </div>
            ) : null}

            {showTranscriptSurface ? (
              <>
                <div className="voice-listening-surface">
                  <div className="voice-listening-surface__head">
                    <span className={`voice-listening${listening ? " is-active" : ""}`}>
                      <span className="voice-listening__dot" aria-hidden="true" />
                      {voiceStateLabel}
                    </span>
                    <VoiceTooltip content={micFull}>
                      <span className="voice-listening-surface__device">{micShort}</span>
                    </VoiceTooltip>
                  </div>

                  <div className="voice-activity" aria-label="Input Activity">
                    <VoiceTooltip content={VOICE_HELP.inputActivity}>
                      <div className="voice-activity__label" tabIndex={0}>Input Activity</div>
                    </VoiceTooltip>
                    <div className="voice-activity__bars" aria-hidden="true">
                      {activityScales.map((scale, index) => (
                        <span
                          key={index}
                          className={`voice-activity__bar${running && scale > 0.4 ? " is-hot" : ""}${!running ? " is-quiet" : ""}`}
                          style={{ transform: `scaleY(${scale})` }}
                        />
                      ))}
                    </div>
                    <div className="voice-activity__meta">
                      <span>{percent}%</span>
                    </div>
                  </div>

                  {providerId !== "mock" ? (
                    <div className="voice-partial" data-voice-region="partial">
                      <div className="voice-partial__label">Current Speech</div>
                      <p className={partialText ? "is-live" : "is-placeholder"}>
                        {partialText || "等待语音…"}
                        {partialText ? <span className="voice-transcript-cursor" aria-hidden="true" /> : null}
                      </p>
                      {providerId === "xinqi" && stats?.transcriptStatus?.detail ? (
                        <p className="hint-text" data-voice-region="transcript-status">
                          {stats.transcriptStatus.detail}
                        </p>
                      ) : null}
                    </div>
                  ) : (
                    <div className="voice-partial voice-partial--mock" data-voice-region="partial">
                      <div className="voice-partial__label">Current Speech</div>
                      <p className="is-placeholder">Mock 不产生识别文本</p>
                    </div>
                  )}
                </div>

                {providerId === "xinqi" ? (
                  <div className="voice-transcript">
                    <div className="voice-transcript__head">
                      <h3>对话</h3>
                      <span>{formatCount(conversation.length)} 条</span>
                    </div>
                    {assistantDraft ? (
                      <div className="voice-assistant-live">
                        <div className="voice-partial__label">心契正在回复</div>
                        <p>{assistantDraft}<span className="voice-transcript-cursor" aria-hidden="true" /></p>
                      </div>
                    ) : null}
                    <div className="voice-transcript-history-wrap">
                      <div
                        className="voice-transcript-history"
                        ref={historyRef}
                        onScroll={handleHistoryScroll}
                      >
                        {conversation.length === 0 ? (
                          <p className="voice-transcript-history__empty">尚无对话</p>
                        ) : (
                          conversation.map((item, index) => (
                            <article
                              key={`${item.wallClock}-${index}`}
                              className={`voice-transcript-item voice-transcript-item--${item.role}`}
                            >
                              <time>{item.role === "assistant" ? "心契" : "用户"} · {formatWallClock(item.wallClock)}</time>
                              <p>{item.text}</p>
                            </article>
                          ))
                        )}
                      </div>
                      {!autoScroll ? (
                        <button type="button" className="voice-jump-latest" onClick={jumpToLatest}>
                          ↓ 回到最新
                        </button>
                      ) : null}
                    </div>
                  </div>
                ) : providerId !== "mock" ? (
                  <div className="voice-transcript">
                    <div className="voice-transcript__head">
                      <h3>识别记录</h3>
                      <span>{formatCount(finalHistory.length)} 条</span>
                    </div>
                    <div className="voice-transcript-history-wrap">
                      <div
                        className="voice-transcript-history"
                        ref={historyRef}
                        onScroll={handleHistoryScroll}
                      >
                        {finalHistory.length === 0 ? (
                          <p className="voice-transcript-history__empty">尚无最终识别结果</p>
                        ) : (
                          finalHistory.map((item, index) => (
                            <article
                              key={`${item.wallClock}-${index}`}
                              className="voice-transcript-item"
                            >
                              <time>{formatWallClock(item.wallClock)}</time>
                              <p>{item.text}</p>
                            </article>
                          ))
                        )}
                      </div>
                      {!autoScroll ? (
                        <button
                          type="button"
                          className="voice-jump-latest"
                          onClick={jumpToLatest}
                        >
                          ↓ 回到最新
                        </button>
                      ) : null}
                    </div>
                  </div>
                ) : (
                  <div className="voice-transcript voice-transcript--mock">
                    <div className="voice-transcript__head">
                      <h3>识别记录</h3>
                      <span>Mock</span>
                    </div>
                    <p className="voice-transcript-history__empty">
                      Mock 无识别记录
                    </p>
                  </div>
                )}
              </>
            ) : null}
          </section>

          <aside className="voice-inspector" aria-label="系统状态" data-voice-region="inspector">
            <div className="voice-inspector__header">
              <h3>系统状态</h3>
              <p>Session Inspector</p>
            </div>

            <section className="voice-inspector__section">
              <h4>Voice</h4>
              <div className="voice-insp-meter" aria-label="input level">
                <div className="voice-insp-meter__track">
                  <div className="voice-insp-meter__fill" style={{ width: `${percent}%` }} />
                </div>
                <div className="voice-insp-meter__meta">
                  <span>{voiceStateLabel}</span>
                  <span>{percent}%</span>
                </div>
              </div>
              <dl className="voice-insp-list">
                <InspectorRow label="RMS" value={formatMetric(rms)} tip={VOICE_HELP.rms} />
                <InspectorRow label="Peak" value={formatMetric(peak)} tip={VOICE_HELP.peak} />
                <InspectorRow label="Mic" value={micShort} tip={micFull} />
              </dl>
            </section>

            <section className="voice-inspector__section">
              <h4>Session</h4>
              <dl className="voice-insp-list">
                <InspectorRow
                  label="State"
                  value={<StatusBadge label="Session" value={sessionState} />}
                />
                <InspectorRow
                  label="Provider"
                  value={providerInfo.label}
                  tip={providerInfo.tip}
                />
                <InspectorRow
                  label="Streaming"
                  value={formatStreamingLabel(providerId, stats?.streamingState, sessionState)}
                />
                <InspectorRow
                  label="Playback"
                  value={<StatusBadge label="Playback" value={stats?.playbackState || "Idle"} />}
                />
                <InspectorRow
                  label="Auth"
                  value={formatAuthLabel(providerId, stats?.authState)}
                  tip={authTooltip(providerId, stats?.authState)}
                />
              </dl>
            </section>

            <section className="voice-inspector__section">
              <h4>Runtime</h4>
              <VoiceTooltip content={VOICE_HELP.runtimeRate}>
                <div className="voice-pipeline" tabIndex={0}>
                  <strong>{inputSrLabel}</strong>
                  <span aria-hidden="true">→</span>
                  <strong>{formatCount(VOICE_AUDIO_FORMAT.sampleRate)} Hz</strong>
                </div>
              </VoiceTooltip>
              <VoiceTooltip content={frameMeta.tip}>
                <p className="voice-pipeline__meta" tabIndex={0}>{frameMeta.short}</p>
              </VoiceTooltip>
              <dl className="voice-insp-list">
                <InspectorRow label="Generated" value={formatCount(stats?.framesGenerated ?? 0)} />
                <InspectorRow
                  label="Dropped"
                  value={formatCount(dropped)}
                  warn={dropped > 0}
                  tip={VOICE_HELP.dropped}
                />
                <InspectorRow
                  label="Invalid"
                  value={formatCount(invalid)}
                  warn={invalid > 0}
                  tip={VOICE_HELP.invalid}
                />
              </dl>
            </section>

            <section className="voice-inspector__section">
              <h4>Transport</h4>
              <div className="voice-transport-lead">
                <strong>{providerInfo.label}</strong>
                <VoiceTooltip content={transportInfo.tip}>
                  <span tabIndex={0}>{transportInfo.short}</span>
                </VoiceTooltip>
              </div>
              <dl className="voice-insp-list">
                <InspectorRow label="Frames" value={formatCount(stats?.providerFramesReceived ?? 0)} />
                <InspectorRow label="Chunks" value={formatCount(stats?.providerAudioChunksSent ?? 0)} />
                <InspectorRow label="TX" value={formatBytes(stats?.providerBytesSent || 0)} />
                <InspectorRow label="Final" value={formatCount(stats?.finalTranscripts ?? 0)} />
              </dl>
            </section>
          </aside>
        </div>

        <details className="voice-advanced" data-voice-region="advanced-runtime">
          <summary>
            <span className="voice-advanced__title">高级运行信息</span>
            <span className="voice-advanced__hint">Runtime details</span>
          </summary>
          <div className="voice-advanced__grid">
            <div className="voice-advanced__card">
              <h4>Audio Runtime</h4>
              <dl className="audio-input-debug__meta">
                <div><dt>Input SR</dt><dd>{stats?.inputSampleRate == null ? "N/A" : `${stats.inputSampleRate} Hz`}</dd></div>
                <div><dt>Output SR</dt><dd>{VOICE_AUDIO_FORMAT.sampleRate} Hz</dd></div>
                <div><dt>Encoding</dt><dd>PCM S16LE</dd></div>
                <div><dt>Channels</dt><dd>1 (mono)</dd></div>
                <div><dt>Frame</dt><dd>{VOICE_AUDIO_FORMAT.frameDurationMs} ms</dd></div>
                <div><dt>Samples/Frame</dt><dd>{VOICE_AUDIO_FORMAT.samplesPerFrame}</dd></div>
                <div><dt>Bytes/Frame</dt><dd>{VOICE_AUDIO_FORMAT.bytesPerFrame}</dd></div>
                <div><dt>TX Frames</dt><dd>{stats?.framesSent ?? 0}</dd></div>
                <div><dt>Generated</dt><dd>{stats?.framesGenerated ?? 0}</dd></div>
                <div><dt>TX Bytes</dt><dd>{formatBytes(stats?.bytesSent || 0)}</dd></div>
                <div><dt>Dropped</dt><dd>{stats?.droppedFrames ?? 0}</dd></div>
                <div><dt>Invalid</dt><dd>{stats?.invalidFrames ?? 0}</dd></div>
                <div><dt>Duration</dt><dd>{formatDuration(stats?.durationMs || 0)}</dd></div>
              </dl>
            </div>
            <div className="voice-advanced__card">
              <h4>Provider Stats</h4>
              <dl className="audio-input-debug__meta">
                <div><dt>Frames RX</dt><dd>{stats?.providerFramesReceived ?? 0}</dd></div>
                <div><dt>WS Chunks TX</dt><dd>{stats?.providerAudioChunksSent ?? 0}</dd></div>
                <div><dt>Provider Bytes</dt><dd>{formatBytes(stats?.providerBytesSent || 0)}</dd></div>
                <div><dt>Pending Frames</dt><dd>{stats?.pendingAudioFrames ?? 0}</dd></div>
                <div><dt>WS Msg RX</dt><dd>{stats?.wsMessagesRx ?? 0}</dd></div>
                <div><dt>Partials</dt><dd>{stats?.partialTranscripts ?? 0}</dd></div>
                <div><dt>Finals</dt><dd>{stats?.finalTranscripts ?? 0}</dd></div>
                <div><dt>Chunk</dt><dd>{stats?.chunkDurationMs != null ? `${stats.chunkDurationMs} ms / ${stats.chunkBytes} B` : "N/A"}</dd></div>
                <div><dt>Last Audio TX</dt><dd>{stats?.lastAudioSendAt == null ? "—" : Math.round(stats.lastAudioSendAt)}</dd></div>
                <div><dt>Last Transcript</dt><dd>{stats?.lastTranscriptAt == null ? "—" : Math.round(stats.lastTranscriptAt)}</dd></div>
                <div><dt>Transport Policy</dt><dd>{transportPolicyLabel(providerId, stats)}</dd></div>
              </dl>
              <p className="hint-text">
                AssemblyAI：5×20 ms → 1×100 ms chunk。Deepgram：1×20 ms → 1×640 B binary。
                Xinqi 播放：24 kHz PCM，进度按播放线程已消费的源样本回报。
              </p>
            </div>
            <div className="voice-advanced__card">
              <h4>Audio Output</h4>
              <dl className="audio-input-debug__meta">
                <div><dt>State</dt><dd>{stats?.playbackState || "Idle"}</dd></div>
                <div><dt>Output Sample Rate</dt><dd>{stats?.playbackOutputSampleRate ? `${stats.playbackOutputSampleRate} Hz` : "—"}</dd></div>
                <div><dt>Source Sample Rate</dt><dd>{stats?.playbackSourceSampleRate ? `${stats.playbackSourceSampleRate} Hz` : "—"}</dd></div>
                <div><dt>Audio Chunks RX</dt><dd>{stats?.playbackChunks ?? 0}</dd></div>
                <div><dt>Samples Received</dt><dd>{stats?.playbackSamplesReceived ?? 0}</dd></div>
                <div><dt>Samples Played</dt><dd>{stats?.playbackSamplesPlayed ?? 0}</dd></div>
                <div><dt>Queued Duration</dt><dd>{stats?.playbackQueuedMs ?? 0} ms</dd></div>
                <div><dt>Underruns</dt><dd>{stats?.playbackUnderruns ?? 0}</dd></div>
                <div><dt>Playback Progress Sent</dt><dd>{stats?.playbackProgressSent ?? 0}</dd></div>
                <div><dt>Playback Done Sent</dt><dd>{stats?.playbackDoneSent ?? 0}</dd></div>
                <div><dt>Current Turn ID</dt><dd>{stats?.playbackTurnId ? String(stats.playbackTurnId).slice(0, 8) : "—"}</dd></div>
                <div><dt>Close Side</dt><dd>{stats?.closeSide || stats?.closeInitiator || "—"}</dd></div>
                <div><dt>Close Code</dt><dd>{stats?.closeCode == null ? "—" : stats.closeCode}</dd></div>
                <div><dt>Close Reason</dt><dd>{stats?.closeReason || "—"}</dd></div>
                <div><dt>Cleanup</dt><dd>{stats?.cleanupReason || "—"}</dd></div>
                <div><dt>Connection</dt><dd>{stats?.connectionMs == null ? "—" : `${stats.connectionMs} ms`}</dd></div>
              </dl>
            </div>
            <div className="voice-advanced__card">
              <h4>Xinqi Output Trace</h4>
              <dl className="audio-input-debug__meta">
                <div><dt>Turn ID</dt><dd>{stats?.xinqiOutputTrace?.turnId ? String(stats.xinqiOutputTrace.turnId).slice(0, 8) : "—"}</dd></div>
                <div><dt>Assistant Text Done</dt><dd>{stats?.xinqiOutputTrace?.assistantTextDone ?? 0}</dd></div>
                <div><dt>Browser Audio RX</dt><dd>{stats?.xinqiOutputTrace?.browserAudioEventsRx ?? 0}</dd></div>
                <div><dt>audio.done RX</dt><dd>{stats?.xinqiOutputTrace?.browserAudioDoneRx ?? 0}</dd></div>
                <div><dt>Audio Dropped (turnId)</dt><dd>{stats?.xinqiOutputTrace?.audioDroppedTurnMismatch ?? 0}</dd></div>
                <div><dt>Chunks Decoded</dt><dd>{stats?.xinqiOutputTrace?.audioChunksDecoded ?? 0}</dd></div>
                <div><dt>PCM Samples RX</dt><dd>{stats?.xinqiOutputTrace?.pcmSamplesReceived ?? 0}</dd></div>
                <div><dt>PCM Samples Played</dt><dd>{stats?.xinqiOutputTrace?.pcmSamplesPlayed ?? 0}</dd></div>
                <div><dt>Queued Duration</dt><dd>{stats?.xinqiOutputTrace?.queuedMs ?? 0} ms</dd></div>
                <div><dt>AudioContext</dt><dd>{stats?.xinqiOutputTrace?.audioContextState || "none"}</dd></div>
                <div><dt>Worklet</dt><dd>{stats?.xinqiOutputTrace?.workletState || "idle"}</dd></div>
                <div><dt>Output Device</dt><dd>{stats?.xinqiOutputTrace?.outputDevice || "(default)"}{stats?.sinkFallback ? " · fallback" : ""}</dd></div>
                <div><dt>Playback State</dt><dd>{stats?.xinqiOutputTrace?.playbackState || "Idle"}</dd></div>
                <div><dt>Playback Error</dt><dd>{stats?.xinqiOutputTrace?.playbackError || "—"}</dd></div>
                <div><dt>playback.progress TX</dt><dd>{stats?.xinqiOutputTrace?.playbackProgressSent ?? 0}</dd></div>
                <div><dt>playback.done TX</dt><dd>{stats?.xinqiOutputTrace?.playbackDoneSent ?? 0}</dd></div>
                <div><dt>turn.done RX</dt><dd>{stats?.xinqiOutputTrace?.turnDoneReceived ?? 0}</dd></div>
              </dl>
              <p className="hint-text">
                Gateway Upstream→Browser 音频计数见 Companion 本机日志（[xinqi-gw] audio relay）。不记录 Key / Token / PCM / Base64。
              </p>
            </div>
            <div className="voice-advanced__card">
              <h4>Xinqi Event Trace</h4>
              <div className="voice-xinqi-trace">
                {(stats?.xinqiTrace || []).length === 0 ? (
                  <p className="hint-text">尚无 Xinqi 事件。长语音复现时展开本区，查看 partial、environment、user、turn 的顺序。</p>
                ) : (
                  <table>
                    <thead>
                      <tr>
                        <th>ms</th>
                        <th>Event</th>
                        <th>Turn</th>
                        <th>Env</th>
                        <th>Partial</th>
                        <th>Final</th>
                        <th>Frames</th>
                        <th>Chunks</th>
                        <th>Drop</th>
                        <th>Inv</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(stats.xinqiTrace || []).map((item, index) => (
                        <tr key={`${item.at}-${index}`}>
                          <td>{item.relativeMs}</td>
                          <td>{item.type}{item.error ? ` [${item.error}]` : ""}{item.closeSide ? ` · ${item.closeSide}` : ""}{item.closeCode != null ? ` #${item.closeCode}` : ""}</td>
                          <td>{item.turnId ? String(item.turnId).slice(0, 8) : "—"}</td>
                          <td title={item.environmentReason || ""}>
                            {item.environmentState || "—"}
                            {item.environmentTarget ? ` / ${item.environmentTarget}` : ""}
                          </td>
                          <td>{item.partialLength == null ? "—" : item.partialLength}</td>
                          <td>{item.finalLength == null ? "—" : item.finalLength}</td>
                          <td>{item.frames}</td>
                          <td>{item.chunks}</td>
                          <td>{item.dropped}</td>
                          <td>{item.invalid}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
              <p className="hint-text">只保留最近 100 条。不保存原文、音频、API Key 或 token。Env 的 title 为 reason。</p>
            </div>
            <div className="voice-advanced__card">
              <h4>Session Events</h4>
              <pre className="audio-input-debug__events">
                {(stats?.events || []).map((item, index) => `#${index + 1} ${item.type}${item.message ? ` — ${item.message}` : ""}${item.code ? ` [${item.code}]` : ""}${item.inputSampleRate ? ` in=${item.inputSampleRate}` : ""}`).join("\n") || "（尚无事件）"}
              </pre>
            </div>
          </div>
        </details>

        <details className="voice-advanced" data-voice-region="advanced-device">
          <summary>
            <span className="voice-advanced__title">高级设备诊断</span>
            <span className="voice-advanced__hint">Device &amp; channel diagnostics</span>
          </summary>
          <div className="voice-advanced__grid">
            <div className="voice-advanced__card">
              <h4>连接诊断操作</h4>
              <div className="voice-advanced__actions">
                <button
                  type="button"
                  className="voice-console__btn voice-console__btn--secondary"
                  disabled={busy || locked}
                  onClick={() => void handleRequestPermission()}
                >
                  请求麦克风权限
                </button>
                <button
                  type="button"
                  className="voice-console__btn voice-console__btn--secondary"
                  disabled={busy || locked}
                  onClick={() => void refreshDevices()}
                >
                  刷新音频设备
                </button>
              </div>
              <dl className="audio-input-debug__meta">
                <div><dt>Permission</dt><dd>{permission}</dd></div>
                <div><dt>Preferred</dt><dd>{preferredAudio?.deviceId ? shortDeviceId(preferredAudio.deviceId) : "—"}</dd></div>
                <div><dt>Selected</dt><dd>{shortDeviceId(selectedDeviceId)}</dd></div>
                <div><dt>Full Label</dt><dd>{selectedDevice ? formatDeviceLabel(selectedDevice) : "—"}</dd></div>
              </dl>
              <p className="hint-text">
                正常使用请点击主界面「连接并开始」。此处仅用于权限异常与设备诊断。
              </p>
              <label className="voice-field">
                <span className="voice-field__label">播放输出</span>
                <select
                  value={outputDeviceId}
                  disabled={busy || locked || !audioOutputSelectionSupported()}
                  onChange={(event) => setOutputDeviceId(event.target.value)}
                >
                  <option value="">系统默认输出</option>
                  {outputDevices.filter((device) => device.deviceId && device.deviceId !== "communications").map((device) => (
                    <option key={device.deviceId} value={device.deviceId}>
                      {device.label || device.deviceId.slice(0, 8)}
                    </option>
                  ))}
                </select>
              </label>
              <p className="hint-text">
                {audioOutputSelectionSupported()
                  ? "留空使用系统默认扬声器。ReSpeaker Lite 输出会排在前面，不保证当前端点一定可用。"
                  : "当前浏览器不能切换输出设备，播放走系统默认设备。"}
              </p>
            </div>

            <div className="voice-advanced__card">
              <h4>Device Resolution</h4>
              <dl className="audio-input-debug__meta">
                <div><dt>Raw audioinput count</dt><dd>{deviceResolution?.rawAudioInputCount ?? devices.length}</dd></div>
                <div><dt>Physical input count</dt><dd>{deviceResolution?.physicalInputCount ?? physicalDevices.length}</dd></div>
                <div><dt>Default alias present</dt><dd>{deviceResolution?.defaultAliasPresent ? "yes" : "no"}</dd></div>
                <div><dt>Communications alias present</dt><dd>{deviceResolution?.communicationsAliasPresent ? "yes" : "no"}</dd></div>
                <div><dt>Preferred</dt><dd>{deviceResolution?.preferredLabel || preferredAudio?.label || "none"}</dd></div>
                <div><dt>Resolved</dt><dd>{deviceResolution?.resolvedLabel || micShort || "—"}</dd></div>
                <div><dt>Requested Device ID</dt><dd>{shortDeviceId(deviceResolution?.requestedDeviceId || selectedDeviceId)}</dd></div>
                <div><dt>Actual Track Device ID</dt><dd>{shortDeviceId(deviceResolution?.actualDeviceId || trackSettings?.deviceId)}</dd></div>
                <div><dt>Selection Source</dt><dd>{deviceResolution?.selectionSource || selectionSourceRef.current || "none"}</dd></div>
                <div><dt>Start Attempts</dt><dd>{deviceResolution?.startAttempts ?? "—"}</dd></div>
                <div><dt>Last Device Error</dt><dd>{deviceResolution?.lastDeviceError || "none"}</dd></div>
              </dl>
            </div>

            <div className="voice-advanced__card">
              <h4>Raw enumerateDevices List</h4>
              <pre className="audio-input-debug__events">
                {devices.length === 0
                  ? "（尚无设备）"
                  : devices.map((device, index) => {
                    const item = device.isPhysical != null ? device : normalizeAudioInputDevice(device)
                    const flags = [
                      item.isPhysical ? "physical" : null,
                      item.isDefaultAlias ? "default" : null,
                      item.isCommunicationsAlias ? "communications" : null,
                      item.isReSpeaker ? "respeaker" : null,
                    ].filter(Boolean).join(",")
                    return `#${index + 1} [${flags}] ${shortDeviceId(item.deviceId)} ${item.label || "(no label)"}`
                  }).join("\n")}
              </pre>
            </div>

            <div className="voice-advanced__card">
              <h4>Capture Channel Mode</h4>
              <label className="voice-field">
                <span className="voice-field__label">Mode</span>
                <select
                  value={channelMode}
                  disabled={busy || locked}
                  onChange={(event) => setChannelMode(event.target.value)}
                >
                  <option value={AUDIO_CHANNEL_MODES.native}>Native</option>
                  <option value={AUDIO_CHANNEL_MODES.mono}>Mono</option>
                  <option value={AUDIO_CHANNEL_MODES.stereo}>Stereo Diagnostic</option>
                </select>
              </label>
              <dl className="audio-input-debug__meta">
                <div><dt>Mode</dt><dd>{AUDIO_CHANNEL_MODE_LABELS[channelMode]}</dd></div>
                <div>
                  <dt>Requested CH</dt>
                  <dd>{plannedRequestedChannels == null ? "unspecified" : plannedRequestedChannels}</dd>
                </div>
                <div><dt>Device ID</dt><dd>{shortDeviceId(selectedDeviceId)}</dd></div>
                <div><dt>sampleRate ideal</dt><dd>{AUDIO_CAPTURE_CONSTRAINTS.sampleRateIdeal}</dd></div>
              </dl>
              <p className="hint-text">
                Voice Runtime 始终输出 mono PCM。Stereo Diagnostic 仅用于观察逻辑通道，不能在会话运行中切换。
              </p>
            </div>

            <div className="voice-advanced__card">
              <h4>Channel Diagnostics</h4>
              <dl className="audio-input-debug__meta">
                <div><dt>Actual Channels</dt><dd>{formatSettingValue(trackSettings?.channelCount)}</dd></div>
                <div><dt>CH0 RMS</dt><dd>{formatMetric(rms0)}</dd></div>
                <div><dt>CH1 RMS</dt><dd>{rms1 == null ? "N/A" : formatMetric(rms1)}</dd></div>
                <div><dt>Correlation</dt><dd>{correlationLabel}</dd></div>
                <div><dt>Difference</dt><dd>{differenceLabel}</dd></div>
              </dl>
              {diagnosticHint ? <p className="audio-input-debug__hint">{diagnosticHint}</p> : null}
              <p className="hint-text">
                物理 Mic1 / Mic2 不默认等同于 USB CH0 / CH1。Mic1 无响应已确认不是 Browser 层问题，本阶段不再阻塞 Voice Runtime。
              </p>
            </div>

            <div className="voice-advanced__card">
              <h4>Track Settings</h4>
              <dl className="audio-input-debug__meta">
                <div><dt>sampleRate</dt><dd>{formatSettingValue(trackSettings?.sampleRate)}</dd></div>
                <div><dt>sampleSize</dt><dd>{formatSettingValue(trackSettings?.sampleSize)}</dd></div>
                <div><dt>channelCount</dt><dd>{formatSettingValue(trackSettings?.channelCount)}</dd></div>
                <div><dt>deviceId</dt><dd>{shortDeviceId(trackSettings?.deviceId)}</dd></div>
                <div><dt>echoCancellation</dt><dd>{formatSettingValue(trackSettings?.echoCancellation)}</dd></div>
                <div><dt>noiseSuppression</dt><dd>{formatSettingValue(trackSettings?.noiseSuppression)}</dd></div>
                <div><dt>autoGainControl</dt><dd>{formatSettingValue(trackSettings?.autoGainControl)}</dd></div>
                <div><dt>latency</dt><dd>{formatSettingValue(trackSettings?.latency)}</dd></div>
              </dl>
            </div>

            <div className="voice-advanced__card">
              <h4>Provider Debug</h4>
              <dl className="audio-input-debug__meta">
                <div><dt>Provider</dt><dd>{stats?.providerId || providerId}</dd></div>
                <div><dt>WS State</dt><dd>{stats?.wsState || "N/A"}</dd></div>
                <div><dt>Close Code</dt><dd>{stats?.closeCode == null ? "—" : stats.closeCode}</dd></div>
                <div><dt>Close Reason</dt><dd>{stats?.closeReason || "—"}</dd></div>
                <div><dt>Last Event</dt><dd>{stats?.lastEventType || "—"}</dd></div>
                <div><dt>Speech Model</dt><dd>{stats?.speechModel || "—"}</dd></div>
                <div><dt>Languages</dt><dd>{Array.isArray(stats?.languageCodes) ? stats.languageCodes.join(",") : "—"}</dd></div>
                <div><dt>Chunks Sent</dt><dd>{stats?.providerAudioChunksSent ?? 0}</dd></div>
                <div><dt>Messages RX</dt><dd>{stats?.wsMessagesRx ?? 0}</dd></div>
                <div><dt>Last Start Stage</dt><dd>{stats?.startStage || "—"}</dd></div>
              </dl>
              <p className="hint-text">不显示 temporary token。API Key 仅存在于服务器环境变量。</p>
            </div>

            <div className="voice-advanced__card">
              <h4>Test Guidance</h4>
              <ol className="audio-input-debug__guide">
                <li>Mock：Start 后确认电平与 Runtime Frames 增长，且不请求 /api/voice/token。</li>
                <li>AssemblyAI / Deepgram：Start 后确认 partial / final；Provider 切换须先 Stop。</li>
                <li>确认 Runtime 始终为 16000 / mono / PCM16LE / 20 ms。</li>
                <li>长 Transcript 应仅在历史区内部滚动，不应撑高整页。</li>
              </ol>
            </div>
          </div>
        </details>
      </section>
    </VoiceTooltipProvider>
  )
}
