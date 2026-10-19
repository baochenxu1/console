# Tracking 协议：`tracking.rigFrame`

## 1. 消息类型

前端与 Python 跟踪服务之间传递的 JSON 消息须满足统一结构，**`type` 固定为** `tracking.rigFrame`。

## 2. 示例 JSON

```json
{
  "type": "tracking.rigFrame",
  "source": "python-mediapipe",
  "timestampMs": 123456,
  "faceDetected": true,
  "quality": 0.92,
  "rig": {
    "browL": { "tip": 0, "mid": 0, "tail": 0 },
    "browR": { "tip": 0, "mid": 0, "tail": 0 },
    "eyeL": { "up": 0, "lo": 0 },
    "eyeR": { "up": 0, "lo": 0 },
    "sharedRadar": { "x": 50, "y": 50 },
    "mouth": {
      "UL": 0,
      "UR": 0,
      "LL": 0,
      "LR": 0,
      "sideL": { "x": 50, "y": 50 },
      "sideR": { "x": 50, "y": 50 }
    },
    "tongue": { "val": 0 },
    "jaw": { "val": 0 }
  }
}
```

`rig` 必须与当前工程 **Face Rig 控件状态（Elite Rig）** 结构兼容，以便 `FaceExpressionEditor` 等在「Drive Rig」开启时合并校准后写入 `rig` state。

**`type`、`source`、`timestampMs`、`faceDetected`、`quality`、`rig` 为必选语义字段**；下述 `debug` 为 **可选扩展**，不改变既有基础字段含义。

---

## 2.1 可选字段 `debug`（阶段 2.5+）

当 **`source` 为 `python-mediapipe`** 且 **`faceDetected` 为 `true`** 时，Python 服务可附加 **`debug`**，供前端 **MediaPipe Debug** 折叠区展示；**不参与** `rig` 归一化与舵机下发。

示例（节选）：

```json
{
  "type": "tracking.rigFrame",
  "source": "python-mediapipe",
  "timestampMs": 123456,
  "faceDetected": true,
  "quality": 0.92,
  "rig": { },
  "debug": {
    "blendshapes": {
      "jawOpen": 0.23,
      "eyeBlinkLeft": 0.1,
      "eyeBlinkRight": 0.08,
      "eyeWideLeft": 0.02,
      "eyeWideRight": 0.02,
      "mouthSmileLeft": 0.3,
      "mouthSmileRight": 0.29,
      "mouthUpperUpLeft": 0.05,
      "mouthUpperUpRight": 0.04,
      "mouthLowerDownLeft": 0.03,
      "mouthLowerDownRight": 0.03,
      "mouthPucker": 0.01,
      "mouthFunnel": 0.01,
      "mouthClose": 0.0,
      "browInnerUp": 0.12,
      "browOuterUpLeft": 0.1,
      "browOuterUpRight": 0.11
    },
    "mapping": {
      "jaw": 35,
      "blinkLeft": 20,
      "blinkRight": 18,
      "smileLeft": 42,
      "smileRight": 40,
      "browLeft": 12,
      "browRight": 13,
      "eyeOpenBiasLeft": 20,
      "eyeOpenBiasRight": 20,
      "eyeLUp": 18.5,
      "eyeLLo": -4.2,
      "eyeRUp": 18.2,
      "eyeRLo": -4.0,
      "browInner": 10,
      "browOuterLeft": 8,
      "browOuterRight": 9,
      "browLeftTip": 11,
      "browLeftMid": 9,
      "browLeftTail": 7,
      "browRightTip": 11,
      "browRightMid": 9,
      "browRightTail": 8,
      "upperLipLeft": 0,
      "upperLipRight": 0,
      "lowerLipLeft": 0,
      "lowerLipRight": 0,
      "mouthPucker": 0,
      "mouthFunnel": 0,
      "eyeLookX": 0.05,
      "eyeLookY": -0.02,
      "sharedRadarX": 52.5,
      "sharedRadarY": 49.0
    },
    "gaze": {
      "available": true,
      "eyeLookX": 0.12,
      "eyeLookY": -0.08,
      "leftEyeX": 0.10,
      "leftEyeY": -0.05,
      "rightEyeX": 0.14,
      "rightEyeY": -0.11
    }
  }
}
```

