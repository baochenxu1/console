# 项目树（自动生成）

排除 `node_modules`、各类 `dist`、`.venv`、`__pycache__`、`.vite`、`*.tgz`、本地模型 `*.task` 等后的目录结构。

```text
FaceDEV/
├── distribution/
│   ├── FEEDBACK_TEMPLATE.md
│   ├── RELEASE_NOTES.template.md
│   └── TEST_GUIDE.template.md
├── docs/
│   ├── ARCHITECTURE.md
│   ├── DISTRIBUTION_PACKAGING.md
│   ├── PROJECT_TREE.md
│   ├── PYTHON_TRACKING_SERVICE.md
│   ├── README.md
│   ├── RELEASE_CHECKLIST.md
│   ├── SDK_API.md
│   ├── SDK_QUICK_START.md
│   └── TRACKING_PROTOCOL.md
├── examples/
│   └── basic-sdk-host/
│       ├── src/
│       │   ├── App.jsx
│       │   └── main.jsx
│       ├── index.html
│       ├── package-lock.json
│       ├── package.json
│       ├── README.md
│       └── vite.config.js
├── public/
│   └── .gitkeep
├── scripts/
│   ├── make-distribution-zip.mjs
│   ├── prepare-sdk-package.mjs
│   └── print-project-tree.mjs
├── src/
│   ├── components/
│   │   ├── FaceRigBindingInspector.jsx
│   │   ├── FaceRigControlConsole.jsx
│   │   ├── FaceRigWorkspace.jsx
│   │   ├── FrameEditor.jsx
│   │   ├── FramePreviewPanel.jsx
│   │   ├── SerialPanel.jsx
│   │   └── ServoControlPanel.jsx
│   ├── core/
│   │   ├── actionPlayer.js
│   │   ├── faceDofMapper.js
│   │   ├── faceRigProfile.js
│   │   ├── frameProject.js
│   │   ├── servoConfig.js
│   │   ├── servoProtocol.js
│   │   └── webSerial.js
│   ├── hooks/
│   │   └── useFaceRigInteraction.js
│   ├── pages/
│   │   ├── FaceExpressionEditorPage.jsx
│   │   └── FaceRigPage.jsx
│   ├── sdk/
│   │   ├── binding/
│   │   │   ├── bindingActions.js
│   │   │   ├── bindingLimits.js
│   │   │   ├── bindingSelectors.js
│   │   │   └── index.js
│   │   ├── core/
│   │   │   ├── createExpressionEngine.js
│   │   │   ├── createFaceRigBindingEngine.js
│   │   │   ├── index.js
│   │   │   └── types.js
│   │   ├── expression/
│   │   │   ├── expressionActions.js
│   │   │   ├── expressionPlayback.js
│   │   │   ├── expressionSelectors.js
│   │   │   └── index.js
│   │   ├── protocol/
│   │   │   ├── index.js
│   │   │   └── poseToServoCommand.js
│   │   ├── react/
│   │   │   ├── ExpressionFramePanel.jsx
│   │   │   ├── ExpressionPlaybackBar.jsx
│   │   │   ├── ExpressionTimeline.jsx
│   │   │   ├── FaceBindingEditor.jsx
│   │   │   ├── FaceBindingInspector.jsx
│   │   │   ├── FaceExpressionEditor.jsx
│   │   │   ├── FaceRigControls.jsx
│   │   │   ├── FaceTrackingPanel.jsx
│   │   │   └── index.js
│   │   ├── tracking/
│   │   │   ├── createWebSocketTrackingAdapter.js
│   │   │   ├── index.js
│   │   │   ├── trackingCalibration.js
│   │   │   ├── trackingMapper.js
│   │   │   └── trackingTypes.js
│   │   ├── index.js
│   │   ├── INTERNAL_HARDWARE_VALIDATION.md
│   │   ├── README.md
│   │   └── style.css
│   ├── state/
│   │   └── README.md
│   ├── styles/
│   │   ├── base.css
│   │   ├── face-rig.css
│   │   ├── frame-editor.css
│   │   ├── layout.css
│   │   ├── serial-panels.css
│   │   └── servo-panels.css
│   ├── utils/
│   │   ├── clamp.js
│   │   ├── fileExport.js
│   │   └── storage.js
│   ├── App.css
│   ├── App.jsx
│   └── main.jsx
├── tools/
│   └── tracking_service/
│       ├── models/
│       │   └── README.md
│       ├── mediapipe_to_rig.py
│       ├── mediapipe_tracking_server.py
│       ├── mock_tracking_server.py
│       ├── README.md
│       └── requirements.txt
├── .gitignore
├── index.html
├── jsconfig.json
├── package-lock.json
├── package.json
├── README.md
├── vite.config.js
└── vite.sdk.config.js
```
