# FaceDEV P0.0-B 交付报告：Landmark 2D Mouth Corner Mapping V2

**日期**：2026-07-22  
**状态**：已实现 landmark-2d-v2；Five-bar / Binding / E4 / E5 / Safety / DeviceBus **未改**

---

## 1. 复用的 face-local / mouth pose 模块

| 模块 | 复用方式 |
|------|----------|
| `mouth_pose_frame.build_mouth_pose_frame` | **不直接用于嘴角测量**（原点/X 由 61/291 定义 → 角点投影恒 ±0.5） |
| 鼻尖 / 颏 / 眼外眦语义 | **复用同一约定**：origin=`noseTip(1)`，Y←Gram–Schmidt(`chin−nose`)，与 lip/jaw 的 nose/chin 语义一致 |
| 尺度 | inter-ocular `‖rightEyeOuter−leftEyeOuter‖`（稳定锚点，非当前嘴宽） |
| `nose_anchor_frame` | 提供 `motionActive` → head-motion reject / Neutral 门控 |
| lip/jaw Neutral 模式 | warmup + N 帧 + **中位数**；session 随 `_reset_mouth_geometry_state` 重置 |

**结论**：嘴角与 lip/jaw 共用稳定锚点坐标约定；**禁止**用 61/291 自建系测位移。

---

## 2. Mouth Corner State 位置

- 状态对象：`create_mouth_corner_state()` / `reset_mouth_corner_state()`  
  文件：`tools/tracking_service/mouth_corner_geometry.py`
- 会话持有：`TrackingSession._mouth_corner_state`  
  文件：`tools/tracking_service/mediapipe_tracking_server.py`
- 重置钩子：`_reset_mouth_geometry_state`、source switch、`start_*_neutral_calibration`（与 lip/jaw 同触发）
- 传入：`mediapipe_result_to_rig(..., mouth_corner_state=...)`

---

## 3. Landmark 索引及左右验证

| 角色 | 索引 | 证据 |
|------|------|------|
| leftMouthCorner → sideL | **61** | `tracking_landmark_debug.FACE_LANDMARK_KEYS`、overlay、lip/jaw defaults |
| rightMouthCorner → sideR | **291** | 同上 |
| leftEyeOuter / rightEyeOuter | **33 / 263** | 稳定 X 轴 |
| noseTip / chin | **1 / 152** | 原点 / Y |

`conversation_ff` raw 样本：61.x &lt; 291.x、33.x &lt; 263.x，与「图像左侧为 left 键」一致。  
`sourceMirror=true` 时交换左右语义。

---

## 4. Canonical 坐标定义

- origin = nose tip  
- X = normalize(rightEyeOuter − leftEyeOuter)  
- Y = Gram–Schmidt(chin − nose)，朝颏  
- scale = inter-ocular distance  
- (cx, cy) = 点相对原点在 X/Y 上的投影 / scale  

去除：平移、等比尺度、平面内 roll。Delta：`d = c − c_neutral`，无轴交叉复制。

---

## 5. Neutral 收集条件

- faceDetected  
- canonical available（质量 / head-motion 未拒）  
- `mouth_motion_score ≤ 8`（避免表情污染）  
- 可选 `requireLipJawNeutral`（默认 false）  
- warmup 8 + sample 30，**中位数**定标  
- 未 ready：pad **保持 50/50**，**不**回退 diagonal-v1  
- session/source reset 清空 state  

---

## 6. 新增文件

| 文件 | 说明 |
|------|------|
| `tools/tracking_service/mouth_corner_geometry.py` | extract / canonical / neutral / project / apply |
| `tools/tracking_service/tests/test_mouth_corner_geometry.py` | 21 项单元测试 |

---

## 7. 修改文件

| 文件 | 变更 |
|------|------|
| `mediapipe_to_rig.py` | smile 仅 debug；Nose→Scenario(legacy evidence)→MouthCorner→side*；debug.mouthCornerGeometry |
| `mediapipe_mapping_config.py` | `mouthCorner` 默认 / normalize（缺省段 → diagonal-v1） |
| `mediapipe_mapping.default.json` | `mouthCorner.model=landmark-2d-v2` + ranges |
| `mediapipe_tracking_server.py` | `_mouth_corner_state` 生命周期 |
| `src/sdk/tracking/trackingMapper.js` | 透传 `debug.mouthCornerGeometry` |

---

## 8. diagonal-v1 与 landmark-2d-v2 契约

| | diagonal-v1 | landmark-2d-v2 |
|--|-------------|----------------|
| 输入 | smileLeft/Right 标量 | leftDx/Dy, rightDx/Dy |
| 输出 | 旧公式 `50∓s·0.35/0.25` | `50 + norm(d)·span` 分轴 |
| 缺省配置无 `mouthCorner` | **默认此模型** | — |
| 默认 JSON | — | **此模型**（验收后） |
| Neutral 未就绪 | 仍输出 smile 对角线 | **50/50**，不回退 v1 |

---

## 9. Scenario 兼容隔离

```text
corner_offset_abs = max(smileLeft*0.35, smileRight*0.35)  # legacySmileCornerEvidence
scenarioCornerEvidenceSource = "legacy-smile-v1"
```

同时输出 `canonicalCornerMotionEvidence`，**第一版不替换** Scenario 输入。  
→ Jaw/Lip/Artifact Lock 与改前 smile 证据一致；仅 side* Rig 目标改变。

