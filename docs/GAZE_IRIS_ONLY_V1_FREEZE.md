# Gaze Iris-Only V1 冻结说明

**冻结日期**：2026-06-29  
**验证数据**：`tracking-diagnostic-ai-review-2026-06-29T08-28-09-236Z.json`（固定方向 + 眨眼）

---

## 冻结范围（已纳入 V1）

### 生产链路

- **Iris-only 眼球追踪**：`tools/tracking_service/gaze_iris_only.py`（`mediapipe_iris_only_v1`）
- 调用入口：`mediapipe_to_rig.py` → `apply_mediapipe_iris_only_gaze()`
- 配置基线：`mediapipe_mapping.default.json` / `mediapipe_mapping_config.py` 中 `gaze.*`
- **Start/Stop 生命周期**：前端 `useTrackingPreviewCamera.js` + 服务端 `resetIrisGaze` / `iris_gaze_armed`
- **眨眼冻结**：instant hold + latch hold + release blend 三层门控

### 明确不在 V1 范围

- eye-corner / legacy gaze 校准 UI
- session neutral 五方向校准
- servo binding 改动

---

## 参数基线（V1 勿随意改）

| 参数 | 值 | 作用 |
|------|-----|------|
| `irisEmaAlpha` | 0.58 | 追踪响应（原 0.45 偏慢） |
| `irisMaxStepSharedRadar` | 10 | 单帧最大步进 |
| `blinkFreezeEnterThreshold` | 0.48 | latch 冻结进入 |
| `blinkInstantHoldThreshold` | 0.42 | 逐帧即时冻结（上升沿） |
| `blinkFreezeReleaseThreshold` | 0.38 | 释放判定（需低于半闭眼） |
| `blinkFreezeReleaseHoldFrames` | 3 | 连续低 blink 帧数才释放 |
| `blinkFreezeMaxFrames` | 10 | 单次最长冻结 |
| `blinkReleaseBlendFrames` | 2 | 释放后平滑过渡 |

---

## 诊断预期（V1 验收参考）

固定方向 + 眨眼录制，应接近：

- `iris_tracking` ≈ 45–50%
- `iris_blink_hold` + `iris_blink_instant` + release 系列 ≈ 45–50%
- 冻结段跳变 avg **< 1.5**；追踪段跳变 avg **3–5**
- 冻结段 `candidate` 与 `emit` 有明显差距（内部目标动、输出 hold）

---

## 之前为什么一直出问题

问题不是单点 bug，而是 **iris 几何、MediaPipe blendshape 分布、状态机、前后端生命周期** 几层叠在一起。按时间线：

### 1. 追踪几乎不动 / 方向反 / 饱和钉死

| 现象 | 根因 |
|------|------|
| sharedRadar 几乎不变 | 左右眼 local 坐标镜像后做 **median 融合**，双眼差分相互抵消 |
| 贴 30/70 饱和 | iris gain 过高 + 硬限幅，小 delta 直接顶满 |
| Y 下视弱 | 几何上视:下视幅度约 3:1，未分轴增益 |

### 2. Start 后无法重新采集 / 眼球全程 50/50

| 现象 | 根因 |
|------|------|
| 再点 Start 不 warmup | Stop 未作废 session；或 `resetIrisGaze` 在 WS 未连上时丢失 |
| 诊断全 `iris_disarmed` | 引入 `iris_gaze_armed` 后，armed 信号未在每帧同步到 `gaze_state` |

### 3. 眨眼冻结第一轮：要么一直冻，要么看不出在冻

**MediaPipe `eyeBlink` 关键事实（本机实测）**：

- 睁眼 resting：**0.25–0.35**
- 半闭眼 / 眨眼过程：**0.40–0.55**
- 闭眼峰值：**0.65–0.85**

在此分布下，前几版冻结策略犯了相反方向的错：

| 版本 | 配置问题 | 结果 |
|------|----------|------|
| 初版 blink gate | 阈值 **0.35 / 0.22** | 把 resting 当眨眼 → 长期 soft-freeze，像「一直卡住」 |
| latch 0.52 + release **0.30** | 释放低于 resting 不可能达到 | 冻结后 **20+ 帧** 才释放，主观「延迟 / 卡顿」 |
| 为减延迟收紧 | `max_frames=6`、enter **0.52** 偏高 | 冻结只有 **1–3 帧**，上升沿仍在 tracking → 「看不出在作用」 |

