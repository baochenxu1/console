# FaceDEV Development Log

按日期追加的持续开发记录。不再为每个 Phase / R* 单独创建 Completion 文档。

---

# 2026-10-10（Local Xinqi Companion / 云端页本机发现）

## 1. 重点工作

- 评估 A（Xinqi 内嵌 Gateway）vs B（独立 Companion）；采用 **B**
- 默认发现 `http://127.0.0.1:18740`；Origin 白名单 + 首次配对；高级端口仅 loopback
- Voice Console 区分 Companion 未启动 / LNA / 已连接 / Xinqi 不可用 / 需配对 / 配对完成
- Windows 登录自启脚本；P0 真实 CF Pages Origin HTTP+WS（Node）与浏览器 discover 验证通过

## 2. 关键进展

- `server/voice/companion/*` + `src/sdk/voice/companion/*`
- 文档：`docs/VOICE_LOCAL_COMPANION.md`
- 未改 Xinqi 源码；未碰 `main` / 生产

## 3. 问题记录

- A 方案需改 Xinqi，未经授权搁置
- 浏览器 LNA 仍可能要求用户首次点授权；过期配对不得静默绕过

## 4. 下一步计划

- 内测用户安装 Companion 自启后走完整语音回归
- 若后续授权 Xinqi 集成，再评估方案 A

---

# 2026-10-09（Xinqi Engine Integration Phase 2）

## 1. 重点工作

- 新增 XinqiProvider：ReSpeaker 20 ms 帧经 Gateway 聚合成 100 ms / 3200 B 送入心契

## 2. 关键进展

- `turn.delta.text` 按增量拼接；用户 `transcript.partial` / `user` 与 AI `assistant.*` 分开
- 收到 `audio` 只计数，不播放、不发送 playback ACK
- Voice Console 增加 Xinqi，并区分用户与心契文字；Audio Runtime / Gateway 协议未改

## 3. 问题记录

- 未 ACK 播放时，Xinqi 可能不会发出 `turn.done`；文字完成不等于整轮播放完成

## 4. 下一步计划

- 24 kHz PCM 播放与 playback.progress / playback.done

---

# 2026-10-09（Xinqi Engine Integration Phase 1）

## 1. 重点工作

- FaceDEV Backend → Xinqi Engine Robot API 安全 Gateway 边界（服务发现 / 握手 / WS 代理）

## 2. 关键进展

- server-side `XINQI_BASE_URL` + `XINQI_ROBOT_API_KEY`；Browser 不持有长期密钥、不直连 Xinqi
- `GET /api/voice/xinqi/health`、`POST /api/voice/xinqi/session`、`WS /api/voice/xinqi/realtime`
- Gateway 内存 session + upstream Origin 伪装 + start handshake；3200B binary 校验；JSON whitelist
- Vite `npm run dev` 与 `dev:voice-api` 共用同一实现；Audio Runtime / Provider / 播放 / Camera 未改

## 3. 问题记录

- 下一阶段才做 XinqiProvider（20ms×5 → 100ms/3200B）与 transcript/turn 映射

## 4. 下一步计划

- 真机 Gateway ready 验收后进入 Mic 接入

---

# 2026-09-30（Voice Console Layout Stability）

## 1. 重点工作

- 消除 Voice Console layout shift；永久说明迁入 Tooltip；骨架在状态切换时保持稳定

## 2. 关键进展

- Toolbar 四槽 Grid（Mic / Provider / Status / Action）固定宽度；Action / Status / Partial / Error 固定槽位
- 设备名短标签 + 完整 label Tooltip；Provider helper text 移除
- Base UI Tooltip（hover delay 400ms + focus + portal）；`voiceConsolePresentation.js` 集中帮助文案
- Playwright CLS / tooltip 验收脚本；Audio Runtime / Provider 0 functional change

## 3. 问题记录

- 无

## 4. 下一步计划

- 真机 ReSpeaker Idle→Running 目视确认骨架不动

---

# 2026-09-30（Voice Console 一键连接）

## 1. 重点工作

- 将 Mic Permission + Device + Provider Start 收敛为「连接并开始」一键流程

## 2. 关键进展

