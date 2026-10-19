/**
 * 同一 busServoId / actuatorKey 下多条 profile 的择优。
 * 典型坑：同一 ID 同时残留 scscl + sms_sts / rj_sbus，旧逻辑只比「标定时间 / 距理论中位」
 * 会误选 ST（中位~2028 / 上限~3072），把真实 SC/RJ 舵机打到大行程。
 */

import { PROTOCOL } from "../servoAdapters/core/servoTypes.js"

function modelPositionMax(profile) {
  const max = Number(profile?.positionMax)
  if (Number.isFinite(max) && max > 0) return max
  if (profile?.protocol === "sms_sts" || String(profile?.servoModel || "").includes("4096")) {
    return 4095
  }
  if (profile?.protocol === "rj_sbus") {
    return 1500
  }
  return 1023
}

function theoreticalCenter(profile) {
  if (profile?.protocol === "sms_sts" || String(profile?.servoModel || "").includes("4096")) {
    return 2048
  }
  if (profile?.protocol === "rj_sbus") {
    return 0
  }
  return 512
}

function isInstalledCenterValid(profile) {
  return (
    profile?.centerMode === "installed_center" &&
    (profile.installedCenterValid === true ||
      Number.isFinite(Number(profile.installedCenterPosition)))
  )
}

/**
 * UI 总线族 → 择优 preferredProtocol。
 * @param {'feetech'|'rj_sbus'|string|null|undefined} family
 * @returns {string|null}
 */
export function preferredProtocolFromBusTransportFamily(family) {
  const f = String(family || "")
  if (f === "rj_sbus" || f === PROTOCOL.RJ_SBUS || f === "RJ" || f === "RJ_SBUS") {
    return PROTOCOL.RJ_SBUS
  }
  /* feetech：不指定 scscl/sms_sts，交给 majority / 评分 */
  return null
}

/**
 * 在整表 profile 中统计主导协议（用于跨协议冲突时打破平局）。
 * @param {object[]} profiles
 * @returns {string | null}
 */
export function majorityActuatorProtocol(profiles) {
  const counts = new Map()
  for (const p of profiles || []) {
    if (!p || p.enabled === false) continue
    const proto = String(p.protocol || "")
    if (!proto) continue
    counts.set(proto, (counts.get(proto) || 0) + 1)
  }
  let best = null
  let bestN = 0
  for (const [proto, n] of counts) {
    if (n > bestN) {
      best = proto
      bestN = n
    }
  }
  return best
}

/**
 * @param {object} profile
 * @param {{ protocolConflict?: boolean, preferredProtocol?: string | null }} [opts]
 */
export function profilePickScore(profile, opts = {}) {
  const protocolConflict = Boolean(opts.protocolConflict)
  const preferredProtocol = opts.preferredProtocol ? String(opts.preferredProtocol) : null
  let score = 0

  if (isInstalledCenterValid(profile)) {
    score += 1_000_000
  }

  const ic = Number(profile?.installedCenterPosition)
  const max = modelPositionMax(profile)
  if (Number.isFinite(ic)) {
    if (ic >= 0 && ic <= max) {
      score += 100_000
    } else if (profile?.protocol === "rj_sbus" && ic >= -max && ic <= max) {
      /* RJ 中位可为 0 / 负 ticks */
      score += 100_000
    } else {
      /* 量程外中位（如 SC profile 上写了 ST 的 ~2000）强烈降权 */
      score -= 2_000_000
    }
  }

  if (protocolConflict) {
    /*
     * 跨协议冲突：不能只比「距本型号理论中位」，否则 ST@2028 与 SC@424
     * 都「合理」，而 ST 往往更贴 2048 反被选中 → SC/RJ 真机收到 ~3072 大甩。
     * 优先总线主导协议（整机多为 scscl 时选 SC；UI 主用 RJ 时选 RJ）。
     */
    if (preferredProtocol && String(profile.protocol || "") === preferredProtocol) {
      score += 500_000
    }
    if (Number.isFinite(ic)) {
      const theory = theoreticalCenter(profile)
      const dist = Math.abs(ic - theory)
      score += Math.max(0, 80_000 - dist)
    }
    if (profile.installedCenterCapturedAt) {
      const t = Date.parse(profile.installedCenterCapturedAt)
      if (Number.isFinite(t)) {
        score += (t % 10_000) / 10_000
      }
    }
    return score
  }

  if (profile.installedCenterCapturedAt) {
    const t = Date.parse(profile.installedCenterCapturedAt)
    if (Number.isFinite(t)) {
      score += t
    }
  }
  return score
}

/**
 * 在候选列表中选出最优 profile；若存在跨协议冲突则启用主导协议 + 一致性择优。
 * 硬约束：有 preferredProtocol 且候选里存在该协议时，只在该协议内择优
 * （避免 ST installed_center 以 +1e6 分压过 RJ，把绑定上限打成 ~3072）。
 * @param {object[]} candidates
 * @param {{ preferredProtocol?: string | null }} [opts]
 */
export function pickBestActuatorProfile(candidates, opts = {}) {
  const list = (candidates || []).filter(Boolean)
  if (list.length === 0) return null
  if (list.length === 1) return list[0]

  const protocols = new Set(list.map((p) => String(p.protocol || "")))
  const protocolConflict = protocols.size > 1
  const preferredProtocol =
    opts.preferredProtocol ?? (protocolConflict ? majorityActuatorProtocol(list) : null)

  let pool = list
  if (protocolConflict && preferredProtocol) {
    const matched = list.filter((p) => String(p.protocol || "") === String(preferredProtocol))
    if (matched.length > 0) {
      pool = matched
    }
  }

  const stillConflict = new Set(pool.map((p) => String(p.protocol || ""))).size > 1

  return [...pool].sort(
    (a, b) =>
      profilePickScore(b, {
        protocolConflict: stillConflict,
        preferredProtocol,
      }) -
      profilePickScore(a, {
        protocolConflict: stillConflict,
        preferredProtocol,
      })
  )[0]
}
