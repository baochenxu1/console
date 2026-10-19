#!/usr/bin/env bash
# First-time setup (macOS / Linux)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$ROOT/package.json" ]]; then
  :
else
  ROOT="$(cd "$ROOT/.." && pwd)"
fi

HELPER="$(dirname "${BASH_SOURCE[0]}")/tracking-model.sh"
if [[ ! -f "$HELPER" ]]; then
  HELPER="$ROOT/release/tracking-model.sh"
fi
# shellcheck source=/dev/null
source "$HELPER"

TRACKING_DIR="$ROOT/tools/tracking_service"
VENV_DIR="$TRACKING_DIR/.venv"
VENV_PYTHON="$VENV_DIR/bin/python"
MODEL_PATH="$TRACKING_DIR/models/face_landmarker.task"

echo "=== FaceDEV camera tracking - setup ==="
echo "Project root: $ROOT"

command -v node >/dev/null 2>&1 || { echo "错误: 未找到 node，请安装 Node.js 18+"; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "错误: 未找到 npm"; exit 1; }
command -v python3 >/dev/null 2>&1 || command -v python >/dev/null 2>&1 || {
  echo "错误: 未找到 python3/python，请安装 Python 3.10 或 3.11"
  exit 1
}

PY="$(command -v python3 2>/dev/null || command -v python)"
echo "Node.js: $(node -p 'process.versions.node')"
echo "Python: $($PY -c 'import sys; print(f\"{sys.version_info.major}.{sys.version_info.minor}\")')"

echo ""
echo "[1/3] MediaPipe model..."
ensure_face_landmarker_model "$MODEL_PATH"

echo ""
echo "[2/3] npm install..."
(cd "$ROOT" && npm install)

echo ""
echo "[3/3] Python venv + pip install..."
if [[ ! -x "$VENV_PYTHON" ]]; then
  (cd "$TRACKING_DIR" && "$PY" -m venv .venv)
fi

"$VENV_PYTHON" -m pip install --upgrade pip
"$VENV_PYTHON" -m pip install -r "$TRACKING_DIR/requirements.txt"

echo ""
echo "=== Setup complete ==="
echo "Next: ./start-camera-tracking.sh"
