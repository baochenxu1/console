/**
 * RJ_SBUS 协议组包自测：对照手册通信帧示例校验字节与校验和。
 * 运行：node src/sdk/servoAdapters/rjsbus/rjSbusPacket.test.mjs
 */

import {
  buildPing,
  buildMoveOnAngleMode,
  buildMoveOnAngleModeExByInterval,
  parseResponsePacket,
  computeChecksum,
  toHex,
} from "./rjSbusPacket.js"
import { degreesToAngleTicks, parseReadAngleContent, parseIdRetContent } from "./rjSbusCodec.js"

function assertHex(actualBytes, expectedHex, label) {
  const actual = toHex(actualBytes)
  const expected = expectedHex
    .trim()
    .replace(/0x/gi, "")
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((s) => s.padStart(2, "0").toUpperCase())
    .join(" ")
  if (actual !== expected) {
    throw new Error(`${label}\n  expected: ${expected}\n  actual:   ${actual}`)
  }
}

function assertEq(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`)
  }
}

// 示例 1：PING ID=3
assertHex(buildPing(3), "12 4C 01 01 03 63", "PING id=3")

// 示例 1 响应
{
  const rx = Uint8Array.from([0x05, 0x1c, 0x01, 0x01, 0x03, 0x26])
  const parsed = parseResponsePacket(rx, { expectedId: 3, expectedCmd: 1 })
  assertEq(parsed.ok, true, "PING response ok")
  assertEq(parsed.id, 3, "PING response id")
  assertEq(computeChecksum(rx.slice(0, 5)), 0x26, "PING response checksum")
}

// 示例 2：ID=2 → 90°（time=0 power=0）
assertEq(degreesToAngleTicks(90), 900, "90deg → 900 ticks")
assertHex(
  buildMoveOnAngleMode(2, { angleTicks: 900, timeMs: 0, power: 0 }),
  "12 4C 08 07 02 84 03 00 00 00 00 F6",
  "MOVE_ON_ANGLE_MODE 90deg"
)

// 示例 2 响应
{
  const rx = Uint8Array.from([0x05, 0x1c, 0x08, 0x02, 0x02, 0x01, 0x2e])
  const parsed = parseResponsePacket(rx, { expectedId: 2, expectedCmd: 8 })
  assertEq(parsed.ok, true, "angle response ok")
  const ret = parseIdRetContent(parsed.content)
  assertEq(ret.ok, true, "angle ret ok")
}

// 手册：ID=2，500ms 到 90°
assertHex(
  buildMoveOnAngleMode(2, { angleTicks: 900, timeMs: 500, power: 0 }),
  "12 4C 08 07 02 84 03 F4 01 00 00 EB",
  "MOVE_ON_ANGLE_MODE 90deg/500ms"
)

// 手册 cmd11：ID=0，600ms 到 90°，acc/dec=100ms
assertHex(
  buildMoveOnAngleModeExByInterval(0, {
    angleTicks: 900,
    intervalMs: 600,
    accIntervalMs: 100,
    decIntervalMs: 100,
    power: 0,
  }),
  "12 4C 0B 0B 00 84 03 58 02 64 00 64 00 00 00 1D",
  "MOVE_ON_ANGLE_MODE_EX_BY_INTERVAL"
)

// READ_ANGLE 响应解析：假设角度 90.0°
{
  // content: id=0, ticks=900 → 84 03
  const content = [0x00, 0x84, 0x03]
  const parsed = parseReadAngleContent(content)
  assertEq(parsed.angleTicks, 900, "read angle ticks")
  assertEq(parsed.degrees, 90, "read angle degrees")
}

console.log("rjSbusPacket.test.mjs: all passed")