- `resolvePreferredAudioInput`：当前选择 → preferred → 单 ReSpeaker → fallback
- localStorage `facedev.voice.preferredAudioInput`（仅 deviceId/label）
- 主 Toolbar：Mic / Provider / 状态 / 单一主按钮；权限与刷新下沉 Advanced
- Audio Runtime / Provider protocol 0 change

## 3. 问题记录

- 无

## 4. 下一步计划

- Chrome 真机：首次授权 / 已授权 / 拔插 ReSpeaker / AssemblyAI / Deepgram

---

# 2026-09-30（Voice Interaction Console Final Polish）

## 1. 重点工作

- Voice Console Final Polish Pass：typography / activity bars / transcript / inspector / toolbar 精修

## 2. 关键进展

- Header Session 状态去重；Input Activity 20-bar deterministic mapping；Transcript 阅读流与行宽
- Inspector Runtime/Transport 主次层级；Select/Button/Focus/Scrollbar polish；无 Runtime / Provider 功能变更

## 3. 问题记录

- 无

## 4. 下一步计划

- 真机 Mock / AssemblyAI / Deepgram 目视验收

---

# 2026-09-29（Voice Interaction Console production polish）

## 1. 重点工作

- Voice Interaction Console production visual hierarchy rebuild（Precision Voice Studio）
- 移除误建的 Prototype surface / picker / 实验路由

## 2. 关键进展

- `?page=audioInput`：Voice Workspace（Idle / Listening / Transcript）+ System Inspector（Voice / Session / Runtime / Transport）
- Typography / spacing / surface hierarchy / Input Activity bars（由 RMS/Peak 确定性映射）
- Button / Select / Error / Advanced disclosure 交互抛光；无 Voice Runtime / Provider / Backend 功能变更
- 删除 `src/prototypes/voice-console/*` 与 `prototype-voice-console` 路由

## 3. 问题记录

- 无

## 4. 下一步计划

- 真机 Mock / AssemblyAI / Deepgram UI 验收

---

# 2026-09-29（Voice Interaction Console UI）

## 1. 重点工作

- Voice Interaction Console UI Refresh：调试面板升级为可长期承载对话调试的控制台布局

## 2. 关键进展

- Transcript / Conversation 提升为主区域；Session Control Bar + Live Status Rail
- Runtime / Provider 压缩为 Summary；完整字段移入 Advanced Runtime / Device Diagnostics
- Auto-scroll +「回到最新」；未修改 Voice Runtime / Provider contract / Backend

## 3. 问题记录

- 无

## 4. 下一步计划

- 真机 UI 验收后，再考虑目标 AI 平台接入

---

# 2026-09-29（Phase 3 / Step 2）

## 1. 重点工作

- Voice Interaction Debug Phase 3 Step 2：新增第二个真实 Streaming STT Provider — Deepgram Nova-3
- 验证 FaceDEV VoiceProvider 架构可替换性：Audio Runtime 零修改

## 2. 关键进展

- DeepgramProvider：`GET /api/voice/token?provider=deepgram` → temporary JWT
- Browser WebSocket：`wss://api.deepgram.com/v1/listen`，`Sec-WebSocket-Protocol: bearer + JWT`（非 token scheme，非 query token）
- 模型固定 `nova-3`，语言固定 `zh-CN`；`encoding=linear16` / `sample_rate=16000` / `channels=1` / `endpointing=300`
- Transport policy：标准 20 ms AudioFrame 直接 binary send（Frames RX ≈ WS Chunks TX）；对比 AssemblyAI 的 5×20 ms → 100 ms aggregation
- Results：`is_final` 与 `speech_final` 分离；`finalSegmentBuffer` + 中文友好 segment join；Stop 时 `Finalize` → `CloseStream`
- Provider Selector：Mock / AssemblyAI / Deepgram；会话运行中禁止切换
- Audio Runtime（capture / runtime / resampler / pcm16 / frame / worklet）保持 0 change

## 3. 问题记录

- Deepgram API Key 需 Member+ 权限才能签发 temporary token；权限不足时 backend 映射 `UPSTREAM_PERMISSION_DENIED`
- 真机 Chrome 验收（连接 / 中文 / 长句 / Start-Stop×5 / 5 分钟 / Provider Switch）需人工完成

