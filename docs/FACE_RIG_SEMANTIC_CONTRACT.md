# Face Rig v1 语义约定（节选）

本文档描述 **面控语义** 与 **舵机绑定** 的职责边界，便于 Tracking / Binding 分层调试。完整控件树见源码 `createInitialEliteRig` 与 profile。

## sharedRadar（双眼共同视线）

`rig.sharedRadar` 为 **百分比平面** 上的目标点，用于驱动左右眼 **共同** 的注视方向（具体舵机通道由 **Face Rig Binding** 定义）。

| 字段 | 语义 |
|------|------|
| `x = 50` | 水平居中（正视前方语义） |
| `x < 50` | 向左看 |
| `x > 50` | 向右看 |
| `y = 50` | 垂直居中 |
| `y < 50` | 向上看 |
| `y > 50` | 向下看 |

**数值范围**：`x`、`y` 各在 **0～100**（与前端 `normalizeEliteRig` 一致）。

**Python MediaPipe 第一版**：通过 iris 与眼眶参考点做简单几何估算，将结果 **限幅在较小区间**（默认约 `x∈[30,70]`、`y∈[30,70]`，见 `mediapipe_mapping.default.json` 的 `limits.eyeLookX` / `eyeLookY`），避免眼球动作过大。后续可单独调 `gains` / `deadzone` / `invert` / `neutral`。

**不可用时的行为**：无 landmarks、点数不足 478、或 `gaze.enabled === false` 时，`debug.gaze.available === false`，`rig.sharedRadar` 保持 **(50, 50)**，服务不抛错。

## 视线与眼睑

- **眨眼**：`eyeBlinkLeft` / `eyeBlinkRight` blendshape 经 neutral / deadzone / gain / invert 得到 **blink 强度**（0～100），再与配置 **`eye.openBias*`**、**`lowerLidOpenRatio`**、**`lowerLidCloseRatio`** 组合写入 **`rig.eyeL` / `rig.eyeR`** 的 **`up` / `lo`**（约 −100～100）。**建议先 `--calibrate-neutral`**，使自然脸 blink 强度接近 0，**openBias** 才能让眼睛默认更大；可选 **`eye.useEyeWide`** 将 **`eyeWide*`** 叠加到上睑（默认关闭，宽眼仅进 **`debug.blendshapes`**）。**`debug.mapping`** 含 **`eyeLUp` / `eyeLLo` / `eyeRUp` / `eyeRLo`** 便于对照。若控件方向对但舵机方向反，在 **Binding** 层处理。
- **视线**：由 **landmarks / iris** → `debug.gaze` → **`rig.sharedRadar`**，不写入眼睑通道。
- **眉**：**`browInnerUp`** 与左右 **`browOuterUp*`** 经 neutral 后得到内/外侧强度，写入 **`browL` / `browR`** 的 **`tip` / `mid` / `tail`**（0～100）。**`leftTipChannel`** 接收内侧（眉头语义）强度，**`leftTailChannel`** 接收外侧（眉尾）强度，**`mid`** 为内外加权；左右通道名可在 JSON 中交换。
- **上/下唇**：**`mouthUpperUp*`** 映射为 **`rig.mouth.UL` / `UR`**（单极 0～100，与 `debug.mapping.upperLip*` 一致）。**`mouthLowerDown*`** 在 Python 服务中先经单极 pipe，再写入 **`rig.mouth.LL` / `LR` 为 signed −100～0**（下拉越大越负），以便与前端 **`mouth_ll` / `mouth_lr`（signed100）** 及常见绑定极性一致；**`debug.mapping.lowerLip*`** 与写入 rig 的数值一致。**`mouthPucker` / `mouthFunnel`** 第一版仅进入 **`debug.mapping`** 与 blend 调试，**不参与** rig 控件驱动。

## 与舵机（Binding）的关系

- **MediaPipe 映射层**只输出 **语义 rig**（含 `sharedRadar`）及 **调试字段** `debug.gaze` / `debug.mapping`。
- **实体舵机方向、PWM 区间、正负极性** 一律在 **Face Rig Binding**（及 `logicalPose`）中处理；若上下左右反了，优先调 **`invert.eyeLookX` / `invert.eyeLookY`** 或绑定表，而不是在协议层写死舵机方向。
- **rawFrameRig 正确 ≠ 舵机表现正确**：同一 rig 经不同 **servoId** 绑定、**rangeMode**（full / custom）与 **percent** 通道中性附近的增益，会得到截然不同的 **PWM**。**percent** 通道以 **50 为中性**；在 **48～52** 一类小摆动下，若绑定正负目标距中性很近，**单通道逻辑增量可能低于几十微秒**，实机几乎无感。多个控件绑定到 **同一 servoId** 时，逻辑上为 **增量叠加**，易出现「抢舵机」或某一通道被淹没。调试时请使用应用内 **Servo Output Inspector**（见 [MAPPING_DEBUG_GUIDE.md](./MAPPING_DEBUG_GUIDE.md) 阶段 2.7）核对 **Face Rig → PWM** 全链路。

## 调试字段（`tracking.rigFrame.debug`）

- **`debug.gaze`**：`available`、`eyeLookX`/`eyeLookY`（融合后约 −1～1）、左右眼分量等；见 [TRACKING_PROTOCOL.md](./TRACKING_PROTOCOL.md)。
- **`debug.mapping`**：在 jaw / blink / smile / brow 外，可含 **眼睑**（`eyeOpenBias*`、`eyeLUp` / `eyeLLo` / `eyeRUp` / `eyeRLo`）、**眉细分**、**唇**、**仅调试** 的 **`mouthPucker` / `mouthFunnel`**，以及 **`eyeLookX` / `eyeLookY`**、**`sharedRadarX` / `sharedRadarY`** 等。

当前视线估算是 **第一版几何近似**，精度与稳定性依赖模型与标定；后续迭代可能引入平滑或头部姿态补偿。
