# FaceDEV Neck Cloud Local Bridge Phase 2 Completion

## 1. Phase 1 checkpoint commit

- `2ca4efc` — `feat: integrate neck into character expression timeline`
- 无 Cursor attribution trailer

## 2. Branch

- `feature/neck-character-integration`（未新建分支；未 merge develop）

## 3. Phase 2 修改文件

- `src/sdk/neck/neckLocalBridgeCapability.js`（新）
- `src/sdk/neck/neckBridgeErrors.js`（新）
- `src/sdk/neck/neckBridgeClient.js`（连接层增强）
- `src/sdk/neck/neckBridgeProtocol.js`（UI states + `session.resume`）
- `src/sdk/neck/neckTimingDiagnostic.js`（对齐指标 + 60s 模拟流）
- `src/sdk/neck/index.js`
- `src/sdk/react/NeckBridgePanel.jsx`
- `src/sdk/react/FaceExpressionEditor.jsx`（Resume / timing 字段）
- `src/styles/face-rig.css`
- `src/core/neckCloudLocalBridgePhase2.test.mjs`（新）
- `docs/FaceDEV_Neck_Cloud_Local_Bridge_Phase2_Completion.md`（本报告）

## 4. Browser local-network capability layer

- `detectLocalBridgeEnvironment()`：secure context / browser family / Permissions API support
- `queryLocalNetworkPermission()`：feature-detect `loopback-network` / `local-network`，try/catch
- `unsupported` ≠ Neck unsupported；真正能力以 localhost connection attempt 为准
- Chromium（Chrome/Edge）为 Neck Local Hardware 目标；本机 loopback Vite 页面仍允许联调

## 5. Connect Neck flow

仅用户点击 **Connect Neck** 才执行：

1. compatibility check → 2. optional permission diagnostic → 3. `GET /v1/health` → 4. `GET /v1/capabilities` → 5. protocolVersion → 6. `ws://127.0.0.1:8787/v1/session` → 7–8. hello → 9. session active → 10. independent heartbeat → 11. state stream → 12. allow semantic target  
**不**自动 `neck.enable`。

## 6. Error classification

`NECK_BRIDGE_ERROR_CODES`：`BRIDGE_NOT_RUNNING` / `LOCAL_NETWORK_PERMISSION_*` / `ORIGIN_NOT_ALLOWED` / `CAPABILITIES_FAILED` / `PROTOCOL_MISMATCH` / `BRIDGE_BUSY` / `WEBSOCKET_FAILED` / `SESSION_REJECTED` / `BRIDGE_UNHEALTHY` / `UNSUPPORTED_BROWSER` / `UNKNOWN_ERROR`  
分类依据：permission state、HTTP status、health body、WS close code、server.hello — **不**依赖 Chromium 文案字符串。

## 7. Permission denied UX

- 文案：`Local Neck access denied`
- 不 crash、不自动重复 prompt、不影响 Face
- 提供用户点击 **Retry**（= 再次 Connect）

## 8. Bridge not running UX

- 文案：`Local Neck Bridge not detected.`
- UI state：`BRIDGE_NOT_FOUND`
- 不显示为 Neck hardware fault

## 9. HTTP / WebSocket 独立状态

Snapshot `access: { health, capabilities, websocket }` 各自 `idle|pending|ok|failed|blocked`。

## 10. Heartbeat / Pause

- ~100 ms `session.heartbeat` 独立于 Timeline / target
- Pause 不停 heartbeat（Phase 1 契约保持）

## 11. Background tab diagnostic

Snapshot：`visibilityState` / `lastHeartbeatSentAt` / `lastHeartbeatSendAgeMs` / `lastTargetSentAt` / `lastTargetSendAgeMs`  
（真实 staging 后台 10s 仍需手工验收）

## 12. STALE / Resume

- STALE：停止 Neck target dispatch；UI「Neck Safe Hold / Stale」；Face 继续
- **Resume Neck** → `session.resume` → ack 后恢复 target；不自动 Resume

## 13. bufferedAmount / latest-wins

- `socket.bufferedAmount` 采样；超过 soft limit 不继续把历史 target 塞入 socket
- 仅保留 latest pending；恢复后只发最新 pose

## 14. Control command priority

- ESTOP / hold / disable / heartbeat 走 `sendControl`，不受 target backpressure 门控
- target producer 在 send 前限流

## 15. Timing diagnostics

- 记录：`timelineTimeMs` / `characterSampleAt` / `faceDispatchAt` / `neckTargetPreparedAt` / `neckSocketSendAt` / `sequence` / `bridgeLastAcceptedSequence`
- `summarizeFaceNeckDispatchAlignment()` → mean / p50 / p95 / max

## 16. 60 s stream test

- `simulateTargetLatestWinsStream(60s @ 20ms)`：无无界 backlog；自动测试 **X** 覆盖

## 17. Production build

- `npm run build:faceconsole-web`：**PASS**（`[check-faceconsole-web-assets] all checks passed`）
- 未改 PWA / GitHub Actions

## 18. 自动测试结果

```
Phase 1 + Expression + Phase 2：104 pass / 0 fail
```

## 19. Face / SC / ST / RJ regression

- 既有 Expression / Phase1 测试全绿
- Phase2 AB–AD：Neck client 未引入 SC/ST/RJ adapter 依赖
- CharacterPose / frameProject v3 / Face Rig layout 未重构

## 20. LUVIA_REQUIRED_CHANGE

需要在 **Luvia** 仓库（非本仓库）更新：

`04_Software/configs/bridge.yaml` → `allowed_origins` 增加：

```text
https://faceconsole-web-staging.pages.dev
```

FaceDEV **未**跨仓库修改该文件。

## 21. Cloudflare staging 手工验收条件

已具备代码侧条件；真实验收仍依赖：

1. 上述 Luvia `allowed_origins` 已生效
2. FaceDEV staging 已部署含 Phase 2 的 `dist-web`（Direct Upload）
3. 本机 `python -m luvia.bridge --virtual`
4. Chrome Desktop 按 §38 步骤；Edge smoke Connect→hello→heartbeat→single target

**Mock 不能代替** staging × virtual Bridge 实测。
