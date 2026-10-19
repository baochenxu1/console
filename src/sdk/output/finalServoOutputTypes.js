/** @typedef {'tracking' | 'action-frame' | 'manual' | 'motion-track' | 'center'} FinalServoSourceType */

/**
 * @typedef {object} FinalServoOutput
 * @property {string} actuatorKey
 * @property {number} [legacyServoIndex]
 * @property {number} logicalValue 0~1000
 * @property {number} [pwmValue] 500~2500
 * @property {string} [sourceChannel]
 * @property {string} [bindingId]
 * @property {FinalServoSourceType} [sourceType]
 * @property {boolean} [enabled]
 * @property {Record<string, unknown>} [debug]
 */

export const LOGICAL_MIN = 0
export const LOGICAL_MAX = 1000
export const LOGICAL_CENTER = 500

export const PWM_MIN = 500
export const PWM_MAX = 2500
export const PWM_CENTER = 1500
