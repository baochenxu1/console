import { useCallback, useState } from "react"
import RightMouthFiveBarReachabilityOverlay from "../sdk/react/RightMouthFiveBarReachabilityOverlay.jsx"
import FaceRigVerticalScrub from "../sdk/react/faceRig/FaceRigVerticalScrub.jsx"
import FaceRigHorizontalScrub from "../sdk/react/faceRig/FaceRigHorizontalScrub.jsx"
import FaceRigNosePair from "../sdk/react/faceRig/FaceRigNosePair.jsx"
import FaceRigCornerPad from "../sdk/react/faceRig/FaceRigCornerPad.jsx"
import FaceRigValInput from "../sdk/react/faceRig/FaceRigValInput.jsx"
import FaceRigValXYInput from "../sdk/react/faceRig/FaceRigValXYInput.jsx"
import { useFitScale } from "../sdk/react/faceRig/useFitScale.js"
import { syncSharedRadarMirror } from "../core/faceDofMapper.js"
import {
  JAW_BIND_CHANNEL_A,
  JAW_BIND_CHANNEL_D,
} from "../sdk/binding/jawBindingUi.js"
import {
  BROW_TIP_BIND_CHANNEL_F,
} from "../sdk/binding/browTipBindingUi.js"

/**
 * 表情编排控制台：左右分区眼部 / 口部控件（非整脸示意图），与 {@link FaceRigWorkspace} 共用同一 rig 状态与交互。
 */
