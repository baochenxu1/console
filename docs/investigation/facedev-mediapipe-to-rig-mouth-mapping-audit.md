# FaceDEV P0.0-A：MediaPipe → Rig → FaceControlCommand 嘴部映射关系审计

**状态**：Analysis only — no code changes applied  
**日期**：2026-07-22  
**范围**：只分析、梳理与报告；禁止任何修复或参数改动  

---

## 1. Executive Summary

**现象**：`conversation_ff` / Signal Curves 中 `mouth.sideL.x` 与 `mouth.sideL.y`（以及右侧镜像对）整段保持固定线性关系，近似：

\[
\begin{aligned}
\text{sideL.y} &= 50 + \tfrac{5}{7}\,(\text{sideL.x} - 50) \\
\text{sideR.y} &= 50 - \tfrac{5}{7}\,(\text{sideR.x} - 50)
\end{aligned}
\]

表面四个通道（左/右 × X/Y）实际只有 **约 2 个有效自由度**（左右各一个 smile 标量）。

**最可能问题层（已由代码唯一定位）**：Python `tools/tracking_service/mediapipe_to_rig.py` 内 **Face Rig v1 对角线嘴角 pad 展开**——将 `mouthSmileLeft/Right` 经 `_pipe_unipolar_strength` 得到的单标量，用硬编码系数 `0.35` / `0.25` 同时写入 `side*.x` 与 `side*.y`。

**是否设计问题**：**是有意的“对角线微笑 pad 模型”**（注释写明「微笑时略向上提」），不是 Signal Curves / FCC 导出字段误贴。但该设计与后续 **二维 pad + Five-bar IK** 语义冲突：数据结构是 2D，感知源仍是 1D。

**是否影响真机**：**是**。`previewRig` → `buildFaceControlCommandFromRig` **原样复制** `mouth.sideL/R`；`mapFaceRigToPose` → `computeMouthCornerFiveBarIk` 接收该 2D pad 并驱动舵机。耦合已进入执行目标，不是纯诊断显示问题。

**是否阻塞闭环**：对「独立二维嘴角 / 真 4D 嘴角轨迹 / Whole-Mouth Contour」类闭环与几何评估 **阻塞**；对「沿固定微笑斜线的嘴角」仍可驱动机构。

**样本文件**：仓库及本机常见路径未找到 `signal-curves_20260722_113716.json`；§6 给出代码系数的解析验证。若用户提供该文件路径，可补跑离线统计而不改代码。

---

## 2. Architecture Diagram

```text
MediaPipe Face Landmarker
  ├─ face_landmarks (归一化 x/y/z；嘴角 landmark 几何可用但未驱动 side*)
  └─ face_blendshapes
       ├─ mouthSmileLeft / mouthSmileRight  ──► smile_*_val (0~100 单标量)
       ├─ jawOpen / mouthOpen / funnel …   ──► jaw / scenario / lip（不改写 side* XY）
       └─ mouthUpperUp* / mouthLowerDown*  ──► UL/UR/LL/LR（独立于 side*）

mediapipe_to_rig.map_result_to_rig  ★ First Collapse
  smile_L → sideL.{x,y} = 50 ∓ smile*0.35 / 50 − smile*0.25
  smile_R → sideR.{x,y} = 50 ± smile*0.35 / 50 − smile*0.25

WebSocket tracking.rigFrame
  └─ normalizeRigFrameMessage (trackingMapper.js)  clampPct 透传 XY

useTrackingPreviewCamera
  ├─ videoNeutral (可选：相对 baseline 减法；按轴独立，比例可保留)
  ├─ applyTrackingCalibration (按轴 smoothPct)
  ├─ videoSourceTuning / jawPatch（jaw 为主；mouth clamp 不以 side 峰值为据）
  └─ previewRig

buildFaceControlCommandFromRig
  FCC.mouth.sideL/R = previewRig.mouth.sideL/R   （复制，无二次展开）

rigValuesFromEliteRig → mapFaceRigToPose
  mouth_corner_l/r.{x,y} ← sideL/R
  → computeMouthCornerFiveBarIk(pad 2D) → PWM → DeviceBus / Servo
```

