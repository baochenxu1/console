# basic-sdk-host

验证 **`@facedev/sdk`** 本地包（`file:../../dist-sdk-package`）的最小宿主工程：面部绑定、表情编排（含 Tracking 面板）、全局样式入口。

## 前置条件

### 在 monorepo 内开发（本仓库）

在仓库根目录已执行：

```bash
npm run build:sdk
node scripts/prepare-sdk-package.mjs
```

（或 `npm run pack:sdk`；本目录 `package.json` 默认 **`file:../../dist-sdk-package`**。）

### 收到外发 zip 的同事

解压后进入 **`facedev-sdk-<标签>/examples/basic-sdk-host`**，此时 `package.json` 已指向 **`file:../../facedev-sdk-<version>.tgz`**，无需改路径。组包方式见根目录文档 **`docs/DISTRIBUTION_PACKAGING.md`**（维护者执行 **`npm run dist:release`**）。

## 安装与运行

```bash
cd examples/basic-sdk-host
npm install
npm run dev
```

生产构建：

```bash
npm run build
```

## 不应提交的内容

- `node_modules/`
- `dist/`

已由仓库根目录 `.gitignore` 的 `examples/**/node_modules/`、`examples/**/dist/` 规则忽略。

## 说明

更完整的集成步骤见根目录 **`docs/SDK_QUICK_START.md`**。
