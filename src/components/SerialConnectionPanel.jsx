import { useSerialConnection } from "../hooks/useSerialConnection.js"

/**
 * 左栏：串口连接 + 通信日志（总线舵机）。
 * @param {{ transportFamily?: 'feetech' | 'rj_sbus', transportMode?: string }} props
 *   transportMode 为旧参数兼容（忽略）；以 transportFamily 为准。
 */
export default function SerialConnectionPanel({
  transportFamily = "feetech",
  transportMode: _transportMode,
}) {
  void _transportMode
  const serial = useSerialConnection(transportFamily)

  return (
    <section className="servo-control-serial panel" aria-label="串口连接">
      <div className="servo-control-serial-head panel-header">
        <h2>串口 · {serial.familyLabel} 总线</h2>
        <span
          className={`servo-control-status ${
            serial.status.connected ? "servo-control-status--on" : "servo-control-status--off"
          }`}
        >
          {serial.status.connected ? "已连接" : "未连接"}
        </span>
      </div>

      <p className="servo-control-serial-hint">
        右侧切换「控制协议」后，此处传输层自动跟随（SC/ST 与 RJ_SBUS 为独立串口链路）。
      </p>

      {!serial.status.supported ? (
        <p className="servo-control-serial-warn">当前浏览器不支持 Web Serial，请使用 Chrome 或 Edge。</p>
      ) : null}

      <div className="servo-control-serial-connect">
        <div className="servo-control-serial-baud">
          <label htmlFor="scp-baud">波特率</label>
          <select
            id="scp-baud"
            className="servo-control-baud-select"
            value={serial.baudRate}
            disabled={serial.status.connected}
            onChange={(e) => serial.setBaudRate(Number(e.target.value))}
          >
            {serial.baudOptions.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </div>
        <div className="servo-control-serial-actions">
          <button
            type="button"
            className="servo-control-btn servo-control-btn--ghost"
            disabled={!serial.status.supported || serial.status.connected}
            onClick={() => void serial.handleSelectPort()}
          >
            选择串口
          </button>
          <button
            type="button"
            className="servo-control-btn"
            disabled={!serial.status.supported || serial.status.connected}
            onClick={() => void serial.handleOpenPort()}
          >
            打开
          </button>
          <button
            type="button"
            className="servo-control-btn servo-control-btn--ghost"
            disabled={!serial.status.connected}
            onClick={() => void serial.handleClosePort()}
          >
            关闭
          </button>
        </div>
      </div>

      <div className="servo-control-meta">
        <span>
          已选端口：<strong>{serial.status.portSelected ? "是" : "否"}</strong>
        </span>
        <span>
          TX <strong>{serial.status.txCount}</strong>
        </span>
        <span>
          RX <strong>{serial.status.rxCount}</strong>
        </span>
      </div>

      <div className="servo-control-log">
        <div className="servo-control-log-header">
          <h3>通信日志</h3>
          <button type="button" className="servo-control-btn servo-control-btn--ghost" onClick={serial.clearLogs}>
            清空
          </button>
        </div>
        <div className="servo-control-log-list">
          {serial.logs.length === 0 ? (
            <div className="servo-control-log-empty">暂无</div>
          ) : (
            serial.logs.map((log) => (
              <div
                key={log.id}
                className={`servo-control-log-line servo-control-log-line--${String(log.type).toLowerCase()}`}
              >
                <span className="servo-control-log-time">{log.time}</span>
                <span className="servo-control-log-type">[{serial.serialLogTypeLabel(log.type)}]</span>
                {log.message}
              </div>
            ))
          )}
        </div>
      </div>
    </section>
  )
}