**感知耦合 vs 机构耦合（不得混谈）**

| 类型 | 位置 | 内容 |
|------|------|------|
| 感知映射耦合 | `mediapipe_to_rig.py` | 1 标量 → 固定方向 2D pad（0.35/0.25） |
| 机构运动学耦合 | `mouthCornerKinematics.js` | 任意 pad (x,y) → 五杆双舵机；**不**自行把标量展成斜线 |

---

## 3. Field Lineage（字段血缘表）

单元格格式：`文件 · 函数 · path · 等效公式`

| 阶段 | 左 X | 左 Y | 右 X | 右 Y | Jaw |
|------|------|------|------|------|-----|
| MediaPipe Raw | Landmark 嘴角点存在但 **未用于 side***；Blend `mouthSmileLeft` ∈≈[0,1] · `extract_debug_blendshapes` / `get_blendshape_score` | 同左：无独立 Y blend；smile 为单通道 | `mouthSmileRight` | 同右 | `jawOpen`（及可选 `jaw_open`）blend |
| Geometry | `landmarks_to_mouth_corners` **stub → (0,0,0,0)** 且 **全库无调用**；`mouth_pose_frame` / lip 用 `mouthWidth` 等服务 lip/jaw，**不写 side*** | 同左 | 同右 | 同右 | `jaw_geometry` / aperture 证据 → `rig.jaw` |
| Neutralized (Python) | `smile_l_cent = mouthSmileLeft − neutral.mouthSmileLeft` · mapping JSON | 同左（仍为标量） | `smile_r_cent` | 同右 | `jawOpen − neutral` |
| Tracking Rig (Python 写出) | `mediapipe_to_rig` · `50 − smile_l_val×0.35` · `rig.mouth.sideL.x` | `50 − smile_l_val×0.25` · `sideL.y` | `50 + smile_r_val×0.35` · `sideR.x` | `50 − smile_r_val×0.25` · `sideR.y` | 后续 `apply_jaw_geometry_drive` · `rig.jaw.val`（**不改 side***） |
| WS / Adapter | `trackingMapper.normalizeEliteRig` · `clampPct(sideL.x)` | `clampPct(sideL.y)` | `clampPct(sideR.x)` | `clampPct(sideR.y)` | `jaw.val` clamp |
| Postprocess Rig | `videoNeutral`：`x−baseline.x`（可选）；`smoothPct` 按轴；tuning 对 side 可能 `×f`（仅当 lip 触发 mouth clamp） | 同左 Y | 同右 | 同右 | `jawPatch` 可改 jaw |
| Face Rig / previewRig | 上表透传结果 | 同左 | 同右 | 同右 | `jaw.val` |
| FaceControlCommand | `diagnosticCommandRecording.buildFaceControlCommandFromRig` · `rig.mouth.sideL` 复制 · `fcc.rig.mouth.sideL.x` | `.y` 复制 | `sideR.x` 复制 | `.y` 复制 | `fcc.rig.jaw.value ← rig.jaw.val` |
| Mouth IK Input | `rigValuesFromEliteRig` → `mouth_corner_l.x`；`rigValuesForMouthCorner` | `mouth_corner_l.y` | `mouth_corner_r.x` | `.y` | 不进入嘴角 IK |
| Servo | Five-bar → PWM A/B（左 18/19，右 7/8 等） | 同左 | 同右 | 同右 | jaw 绑定（如 servo 15）独立 |

---

## 4. Mathematical Mapping

### 4.1 Smile 标量管线