### 4. 延迟感（数据可证）

- EMA 0.45 + maxStep 8 → 方向突变 **~280–600 ms** 才跟满
- 冻结 + release_blend 占录制 **40%+** 时，输出大量静止帧
- 释放瞬间 candidate 与 emit 差 **5–30**，无 blend 时大跳变

---

## 这次为什么解决了

### 追踪层（非眨眼）

1. **双眼差分融合** `(left - right) * 0.5`，避免 median 抵消
2. **tanh 软限幅 + 分轴 Y gain**，下视/上视分开标定
3. **Start 才 armed + Stop 作废 warmup**，WS 就绪后再发 `resetIrisGaze`
4. **略提高响应**：EMA **0.58**、maxStep **10**（仅影响非冻结段）

### 眨眼冻结层（核心）

采用 **三层门控**，阈值按 blendshape 实际分布标定，而不是照搬 legacy 0.90/0.70：

```
眨眼上升沿          闭眼峰值              睁眼恢复
    │                  │                    │
    ▼                  ▼                    ▼
 instant ≥0.42    latch ≥0.48          release ≤0.38 ×3帧
 (单帧 hold)      (snapshot 冻结)      + blend 2帧回追踪
                  max 10帧兜底
```

1. **`iris_blink_instant`（≥0.42）**  
   不依赖 latch 状态机，当帧直接 hold 上一帧输出 → 抓住上升沿，避免「先动一下再冻」

2. **`iris_blink_hold`（latch ≥0.48）**  
   进入时 snapshot sharedRadar + norm；冻结期间 **仍跑 iris 内部计算**，只覆盖输出 → 释放时有正确目标

3. **释放：≤0.38 连续 3 帧 + `release_blend` 2 帧**  
   - 0.38 **高于** resting（~0.32），**低于** 半闭眼（~0.45）→ 不会长期误锁，也不会一眨眼就解  
   - blend 消除释放大跳变

4. **`max_frames=10`**  
   长眨眼不会中途掉回 tracking 吃脏 iris 几何

### 数据印证（08-28-09）

| 指标 | 数值 |
|------|------|
| 追踪 / 冻结 | 30 / 30 帧（各 ~47%） |
| 追踪跳变 avg | 4.2 |
| 冻结跳变 avg | **0.9** |
| 冻结 cand-emit | 5.2（内部动、输出钉住） |

---

## 关键文件

| 文件 | 职责 |
|------|------|
| `tools/tracking_service/gaze_iris_only.py` | iris 信号 + warmup + blink 状态机 + sharedRadar |
| `tools/tracking_service/mediapipe_to_rig.py` | iris-only 生产分支 |
| `tools/tracking_service/mediapipe_tracking_server.py` | `resetIrisGaze` / `iris_gaze_armed` |
| `src/sdk/react/trackingPreview/useTrackingPreviewCamera.js` | Start/Stop 控制 |
| `mediapipe_mapping.default.json` | 参数基线 |

---

## 启动方式（V1 基线）

```bash
python mediapipe_tracking_server.py --source idle
```

映射预览页 **Source** 切换 Camera / Video；Camera 页 **Start** 触发 iris warmup + 追踪，**Stop** 回 idle 并重置采集。

---

1. **帧率依赖**：~13–18 fps 下，2 帧 blend ≈ 110–150 ms；高帧率相机可酌情缩短 `blinkReleaseBlendFrames`。
2. **个体 blink 基线差异**：不同人 resting blink 可能 0.28–0.38；若误冻可微调 `blinkInstantHoldThreshold` → 0.45。
3. **诊断字段**：部分 export 未含 `frozenByBlink` / `irisGazeArmed`，以 `outputMode` 为准。

---

## 后续若需调整（非 V1）

- 真机舵机侧抖动 → device drive / bus pipeline，与 gaze 层分开调
- 更激进眼动响应 → 先动 `irisEmaAlpha`，**勿单独**降低 blink 阈值
- 更强冻结 → 先动 `blinkInstantHoldThreshold`，**勿单独**降低 release 阈值（会带回误锁）
