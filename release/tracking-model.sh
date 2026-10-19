#!/usr/bin/env bash
# Shared: ensure MediaPipe face_landmarker.task exists (auto-download if missing)
# Source from setup/start: source "$(dirname "$0")/tracking-model.sh"

FACE_LANDMARKER_MODEL_URL="${FACE_LANDMARKER_MODEL_URL:-https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task}"

ensure_face_landmarker_model() {
  local model_path="$1"
  local model_dir size

  if [[ -f "$model_path" ]]; then
    size="$(wc -c < "$model_path" | tr -d ' ')"
    if (( size > 1000000 )); then
      return 0
    fi
    echo "警告: 模型文件过小 (${size} bytes)，将重新下载..."
    rm -f "$model_path"
  fi

  if [[ "${TRACKING_SKIP_MODEL_DOWNLOAD:-0}" == "1" ]]; then
    echo "错误: 缺少模型且 TRACKING_SKIP_MODEL_DOWNLOAD=1"
    echo "请手动放置: $model_path"
    return 1
  fi

  model_dir="$(dirname "$model_path")"
  mkdir -p "$model_dir"

  echo "正在下载 face_landmarker.task (MediaPipe 官方)..."
  echo "URL: $FACE_LANDMARKER_MODEL_URL"

  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --progress-bar -o "$model_path" "$FACE_LANDMARKER_MODEL_URL"
  elif command -v wget >/dev/null 2>&1; then
    wget -O "$model_path" "$FACE_LANDMARKER_MODEL_URL"
  else
    echo "错误: 需要 curl 或 wget 才能自动下载模型"
    echo "手动下载: $FACE_LANDMARKER_MODEL_URL"
    echo "保存到: $model_path"
    return 1
  fi

  if [[ ! -f "$model_path" ]]; then
    echo "错误: 下载完成但找不到文件: $model_path"
    return 1
  fi

  size="$(wc -c < "$model_path" | tr -d ' ')"
  if (( size < 1000000 )); then
    rm -f "$model_path"
    echo "错误: 下载文件过小 (${size} bytes)，请检查网络或手动下载"
    return 1
  fi

  echo "模型已就绪: $model_path ($(( size / 1024 / 1024 )) MB)"
}
