/**
 * 运行：node src/sdk/servoAdapters/busServo/evaluateBusCommandsPortGate.test.mjs
 */
import assert from "node:assert/strict"
import { evaluateBusCommandsPortGate } from "./resolveBusTransport.js"
import { rjSbusTransport } from "../rjsbus/rjSbusWebSerialTransport.js"
import { scServoTransport } from "../scservo/scServoWebSerialTransport.js"

function withPorts({ rj = false, sc = false }, fn) {
  const rjGet = rjSbusTransport.getStatus
  const scGet = scServoTransport.getStatus
  rjSbusTransport.getStatus = () => ({ connected: rj, supported: true })
  scServoTransport.getStatus = () => ({ connected: sc, supported: true })
  try {
    return fn()
  } finally {
    rjSbusTransport.getStatus = rjGet
    scServoTransport.getStatus = scGet
  }
}

function run() {
  /* 共总线：只开 RJ 口，RJ + ST 命令全部保留（同一 UART 切换报文） */
  withPorts({ rj: true, sc: false }, () => {
    const gate = evaluateBusCommandsPortGate(
      [
        { protocol: "sms_sts", profile: { protocol: "sms_sts" }, busServoId: 1 },
        { protocol: "rj_sbus", profile: { protocol: "rj_sbus" }, busServoId: 2 },
      ],
      { activeFamily: "rj_sbus" }
    )
    assert.equal(gate.ok, true)
    assert.equal(gate.kept.length, 2)
    assert.equal(gate.skipped.length, 0)
  })

  /* 未开任何口 */
  withPorts({ rj: false, sc: false }, () => {
    const gate = evaluateBusCommandsPortGate(
      [{ protocol: "rj_sbus", profile: { protocol: "rj_sbus" } }],
      { activeFamily: "rj_sbus" }
    )
    assert.equal(gate.ok, false)
    assert.match(gate.reason, /RJ 串口未连接/)
  })

  /* 只开飞特口、主用 RJ：仍视为共线已通 */
  withPorts({ rj: false, sc: true }, () => {
    const gate = evaluateBusCommandsPortGate(
      [
        { protocol: "sms_sts", profile: { protocol: "sms_sts" }, busServoId: 1 },
        { protocol: "rj_sbus", profile: { protocol: "rj_sbus" }, busServoId: 2 },
      ],
      { activeFamily: "rj_sbus" }
    )
    assert.equal(gate.ok, true)
    assert.equal(gate.kept.length, 2)
  })

  console.log("evaluateBusCommandsPortGate tests ok")
}

run()