| 子字段 | 说明 |
|--------|------|
| `debug.blendshapes` | MediaPipe 原始 blendshape 分数（约 0～1），含眼宽、唇相关键等；缺失键按 0；前端 `normalizeRigFrameMessage` 会裁剪到合法范围。 |
| `debug.mapping` | 映射管线后的中间量（jaw、blink、smile、brow 细分、唇、**openBias**、**眼睑 rig 镜像** `eyeLUp`/`eyeLLo`/`eyeRUp`/`eyeRLo`、**仅调试** 的 pucker/funnel、**视线** `eyeLookX`/`eyeLookY`、`sharedRadarX`/`sharedRadarY` 等），用于调参对照；**不**单独驱动舵机。 |
| `debug.gaze` | **可选**：iris 几何估算的视线调试块（`available`、`eyeLookX`/`eyeLookY`、左右眼分量等）；不可用时 `available=false`。 |

`faceDetected === false` 时建议 **省略 `debug`** 或传空对象 `{}`；轻量测试服务可不发送 `debug`。

### 2.2 `debug.gaze`（阶段 2.5-B）

与 **眨眼 blendshape** 分离；仅描述 **landmark/iris 推导的视线语义**（融合值约在 −1～1 的归一化图像空间）。`rig.sharedRadar` 的语义与限幅见 [FACE_RIG_SEMANTIC_CONTRACT.md](./FACE_RIG_SEMANTIC_CONTRACT.md)。

---

## 3. `source` 可选值

| 取值 | 说明 |
|------|------|
| `python-websocket` | Python 通用 WebSocket 源 |
| `python-mediapipe` | Python MediaPipe 跟踪服务 |
| `mediapipe-web` | 预留：浏览器内 MediaPipe |
| （其它字符串） | 实现方可自定义，前端作展示透传 |

---

## 4. 字段说明（RigFrame 摘要）

| 字段 | 说明 |
|------|------|
| `type` | 必须为 `tracking.rigFrame` |
| `source` | 见上表 |
| `timestampMs` | 毫秒时间戳 |
| `faceDetected` | 是否检测到人脸 |
| `quality` | 0～1 置信度或质量占位 |
| `rig` | 与 Face Rig 一致的控件树 |
| `debug` | 可选；见 §2.1，仅调试展示 |

---

## 5. `faceDetected === false` 时的处理原则

1. **Tracking 服务**仍可发送帧（例如保持 last pose 或中性），由前端策略决定是否应用。
2. **前端在驱动 Rig / 舵机输出时**：不应在 `faceDetected === false` 时把该帧当作「有效跟踪」去更新下游舵机目标；当前 `FaceExpressionEditor` 内对 **未检测到脸** 的帧采用**保持/校准链**策略，避免抖动误触发（实现细节见源码 `handleTrackingFrame`）。
3. **Python 服务**只负责输出 RigFrame，**不**生成舵机命令、**不**写串口。

---

## 6. 服务职责边界

1. **Tracking Service 只输出 RigFrame**，不生成舵机 PWM、不组装串口协议帧。
2. **舵机命令**由宿主在 `logicalPose` 确定后，经 `protocol`（如 `buildServoCommandFromPose`）与既有 WebSerial 路径下发（若启用）。
3. **JSON 字段名与 `rig` 结构**应与前端 `normalizeRigFrameMessage` 等保持一致；**可选 `debug`** 为扩展字段，不改变既有基础键语义。

---

## 7. 与 MediaPipe 映射的关系

MediaPipe blendshape 与 **face landmarks（含 iris 时）** → `rig` 的数值映射由 **`tools/tracking_service/mediapipe_mapping*.json`** 与 `mediapipe_to_rig.py` 实现（**视线**写入 `rig.sharedRadar`，**眨眼**仍仅用 blink blendshape；**眼睑开度**由 blink 与 **`eye.openBias*`** 合成；**眉**写 **`brow*.tip/mid/tail`**；**唇**写 **`mouth.UL/UR/LL/LR`**；**pucker/funnel** 仅进 **`debug.mapping`**）；可通过 **gain / invert / neutral / deadzone / limits**、**`gaze` / `eye` / `brow` / `lip`** 段与 **`--calibrate-neutral`**（见 `docs/PYTHON_TRACKING_SERVICE.md`）迭代调参。**本仓库当前阶段不提供**前端 Mapping 可视化编辑器（规划见阶段 2.6）。
