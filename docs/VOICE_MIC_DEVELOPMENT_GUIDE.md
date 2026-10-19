# FaceDEV Voice / Mic 开发与使用说明

本文记录 FaceDEV **语音交互调试（Voice Interaction Debug）** 的开发背景、架构边界、本地使用方式与已知坑点。

对应页面：

- 顶栏：**语音交互调试**
- URL：`?page=audioInput`（兼容 `?page=audio-input`、`?page=debug/audio-input`）

当前开发分支（历史）：`feature/respeaker-audio-poc`

---

## 1. 目标与边界

### 1.1 已完成目标

证明 FaceDEV 已具备：

1. 浏览器侧稳定采集麦克风（含 ReSpeaker Lite）
2. 平台无关的实时 Audio Runtime（标准 PCM 帧）
3. 可替换的 VoiceProvider（Mock / AssemblyAI）
4. 最小安全后端：只签发 temporary token，不代理音频

链路：

```text
Mic (Browser / ReSpeaker)
  → AudioCapture
  → AudioWorklet
  → Mono + Streaming Resample
  → PCM16LE AudioFrame（20 ms）
  → VoiceProvider
       ├─ MockVoiceProvider（本地校验）
       └─ AssemblyAIProvider（100 ms 聚合 → WS Streaming STT）
```

### 1.2 明确不做（当前阶段）

- LLM / Conversation Agent
- TTS / Speaker 输出 / `setSinkId`
- Viseme / Face Motion / Jaw 联动
- VAD / Push-to-talk / Opus / WAV 上传
- 音频经 FaceDEV 后端中继
- 用户系统 / 数据库 / transcript 持久化

---

## 2. 架构分层

| 层级 | 职责 | 谁拥有 Mic |
|------|------|------------|
| AudioDevice / AudioCapture | 权限、enumerateDevices、getUserMedia、devicechange、track ended | Capture |
| AudioRuntime | Worklet、downmix、resampler、PCM16、frame accumulator | Runtime（消费 stream） |
| AudioFrame | 标准帧契约 | Runtime 产出 |
| VoiceProvider | 连接外部 STT / Mock；只收 AudioFrame | **不得**拥有 Mic |
| VoiceSession | 编排 Capture → Provider → Runtime 生命周期 | Session |

关键约束：

- Provider **禁止**调用 `getUserMedia` / 创建 `AudioContext` / 做 resample / PCM 转换
- 下一阶段新增 Provider 时，理想情况只加 Adapter，不改 Capture / Worklet / Resampler / AudioFrame 主流程

启动顺序（Session）：

```text
1. Capture（开麦）
2. Meter（Analyser，仅 Level）
3. Provider connect（AssemblyAI 先取 token 再开 WS）
4. AudioRuntime start（Worklet 出帧）
5. Session = RUNNING
```

停止顺序：

```text
停 Runtime → Provider disconnect（AssemblyAI 先 Terminate）→ 关 Meter → 停 Track / 释麦
```

切页 / unmount 必须同等 cleanup。

---

## 3. Canonical Audio Format（Voice Input v1）

这是 **Runtime Transport Format**，不是硬件原生格式。

| 字段 | 值 |
|------|-----|
| encoding | `pcm_s16le` |
| sampleRate | `16000` |
| channels | `1`（mono） |
| frameDurationMs | `20` |
| samplesPerFrame | `320` |
| bytesPerFrame | `640` |

典型浏览器输入：

```text
Input:  48000 / 44100 Hz Float32（以 AudioContext.sampleRate 为准，禁止硬编码）
Output: 16000 Hz mono PCM16LE，20 ms / 帧
```

AssemblyAI Provider 内部再聚合：

```text
5 × 20 ms AudioFrame → 100 ms / 3200 bytes → WebSocket binary
```

不要为适配外部平台去改内部 20 ms AudioFrame。

---

## 4. 开发历程摘要

| 阶段 | Commit（参考） | 内容 |
|------|----------------|------|
| Audio Input PoC | `914c71c` | ReSpeaker 浏览器采集、Level、Track Settings |
| Channel Diagnostics | `0854b48` | Native / Mono / Stereo Diagnostic，CH0/CH1 |
| Voice Runtime Phase 1 | `1f511a9` | Worklet、Resampler、AudioFrame、MockProvider、页面升级 |
| AssemblyAI Phase 2 | `a1ff35e` | temporary token 后端、AssemblyAI v3 Streaming、transcript UI |
| Bugfix | `697fe01` / `b829eb0` | fetch wrapper；禁止读 `AudioContext.prototype.audioWorklet` |

详细按日记录见：`docs/FaceDEV_Development_Log.md`

### 4.1 ReSpeaker / Mic1 结论

真机已确认：

- ReSpeaker 可被 Browser 捕获；Mic2 正常
- Mic1 基本无响应；Windows 系统直采同现象
- Native / Mono / Stereo Diagnostic 均无法改变该现象

**结论：Mic1 为固件/硬件侧问题，不阻塞 Voice Runtime。**  
Device Diagnostics 仅用于观察，Runtime downmix 不做 Mic1/Mic2 物理映射假设。