export default function FaceRigControlConsole({
  rig,
  setRig,
  setSelectedControlId,
  setSelectedChannel,
  selectedControlId,
  draggingControlId,
  setDraggingControlId,
  padLRef,
  padRRef,
  startRadar,
  radarLCxPx,
  radarLCyPx,
  radarRCxPx,
  radarRCyPx,
  radarCxPx,
  radarCyPx,
  eyeRadarAdjustArmed = null,
  showFiveBarReachabilityOverlay = false,
  rightMouthPadReachabilityMap = null,
  rightMouthPadEval = null,
  /** Optional product Neck controls rendered below mouth (expression editor) */
  neckSlot = null,
}) {
  const browPointsL = ["tail", "mid", "tip"]
  const browPointsR = ["tip", "mid", "tail"]
  const lx = radarLCxPx ?? radarCxPx
  const ly = radarLCyPx ?? radarCyPx
  const rx = radarRCxPx ?? radarCxPx
  const ry = radarRCyPx ?? radarCyPx
  const [jawAdjusting, setJawAdjusting] = useState({ open: false, lateral: false })
  const jawSelected = selectedControlId === "jaw" || draggingControlId === "jaw"
  const jawWingAdjusting = jawAdjusting.open || jawAdjusting.lateral
  const onJawOpenAdjust = useCallback((armed) => {
    setJawAdjusting((prev) => (prev.open === armed ? prev : { ...prev, open: armed }))
  }, [])
  const onJawLateralAdjust = useCallback((armed) => {
    setJawAdjusting((prev) => (prev.lateral === armed ? prev : { ...prev, lateral: armed }))
  }, [])
  const { containerRef: eyeFitViewportRef, contentRef: eyeFitContentRef, scale: eyeFitScale } =
    useFitScale()
  const { containerRef: mouthFitViewportRef, contentRef: mouthFitContentRef, scale: mouthFitScale } =
    useFitScale({ padding: 4, minScale: 0.45 })
  const { containerRef: neckFitViewportRef, contentRef: neckFitContentRef, scale: neckFitScale } =
    useFitScale({ padding: 4, minScale: 0.5 })

  function valClass(controlId) {
    return selectedControlId === controlId || draggingControlId === controlId ? "is-val-visible" : ""
  }

  function scrubProps(controlId, variant, stackExtra = "", channel = null) {
    return {
      controlId,
      variant,
      valueInput: true,
      selected: selectedControlId === controlId || draggingControlId === controlId,
      onSelect: () => {
        setSelectedControlId(controlId)
        if (setSelectedChannel) {
          setSelectedChannel(channel || "value")
        }
      },
      onDragControlChange: setDraggingControlId,
      stackClassName: `face-rig-handle-stack ${stackExtra} ${valClass(controlId)}`.trim(),
    }
  }

  function patchRig(updater) {
    setRig((prev) => syncSharedRadarMirror(typeof updater === "function" ? updater(prev) : updater))
  }

  return (
    <div className="face-expression-rig-sections">
      <section className="face-expression-eye-section" aria-labelledby="face-expression-eye-heading">
        <h3 id="face-expression-eye-heading" className="face-expression-section-title">
          眼部控制区
        </h3>

        <div className="face-expression-eye-fit-viewport" ref={eyeFitViewportRef}>
          <div
            className="face-expression-eye-fit-scaler"
            ref={eyeFitContentRef}
            style={{ transform: `scale(${eyeFitScale})` }}
          >
        <div className="eye-brow-row">
          <div className="eye-brow-col">
            <span className="face-expression-mini-label">左眉</span>
            <div className="eye-brow-handles">
              {browPointsL.map((p) => {
                const id = `brow_l_${p}`
                if (p === "tip") {
                  return (
                    <div
                      key={id}
                      className="face-rig-brow-tip-pair"
                      title="眉尖二维目标 (x,y) → Five-Bar IK → brow_l_F(qF→ID24) / brow_l_D(qD→ID23)"
                    >
                      <FaceRigVerticalScrub
                        value={rig.browL.y ?? 0}
                        rangeMode="signed"
                        onChange={(y) =>
                          patchRig((prev) => ({
                            ...prev,
                            browL: {
                              ...prev.browL,
                              x: prev.browL?.x ?? 0,
                              y,
                            },
                          }))
                        }
                        {...scrubProps("brow_l_tip", "brow", "face-rig-handle-stack--compact", BROW_TIP_BIND_CHANNEL_F)}
                      />
                      <FaceRigHorizontalScrub
                        value={rig.browL.x ?? 0}
                        rangeMode="signed"
                        trackWidthPx={40}
                        variant="brow-lateral"
                        onChange={(x) =>
                          patchRig((prev) => ({
                            ...prev,
                            browL: {
                              ...prev.browL,
                              x,
                              y: prev.browL?.y ?? 0,
                            },
                          }))
                        }
                        {...scrubProps(
                          "brow_l_tip",
                          "brow-lateral",
                          "face-rig-handle-stack--brow-lateral",
                          BROW_TIP_BIND_CHANNEL_F
                        )}
                      />
                    </div>
                  )
                }
                return (
                  <FaceRigVerticalScrub
                    key={id}
                    value={rig.browL[p]}
                    onChange={(v) =>
                      patchRig((prev) => ({
                        ...prev,
                        browL: { ...prev.browL, [p]: v },
                      }))
                    }
                    {...scrubProps(id, "brow", "face-rig-handle-stack--compact")}
                  />
                )
              })}
            </div>
          </div>
          <div className="eye-brow-col">
            <span className="face-expression-mini-label">右眉</span>
            <div className="eye-brow-handles">
              {browPointsR.map((p) => {
                const id = `brow_r_${p}`
                if (p === "tip") {
                  return (
                    <div
                      key={id}
                      className="face-rig-brow-tip-pair"
                      title="眉尖二维目标 (x,y) → Five-Bar IK → brow_r_F(qF→ID1) / brow_r_D(qD→ID2)"
                    >
                      <FaceRigVerticalScrub
                        value={rig.browR.y ?? 0}
                        rangeMode="signed"
                        onChange={(y) =>
                          patchRig((prev) => ({
                            ...prev,
                            browR: {
                              ...prev.browR,
                              x: prev.browR?.x ?? 0,
                              y,
                            },
                          }))
                        }
                        {...scrubProps("brow_r_tip", "brow", "face-rig-handle-stack--compact", BROW_TIP_BIND_CHANNEL_F)}
                      />
                      <FaceRigHorizontalScrub
                        value={rig.browR.x ?? 0}
                        rangeMode="signed"
                        trackWidthPx={40}
                        variant="brow-lateral"
                        onChange={(x) =>
                          patchRig((prev) => ({
                            ...prev,
                            browR: {
                              ...prev.browR,
                              x,
                              y: prev.browR?.y ?? 0,
                            },
                          }))
                        }
                        {...scrubProps(
                          "brow_r_tip",
                          "brow-lateral",
                          "face-rig-handle-stack--brow-lateral",
                          BROW_TIP_BIND_CHANNEL_F
                        )}
                      />
                    </div>
                  )
                }
                return (
                  <FaceRigVerticalScrub
                    key={id}
                    value={rig.browR[p]}
                    onChange={(v) =>
                      patchRig((prev) => ({
                        ...prev,
                        browR: { ...prev.browR, [p]: v },
                      }))
                    }
                    {...scrubProps(id, "brow", "face-rig-handle-stack--compact")}
                  />
                )
              })}
            </div>
          </div>
        </div>

        <div className="eye-upper-row">
          <div className="eye-lid-cell">
            <span className="face-expression-mini-label">左上眼皮</span>
            <FaceRigVerticalScrub
              value={rig.eyeL.up}
              onChange={(v) =>
                patchRig((prev) => ({
                  ...prev,
                  eyeL: { ...prev.eyeL, up: v },
                }))
              }
              {...scrubProps("eye_l_up", "lid", "face-rig-handle-stack--lid")}
            />
          </div>
          <div className="eye-lid-cell">
            <span className="face-expression-mini-label">右上眼皮</span>
            <FaceRigVerticalScrub
              value={rig.eyeR.up}
              onChange={(v) =>
                patchRig((prev) => ({
                  ...prev,
                  eyeR: { ...prev.eyeR, up: v },
                }))
              }
              {...scrubProps("eye_r_up", "lid", "face-rig-handle-stack--lid")}
            />
          </div>
        </div>

        <div className="eye-radar-row">
          <div className={`eye-radar-cell ${valClass("eye_l_xy")}`}>
            <span className="face-expression-mini-label">左眼球</span>
            <FaceRigValXYInput
              x={rig.eyeL?.x ?? 50}
              y={rig.eyeL?.y ?? 50}
              pillClassName="face-rig-val-pill--radar"
              ariaLabel="左眼球坐标"
              onSelect={() => setSelectedControlId("eye_l_xy")}
              onChange={({ x, y }) =>
                patchRig((prev) => ({
                  ...prev,
                  eyeL: { ...prev.eyeL, x, y },
                }))
              }
            />
            <div className="face-expression-radar-scale">
              <div
                role="presentation"
                className={`face-rig-radar-box${
                  selectedControlId === "eye_l_xy" || draggingControlId === "eye_l_xy"
                    ? " is-selected"
                    : ""
                }${eyeRadarAdjustArmed?.L ? " is-adjusting" : ""}`}
                title={
                  eyeRadarAdjustArmed?.L ? "可调节：拖动" : "单击选定 · 双击后调节"
                }
                onPointerDown={(e) => startRadar(e, "L")}
              >
                <div className="face-rig-radar-grid" />
                <div
                  className="face-rig-radar-cursor"
                  style={{ left: `${lx}px`, top: `${ly}px` }}
                />
              </div>
            </div>
          </div>
          <div className={`eye-radar-cell ${valClass("eye_r_xy")}`}>
            <span className="face-expression-mini-label">右眼球</span>
            <FaceRigValXYInput
              x={rig.eyeR?.x ?? 50}
              y={rig.eyeR?.y ?? 50}
              pillClassName="face-rig-val-pill--radar"
              ariaLabel="右眼球坐标"
              onSelect={() => setSelectedControlId("eye_r_xy")}
              onChange={({ x, y }) =>
                patchRig((prev) => ({
                  ...prev,
                  eyeR: { ...prev.eyeR, x, y },
                }))
              }
            />
            <div className="face-expression-radar-scale">
              <div
                role="presentation"
                className={`face-rig-radar-box${
                  selectedControlId === "eye_r_xy" || draggingControlId === "eye_r_xy"
                    ? " is-selected"
                    : ""
                }${eyeRadarAdjustArmed?.R ? " is-adjusting" : ""}`}
                title={
                  eyeRadarAdjustArmed?.R ? "可调节：拖动" : "单击选定 · 双击后调节"
                }
                onPointerDown={(e) => startRadar(e, "R")}
              >
                <div className="face-rig-radar-grid" />
                <div
                  className="face-rig-radar-cursor"
                  style={{ left: `${rx}px`, top: `${ry}px` }}
                />
              </div>
            </div>
          </div>
        </div>

        <div className="eye-lower-row">
          <div className="eye-lid-cell">
            <span className="face-expression-mini-label">左下眼皮</span>
            <FaceRigVerticalScrub
              value={rig.eyeL.lo}
              onChange={(v) =>
                patchRig((prev) => ({
                  ...prev,
                  eyeL: { ...prev.eyeL, lo: v },
                }))
              }
              {...scrubProps("eye_l_lo", "lid", "face-rig-handle-stack--lid")}
            />
          </div>
          <div className="eye-lid-cell">
            <span className="face-expression-mini-label">右下眼皮</span>
            <FaceRigVerticalScrub
              value={rig.eyeR.lo}
              onChange={(v) =>
                patchRig((prev) => ({
                  ...prev,
                  eyeR: { ...prev.eyeR, lo: v },
                }))
              }
              {...scrubProps("eye_r_lo", "lid", "face-rig-handle-stack--lid")}
            />
          </div>
        </div>

        <div className="eye-nose-row" aria-label="鼻子">
          <span className="face-expression-mini-label">鼻子（仅上抬）</span>
          <FaceRigNosePair
            noseL={rig.noseL?.val ?? 0}
            noseR={rig.noseR?.val ?? 0}
            valueInput
            onChangeNose={({ noseL, noseR }) =>
              patchRig((prev) => ({
                ...prev,
                noseL: { val: noseL },
                noseR: { val: noseR },
              }))
            }
            setSelectedControlId={setSelectedControlId}
            setDraggingControlId={setDraggingControlId}
            selectedControlId={selectedControlId}
            draggingControlId={draggingControlId}
          />
        </div>

        <p className="face-expression-radar-hint">左右眼球独立：左/右雷达分别控制 eye_l_xy / eye_r_xy</p>
          </div>
        </div>
      </section>

      <section className="face-expression-mouth-section" aria-labelledby="face-expression-mouth-heading">
        <h3 id="face-expression-mouth-heading" className="face-expression-section-title">
          口部控制区
        </h3>

        <div className="mouth-fit-viewport" ref={mouthFitViewportRef}>
          <div
            className="mouth-fit-scaler"
            ref={mouthFitContentRef}
            style={{ transform: `scale(${mouthFitScale})` }}
          >
        <div className="mouth-section-body">
          <div className="mouth-main-area">
            <div className="mouth-matrix">
              <div className="mouth-row mouth-row--upper">
                <div className="mouth-cell">
                  <span className="face-expression-mini-label">上唇左</span>
                  <FaceRigVerticalScrub
                    value={rig.mouth.UL}
                    onChange={(v) =>
                      patchRig((prev) => ({ ...prev, mouth: { ...prev.mouth, UL: v } }))
                    }
                    {...scrubProps("mouth_ul", "mouth")}
                  />
                </div>
                <div className="mouth-cell">
                  <span className="face-expression-mini-label">上唇右</span>
                  <FaceRigVerticalScrub
                    value={rig.mouth.UR}
                    onChange={(v) =>
                      patchRig((prev) => ({ ...prev, mouth: { ...prev.mouth, UR: v } }))
                    }
                    {...scrubProps("mouth_ur", "mouth")}
                  />
                </div>
              </div>

              <div className="mouth-row mouth-row--mid">
                <div className={`mouth-cell mouth-corner-wrap ${valClass("mouth_corner_l")}`}>
                  <span className="face-expression-mini-label">左嘴角</span>
                  <FaceRigValXYInput
                    x={rig.mouth.sideL.x}
                    y={rig.mouth.sideL.y}
                    pillClassName="face-rig-val-pill--corner"
                    ariaLabel="左嘴角坐标"
                    onSelect={() => setSelectedControlId("mouth_corner_l")}
                    onChange={(next) =>
                      patchRig((prev) => ({
                        ...prev,
                        mouth: { ...prev.mouth, sideL: { ...next } },
                      }))
                    }
                  />
                  <FaceRigCornerPad
                    ref={padLRef}
                    x={rig.mouth.sideL.x}
                    y={rig.mouth.sideL.y}
                    onChange={(next) =>
                      patchRig((prev) => ({
                        ...prev,
                        mouth: { ...prev.mouth, sideL: { ...next } },
                      }))
                    }
                    onSelect={() => setSelectedControlId("mouth_corner_l")}
                    controlId="mouth_corner_l"
                    selected={
                      selectedControlId === "mouth_corner_l" ||
                      draggingControlId === "mouth_corner_l"
                    }
                    onDragControlChange={setDraggingControlId}
                    className="face-expression-corner-pad"
                  />
                </div>
                <div className="mouth-cell mouth-tongue-cell" aria-hidden="true">
                  <span className="face-expression-mini-label">—</span>
                </div>
                <div className={`mouth-cell mouth-corner-wrap ${valClass("mouth_corner_r")}`}>
                  <span className="face-expression-mini-label">右嘴角</span>
                  <FaceRigValXYInput
                    x={rig.mouth.sideR.x}
                    y={rig.mouth.sideR.y}
                    pillClassName="face-rig-val-pill--corner"
                    ariaLabel="右嘴角坐标"
                    onSelect={() => setSelectedControlId("mouth_corner_r")}
                    onChange={(next) =>
                      patchRig((prev) => ({
                        ...prev,
                        mouth: { ...prev.mouth, sideR: { ...next } },
                      }))
                    }
                  />
                  <FaceRigCornerPad
                    ref={padRRef}
                    x={rig.mouth.sideR.x}
                    y={rig.mouth.sideR.y}
                    onChange={(next) =>
                      patchRig((prev) => ({
                        ...prev,
                        mouth: { ...prev.mouth, sideR: { ...next } },
                      }))
                    }
                    onSelect={() => setSelectedControlId("mouth_corner_r")}
                    controlId="mouth_corner_r"
                    selected={
                      selectedControlId === "mouth_corner_r" ||
                      draggingControlId === "mouth_corner_r"
                    }
                    onDragControlChange={setDraggingControlId}
                    className="face-expression-corner-pad face-rig-mouth-corner-pad--fivebar-debug"
                  >
                    {showFiveBarReachabilityOverlay && rightMouthPadReachabilityMap ? (
                      <RightMouthFiveBarReachabilityOverlay
                        reachabilityMap={rightMouthPadReachabilityMap}
                        currentEval={rightMouthPadEval}
                      />
                    ) : null}
                  </FaceRigCornerPad>
                </div>
              </div>

              <div className="mouth-row mouth-row--lower">
                <div className="mouth-cell">
                  <span className="face-expression-mini-label">下唇左</span>
                  <FaceRigVerticalScrub
                    value={rig.mouth.LL}
                    onChange={(v) =>
                      patchRig((prev) => ({ ...prev, mouth: { ...prev.mouth, LL: v } }))
                    }
                    {...scrubProps("mouth_ll", "mouth")}
                  />
                </div>
                <div className="mouth-cell">
                  <span className="face-expression-mini-label">下唇右</span>
                  <FaceRigVerticalScrub
                    value={rig.mouth.LR}
                    onChange={(v) =>
                      patchRig((prev) => ({ ...prev, mouth: { ...prev.mouth, LR: v } }))
                    }
                    {...scrubProps("mouth_lr", "mouth")}
                  />
                </div>
              </div>
            </div>
          </div>

          <div
            className={`jaw-side-area ${valClass("jaw")}${jawSelected ? " is-selected" : ""}${
              jawWingAdjusting ? " is-adjusting" : ""
            }`}
            title={jawWingAdjusting ? "可调节：拖动或滚轮" : "单击选定 · 双击后调节"}
          >
            <div className="jaw-side-inner">
              <span className="face-expression-mini-label jaw-side-label">下颌开合</span>
              <FaceRigVerticalScrub
                value={rig.jaw?.val ?? 0}
                onChange={(v) =>
                  patchRig((prev) => ({
                    ...prev,
                    jaw: { ...prev.jaw, val: v, lateral: prev.jaw?.lateral ?? 0 },
                  }))
                }
                selectionChrome="none"
                onAdjustArmedChange={onJawOpenAdjust}
                {...scrubProps("jaw", "jaw", "face-rig-jaw-stack", JAW_BIND_CHANNEL_A)}
              />
              <span className="face-expression-mini-label jaw-side-label">下颌左右</span>
              <FaceRigHorizontalScrub
                value={rig.jaw?.lateral ?? 0}
                onChange={(v) =>
                  patchRig((prev) => ({
                    ...prev,
                    jaw: { ...prev.jaw, val: prev.jaw?.val ?? 0, lateral: v },
                  }))
                }
                rangeMode="signed50"
                selectionChrome="none"
                onAdjustArmedChange={onJawLateralAdjust}
                {...scrubProps("jaw", "jaw-lateral", "face-rig-handle-stack--jaw-lateral", JAW_BIND_CHANNEL_D)}
              />
              <FaceRigValInput
                value={rig.jaw?.lateral ?? 0}
                rangeMode="signed50"
                onSelect={() => {
                  setSelectedControlId("jaw")
                  setSelectedChannel?.(JAW_BIND_CHANNEL_D)
                }}
                onChange={(v) =>
                  patchRig((prev) => ({
                    ...prev,
                    jaw: { ...prev.jaw, val: prev.jaw?.val ?? 0, lateral: v },
                  }))
                }
                className="face-rig-val-pill face-rig-val-pill--jaw-lateral-readout"
                ariaLabel="下颌左右"
              />
            </div>
          </div>
        </div>
        </div>
        </div>

        {neckSlot ? (
          <div className="mouth-section-neck-slot">
            <div className="neck-fit-viewport" ref={neckFitViewportRef}>
              <div
                className="neck-fit-scaler"
                ref={neckFitContentRef}
                style={{ transform: `scale(${neckFitScale})` }}
              >
                {neckSlot}
              </div>
            </div>
          </div>
        ) : null}
      </section>
    </div>
  )
}
