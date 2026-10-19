# FaceDEV × Luvia — Physical Neck Target Dispatch Hotfix

分支：`feature/neck-character-integration`（未新建分支）  
**未修改 Luvia / CharacterPose / frameProject / Timeline 插值 / Face Rig / SC/ST/RJ。**

## 审计结论（按代码）

### 1. Manual target 原来卡在哪个 gate

`FaceExpressionEditor.handleNeckChange` 原先：

```js
if (client?.getSnapshot?.()?.hardwarePreview) {
  client.offerTarget({ ..., fromScrub: true })
}
```

且 `offerTarget` 内：`fromScrub && !hardwarePreview → return false`。

**Hardware Preview 默认 OFF** → 手动拖动只更新 UI / `neckPose` state，**不发 `neck.target`**。  
Luvia Physical Debug 的 Target 保持 0/0/0，Last 0x32 保持全 0——符合「未下发」而非「硬件门」。

### 2. Timeline target 原来卡在哪个 gate

Timeline 路径：`playKeyframes` → `handleDispatchNeck` → `offerTarget({ fromScrub: false })`，**本就不检查 Hardware Preview**。

原先也**不**检查 `productionReady` / `hardwareExecutionEnabled`。  
若 Playback 时 Target 仍为 0，更可能是：

- 关键帧 Neck 仍为 0/0/0（只拖了 Editor、未写入 Character Key），或  
- 未看 FaceDEV 侧 Prepared/Sent（此前 UI 不可见）。

本 hotfix 为 Timeline 补上与 Manual 一致的 **live** 最小前置：`SESSION_ACTIVE` + Hardware Connected + Enabled，并写出 Dispatch Decision，避免再猜。

### 3. Hardware Preview 正式语义

| 路径 | Preview OFF | Preview ON |
|---|---|---|
| Editor 拖动 / scrub | 只改 UI，不下发 | 可下发（另需 session+hw+enabled） |
| Timeline Playback | **必须仍可下发** | 同样下发 |

### 4. productionReady / HardwareExec 是否误用

**否。** FaceDEV 未用二者阻断 target；并在 `offerTarget` 中明确注释禁止自行增加此类 gate。

### 5. stale closure

`handleDispatchNeck` / `handleNeckChange` 一律经 `neckBridgeRef.current.offerTarget`，gate 读 client 内部 `lastNeckState` / `state`，**不**缓存 connected/enabled 到 React closure。

### 6. shared client

Editor / Panel / Timeline 共用 `getSharedNeckBridgeClient()`；Hardware Connect 后仍为同一 instance（测试 K）。

### 7. 新 dispatch diagnostic（Physical Debug）

- Prepared / Send Attempts / Sent  
- Last Sequence / Last Timeline / Last Sent Pose P/R/Y  
- Dispatch Decision / Reason / Source  

Decision 枚举：`SENT` | `SKIPPED_HARDWARE_PREVIEW_OFF` | `SKIPPED_SESSION_INACTIVE` | `SKIPPED_HARDWARE_DISCONNECTED` | `SKIPPED_NOT_ENABLED` | `SKIPPED_STALE` | `FAILED_SOCKET`

### 8–10. 真机验收（用户 Physical Debug）

1. Connect Runtime → Connect Hardware COM3 → Enable  
2. **Hardware Preview ON** → 拖 P+1 R+2 → 看 Prepared/Sent/Last Sent Pose/Decision=SENT，Luvia Target≈1/2/0  
3. Preview OFF 再 **Play Timeline**（键上需有非零 Neck）→ Decision 仍可为 SENT；Preview 不得阻断 Playback  
4. Target 非零后观察 Last 0x32；若 FaceDEV Sent Pose 与 Luvia Target 均非零但 0x32 仍全 0 → 转 Luvia Direct Runtime

### 11. 自动测试

`src/core/neckTargetDispatchHotfix.test.mjs`（A–O + Timeline play 路径）。
