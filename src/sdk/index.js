/**
 * `@/sdk` 聚合入口：合并 `core` / `protocol` / `react` 扁平导出，`binding` 与 `expression` 命名空间、`createExpressionEngine` 经 `expression` 与 `core` 指向同一实现。
 *
 * --- BindingEngine ---
 * ```
 * import { createFaceRigBindingEngine } from '@/sdk'
 * const engine = createFaceRigBindingEngine({ configs: servoConfigs })
 * engine.setRigState(nextRig)
 * engine.evaluate()
 * const logicalPose = engine.getLogicalPose()
 * ```
 *
 * --- ExpressionEngine ---
 * ```
 * import { createExpressionEngine } from '@/sdk'
 * const ex = createExpressionEngine({ project, configs })
 * ex.setAmbientPose(currentPoseBaseline)
 * ex.savePoseAsNewKeyframe({ name: '新帧', durationMs: 500, pose })
 * ex.updateSelectedKeyframeWithPose(pose)
 * await ex.playAll({ sendCommand: async (cmd) => { … } })
 * ```
 *
 * --- React ---
 * ```
 * import { FaceBindingEditor, FaceExpressionEditor } from '@/sdk'
 * ```
 *
 * @see {@link ./README.md}
 */

export * from "./core/index.js"
export * from "./output/index.js"
export * from "./binding/index.js"
export * from "./expression/index.js"
export * from "./protocol/index.js"
export * from "./tracking/index.js"
export * from "./react/index.js"
