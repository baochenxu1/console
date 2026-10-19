# FaceDEV 文档索引

| 文档 | 说明 |
|------|------|
| [BUS_SERVO_CENTER_POSITION.md](./BUS_SERVO_CENTER_POSITION.md) | **总线舵机中位 / 行程**：装配 90° vs SC/ST/RJ 协议坐标、前端 ID/设中位、Python 零点+行程边界 |
| [BUS_SERVO_BINDING_PROTOCOL_PITFALLS.md](./BUS_SERVO_BINDING_PROTOCOL_PITFALLS.md) | **型号接入踩坑**：同 ID 多协议误选、绑定 PWM≠协议 ticks、RJ time/defer、新增舵机检查清单 |
| [ARCHITECTURE_OVERVIEW.md](./ARCHITECTURE_OVERVIEW.md) | **全工程架构总结**：模块职责、核心数据模型与链路、安全机制、进度边界 |
| [DISTRIBUTION_PACKAGING.md](./DISTRIBUTION_PACKAGING.md) | 发给外部的 zip 结构、`dist:release`、验收清单 |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | 目录职责、数据流、构建产物边界 |
| [PROJECT_TREE.md](./PROJECT_TREE.md) | 排除生成物后的项目树（`npm run tree:docs` 更新） |
| [RELEASE_CHECKLIST.md](./RELEASE_CHECKLIST.md) | 发布与回归检查清单 |
| [SDK_QUICK_START.md](./SDK_QUICK_START.md) | 构建、打包、安装 SDK 与最小集成 |
| [SDK_API.md](./SDK_API.md) | 引擎与 React 组件 API 摘要 |
| [TRACKING_PROTOCOL.md](./TRACKING_PROTOCOL.md) | `tracking.rigFrame` 与 RigState 约定 |
| [FACE_RIG_SEMANTIC_CONTRACT.md](./FACE_RIG_SEMANTIC_CONTRACT.md) | Face Rig v1 语义（含 sharedRadar / gaze 与 Binding 边界） |
| [PYTHON_TRACKING_SERVICE.md](./PYTHON_TRACKING_SERVICE.md) | Python Mock / MediaPipe 服务启动 |
| [MAPPING_DEBUG_GUIDE.md](./MAPPING_DEBUG_GUIDE.md) | 记录 MediaPipe debug、mapping、rig、logicalPose，辅助后续映射校准 |
| [GAZE_IRIS_ONLY_V1_FREEZE.md](./GAZE_IRIS_ONLY_V1_FREEZE.md) | **Gaze Iris-only V1 冻结**：参数基线、问题根因、恢复方式 |
| [MOUTH_CORNER_FIVEBAR_V1_FREEZE.md](./MOUTH_CORNER_FIVEBAR_V1_FREEZE.md) | **嘴角 FiveBar V1 冻结**：flip/中位/7·8 路由、标定流程、恢复方式 |
| [CLOUDFLARE_PAGES_STAGING.md](./CLOUDFLARE_PAGES_STAGING.md) | **Web Staging Phase 1**：Cloudflare Pages Preview、构建配置、HTTPS smoke |
| [BROWSER_NATIVE_NECK_RUNTIME.md](./BROWSER_NATIVE_NECK_RUNTIME.md) | **Browser-Native Neck Runtime**：R1～R4.2 合并文档（Core / Protocol / WebSerial / Worker / 软件中性标定） |
| [VOICE_MIC_DEVELOPMENT_GUIDE.md](./VOICE_MIC_DEVELOPMENT_GUIDE.md) | **Voice / Mic**：语音交互调试架构、Canonical PCM 格式、Mock/AssemblyAI 使用与踩坑 |

根目录 [README.md](../README.md) 含仓库级说明与三种使用方式总览。

**干净项目树**（控制台）：在仓库根目录执行 `npm run tree:clean`。