---

## 5. 目录与模块地图

```text
src/sdk/audio/
  audioDevices.js          # 权限 / 枚举 / devicechange
  audioCapture.js          # getUserMedia + channel mode
  audioMeter.js            # Analyser RMS / 通道诊断（仅 UI Level）
  audioErrors.js
  audioRuntime.js          # Worklet 管道 + 标准帧产出
  audioResampler.js        # 流式线性插值
  pcm16.js                 # Float32 → PCM16LE
  audioFrame.js            # AudioFrame + accumulator
  worklets/pcmCaptureProcessor.js

src/sdk/voice/
  voiceSession.js          # 会话编排
  voiceProvider.js         # 状态 / 事件契约
  voiceProviderRegistry.js # mock | assemblyai
  mockVoiceProvider.js
  voiceTokenClient.js      # GET /api/voice/token
  browserApi.js            # defaultFetch / defaultNow（防 Illegal invocation）
  providers/
    assemblyAIProvider.js
    assemblyAIChunkAggregator.js
    assemblyAIProtocol.js

server/voice/              # 最小 token 后端（无 Express）
  fetchAssemblyAIToken.js
  createVoiceTokenHandler.js
  server.mjs               # 可选独立进程 :8787
  loadEnv.js

scripts/vite-voice-api-plugin.mjs   # npm run dev 挂载 /api/voice/*
```

页面：

- `src/pages/AudioInputDebugPage.jsx`
- 样式：`src/styles/audio-input-debug.css`

---

## 6. 使用方式

### 6.1 启动前端

```bash
npm run dev
```

浏览器打开 Face Console，进入 **语音交互调试**，或：

```text
http://127.0.0.1:<vite-port>/?page=audioInput
```

目标浏览器：Windows Chrome / Edge。

> Dev 已通过 Vite plugin 挂载 `GET /api/voice/token`。  
> 修改 `vite.config.js` / plugin 后若异常，请重启 `npm run dev`。

### 6.2 Mock 模式（不需要 API Key）

1. Provider 选 **Mock**
2. Request Permission → 选择麦克风（如 ReSpeaker Lite）
3. **Start Session**
4. 预期：
   - Session = `RUNNING`
   - Provider = `CONNECTED`
   - Input Level 随说话变化
   - Runtime：Frames Generated / Sent 持续增加
   - Transcript 区提示 Mock 不产生转写
5. **Stop Session** → 麦克风占用消失

Session 运行中不可切换 Provider / 设备 / Capture Mode；需先 Stop。

### 6.3 AssemblyAI 模式（实时中文 STT）

#### 配置密钥

1. 复制 `.env.example` → **`.env`**（注意：必须是 `.env`，不要只改 `.env.example`；`.env` 已 gitignore）
2. 填写：

```env
ASSEMBLYAI_API_KEY=你的密钥
```

3. 只执行 `npm run dev` 即可；**不必**再在 PowerShell 里 `$env:ASSEMBLYAI_API_KEY=...`
4. **禁止**使用 `VITE_ASSEMBLYAI_API_KEY`（不得进入浏览器 bundle）
5. 修改 `.env` 后若 middleware 已启动，请重启 `npm run dev`

可选独立 token 服务：

```bash
npm run dev:voice-api
# 默认 http://127.0.0.1:8787
# 健康检查：GET /healthz
```

生产静态站需自行把 `/api/voice/*` 反代到该服务或等价实现；前端只请求相对路径 `/api/voice/token`。

#### 操作步骤

1. Provider 选 **AssemblyAI**
2. Start Session
3. 预期阶段：
   - Auth = Temporary Token（不显示 token 内容）
   - Streaming = Active
   - Provider = CONNECTED
4. 讲中文，例如：「你好，现在正在测试 FaceDEV 的实时语音识别。」
5. UI：
   - **正在识别**：partial（覆盖更新，不刷屏追加）
   - **Final History**：`end_of_turn=true` 的句子
6. Stop Session：发送 `Terminate`，再关闭 WS，并释放麦

未配置 Key 时，应看到明确的服务端/token 错误（如 `MISSING_SERVER_API_KEY`），而不是浏览器 `Illegal invocation`。

### 6.4 页面信息结构

主区域：

1. Voice Session（设备、Provider、Start/Stop、Session/Auth/Streaming）
2. Input Level
3. Audio Runtime Stats
4. Provider Stats（Frames RX vs WS Chunks TX）
5. Transcript / Events

高级（默认折叠）：

- Capture Channel Mode
- Channel Diagnostics（CH0/CH1、Correlation…）
- Track Settings
- Provider Debug（WS State、Close Code、Last Start Stage…）

---

## 7. Backend Token API

```http
GET /api/voice/token?provider=assemblyai
```

成功响应（标准化，非上游裸透传）：

```json
{
  "provider": "assemblyai",
  "token": "...",
  "expiresIn": 60
}
```

错误码（服务端）：