\[
\begin{aligned}
s_L &= \mathrm{pipe\_unipolar}(\texttt{mouthSmileLeft} - N_L;\ \mathrm{dz},\ g_L,\ \mathrm{inv}_L,\ [0,100]) \\
s_R &= \mathrm{pipe\_unipolar}(\texttt{mouthSmileRight} - N_R;\ \ldots)
\end{aligned}
\]

其中 `pipe` ≈：deadzone → gain → ×100 → clamp → 可选 unipolar invert。  
默认：`N=0`，`dz=0.03`，`g=1`，`inv=false`（`mediapipe_mapping.default.json`）。

### 4.2 Pad 展开（First Collapse / 伪 4D）

```text
# mediapipe_to_rig.py ~2502–2519
sideL.x = clamp(50 - s_L * 0.35, 0, 100)
sideL.y = clamp(50 - s_L * 0.25, 0, 100)
sideR.x = clamp(50 + s_R * 0.35, 0, 100)
sideR.y = clamp(50 - s_R * 0.25, 0, 100)
```

未 clamp 时：

\[
\frac{y_L-50}{x_L-50}=\frac{-0.25\,s_L}{-0.35\,s_L}=\frac{5}{7},\quad
\frac{y_R-50}{x_R-50}=\frac{-0.25\,s_R}{+0.35\,s_R}=-\frac{5}{7}
\]

即用户观测公式；**5/7 = 0.25/0.35**，**不是** Five-bar 的 `Kx/Ky=7/7`，也不是 Canvas/Radar 尺寸比。

### 4.3 映射矩阵 \(W\)

\[
\begin{bmatrix} L_x \\ L_y \\ R_x \\ R_y \end{bmatrix}
=
\begin{bmatrix}
-0.35 & 0 \\
-0.25 & 0 \\
0 & +0.35 \\
0 & -0.25
\end{bmatrix}
\begin{bmatrix} s_L \\ s_R \end{bmatrix}
+
\begin{bmatrix} 50 \\ 50 \\ 50 \\ 50 \end{bmatrix}
\]

（再经 `_clamp_pct`；在未触边时 \(\mathrm{rank}(W)=2\)。）

### 4.4 Jaw / Head / Mirror / Scale

- **Jaw**：不参与 `side*.x/y` 写入；仅读 side 作 `corner_offset_abs` 证据。
- **Head pose / nose anchor**：用于 mouth scenario / lip·jaw 门控，**不改写** side XY。
- **Face scale / mouthWidth**：lip/jaw 几何，**不驱动** side pad。
- **Mirror**：左 X 用减、右 X 用加，属该硬编码展开的左右对称，非独立前端 mirror 层对嘴角再处理。

### 4.5 FaceControlCommand

纯复制：`fcc.rig.mouth.sideL/R = previewRig.mouth.sideL/R`。无 `value ?? x ?? y` 类 fallback 扩维。

### 4.6 Five-bar IK

- 输入：二维 pad `{x,y}`（`rigValuesForMouthCorner`）。
- Pad→D：\(u=(x-c_x)/c_x\)，\(v=(c_y-y)/c_y\)，再乘 `Kx/Ky`、`xSign/ySign`、flip。
- **不**假设只能沿 5/7 斜线；斜线来自上游 pad 轨迹。

---

## 5. Dimension / Rank Analysis

| 层 | 名义维度 | 有效 DoF | 说明 |
|----|----------|----------|------|
| Raw Landmark 嘴几何 | 高维点云 | 未接入 side* | stub 未用 |
| Blend smile L/R | 2 | **2** | 左右微笑强度 |
| Tracking / Face Rig `side*` | 4 | **≤2** | \(W\) 列空间 |
| FaceControlCommand `side*` | 4 | **≤2** | 复制 |
| IK Target pad | 4 名义 / 2 点 | **≤2** | 落在微笑流形 |
| Servo（左右嘴角） | 4 舵机 | **≤2** 由 pad 流形决定 | 五杆另有机构约束 |

