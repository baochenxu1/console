import RightMouthFiveBarReachabilityOverlay from "../sdk/react/RightMouthFiveBarReachabilityOverlay.jsx"
import FaceRigVerticalScrub from "../sdk/react/faceRig/FaceRigVerticalScrub.jsx"
import FaceRigHorizontalScrub from "../sdk/react/faceRig/FaceRigHorizontalScrub.jsx"
import FaceRigNosePair from "../sdk/react/faceRig/FaceRigNosePair.jsx"
import FaceRigCornerPad from "../sdk/react/faceRig/FaceRigCornerPad.jsx"
import { syncSharedRadarMirror } from "../core/faceDofMapper.js"
import {
  BROW_TIP_BIND_CHANNEL_F,
} from "../sdk/binding/browTipBindingUi.js"
import {
  JAW_BIND_CHANNEL_A,
  JAW_BIND_CHANNEL_D,
} from "../sdk/binding/jawBindingUi.js"
import { useCallback, useState } from "react"

/**
 * Face Rig 面部控件工作台（与 {@link FaceRigPage} 中工作区一致，不含绑定检视与诊断栏）。
 * 铁律：不移动现有眉/睑/眼 Pad/嘴/嘴角/下颌翼主布局；鼻子绝对定位于眼间空隙；舌位留白。
 */
