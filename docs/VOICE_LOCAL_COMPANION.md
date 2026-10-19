# FaceDEV Local Xinqi Companion

内测用户通过 **Cloudflare Pages** 打开 FaceDEV 时，浏览器需连接本机 Xinqi。  
Cloudflare Pages 只有静态资源，不能托管 Gateway，因此采用 **独立 Local Companion**。

## 架构结论

| 方案 | 结论 |
|---|---|
| A. Xinqi Engine 集成本地 Gateway | **暂不采用**。需改 Xinqi 源码并做独立受保护路由 / Origin / 配对；本机无授权不得修改 Xinqi。 |
| B. 独立 Local Companion | **采用**。复用现有 FaceDEV Xinqi Gateway；默认 `http://127.0.0.1:18740`；Robot API Key 留在本机进程。 |

## 普通用户步骤

1. 启动 Xinqi Engine  
2. 安装一次 Companion 开机自启：`npm run companion:autostart:install`（或手动 `npm run dev:companion`）  
3. 打开 FaceDEV 云端页（Release Pages）  
4. 首次：授权浏览器本机网络访问 + 输入 Companion 控制台配对码  
5. 自动识别本机服务后，点击「连接并开始」

后续访问会尽量恢复本机连接；**过期配对不会被静默绕过**。

若本机已是 `paired` 但云端页仍要配对码：说明浏览器本地 token 丢失。  
`840456` 一类旧码是一次性的，已用过即失效。重启 Companion 会打印**重新配对码**（或见控制台「重新配对码」行）。

## Windows 双文件分发包

构建（开发机）：

```bash
npm run build:companion-win
npm run verify:companion-win
```

交付目录：

```text
dist/face-dev-xinqi-companion-win/
  FaceDEV-Companion.exe
  start-with-facedev.cmd
```

复制这两个文件到任意 Xinqi 工程根（与 `start.cmd` 同级），双击 `start-with-facedev.cmd`。  
配对码见 Companion 窗口或 `%USERPROFILE%\.facedev\companion\PAIRING_CODE.txt`。

## 开发者

```bash
npm run dev:companion
npm run test:voice-companion
npm run test:voice-companion-discovery
npm run verify:companion-p0
```

环境变量（项目根 `.env`，勿提交密钥）：

- `XINQI_BASE_URL` / `XINQI_ROBOT_API_KEY` — Companion 进程读取  
- `FACEDEV_COMPANION_PORT` — 默认 `18740`  
- `FACEDEV_COMPANION_ALLOWED_ORIGINS` — 逗号分隔 Origin 白名单  

高级 UI 可改本机端口 / loopback Gateway 地址；**不允许公网 URL，不允许填写 Robot API Key**。

## P0 验证门槛

在真实 CF Pages Origin 下完成 HTTP + WebSocket 验证前，**不得声称云端语音功能已经可用**。
