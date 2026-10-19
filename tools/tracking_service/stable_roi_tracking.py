"""Phase 2.4 — Stable ROI：EMA + deadband + hysteresis + rate limit 矩形观察窗口。"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

from roi_tracking import RoiRect


@dataclass
class StableRoiConfig:
    center_ema_alpha: float = 0.12
    size_ema_alpha: float = 0.08
    center_deadband_px: float = 6.0
    size_hysteresis_ratio: float = 0.04
    max_center_step_px: float = 12.0
    max_width_step_px: float = 10.0
    max_height_step_px: float = 10.0
    min_width_px: int = 80
    min_height_px: int = 80


def _fit_rect_to_frame(
    cx: float,
    cy: float,
    width: float,
    height: float,
    fw: int,
    fh: int,
    min_w: int,
    min_h: int,
) -> tuple[int, int, int, int, bool]:
    """将中心+尺寸 fit 到帧内；返回 x,y,w,h 及是否发生边界修正（0/1 次计数）。"""
    w = max(int(min_w), int(round(width)))
    h = max(int(min_h), int(round(height)))
    w = min(w, fw)
    h = min(h, fh)
    x = int(round(cx - w / 2.0))
    y = int(round(cy - h / 2.0))
    clamped = False

    if x < 0:
        x = 0
        clamped = True
    if y < 0:
        y = 0
        clamped = True
    if x + w > fw:
        x = max(0, fw - w)
        clamped = True
    if y + h > fh:
        y = max(0, fh - h)
        clamped = True

    if w > fw:
        w = fw
        x = 0
        clamped = True
    if h > fh:
        h = fh
        y = 0
        clamped = True

    return x, y, w, h, clamped


def target_center_size_from_face_box(
    full_face_box: dict[str, float],
    frame_width: int,
    frame_height: int,
    multiplier: float,
    *,
    min_w: int = 80,
    min_h: int = 80,
) -> tuple[float, float, float, float]:
    """按人脸宽/高分别乘 multiplier，矩形 ROI（非正方形）。"""
    fw = max(1, int(frame_width))
    fh = max(1, int(frame_height))
    if "centerXPx" in full_face_box and "widthPx" in full_face_box:
        cx = float(full_face_box["centerXPx"])
        cy = float(full_face_box["centerYPx"])
        face_w = float(full_face_box["widthPx"])
        face_h = float(full_face_box["heightPx"])
    else:
        cx = float(full_face_box.get("centerX", 0.5)) * fw
        cy = float(full_face_box.get("centerY", 0.5)) * fh
        face_w = float(full_face_box.get("width", 0.1)) * fw
        face_h = float(full_face_box.get("height", 0.1)) * fh
    tw = max(float(min_w), face_w * float(multiplier))
    th = max(float(min_h), face_h * float(multiplier))
    return cx, cy, tw, th


class StableRoiTracker:
    """稳定矩形 ROI：宽/高独立平滑，不每帧完全跟随 faceBox。"""

    def __init__(self, config: StableRoiConfig | None = None) -> None:
        self._cfg = config or StableRoiConfig()
        self.reset()

    def reset(self) -> None:
        self._initialized = False
        self._smoothed_cx = 0.0
        self._smoothed_cy = 0.0
        self._smoothed_w = 0.0
        self._smoothed_h = 0.0
        self._target_cx = 0.0
        self._target_cy = 0.0
        self._target_w = 0.0
        self._target_h = 0.0
        self._last_update_applied = False
        self._last_update_reason = "not-initialized"
        self._frame_clamp_count = 0
        self._total_clamp_count = 0

    @property
    def initialized(self) -> bool:
        return self._initialized

    def get_roi_rect(self, frame_width: int, frame_height: int) -> RoiRect | None:
        if not self._initialized:
            return None
        cfg = self._cfg
        fw = max(1, int(frame_width))
        fh = max(1, int(frame_height))
        x, y, w, h, _ = _fit_rect_to_frame(
            self._smoothed_cx,
            self._smoothed_cy,
            self._smoothed_w,
            self._smoothed_h,
            fw,
            fh,
            cfg.min_width_px,
            cfg.min_height_px,
        )
        return RoiRect(x=x, y=y, w=w, h=h)

    def observe_after_frame(
        self,
        full_face_box: dict[str, float] | None,
        frame_width: int,
        frame_height: int,
        multiplier: float,
    ) -> dict[str, Any]:
        fw = max(1, int(frame_width))
        fh = max(1, int(frame_height))
        self._frame_clamp_count = 0
        cfg = self._cfg

        if not full_face_box:
            self._last_update_applied = False
            self._last_update_reason = "no-face-box"
            return self._debug_dict(fw, fh)

        tcx, tcy, tw, th = target_center_size_from_face_box(
            full_face_box,
            fw,
            fh,
            multiplier,
            min_w=cfg.min_width_px,
            min_h=cfg.min_height_px,
        )
        self._target_cx = tcx
        self._target_cy = tcy
        self._target_w = tw
        self._target_h = th

        if not self._initialized:
            self._smoothed_cx = tcx
            self._smoothed_cy = tcy
            self._smoothed_w = tw
            self._smoothed_h = th
            self._initialized = True
            self._last_update_applied = True
            self._last_update_reason = "init"
        else:
            reasons: list[str] = []
            applied = False

            center_dist = math.hypot(tcx - self._smoothed_cx, tcy - self._smoothed_cy)
            if center_dist <= cfg.center_deadband_px:
                aim_cx, aim_cy = self._smoothed_cx, self._smoothed_cy
                reasons.append("center-deadband")
            else:
                aim_cx, aim_cy = tcx, tcy
                reasons.append("center-track")
                applied = True

            w_ref = max(self._smoothed_w, 1.0)
            h_ref = max(self._smoothed_h, 1.0)
            w_delta_ratio = abs(tw - self._smoothed_w) / w_ref
            h_delta_ratio = abs(th - self._smoothed_h) / h_ref
            if w_delta_ratio < cfg.size_hysteresis_ratio:
                aim_w = self._smoothed_w
                reasons.append("width-hysteresis")
            else:
                aim_w = tw
                reasons.append("width-track")
                applied = True
            if h_delta_ratio < cfg.size_hysteresis_ratio:
                aim_h = self._smoothed_h
                reasons.append("height-hysteresis")
            else:
                aim_h = th
                reasons.append("height-track")
                applied = True

            new_cx = self._smoothed_cx + cfg.center_ema_alpha * (aim_cx - self._smoothed_cx)
            new_cy = self._smoothed_cy + cfg.center_ema_alpha * (aim_cy - self._smoothed_cy)
            new_w = self._smoothed_w + cfg.size_ema_alpha * (aim_w - self._smoothed_w)
            new_h = self._smoothed_h + cfg.size_ema_alpha * (aim_h - self._smoothed_h)

            step = math.hypot(new_cx - self._smoothed_cx, new_cy - self._smoothed_cy)
            if step > cfg.max_center_step_px and step > 1e-6:
                scale = cfg.max_center_step_px / step
                new_cx = self._smoothed_cx + (new_cx - self._smoothed_cx) * scale
                new_cy = self._smoothed_cy + (new_cy - self._smoothed_cy) * scale
                reasons.append("center-rate-limit")
                applied = True

            w_step = abs(new_w - self._smoothed_w)
            if w_step > cfg.max_width_step_px:
                new_w = self._smoothed_w + math.copysign(cfg.max_width_step_px, new_w - self._smoothed_w)
                reasons.append("width-rate-limit")
                applied = True
            h_step = abs(new_h - self._smoothed_h)
            if h_step > cfg.max_height_step_px:
                new_h = self._smoothed_h + math.copysign(cfg.max_height_step_px, new_h - self._smoothed_h)
                reasons.append("height-rate-limit")
                applied = True

            _, _, _, _, clamped = _fit_rect_to_frame(
                new_cx, new_cy, new_w, new_h, fw, fh, cfg.min_width_px, cfg.min_height_px
            )
            if clamped:
                self._frame_clamp_count = 1
                self._total_clamp_count += 1
                reasons.append("boundary-clamp")

            self._smoothed_cx = new_cx
            self._smoothed_cy = new_cy
            self._smoothed_w = new_w
            self._smoothed_h = new_h
            self._last_update_applied = applied
            self._last_update_reason = "+".join(reasons) if reasons else "hold"

        return self._debug_dict(fw, fh)

    def _debug_dict(self, fw: int, fh: int) -> dict[str, Any]:
        rect = self.get_roi_rect(fw, fh)
        cx = (rect.x + rect.w / 2.0) if rect else self._smoothed_cx
        cy = (rect.y + rect.h / 2.0) if rect else self._smoothed_cy
        return {
            "roiCenterXPx": round(cx, 2),
            "roiCenterYPx": round(cy, 2),
            "roiTargetCenterXPx": round(self._target_cx, 2),
            "roiTargetCenterYPx": round(self._target_cy, 2),
            "roiSmoothedCenterXPx": round(self._smoothed_cx, 2),
            "roiSmoothedCenterYPx": round(self._smoothed_cy, 2),
            "roiTargetWidthPx": round(self._target_w, 2),
            "roiTargetHeightPx": round(self._target_h, 2),
            "roiSmoothedWidthPx": round(self._smoothed_w, 2),
            "roiSmoothedHeightPx": round(self._smoothed_h, 2),
            "roiUpdateApplied": bool(self._last_update_applied),
            "roiUpdateReason": str(self._last_update_reason),
            "roiClampCount": int(self._frame_clamp_count),
        }
