import { useState } from "react"
import SerialConnectionPanel from "../components/SerialConnectionPanel.jsx"
import ServoControlPanel from "../components/ServoControlPanel.jsx"
import "../styles/servo-control-page.css"

/**
 * 串口 + 单舵机控制：左栏串口/日志，右栏舵机控制。
 */
export default function ServoControlPage({ onCurrentPoseChange, onConfigsChange }) {
  /** @type {[import('../sdk/servoAdapters/busServo/resolveBusTransport.js').BusTransportFamily, Function]} */
  const [transportFamily, setTransportFamily] = useState("feetech")

  return (
    <div className="servo-control-page">
      <SerialConnectionPanel transportFamily={transportFamily} />

      <div className="servo-control-panel-wrap">
        <ServoControlPanel
          onCurrentPoseChange={onCurrentPoseChange}
          onConfigsChange={onConfigsChange}
          onTransportFamilyChange={setTransportFamily}
        />
      </div>
    </div>
  )
}