| code | 含义 |
|------|------|
| `MISSING_SERVER_API_KEY` | 未配置 `ASSEMBLYAI_API_KEY` |
| `UPSTREAM_AUTH_FAILED` | 上游 401/403 |
| `UPSTREAM_TOKEN_FAILED` | 上游 token 失败 |
| `UPSTREAM_UNAVAILABLE` | 网络/上游不可达 |
| `UNKNOWN_PROVIDER` | 不支持的 provider |
| `UNKNOWN_SERVER_ERROR` | 其它 |

规则：

- Token 60 秒内用于**建立** WS；不限制已建立会话只能 60 秒
- 每次 Start 现取新 token，不缓存、不写 localStorage
- Browser 持 temporary token，**直连** AssemblyAI；后端不碰音频

AssemblyAI 连接参数（当前实现）：

```text
wss://streaming.assemblyai.com/v3/ws
  ?sample_rate=16000
  &encoding=pcm_s16le
  &speech_model=universal-3-5-pro
  &language_codes=["zh"]
  &token=<temporary>
```

---

## 8. Provider 契约（摘要）

状态：`IDLE | CONNECTING | CONNECTED | DISCONNECTING | ERROR`

事件：

- `connected` / `disconnected`
- `transcript.partial` / `transcript.final`
- `error`
- （预留）`audio.delta`

方法：`connect` / `sendAudio(frame)` / `disconnect` / `onEvent` / `getState` / `getStats`

Registry：`mock`、`assemblyai` —— UI 下拉可切换；不要写死唯一 Provider。

---

## 9. 自测与构建

```bash
# Audio / Runtime
node src/sdk/audio/audioInput.selftest.mjs
node src/sdk/audio/audioRuntime.selftest.mjs

# Voice
node src/sdk/voice/voiceRuntime.selftest.mjs
node src/sdk/voice/browserApi.selftest.mjs
node src/sdk/voice/providers/assemblyAIProvider.selftest.mjs

# Token backend（mock upstream）
npm run test:voice-token

# 生产构建（含独立 Worklet 资源）
npm run build:faceconsole-web
```

说明：Node selftest **不会**覆盖全部 Browser native getter 行为；关键路径需 Chrome 真机点一次 Start Session。

---

## 10. 开发注意与已踩坑

### 10.1 Illegal invocation

Chromium 对 native API 的 `this` 很严格。

| 错误写法 | 正确写法 |
|----------|----------|
| `const f = globalThis.fetch; f(url)` | `(...a) => globalThis.fetch(...a)` |
| 读 `AudioContext.prototype.audioWorklet` | 先 `new AudioContext()`，再读 `context.audioWorklet` |
| `const now = performance.now; now()` | `() => performance.now()` |

相关修复 commit：`697fe01`、`b829eb0`。

### 10.2 Worklet 打包

- 使用 `new URL('./worklets/pcmCaptureProcessor.js', import.meta.url)`
- `vite.faceconsole-web.config.js` 禁止把 `pcmCaptureProcessor` 内联成 `data:` URL
- 验证 dist 中存在独立 `pcmCaptureProcessor-*.js`

### 10.3 React 刷新频率

Runtime 内部约 50 frame/s；UI Stats 约 **5 Hz**（200 ms）快照，禁止每帧 `setState`。

### 10.4 日志安全

允许：state、WS close code、chunk 计数、Turn 类型。  
禁止：API Key、temporary token、完整带 `token=` 的 URL、逐帧 PCM。

---

## 11. 真机验收清单（建议）

**Mock**

- [ ] Start → Level + Frames 增长
- [ ] Stop → 麦释放
- [ ] Start/Stop ×5
- [ ] RUNNING 时切页 → 自动 Stop

**AssemblyAI**

- [ ] 有 Key：CONNECTED + 中文 partial/final
- [ ] 无 Key：明确 token/server 错误
- [ ] Stop：Terminate + 干净关闭
- [ ] 拔麦：Session ERROR / 停止，不再继续发帧
- [ ] 断网：Provider ERROR，页面不崩，可 Stop 释麦

**Runtime 不变性**

- [ ] Output 仍为 16000 / mono / PCM16LE / 20 ms / 320 / 640
- [ ] AssemblyAI 下 Provider WS Chunk ≈ Runtime Frames / 5

---

## 12. 下一步（未开始）

在确认三层边界成立后：

1. 第二个真实 Provider（验证可替换性）
2. 视产品需要再接 LLM / TTS / Viseme（独立阶段）

不要在本模块内提前做万能 AI Agent 抽象。

---

## 13. 相关文件速查

| 用途 | 路径 |
|------|------|
| 调试页 | `src/pages/AudioInputDebugPage.jsx` |
| 会话编排 | `src/sdk/voice/voiceSession.js` |
| Runtime | `src/sdk/audio/audioRuntime.js` |
| AssemblyAI | `src/sdk/voice/providers/assemblyAIProvider.js` |
| Token 后端 | `server/voice/` |
| 环境变量示例 | `.env.example` |
| 开发日志 | `docs/FaceDEV_Development_Log.md` |
