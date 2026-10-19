# FaceDEV Neck Cloud Staging Real Browser Acceptance

> Phase 2.1 验收任务报告。  
> **规则**：无真实 Browser 证据不得声明 Cloud→localhost PASS。

## 执行摘要

| 项 | 结果 |
|----|------|
| Phase 2 checkpoint commit | **DONE** `9cdcde6` |
| 正式测试 104 pass | **PASS**（提交前已复跑） |
| `npm run build:faceconsole-web` | **PASS** |
| dist-web 含 Phase 2 Neck 代码 | **PASS**（审计） |
| Permissions-Policy blocker | **无**（未发现禁止 LNA 的 header） |
| Cloudflare Direct Upload | **BLOCKED**（本机无 `CLOUDFLARE_API_TOKEN`，`wrangler whoami` 未登录） |
| Staging 是否已是本构建 | **NO** — 线上仍为 `index-DYoz8y4E.js`；本地为本构建 `index-BVkzLREz.js` |
| Luvia virtual Bridge（本机） | **RUNNING** — health/capabilities OK；`allowed_origins` 已含 staging |
| Chrome 真实验收 A–R | **NOT EXECUTED**（被部署阻塞；且本 Agent 会话无交互式 Browser/LNA） |
| Edge smoke | **NOT EXECUTED** |
| 可否进入 Physical Neck Phase 3 | **NO** |

---

## 1. FaceDEV Phase 2 checkpoint commit

- Branch: `feature/neck-character-integration`
- Commit: **`9cdcde6`**
- Message: `feat: support cloud-to-local neck bridge connectivity`
- 无 Cursor attribution trailer
- Parent Phase 1: `2ca4efc`

## 2. Staging deployment version/time

- **未能完成本次 Direct Upload**
- 阻塞：`wrangler pages deploy` →  
  `In a non-interactive environment, it's necessary to set a CLOUDFLARE_API_TOKEN`
- `npx wrangler whoami` → **not authenticated**
- 当前线上：`https://faceconsole-web-staging.pages.dev/` → **200**
- 线上主包：`/assets/index-DYoz8y4E.js`（**旧构建**）
- 本地待部署主包：`dist-web/assets/index-BVkzLREz.js`（Phase 2 构建）
- 部署时间：**N/A（未上传）**

### 解除阻塞后命令

```bash
# 交互登录或设置 CLOUDFLARE_API_TOKEN 后：
npm run build:faceconsole-web
npx wrangler pages deploy dist-web --project-name=faceconsole-web-staging
```

## 3. Chrome version

- **NOT RECORDED**（未打开 Chrome 对 staging 做 Phase 2 验收）
- 本机已检测到：`C:\Program Files\Google\Chrome\Application\chrome.exe`

## 4. Bridge OFF UX

- **NOT EXECUTED**（需 staging 上 Phase 2 UI + 真实点击 Connect Neck）
- 代码/构建侧：文案 `Local Neck Bridge not detected` / 错误码 `BRIDGE_NOT_RUNNING` 已打入 `dist-web`

## 5. LNA permission prompt 实际行为

- **NOT EXECUTED**
- 无法在无用户交互 Browser 的情况下获取 Allow/Deny 证据

## 6–9. health / capabilities / WebSocket / protocol hello

### 本机 Luvia virtual（可证据）

- 命令：`python -m luvia.bridge --virtual`（`luvia_neck_control/04_Software`）
- `GET http://127.0.0.1:8787/v1/health` →  
  `ok:true`, `protocolVersion:facedev-neck-v1`, `productionReady:false`, `COMMISSIONING_OPEN_LOOP`
- `GET /v1/capabilities` → semantic pitch/roll/yaw、50 Hz recommended、`actualPoseAvailable:false`
- `bridge.yaml` `allowed_origins` **已含** `https://faceconsole-web-staging.pages.dev`

### Cloud staging → localhost（真实验收）

- health：**NOT EXECUTED**
- capabilities：**NOT EXECUTED**
- WebSocket / hello：**NOT EXECUTED**

## 10–20. Heartbeat / manual axes / Timeline / 50Hz / timing / Pause / background / STALE / restart / 60s / permission

全部：**NOT EXECUTED**（依赖已部署 Phase 2 的 staging + 真实 Chromium + 本机 Bridge）

## 21. CLOUD_HTTPS_TO_HTTP_LOOPBACK

**FAIL / NOT PROVEN**（无真实 Browser 证据；不得报 PASS）

## 22. CLOUD_HTTPS_TO_WS_LOOPBACK

**FAIL / NOT PROVEN**（无真实 Browser 证据；不得报 PASS）

## 23. LOCALHOST_TLS_REQUIRED

**UNKNOWN**（需先完成 HTTP/WS 实测；本阶段不擅自引入 TLS）

附加：

- `LNA_PERMISSION_REQUIRED`: **UNKNOWN**（未观察到 prompt）

## 24. Edge smoke

**NOT EXECUTED**  
本机已检测到 Edge：`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`

## 25. 是否可以进入 Physical Neck Integration Phase 3

**不可以。**

进入 Phase 3 前必须至少完成：

1. Direct Upload 使 staging 提供本构建（`index-BVkzLREz.js` 或后续新 hash）
2. Chrome：Connect Neck → Allow → health/caps/WS hello/heartbeat
3. 明确记录 `CLOUD_HTTPS_TO_HTTP_LOOPBACK` / `CLOUD_HTTPS_TO_WS_LOOPBACK` 为 **PASS**
4. Expression Timeline Face+Neck 与 Pause/Restart 至少冒烟 PASS

---

## 部署前审计（已完成，可证据）

1. Phase 2 代码进入 `dist-web`：`facedev-neck-v1`、`127.0.0.1:8787`、`ws://127.0.0.1:8787/v1/session`、`Connect Neck` 均在主 JS 中
2. 默认 HTTP/WS endpoint：如上
3. `protocolVersion`：`facedev-neck-v1`
4. 页面加载：`createNeckBridgeClient()` 仅构造；**Connect Neck** 才 `connect()`（源码审计）
5. 不自动 Enable：无 page-load `neck.enable` 路径
6. `dist-web/_headers`：**无** `Permissions-Policy`；**无** `loopback-network=()` / `local-network=()` → **不是 BLOCKER**；未擅自新增 header
7. Staging 响应头未发现 Permissions-Policy 禁止项（抽样 index.html）

---

## 阻塞项（按优先级）

1. **BLOCKER — Cloudflare auth**：设置 `CLOUDFLARE_API_TOKEN` 或本机执行 `npx wrangler login`，再 Direct Upload
2. **BLOCKER — Staging 仍为旧构建**：线上 `index-DYoz8y4E.js` ≠ 本地 Phase 2
3. **BLOCKER — 真实 Browser LNA 交互**：需人工在 Chrome/Edge 完成 Allow/Deny 与 A–R 清单

---

## 下一步（用户侧最短路径）

```text
1) wrangler login 或设置 CLOUDFLARE_API_TOKEN
2) npx wrangler pages deploy dist-web --project-name=faceconsole-web-staging
3) 确认 staging index.html 引用新 hash（≠ index-DYoz8y4E.js）
4) 本机保持：python -m luvia.bridge --virtual
5) Chrome 打开 https://faceconsole-web-staging.pages.dev → Expression → Connect Neck
6) 按 Phase 2.1 §7–§19 逐项记录证据后，再声明 PASS / Phase 3
```
