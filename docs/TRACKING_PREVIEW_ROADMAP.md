# Tracking Preview 路线图（Phase 4）

## 页面定位

**Tracking Preview**（原「映射预览」）是 Camera / Video 面部驱动的核心入口，不是单纯 MediaPipe Debug 页。

负责：

- 摄像头实时面部追踪预览（Camera Preview）
- 视频文件面部追踪预览（Video Preview）
- Face Rig 控件映射预览
- 可选生成舵机命令（Dry Run，不下发）
- 可选驱动真实设备（Device Drive，显式开启）
- Motion Track 导出 / 回放 / 后续转关键帧

不负责：

- 单舵机调试、FiveBar 标定、baseline、Direct Servo、Force Send → **Kinematics Lab**
- 关键帧表情工程 → **表情编排页**

---

## 输入源（冻结）

普通用户流程仅两种输入：

1. **Camera** — UI 显示为 Camera Source（底层可为 WebSocket `camera-mediapipe`）
2. **Video** — UI 显示为 Video Source（底层 `video-mediapipe`，Phase 4.2 由 Python 服务处理）

**移除 / 隐藏**常规入口：Mock、手动 WebSocket Source 选择。

WebSocket 仍可作为通信机制；Developer Debug 下可显示 WS URL。

---

## 三个主 Tab

| Tab | 用途 | Phase |
|-----|------|-------|
| Camera Preview | 摄像头 → Python MediaPipe → `tracking.rigFrame` → Face Rig | 4.0 骨架 / 4.1 固化 |
| Video Preview | 视频 → 同上 + 播放/seek + Export Motion Track | 4.2 |
| Motion Track | 导入/导出/回放 rigFrame 序列 | 4.3 |

---

## Drive Mode（冻结）

| 模式 | 行为 | 默认 |
|------|------|------|
| **Preview Only** | 仅更新 Face Rig Preview；不写 WebSerial | **是** |
| **Dry Run** | 生成 logicalPose / command 预览；不写 WebSerial | 否 |
| **Device Drive** | 写 WebSerial 驱动实机；需串口、face、quality≥0.5、用户确认 | 否 |

进入 Device Drive 条件：串口 connected、profile 已加载、baseline 就绪、Stop All 可见、`faceDetected=true`、`quality≥0.5`、用户显式选择并确认警告。

切换 Tab / 输入源 / 关串口 / 页面卸载 → 自动退出 Device Drive（降级 Preview Only）。

---

## 统一数据流

所有来源输出统一 **`tracking.rigFrame`**，禁止 Camera / Video 各写一套映射逻辑。

```
Tracking Source (camera | video | motion-track)
  → normalizeRigFrameMessage
  → applyTrackingCalibration
  → Face Rig Preview
  → mapFaceRigToPose (Dry Run / Device Drive)
  → Drive Mode 门控
```

示例帧结构见需求文档 §10；Motion Track V1：`facedev.motionTrack.v1`。

---

## 串口（Serial Compact Bar）

用于 **Device Drive**，非单舵机调试。保留：连接状态、波特率、选口/开关、tx/rx、lastCommand、lastError、Stop All Servo。

不保留：Direct Servo Diagnostic、FiveBar Force Send、标定面板。

---

## Device Drive 安全策略（Phase 4.4 全面启用）

复用实时下发策略：

- 默认不发送；仅 `Device Drive` 发送
- 串口未连接 / `faceDetected=false` / quality 过低 → 不发送
- 目标不变不重复刷；command cooldown；minPwmDelta；maxSendFps；serial busy 丢帧
- Stop All 立即停止 Device Drive

建议默认：`maxSendFps=20~25`，`minPwmDeltaUs=3`，`sameCommandCooldownMs=200`，`servoTimeMs=40`。

---

## Developer Debug

`localStorage facedev.showDeveloperDebug=1` 或 `?debug=1`。

可显示：raw frame JSON、debug.mapping、WS URL、adapter status、performance、servo command preview。

普通模式不显示大块 JSON。

---

## 与现有页面关系

| 页面 | 职责 |
|------|------|
| 表情编排 | 关键帧、播放、表情编辑、实时预览 |
| Kinematics Lab | FiveBar、舵机、baseline、calibration、force send |
| **Tracking Preview** | Camera / Video / Motion Track、Face Rig、Dry Run、Device Drive |

---

## 分步实现计划

### Phase 4.0 — 骨架（当前）

- 页面重定位为 Tracking Preview
- 三 Tab + Drive Mode（默认 Preview Only）
- Serial Compact Bar
- Developer Debug 折叠
- Camera Tab 接入现有 WS（UI 不强调 WS）
- Video / Motion Track 占位
- **不**自动发串口；Device Drive UI 受控/占位

### Phase 4.1 — Camera Preview 固化

- 统一 normalize + calibration + Mapping Summary
- Dry Run 显示 command preview
- Device Drive 入口 guarded

### Phase 4.2 — Video Preview

- Python `--source video --video path`
- 播放/暂停/seek、Export Motion Track

### Phase 4.3 — Motion Track V1

- import / export / playback JSON

### Phase 4.4 — Device Drive 正式启用

- 全链路实机下发 + 安全策略验收

---

## 验收（Phase 4.0）

- [ ] `docs/TRACKING_PREVIEW_ROADMAP.md` 存在且内容完整
- [ ] 三 Tab 可切换；Drive Mode 默认 Preview Only
- [ ] 串口条可见；连接后无自动 tx
- [ ] `npm run build` / `npm run build:sdk` 通过
- [ ] 不影响表情编排页与 Kinematics Lab
