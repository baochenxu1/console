# FaceDEV SDK 快速开始

## 边界（必读）

1. **FaceDEV SDK 的核心输出是 `logicalPose`**（各舵机逻辑 PWM 等），**不等于**下位机实际 PWM。
2. **`actualPose`** 仅用于诊断与映射预览。
3. **WebSerial** 为内部硬件联调能力；宿主未连接串口时，编排与绑定仍可编辑。
4. **Python Tracking Service** 只输出 `tracking.rigFrame`，**不控制舵机、不写串口**。
5. **Tracking** 仅通过 RigFrame 协议驱动 Face Rig 控件；与舵机下发解耦。
6. **MediaPipe → RigState** 当前为第一版映射，需按机器人结构后续调参；识别点与控件不完全对应属 **mapping 问题**，非 SDK 打包缺陷。

---

## 1. 在仓库根目录构建 SDK

```bash
npm install
npm run build:sdk
```

产物目录：`dist-sdk/`（中间构建）。

---

## 2. 打包为可本地安装的 npm 包

**前提**：已生成 `dist-sdk/`（先执行上一节的 `npm run build:sdk`）。

```bash
npm run pack:sdk
```

流程：

1. 运行 `scripts/prepare-sdk-package.mjs`：清空并写入 `dist-sdk-package/`（含 `package.json`、`README.md`、构建出的 `.js` / `chunks/` / `style.css`）。
2. 执行 `npm pack dist-sdk-package`，在**当前目录**生成 `facedev-sdk-<version>.tgz`（版本与根目录 `package.json` 的 `version` 一致）。

---

## 3. 在示例或其它项目中安装

**方式 A：目录依赖（与仓库内 `examples/basic-sdk-host` 一致）**

在目标项目的 `package.json`：

```json
{
  "dependencies": {
    "@facedev/sdk": "file:../../dist-sdk-package"
  }
}
```

然后在该项目目录执行 `npm install`。路径请按你的 monorepo / 拷贝位置调整。

**方式 B：tgz**

```bash
npm install /绝对或相对路径/facedev-sdk-0.2.0-beta.tgz
```

---

## 4. 引入样式

在应用入口（如 `main.jsx`）**最先**引入一次即可：

```javascript
import "@facedev/sdk/style.css"
```

该样式聚合了面部绑定与表情编排所需的 `face-rig` 与 `frame-editor` 相关规则；后续版本可能精简为 SDK 专用子集。

---

## 5. 渲染 FaceBindingEditor

`FaceBindingEditor` 需要宿主提供与主应用 `FaceRigPage` 相同的 **`rigApi`**。推荐直接使用 SDK 导出的 `useFaceRigInteraction`（内部组合 profile、rig 状态、映射与串口预览等）。

```jsx
import {
  FaceBindingEditor,
  REALTIME_THROTTLE_MS,
  useFaceRigInteraction,
} from "@facedev/sdk/react"

export function BindingHost() {
  const configs = [] // 或你的舵机配置数组；空数组时使用默认 24 路占位
  const rig = useFaceRigInteraction(configs)

  return (
    <FaceBindingEditor
      configs={configs}
      rigApi={rig}
      realtimeThrottleMs={REALTIME_THROTTLE_MS}
    />
  )
}
```

---

## 6. 渲染 FaceExpressionEditor

需提供 `frameProject` / `onFrameProjectChange`、`currentPose` / `onCurrentPoseChange`。空 `keyframes` 数组会在内部归一化为带默认关键帧的工程（与主工程行为一致）。

```jsx
import { useState } from "react"
import { FaceExpressionEditor, useFaceRigInteraction } from "@facedev/sdk/react"

const initialProject = {
  version: "1.0.0",
  projectType: "robot-face-single-expression",
  expressionId: "expr_1",
  expressionName: "演示",
  keyframes: [],
  updatedAt: new Date().toISOString(),
}

export function ExpressionHost() {
  const configs = []
  const [frameProject, setFrameProject] = useState(initialProject)
  const [currentPose, setCurrentPose] = useState({})

  return (
    <FaceExpressionEditor
      configs={configs}
      frameProject={frameProject}
      onFrameProjectChange={setFrameProject}
      currentPose={currentPose}
      onCurrentPoseChange={setCurrentPose}
    />
  )
}
```

---

## 7. 接入 createWebSocketTrackingAdapter

表情页内已集成 **WebSocket** Tracking；若要在自有代码中创建适配器：

```javascript
import { createWebSocketTrackingAdapter } from "@facedev/sdk/tracking"

const adapter = createWebSocketTrackingAdapter({
  url: "ws://127.0.0.1:8766/tracking",
})
adapter.start()
// adapter.onFrame(cb) / adapter.stop() / adapter.dispose()
```

协议见 [TRACKING_PROTOCOL.md](./TRACKING_PROTOCOL.md)。Python 服务说明见 [PYTHON_TRACKING_SERVICE.md](./PYTHON_TRACKING_SERVICE.md)。

---

## 8. 仓库内验证示例

```bash
npm run build:sdk
node scripts/prepare-sdk-package.mjs
cd examples/basic-sdk-host
npm install
npm run dev
```

浏览器打开终端提示的本地地址（默认端口 `5274`），在「面部绑定」与「表情编排 + Tracking」页签间切换验证。
