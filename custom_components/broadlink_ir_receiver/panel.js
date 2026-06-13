class BroadlinkIRPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._entries = {};
    this._codes = [];
    this._unsub = null;
    this._initialized = false;
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._initialized) {
      this._initialized = true;
      this._render();
      this._init();
    }
  }

  set panel(p) {
    this._panel = p;
  }

  disconnectedCallback() {
    if (this._unsub) this._unsub();
  }

  async _init() {
    await this._loadState();
    try {
      this._unsub = await this._hass.connection.subscribeEvents((ev) => {
        this._codes.unshift(ev.data);
        if (this._codes.length > 100) this._codes.pop();
        this._renderCodes();
      }, "broadlink_ir_command");
    } catch (e) {
      console.error("BroadLink IR: event subscription failed", e);
    }
  }

  async _loadState() {
    try {
      const r = await this._hass.connection.sendMessagePromise({
        type: "broadlink_ir_receiver/get_state",
      });
      this._entries = r.entries || {};
      this._codes = [];
      Object.values(this._entries).forEach((e) => {
        (e.codes || []).forEach((c) => this._codes.push(c));
      });
      this._codes.sort((a, b) => b.timestamp - a.timestamp);
      this._renderDevices();
      this._renderCodes();
    } catch (e) {
      console.error("BroadLink IR: load state failed", e);
    }
  }

  async _toggle(id, on) {
    try {
      await this._hass.connection.sendMessagePromise({
        type: "broadlink_ir_receiver/toggle",
        entry_id: id,
        enabled: on,
      });
      if (this._entries[id]) this._entries[id].enabled = on;
      this._renderDevices();
    } catch (e) {
      console.error("BroadLink IR: toggle failed", e);
    }
  }

  async _clear() {
    try {
      await this._hass.connection.sendMessagePromise({
        type: "broadlink_ir_receiver/clear_codes",
      });
      this._codes = [];
      this._renderCodes();
    } catch (e) {
      console.error("BroadLink IR: clear failed", e);
    }
  }

  _copy(text) {
    navigator.clipboard.writeText(text).then(() => {
      const toast = this.shadowRoot.getElementById("toast");
      if (toast) {
        toast.textContent = "Copied: " + text;
        toast.classList.add("show");
        setTimeout(() => toast.classList.remove("show"), 2000);
      }
    });
  }

  _fmtTime(ts) {
    return new Date(ts * 1000).toLocaleTimeString();
  }

  _esc(s) {
    if (!s) return "";
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }

  _render() {
    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          padding: 24px;
          color: var(--primary-text-color, #e1e1e1);
          font-family: var(--paper-font-body1_-_font-family, Roboto, sans-serif);
          background: var(--primary-background-color, #111);
          min-height: 100vh;
          box-sizing: border-box;
        }
        .container { max-width: 960px; margin: 0 auto; }

        .header {
          display: flex; align-items: center; gap: 12px;
          margin-bottom: 24px;
        }
        .header h1 { margin: 0; font-size: 24px; font-weight: 400; }
        .header-icon {
          width: 32px; height: 32px;
          color: var(--primary-color, #03a9f4);
        }

        .device-card {
          background: var(--card-background-color, #1c1c1c);
          border-radius: var(--ha-card-border-radius, 12px);
          padding: 16px 20px;
          margin-bottom: 16px;
          display: flex; align-items: center; justify-content: space-between;
          border: 1px solid var(--divider-color, #333);
        }
        .device-info { flex: 1; }
        .device-name { font-size: 16px; font-weight: 500; }
        .device-host {
          font-size: 13px;
          color: var(--secondary-text-color, #999);
          margin-top: 2px;
        }
        .device-status {
          font-size: 12px; margin-top: 4px;
          display: flex; align-items: center; gap: 6px;
        }
        .dot {
          width: 8px; height: 8px; border-radius: 50%;
          display: inline-block;
        }
        .dot.on { background: #4caf50; }
        .dot.off { background: #f44336; }

        .toggle {
          padding: 8px 24px; border-radius: 20px; border: none;
          font-size: 14px; cursor: pointer; font-weight: 500;
          transition: all 0.2s; min-width: 72px;
        }
        .toggle.on {
          background: var(--primary-color, #03a9f4); color: #fff;
        }
        .toggle.off {
          background: var(--disabled-color, #555);
          color: var(--primary-text-color, #e1e1e1);
        }
        .toggle:hover { opacity: 0.85; }

        .codes-card {
          background: var(--card-background-color, #1c1c1c);
          border-radius: var(--ha-card-border-radius, 12px);
          border: 1px solid var(--divider-color, #333);
          overflow: hidden;
        }
        .codes-hdr {
          display: flex; align-items: center; justify-content: space-between;
          padding: 16px 20px;
          border-bottom: 1px solid var(--divider-color, #333);
        }
        .codes-hdr h2 { margin: 0; font-size: 18px; font-weight: 400; }
        .clear-btn {
          padding: 6px 16px; border-radius: 16px;
          border: 1px solid var(--divider-color, #555);
          background: transparent;
          color: var(--secondary-text-color, #999);
          cursor: pointer; font-size: 13px;
        }
        .clear-btn:hover {
          background: var(--divider-color, #333);
          color: var(--primary-text-color, #e1e1e1);
        }

        .codes-scroll { max-height: 520px; overflow-y: auto; }

        .row {
          display: grid;
          grid-template-columns: 90px 72px 1fr 60px;
          align-items: center;
          padding: 10px 20px; gap: 8px;
          border-bottom: 1px solid var(--divider-color, #222);
          font-size: 14px;
        }
        .row:hover { background: rgba(255,255,255,0.03); }
        .row.hdr {
          font-weight: 500;
          color: var(--secondary-text-color, #999);
          font-size: 12px; text-transform: uppercase; letter-spacing: .5px;
          border-bottom: 1px solid var(--divider-color, #333);
          position: sticky; top: 0;
          background: var(--card-background-color, #1c1c1c);
          z-index: 1;
        }
        .row.new { animation: flash 1s ease-out; }
        @keyframes flash {
          0%   { background: rgba(3,169,244,.2); }
          100% { background: transparent; }
        }

        .badge {
          padding: 2px 8px; border-radius: 4px;
          font-size: 11px; font-weight: 600;
          display: inline-block; text-transform: uppercase;
        }
        .badge.nec     { background: #1b5e20; color: #a5d6a7; }
        .badge.unknown { background: #4a3500; color: #ffb74d; }
        .badge.rf      { background: #1a237e; color: #9fa8da; }

        .code-val {
          font-family: 'Roboto Mono', 'Courier New', monospace;
          color: var(--primary-color, #03a9f4);
          font-size: 15px; font-weight: 500;
          cursor: pointer;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .code-val:hover { text-decoration: underline; }

        .copy-btn {
          padding: 4px 12px; border-radius: 12px;
          border: 1px solid var(--divider-color, #444);
          background: transparent;
          color: var(--secondary-text-color, #999);
          cursor: pointer; font-size: 12px;
        }
        .copy-btn:hover {
          background: var(--primary-color, #03a9f4);
          color: #fff; border-color: var(--primary-color, #03a9f4);
        }

        .empty {
          text-align: center; padding: 48px 20px;
          color: var(--secondary-text-color, #888);
        }
        .empty p { margin: 6px 0; }
        .empty .hint { font-size: 13px; }

        .time { color: var(--secondary-text-color, #999); font-size: 13px; }

        #toast {
          position: fixed; bottom: 24px; left: 50%;
          transform: translateX(-50%) translateY(80px);
          background: var(--primary-color, #03a9f4); color: #fff;
          padding: 10px 24px; border-radius: 24px; font-size: 14px;
          transition: transform .3s ease; z-index: 100;
          pointer-events: none; white-space: nowrap;
        }
        #toast.show { transform: translateX(-50%) translateY(0); }

        .sub-info {
          font-size: 11px;
          color: var(--secondary-text-color, #777);
          margin-top: 2px;
          font-family: 'Roboto Mono', 'Courier New', monospace;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
      </style>

      <div class="container">
        <div class="header">
          <svg class="header-icon" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48
                     10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93
                     0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54
                     c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2
                     c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5
                     4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/>
          </svg>
          <h1>BroadLink IR Receiver</h1>
        </div>

        <div id="devices"></div>

        <div class="codes-card">
          <div class="codes-hdr">
            <h2>Received Codes</h2>
            <button class="clear-btn" id="clear-btn">Clear</button>
          </div>
          <div class="codes-scroll">
            <div class="row hdr">
              <span>Time</span>
              <span>Protocol</span>
              <span>Code</span>
              <span></span>
            </div>
            <div id="codes"></div>
          </div>
        </div>
      </div>

      <div id="toast"></div>
    `;

    this.shadowRoot
      .getElementById("clear-btn")
      .addEventListener("click", () => this._clear());
  }

  _renderDevices() {
    const el = this.shadowRoot.getElementById("devices");
    if (!el) return;

    const ids = Object.keys(this._entries);
    if (ids.length === 0) {
      el.innerHTML = `
        <div class="device-card">
          <div class="device-info">
            <div class="device-name">No devices configured</div>
            <div class="device-host">
              Go to Settings &rarr; Devices &amp; Services &rarr; Add Integration
            </div>
          </div>
        </div>`;
      return;
    }

    let html = "";
    for (const id of ids) {
      const e = this._entries[id];
      const on = e.enabled;
      html += `
        <div class="device-card">
          <div class="device-info">
            <div class="device-name">${this._esc(e.name)}</div>
            <div class="device-host">${this._esc(e.host)}</div>
            <div class="device-status">
              <span class="dot ${on ? "on" : "off"}"></span>
              ${on ? "Listening for signals" : "Receiver off"}
            </div>
          </div>
          <button class="toggle ${on ? "on" : "off"}"
                  data-id="${id}" data-on="${on}">
            ${on ? "ON" : "OFF"}
          </button>
        </div>`;
    }
    el.innerHTML = html;

    el.querySelectorAll(".toggle").forEach((btn) => {
      btn.addEventListener("click", () => {
        this._toggle(btn.dataset.id, btn.dataset.on !== "true");
      });
    });
  }

  _renderCodes() {
    const el = this.shadowRoot.getElementById("codes");
    if (!el) return;

    if (this._codes.length === 0) {
      el.innerHTML = `
        <div class="empty">
          <p>No codes received yet</p>
          <p class="hint">Press a button on your IR remote to see codes here</p>
        </div>`;
      return;
    }

    let html = "";
    this._codes.forEach((c, i) => {
      const t = this._fmtTime(c.timestamp);
      const proto = c.protocol || "Unknown";
      const code = c.nec_code || (c.raw_hex ? c.raw_hex.substring(0, 16) : "-");
      const copyVal = c.nec_code || c.raw_hex || "";
      const rawShort = c.raw_hex
        ? c.raw_hex.substring(0, 32) + (c.raw_hex.length > 32 ? "..." : "")
        : "";

      html += `
        <div class="row ${i === 0 ? "new" : ""}">
          <span class="time">${t}</span>
          <span><span class="badge ${proto.toLowerCase()}">${proto}</span></span>
          <span>
            <span class="code-val" title="Click to copy: ${this._esc(copyVal)}"
                  data-code="${this._esc(copyVal)}">${this._esc(code)}</span>
            ${rawShort && c.nec_code ? `<div class="sub-info" title="${this._esc(c.raw_hex)}">raw: ${this._esc(rawShort)}</div>` : ""}
          </span>
          <button class="copy-btn" data-code="${this._esc(copyVal)}">Copy</button>
        </div>`;
    });
    el.innerHTML = html;

    el.querySelectorAll(".copy-btn").forEach((btn) => {
      btn.addEventListener("click", () => this._copy(btn.dataset.code));
    });
    el.querySelectorAll(".code-val").forEach((span) => {
      span.addEventListener("click", () => this._copy(span.dataset.code));
    });
  }
}

customElements.define("broadlink-ir-panel", BroadlinkIRPanel);