**退化时刻**：首次在 Python **写出** `rig.mouth.side*` 时，由 2 标量伪展开为 4 通道（非 FCC/导出层）。  
**不存在**「先有真 4D 再被 FCC 压成斜线」的证据。

---

## 6. Sample Data Evidence

### 6.1 文件状态

未在以下范围找到 `signal-curves_20260722_113716.json`：

- 仓库 `04_Software` 全树  
- `C:\Users\15123\Downloads|Desktop|Documents`、`F:\Dreame_PJ` 浅层递归  

**结论**：本节无法对该 JSON 做 corr/回归/PCA；下列为 **与代码同构的解析/合成验证**（`s∈[0,100]`，再 clamp）。

### 6.2 合成轨迹统计（与硬编码一致）

| 量 | sideL | sideR |
|----|-------|-------|
| corr(x,y) | **+1.0** | **−1.0** |
| 线性回归 y∼x 斜率 | **5/7 ≈ 0.714285714286** | **−5/7** |
| 截距 | \(50(1-5/7)=100/7≈14.286\) | \(50(1+5/7)=200/7≈85.714\) |
| max \|残差\| | ~1e−14（浮点） | 同量级 |
| 有效 rank（中心化协方差） | **1**（每侧） | **1** |
| PCA 第一主成分解释率 | ≈100% | ≈100% |

与用户公式完全一致。触 `_clamp_pct` 边界时残差可非零，斜线在饱和区“折断”。

### 6.3 对真实样本仍建议补做（拿到文件后）

- 全段 / Neutral 附近 / Clamp 区 / Jaw≠0 分段的 corr 与残差  
- 左右是否严格镜像（\(s_L\approx s_R\) 时）  
- 任一帧是否打破 5/7（若有，优先查 videoNeutral 减法、mouth clamp `×f`、人工改 pad）

---

## 7. First Collapse Point

| 项 | 内容 |
|----|------|
| **位置** | Python MediaPipe→Rig 写出嘴角 pad |
| **文件** | `tools/tracking_service/mediapipe_to_rig.py` |
| **行附近** | 2502–2519 |
| **行为** | 单标量 smile → 同时写 X 与 Y（固定比） |
| **输入** | `smile_l_val` / `smile_r_val`（0~100） |
| **输出** | `rig.mouth.sideL/R.{x,y}` |
| **引入** | 公式首次出现于 `29c0d11`（2026-05-14）；当前 blame 行为 `592409a3`（2026-05-29）同式重写/保留 |
| **注释** | 「Face Rig v1 嘴角 pad…微笑时略向上提」「mapping.smile* 仍为强度，**仅此处**写入 side*」 |

**唯一性**：全库仅此写入 `rig["mouth"]["sideL/R"]` 的动态值；`lip_geometry` / `jaw_geometry` **只读** side，不回写 XY。`landmarks_to_mouth_corners` 为死 stub。

---

## 8. Historical Reason

| 问题 | 结论 |
|------|------|
| 嘴角最早是否单控制量？ | Tracking 接入起即用 **smile 标量 → 对角线 pad**；非后期误把 Y 绑到 X |
| 何时出现 x/y 字段？ | Face Rig / Elite Rig 控件本为 **二维 pad**（50/50 中位）；与 Five-bar 一致 |
| 增加 x/y 后是否改造数据源？ | **否**。Landmark 嘴角几何未接入；仍用 smile |
| 旧版对角线兼容？ | **即当前正式路径**，非旁路兼容逻辑 |
| 有意设计还是迁移遗漏？ | **有意的 v1 近似**（注释+ARCHITECTURE「微笑→side pad」）；相对「真二维追踪」则是 **未完成的数据源升级** |
| Five-bar 引入后语义？ | IK 按 2D pad 设计；冻结文档明确 **不改** Python smile 映射（`MOUTH_CORNER_FIVEBAR_V1_FREEZE.md`） |
| TODO/FIXME | `landmarks_to_mouth_corners` stub 暗示曾计划 landmark 嘴角，**从未接线** |