## 4. 下一步计划

- 真机验收清单回填；不进入 TTS / Voice Agent

---

# 2026-09-29（Voice env）

## 1. 重点工作

- 修复 Voice API 开发环境 `.env` 自动加载：`npm run dev` 无需手工 `$env:ASSEMBLYAI_API_KEY`

## 2. 关键进展

- Vite `loadEnv(mode, root, "")` + `resolveVoiceServerConfig` DI 注入 middleware
- standalone `dev:voice-api` 同步读取 `.env` / `.env.local`
- 优先级：非空 process.env > `.env.local` > `.env`
- 空字符串环境变量不再挡住文件加载

## 3. 问题记录

- 此前仓库根目录常无真正的 `.env`（密钥误放 `.env.example` 或仅 shell 注入），导致 `MISSING_SERVER_API_KEY`

## 4. 下一步计划

- 无

---

# 2026-09-29（文档）

## 1. 重点工作

- 新增 Mic / Voice 开发与使用文档：`docs/VOICE_MIC_DEVELOPMENT_GUIDE.md`
- 已写入文档索引 `docs/README.md`

## 2. 关键进展

- 覆盖架构分层、Canonical 16 kHz PCM 帧、Mock/AssemblyAI 使用步骤、token API、自测命令与 Illegal invocation 踩坑

## 3. 问题记录

- 无

## 4. 下一步计划

- 真机验收结果可回填到该文档第 11 节清单

---

# 2026-09-29（Phase 2）

## 1. 重点工作

- Voice Interaction Debug Phase 2：最小 Backend temporary token + AssemblyAI v3 Streaming STT
- 验证「同一 Audio Runtime 仅新增 Provider Adapter 即可接入真实外部语音平台」

## 2. 关键进展

- Minimal backend：`GET /api/voice/token?provider=assemblyai`（Vite middleware + 可选独立 `server/voice`）
- API Key 仅 `ASSEMBLYAI_API_KEY` 环境变量；Browser 不持有长期密钥
- AssemblyAIProvider：temporary token → `wss://streaming.assemblyai.com/v3/ws` 直连
- 内部 AudioFrame 仍为 20 ms；Provider 内聚合成 100 ms / 3200 B binary chunk
- Turn → `transcript.partial` / `transcript.final`；Stop 发送 `Terminate`
- Mock Provider 保留；未接 LLM / TTS

## 3. 问题记录

- 真机中文转写与 5 分钟稳态需本地配置 API Key 后验收
- Mic1 硬件问题仍独立存在

## 4. 下一步计划

- 根据本阶段边界确认结果，再增加第二个真实 Provider 验证可替换性

---

# 2026-09-29

## 1. 重点工作

- Audio Input Debug 升级为 Voice Interaction Debug（语音交互调试）
- 建立平台无关前端 Audio Runtime + Mock Voice Provider
- ReSpeaker Browser Capture 已验证；物理 Mic1 问题确认为固件/硬件侧，不阻塞 Runtime

## 2. 关键进展

- Voice Runtime 标准格式：16 kHz / mono / PCM16LE / 20 ms（320 samples / 640 bytes）
- AudioWorklet 采集 Float32 → downmix → 流式线性重采样 → frame accumulator → AudioFrame
- MockVoiceProvider 只收帧校验与计数，不产假 transcript
- Device Diagnostics 收入 Advanced；主入口改为 Start / Stop Session

## 3. 问题记录

- 本阶段未接真实 AI Provider / Token / Backend / TTS
- Mic1 无响应保留为独立硬件问题

## 4. 下一步计划

- Minimal Voice Backend + temporary token + 真实 streaming Provider（如 AssemblyAI）
- 不改 AudioCapture / Worklet / Resampler / AudioFrame 主流程，只加 Provider Adapter

---

# 2026-09-23

## 1. 重点工作

- ReSpeaker Lite USB 音频通道诊断 PoC
- Audio Debug 增加 Native / Mono / Stereo Diagnostic
- 用 ChannelSplitter 分别读 CH0 / CH1 RMS、Correlation、Difference

