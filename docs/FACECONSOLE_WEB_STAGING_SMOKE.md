# Face Console Web — Cloudflare Pages Smoke Checklist（Phase 1）

## 自动

```bash
npm run build:faceconsole-web          # Test A + B + C（含路径审计）
npm run test:browser-tracking          # 含 Test D：browser 模块无 8766/8767
npm run test:tracking-semantic
npm run smoke:browser-mediapipe-worker
npm run smoke:faceconsole-web-https -- https://<preview>.pages.dev   # Test E
```

## 人工（HTTPS Preview）

- [ ] 不启动 Python
- [ ] Chrome/Edge 打开 Preview URL
- [ ] Tracking Runtime = Browser · Source = Camera · Start
- [ ] Camera 权限 / Preview / Model READY / FPS &gt; 0 / Face Rig 有数据
- [ ] Stop / Restart 正常
- [ ] Network：WASM + `face_landmarker.task` 来自 HTTPS；无 8766/8767
- [ ] 页眉或 Console 可见 `v<package.version> · <shortSha>`
- [ ] `navigator.serial` 存在（Hardware Validation Pending）
