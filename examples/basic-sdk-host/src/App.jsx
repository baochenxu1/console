import { useMemo, useState } from "react"
import {
  FaceBindingEditor,
  FaceExpressionEditor,
  REALTIME_THROTTLE_MS,
  useFaceRigInteraction,
} from "@facedev/sdk/react"

/** 空 keyframes 会在编辑器内归一化为默认单帧工程（与主工程 frameProject 行为一致）。 */
function createInitialFrameProject() {
  return {
    version: "1.0.0",
    projectType: "robot-face-single-expression",
    expressionId: "expr_sdk_host",
    expressionName: "SDK Host 演示",
    keyframes: [],
    updatedAt: new Date().toISOString(),
  }
}

export default function App() {
  const configs = useMemo(() => [], [])
  const rig = useFaceRigInteraction(configs)
  const [frameProject, setFrameProject] = useState(createInitialFrameProject)
  const [currentPose, setCurrentPose] = useState(() => ({}))
  const [tab, setTab] = useState("binding")

  return (
    <div style={{ minHeight: "100vh", background: "#0f1218", color: "#e8eaef" }}>
      <header
        style={{
          padding: "12px 20px",
          borderBottom: "1px solid #2a3142",
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <strong>FaceDEV · basic-sdk-host</strong>
        <span style={{ opacity: 0.75, fontSize: 13 }}>
          演示 <code>@facedev/sdk</code>：绑定 / 表情（含 Tracking）。自建适配器可从{" "}
          <code>@facedev/sdk/tracking</code> 引入 <code>createWebSocketTrackingAdapter</code>；表情区内已含 WebSocket Tracking（默认{" "}
          <code>ws://127.0.0.1:8766/tracking</code>）。
        </span>
      </header>

      <nav style={{ padding: "10px 20px", display: "flex", gap: 8 }}>
        {[
          ["binding", "面部绑定"],
          ["expression", "表情编排 + Tracking"],
        ].map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            style={{
              padding: "8px 14px",
              borderRadius: 8,
              border: tab === id ? "1px solid #5b8cff" : "1px solid #3d465a",
              background: tab === id ? "#1a2336" : "#151a24",
              color: "#e8eaef",
              cursor: "pointer",
            }}
          >
            {label}
          </button>
        ))}
      </nav>

      <div style={{ height: "calc(100vh - 120px)", overflow: "auto" }}>
        {tab === "binding" ? (
          <FaceBindingEditor
            configs={configs}
            rigApi={rig}
            realtimeThrottleMs={REALTIME_THROTTLE_MS}
          />
        ) : (
          <FaceExpressionEditor
            configs={configs}
            frameProject={frameProject}
            onFrameProjectChange={setFrameProject}
            currentPose={currentPose}
            onCurrentPoseChange={setCurrentPose}
            servoConfigSnapshot={null}
          />
        )}
      </div>
    </div>
  )
}
