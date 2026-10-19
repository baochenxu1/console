# FaceDEV · Face Binding Workspace Priority Polish Completion

## 1. Workspace Actions 新位置

左栏顶部（`FaceBindingEditor` rail top）：

- 标题「面部绑定工作台」+ 右侧保存状态
- 2×2：重置工作台 / 保存到本地 / 导入配置 / 导出配置
- 「高级操作 ▾」
- `sendStatus` compact 反馈

已移除底部 Workspace Footer。

## 2. Reset 权重

「重置工作台」提升为顶部第一行 secondary 主操作，与「保存到本地」同排；非 destructive、不进高级菜单。

## 3. Save Local

「保存到本地」保持 Primary；状态「已保存 / 有未保存修改」在标题右侧。复用 `handleSaveProfile`。

## 4. Import / Export 关联

成对放在第二行，同为 Secondary。均复用既有 `handleImportClick` / `handleExportProfile`。

## 5. 原顶部 Import 如何处理

审计确认页顶「导入并生效 / 恢复默认映射 / 一键清除全部绑定」仅服务 Face Binding Workspace。

处理：

- 页顶移除上述三按钮（保留配置名称 + 串口胶囊 + 实时预览）
- 导入迁入左栏「导入配置」
- 恢复默认 / 清除全部 → 「高级操作」

## 6. 高级操作内容

- 迁移为 Bus Servo 中位语义（仅 Bus）
- 恢复默认映射
- 清除全部绑定（danger）

## 7. Restore Full Range 新位置

行程标定标题行右侧 compact「恢复全范围」；仍调用 `handleRestoreFullStroke` / `bindingWithRestoredEndpointsVsNeutral`。

## 8. More Settings 收敛结果

仅保留：权重、曲线、actuatorKey、bindingId、迁移痕迹、舵机详情、手工脉宽。不再含恢复全范围。

## 9. 自动测试

`bindingWorkspacePriorityPolish.test.mjs` A–K PASS。

## 10. Regression

既有 binding workflow 单测 PASS；`build:faceconsole-web` PASS。

## 11. Build

`npm run build:faceconsole-web` PASS。

## 12. Commit hash

见 `git log -1`（本任务提交）。

## 截图

`docs/screenshots/binding-inspector-workflow/F-workspace-priority-top.png`
