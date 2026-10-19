# 分发压缩包（FaceDEV SDK）

面向「发给别人的 zip」的**推荐目录结构**、**生成方式**与**验收项**。

---

## 1. 推荐 zip 根目录结构

解压后根目录为 **`facedev-sdk-<标签>/`**（默认标签 `v0.2.0-beta`，即 `facedev-sdk-v0.2.0-beta/`）：

```text
facedev-sdk-v0.2.0-beta/
  facedev-sdk-<npm-version>.tgz    # 例如 facedev-sdk-0.2.0-beta.tgz
  docs/                              # 含 SDK_QUICK_START、TRACKING_PROTOCOL、PYTHON_TRACKING_SERVICE 等
  examples/
    basic-sdk-host/                  # package.json 已指向 ../../facedev-sdk-<version>.tgz
  tools/
    tracking_service/                # 源码与 requirements；不含 .venv / __pycache__ / *.task
  TEST_GUIDE_<标签>.md
  RELEASE_NOTES_<标签>.md
  FEEDBACK_TEMPLATE.md
```

**测 MediaPipe** 时，对方仍需自备 **`face_landmarker.task`** 放到其解压路径下的 `tools/tracking_service/models/`；协议与启动说明已在 **`docs/TRACKING_PROTOCOL.md`**、**`docs/PYTHON_TRACKING_SERVICE.md`** 中，随 **`docs/`** 一并打包。

---

## 2. 在仓库内生成 zip

```bash
npm run dist:release
```

等价于：先 **`npm run pack:sdk`**（生成根目录 `facedev-sdk-<version>.tgz`），再执行 **`node scripts/make-distribution-zip.mjs`**。

产物默认：

- **`dist/facedev-sdk-v0.2.0-beta.zip`**

自定义发行标签（目录名后缀）：

```bash
set FACEDEV_DIST_VERSION=v0.2.0-beta
npm run dist:release
```

（Linux/macOS：`export FACEDEV_DIST_VERSION=v0.2.0-beta`）

---

## 3. 接收方快速验证

1. 解压 zip。  
2. 打开 **`TEST_GUIDE_<标签>.md`**，按其中步骤执行（与 **`docs/SDK_QUICK_START.md`** 一致方向）。  
3. 在 `examples/basic-sdk-host` 下执行 **`npm install`**、**`npm run build`** / **`npm run dev`**。

---

## 4. 发送方验收清单（脚本已自动检查部分）

| 项 | 要求 |
|----|------|
| 无 `node_modules` | zip 内不得包含（示例依赖由接收方 `npm install` 安装）。 |
| 无 `.venv` / `venv` | 不得打包 Python 虚拟环境。 |
| 无 `dist-sdk-package` | 分发依赖 **tgz**；除非刻意提供 `file:` 目录安装（本流程不包含）。 |
| 无 `face_landmarker.task` | 大模型不进入 zip；随 `models/README.md` 说明自下载。 |
| 无 `__pycache__`、`.pyc` | 不打包解释器缓存。 |
| `tgz` 可被示例安装 | 示例内 **`@facedev/sdk`** 为 **`file:../../facedev-sdk-<version>.tgz`**。 |
| 文档含快速启动 | **`docs/SDK_QUICK_START.md`** 随 **`docs/`** 复制。 |

`make-distribution-zip.mjs` 在写入 zip 前会遍历暂存目录，并在 zip 生成后尽量执行 **`tar -tf`** 做二次字符串级检查；若本机无 `tar`，请人工按上表抽查。

---

## 5. 模板文件位置（维护者编辑）

仓库内 **`distribution/`**：

| 文件 | 用途 |
|------|------|
| `TEST_GUIDE.template.md` | 生成 zip 根目录 `TEST_GUIDE_<标签>.md` |
| `RELEASE_NOTES.template.md` | 生成 `RELEASE_NOTES_<标签>.md` |
| `FEEDBACK_TEMPLATE.md` | 原样复制为根目录 `FEEDBACK_TEMPLATE.md` |

占位符：`{{VERSION_LABEL}}`、`{{NPM_PKG_VERSION}}`（来自根目录 `package.json` 的 `version`，与 `facedev-sdk-<version>.tgz` 文件名一致）。

---

## 6. 与 `npm pack` 的关系

- **`npm run pack:sdk`**：生成 **`facedev-sdk-<version>.tgz`**（在仓库根目录）。  
- **`dist:release`**：在上一文件存在的前提下，组包并打 zip；**不包含** `dist-sdk-package` 目录。
