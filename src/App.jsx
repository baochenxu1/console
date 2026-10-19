import ServoControlPage from "./pages/ServoControlPage.jsx"
import FrameEditor from "./components/FrameEditor.jsx"
import FaceRigPage from "./pages/FaceRigPage.jsx"
import FaceExpressionEditorPage from "./pages/FaceExpressionEditorPage.jsx"
import ExpressionPresetPage from "./pages/ExpressionPresetPage.jsx"
import TrackingPreviewPage from "./pages/TrackingPreviewPage.jsx"
import AudioInputDebugPage from "./pages/AudioInputDebugPage.jsx"
import { useCallback, useRef, useState } from "react"
import { createDefaultFrameProject } from "./core/frameProject.js"
import { getFaceConsoleBuildInfo } from "./core/faceConsoleBuildInfo.js"
import { loadServoConfigProject, SERVO_COUNT } from "./core/servoConfig.js"
import "./App.css"
import "./styles/base.css"
import "./styles/layout.css"
import "./styles/serial-panels.css"
import "./styles/serial-capsule.css"
import "./styles/servo-panels.css"

const BUILD_INFO = getFaceConsoleBuildInfo()

const VALID_APP_PAGES = new Set([
  "control",
  "frame",
  "facerig",
  "expression",
  "presets",
  "trackingPreview",
  "audioInput",
])

/** 兼容 ?page=audioInput 与调试路径写法 /debug/audio-input */
const PAGE_ALIASES = Object.freeze({
  "audio-input": "audioInput",
  "debug/audio-input": "audioInput",
  "/debug/audio-input": "audioInput",
})

/** 支持 ?page=trackingPreview 直达追踪预览页（发布包一键启动用） */
function readInitialAppPage() {
  try {
    const page = new URLSearchParams(window.location.search).get("page")
    const normalized = PAGE_ALIASES[page] || page
    if (normalized && VALID_APP_PAGES.has(normalized)) {
      return normalized
    }
  } catch {
    /* ignore */
  }
  return "control"
}

export default function App() {
  const [activePage, setActivePage] = useState(readInitialAppPage)
  const [servoConfigProject, setServoConfigProject] = useState(() => loadServoConfigProject())
  const [frameProject, setFrameProject] = useState(() => createDefaultFrameProject())
  const [currentPose, setCurrentPose] = useState(() =>
    Object.fromEntries(Array.from({ length: SERVO_COUNT }, (_, servoId) => [String(servoId), 1500]))
  )
  const presetPageApiRef = useRef(null)
  const expressionPageApiRef = useRef(null)
  const handleServoConfigsChange = useCallback((nextConfigs) => {
    if (!Array.isArray(nextConfigs)) return
    setServoConfigProject((prev) => ({
      ...prev,
      servos: nextConfigs,
    }))
  }, [])

  const requestPageChange = useCallback(
    async (next) => {
      if (next === activePage) return
      if (activePage === "presets") {
        await presetPageApiRef.current?.prepareLeave?.()
      }
      if (activePage === "expression") {
        await expressionPageApiRef.current?.prepareLeave?.()
      }
      setActivePage(next)
    },
    [activePage]
  )

  return (
    <main className="app">
      <header className="app-header">
        <div className="app-brand">
          <span className="app-brand-mark" aria-hidden="true">
            FC
          </span>
          <div className="app-brand-text">
            <h1 className="app-brand-title">Face Console</h1>
            <p className="app-brand-tagline" title={`built ${BUILD_INFO.buildTime || "n/a"}`}>
              面部舵机控制 · Web Serial · {BUILD_INFO.label}
            </p>
          </div>
        </div>
        <div className="app-page-switch">
          <button
            type="button"
            className={activePage === "control" ? "active" : ""}
            onClick={() => void requestPageChange("control")}
          >
            串口与单舵机控制
          </button>
          <button
            type="button"
            className={activePage === "frame" ? "active" : ""}
            onClick={() => void requestPageChange("frame")}
          >
            动作帧编辑与预览
          </button>
          <button
            type="button"
            className={activePage === "facerig" ? "active" : ""}
            onClick={() => void requestPageChange("facerig")}
          >
            面部绑定
          </button>
          <button
            type="button"
            className={activePage === "expression" ? "active" : ""}
            onClick={() => void requestPageChange("expression")}
          >
            表情编排
          </button>
          <button
            type="button"
            className={activePage === "presets" ? "active" : ""}
            onClick={() => void requestPageChange("presets")}
          >
            常用表情
          </button>
          <button
            type="button"
            className={activePage === "trackingPreview" ? "active" : ""}
            onClick={() => void requestPageChange("trackingPreview")}
          >
            追踪预览
          </button>
          <button
            type="button"
            className={activePage === "audioInput" ? "active" : ""}
            onClick={() => void requestPageChange("audioInput")}
          >
            语音交互调试
          </button>
        </div>
      </header>

      {activePage === "control" ? (
        <ServoControlPage
          onCurrentPoseChange={setCurrentPose}
          onConfigsChange={handleServoConfigsChange}
        />
      ) : activePage === "frame" ? (
        <FrameEditor
          project={frameProject}
          configs={servoConfigProject.servos}
          servoConfigSnapshot={servoConfigProject}
          currentPose={currentPose}
          onCurrentPoseChange={setCurrentPose}
          onProjectChange={setFrameProject}
        />
      ) : activePage === "facerig" ? (
        <FaceRigPage configs={servoConfigProject.servos} />
      ) : activePage === "expression" ? (
        <FaceExpressionEditorPage
          configs={servoConfigProject.servos}
          frameProject={frameProject}
          onFrameProjectChange={setFrameProject}
          currentPose={currentPose}
          onCurrentPoseChange={setCurrentPose}
          servoConfigSnapshot={servoConfigProject}
          apiRef={expressionPageApiRef}
        />
      ) : activePage === "presets" ? (
        <ExpressionPresetPage
          configs={servoConfigProject.servos}
          frameProject={frameProject}
          apiRef={presetPageApiRef}
        />
      ) : activePage === "audioInput" ? (
        <AudioInputDebugPage />
      ) : (
        <TrackingPreviewPage configs={servoConfigProject.servos} />
      )}
    </main>
  )
}
