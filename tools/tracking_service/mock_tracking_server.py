"""
Mock WebSocket 追踪服务：定时广播 tracking.rigFrame（与前端 normalizeRigFrameMessage 兼容）。
仅用于阶段 2.1 联调，不含 MediaPipe / 舵机协议。
"""

from __future__ import annotations

import asyncio
import json
import math
import signal
import time

import websockets

try:
    from websockets.exceptions import ConnectionClosed
except ImportError:  # pragma: no cover
    ConnectionClosed = Exception  # type: ignore[misc,assignment]

TRACKING_FRAME_TYPE = "tracking.rigFrame"
HOST = "127.0.0.1"
PORT = 8766
PATH = "/tracking"
# 与前端 Mock 一致：33ms 或 50ms
FRAME_INTERVAL_SEC = 0.05


def _connection_path(websocket) -> str:
    req = getattr(websocket, "request", None)
    if req is not None:
        return getattr(req, "path", "/") or "/"
    return getattr(websocket, "path", "/") or "/"


def build_rig_frame(elapsed_sec: float) -> dict:
    """生成与 createInitialEliteRig 结构一致的 rig，数值经前端 clamp。"""
    t = elapsed_sec
    # jaw.val：0~70 正弦
    jaw_val = (math.sin(t * 1.8) + 1.0) * 0.5 * 70.0

    smile = math.sin(t * 0.95) * 12.0
    # mouth 嘴角：轻微「微笑」变化（percent xy）
    side_l_x = max(0.0, min(100.0, 50.0 + smile * 0.6 + math.sin(t * 0.4) * 2.0))
    side_l_y = max(0.0, min(100.0, 52.0 + smile + math.cos(t * 0.37) * 3.0))
    side_r_x = max(0.0, min(100.0, 50.0 - smile * 0.6 - math.sin(t * 0.43) * 2.0))
    side_r_y = max(0.0, min(100.0, 52.0 + smile * 1.05 + math.cos(t * 0.39) * 3.0))

    blink_phase = math.sin(t * 2.92)
    blink_on = blink_phase > 0.93
    eye_l_lo = -52.0 if blink_on else 4.0 * math.sin(t * 2.05)
    eye_r_lo = -52.0 if blink_on else 4.0 * math.cos(t * 2.07)

    rx = max(45.0, min(55.0, 50.0 + math.sin(t * 0.55) * 4.8))
    ry = max(45.0, min(55.0, 50.0 + math.cos(t * 0.48) * 4.8))

    tongue_val = 14.0 * math.sin(t * 0.75)

    quality = max(0.0, min(1.0, 0.9 + 0.04 * math.sin(t * 0.33)))

    rig = {
        "browL": {"tip": 0.0, "mid": 0.0, "tail": 0.0},
        "browR": {"tip": 0.0, "mid": 0.0, "tail": 0.0},
        "eyeL": {"up": 2.0 * math.sin(t * 1.1), "lo": eye_l_lo},
        "eyeR": {"up": 2.0 * math.cos(t * 1.12), "lo": eye_r_lo},
        "sharedRadar": {"x": rx, "y": ry},
        "mouth": {
            "UL": 6.0 * math.sin(t * 0.6),
            "UR": 6.0 * math.cos(t * 0.61),
            "LL": -4.0 * math.sin(t * 0.58),
            "LR": -4.0 * math.cos(t * 0.59),
            "sideL": {"x": side_l_x, "y": side_l_y},
            "sideR": {"x": side_r_x, "y": side_r_y},
        },
        "tongue": {"val": tongue_val},
        "jaw": {"val": jaw_val},
    }

    now_ms = time.time() * 1000.0
    return {
        "type": TRACKING_FRAME_TYPE,
        "source": "python-websocket",
        "timestampMs": now_ms,
        "faceDetected": True,
        "quality": quality,
        "rig": rig,
    }


async def stream_client(websocket) -> None:
    t0 = time.perf_counter()
    try:
        while True:
            elapsed = time.perf_counter() - t0
            payload = json.dumps(build_rig_frame(elapsed))
            await websocket.send(payload)
            await asyncio.sleep(FRAME_INTERVAL_SEC)
    except ConnectionClosed:
        return
    except asyncio.CancelledError:
        raise
    except BrokenPipeError:
        return
    except ConnectionError:
        return


async def handle_connection(websocket) -> None:
    try:
        if _connection_path(websocket) != PATH:
            await websocket.close(code=1008, reason="connect to /tracking")
            return
    except Exception:
        await websocket.close(code=1011, reason="handshake error")
        return

    await stream_client(websocket)


async def serve_forever(stop: asyncio.Future) -> None:
    async with websockets.serve(handle_connection, HOST, PORT):
        await stop


def main() -> None:
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)

    stop = loop.create_future()

    def _shutdown(*_args) -> None:
        if not stop.done():
            stop.set_result(True)

    signal.signal(signal.SIGINT, _shutdown)
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, _shutdown)

    print(f"Mock tracking WS: ws://{HOST}:{PORT}{PATH}")
    print(f"Frame interval: {FRAME_INTERVAL_SEC * 1000:.0f} ms (edit FRAME_INTERVAL_SEC for 33ms => 0.033)")
    print("Ctrl+C to stop.")

    try:
        loop.run_until_complete(serve_forever(stop))
    finally:
        loop.close()


if __name__ == "__main__":
    main()
