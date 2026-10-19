#!/usr/bin/env bash
# One-click start (macOS / Linux)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$ROOT/package.json" ]]; then
  :
else
  ROOT="$(cd "$ROOT/.." && pwd)"
fi

SETUP_SCRIPT="$ROOT/setup-camera-tracking.sh"
if [[ ! -f "$SETUP_SCRIPT" ]]; then
  SETUP_SCRIPT="$ROOT/release/setup-camera-tracking.sh"
fi

HELPER="$(dirname "${BASH_SOURCE[0]}")/tracking-model.sh"
if [[ ! -f "$HELPER" ]]; then
  HELPER="$ROOT/release/tracking-model.sh"
fi
# shellcheck source=/dev/null
source "$HELPER"

TRACKING_DIR="$ROOT/tools/tracking_service"
VENV_PYTHON="$TRACKING_DIR/.venv/bin/python"
MODEL_PATH="$TRACKING_DIR/models/face_landmarker.task"
CAMERA_INDEX="${TRACKING_CAMERA:-0}"
FRONTEND_URL="http://localhost:5173/?page=trackingPreview"

wait_for_port() {
  local port="$1"
  local timeout="${2:-45}"
  local i=0
  while (( i < timeout )); do
    if (echo >/dev/tcp/127.0.0.1/"$port") >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
    ((i++))
  done
  return 1
}

port_open() {
  (echo >/dev/tcp/127.0.0.1/"$1") >/dev/null 2>&1
}

echo "=== FaceDEV camera tracking - start ==="

command -v node >/dev/null 2>&1 || { echo "错误: 未找到 node"; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "错误: 未找到 npm"; exit 1; }

if [[ ! -x "$VENV_PYTHON" ]] || [[ ! -d "$ROOT/node_modules" ]]; then
  echo "Running setup..."
  bash "$SETUP_SCRIPT"
fi

ensure_face_landmarker_model "$MODEL_PATH"

if port_open 8766; then
  echo "警告: 端口 8766 已占用。若追踪服务已在运行可继续。"
else
  echo "Starting Python MediaPipe server (camera $CAMERA_INDEX)..."
  (
    cd "$TRACKING_DIR"
    exec "$VENV_PYTHON" mediapipe_tracking_server.py --camera "$CAMERA_INDEX"
  ) &
  TRACKING_PID=$!
  echo "Tracking PID: $TRACKING_PID"

  echo "Waiting for WebSocket 127.0.0.1:8766 ..."
  if ! wait_for_port 8766 45; then
    echo "错误: 追踪服务未在 45 秒内就绪。"
    kill "$TRACKING_PID" 2>/dev/null || true
    exit 1
  fi
  echo "Tracking server is ready."
fi

echo "Starting frontend (npm run dev)..."
echo "Open: $FRONTEND_URL"
cd "$ROOT"
npm run dev -- --open "$FRONTEND_URL"
