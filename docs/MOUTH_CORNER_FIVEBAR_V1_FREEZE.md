# Mouth Corner FiveBar V1 冻结说明

**冻结版本**：`2026-06-11.v1`（代码常量 `MOUTH_CORNER_FROZEN_VERSION`）  
**冻结日期**：2026-06-11  
**代码锚点**：`src/sdk/kinematics/mouthCornerFrozenConfig.js` + `mouthCornerFiveBarLabConfig.js`

---

## 冻结范围（已纳入 V1）

### 生产链路（全页共用）

- **Pad 控件语义**：`rig.mouth.sideL` / `rig.mouth.sideR`（0~100，**50/50 = 控件中位**）
- **FiveBar IK 唯一入口**：`mapFaceRigToPose()` → `resolveMouthCornerKinematics()` → `computeMouthCornerFiveBarIk()`
- **Runtime 读取**：`getRightMouthFiveBarRuntime()` / `getLeftMouthFiveBarRuntime()`（含 baseline + Lab 实时校准合并）
- **硬件路由**：Lab 样机右 **servo 7/8**，左 **servo 18/19**（非 profile 默认 20/21）
- **按侧独立 Pad Flip**（与 rig UI 解耦，见下表）
- **中位标定**：绑定页「设为中位」→ 五杆 IK logicalPwm → 同步 Lab 校准 + profile

### 页面与组件（嘴角 Pad / IK 语义一致）

| 页面 | UI | Pad 数据源 | IK |
|------|-----|-----------|-----|
| 面部绑定 | `FaceRigControls` (workspace) | `rig.mouth.sideL/R` | 正式 runtime |
| 表情编排 | `FaceRigControls` (console) | 同上 | 同上 |
| Tracking 预览 | rig 同结构 | `mouth.sideL/R` | 同上 |
| Kinematics Lab | `RightMouthFiveBarWorkspace` | 独立 state，**坐标系 0~100 相同** | `buildMouthCornerLabKinematicsWrap` |
| ServoOutputInspector | 诊断 | 读 profile + rig | 同上 |

### 明确不在 V1 范围（勿为「修嘴角」去动）

- Python `tools/tracking_service` 内 **smile / mouth 映射**（MediaPipe → rig 的 smile gain、曲线）
- Face Rig UI 上 **`mouth.sideL` / `mouth.sideR` 控件语义**（仍 0~100 pad，50 为中）
- 用降低 `mouthCorner` gain 掩盖方向错误
- 总线 **0~1000 logical** 与 **500~2500 PWM logical** 的换算层（V1 保持现状，不在此冻结内改）

---

## 参数基线（V1 勿随意改）

> 唯一配置源：`mouthCornerFiveBarLabConfig.js` → `MOUTH_CORNER_LAB_SIDES.*.defaultCalibration`  
> 修改后必须 **bump** `mouthCornerFrozenConfig.js` 内 `MOUTH_CORNER_FROZEN_VERSION`。

### 右嘴角（Right）

| 参数 | 值 | 说明 |
|------|-----|------|
| `labHwServoA` / `B` | **7 / 8** | FiveBar A/B 轴实际舵机 |
| `flipPadX` / `flipPadY` | **false / false** | Pad→IK 翻转 |
| `xSign` / `ySign` | **+1 / +1** | D 偏移符号 |
| `Kx` / `Ky` | **7 / 7** | Pad→D 增益 |
| `qSignA/B` | **+1 / +1** | IK→PWM 符号 |
| `qGainA/B` | **1 / 1** | IK→PWM 增益 |
| `servoSwap` | **false** | 不交换 A/B |
| `neutralPwmA` / `B` | **2009 / 1618** | pad 50/50、q≈0 时 logicalPwm（500~2500 空间） |
| 对应总线 logical（约） | **754 / 559** | `(pwm-500)/2`，仅作验收参考 |

### 左嘴角（Left）

| 参数 | 值 | 说明 |
|------|-----|------|
| `labHwServoA` / `B` | **18 / 19** | Lab 硬件 |
| `flipPadX` / `flipPadY` | **true / false** | 左 X 翻转，Y 不翻转 |
| `xSign` / `ySign` | **-1 / +1** | 镜像几何 |
| `qGainA/B` | **4 / 4** | 左机构增益 |
| `neutralPwmA/B` | **null** | 由 profile / 绑定页标定，无代码硬编码 |

### Pad 方向验收（机构 vs UI）

| 侧 | X | Y |
|----|---|---|
| 左 | ✅ 正确 | ✅ 正确（`flipPadY: false`） |
| 右 | ✅ 正确（`flipPadX: false`） | ✅ 正确 |

### Rig 控件 ↔ 机构（验收参考，非 smile）

