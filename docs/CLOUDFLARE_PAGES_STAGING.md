# Face Console · Cloudflare Pages Staging（Phase 1）

**目标**：把已验证的 Production Web（`npm run build:faceconsole-web` → `dist-web/`）部署到 **HTTPS** 静态站点，用户打开网址即可跑 **Browser MediaPipe**。

**本阶段定位**：staging / preview 验证。  
**不做**：PWA、Service Worker、登录、云同步、修改 Tracking / Servo / Expression 业务逻辑、修改 `release` / `main`。

---

## 1. 仓库与 Root Directory

本 Git 仓库根目录即 `04_Software`（`package.json` 所在目录）。

Cloudflare Pages：

| 项 | 值 |
|----|-----|
| **Root Directory** | `/`（仓库根，勿再套一层 `04_Software`） |
| **Build command** | `npm run build:faceconsole-web` |
| **Build output directory** | `dist-web` |
| **Node version** | `20`（见 `.node-version`） |
| **Python** | 不需要 |

构建时 `prepare-browser-mediapipe-assets.mjs` 会从官方桶下载 `face_landmarker.task` 并复制 WASM；**不必**把 `.task` 提交进 Git。

---

## 2. Git Integration（推荐）

1. Cloudflare Dashboard → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**
2. 选择仓库：`LUVIA-me/LuviaMini-Console`（或当前 `origin`）
3. 按上表填写 Build 配置
4. **Production branch**：本阶段**不要**设为 `feature/browser-mediapipe-runtime`  
   - 可先选 `main` 但不发布正式流量，或暂不启用 Production  
   - Preview：对 `feature/*` 的每次 push 生成 `*.pages.dev` Preview URL
5. Save / Deploy

正式生产分支未来按仓库规范使用 **`release`**，再显式晋升 `main`。本阶段**不修改** `release` / `main`。

### 分支策略（本阶段）

```text
feature/browser-mediapipe-runtime  push  →  Cloudflare Preview Deployment
release / main                     →  本阶段不改、不挂 Production
```

---

## 3. 本地构建与检查

```bash
npm ci
npm run build:faceconsole-web
npm run smoke:browser-mediapipe-worker
npm run test:browser-tracking
npm run test:tracking-semantic
```

可选本地 HTTPS 预览（仍是本机）：

```bash
npm run preview:faceconsole-web
```

---

## 4. Preview URL Smoke

部署出 Preview URL 后：

```bash
npm run smoke:faceconsole-web-https -- https://<preview>.pages.dev
```

检查：

1. `index.html` = 200  
2. 主 JS / CSS = 200  
3. `/assets/mediapipe/wasm/*` = 200  
4. `/models/face_landmarker.task` = 200  

---

## 5. 人工验收（Browser Camera）

1. Chrome / Edge 打开 HTTPS Preview  
2. **不启动** Python（8766 / 8767）  
3. Tracking Runtime = **Browser**  
4. Source = **Camera** → Start  
5. 确认：Camera 权限、Preview、Model READY、inference FPS &gt; 0、Face Rig 有数据、Stop / Restart  
6. DevTools Network：WASM / model 来自云端 HTTPS；**不得**访问 `127.0.0.1:8766` / `8767`  
7. 控制台可见 `[Face Console] v… · <gitSha>`；页眉副标题含版本与短 SHA  

### Web Serial

无真机时只确认 `navigator.serial` 在 Chromium HTTPS 下存在。  
标记：**Hardware Validation Pending**（HTTPS → Web Serial → SC/ST/RJ 留后续）。

---

## 6. 资源路径约定

Production 请求应为：

```text
/assets/*.js|*.css
/assets/mediapipe/wasm/...
/models/face_landmarker.task
```

禁止：

- `127.0.0.1` / `localhost` 作为 Browser Runtime 硬依赖  
- `F:\` 等本地绝对路径  
- 运行时依赖 `tools/tracking_service/...` 文件系统路径  

页面切换使用 **`?page=...` query string**（非 History Router），标准 `index.html` 即可，本阶段不加 SPA rewrite。

---

## 7. 缓存

`public/_headers`（构建进 `dist-web/_headers`）：

- `index.html`：`no-cache`（刷新拿到新 hashed 引用）  
- `/assets/*`：长缓存 immutable  
- WASM / model：日级缓存  

**不注册** Service Worker / PWA。

---

## 8. 版本诊断

复用 `package.json` 的 `version`（当前 `0.2.0-beta`），构建注入：

- `VITE_FACECONSOLE_VERSION`  
- `VITE_FACECONSOLE_GIT_SHA`（优先 `CF_PAGES_COMMIT_SHA`）  
- `VITE_FACECONSOLE_BUILD_TIME`  

不另起第二套版本号。

---

## 9. ZIP 发布定位

`npm run dist:faceconsole` **保留**，定位改为：

- fallback  
- offline archive  
- special deployment  

主产品发布能力转向 HTTPS Web（本 Phase 仅 staging）。

---

## 10. 可选：Wrangler 直传

未接 Git 时可用（需先 `wrangler login`）：

```bash
npm run build:faceconsole-web
npx wrangler pages deploy dist-web --project-name=faceconsole-web-staging
```

见仓库根 `wrangler.toml`。Git Integration 仍以 Dashboard 为准。

---

## 11. Phase 2（PWA）预留

本阶段明确不做：

- PWA / Service Worker / Offline  
- Cloud Account / Project Sync / Login / DB  
- Local Bridge  
- 删除 Python Tracking Service  
- Browser Video/Upload 重构  
