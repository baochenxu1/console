/**
 * Character Preset Preview Stage — unified logical canvas + uniform contain scale.
 * Consumes one CharacterPose; read-only Face + Neck presentation.
 */

import { useLayoutEffect, useRef, useState } from "react"
import { createNeutralCharacterPose } from "../../../core/characterPose.js"
import {
  CHARACTER_PRESET_STAGE_LOGICAL,
  computeUniformContainScale,
} from "../../expression/characterPresetPreviewStage.js"
import FaceRigPreviewCanvas from "../FaceRigPreviewCanvas.jsx"
import NeckReadOnlyPreview from "./NeckReadOnlyPreview.jsx"

export default function CharacterPresetPreviewStage({
  characterPose = null,
  scopeLabel = "Face",
  className = "",
}) {
  const pose = characterPose || createNeutralCharacterPose()
  const face = pose.face
  const neck = pose.neck
  const viewportRef = useRef(null)
  const [scale, setScale] = useState(1)
  const logical = CHARACTER_PRESET_STAGE_LOGICAL

  useLayoutEffect(() => {
    const el = viewportRef.current
    if (!el) return undefined
    const update = () => {
      const next = computeUniformContainScale(el.clientWidth, el.clientHeight, logical.width, logical.height, 6)
      setScale((prev) => (Math.abs(prev - next) < 0.003 ? prev : next))
    }
    update()
    const ro = new ResizeObserver(() => window.requestAnimationFrame(update))
    ro.observe(el)
    return () => ro.disconnect()
  }, [logical.width, logical.height])

  return (
    <section
      className={`xp-char-stage${className ? ` ${className}` : ""}`}
      aria-label="Character Preview"
    >
      <header className="xp-char-stage-head">
        <h2>当前预览</h2>
        <span className="xp-preview-scope">{scopeLabel}</span>
      </header>

      <div className="xp-char-stage-viewport" ref={viewportRef}>
        <div
          className="xp-char-stage-logical"
          data-logical-width={logical.width}
          data-logical-height={logical.height}
          data-uniform-scale={scale.toFixed(4)}
          style={{
            width: logical.width,
            height: logical.height,
            transform: `scale(${scale})`,
          }}
        >
          <div
            className="xp-char-stage-face"
            style={{
              left: logical.face.x,
              top: logical.face.y,
              width: logical.face.width,
              height: logical.face.height,
            }}
            aria-label="Face Preview"
          >
            {face ? (
              <FaceRigPreviewCanvas
                rig={face}
                fitMode="contain"
                variant="preset"
                className="xp-face-preview-canvas"
              />
            ) : null}
          </div>

          <div
            className="xp-char-stage-neck"
            style={{ top: logical.neck.clusterTop }}
            aria-label="Neck Preview"
          >
            <NeckReadOnlyPreview
              neck={neck}
              padSize={logical.neck.padSize}
              yawWidth={logical.neck.yawWidth}
            />
          </div>
        </div>
      </div>
    </section>
  )
}
