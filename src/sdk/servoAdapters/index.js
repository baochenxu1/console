/**
 * Servo Adapter 层统一出口。
 *
 * SC / ST / RJ_SBUS 总线协议；PWM 文本协议已移除。
 */

export * from "./core/servoTypes.js"
export * from "./core/servoProfile.js"
export { ServoAdapter, clampInt, isValidServoId, validateWriteRequest } from "./core/servoAdapter.js"

export * from "./scservo/scProtocolConstants.js"
export * as scPacket from "./scservo/scPacket.js"
export * from "./scservo/scServoCodec.js"
export { ScServoWebSerialTransport, scServoTransport } from "./scservo/scServoWebSerialTransport.js"
export { ScsclAdapter } from "./scservo/scsclAdapter.js"
export { SmsStsAdapter } from "./scservo/smsStsAdapter.js"

export {
  CMD as RJ_SBUS_CMD,
  DATA_ID as RJ_SBUS_DATA_ID,
  DATA_ID_SIZE as RJ_SBUS_DATA_ID_SIZE,
  REQUEST_HEADER_0 as RJ_SBUS_REQUEST_HEADER_0,
  REQUEST_HEADER_1 as RJ_SBUS_REQUEST_HEADER_1,
  RESPONSE_HEADER_0 as RJ_SBUS_RESPONSE_HEADER_0,
  RESPONSE_HEADER_1 as RJ_SBUS_RESPONSE_HEADER_1,
  BROADCAST_ID as RJ_SBUS_BROADCAST_ID,
  MAX_ID as RJ_SBUS_MAX_ID,
  DEFAULT_RJ_BAUDRATE,
  DEFAULT_RJ_EEPROM_BAUDRATE,
  COMMON_RJ_BAUDRATES,
  ANGLE_TICK_MIN as RJ_ANGLE_TICK_MIN,
  ANGLE_TICK_CENTER as RJ_ANGLE_TICK_CENTER,
  ANGLE_TICK_MAX as RJ_ANGLE_TICK_MAX,
  ANGLE_DEG_MIN as RJ_ANGLE_DEG_MIN,
  ANGLE_DEG_CENTER as RJ_ANGLE_DEG_CENTER,
  ANGLE_DEG_MAX as RJ_ANGLE_DEG_MAX,
  BATCH_A_DATA_BYTES,
  BATCH_B_DATA_BYTES,
  BAUD_OPTION as RJ_BAUD_OPTION,
  baudBpsFromOptionCode as rjBaudBpsFromOptionCode,
  baudOptionCodeFromInput as rjBaudOptionCodeFromInput,
  RESTART_KEY as RJ_RESTART_KEY,
  CLEAR_PROTECT_KEY as RJ_CLEAR_PROTECT_KEY,
} from "./rjsbus/rjSbusConstants.js"
export * as rjSbusPacket from "./rjsbus/rjSbusPacket.js"
export * as rjSbusCodec from "./rjsbus/rjSbusCodec.js"
export { RjSbusWebSerialTransport, rjSbusTransport } from "./rjsbus/rjSbusWebSerialTransport.js"
export { RjSbusAdapter, isValidRjServoId } from "./rjsbus/rjSbusAdapter.js"

export { FACE_BUS_SERVO_ROUTE, listEnabledRouteLogicalIndices } from "./busServo/faceBusServoRoute.js"
export { resolveBusServoProfile } from "./busServo/resolveBusServoProfile.js"
export { pwmLogicalToBusLogical } from "./busServo/pwmLogicalToBusLogical.js"
export { normalizeToBusLogicalValue } from "./busServo/normalizeToBusLogicalValue.js"
export {
  normalizeBusProtocol,
  busTransportFamilyForProtocol,
  resolveBusTransport,
  resolveBusTransportByFamily,
  resolveBusBaudConfig,
  busProtocolLabel,
} from "./busServo/resolveBusTransport.js"
/** @deprecated 请使用 output/buildFinalServoOutputsFromBindings */
export { buildFinalServoOutputs } from "./busServo/buildFinalServoOutputs.js"
export {
  buildFinalServoOutputsFromBindings,
  buildCenterFinalServoOutputs,
  listActuatorKeysFromBindings,
  loadActuatorProfiles,
  resolveActuatorProfile,
} from "../output/index.js"
export {
  buildBusCommandsFromFinalOutputs,
  sendBusServoOutputs,
  buildBusOutputDebug,
} from "../output/adapters/busServoOutputAdapter.js"
export {
  sendLegacyLogicalPwmViaBus,
  sendAllBusProfilesToCenter,
} from "../output/adapters/legacyLogicalBusSend.js"
export { buildBusCommandSendKey } from "./busServo/buildBusCommandSendKey.js"
export { runBusServoProbeId1 } from "./busServo/busServoProbe.js"
export { runBusDirectTestFrame } from "./busServo/busDirectTestFrame.js"
export { bytesToHex } from "./busServo/busServoTxUtil.js"
export {
  buildBusServoCommands,
  buildBusServoNeutralCommands,
  buildBusServoOutputDebug,
  formatBusCommandsPreview,
} from "./busServo/buildBusServoCommands.js"
export {
  runScSingleWriteBaselineTest,
  runScSyncBroadcastTest,
  runScSyncInst83Test,
  SC_SYNC_TEST_OFFSET_TICKS,
  SC_SYNC_INST_OFFSET_TICKS,
  SC_SYNC_INST_HOLD_MS,
  SC_SYNC_INST_DEFAULT_SPEED,
} from "./scservo/scSyncProtocolTest.js"
export { loadBusServoProfiles } from "./busServo/loadBusServoProfiles.js"