| raw pad | 左机构角 | 右机构角 |
|---------|----------|----------|
| `{35, 35}` | 左上 | — |
| `{65, 35}` | — | 右上 |
| `{50, 50}` | 回中 | 回中 |

---

## 中位优先级（V1 冻结逻辑）

FiveBar 绑定 `neutralPwm` 合并顺序：

```
1. Profile 已标定（neutralPwm ≠ 1500）     ← 「设为中位」+ 保存绑定
2. Lab 校准 neutralPwmA/B（localStorage）  ← Lab 字段或设为中位同步
3. defaultCalibration 默认（右：2009/1618）
```

**禁止** baseline 快照里的 stale `neutralPwm` 覆盖 live profile（`mouthCornerBindingFromProfileOverride` 只覆盖 servoId/bindingId）。

---

## 中位标定操作（V1 标准流程）

1. 拖动 **mouth.sideR / sideL** pad 到机构满意位置  
2. 绑定检视 → 选中 `mouth_corner_r.x` / `.y` → **「设为中位」**  
   - 应提示：`已设为中位（五杆 IK）：servo 7 → logical xxxx（已同步 Lab 校准）`  
3. 顶部 **「保存绑定到本地」**  
4. **「重置工作台」**（仅 pad 回 50/50）→ 机构应仍在标定中位  

可选：Kinematics Lab → Calibration → `neutralPwmA/B` 手填 → 自动写 `calibration.v1`。

---

## 诊断预期（V1 验收）

**ServoOutputInspector → Right Mouth FiveBar**，pad **50/50**：

| 字段 | 右嘴角预期 |
|------|------------|
| `servoA/B` | **7 / 8**（不得 7/7） |
| `flipPad X/Y` | **false / false** |
| `binding neutral A/B` | **2009 / 1618**（或你的标定值） |
| `qSend A/B` | **≈ 0°** |
| `logicalPwm A/B` | **≈ binding neutral** |

---

## 之前为什么一直出问题

问题不是单点 bug，而是 **绑定页、FiveBar IK、Lab 校准、baseline、profile 默认舵机** 多层叠在一起。

### 1. 方向反 / 左右不一致

| 现象 | 根因 |
|------|------|
| 左 Y 反、右 X 反 | 共用 `flipPadY` 或错误默认 flip；未按侧独立配置 |
| 右 `{65,35}` 不对应机构右上 | flip / xSign 与 rig UI 未解耦 |

**V1 修复**：`MOUTH_CORNER_PAD_FLIP_DEFAULTS` 从 `mouthCornerFiveBarLabConfig` 生成；左 `T/F`，右 `F/F`。

### 2. servo 7/7、X 被 Y 覆盖

| 现象 | 根因 |
|------|------|
| 诊断 `servoA/B: 7/7` | baseline / profile 路由错误；两路写同一舵机 |
| `actualPwm` 两路相同 | binding 未 fallback 到 Lab 7/8 |

**V1 修复**：`applyMouthCornerLabHwServoFallback` + baseline sanitize；快照强制 7/8。

### 3. 中位「设了不生效 / 重置就回去」

| 现象 | 根因 |
|------|------|
| 设为中位无效 | 「设为中位」读 **线性 contribution**（servo 20/21），不是 IK 的 7/8 |
| 保存后重置丢失 | Lab 默认 `neutralPwmA=2009` **始终覆盖** profile |
| 改 Lab 不生效 | 有 baseline 时只读 baseline 内嵌校准，不读 `calibration.v1` |

**V1 修复**：

- `captureBindingNeutralFromWorkbench` → `resolveMouthCornerNeutralCapture` + `persistMouthLabNeutralPwm`
- `loadRightMouthLabCalibrationForRuntime`：baseline + **live Lab 校准合并**
- `applyMouthCornerBindingNeutralOverrides`：profile 标定优先；按 **servoId 7/8** 写入

### 4. 总线 0~1000 vs PWM 500~2500（已知，V1 未改换算）

机构 logicalPwm 在 **500~2500**；总线下发 **0~1000**。中位 2009 ≈ 总线 754。  
V1 **刻意不改**换算链，避免引入新问题；验收以 **logicalPwm / binding neutral** 为准。

---

## 这次为什么解决了

1. **单一冻结配置源**：`mouthCornerFrozenConfig.js` + `mouthCornerFiveBarLabConfig.js`  
2. **全链路同一 kinematics 包装**：`buildMouthCornerLabKinematicsWrap`（含 flip、neutral、q 符号）  
3. **中位双写**：设为中位 → profile binding + Lab `calibration.v1`  
4. **Runtime 合并**：baseline 只固化 Kx/Ky/路由；**中位以 live 校准 + profile 为准**  
5. **绑定合并**：baseline 的 `profileBindings` **不再带 stale neutralPwm**

---

## localStorage 键（恢复 / 排查）

