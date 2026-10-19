# Mouth FiveBar V1 冻结说明

## 冻结范围（已纳入 V1）

- FiveBar FK / IK（`fiveBar2d.js`、`mouthCornerFivebar.js`）
- Pad → D_raw / D_safe → IK
- Right Mouth FiveBar runtime（`getRightMouthFiveBarRuntime`、baseline、正式链路）
- Left Mouth FiveBar **软件链路**（`getLeftMouthFiveBarRuntime`、`mapFaceRigToPose` 左右覆盖）
- Kinematics Lab 右嘴角调试流程（Pad → IK → PWM → WebSerial）
- Kinematics Lab 左嘴角**软件**调试流程（参数、baseline、calibration）
- 正式链路 `mapFaceRigToPose` 右/左 `applyFaceRigKinematicsOverrides`
- MediaPipe `mouth.sideR` / `mouth.sideL` 语义输入
- WebSerial 舵机命令协议
- 校准机制：qSign / qGain / xSign / ySign / servoSwap、runtime baseline 存取

## 暂不纳入 V1 冻结

- Mouth Lab Recorder（暂停，非验收项）
- 更自然的运动 smoothing / 视频级插值
- **左嘴角硬件最终验收**（servo16 损坏，见下）
- Video Face Driver / Motion Track Editor
- 自动表情生成

## 已知限制

1. **旧关键帧无 `rigSnapshot`**：仅含 `positions` 的关键帧无法可靠重算 Mouth FiveBar，播放时会有提示。
2. **左嘴角硬件验证 blocked by servo16**：左嘴角软件链路与 Lab 参数配置保留，**不作为**左嘴角实机验收结论。
3. 当前优先响应与可控性；自然运动 smoothing 后续阶段再做。
4. Recorder 当前暂停，不作为嘴角 V1 验收项。

## 页面职责（V1）

| 页面 | 职责 |
|------|------|
| 表情编排 | 创作、关键帧、播放、实时预览；Tracking 极简入口 |
| 映射预览 | MediaPipe → Face Rig 映射观察 |
| 机构调试 | FiveBar、舵机、串口、baseline、Force Send、Direct Servo |

机构调试能力**不得**常驻堆在表情编排页。

## 下一阶段建议

**Camera / Video Face Driver**

- Camera Realtime Driver 固化
- Video MediaPipe Source
- Motion Track 导出 / 回放
- 从视频生成关键帧