export {
  loadScServoLabProject,
  saveScServoLabProject,
  loadServoConfigDocument,
  saveServoConfigDocument,
  createDefaultServoConfigDocument,
  normalizeServoConfigDocument,
  collapseProfilesToOnePerBusId,
  updateServoConfigDocumentName,
  importAndActivateServoConfigDocument,
  resetServoConfigDocumentToDefault,
  getLabProfile,
  setLabProfile,
  clearLabProfile,
  migrateLabProfileOnIdChange,
  makeProfileKey,
  buildLabExportPayload,
  buildServoConfigExportFilename,
  parseLabImportPayload,
  SC_SERVO_LAB_STORAGE_KEY,
  SERVO_CONFIG_DOCUMENT_STORAGE_KEY,
  SERVO_CONFIG_DOCUMENT_VERSION,
  SERVO_CONFIG_DOCUMENT_TYPE,
  BUS_SERVO_PROFILES_CHANGED_EVENT,
} from "./scservo/scServoLabStore.js"
export {
  writePositionWithProfile,
  writeSignedCommandWithProfile,
  writeLogicalValueWithProfile,
  returnNeutralWithProfile,
  buildWriteOptionsFromProfile,
} from "./scservo/scServoLabMotion.js"
export {
  RANGE_MODE,
  normalizeLabServoProfile,
  createDefaultLabServoProfile,
  applyCurrentPositionAsNeutral,
  applyJogPositionAsCenterOffset,
  applyInstalledCenterFromPosition,
  resetToStandardWindow,
  clearProfileNeutral,
  computeCenterOffsetLimits,
  CENTER_MODE,
  INSTALLED_CENTER_BOUNDARY_WARNING,
  isInstalledCenterMode,
  isInstalledCenterInModelRange,
  getEffectiveSafeWindow,
  computeServoTarget,
  computeServoTargetFromLogical,
  computeServoTargetFromSigned,
  computeLogicalTargetRaw,
  LOGICAL_MIN,
  LOGICAL_MAX,
  LOGICAL_CENTER,
  computeDirectionTargets,
  clampTargetForProfile,
  clampToMechanicalSafeWindow,
  prepareServoWrite,
  isProfileCalibrated,
  hasConfiguredNeutral,
  getTheoreticalCenter,
  validateServoProfile,
  computeMechanicalSafeWindow,
  enrichProfileWithSafety,
  checkReadPositionForModel,
  resolveModelFields,
  getTheoreticalCenterFromProfile,
  SERVO_MODEL,
  SERVO_MODEL_SPECS,
  MECHANICAL_MAX_TRAVEL_DEG,
} from "./core/servoProfile.js"

import { PROTOCOL } from "./core/servoTypes.js"
import { ScsclAdapter } from "./scservo/scsclAdapter.js"
import { SmsStsAdapter } from "./scservo/smsStsAdapter.js"
import { RjSbusAdapter } from "./rjsbus/rjSbusAdapter.js"

/**
 * 按协议创建适配器。
 * @param {string} protocol "scscl" | "sms_sts" | "rj_sbus"
 * @param {{ transport?: object }} [deps]
 */
export function createServoAdapter(protocol, { transport } = {}) {
  switch (protocol) {
    case PROTOCOL.SCSCL:
      return new ScsclAdapter({ transport })
    case PROTOCOL.SMS_STS:
      return new SmsStsAdapter({ transport })
    case PROTOCOL.RJ_SBUS:
      return new RjSbusAdapter({ transport })
    default:
      throw new Error(`未知协议：${protocol}（PWM 文本协议已移除）`)
  }
}