| 键 | 用途 |
|----|------|
| `facedev.rightMouthFivebar.calibration.v1` | 右 Lab 校准（含 neutralPwmA/B） |
| `facedev.rightMouthFivebar.runtimeBaseline.v1` | 右正式链路 baseline |
| `facedev.leftMouthFivebar.calibration.v1` | 左 Lab 校准 |
| `facedev.leftMouthFivebar.runtimeBaseline.v1` | 左 baseline |
| `servo-face-console:face-rig-profile`（或项目 `FACE_RIG_STORAGE_KEY`） | 绑定 profile（含 neutralPwm） |

---

## 关键文件

| 文件 | 职责 |
|------|------|
| `src/sdk/kinematics/mouthCornerFrozenConfig.js` | 冻结版本号、pad 预设、runtime 默认导出 |
| `src/sdk/kinematics/mouthCornerFiveBarLabConfig.js` | **唯一参数表**（flip、中位、硬件 ID） |
| `src/sdk/kinematics/mouthCornerFivebar.js` | Pad flip、IK、PWM 映射 |
| `src/sdk/kinematics/mouthCornerKinematics.js` | resolve / 中位合并 / `resolveMouthCornerNeutralCapture` |
| `src/sdk/kinematics/rightMouthFiveBarRuntime.js` | 右 runtime + baseline/Lab 合并 |
| `src/sdk/kinematics/mouthCornerFiveBarLab.js` | Lab 校准、`persistMouthLabNeutralPwm`、`buildMouthCornerLabKinematicsWrap` |
| `src/hooks/useFaceRigInteraction.js` | `captureBindingNeutralFromWorkbench` |
| `src/components/FaceRigBindingInspector.jsx` | 「设为中位」UI |
| `src/core/faceDofMapper.js` | `mapFaceRigToPose` 五杆注入 |
| `src/sdk/kinematics/mouthFiveBarRuntimeOptions.js` | Tracking / 绑定页 runtime 选项 |

---

## 如何恢复到本冻结状态

### A. 仅恢复代码参数（无 localStorage）

1. 确认 `MOUTH_CORNER_FROZEN_VERSION === "2026-06-11.v1"`  
2. 对照上文 **参数基线** 检查 `mouthCornerFiveBarLabConfig.js`  
3. `npm run build` 通过  
4. 硬刷新前端  

### B. 恢复运行时校准（推荐完整验收）

在浏览器控制台（面部绑定页）：

```javascript
// 可选：清错误 baseline 后重存
localStorage.removeItem('facedev.rightMouthFivebar.runtimeBaseline.v1')

// 右 Lab 校准（中位 + flip 等）
localStorage.setItem('facedev.rightMouthFivebar.calibration.v1', JSON.stringify({
  Kx: 7, Ky: 7, xSign: 1, ySign: 1,
  qSignA: 1, qSignB: 1, qGainA: 1, qGainB: 1,
  servoSwap: false, flipPadX: false, flipPadY: false,
  neutralPwmA: 2009, neutralPwmB: 1618,
  outputMode: 'static-target', sendMode: 'separate-write',
}))
location.reload()
```

然后在 **Kinematics Lab** 点 **Save Right Mouth Baseline**，或在绑定页按 **中位标定流程** 重标定。

### C. 从 Git 恢复

```bash
git checkout <冻结提交> -- src/sdk/kinematics/mouthCornerFrozenConfig.js
git checkout <冻结提交> -- src/sdk/kinematics/mouthCornerFiveBarLabConfig.js
git checkout <冻结提交> -- src/sdk/kinematics/mouthCornerKinematics.js
git checkout <冻结提交> -- src/sdk/kinematics/mouthCornerFiveBarLab.js
git checkout <冻结提交> -- src/sdk/kinematics/rightMouthFiveBarRuntime.js
git checkout <冻结提交> -- src/hooks/useFaceRigInteraction.js
```

（以实际冻结提交为准。）

---

## 后续若需调整（非 V1）

| 需求 | 建议 |
|------|------|
| 改方向 | 只动 `flipPadX/Y` 或 `xSign/ySign`，**bump 版本** |
| 改中位 | 绑定页「设为中位」或 Lab `neutralPwmA/B`，勿只改 profile 里 servo 20/21 |
| 改 smile 幅度 | 动 Python mapping，**不要**动 FiveBar flip |
| 总线换算 | 单独 PR，与嘴角 V1 冻结分开 |
| 左嘴硬件 | servo16 损坏期间左硬件验收暂停；软件链路保持 V1 参数 |

---

## 版本变更记录

| 版本 | 日期 | 说明 |
|------|------|------|
| `2026-06-11.v1` | 2026-06-11 | 右 7/8、flip 按侧、中位双写、runtime 合并；方向与中位验收通过 |
