"""
MJPEG 预览帧上的 MediaPipe Face Landmarker overlay（OpenCV 绘制，不进入 WebSocket JSON）。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable

import cv2
import numpy as np

from mediapipe_to_rig import get_landmark_xy

try:
    from mediapipe.tasks.python.vision.face_landmarker import FaceLandmarksConnections as _FLC
except ImportError:  # pragma: no cover
    _FLC = None


# 与 rig / gaze 映射相关的关键点（minimal 模式）
def _conn(name: str) -> tuple[tuple[int, int], ...] | None:
    if _FLC is None:
        return None
    raw = getattr(_FLC, name, None)
    if raw is None:
        return None
    out: list[tuple[int, int]] = []
    for edge in raw:
        try:
            if hasattr(edge, "start") and hasattr(edge, "end"):
                out.append((int(edge.start), int(edge.end)))
            else:
                a, b = edge[0], edge[1]
                out.append((int(a), int(b)))
        except Exception:
            continue
    return tuple(out) if out else None


# Face Rig --face-rig-accent #06b6d4（OpenCV BGR；预览区背景偏暗，填充略提亮）
_POINT_FILL_BGR = (255, 200, 0)
_POINT_RING_BGR = (200, 160, 0)
_POINT_HALO_BGR = (28, 32, 38)
_SPARSE_POINT_RADIUS = 1
_SPARSE_RING_RADIUS = 2

def minimal_landmark_indices(mapping_config: dict[str, Any] | None = None) -> tuple[int, ...]:
    """minimal 稀疏点：眼/眉/嘴角/虹膜 + lipGeometry 驱动点。"""
    base = set(_MINIMAL_LANDMARK_INDICES)
    try:
        from lip_geometry import lip_geometry_overlay_indices

        for i in lip_geometry_overlay_indices(mapping_config):
            base.add(int(i))
    except ImportError:
        pass
    return tuple(sorted(base))


_MINIMAL_LANDMARK_INDICES: tuple[int, ...] = (
    33,
    133,
    159,
    145,
    263,
    362,
    386,
    374,
    61,
    291,
    78,
    308,
    13,
    14,
    17,
    152,
    70,
    105,
    107,
    300,
    334,
    336,
    468,
    469,
    470,
    471,
    472,
    473,
    474,
    475,
    476,
    477,
)

_REGION_SPECS: tuple[tuple[str, str, tuple[Any, ...]], ...] = (
    ("lips", (220, 80, 255), (_conn("FACE_LANDMARKS_LIPS"),)),
    ("left_eye", (80, 220, 255), (_conn("FACE_LANDMARKS_LEFT_EYE"), _conn("FACE_LANDMARKS_LEFT_IRIS"))),
    ("right_eye", (80, 255, 160), (_conn("FACE_LANDMARKS_RIGHT_EYE"), _conn("FACE_LANDMARKS_RIGHT_IRIS"))),
    (
        "left_brow",
        (80, 200, 255),
        (_conn("FACE_LANDMARKS_LEFT_EYEBROW"),),
    ),
    (
        "right_brow",
        (80, 255, 220),
        (_conn("FACE_LANDMARKS_RIGHT_EYEBROW"),),
    ),
    ("face_oval", (200, 200, 200), (_conn("FACE_LANDMARKS_FACE_OVAL"),)),
    ("nose", (255, 180, 80), (_conn("FACE_LANDMARKS_NOSE"),)),
)


def _mesh_connections() -> tuple[tuple[int, int], ...] | None:
    return _conn("FACE_LANDMARKS_TESSELATION")


@dataclass(frozen=True)
class PreviewOverlayConfig:
    draw_landmarks: bool = False
    draw_mesh: bool = False
    draw_regions: bool = False
    style: str = "regions"
    mesh_alpha: float = 0.35
    line_thickness: int = 1
    point_radius: int = 2  # sparse 模式使用 _SPARSE_* 常量，此项供 full 密集点回退

    @property
    def enabled(self) -> bool:
        return bool(self.draw_landmarks or self.draw_mesh or self.draw_regions)


def resolve_preview_overlay_config(
    *,
    style: str = "regions",
    draw_landmarks: bool | None = None,
    draw_mesh: bool | None = None,
    draw_regions: bool | None = None,
) -> PreviewOverlayConfig:
    """由 preset style + 可选显式开关合成最终绘制配置。"""
    s = (style or "regions").strip().lower()
    presets: dict[str, tuple[bool, bool, bool]] = {
        "minimal": (True, False, False),
        "mesh": (False, True, False),
        "regions": (False, False, True),
        "full": (True, True, True),
    }
    lm, mesh, reg = presets.get(s, presets["regions"])
    if draw_landmarks is not None:
        lm = bool(draw_landmarks)
    if draw_mesh is not None:
        mesh = bool(draw_mesh)
    if draw_regions is not None:
        reg = bool(draw_regions)
    return PreviewOverlayConfig(
        draw_landmarks=lm,
        draw_mesh=mesh,
        draw_regions=reg,
        style=s,
    )


def _landmarks_to_pixel_points(landmarks: Any, width: int, height: int) -> list[tuple[int, int]]:
    pts: list[tuple[int, int]] = []
    for i in range(len(list(landmarks))):
        xy = get_landmark_xy(landmarks, i)
        if xy is None:
            pts.append((0, 0))
            continue
        x = int(round(xy[0] * width))
        y = int(round(xy[1] * height))
        pts.append((x, y))
    return pts


def _draw_polyline_connections(
    frame: np.ndarray,
    pts: list[tuple[int, int]],
    connections: Iterable[tuple[int, int]],
    color: tuple[int, int, int],
    thickness: int,
) -> None:
    n = len(pts)
    for i, j in connections:
        if 0 <= i < n and 0 <= j < n and (i, j) != (0, 0):
            cv2.line(frame, pts[i], pts[j], color, thickness, lineType=cv2.LINE_AA)


def _draw_sparse_landmark_points(
    frame: np.ndarray,
    pts: list[tuple[int, int]],
    indices: Iterable[int],
) -> None:
    """少量关键点：小半径 + 青蓝填充，与 Face Rig 控件主色一致。"""
    n = len(pts)
    fill_r = _SPARSE_POINT_RADIUS
    ring_r = _SPARSE_RING_RADIUS
    for i in indices:
        if 0 <= i < n:
            x, y = pts[i]
            if x == 0 and y == 0:
                continue
            cv2.circle(frame, (x, y), ring_r, _POINT_HALO_BGR, 1, lineType=cv2.LINE_AA)
            cv2.circle(frame, (x, y), fill_r, _POINT_FILL_BGR, -1, lineType=cv2.LINE_AA)
            cv2.circle(frame, (x, y), fill_r, _POINT_RING_BGR, 1, lineType=cv2.LINE_AA)


def _draw_points(
    frame: np.ndarray,
    pts: list[tuple[int, int]],
    indices: Iterable[int],
    color: tuple[int, int, int],
    radius: int,
) -> None:
    n = len(pts)
    for i in indices:
        if 0 <= i < n:
            x, y = pts[i]
            if x == 0 and y == 0:
                continue
            cv2.circle(frame, (x, y), radius, color, -1, lineType=cv2.LINE_AA)
            cv2.circle(frame, (x, y), max(1, radius + 1), _POINT_RING_BGR, 1, lineType=cv2.LINE_AA)


def draw_preview_landmark_overlay(
    frame_bgr: np.ndarray,
    landmarks: Any,
    config: PreviewOverlayConfig,
    mapping_config: dict[str, Any] | None = None,
) -> np.ndarray:
    """
    在 BGR 帧上原地绘制 overlay；返回同一 frame 引用。
    landmarks 为单张脸的 landmark 列表（归一化 x,y）。
    """
    if not config.enabled or frame_bgr is None:
        return frame_bgr
    h, w = frame_bgr.shape[:2]
    if h < 2 or w < 2:
        return frame_bgr

    pts = _landmarks_to_pixel_points(landmarks, w, h)
    if not pts:
        return frame_bgr

    thick = max(1, int(config.line_thickness))
    pr = max(1, int(config.point_radius))

    if config.draw_mesh:
        mesh = _mesh_connections()
        if mesh:
            overlay = frame_bgr.copy()
            _draw_polyline_connections(overlay, pts, mesh, (60, 220, 120), 1)
            alpha = max(0.05, min(1.0, float(config.mesh_alpha)))
            cv2.addWeighted(overlay, alpha, frame_bgr, 1.0 - alpha, 0, frame_bgr)

    if config.draw_regions:
        for _name, color, conn_groups in _REGION_SPECS:
            for conns in conn_groups:
                if conns:
                    _draw_polyline_connections(frame_bgr, pts, conns, color, thick)

    if config.draw_landmarks:
        if config.style == "minimal" or not config.draw_mesh:
            sparse_idx = minimal_landmark_indices(mapping_config)
            _draw_sparse_landmark_points(frame_bgr, pts, sparse_idx)
        else:
            _draw_points(frame_bgr, pts, range(len(pts)), _POINT_FILL_BGR, max(1, pr))

    return frame_bgr