相关提交：

- `29c0d11` — 追踪映射 + 右嘴角五杆 + `mediapipe_to_rig` 含 0.35/0.25  
- `592409a3` — 嘴角/jaw 追踪相关改动，保留同式  
- Five-bar 冻结文档将 smile→pad 划出 V1 修改范围  

---

## 9. Impact Assessment

| 能力 | 影响 |
|------|------|
| Signal Curves / Reference Take / Target Timeline | 记录到的 side XY **已耦合**；曲线“两通道”冗余 |
| FullRigSnapshot / Deterministic Replay | 忠实回放同一流形；不能恢复丢失的独立轴 |
| FaceControlCommand | 携带耦合 pad → 下游一律可见 |
| Mouth Five-bar IK / **真机嘴部轨迹** | **执行目标即斜线流形**；非仅诊断 |
| Camera Observed Timeline / Geometry Evaluation | 若期望独立 XY 或轮廓，指标会系统性偏差 |
| Closed-loop / Proposal / A/B | 嘴角 4 通道优化空间被压成 2；易误判“Y 跟随好” |
| Whole-Mouth Contour Manifold | 当前 side* **不能**作为独立 2D 观测/控制入口 |

**证明真机路径（代码）**：

1. `useTrackingPreviewCamera` → `previewRig`（含耦合 side*）  
2. `buildFaceControlCommandFromRig({ rig: previewRig })` 复制 side*  
3. Device drive / dry-run：`mapFaceRigToPose(rigValuesFromEliteRig(previewRig))` → `computeMouthCornerFiveBarIk`  

故：**错误（相对真二维语义）已进入真机执行目标**，不仅影响显示。

---

## 10. Repair Options（仅候选，不实施）

### A. 最小兼容修复

- **做法**：保留 smile→对角线为默认；另增 debug/可选开关或导出 `mapping.smile*` 作为“真自由度”通道说明；文档标明 side XY 非独立。  
- **范围**：文档 + 可选诊断字段（若未来任务允许）。  
- **风险**：低；不改机构。  
- **旧 Case**：保留。  
- **IK**：不变。  
- **Reference Take**：不必重录（语义不变）。  
- **标定**：否。

### B. 正确二维数据修复

- **做法**：用 landmark（或 blend 组合）估计独立 corner (Δx,Δy)；废除或降权 0.35/0.25；实现真正的 `landmarks_to_mouth_corners`（或等价）。  
- **范围**：`mediapipe_to_rig.py` + 测试 + 可能 mapping JSON；**不动** Five-bar 冻结参数为佳。  
- **风险**：中高；表情分布与旧 Take 不可比。  
- **旧 Case**：多数嘴角曲线失效，需重录。  
- **IK**：仍吃 2D pad，但轨迹空间变大。  
- **Reference Take**：**需要**重新生成。  
- **标定**：机构中位可保留；感知增益可能需重调。

### C. 与未来整体轮廓方案兼容

- **做法**：side* 改为“流形参数 → pad”的可插拔 projector；上游输出嘴轮廓/控制点；当前对角线 projector 作为 v1 fallback。  
- **范围**：协议 + mapper + 学习/闭环字段；与 Contour Manifold 路线对齐。  
- **风险**：高（架构面）。  
- **旧 Case**：可通过 fallback projector 兼容。  
- **IK**：pad 接口可不变。  
- **Take / 标定**：新流形需新基线；旧对角线 Take 可标为 `mouthCornerModel=diagonal-v1`。

---

## 11. Recommendation