## 2. 关键进展

- 默认仍保留 Mono，不破坏既有采集
- Stereo 请求 ideal:2，实际 channelCount 以 track.getSettings() 为准
- 物理 Mic1/Mic2 不默认映射到 USB CH0/CH1

## 3. 问题记录

- 真机 Mic1 / Mic2 响应差异的原因仍待通道诊断数据

## 4. 下一步计划

- 根据 Actual Channels + Correlation / Difference 决定是否按 mono 继续 Audio Runtime

---

# 2026-09-22

## 1. 重点工作

- ReSpeaker Lite 浏览器音频输入最小功能验证（Audio Input PoC）
- 新增独立调试页，不接 ASR / LLM / TTS
- 以 Track Settings 与 AudioContext.sampleRate 真实值为准，不硬编码 16 kHz

## 2. 关键进展

- 分支 `feature/respeaker-audio-poc`
- 页面入口：`?page=audioInput`（兼容 `audio-input` / `debug/audio-input`）
- 设备枚举、权限、Start/Stop、Level Meter、拔插与页面卸载释放麦克风

## 3. 问题记录

- 真机 Track Settings / AudioContext sampleRate 需在本机 Chrome / Edge 上实测后记录
- 本阶段不做重采样、AudioWorklet、上传或模型接口

## 4. 下一步计划

- 根据实测 sampleRate / channelCount / DSP flags 再定正式 Audio Runtime

---

# 2026-09-15

## 1. 重点工作

### 常用表情预设播放页 Phase 1

新增独立页面「常用表情」，定位为闭环 Preset 播放台（非关键帧编辑器）。

### 常用表情页面布局收口

重构 Library / Playback / Sequence 信息密度与卡片网格。

### Preset 动画资产来源审计

查清 builtin clip 真实来源，并冻结 Catalog metadata 与 animation asset 分离结构。

### 常用表情顶栏对齐

页头右侧补齐与面部绑定 / 表情编排一致的 `SC/ST Offline` 串口胶囊与「实时预览」开关。

### 常用表情切换为用户导入资产

产品 Library 改为 IndexedDB 用户预设；直接导入表情编排 frameProject JSON。

### IndexedDB Preset Library

本地持久化：导入 / 重命名 / 分类 / 替换动画 / 导出 / 删除。

### 当前预设 Preview 修复

去掉固定 `scale(0.36)` 裁切，改为 `fitMode="contain"` fit-to-container。

### 常用表情页改为双栏

页面改为左 Workspace（Preset Library + Playback Sequence）/ 右 Preview + 统一 Playback；约 40/60，主体 max-width ≈1520 居中。

### Sequence Playlist 实现重构

Sequence 正式为 Temporary Playback Playlist：Working Sequence（instanceId）与 immutable Playback Snapshot / Executor 分离。

### Preset Character Preview 补全 Neck

右栏 Preview 从 Face-only 升级为完整 Character Preview（Face Rig + 只读 Neck P/R/Y）。

### 左右栏比例与空间收口

左栏收至约 35%、右栏约 65%；Library content-driven 高度；Sequence 吃剩余空间；Preview/Playback 纵向再平衡。

### Preset Character Preview 重新设计

正式引入 `CharacterPresetPreviewStage`：统一 logical canvas + uniform contain scale；Neck 改为独立 square 只读呈现，不再拉伸 Editor Pad。

## 2. 关键进展

### Phase 1 播放页

- 顶部导航在「表情编排」与「追踪预览」之间增加「常用表情」。
- 复用现有 `playKeyframes` / `CharacterPose` / `dispatchCharacterHardware`，未新增第三套舵机动画系统。
- 支持单次 / 重复 N / 无限；Sequence 临时列表；无 Pause / Skip / Transition。
- 播放中禁止切换 Preset / 编辑 Sequence；离开页面自动 Stop + 回中。
- 引入 `physicalMotionOwner`，与 Tracking / Timeline / Binding / Calibration 互斥。

### Import / normalize / validate

- 导入格式：表情编排导出的 `robot-face-single-expression` frameProject v3（及 normalize 兼容旧版）。
- 链路：`File → JSON.parse → normalizeFrameProject → derive duration/scope/closedClip`。
- closedClip 由起止 Neutral 采样计算，不可手填；非闭环仍可导入，仅单次播放。

