import { useEffect, useMemo, useRef, useState } from "react"
import {
  BINDING_RANGE_MODE_CUSTOM,
  BINDING_RANGE_MODE_FULL,
  CHANNEL_VALUE,
  CHANNEL_X,
  CHANNEL_Y,
  CHANNEL_LATERAL,
  CURVE_LINEAR,
  CURVE_SMOOTHSTEP,
  bindingStrokeUtilizationPercent,
  bindingWithRestoredEndpointsVsNeutral,
  normalizeBinding,
  rangeForControlId,
} from "../core/faceRigProfile.js"
import { SERVO_COUNT, getServoConfig } from "../core/servoConfig.js"
import {
  bindingTargetPatch,
  traceBindingNormalized,
  traceBindingUpdateTarget,
} from "../sdk/binding/bindingActuatorFields.js"
import {
  pickPreferredBindingServoId,
  pickUnusedServoId,
} from "../sdk/binding/bindingActions.js"
import { loadActuatorProfiles } from "../sdk/output/loadActuatorProfiles.js"
import {
  filterBindingsForInspector,
  isBrowTipSemanticControlId,
  resolveBrowTipAddTarget,
  resolveBrowTipBindingHost,
  BROW_TIP_BIND_CHANNEL_F,
  BROW_TIP_BIND_CHANNEL_D,
} from "../sdk/binding/browTipBindingUi.js"
import {
  isJawSemanticControlId,
  resolveJawAddTarget,
  resolveJawBindingHost,
  JAW_BIND_CHANNEL_A,
  JAW_BIND_CHANNEL_D,
} from "../sdk/binding/jawBindingUi.js"
import {
  BINDING_DIR_FORWARD,
  BINDING_DIR_REVERSE,
  bindingDirectionPatch,
  bindingMappingDirectionLabel,
  readBindingMappingDirection,
  readLowerLimitPwm,
  readUpperLimitPwm,
  shouldReverseBindingForDirection,
} from "../sdk/binding/bindingInspectorWorkflowUi.js"
import { resolveJawNeutralCapture } from "../sdk/kinematics/jawKinematics.js"
import { clampNumber, toInt } from "../utils/clamp.js"

function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function fmtPwm(v) {
  return Number.isFinite(Number(v)) ? String(Math.round(Number(v))) : "—"
}

