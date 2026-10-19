import { PROTOCOL } from "../core/servoTypes.js"

/** 对齐官方 scscl/sync_write.py：time=0, speed=2400 */
export const OFFICIAL_SC_SYNC_WRITE_SPEED = 2400

/** 对齐官方 sms_sts/sync_write.py */
export const OFFICIAL_ST_SYNC_WRITE_SPEED = 2400
export const OFFICIAL_ST_SYNC_WRITE_ACC = 50

/**
 * SC SyncWrite 运动参数：profile 未配置 speed/time 时使用官方例程默认值。
 */
export function resolveScSyncWriteMotion({ time = 0, speed = 0 } = {}) {
  const t = Math.max(0, Math.round(Number(time) || 0))
  const s = Math.max(0, Math.round(Number(speed) || 0))
  if (s === 0 && t === 0) {
    return { time: 0, speed: OFFICIAL_SC_SYNC_WRITE_SPEED, usedDefault: true }
  }
  return { time: t, speed: s, usedDefault: false }
}

/**
 * ST SyncWrite 运动参数：speed/acc 均为 0 时使用官方例程默认值。
 */
export function resolveStSyncWriteMotion({ speed = 0, acc = 0 } = {}) {
  const s = Math.max(0, Math.round(Number(speed) || 0))
  const a = Math.max(0, Math.round(Number(acc) || 0))
  if (s === 0 && a === 0) {
    return {
      speed: OFFICIAL_ST_SYNC_WRITE_SPEED,
      acc: OFFICIAL_ST_SYNC_WRITE_ACC,
      usedDefault: true,
    }
  }
  return { speed: s, acc: a, usedDefault: false }
}

export function resolveBusSyncWriteMotion(profile, protocol, cmd = {}) {
  const p = profile || {}
  const proto = protocol === PROTOCOL.SMS_STS ? PROTOCOL.SMS_STS : PROTOCOL.SCSCL
  if (proto === PROTOCOL.SMS_STS) {
    return {
      protocol: proto,
      ...resolveStSyncWriteMotion({
        speed: cmd.speed ?? p.speed ?? 0,
        acc: cmd.acc ?? p.acc ?? 0,
      }),
    }
  }
  return {
    protocol: proto,
    ...resolveScSyncWriteMotion({
      time: cmd.time ?? p.time ?? 0,
      speed: cmd.speed ?? p.speed ?? 0,
    }),
  }
}