### Persistence / CRUD

- IndexedDB：`facedev-expression-presets`（可注入 memory storage 测）。
- API：list / get / save / delete / updateMetadata / replaceAsset。
- 替换保留 presetId / name / group；导出可再 Import。

### Builtin Demo

- 产品 Library **不再展示** 6 个 `BUILTIN_DEMO_CONTENT`。
- 源码与测试 fixture 保留（`listBuiltinDemoPresets`）。

### Preview 修复

- 根因：E 为主（全尺寸 Face Rig 塞入 compact 盒）+ A/B/C/D（固定 scale + overflow + 16:9）。
- 修复：`FaceRigPreviewCanvas` 增加 additive `fitMode="contain"`（复用 `useFaceRigPreviewScale`）；Preset Player 使用；不改 Full Editor Face Rig。

### 40/60 → 35/65 → 32/68 Workspace / Preview

- 左栏：Library / Sequence 均为 content-driven + max-height；允许下方留白，不再 flex 撑满。
- 右栏：Character Stage（~70%）+ Playback Dock（~30%）。
- 主体 max-width ≈1600px。

### Character Preview Stage

- Logical：860×740；Face 区 ~820×548；Neck pad 168²；Yaw 宽 300。
- Viewport：`scale = min(aw/lw, ah/lh)`，禁止非等比。
- Face：复用 `FaceRigPreviewCanvas` + `variant="preset"` compact CSS（不改 Editor）。
- Neck：`NeckReadOnlyPreview` 独立 Presentation（square pad + compact yaw），只消费 semantic pose。

### Character Preview（Face + Neck）

- IDLE：`samplePresetRepresentativeCharacterPose` 同 timestamp 采样 face+neck。
- PLAYING：`snapshot.lastCharacterPose` 同步驱动 Face / Neck。
- `CharacterNeckPreview` 复用 `NeckCharacterControls` 只读呈现；与物理连接无关。
- Face 使用 `variant="preset"`（更小 safePadding）；不改正式 Editor Face Rig。

### Sequence Working Model

- Item：`{ instanceId, presetId, repeatCount }`；同 preset 可多次加入；不复制 animation。
- Phase 1 不持久化；刷新清空 Sequence，保留 User Presets。

### Playback Snapshot

- Play Sequence 时 `createSequencePlaybackSnapshot`：immutable `sequenceRunId` + items + mode。
- 校验：preset 存在 / 有效 / closedClip / repeatCount；失败拒绝整段播放。

### Sequence Executor

- Controller：`activeSequenceSnapshot` + loop/item/itemRepeat；逐 clip await natural complete。
- 无额外长 Neutral delay；完成后一次 Neutral → IDLE。

### Cancel generation

- Stop：`playbackGeneration++`，清空 active snapshot，取消 clip / 续播；旧 callback 不得启动下一项。

### tests/build/commit

- Tests: expressionPresetPlayback + expressionPresetImport 62 pass / 0 fail
- build:faceconsole-web: PASS
- Commit: `refactor: redesign preset character preview stage`（feature/expression-preset-page）

## 3. 问题记录

- Sequence 仍不持久化；无 Transition / Official Preset / 云同步。
- Transition 尚未实现；Item 之间直接 closed→closed 衔接。
- open clip 限制：不可 Repeat / Sequence（无 Transition Engine）。
- Demo content 源码暂留，后续可再清理。
- Import Confirm 使用轻量 dialog；重命名/分类暂用 `prompt`（可后续换成同风格 modal）。
- Face Preview 仍复用 Editor primitives（compact variant）；若 1920 仍偏小，可再抽完全独立的 FaceRigReadOnlyView。

## 4. 下一步计划

- 人工验收：2048×1144 / 1920×1080 — Face 可读、Neck 正方形、Library/Sequence 无巨大空白。
- 评估 Official Preset 与「另存为 Preset」流水线。
- 视需要美化重命名/分类弹窗与 Sequence 持久化（Saved Expression Playlist）。
- 不创建其它阶段文档。