export default function FaceRigBindingInspector({
  controls,
  bindings,
  contributions = [],
  kinematics = null,
  selectedControlId,
  selectedChannel,
  onSelectChannel,
  rigValues,
  configs,
  onBindingsReplace,
  onCaptureBindingNeutral,
  outputMode = "preview",
  driveArmed = false,
}) {
  void outputMode
  void driveArmed

  const control = controls.find((c) => c.controlId === selectedControlId)
  const hasXy = Boolean(control?.channels?.x && control?.channels?.y)
  const browTipHost = resolveBrowTipBindingHost(selectedControlId, selectedChannel)
  const jawHost = resolveJawBindingHost(selectedControlId, selectedChannel)
  const isBrowTipBinding = Boolean(browTipHost.isBrowTipBinding)
  const isJawBinding = Boolean(jawHost.isJawBinding)
  const channelList = filterBindingsForInspector(bindings, selectedControlId, selectedChannel)
  const tipPad =
    isBrowTipBinding && browTipHost.pair
      ? rigValues?.[browTipHost.pair.semanticControlId]
      : null
  const jawPad = isJawBinding ? rigValues?.jaw : null
  const duplicateActuatorsInChannel = useMemo(() => {
    const counts = new Map()
    for (const b of channelList) {
      const ak = b.actuatorKey ?? `servo_${b.servoId}`
      counts.set(ak, (counts.get(ak) ?? 0) + 1)
    }
    return [...counts.entries()].filter(([, n]) => n > 1).map(([ak]) => ak)
  }, [channelList])
  const contribLogicalById = useMemo(() => {
    const m = new Map()
    for (const c of contributions) {
      if (c && c.bindingId != null && Number.isFinite(c.logicalPwm)) {
        m.set(c.bindingId, c.logicalPwm)
      }
    }
    for (const b of channelList) {
      if (m.has(b.bindingId)) continue
      const jawCap = resolveJawNeutralCapture(b, kinematics)
      if (jawCap && Number.isFinite(jawCap.pwm)) {
        m.set(b.bindingId, jawCap.pwm)
      }
    }
    return m
  }, [contributions, channelList, kinematics])

  /** 本条绑定对应的控件通道实时值（signed100 / percent），来自 contribution 或 rig */
  const contribRawById = useMemo(() => {
    const m = new Map()
    for (const c of contributions) {
      if (c && c.bindingId != null && Number.isFinite(Number(c.rawChannelValue))) {
        m.set(c.bindingId, Number(c.rawChannelValue))
      }
    }
    return m
  }, [contributions])

  /** 舵机配置页已启用的总线号；新增绑定时优先占用这些 ID，否则下发会因无 profile 被跳过。 */
  const availableBusServoIds = useMemo(() => {
    try {
      const { actuatorProfiles } = loadActuatorProfiles()
      return [
        ...new Set(
          (actuatorProfiles || [])
            .filter((p) => p && p.enabled !== false)
            .map((p) => Number(p.busServoId))
            .filter((id) => Number.isFinite(id) && id > 0)
        ),
      ].sort((a, b) => a - b)
    } catch {
      return []
    }
  }, [bindings])

  const availableBusServoIdSet = useMemo(
    () => new Set(availableBusServoIds),
    [availableBusServoIds]
  )

  const servoSelectIds = useMemo(() => {
    const ids = new Set()
    for (let i = 1; i < SERVO_COUNT; i += 1) ids.add(i)
    for (const id of availableBusServoIds) {
      if (id > 0 && id < SERVO_COUNT) ids.add(id)
    }
    for (const b of bindings || []) {
      const id = Number(b?.servoId)
      if (Number.isFinite(id) && id >= 0 && id < SERVO_COUNT) ids.add(id)
    }
    return [...ids].sort((a, b) => a - b)
  }, [availableBusServoIds, bindings])

  const [inspectorHint, setInspectorHint] = useState("")
  const [inspectorHintBindingId, setInspectorHintBindingId] = useState(null)
  const hintTimerRef = useRef(null)
  const [setupBindingIds, setSetupBindingIds] = useState(() => new Set())
  const [openMenuId, setOpenMenuId] = useState(null)
  const [batchOpen, setBatchOpen] = useState(false)

  useEffect(() => {
    return () => {
      if (hintTimerRef.current) {
        window.clearTimeout(hintTimerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    if (!isBrowTipSemanticControlId(selectedControlId) || !onSelectChannel) return
    const ch = String(selectedChannel || "")
    if (ch === "x" || ch === "y" || ch === CHANNEL_X || ch === CHANNEL_Y || ch === "tip_a" || ch === "tip_b") {
      onSelectChannel(BROW_TIP_BIND_CHANNEL_F)
    }
  }, [selectedControlId, selectedChannel, onSelectChannel])

  useEffect(() => {
    if (!isJawSemanticControlId(selectedControlId) || !onSelectChannel) return
    const ch = String(selectedChannel || "")
    if (ch === CHANNEL_VALUE || ch === "value") {
      onSelectChannel(JAW_BIND_CHANNEL_A)
      return
    }
    if (ch === "lateral" || ch === CHANNEL_LATERAL) {
      onSelectChannel(JAW_BIND_CHANNEL_D)
    }
  }, [selectedControlId, selectedChannel, onSelectChannel])

  useEffect(() => {
    function onDocClick() {
      setOpenMenuId(null)
      setBatchOpen(false)
    }
    document.addEventListener("click", onDocClick)
    return () => document.removeEventListener("click", onDocClick)
  }, [])

  function flashHint(msg, bindingId = null) {
    if (hintTimerRef.current) {
      window.clearTimeout(hintTimerRef.current)
    }
    setInspectorHint(msg)
    setInspectorHintBindingId(bindingId)
    hintTimerRef.current = window.setTimeout(() => {
      setInspectorHint("")
      setInspectorHintBindingId(null)
      hintTimerRef.current = null
    }, 4500)
  }

  function getContribLogical(bindingId) {
    const v = contribLogicalById.get(bindingId)
    return Number.isFinite(v) ? v : undefined
  }

  function getContribRaw(bindingId, binding) {
    const fromContrib = contribRawById.get(bindingId)
    if (Number.isFinite(fromContrib)) return fromContrib
    if (!binding) return undefined
    const raw = rigValues?.[binding.controlId]?.[binding.channel]
    const n = Number(raw)
    return Number.isFinite(n) ? n : undefined
  }

  function warnIfNearNeutralForLimit(binding, logicalPwm) {
    if (Math.abs(logicalPwm - binding.neutralPwm) < 20) {
      flashHint("当前接近中位，不建议作为极限。", binding.bindingId)
      return true
    }
    return false
  }

  function markSetup(bindingId) {
    setSetupBindingIds((prev) => {
      const next = new Set(prev)
      next.add(bindingId)
      return next
    })
  }

  function clearSetup(bindingId) {
    setSetupBindingIds((prev) => {
      if (!prev.has(bindingId)) return prev
      const next = new Set(prev)
      next.delete(bindingId)
      return next
    })
  }

  const rawVal = isBrowTipBinding || isJawBinding
    ? null
    : rigValues[selectedControlId]?.[selectedChannel]
  const displayVal = isBrowTipBinding
    ? `节点 ${browTipHost.hostControlId} → 期望 ID${browTipHost.expectedServoId}`
    : isJawBinding
      ? `节点 ${jawHost.hostControlId} → 期望 ID${jawHost.expectedServoId}`
      : rawVal === undefined || rawVal === null || Number.isNaN(Number(rawVal))
        ? "—"
        : String(rawVal)

  function replaceWith(nextBindings) {
    onBindingsReplace(nextBindings)
  }

  function patchBinding(bindingId, patch) {
    const forcesCustom =
      Object.prototype.hasOwnProperty.call(patch, "positiveTargetPwm") ||
      Object.prototype.hasOwnProperty.call(patch, "negativeTargetPwm") ||
      Object.prototype.hasOwnProperty.call(patch, "neutralPwm")
    let nextPatch =
      forcesCustom ? { ...patch, rangeMode: BINDING_RANGE_MODE_CUSTOM } : patch

    if (Object.prototype.hasOwnProperty.call(patch, "servoId")) {
      const targetPatch = bindingTargetPatch(patch.servoId)
      nextPatch = { ...nextPatch, ...targetPatch }
    }

    replaceWith(
      bindings.map((b) => {
        if (b.bindingId !== bindingId) {
          return b
        }
        if (Object.prototype.hasOwnProperty.call(patch, "servoId")) {
          traceBindingUpdateTarget({
            bindingId,
            prevServoId: b.servoId,
            prevActuatorKey: b.actuatorKey,
            nextServoId: nextPatch.servoId,
            nextActuatorKey: nextPatch.actuatorKey,
          })
        }
        const normalized = normalizeBinding({ ...b, ...nextPatch })
        traceBindingNormalized(normalized)
        return normalized
      })
    )
  }

  function handleRestoreFullStroke(bindingId) {
    replaceWith(
      bindings.map((b) =>
        b.bindingId === bindingId ? bindingWithRestoredEndpointsVsNeutral(b) : b
      )
    )
  }

  function applyNeutralFromContribution(bindingId) {
    if (onCaptureBindingNeutral) {
      const res = onCaptureBindingNeutral(bindingId)
      if (res?.ok) {
        flashHint(res.message || "已设为中位", bindingId)
      } else {
        flashHint(res?.message || "设为中位失败", bindingId)
      }
      return
    }
    const b = bindings.find((x) => x.bindingId === bindingId)
    if (!b) return
    const lm = getContribLogical(bindingId)
    if (!Number.isFinite(lm)) {
      flashHint("当前无本条绑定的 contribution 输出，请先启用绑定并拖动控件。", bindingId)
      return
    }
    flashHint(`已设为中位：logical ${Math.round(lm)}`, bindingId)
    replaceWith(
      bindings.map((x) =>
        x.bindingId === bindingId
          ? normalizeBinding({
              ...x,
              neutralPwm: Math.round(lm),
              rangeMode: BINDING_RANGE_MODE_CUSTOM,
            })
          : x
      )
    )
  }

  /** 上极限 ← positiveTargetPwm（控件 +100） */
  function applyPositiveFromContribution(bindingId) {
    const b = bindings.find((x) => x.bindingId === bindingId)
    if (!b) return
    const lm = getContribLogical(bindingId)
    if (!Number.isFinite(lm)) {
      flashHint("当前无本条绑定的 contribution 输出，请先启用绑定并拖动控件。", bindingId)
      return
    }
    warnIfNearNeutralForLimit(b, lm)
    replaceWith(
      bindings.map((x) =>
        x.bindingId === bindingId
          ? normalizeBinding({
              ...x,
              positiveTargetPwm: Math.round(lm),
              rangeMode: BINDING_RANGE_MODE_CUSTOM,
            })
          : x
      )
    )
  }

  /** 下极限 ← negativeTargetPwm（控件 −100） */
  function applyNegativeFromContribution(bindingId) {
    const b = bindings.find((x) => x.bindingId === bindingId)
    if (!b) return
    const lm = getContribLogical(bindingId)
    if (!Number.isFinite(lm)) {
      flashHint("当前无本条绑定的 contribution 输出，请先启用绑定并拖动控件。", bindingId)
      return
    }
    warnIfNearNeutralForLimit(b, lm)
    replaceWith(
      bindings.map((x) =>
        x.bindingId === bindingId
          ? normalizeBinding({
              ...x,
              negativeTargetPwm: Math.round(lm),
              rangeMode: BINDING_RANGE_MODE_CUSTOM,
            })
          : x
      )
    )
  }

  function handleBatchPositiveForChannel() {
    const ids = new Set(channelList.map((b) => b.bindingId))
    let anyNearNeutral = false
    const next = bindings.map((b) => {
      if (!ids.has(b.bindingId)) return b
      const lm = getContribLogical(b.bindingId)
      if (!Number.isFinite(lm)) return b
      if (Math.abs(lm - b.neutralPwm) < 20) {
        anyNearNeutral = true
      }
      return normalizeBinding({
        ...b,
        positiveTargetPwm: Math.round(lm),
        rangeMode: BINDING_RANGE_MODE_CUSTOM,
      })
    })
    if (anyNearNeutral) {
      flashHint(
        "当前接近中位，不建议作为极限（部分条目已按要求写入目标）。",
        channelList[0]?.bindingId ?? null
      )
    }
    replaceWith(next)
    setBatchOpen(false)
  }

  function handleBatchNegativeForChannel() {
    const ids = new Set(channelList.map((b) => b.bindingId))
    let anyNearNeutral = false
    const next = bindings.map((b) => {
      if (!ids.has(b.bindingId)) return b
      const lm = getContribLogical(b.bindingId)
      if (!Number.isFinite(lm)) return b
      if (Math.abs(lm - b.neutralPwm) < 20) {
        anyNearNeutral = true
      }
      return normalizeBinding({
        ...b,
        negativeTargetPwm: Math.round(lm),
        rangeMode: BINDING_RANGE_MODE_CUSTOM,
      })
    })
    if (anyNearNeutral) {
      flashHint(
        "当前接近中位，不建议作为极限（部分条目已按要求写入目标）。",
        channelList[0]?.bindingId ?? null
      )
    }
    replaceWith(next)
    setBatchOpen(false)
  }

  function flashAddBindingHint(controlId, servoId, bindingId) {
    let msg = `已新增 ${controlId} → ID${servoId}`
    if (!availableBusServoIdSet.has(Number(servoId))) {
      msg +=
        availableBusServoIds.length === 0
          ? "（警告：舵机配置页尚无启用的 RJ/ST profile）"
          : `（警告：舵机配置页无 ID${servoId} 的 profile）`
    } else {
      msg += " · 请拖动面部控件，对照下方实时值标定行程"
    }
    flashHint(msg, bindingId)
  }

  function commitNewBinding(next) {
    markSetup(next.bindingId)
    replaceWith([...bindings, next])
    flashAddBindingHint(next.controlId, next.servoId, next.bindingId)
  }

  function handleAddBinding() {
    if (!selectedControlId) {
      flashHint("请先在左侧选择一个控制项，再点「新增绑定」", null)
      return
    }

    if (isBrowTipBinding) {
      const target = resolveBrowTipAddTarget(bindings, selectedControlId, selectedChannel)
      if (!target) {
        flashHint(
          `${browTipHost.hostControlId} 已绑定。本通道只允许一路舵机（期望 ID${browTipHost.expectedServoId}）；请编辑或删除现有条目。`,
          channelList[0]?.bindingId ?? null
        )
        return
      }
      const { neutral, pos, neg } = rangeForControlId(target.controlId)
      const next = normalizeBinding({
        bindingId: uid("bind"),
        controlId: target.controlId,
        channel: CHANNEL_VALUE,
        servoId: target.servoId,
        neutralPwm: neutral,
        positiveTargetPwm: pos,
        negativeTargetPwm: neg,
        weight: 1,
        curve: CURVE_LINEAR,
        enabled: true,
        rangeMode: BINDING_RANGE_MODE_FULL,
      })
      commitNewBinding(next)
      return
    }

    if (isJawBinding) {
      const target = resolveJawAddTarget(bindings, selectedControlId, selectedChannel)
      if (!target) {
        flashHint(
          `${jawHost.hostControlId} 已绑定。本通道只允许一路舵机（期望 ID${jawHost.expectedServoId}）；请编辑或删除现有条目。`,
          channelList[0]?.bindingId ?? null
        )
        return
      }
      const { neutral, pos, neg } = rangeForControlId(target.controlId)
      const next = normalizeBinding({
        bindingId: uid("bind"),
        controlId: target.controlId,
        channel: CHANNEL_VALUE,
        servoId: target.servoId,
        neutralPwm: neutral,
        positiveTargetPwm: pos,
        negativeTargetPwm: neg,
        weight: 1,
        curve: CURVE_LINEAR,
        enabled: true,
        rangeMode: BINDING_RANGE_MODE_FULL,
      })
      commitNewBinding(next)
      return
    }

    const hostId = selectedControlId
    const hostCh = selectedChannel || CHANNEL_VALUE
    const { neutral, pos, neg } = rangeForControlId(hostId)
    const servoId = pickPreferredBindingServoId(bindings, null, availableBusServoIds)
    const next = normalizeBinding({
      bindingId: uid("bind"),
      controlId: hostId,
      channel: hostCh,
      servoId,
      neutralPwm: neutral,
      positiveTargetPwm: pos,
      negativeTargetPwm: neg,
      weight: 1,
      curve: CURVE_LINEAR,
      enabled: true,
      rangeMode: BINDING_RANGE_MODE_FULL,
    })
    commitNewBinding(next)
  }

  function handleDeleteBinding(bindingId) {
    clearSetup(bindingId)
    setOpenMenuId(null)
    replaceWith(bindings.filter((b) => b.bindingId !== bindingId))
  }

  function pickServoForReversedCopy(b) {
    return pickUnusedServoId(bindings, Number(b?.servoId) > 0 ? Number(b.servoId) + 1 : 1)
  }

  function handleDirectionChange(binding, nextDirection) {
    if (!shouldReverseBindingForDirection(binding, nextDirection)) return
    patchBinding(binding.bindingId, bindingDirectionPatch(nextDirection))
  }

  function handleCopyReversedBinding(b) {
    const servoId = pickServoForReversedCopy(b)
    const copy = normalizeBinding({
      bindingId: uid("bind"),
      controlId: b.controlId,
      channel: b.channel,
      servoId,
      neutralPwm: b.neutralPwm,
      positiveTargetPwm: b.positiveTargetPwm,
      negativeTargetPwm: b.negativeTargetPwm,
      invert: !b.invert,
      weight: b.weight,
      curve: b.curve,
      enabled: true,
      rangeMode: b.rangeMode,
    })
    const idx = bindings.findIndex((x) => x.bindingId === b.bindingId)
    setOpenMenuId(null)
    if (idx < 0) {
      replaceWith([...bindings, copy])
    } else {
      const next = [...bindings]
      next.splice(idx + 1, 0, copy)
      replaceWith(next)
    }
  }

  function handleCopyBinding(b) {
    const copy = normalizeBinding({
      ...b,
      bindingId: uid("bind"),
    })
    const idx = bindings.findIndex((x) => x.bindingId === b.bindingId)
    setOpenMenuId(null)
    if (idx < 0) {
      replaceWith([...bindings, copy])
    } else {
      const next = [...bindings]
      next.splice(idx + 1, 0, copy)
      replaceWith(next)
    }
  }

  async function copyText(text, bindingId = null) {
    try {
      await navigator.clipboard.writeText(String(text || ""))
      flashHint("已复制到剪贴板", bindingId)
    } catch {
      flashHint("复制失败", bindingId)
    }
  }

  const setUpperLimitLabel = (inSetup) => (inSetup ? "设为上极限" : "重新设定")
  const setNeutralLabel = (inSetup) => (inSetup ? "设为中位" : "重新设定")
  const setLowerLimitLabel = (inSetup) => (inSetup ? "设为下极限" : "重新设定")

  return (
    <div className="face-rig-binding-inspector face-rig-binding-inspector--workflow">
      <h3 className="face-rig-binding-inspector-title">绑定检视</h3>

      <div className="face-rig-binding-current face-rig-binding-current--summary">
        <div className="face-rig-binding-summary-title">{control?.label ?? "未选择控件"}</div>
        <code className="face-rig-binding-summary-id">{selectedControlId || "—"}</code>

        <div className="face-rig-binding-row face-rig-binding-row-channel">
          <span className="face-rig-binding-k">通道</span>
          <div className="face-rig-binding-channel-wrap">
            {isBrowTipBinding && browTipHost.pair ? (
              <div className="face-rig-channel-toggle" role="group" aria-label="眉尖运动学节点通道">
                <button
                  type="button"
                  className={browTipHost.hostControlId === browTipHost.primaryId ? "active" : ""}
                  onClick={() => onSelectChannel(BROW_TIP_BIND_CHANNEL_F)}
                >
                  {browTipHost.pair.labels.primary}
                </button>
                <button
                  type="button"
                  className={browTipHost.hostControlId === browTipHost.secondaryId ? "active" : ""}
                  onClick={() => onSelectChannel(BROW_TIP_BIND_CHANNEL_D)}
                >
                  {browTipHost.pair.labels.secondary}
                </button>
              </div>
            ) : isJawBinding && jawHost.pair ? (
              <div className="face-rig-channel-toggle" role="group" aria-label="下颌运动学节点通道">
                <button
                  type="button"
                  className={jawHost.hostControlId === jawHost.primaryId ? "active" : ""}
                  onClick={() => onSelectChannel(JAW_BIND_CHANNEL_A)}
                >
                  {jawHost.pair.labels.primary}
                </button>
                <button
                  type="button"
                  className={jawHost.hostControlId === jawHost.secondaryId ? "active" : ""}
                  onClick={() => onSelectChannel(JAW_BIND_CHANNEL_D)}
                >
                  {jawHost.pair.labels.secondary}
                </button>
              </div>
            ) : hasXy ? (
              <div className="face-rig-channel-toggle" role="group" aria-label="横向与纵向通道">
                <button
                  type="button"
                  className={selectedChannel === CHANNEL_X ? "active" : ""}
                  onClick={() => onSelectChannel(CHANNEL_X)}
                >
                  横向
                </button>
                <button
                  type="button"
                  className={selectedChannel === CHANNEL_Y ? "active" : ""}
                  onClick={() => onSelectChannel(CHANNEL_Y)}
                >
                  纵向
                </button>
              </div>
            ) : (
              <span className="face-rig-binding-v mono">数值</span>
            )}
          </div>
        </div>

        {isBrowTipBinding && tipPad ? (
          <div className="face-rig-binding-secondary-meta">
            语义 pad · x={tipPad.x ?? 0} / y={tipPad.y ?? 0}
          </div>
        ) : null}
        {isJawBinding && jawPad ? (
          <div className="face-rig-binding-secondary-meta">
            语义目标 · value={jawPad.value ?? jawPad.val ?? 0} / lateral={jawPad.lateral ?? 0}
          </div>
        ) : null}

        <div className="face-rig-binding-row face-rig-binding-row--value">
          <span className="face-rig-binding-k">
            {isBrowTipBinding || isJawBinding ? "绑定节点" : "当前值"}
          </span>
          <span className="face-rig-binding-v mono face-rig-binding-v--readout">{displayVal}</span>
        </div>
      </div>

      <div className="face-rig-binding-channel-bar">
        <div className="face-rig-binding-channel-bar-meta">
          <span className="face-rig-binding-channel-bar-title">当前通道</span>
          <span className="face-rig-binding-channel-bar-count">{channelList.length} 个绑定</span>
        </div>
        <div className="face-rig-binding-channel-bar-actions">
          {channelList.length > 0 ? (
            <>
              <button type="button" className="btn-primary btn-tiny" onClick={handleAddBinding}>
                + 新增绑定
              </button>
              <div className="face-rig-binding-menu-wrap">
                <button
                  type="button"
                  className="btn-ghost btn-tiny"
                  onClick={(e) => {
                    e.stopPropagation()
                    setBatchOpen((v) => !v)
                    setOpenMenuId(null)
                  }}
                >
                  批量操作 ▾
                </button>
                {batchOpen ? (
                  <div className="face-rig-binding-menu" role="menu" onClick={(e) => e.stopPropagation()}>
                    <button type="button" role="menuitem" onClick={handleBatchPositiveForChannel}>
                      全部设为上极限
                    </button>
                    <button type="button" role="menuitem" onClick={handleBatchNegativeForChannel}>
                      全部设为下极限
                    </button>
                  </div>
                ) : null}
              </div>
            </>
          ) : null}
        </div>
      </div>

      {duplicateActuatorsInChannel.length > 0 ? (
        <p className="hint face-rig-binding-stroke-warning face-rig-binding-warn-compact">
          ⚠ 重复绑定 {duplicateActuatorsInChannel.join("、")}
        </p>
      ) : null}

      {channelList.length === 0 ? (
        <div className="face-rig-binding-empty-state">
          <p className="face-rig-binding-empty-state-text">此通道暂无绑定</p>
          <button type="button" className="btn-primary btn-tiny" onClick={handleAddBinding}>
            + 新增绑定
          </button>
        </div>
      ) : (
        <ul className="face-rig-binding-list">
          {channelList.map((b) => {
            const cfg = getServoConfig(configs, b.servoId)
            const rm = b.rangeMode || BINDING_RANGE_MODE_FULL
            const utilPct = Math.round(bindingStrokeUtilizationPercent(b))
            const contribLm = getContribLogical(b.bindingId)
            const hasContrib = Number.isFinite(contribLm)
            const logicalPwmLabel = hasContrib ? String(Math.round(contribLm)) : "—"
            const rawControl = getContribRaw(b.bindingId, b)
            const rawControlLabel = Number.isFinite(rawControl)
              ? String(Math.round(rawControl * 10) / 10)
              : "—"
            const inSetup = setupBindingIds.has(b.bindingId)
            const mappingDir = readBindingMappingDirection(b)
            const targetsCollapsed = b.positiveTargetPwm === b.negativeTargetPwm
            const utilWarn = rm === BINDING_RANGE_MODE_CUSTOM && utilPct < 50
            const servoTitle = cfg?.name || `舵机_${b.servoId}`

            return (
              <li
                key={b.bindingId}
                className={`face-rig-binding-card face-rig-binding-card--workflow${
                  inSetup ? " is-setup" : ""
                }${!b.enabled ? " is-disabled" : ""}`}
              >
                <div className="face-rig-binding-card-head face-rig-binding-card-head--workflow">
                  <label className="face-rig-binding-inline-check">
                    <input
                      type="checkbox"
                      checked={b.enabled}
                      onChange={(e) => patchBinding(b.bindingId, { enabled: e.target.checked })}
                    />
                    <span>{b.enabled ? "已启用" : "已禁用"}</span>
                  </label>
                  <span className="face-rig-binding-card-servo-name" title={servoTitle}>
                    {servoTitle}
                  </span>
                  <div className="face-rig-binding-menu-wrap">
                    <button
                      type="button"
                      className="btn-ghost btn-tiny face-rig-binding-more-btn"
                      aria-label="绑定操作"
                      onClick={(e) => {
                        e.stopPropagation()
                        setOpenMenuId((id) => (id === b.bindingId ? null : b.bindingId))
                        setBatchOpen(false)
                      }}
                    >
                      ⋯
                    </button>
                    {openMenuId === b.bindingId ? (
                      <div
                        className="face-rig-binding-menu face-rig-binding-menu--end"
                        role="menu"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <button type="button" role="menuitem" onClick={() => handleCopyBinding(b)}>
                          复制
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => handleCopyReversedBinding(b)}
                        >
                          复制为反向
                        </button>
                        <hr />
                        <button
                          type="button"
                          role="menuitem"
                          className="is-danger"
                          onClick={() => handleDeleteBinding(b.bindingId)}
                        >
                          删除绑定
                        </button>
                      </div>
                    ) : null}
                  </div>
                </div>

                {!b.enabled && b.disabledReason ? (
                  <p className="face-rig-binding-warn-compact">
                    已禁用 ·{" "}
                    {b.disabledReason === "tongue-not-configured" ? "舌头暂未配置" : b.disabledReason}
                  </p>
                ) : null}

                {targetsCollapsed ? (
                  <p className="face-rig-binding-warn-compact" title="正负目标相同，控件双向同向">
                    ⚠ 上下极限配置异常
                  </p>
                ) : null}

                {utilWarn ? (
                  <p className="face-rig-binding-warn-compact">⚠ 行程利用率 {utilPct}%</p>
                ) : (
                  <p className="face-rig-binding-range-chip">
                    {rm === BINDING_RANGE_MODE_FULL ? "全范围" : `自定义行程 · ${utilPct}%`}
                  </p>
                )}

                {inSetup ? (
                  <div className="face-rig-binding-setup-guide">
                    <div className="face-rig-binding-setup-guide-title">新绑定</div>
                    <ol>
                      <li>选择舵机号（须与舵机配置页 RJ/ST ID 一致）</li>
                      <li>开启顶部「实时预览」，拖动面部控件，对照下方实时值</li>
                      <li>按当前逻辑脉宽设置上极限 / 下极限 / 中位</li>
                    </ol>
                  </div>
                ) : null}

                <div className="face-rig-binding-map-grid">
                  <label className="face-rig-binding-field">
                    <span>舵机号</span>
                    <select
                      value={b.servoId}
                      onChange={(e) => {
                        const nextServoId = toInt(e.target.value, b.servoId)
                        patchBinding(b.bindingId, bindingTargetPatch(nextServoId))
                      }}
                    >
                      {servoSelectIds.map((i) => (
                        <option key={i} value={i}>
                          {availableBusServoIdSet.has(i) ? `${i} · 已配置` : String(i)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="face-rig-binding-field">
                    <span>方向</span>
                    <select
                      value={mappingDir}
                      onChange={(e) =>
                        handleDirectionChange(
                          b,
                          e.target.value === BINDING_DIR_REVERSE
                            ? BINDING_DIR_REVERSE
                            : BINDING_DIR_FORWARD
                        )
                      }
                      aria-label="绑定映射方向"
                    >
                      <option value={BINDING_DIR_FORWARD}>
                        {bindingMappingDirectionLabel(BINDING_DIR_FORWARD)}
                      </option>
                      <option value={BINDING_DIR_REVERSE}>
                        {bindingMappingDirectionLabel(BINDING_DIR_REVERSE)}
                      </option>
                    </select>
                  </label>
                </div>

                <div className="face-rig-binding-contrib-row face-rig-binding-contrib-row--hero">
                  <span className="face-rig-binding-k">控件实时值</span>
                  <span
                    className="face-rig-binding-v mono face-rig-binding-v--readout"
                    title={`${b.controlId}.${b.channel}`}
                  >
                    {rawControlLabel}
                  </span>
                </div>
                <div className="face-rig-binding-contrib-row">
                  <span className="face-rig-binding-k">本条逻辑脉宽</span>
                  <span className="face-rig-binding-v mono face-rig-binding-v--readout">
                    {logicalPwmLabel}
                  </span>
                </div>

                <div className="face-rig-binding-travel">
                  <div
                    className="face-rig-binding-travel-status"
                    role="status"
                    title={
                      inspectorHint && inspectorHintBindingId === b.bindingId
                        ? inspectorHint
                        : undefined
                    }
                  >
                    {inspectorHint && inspectorHintBindingId === b.bindingId
                      ? inspectorHint
                      : "\u00a0"}
                  </div>
                  <div className="face-rig-binding-travel-head">
                    <div className="face-rig-binding-travel-title">行程标定</div>
                    <button
                      type="button"
                      className="btn-ghost btn-tiny face-rig-binding-restore-full"
                      onClick={() => handleRestoreFullStroke(b.bindingId)}
                      title="相对中性恢复逻辑满行程端点（保留朝向）"
                    >
                      恢复全范围
                    </button>
                  </div>
                  <div className="face-rig-binding-travel-row">
                    <span className="face-rig-binding-travel-label">上极限</span>
                    <span className="face-rig-binding-travel-value mono">
                      {fmtPwm(readUpperLimitPwm(b))}
                    </span>
                    <button
                      type="button"
                      className="btn-secondary btn-tiny"
                      disabled={!hasContrib}
                      title={
                        hasContrib
                          ? "将当前逻辑脉宽写入 positiveTargetPwm（控件 +100）"
                          : "无 contribution：请先启用本条绑定并拖动控件"
                      }
                      onClick={() => applyPositiveFromContribution(b.bindingId)}
                    >
                      {setUpperLimitLabel(inSetup)}
                    </button>
                  </div>
                  <div className="face-rig-binding-travel-row">
                    <span className="face-rig-binding-travel-label">中位</span>
                    <span className="face-rig-binding-travel-value mono">{fmtPwm(b.neutralPwm)}</span>
                    <button
                      type="button"
                      className="btn-secondary btn-tiny"
                      disabled={!hasContrib && !onCaptureBindingNeutral}
                      title={
                        hasContrib || onCaptureBindingNeutral
                          ? undefined
                          : "无 contribution：请先启用本条绑定并拖动控件"
                      }
                      onClick={() => applyNeutralFromContribution(b.bindingId)}
                    >
                      {setNeutralLabel(inSetup)}
                    </button>
                  </div>
                  <div className="face-rig-binding-travel-row">
                    <span className="face-rig-binding-travel-label">下极限</span>
                    <span className="face-rig-binding-travel-value mono">
                      {fmtPwm(readLowerLimitPwm(b))}
                    </span>
                    <button
                      type="button"
                      className="btn-secondary btn-tiny"
                      disabled={!hasContrib}
                      title={
                        hasContrib
                          ? "将当前逻辑脉宽写入 negativeTargetPwm（控件 −100）"
                          : "无 contribution：请先启用本条绑定并拖动控件"
                      }
                      onClick={() => applyNegativeFromContribution(b.bindingId)}
                    >
                      {setLowerLimitLabel(inSetup)}
                    </button>
                  </div>
                </div>

                {inSetup ? (
                  <button
                    type="button"
                    className="btn-primary btn-tiny face-rig-binding-finish-setup"
                    onClick={() => clearSetup(b.bindingId)}
                  >
                    完成绑定设置
                  </button>
                ) : (
                  <div className="face-rig-binding-servo-overview">
                    <div className="face-rig-binding-servo-overview-title">舵机概览</div>
                    <div className="face-rig-binding-servo-overview-line">
                      {servoTitle} · {cfg.enabled !== false ? "已启用" : "已禁用"}
                    </div>
                    <div className="face-rig-binding-servo-overview-line muted">
                      范围 {cfg.actualMinPwm}–{cfg.actualMaxPwm} · 机械零位 {cfg.mechanicalZeroPwm}
                    </div>
                  </div>
                )}

                <details className="face-rig-binding-more">
                  <summary>更多设置</summary>
                  <div className="face-rig-binding-more-body">
                    <div className="face-rig-binding-map-grid">
                      <label className="face-rig-binding-field">
                        <span>权重</span>
                        <input
                          type="number"
                          step="0.05"
                          min="0"
                          max="4"
                          value={b.weight}
                          onChange={(e) =>
                            patchBinding(b.bindingId, {
                              weight: clampNumber(Number(e.target.value), 0, 4),
                            })
                          }
                        />
                      </label>
                      <label className="face-rig-binding-field">
                        <span>曲线</span>
                        <select
                          value={b.curve}
                          onChange={(e) => patchBinding(b.bindingId, { curve: e.target.value })}
                        >
                          <option value={CURVE_LINEAR}>线性</option>
                          <option value={CURVE_SMOOTHSTEP}>平滑阶跃</option>
                        </select>
                      </label>
                    </div>

                    <div className="face-rig-binding-advanced-meta">
                      <div className="face-rig-binding-advanced-row">
                        <span>actuatorKey</span>
                        <code title={b.actuatorKey ?? `servo_${b.servoId}`}>
                          {b.actuatorKey ?? `servo_${b.servoId}`}
                        </code>
                      </div>
                      <div className="face-rig-binding-advanced-row">
                        <span>bindingId</span>
                        <button
                          type="button"
                          className="face-rig-binding-id-copy"
                          title={b.bindingId}
                          onClick={() => copyText(b.bindingId, b.bindingId)}
                        >
                          <code>{b.bindingId}</code>
                        </button>
                      </div>
                      {b.migratedFromNeutralPwm != null ? (
                        <div className="face-rig-binding-advanced-row">
                          <span>迁移</span>
                          <span>neutral {b.migratedFromNeutralPwm} → 1500</span>
                        </div>
                      ) : null}
                      {targetsCollapsed ? (
                        <p className="hint">
                          上下极限相同（{b.positiveTargetPwm}）：控件双向同向。请改方向或分别设定上/下极限。
                        </p>
                      ) : null}
                      {utilWarn ? (
                        <p className="hint">
                          当前绑定只使用部分逻辑行程；可继续单独标定，或使用「恢复全范围」。
                        </p>
                      ) : null}
                    </div>

                    {!inSetup ? (
                      <div className="face-rig-binding-servo-detail">
                        <div className="face-rig-binding-servo-title">舵机详情</div>
                        <div className="face-rig-binding-servo-grid">
                          <span>名称</span>
                          <span>{cfg.name}</span>
                          <span>启用</span>
                          <span>{cfg.enabled !== false ? "是" : "否"}</span>
                          <span>物理下限</span>
                          <span>{cfg.actualMinPwm}</span>
                          <span>物理上限</span>
                          <span>{cfg.actualMaxPwm}</span>
                          <span>机械零位</span>
                          <span>{cfg.mechanicalZeroPwm}</span>
                        </div>
                      </div>
                    ) : null}

                    <div className="face-rig-binding-map-grid face-rig-binding-manual-targets">
                      <label className="face-rig-binding-field">
                        <span>中性脉宽</span>
                        <input
                          type="number"
                          value={b.neutralPwm}
                          onChange={(e) =>
                            patchBinding(b.bindingId, { neutralPwm: toInt(e.target.value, 1500) })
                          }
                        />
                      </label>
                      <label className="face-rig-binding-field">
                        <span>上极限（+）</span>
                        <input
                          type="number"
                          value={b.positiveTargetPwm}
                          onChange={(e) =>
                            patchBinding(b.bindingId, {
                              positiveTargetPwm: toInt(e.target.value, 2500),
                            })
                          }
                        />
                      </label>
                      <label className="face-rig-binding-field">
                        <span>下极限（−）</span>
                        <input
                          type="number"
                          value={b.negativeTargetPwm}
                          onChange={(e) =>
                            patchBinding(b.bindingId, {
                              negativeTargetPwm: toInt(e.target.value, 500),
                            })
                          }
                        />
                      </label>
                    </div>
                  </div>
                </details>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
