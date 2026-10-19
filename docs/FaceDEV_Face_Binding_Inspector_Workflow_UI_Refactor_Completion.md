# FaceDEV · Face Binding Inspector Workflow UI Refactor Completion

## 1. 原 UI 问题

左侧绑定检视功能完整但信息扁平：调试字段、低频参数与高频标定同级；Binding Card 过长；首次绑定顺序不清晰；`bindingId` / 权重 / 曲线 / 硬件表占据主视图；旧「测试中位 / ±极限」几乎无用。

## 2. 真实 Binding workflow → UI

选控件 → 选通道 → 新增绑定 → 选舵机号 → 确认方向 → 看本条逻辑脉宽 → 上/中/下行程标定 → 完成设置 → 重置工作台 → 保存到本地 → 导出配置。

## 3. Current Control Summary

绑定检视改为：中文控件名（一级）+ `controlId`（次级）+ 通道切换 + 当前值只读。

## 4. New Binding Setup

新增绑定进入 session `setupBindingIds`（不写 schema）；显示引导 + 舵机号/方向 + 行程标定 +「完成绑定设置」。

## 5. Servo ID

主 Card 常驻可编辑；改号仍走 `bindingTargetPatch` 同步 `actuatorKey`。

## 6. Direction

主 Card 常驻「正向/反向」；底层仍交换 `positiveTargetPwm` ↔ `negativeTargetPwm`（既有 reverse），不新增 schema 字段。

## 7. 本条逻辑脉宽

常驻展示 contribution logical PWM；无值显示 `—`。

## 8. 上 / 中 / 下行程标定

审计映射（`evaluateBindingLogical`）：

- 控件 +100（驱动 ≥0）→ `positiveTargetPwm` → **上极限**
- 控件 −100（驱动 <0）→ `negativeTargetPwm` → **下极限**
- 中位 → `neutralPwm` / capture API

仍调用既有 contribution / capture handlers。

## 9. Servo Overview

完成 Setup 后显示 compact 概览（名称、启用、范围、机械零位）；不重复方向。

## 10. More Settings

默认折叠：权重、曲线、恢复全范围、actuatorKey / bindingId、迁移痕迹、完整舵机详情、手工脉宽。

## 11. 删除 / 复制

右上角 `⋯`：复制、复制为反向、删除绑定（danger）。

## 12. Workspace Footer

保存到本地（主）+ 重置工作台 / 导出配置（次）+ 简易未保存指纹状态。

## 13. Reset / Save / Export

复用 `resetEngine` / `handleSaveProfile` / `handleExportProfile`；迁移收入「工作台操作 ▾」。

## 14. 旧 Output Test

主 Card 移除三测试按钮；保留 `onBindingTest` API 兼容；不新增行程预览 sequencer（仅预留注释位）。

## 15. 自动测试

`src/sdk/binding/bindingInspectorWorkflowUi.test.mjs`（A–Y 相关映射与 actions）PASS。

## 16. Regression

`buildBindingWorkbenchState`、眉/下颌 kinematics、expression dope sheet 等抽样 PASS。

## 17. Production build

`npm run build:faceconsole-web` PASS。

## 18. Commit hash

当前分支 `feature/neck-character-integration` 上本任务提交（见 `git log -1`）。

## 截图（真实侧栏宽度，未扩宽）

目录：`docs/screenshots/binding-inspector-workflow/`

- A. `A-empty-channel.png`
- B. `B-new-binding-setup.png`
- C. `C-completed-binding.png`
- D. `D-more-settings.png`
- E. `E-multi-binding.png`