1. **根因定性**：**A + C**（上游仅左右 smile 标量；Rig 展示为 x/y 但仍是一维 corner strength 的对角线嵌入）。**非** D（FCC/IK 二次压维）。**非** 单纯 B（丢失已存在的独立轴）——独立 landmark 轴从未接入。  
2. **5/7 来源**：硬编码 `0.25/0.35`；与 Five-bar `Kx=Ky=7` **无关**。右侧负号来自右 X 用 `+0.35`、Y 仍 `-0.25`。  
3. **修复前**：与产品确认目标语义——继续“微笑斜线 v1”，还是升级真 2D/轮廓。  
4. **下一步**：用户确认样本路径后补 §6 实数统计；再单独立项修复任务。  

**Analysis only — no code changes applied.**

---

## 附录 A：审计问题速答

| # | 问题 | 答案 |
|---|------|------|
| 1 | MediaPipe 嘴部原始字段？ | Landmarks 全脸点；Blend 含 smile/jaw/upper/lower/pucker/funnel/close 等 |
| 2 | 来自 Landmark？ | 眼/鼻/唇几何、jaw aperture 等；**嘴角 side* 否** |
| 3 | 来自 Blendshape？ | **side* 仅 smile***；jaw 用 jawOpen 等 |
| 4 | 自定义几何？ | mouthWidth、aperture、nose anchor、scenario score 等；不写 side* XY |
| 5 | 左右最初独立 X/Y？ | 控件层是；**感知源否** |
| 6 | 哪层只剩 corner scalar？ | Blend smile → `_pipe_unipolar_strength` 之后 |
| 7 | 哪层再展成 X/Y？ | 同文件立刻写入 side*（0.35/0.25） |
| 8 | 5/7？ | \(0.25/0.35\) |
| 9 | 右侧负号？ | \(\Delta y/\Delta x = -0.25/+0.35\) |
| 10 | Jaw 参与嘴角 XY？ | **否**（仅证据） |
| 11 | Head/Scale/Mirror？ | 不改写 side*；左右符号在展开式内 |
| 12 | Neutral/Tuning/Smooth 按 XY？ | 是按轴；不引入 5/7，默认可保持比例 |
| 13 | IK 收到什么？ | 二维点，但轨迹在 1D 流形上 |
| 14 | 有意对角线还是意外？ | **有意 v1** |
| 15 | FCC sideL/R 语义？ | Face Rig 嘴角 pad 目标（0~100，50 中位）；追踪路径下 = 微笑对角线嵌入 |

## 附录 B：关键代码锚点

```2502:2519:tools/tracking_service/mediapipe_to_rig.py
    # Face Rig v1 嘴角 pad：x=50 中心（左减右增），y=50 中心（上减下增，微笑时略向上提）。
    # mapping.smileLeft/Right 仍为 0~100 语义强度，仅此处写入 rig.mouth.side*。
    rig["mouth"]["sideL"]["x"] = _clamp_pct(50.0 - smile_l_val * 0.35)
    rig["mouth"]["sideL"]["y"] = _clamp_pct(50.0 - smile_l_val * 0.25)
    ...
    rig["mouth"]["sideR"]["x"] = _clamp_pct(50.0 + smile_r_val * 0.35)
    rig["mouth"]["sideR"]["y"] = _clamp_pct(50.0 - smile_r_val * 0.25)
```

```168:169:tools/tracking_service/mediapipe_to_rig.py
def landmarks_to_mouth_corners(_landmarks: Any) -> tuple[float, float, float, float]:
    return 0.0, 0.0, 0.0, 0.0
```

```74:113:src/sdk/tracking/diagnostics/diagnosticCommandRecording.js
export function buildFaceControlCommandFromRig({ ... }) {
  ...
      mouth: {
        sideL: rig.mouth?.sideL ?? null,
        sideR: rig.mouth?.sideR ?? null,
      },
```

```716:735:src/sdk/kinematics/mouthCornerKinematics.js
export function computeMouthCornerFiveBarIk(rigValues, resolved, state, sideId = "right") {
  const pad = rigValuesForMouthCorner(rigValues, sideId)
  ...
  const result = resolveRightMouthCornerFivebar({ ..., sideR: pad, ... })
```