---

## 10. inputRange / outputSpan 数据依据

样本：`mediapipe-raw_20260720_101926.json.gz`（conversation_ff 同源，603 帧）

| 量 | leftDx | leftDy | rightDx | rightDy |
|----|--------|--------|---------|---------|
| abs P90 | ≈0.053–0.057 | ≈0.056 | ≈0.033 | ≈0.050 |
| abs P95 | ≈0.063–0.067 | ≈0.068 | ≈0.035 | ≈0.058 |
| neutral noise P90 | ≈0.02–0.06 | | | |

**选用**：`inputRangeX/Y = 0.08`（略高于 P95，避免过早饱和）  
**outputSpanX/Y = 35**（对齐旧 v1 最大水平摆幅 `100×0.35`）  
**deadzone = 0.012**（低于噪声 P90，滤微颤）

---

## 11. 合成独立轴测试

`test_mouth_corner_geometry.py`：Left/Right × X/Y only、侧独立、Jacobian rank=4、无强制 5/7。  
**全部通过**。

---

## 12. Canonical invariance 测试

同一合成脸：平移 / 等比缩放 / Roll → canonical 不变（places=5）。**通过**。

---

## 13. conversation_ff 新导出统计（离线 pad）

在 neutral ready 后 566 帧投影：

```json
mouthCornerAxisQuality: {
  "model": "landmark-2d-v2",
  "leftAffineResidual": 26.27,
  "rightAffineResidual": 30.08,
  "leftEffectiveRank": 2,
  "rightEffectiveRank": 2,
  "mappingJacobianRank": 4,
  "axisCollapseDetected": false,
  "deltaCovRank": 4,
  "neutralNoiseP90": [0.024, 0.044, 0.028, 0.061],
  "padCorr.sideL.xy": 0.49,
  "padCorr.sideR.xy": -0.26
}
```

相对旧 5/7 精确线（corr=±1, residual≈0）：**已解除轴坍缩**。  
自然表情仍可有中等相关（生理耦合），但非实现强制 affine。

> 完整 Reference Take / Signal Curves 需在 Tracking 服务加载新 mapping 后重跑视频生成；本报告离线路径已验证几何与 projector。

---

## 14. Head Motion 污染

- `rejectOnHeadMotion=true`（默认）：nose `motionActive` 时不采新目标（hold→decay→中心）  
- Neutral 采集同样拒绝 head motion  
- 离线质量脚本未接 nose state，`headMotionCorrelation` 需实机 noseAnchor 门控验证  

---

## 15. 是否影响 Jaw / Lip

**Scenario 输入**：故意保持 legacy smile evidence → **预期无行为回归**。  
Lip/Jaw 几何驱动函数未改。  
需实机冒烟确认 artifact lock 时序仍合理。

---

## 16. 是否影响 Five-bar IK

**未改** IK / Binding / 冻结参数。  
仅 pad 轨迹从对角线变为真 2D；需确认 pad 落在安全工作区（span=35 相对保守）。

---

## 17. 是否影响旧 Case Replay

- 旧 Face Case 使用 **frozen fullRigSnapshot** → Replay **不重跑** Mapper → **行为不变**  
- 无 `mouthCorner` 的旧 mapping → **diagonal-v1**  
- 新 Take 应记录 `mapping.mouthCornerModel` / `debug.mouthCornerGeometry.model`  
- 旧 diagonal-v1 Take **不得**作为新嘴角闭环基线  

---

## 18. 测试结果

```text
Ran 21 tests in ~0.14s — OK
```

覆盖：Raw / Mirror / Canonical invariance / Axis·Side independence / Legacy 公式 / Neutral / Hold / Jacobian rank4 / Scenario evidence 隔离 / 配置兼容。

---

## 闭环关系（确认）

- 重新生成 Reference Take 后方可用于新嘴角闭环  
- P0.3 Clock/Replay/Camera 继续  
- Proposal / A/B / readyForSelfLearning 仍等 Observed Geometry 验收  
- **不进入** Whole-Mouth Contour / 流形 / Forward Model / MPC  

---

## 建议下一步

1. **必须重启** Python tracking（加载新 mapping；含下方热修）  
2. 对 `conversation_ff.mov` 录新 Reference Take + Signal Curves  
3. 核对 UI Pad 左右/上下方向；若反号，调 `mouthCorner.sourceMirror`  
4. 再开任务评估 Scenario 是否切换到 `canonicalCornerMotionEvidence`  

---

## 热修（2026-07-22）：side* 全程锁死 50

**现象**：`signal-curves_20260722_181029.json` 四通道 611 帧恒为 50。

**根因**：
1. `landmark-2d-v2` 在 Neutral 未 ready 时输出中心 50（设计如此）；
2. Neutral 采集无条件拒绝 `head_motion_active`；conversation 上 nose `motionActive` ≈ 94% 帧；
3. 另有硬编码 `mouth_motion_score > 8`，说话时 scenario score 长期超标。

**修复**：
- Neutral 门控尊重 `rejectOnHeadMotion`（默认 **false**）；
- 几何可读即可采样（不因 drive reject 丢坐标）；
- `maxMouthMotionForNeutral` 默认 **null**（关闭 score 硬拒）。

用同日 `mediapipe-raw_20260722_181024.json.gz` 复现：修复后 Neutral ready，sideL.x ∈≈[44,85]。