export default function FaceRigWorkspace({
  rig,
  setRig,
  setSelectedControlId,
  setSelectedChannel,
  selectedControlId = null,
  draggingControlId = null,
  setDraggingControlId,
  padLRef,
  padRRef,
  startRadar,
  radarLCxPx,
  radarLCyPx,
  radarRCxPx,
  radarRCyPx,
  eyeRadarAdjustArmed = null,
  showFiveBarReachabilityOverlay = false,
  rightMouthPadReachabilityMap = null,
  rightMouthPadEval = null,
}) {
  const [jawAdjusting, setJawAdjusting] = useState({ open: false, lateral: false })
  const jawSelected = selectedControlId === "jaw" || draggingControlId === "jaw"
  const jawWingAdjusting = jawAdjusting.open || jawAdjusting.lateral

  const onJawOpenAdjust = useCallback((armed) => {
    setJawAdjusting((prev) => (prev.open === armed ? prev : { ...prev, open: armed }))
  }, [])
  const onJawLateralAdjust = useCallback((armed) => {
    setJawAdjusting((prev) => (prev.lateral === armed ? prev : { ...prev, lateral: armed }))
  }, [])

  function valClass(controlId) {
    return selectedControlId === controlId || draggingControlId === controlId ? "is-val-visible" : ""
  }

  function scrubProps(controlId, variant, stackExtra = "", channel = null) {
    return {
      controlId,
      variant,
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
    <div className="face-rig-panel face-rig-panel-workspace">
      <div className="face-rig-workspace-inner">
        <div className="face-rig-assembly">
          <div className="face-rig-face-core">
            <div className="face-rig-eye-section">
              {["L", "R"].map((side) => {
                const isL = side === "L"
                const brow = isL ? rig.browL : rig.browR
                const eye = isL ? rig.eyeL : rig.eyeR
                const sideKey = isL ? "browL" : "browR"
                const eyeKey = isL ? "eyeL" : "eyeR"
                const cx = isL ? radarLCxPx : radarRCxPx
                const cy = isL ? radarLCyPx : radarRCyPx
                const eyeControlId = isL ? "eye_l_xy" : "eye_r_xy"
                const eyeSelected =
                  selectedControlId === eyeControlId || draggingControlId === eyeControlId
                const eyeAdjusting = Boolean(eyeRadarAdjustArmed?.[isL ? "L" : "R"])

                return (
                  <div key={side} className="face-rig-eye-column">
                    <div className="face-rig-brow-group">
                      {/* 尖端靠近鼻梁：左列 tail→mid→tip，右列 tip→mid→tail */}
                      {(isL ? ["tail", "mid", "tip"] : ["tip", "mid", "tail"]).map((p) => {
                        const id = `${isL ? "brow_l" : "brow_r"}_${p}`
                        if (p === "tip") {
                          const tipControlId = `${isL ? "brow_l" : "brow_r"}_tip`
                          const tipBindChannel = BROW_TIP_BIND_CHANNEL_F
                          return (
                            <div
                              key={p}
                              className="face-rig-brow-tip-pair"
                              title={
                                isL
                                  ? "眉尖二维目标 (x,y) → Five-Bar IK → brow_l_F(qF→ID24) / brow_l_D(qD→ID23)"
                                  : "眉尖二维目标 (x,y) → Five-Bar IK → brow_r_F(qF→ID1) / brow_r_D(qD→ID2)"
                              }
                            >
                              <FaceRigVerticalScrub
                                value={brow.y ?? 0}
                                rangeMode="signed"
                                onChange={(y) =>
                                  patchRig((prev) => ({
                                    ...prev,
                                    [sideKey]: {
                                      ...prev[sideKey],
                                      x: prev[sideKey]?.x ?? 0,
                                      y,
                                    },
                                  }))
                                }
                                {...scrubProps(tipControlId, "brow", "face-rig-handle-stack--compact", tipBindChannel)}
                              />
                              <FaceRigHorizontalScrub
                                value={brow.x ?? 0}
                                rangeMode="signed"
                                trackWidthPx={40}
                                variant="brow-lateral"
                                onChange={(x) =>
                                  patchRig((prev) => ({
                                    ...prev,
                                    [sideKey]: {
                                      ...prev[sideKey],
                                      x,
                                      y: prev[sideKey]?.y ?? 0,
                                    },
                                  }))
                                }
                                {...scrubProps(
                                  tipControlId,
                                  "brow-lateral",
                                  "face-rig-handle-stack--brow-lateral",
                                  tipBindChannel
                                )}
                              />
                            </div>
                          )
                        }
                        return (
                          <FaceRigVerticalScrub
                            key={p}
                            value={brow[p]}
                            onChange={(v) =>
                              patchRig((prev) => ({
                                ...prev,
                                [sideKey]: { ...prev[sideKey], [p]: v },
                              }))
                            }
                            {...scrubProps(id, "brow", "face-rig-handle-stack--compact")}
                          />
                        )
                      })}
                    </div>

                    <FaceRigVerticalScrub
                      value={eye.up}
                      onChange={(v) =>
                        patchRig((prev) => ({
                          ...prev,
                          [eyeKey]: { ...prev[eyeKey], up: v },
                        }))
                      }
                      {...scrubProps(`${isL ? "eye_l" : "eye_r"}_up`, "lid", "face-rig-handle-stack--lid")}
                    />

                    <div
                      role="presentation"
                      className={`face-rig-radar-box${eyeSelected ? " is-selected" : ""}${
                        eyeAdjusting ? " is-adjusting" : ""
                      }`}
                      data-eye-side={side}
                      title={eyeAdjusting ? "可调节：拖动" : "单击选定 · 双击后调节"}
                      onPointerDown={(e) => startRadar(e, side)}
                    >
                      <div className="face-rig-radar-grid" />
                      <div
                        className="face-rig-radar-cursor"
                        style={{
                          left: `${cx}px`,
                          top: `${cy}px`,
                        }}
                      />
                    </div>

                    <FaceRigVerticalScrub
                      value={eye.lo}
                      onChange={(v) =>
                        patchRig((prev) => ({
                          ...prev,
                          [eyeKey]: { ...prev[eyeKey], lo: v },
                        }))
                      }
                      {...scrubProps(`${isL ? "eye_l" : "eye_r"}_lo`, "lid", "face-rig-handle-stack--lid")}
                    />
                    <span className="face-rig-visually-hidden">{eyeControlId}</span>
                  </div>
                )
              })}

              <FaceRigNosePair
                noseL={rig.noseL?.val ?? 0}
                noseR={rig.noseR?.val ?? 0}
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

            <div className="face-rig-mouth-matrix">
              <div
                className="face-rig-mouth-cell face-rig-mouth-cell--corner"
                style={{ gridArea: "upL" }}
              >
                <FaceRigVerticalScrub
                  value={rig.mouth.UL}
                  onChange={(v) =>
                    patchRig((prev) => ({ ...prev, mouth: { ...prev.mouth, UL: v } }))
                  }
                  {...scrubProps("mouth_ul", "mouth")}
                />
              </div>
              <div
                className="face-rig-mouth-cell face-rig-mouth-cell--corner"
                style={{ gridArea: "upR" }}
              >
                <FaceRigVerticalScrub
                  value={rig.mouth.UR}
                  onChange={(v) =>
                    patchRig((prev) => ({ ...prev, mouth: { ...prev.mouth, UR: v } }))
                  }
                  {...scrubProps("mouth_ur", "mouth")}
                />
              </div>

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
                  selectedControlId === "mouth_corner_l" || draggingControlId === "mouth_corner_l"
                }
                onDragControlChange={setDraggingControlId}
                style={{ gridArea: "sideL" }}
                label="左嘴角"
              />

              <div className="face-rig-tongue-well" style={{ gridArea: "tongue" }} aria-hidden="true">
                <div className="face-rig-tag face-rig-tag-muted">—</div>
              </div>

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
                  selectedControlId === "mouth_corner_r" || draggingControlId === "mouth_corner_r"
                }
                onDragControlChange={setDraggingControlId}
                className="face-rig-mouth-corner-pad--fivebar-debug"
                style={{ gridArea: "sideR" }}
                label="右嘴角"
                labelClassName="face-rig-corner-label face-rig-corner-label-r"
              >
                {showFiveBarReachabilityOverlay && rightMouthPadReachabilityMap ? (
                  <RightMouthFiveBarReachabilityOverlay
                    reachabilityMap={rightMouthPadReachabilityMap}
                    currentEval={rightMouthPadEval}
                  />
                ) : null}
              </FaceRigCornerPad>

              <div
                className="face-rig-mouth-cell face-rig-mouth-cell--corner"
                style={{ gridArea: "loL" }}
              >
                <FaceRigVerticalScrub
                  value={rig.mouth.LL}
                  onChange={(v) =>
                    patchRig((prev) => ({ ...prev, mouth: { ...prev.mouth, LL: v } }))
                  }
                  {...scrubProps("mouth_ll", "mouth")}
                />
              </div>
              <div
                className="face-rig-mouth-cell face-rig-mouth-cell--corner"
                style={{ gridArea: "loR" }}
              >
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

          <aside
            className={`face-rig-jaw-wing${jawSelected ? " is-selected" : ""}${
              jawWingAdjusting ? " is-adjusting" : ""
            }`}
            title={jawWingAdjusting ? "可调节：拖动或滚轮" : "单击选定 · 双击后调节"}
          >
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
              {...scrubProps("jaw", "jaw", "", JAW_BIND_CHANNEL_A)}
            />
            <div className="face-rig-tag face-rig-tag-muted face-rig-jaw-foot">开合</div>
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
            <div className="face-rig-tag face-rig-tag-muted face-rig-jaw-foot">左右</div>
          </aside>
        </div>
      </div>
    </div>
  )
}
