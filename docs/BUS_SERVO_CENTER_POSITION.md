# 总线舵机中位与工作窗约定

本文说明 Face Console 中 **SC / ST / RJ_SBUS** 的装配中位、协议坐标与安全行程，以及前端可执行的标定能力。后续纯 Python 驱动包只需暴露更精简的「零点 + 行程」语义。

---

## 1. 两套坐标系（必读）

| 坐标系 | 含义 | 中位 | 工作区 |
|--------|------|------|--------|
| **装配角（脸 / 机构）** | 装机与机构设计使用的角度 | **90°** | **0°～180°**（中位 ±90°） |
| **舵机协议绝对量** | 线缆上实际下发的 position / angle ticks | 因型号而异（见下表） | 映射到上述 180° 窗 |

**重要：** UI 上「转至 SC 中位 150° / pos 512」「转至 ST 中位 180° / pos 2048」指的是 **舵机协议坐标系里的标准窗中位**，不是脸上的 90°。装机时要把机构 90° 对准这些协议中位。

| 协议 | 全量程（约） | 标准安全窗（协议量） | 协议中位 | 对应装配中位 |
|------|-------------|---------------------|----------|--------------|
| SC (`scscl`) | 300° · pos 0～1023 | 60°～240° · pos 205～819 | **150° · pos 512** | 脸上 **90°** |
| ST (`sms_sts`) | 360° · pos 0～4095 | 90°～270° · pos 1024～3072 | **180° · pos 2048** | 脸上 **90°** |
| RJ_SBUS (`rj_sbus`) | 实机常见限位 ±150°（ticks ±1500） | **协议 ticks -900～+900**（中位 **0**）↔ 机构 **0°～180° / ±90°** | **协议 0** | 脸上 **90°**（装到协议中位 0） |

RJ 协议在 `MID_OFFSET=0` 时是**有符号角度**：中位 ticks `0`，不是绝对 90°=900。  
**模型层铁律（不可变）：** `logical 0～1000` ↔ 机构总行程 **180°**，中位左右各 **90°**。  
RJ 只做固定映射：`logical 0/500/1000` → 协议 `-900 / 0 / +900`。不要求协议角等于装配绝对角，也不改寄存器限位。

SC/ST 的 150°/180° 是各自全量程几何中心，装机后仍对应机构 90°。

代码来源：

- `src/sdk/servoAdapters/core/servoMechanicalSafety.js`（`MECHANICAL_MAX_TRAVEL_DEG = 180`、各型号 `logicalAngle*`）
- `src/sdk/servoAdapters/rjsbus/rjSbusConstants.js`（`ANGLE_TICK_*` / `ANGLE_DEG_*`）

---

## 2. 中位模式（前端 Profile）

| `centerMode` | 含义 |
|--------------|------|
| `standard_window` | 使用型号标准窗中位（上表协议中位）作为 logical 500 |
| `installed_center` | 以 **当前读到的 position** 作为 logical 500，并围绕该点再取 ±90° 安全窗 |

实现：`src/sdk/servoAdapters/core/servoCenterMode.js`（`applyInstalledCenterFromPosition`）。

逻辑空间 `logical 0～1000` 始终映射到 **总行程 180°**（中位 ±90°），与装配约定一致。

---

## 3. 前端必须可用的能力（验收）

入口：**串口与单舵机控制** → 选协议（SC / ST / RJ_SBUS）→ 打开对应总线串口。

### 3.1 ID 管理

位置：参数配置 →「高级 · ID 管理」。

| 操作 | 说明 |
|------|------|
| Ping ID | 检测当前 Profile ID 是否在线 |
| Read ID | 读回舵机当前 ID |
| Scan ID | 区间扫描在线 ID |
| Change ID | 改 ID（需总线 ideally 只接一台）；成功后可迁移本地 Profile |

实现：

- UI：`BusServoIdManagementSection`（`src/components/BusServoSections.jsx`）
- SC/ST：`readId` / `changeId` → EEPROM ID 寄存器
- RJ：`readId` / `changeId` → `data_id=34`（`SERVO_ID`），改后 ping 校验

### 3.2 读取当前位置作为中位

位置：参数配置 →「点动调零」工作区。

推荐流程：

1. 将机构摆到装配中位（脸上 90°）
2. **读取位置（ReadPos）**
3. **设为安装中位**（`installed_center`：当前 position → logical 500，并计算 ±90° 安全窗）
4. 保存 Profile

相关按钮 / API：

- ReadPos → `adapter.readPosition`
- 设安装中位 → `applyInstalledCenterFromPosition`
- 也可点动微调后再设中位

控制页与 SC Lab 页共用同一套 profile / adapter 能力。

### 3.3 回标准窗中位（调试）

「转至 SC/ST/RJ 中位 …」仅把舵机送到 **标准窗协议中位**，用于对齐装配，不替代「读当前位置设为安装中位」。

---

## 4. Python 包边界（外部驱动）

Python 通信包面向真机驱动时，**不必**复刻前端全部标定 UI。对外只需明确：

1. **零点（中位）**  
   - 装配语义：机构 90°  
   - 协议量：SC `512` / ST `2048` / RJ ticks `900`（或由用户标定写入的 installed center）
2. **行程**  
   - 默认硬门禁：中位 ±90°（总 180°）  
   - SC：pos 205～819；ST：1024～3072；RJ：协议 ticks -900～+900（中位 0，对应机构 ±90°）

建议默认策略：

- 所有运动指令 clamp（或拒绝）到上述行程
- 配置写 / 改 ID / 广播写位置 → 非默认开放（admin / unsafe）
- 文档用一句话标注：

> Safety：舵机按机械中位 90° 安装；运行工作区为中位 ±90°（机构 0°～180°）。SC/ST 协议中位分别为 pos 512 / 2048；RJ 在 MID_OFFSET=0 时协议中位为 ticks 0，模型层映射为 -900～+900。logical 0～1000 的 180° 语义不可收缩。

前端负责装机标定与 ID 管理；Python 侧消费「零点 + 行程」即可安全控机。

---

## 5. 相关代码索引

| 主题 | 路径 |
|------|------|
| 型号安全窗 | `src/sdk/servoAdapters/core/servoMechanicalSafety.js` |
| 安装中位模式 | `src/sdk/servoAdapters/core/servoCenterMode.js` |
| RJ 安全 ticks | `src/sdk/servoAdapters/rjsbus/rjSbusConstants.js` |
| 控制页 ID / 点动 / 设中位 | `src/components/BusServoSections.jsx` |
| 串口页 | `src/pages/ServoControlPage.jsx`、`src/components/ServoControlPanel.jsx` |
