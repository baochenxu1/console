# FaceDEV Neck Character Integration Phase 1 Completion

## 1. Git branch

- 基于最新 `develop` 创建并检出：`feature/neck-character-integration`
- 未修改 `main` / `release`

## 2. CharacterPose schema

```js
CharacterPose = {
  face: FaceRigSnapshot,  // 现有 Elite Rig
  neck: { pitch, roll, yaw }  // deg；不含 joint / motor / CAN
}
```

核心：`src/core/characterPose.js`（`createNeutralCharacterPose` / `normalizeCharacterPose` / `cloneCharacterPose`）

## 3. frameProject v3 / migration

- 正式版本：`FRAME_PROJECT_VERSION = "3.0.0"`
- Keyframe 正式字段：`characterPose`；兼容保留 `rigSnapshot = face`
- v2 加载：`face = old rigSnapshot`，`neck = {0,0,0}`；旧 Full-Face keyed 经 `expandKeyedChannelsToCharacter` 扩为 Face+Neck ALL

## 4. Neck channels

- Dope Sheet registry：`neck.pitch` / `neck.roll` / `neck.yaw`
- 正式 UI：**不开放**独立 Neck channel Key 编辑（`EXPRESSION_NECK_CHANNEL_EDITING_ENABLED = false`）

## 5. Full Character Key

- `addFullFaceKeyAtTime` / `addCharacterKeyAtTime` 一次写入 Face + Neck
- Select / Move / Delete / same-time merge / Alt 复制均整包 CharacterPose
- UI 文案：「写入当前关键帧」/ Dope「● 角色」

## 6. Sampler

- `sampleExpressionTimeline` / `sampleCharacterPoseAt(t)` **一次**采样得到 `{ face, neck }`
- Neck 在 semantic degree 域插值，复用 Expression easing

## 7. Absolute clock

- 保持：`playKeyframes` 绝对 Timeline Clock + ~20 ms hardware cadence
- 未新增第二套 Timeline timer

## 8. Neck Editor UI

- `NeckCharacterControls`：Pitch/Roll 2D Pad（X=roll，Y=pitch；屏上=抬头 → semantic pitch 取反）+ Yaw slider
- 独立侧栏 Character Neck section

## 9. Face Rig layout

- **未改** `FaceRigControls` 内部布局
- Neck 叠在侧栏 `face-expression-side-stack`，原三列 Grid 结构保留

## 10. Neck SDK 文件

```
src/sdk/neck/
  neckPose.js
  neckCapabilities.js
  neckBridgeProtocol.js
  neckBridgeClient.js
  neckRuntimeState.js
  neckTimingDiagnostic.js
  neckBridgeMock.js
  index.js
src/core/characterPose.js
```

## 11. facedev-neck-v1 client

- HTTP：`/v1/health`、`/v1/capabilities`
- WS：`client.hello` → 校验 `server.hello`（`protocolVersion=facedev-neck-v1`）
- Client FSM：`DISCONNECTED | CONNECTING | CONNECTED | SESSION_ACTIVE | STALE | ERROR`

## 12. Capabilities

- 连接后优先 `capabilities.neckSemantic.limits`
- UI 显示 `runtimeSafetyMode`；`productionReady=false` 时显示 Commissioning，**不**标 PRODUCTION READY
- `actualPoseAvailable=false` → 明确 `actualPose unavailable`（不用 target 假装）

## 13. Heartbeat

- Session Active：约 **100 ms** `session.heartbeat`
- 与 Timeline Pause **独立**（Pause 不停 heartbeat）

## 14. Target ~50 Hz

- 复用 `EXPRESSION_HARDWARE_SAMPLE_INTERVAL_MS = 20`（约 50 Hz）
- `dispatchNeck` 与 Face 同 tick；latest-wins / bounded pending

## 15. Sequence

- Session 内单调递增；Timeline loop 时 `timelineTimeMs` 可回绕，`sequence` 不回退

## 16. Pause / Stop / Loop / Scrub

| 动作 | Face | Neck |
|------|------|------|
| Pause | 冻结 sample | 停发变化 target；heartbeat 继续 |
| Stop | 原 Face Player 行为 | HOLD 当前 pose（不 auto-neutral/disable/estop） |
| Loop | 同 absolute modulo clock | 跟同一 CharacterPose |
| Scrub | UI 更新 | UI 更新；默认 **不**发 Bridge（Hardware Preview OFF） |

## 17. Subsystem isolation

- Neck **不**走 SC/ST/RJ adapter
- Bridge fault / disconnect：Face 继续；`dispatchNeck` 异常被吞掉

## 18. Virtual Luvia integration

- 默认 `http://127.0.0.1:8787` + `ws://127.0.0.1:8787/v1/session`
- 联调：`python -m luvia.bridge --virtual` + FaceDEV Vite（localhost:5173）
- 本阶段未做 Cloudflare / HTTPS→localhost LNA

## 19. Timeline timing diagnostic

- `src/sdk/neck/neckTimingDiagnostic.js`：记录 sampledTime / faceDispatchTime / neckSendTime / sequence / lastAcceptedSequence

## 20. 自动测试结果

```
node --test \
  src/core/expressionDopeSheetPhase1.test.mjs \
  src/core/expressionDopeSheetPhase1_1.test.mjs \
  src/core/expressionTimelinePlayback.test.mjs \
  src/core/neckCharacterIntegrationPhase1.test.mjs
→ 75 pass / 0 fail
```

覆盖 CharacterPose A–D、migration E–H、sampler I–O、Full Character Key P–T、Bridge mock U–AF、Playback AG–AN、Face regression AO–AW（registry / 隔离层面）。

## 21. Face / SC / ST / RJ regression

- Face Device Output 路径未为 Neck 重构
- 既有 Expression Dope / Playback / Phase1.1 测试全部通过
- Neck 仅为并列 `dispatchNeck` 钩子

## 22. 下一阶段（Cloud → localhost）需验证

1. HTTPS Face Console Origin → `127.0.0.1:8787` Local Network Access / 权限提示
2. Cloudflare 部署下的 allowed Origins / cookies
3. Secure context 下 WS 到 loopback 的浏览器策略
4. 与 virtual Bridge 相同的 hello / capabilities / heartbeat / target 语义在跨 Origin 下是否稳定
5. productionReady / Enable 显式门控在远程会话下的 UX
