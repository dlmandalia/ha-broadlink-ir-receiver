class BroadlinkIRPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._initialized = false;
    this._entries = {};
    this._codes = [];
    this._unsub = null;
    this._config = null;
    this._wiz = null;
    this._entities = [];
    this._services = [];
    this._captureSub = null;
    this._activeEntry = null;
    this._logFilter = null;
    this._entityRegistry = [];
  }

  static get RF_DEVTYPES() {
    return new Set([0x520B,0x51DA,0x61A2,0x649B,0x653C,0x653A,0x6508,0x6539,0x648D,0x6184,0x6070,0x610E,0x610F,0x62BC,0x62BE,0x6364,0x6476]);
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._initialized) {
      this._initialized = true;
      this._boot();
    }
  }

  set panel(p) { this._panel = p; }

  disconnectedCallback() {
    if (this._unsub) this._unsub();
    if (this._captureSub) this._captureSub();
  }

  async _boot() {
    this._renderShell();
    await Promise.all([this._loadState(), this._loadConfig(), this._loadHA(), this._loadEntityRegistry()]);
    this._renderAll();
    try {
      this._unsub = await this._hass.connection.subscribeEvents((ev) => {
        this._codes.unshift(ev.data);
        if (this._codes.length > 100) this._codes.pop();
        this._renderLog(true);
        this._flashMatch(ev.data);
      }, "broadlink_ir_command");
    } catch (e) { console.error("IR: event sub failed", e); }
  }

  async _loadState() {
    try {
      const r = await this._hass.connection.sendMessagePromise({ type: "broadlink_ir_receiver/get_state" });
      this._entries = r.entries || {};
      this._codes = [];
      Object.values(this._entries).forEach(e => (e.codes || []).forEach(c => this._codes.push(c)));
      this._codes.sort((a, b) => b.timestamp - a.timestamp);
    } catch (e) { console.error("IR: load state failed", e); }
  }

  async _loadConfig() {
    try {
      this._config = await this._hass.connection.sendMessagePromise({ type: "broadlink_ir_receiver/get_config" });
      if (!this._config || !this._config.devices) {
        this._config = { version: 2, devices: {} };
      }
    } catch (e) {
      console.error("IR: load config failed", e);
      this._config = { version: 2, devices: {} };
    }
  }

  async _saveConfig() {
    try {
      await this._hass.connection.sendMessagePromise({ type: "broadlink_ir_receiver/set_config", config: this._config });
    } catch (e) { console.error("IR: save config failed", e); }
  }

  async _loadHA() {
    try {
      const states = await this._hass.connection.sendMessagePromise({ type: "get_states" });
      this._entities = (states || []).map(s => ({id: s.entity_id, name: s.attributes?.friendly_name || s.entity_id})).sort((a,b) => a.name.localeCompare(b.name));
    } catch (e) { this._entities = []; }
    try {
      const svc = await this._hass.connection.sendMessagePromise({ type: "get_services" });
      this._services = [];
      for (const [domain, svcs] of Object.entries(svc || {})) {
        for (const s of Object.keys(svcs)) this._services.push(domain + "." + s);
      }
      this._services.sort();
    } catch (e) { this._services = []; }
  }

  async _loadEntityRegistry() {
    try {
      const r = await this._hass.connection.sendMessagePromise({ type: "config/entity_registry/list" });
      this._entityRegistry = (r || []).filter(e => e.platform === "broadlink_ir_receiver");
    } catch (e) { this._entityRegistry = []; }
  }

  // --- helpers ---
  _esc(s) { if (s == null) return ""; const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }
  _$(id) { return this.shadowRoot.getElementById(id); }
  _deviceConfig() {
    if (!this._activeEntry || !this._config.devices) return { remotes: [{ id: "r1", name: "Remote 1", mappings: [] }], sel: "r1" };
    return this._config.devices[this._activeEntry] || { remotes: [{ id: "r1", name: "Remote 1", mappings: [] }], sel: "r1" };
  }
  _curRemote() { const dc = this._deviceConfig(); return dc.remotes.find(r => r.id === dc.sel) || dc.remotes[0]; }
  _curMaps() { return this._curRemote().mappings; }
  _mappedBtn(id) { return this._curMaps().find(m => m.button === id); }
  _label(id) { return id.toUpperCase().replace("_", " "); }
  _toast(m) { const t = this._$("toast"); if (!t) return; t.textContent = m; t.classList.add("show"); setTimeout(() => t.classList.remove("show"), 1800); }
  _fmtTime(ts) { return new Date(ts * 1000).toLocaleTimeString(); }

  _findEntityByEntry(entryId, suffix) {
    if (!this._entityRegistry) return null;
    const reg = this._entityRegistry.find(e => e.config_entry_id === entryId && e.unique_id?.endsWith(suffix));
    if (!reg) return null;
    return this._hass?.states?.[reg.entity_id] || null;
  }
  _findNotifEntity(entryId) { return this._findEntityByEntry(entryId, "_notifications_switch"); }
  _findReceiverEntity(entryId) { return this._findEntityByEntry(entryId, "_receiver_switch"); }
  _isNotifOn(entryId) {
    const reg = (this._entityRegistry || []).find(e => e.config_entry_id === entryId && e.unique_id && e.unique_id.endsWith("_notifications_switch"));
    if (!reg) return false;
    const s = this._hass?.states?.[reg.entity_id];
    return s ? s.state === "on" : false;
  }

  _flashMatch(ev) {
    const code = ev.nec_code || (ev.raw_hex || "").substring(0, 16);
    const m = this._curMaps().find(x => x.ir_code === code);
    if (!m) return;
    const btn = this.shadowRoot.querySelector(`button.key[data-btn="${m.button}"]`);
    if (!btn) return;
    btn.classList.remove("flash"); void btn.offsetWidth; btn.classList.add("flash");
    setTimeout(() => btn.classList.remove("flash"), 950);
  }

  // --- toggle WS ---
  async _toggleEntry(id, on) {
    try {
      await this._hass.connection.sendMessagePromise({ type: "broadlink_ir_receiver/toggle", entry_id: id, enabled: on });
      if (this._entries[id]) this._entries[id].enabled = on;
      this._toast(on ? "Receiver on" : "Receiver off");
      this._renderTopbar();
    } catch (e) {
      console.error("IR: toggle failed", e);
      this._toast("Toggle failed: " + (e.message || "unknown"));
    }
  }

  // --- add/remove device ---
  async _addDevice() {
    const host = this._$("addDevHost").value.trim();
    const name = this._$("addDevName").value.trim();
    if (!host) { this._toast("Enter an IP address"); return; }
    this._$("addDevGo").textContent = "Adding...";
    this._$("addDevGo").disabled = true;
    try {
      const r = await this._hass.connection.sendMessagePromise({
        type: "broadlink_ir_receiver/add_device",
        host,
        name: name || undefined,
      });
      this._toast("Device added!");
      this._$("addDevForm").style.display = "none";
      this._$("addDevBtn").style.display = "flex";
      this._$("addDevHost").value = "";
      this._$("addDevName").value = "";
      await this._loadState();
      this._activeEntry = r.entry_id;
      await this._loadConfig();
      this._renderAll();
    } catch (e) {
      this._toast("Failed: " + (e.message || "check IP"));
    } finally {
      const btn = this._$("addDevGo");
      if (btn) { btn.textContent = "Add"; btn.disabled = false; }
    }
  }

  async _removeDevice(entryId) {
    try {
      await this._hass.connection.sendMessagePromise({
        type: "broadlink_ir_receiver/remove_device",
        entry_id: entryId,
      });
      delete this._entries[entryId];
      if (this._activeEntry === entryId) {
        const ids = Object.keys(this._entries);
        this._activeEntry = ids[0] || null;
      }
      await this._loadConfig();
      this._renderAll();
      this._toast("Device removed");
    } catch (e) {
      this._toast("Failed: " + (e.message || "unknown error"));
    }
  }

  // --- buttons layout ---
  static get BTNS() {
    return [
      { id:"power", label:"⏻", cls:"power", row:"twocol" }, { id:"mute", label:"🔇", row:"twocol" },
      { id:"1",label:"1",row:"numpad" },{ id:"2",label:"2",row:"numpad" },{ id:"3",label:"3",row:"numpad" },
      { id:"4",label:"4",row:"numpad" },{ id:"5",label:"5",row:"numpad" },{ id:"6",label:"6",row:"numpad" },
      { id:"7",label:"7",row:"numpad" },{ id:"8",label:"8",row:"numpad" },{ id:"9",label:"9",row:"numpad" },
      { id:"back",label:"↩",row:"numpad" },{ id:"0",label:"0",row:"numpad" },{ id:"home",label:"⌂",row:"numpad" },
      { id:"up",label:"▲",row:"dpad",pos:2 },{ id:"ok",label:"OK",row:"dpad",pos:5,round:true },
      { id:"left",label:"◀",row:"dpad",pos:4 },{ id:"right",label:"▶",row:"dpad",pos:6 },{ id:"down",label:"▼",row:"dpad",pos:8 },
      { id:"vol_up",label:"Vol +",row:"twocol" },{ id:"ch_up",label:"Ch +",row:"twocol" },
      { id:"vol_down",label:"Vol –",row:"twocol" },{ id:"ch_down",label:"Ch –",row:"twocol" }
    ];
  }

  // --- IR/RF capture ---
  async _startCapture() {
    this._wiz.capturing = true;
    this._wiz.ir_code = null;
    this._wiz.captureError = null;
    this._wiz.captureMode = this._wiz.captureMode || "ir";
    this._renderWizard();

    if (this._wiz.captureMode === "rf") {
      this._startRfCapture();
      return;
    }

    const activeHost = this._entries[this._activeEntry]?.host;
    try {
      this._captureSub = await this._hass.connection.subscribeEvents((ev) => {
        if (activeHost && ev.data.host !== activeHost) return;
        const code = ev.data.nec_code || (ev.data.raw_hex || "").substring(0, 16);
        if (!code) return;
        this._wiz.ir_code = code;
        this._wiz.capturing = false;
        if (this._captureSub) { this._captureSub(); this._captureSub = null; }
        this._renderWizard();
      }, "broadlink_ir_command");
    } catch (e) {
      console.error("IR: capture sub failed", e);
      this._wiz.capturing = false;
      this._renderWizard();
    }
  }

  async _startRfCapture() {
    this._wiz.rfPhase = 1;
    this._renderWizard();
    try {
      await this._hass.connection.sendMessagePromise({
        type: "broadlink_ir_receiver/rf_sweep",
        entry_id: this._activeEntry,
      });
    } catch (e) {
      this._wiz.capturing = false;
      this._wiz.captureError = e.message || "Frequency scan failed";
      this._renderWizard();
      return;
    }
    this._wiz.rfPhase = 2;
    this._renderWizard();
    try {
      const r = await this._hass.connection.sendMessagePromise({
        type: "broadlink_ir_receiver/rf_capture",
        entry_id: this._activeEntry,
      });
      this._wiz.ir_code = r.rf_code || r.raw_hex?.substring(0, 16);
      this._wiz.raw_hex = r.raw_hex;
      this._wiz.capturing = false;
      this._wiz.rfPhase = 0;
      this._renderWizard();
    } catch (e) {
      this._wiz.capturing = false;
      this._wiz.rfPhase = 0;
      this._wiz.captureError = e.message || "RF capture failed";
      this._renderWizard();
    }
  }

  _cancelCapture() {
    if (this._captureSub) { this._captureSub(); this._captureSub = null; }
  }

  // --- main render ---
  _renderShell() {
    const S = `
      :host { display:block; padding:24px; color:var(--primary-text-color,#e4e7eb);
        font-family:var(--paper-font-body1_-_font-family,Roboto,sans-serif);
        background:var(--primary-background-color,#111417); min-height:100vh; box-sizing:border-box; }
      *{box-sizing:border-box}
      .header{display:flex;align-items:center;gap:12px;margin-bottom:20px}
      .header h1{margin:0;font-size:22px;font-weight:400}
      .layout{display:grid;grid-template-columns:300px minmax(0,1fr) 340px;gap:18px;max-width:1320px;align-items:start}
      @media(max-width:1040px){.layout{grid-template-columns:1fr}}
      .panel{background:var(--card-background-color,#1c2025);border:1px solid var(--divider-color,#313742);border-radius:12px;padding:18px}
      .panel h2{font-size:14px;font-weight:500;margin:0 0 14px;color:var(--secondary-text-color,#9aa3ad);text-transform:uppercase;letter-spacing:.5px}
      .mono{font-family:"Roboto Mono",monospace}

      .topbar{display:flex;gap:10px;margin-bottom:18px;padding:12px 16px;background:var(--card-background-color,#1c2025);border:1px solid var(--divider-color,#313742);border-radius:12px;flex-wrap:wrap;align-items:center;max-width:1320px}
      .dev-chip{display:flex;align-items:center;gap:8px;background:var(--card-background-color,#232830);border:1px solid var(--divider-color,#313742);border-radius:8px;padding:10px 14px;cursor:pointer;min-width:180px;transition:.15s}
      .dev-chip:hover{border-color:var(--primary-color,#03a9f4)}
      .dev-chip.active{border-color:var(--primary-color,#03a9f4);box-shadow:0 0 0 1px var(--primary-color,#03a9f4)}
      .dev-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
      .dev-dot.on{background:#4caf50}
      .dev-dot.off{background:#f44336}
      .dev-name{font-size:13px;font-weight:500}
      .dev-meta{font-size:10px;color:var(--secondary-text-color,#9aa3ad)}
      .add-dev-btn{display:flex;align-items:center;gap:6px;background:transparent;border:1px dashed var(--divider-color,#555);border-radius:8px;padding:10px 16px;font-size:13px;color:var(--primary-color,#03a9f4);cursor:pointer}
      .add-dev-btn:hover{border-color:var(--primary-color,#03a9f4)}
      .add-form{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
      .add-form input{background:var(--card-background-color,#232830);color:var(--primary-text-color,#e4e7eb);border:1px solid var(--divider-color,#313742);border-radius:8px;padding:8px 10px;font-size:13px;width:140px}
      .add-form .btn{flex:none;padding:8px 16px}
      .dev-menu{position:relative;display:inline-block}
      .dev-menu-btn{background:none;border:none;color:var(--secondary-text-color,#9aa3ad);cursor:pointer;font-size:16px;padding:2px 6px}
      .dev-menu-drop{position:absolute;right:0;top:100%;background:var(--card-background-color,#232830);border:1px solid var(--divider-color,#313742);border-radius:8px;padding:4px 0;z-index:10;min-width:120px;display:none}
      .dev-menu-drop.open{display:block}
      .dev-menu-drop button{display:block;width:100%;text-align:left;background:none;border:none;color:var(--primary-text-color,#e4e7eb);padding:8px 14px;font-size:12px;cursor:pointer}
      .dev-menu-drop button:hover{background:rgba(255,255,255,.05)}
      .dev-menu-drop button.danger{color:#f44336}

      .remote-pick{display:flex;gap:8px;margin-bottom:16px}
      .remote-pick select{flex:1;background:var(--card-background-color,#232830);color:var(--primary-text-color,#e4e7eb);border:1px solid var(--divider-color,#313742);border-radius:8px;padding:8px}
      .iconbtn{background:var(--card-background-color,#232830);border:1px solid var(--divider-color,#313742);color:var(--primary-text-color,#e4e7eb);border-radius:8px;padding:0 12px;cursor:pointer;font-size:18px}
      .iconbtn:hover{border-color:var(--primary-color,#03a9f4)}
      .iconbtn.danger:hover{border-color:#f44336;color:#f44336}

      .remote{display:flex;flex-direction:column;gap:12px;align-items:center}
      .rrow{display:grid;gap:10px;width:100%}
      .numpad{grid-template-columns:repeat(3,1fr)}
      .twocol{grid-template-columns:repeat(2,1fr)}
      .dpad{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;width:170px;margin:4px auto}
      .dpad .sp{visibility:hidden}
      button.key{position:relative;background:var(--card-background-color,#232830);color:var(--primary-text-color,#e4e7eb);border:1px solid var(--divider-color,#313742);
        border-radius:10px;padding:12px 0;font-size:15px;cursor:pointer;transition:.12s;min-height:44px}
      button.key:hover{border-color:var(--primary-color,#03a9f4)}
      button.key:active{transform:translateY(1px)}
      button.key.power{background:#3a1d1d;border-color:#5a2a2a;color:#ff8a80}
      button.key.round{border-radius:50%;aspect-ratio:1;padding:0}
      button.key .dot{position:absolute;top:6px;right:6px;width:8px;height:8px;border-radius:50%;background:#555}
      button.key.mapped .dot{background:#4caf50;box-shadow:0 0 6px #4caf50}
      button.key.flash{animation:flashkey .9s ease-out}
      @keyframes flashkey{0%{background:var(--primary-color,#03a9f4);border-color:#fff;box-shadow:0 0 0 0 rgba(3,169,244,.7);transform:scale(1.08)}100%{background:var(--card-background-color,#232830);box-shadow:0 0 0 16px rgba(3,169,244,0);transform:scale(1)}}

      .cont{width:100%;margin-top:6px;border-top:1px dashed var(--divider-color,#313742);padding-top:14px}
      .cont .lbl{font-size:12px;color:var(--secondary-text-color,#9aa3ad);display:flex;justify-content:space-between}
      .cont .readout{font-size:26px;font-weight:600;text-align:center;color:var(--primary-color,#03a9f4);margin:4px 0}
      .rocker{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:8px 0}
      .rocker button{font-size:20px;padding:10px 0}
      input[type=range]{width:100%;accent-color:var(--primary-color,#03a9f4)}
      .presets{display:flex;gap:8px;justify-content:center;margin-top:10px}
      .chip{background:transparent;border:1px solid var(--divider-color,#313742);color:var(--secondary-text-color,#9aa3ad);border-radius:14px;padding:5px 12px;font-size:12px;cursor:pointer}
      .chip:hover{border-color:var(--primary-color,#03a9f4);color:var(--primary-text-color,#e4e7eb)}
      .cont .note{font-size:11px;color:var(--secondary-text-color,#9aa3ad);text-align:center;margin-top:8px}

      .map-empty{color:var(--secondary-text-color,#9aa3ad);text-align:center;padding:26px 10px;font-size:14px}
      .auto-card{background:var(--card-background-color,#232830);border:1px solid var(--divider-color,#313742);border-radius:10px;padding:14px;margin-bottom:12px;transition:.15s}
      .auto-card:hover{border-color:var(--primary-color,#03a9f4)}
      .auto-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
      .auto-title{font-size:14px;font-weight:600;color:var(--primary-text-color,#e4e7eb)}
      .auto-controls{display:flex;gap:10px}
      .auto-trigger{display:flex;align-items:center;gap:8px;margin-bottom:10px}
      .auto-btn-badge{background:var(--primary-color,#03a9f4);color:#fff;font-size:10px;font-weight:700;padding:3px 8px;border-radius:4px;text-transform:uppercase;letter-spacing:.3px}
      .auto-actions{display:flex;flex-direction:column;gap:6px}
      .auto-action-row{display:flex;align-items:center;gap:8px;padding:6px 10px;background:rgba(0,0,0,.18);border-radius:6px;font-size:13px}
      .auto-action-text{color:var(--primary-text-color,#e4e7eb);flex:1}
      table{width:100%;border-collapse:collapse;font-size:13px}
      th{text-align:left;color:var(--secondary-text-color,#9aa3ad);font-weight:500;font-size:11px;text-transform:uppercase;letter-spacing:.4px;padding:8px;border-bottom:1px solid var(--divider-color,#313742)}
      td{padding:10px 8px;border-bottom:1px solid #262b32}
      .badge{font-size:11px;padding:2px 7px;border-radius:4px;background:#1b3a4a;color:#8fd3f0}
      .badge.nec{background:#1b5e20;color:#a5d6a7}
      .badge.ir{background:#1b5e20;color:#a5d6a7}
      .badge.rf{background:#1a237e;color:#9fa8da}
      .lk{color:var(--primary-color,#03a9f4);cursor:pointer}.lk:hover{text-decoration:underline}
      .lk.del{color:#f44336}
      .steps{display:flex;gap:6px;margin-bottom:18px}
      .step-pip{flex:1;height:4px;border-radius:2px;background:var(--divider-color,#313742)}
      .step-pip.on{background:var(--primary-color,#03a9f4)}
      .wz-title{font-size:17px;margin:0 0 14px;font-weight:500}
      .field{margin-bottom:14px}
      .field label{display:block;font-size:12px;color:var(--secondary-text-color,#9aa3ad);margin-bottom:5px}
      select,input[type=text],textarea{width:100%;background:var(--card-background-color,#232830);color:var(--primary-text-color,#e4e7eb);border:1px solid var(--divider-color,#313742);border-radius:8px;padding:9px 10px;font-size:14px}
      textarea{font-family:"Roboto Mono",monospace;font-size:12px;min-height:64px;resize:vertical}
      .mode-tabs{display:flex;gap:8px;margin-bottom:14px}
      .mode-tab{flex:1;text-align:center;padding:9px 4px;border-radius:8px;cursor:pointer;border:1px solid var(--divider-color,#313742);background:var(--card-background-color,#232830);color:var(--secondary-text-color,#9aa3ad);font-size:12.5px}
      .mode-tab.on{border-color:var(--primary-color,#03a9f4);color:var(--primary-text-color,#e4e7eb);background:#14242c}
      .capture-box{text-align:center;padding:18px 10px}
      .pulse{width:70px;height:70px;margin:6px auto 14px;border-radius:50%;background:var(--primary-color,#03a9f4);display:flex;align-items:center;justify-content:center;animation:pulse 1.1s infinite;font-size:30px}
      @keyframes pulse{0%{box-shadow:0 0 0 0 rgba(3,169,244,.5)}70%{box-shadow:0 0 0 18px rgba(3,169,244,0)}100%{box-shadow:0 0 0 0 rgba(3,169,244,0)}}
      .code-result{font-family:"Roboto Mono",monospace;font-size:30px;color:#4caf50;text-align:center;margin:10px 0;letter-spacing:2px}
      .preview{background:#0d1216;border:1px solid var(--divider-color,#313742);border-radius:8px;padding:12px;font-family:"Roboto Mono",monospace;font-size:12.5px;white-space:pre;overflow-x:auto;color:#cfe8f5;margin-top:6px}
      .row-btns{display:flex;gap:10px;margin-top:18px}
      .btn{flex:1;padding:11px;border-radius:8px;border:none;cursor:pointer;font-size:14px;font-weight:500}
      .btn.primary{background:var(--primary-color,#03a9f4);color:#fff}.btn.primary:hover{background:#0277bd}
      .btn.ghost{background:transparent;border:1px solid var(--divider-color,#313742);color:var(--secondary-text-color,#9aa3ad)}.btn.ghost:hover{color:var(--primary-text-color,#e4e7eb)}

      .log-hdr{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;gap:8px}
      .log-actions{display:flex;gap:6px;align-items:center}
      .sbtn{background:var(--primary-color,#03a9f4);color:#fff;border:none;border-radius:8px;padding:6px 10px;font-size:12px;cursor:pointer}
      .sbtn.ghost{background:transparent;border:1px solid var(--divider-color,#313742);color:var(--secondary-text-color,#9aa3ad)}
      .sbtn:hover{opacity:.9}
      .logrow{padding:9px 4px;border-bottom:1px solid #262b32}
      .logrow.new{animation:flashrow 1s ease-out}
      @keyframes flashrow{0%{background:rgba(3,169,244,.18)}100%{background:transparent}}
      .lr-top{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--secondary-text-color,#9aa3ad)}
      .lr-code{font-size:15px;margin:3px 0;color:var(--primary-color,#03a9f4)}
      .lr-match{font-size:12px}
      .log-scroll{max-height:560px;overflow-y:auto}
      .match{color:#4caf50}.nomatch{color:var(--secondary-text-color,#9aa3ad)}
      #toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%) translateY(80px);background:var(--primary-color,#03a9f4);color:#fff;padding:10px 22px;border-radius:22px;font-size:14px;transition:.3s;z-index:50}
      #toast.show{transform:translateX(-50%) translateY(0)}
    `;
    this.shadowRoot.innerHTML = `<style>${S}</style>
      <div class="header"><h1>IR Remote &amp; Automation Wizard</h1><span style="margin-left:auto;font-size:11px;color:var(--secondary-text-color,#9aa3ad)">v2.6.0</span></div>
      <div class="topbar" id="topbar"></div>
      <div class="layout">
        <div class="panel"><div class="remote-pick"><select id="remoteSel"></select><button class="iconbtn" id="newRemote" title="New remote">＋</button><button class="iconbtn danger" id="delRemote" title="Delete remote">🗑</button></div><h2 id="remoteTitle">Remote</h2><div class="remote"><div id="remoteGrid"></div><div class="cont"><div class="lbl"><span>Continuous control</span></div><div class="readout" id="cVal">30%</div><input type="range" id="cSlider" min="0" max="100" value="30"><div class="rocker"><button class="key" id="cMinus">– hold</button><button class="key" id="cPlus">+ hold</button></div><div class="presets"><button class="chip" data-p="20">20%</button><button class="chip" data-p="30">30%</button><button class="chip" data-p="50">50%</button></div><div class="note">Hold –/+ to ramp. UX for step-mode mappings.</div></div></div></div>
        <div><div class="panel" id="middle"></div></div>
        <div class="panel"><div class="log-hdr"><h2 style="margin:0">Live IR/RF Log</h2><div class="log-actions"><select id="logFilter" style="background:var(--card-background-color,#232830);color:var(--primary-text-color,#e4e7eb);border:1px solid var(--divider-color,#313742);border-radius:6px;padding:4px 8px;font-size:11px"><option value="">All devices</option></select><button class="sbtn ghost" id="clearLog">Clear</button></div></div><div class="log-scroll" id="log"></div></div>
      </div>
      <div id="toast"></div>`;
    this._bindShell();
  }

  _bindShell() {
    this._$("newRemote").addEventListener("click", () => {
      const dc = this._deviceConfig();
      const name = prompt("New remote name:", "Remote " + (dc.remotes.length + 1));
      if (!name) return;
      const id = "r" + Date.now();
      dc.remotes.push({ id, name, mappings: [] });
      dc.sel = id;
      this._wiz = null;
      this._saveConfig();
      this._renderAll();
    });
    this._$("delRemote").addEventListener("click", () => {
      const dc = this._deviceConfig();
      if (dc.remotes.length <= 1) { this._toast("Keep at least one remote"); return; }
      if (!confirm('Delete remote "' + this._curRemote().name + '" and its mappings?')) return;
      dc.remotes = dc.remotes.filter(r => r.id !== dc.sel);
      dc.sel = dc.remotes[0].id;
      this._wiz = null;
      this._saveConfig();
      this._renderAll();
    });
    this._$("remoteSel").addEventListener("change", (e) => {
      const dc = this._deviceConfig();
      dc.sel = e.target.value;
      this._wiz = null;
      this._saveConfig();
      this._renderAll();
    });
    this._$("clearLog").addEventListener("click", () => {
      this._codes = [];
      this._renderLog(false);
    });
    this._initContinuous();
  }

  _initContinuous() {
    const slider = this._$("cSlider"), val = this._$("cVal");
    const setV = v => { v = Math.max(0, Math.min(100, v)); slider.value = v; val.textContent = v + "%"; };
    slider.oninput = () => setV(Number(slider.value));
    let timer = null;
    const ramp = dir => { timer = setInterval(() => setV(Number(slider.value) + dir * 2), 80); };
    const stop = () => { clearInterval(timer); timer = null; };
    const hold = (id, dir) => {
      const b = this._$(id);
      b.onmousedown = () => { setV(Number(slider.value) + dir * 2); ramp(dir); };
      b.onmouseup = stop; b.onmouseleave = stop;
      b.ontouchstart = e => { e.preventDefault(); setV(Number(slider.value) + dir * 2); ramp(dir); };
      b.ontouchend = stop;
    };
    hold("cMinus", -1); hold("cPlus", +1);
    this.shadowRoot.querySelectorAll(".chip").forEach(c => c.onclick = () => setV(Number(c.dataset.p)));
  }

  // --- render all ---
  _renderAll() {
    if (!this._activeEntry) {
      const ids = Object.keys(this._entries);
      this._activeEntry = ids[0] || null;
    }
    this._renderTopbar();
    this._renderSelector();
    this._renderRemote();
    this._renderMiddle();
    this._renderLog(false);
    this._renderLogFilter();
  }

  _renderTopbar() {
    const el = this._$("topbar");
    if (!el) return;
    const ids = Object.keys(this._entries);
    const isRF = dt => BroadlinkIRPanel.RF_DEVTYPES.has(dt);

    let html = ids.map(id => {
      const e = this._entries[id];
      const active = id === this._activeEntry;
      const lm = e.listen_mode || "ir";
      const modeLabel = lm === "both" ? "IR+RF" : lm === "rf" ? "RF" : "IR";
      const typeBadge = isRF(e.dev_type)
        ? `<span class="badge rf" style="font-size:9px;padding:1px 5px">${modeLabel}${lm !== "ir" ? " ⚡" : ""}</span>`
        : '<span class="badge ir" style="font-size:9px;padding:1px 5px">IR</span>';
      return `<div class="dev-chip ${active ? "active" : ""}" data-eid="${id}">
        <div class="dev-dot ${e.enabled ? "on" : "off"}"></div>
        <div style="flex:1">
          <div class="dev-name">${this._esc(e.name)}</div>
          <div class="dev-meta">${this._esc(e.host)} · ${typeBadge}</div>
        </div>
        <div class="dev-menu">
          <button class="dev-menu-btn" data-menu="${id}">⋮</button>
          <div class="dev-menu-drop" id="menu-${id}">
            <button data-toggle="${id}">${e.enabled ? "Receiver off" : "Receiver on"}</button>
            ${e.rf_capable ? `<div style="padding:4px 8px;font-size:12px">
              Listen: <select data-listenmode="${id}">
                <option value="ir"${lm==="ir"?" selected":""}>IR only</option>
                <option value="rf"${lm==="rf"?" selected":""}>RF only</option>
                <option value="both"${lm==="both"?" selected":""}>IR + RF</option>
              </select>
            </div>` : ""}
            <button data-notif="${id}">${this._isNotifOn(id) ? "Notifications off" : "Notifications on"}</button>
            <button class="danger" data-remove="${id}">Remove device</button>
          </div>
        </div>
      </div>`;
    }).join("");

    html += `<div class="add-dev-btn" id="addDevBtn">＋ Add Device</div>`;
    html += `<div class="add-form" id="addDevForm" style="display:none">
      <input id="addDevHost" placeholder="IP address" />
      <input id="addDevName" placeholder="Name (optional)" />
      <button class="btn primary" id="addDevGo">Add</button>
      <button class="btn ghost" id="addDevCancel">Cancel</button>
    </div>`;

    el.innerHTML = html;

    el.querySelectorAll(".dev-chip").forEach(chip => {
      chip.addEventListener("click", (ev) => {
        if (ev.target.closest(".dev-menu")) return;
        this._activeEntry = chip.dataset.eid;
        this._renderAll();
      });
    });

    el.querySelectorAll(".dev-menu-btn").forEach(btn => {
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const drop = this._$("menu-" + btn.dataset.menu);
        if (drop) drop.classList.toggle("open");
      });
    });

    el.querySelectorAll("[data-toggle]").forEach(btn => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.toggle;
        const on = !(this._entries[id]?.enabled);
        this._toggleEntry(id, on);
      });
    });

    el.querySelectorAll("[data-listenmode]").forEach(sel => {
      sel.addEventListener("change", async () => {
        const id = sel.dataset.listenmode;
        const mode = sel.value;
        try {
          await this._hass.connection.sendMessagePromise({ type: "broadlink_ir_receiver/set_listen_mode", entry_id: id, mode });
          this._entries[id].listen_mode = mode;
          this._toast(`Listen mode: ${mode}`);
          this._renderTopbar();
        } catch (e) {
          this._toast("Mode change failed: " + (e.message || "unknown"));
        }
      });
    });

    el.querySelectorAll("[data-notif]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const id = btn.dataset.notif;
        const reg = (this._entityRegistry || []).find(e => e.config_entry_id === id && e.unique_id && e.unique_id.endsWith("_notifications_switch"));
        if (!reg) { this._toast("Notifications entity not found"); console.error("IR: no registry entry for", id, this._entityRegistry); return; }
        const entityId = reg.entity_id;
        const curState = this._hass?.states?.[entityId];
        const turnOn = !curState || curState.state !== "on";
        try {
          await this._hass.callService("switch", turnOn ? "turn_on" : "turn_off", { entity_id: entityId });
          this._toast(turnOn ? "Notifications on" : "Notifications off");
          setTimeout(() => this._renderTopbar(), 500);
        } catch (e) {
          console.error("IR: notif toggle failed", e);
          this._toast("Failed: " + (e.message || "unknown"));
        }
      });
    });

    el.querySelectorAll("[data-remove]").forEach(btn => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.remove;
        const name = this._entries[id]?.name || id;
        if (!confirm(`Remove device "${name}"? Its mappings will also be deleted.`)) return;
        this._removeDevice(id);
      });
    });

    const addBtn = this._$("addDevBtn");
    if (addBtn) {
      addBtn.addEventListener("click", () => {
        this._$("addDevBtn").style.display = "none";
        this._$("addDevForm").style.display = "flex";
        this._$("addDevHost").focus();
      });
    }
    const cancelBtn = this._$("addDevCancel");
    if (cancelBtn) {
      cancelBtn.addEventListener("click", () => {
        this._$("addDevForm").style.display = "none";
        this._$("addDevBtn").style.display = "flex";
      });
    }
    const goBtn = this._$("addDevGo");
    if (goBtn) {
      goBtn.addEventListener("click", () => this._addDevice());
    }
  }

  _renderSelector() {
    const sel = this._$("remoteSel");
    const dc = this._deviceConfig();
    sel.innerHTML = dc.remotes.map(r =>
      `<option value="${r.id}" ${r.id === dc.sel ? "selected" : ""}>${this._esc(r.name)} (${r.mappings.length})</option>`
    ).join("");
  }

  _renderRemote() {
    const el = this._$("remoteGrid");
    el.innerHTML = "";
    const BTNS = BroadlinkIRPanel.BTNS;
    let i = 0;
    while (i < BTNS.length) {
      const type = BTNS[i].row;
      if (type === "dpad") {
        const pad = document.createElement("div"); pad.className = "dpad";
        const cells = {};
        while (i < BTNS.length && BTNS[i].row === "dpad") { cells[BTNS[i].pos] = BTNS[i]; i++; }
        for (let p = 1; p <= 9; p++) {
          if (cells[p]) pad.appendChild(this._keyEl(cells[p]));
          else { const sp = document.createElement("div"); sp.className = "sp"; pad.appendChild(sp); }
        }
        el.appendChild(pad);
      } else {
        const row = document.createElement("div"); row.className = "rrow " + type;
        while (i < BTNS.length && BTNS[i].row === type) { row.appendChild(this._keyEl(BTNS[i])); i++; }
        el.appendChild(row);
      }
    }
  }

  _keyEl(b) {
    const btn = document.createElement("button");
    btn.className = "key" + (b.cls ? " " + b.cls : "") + (b.round ? " round" : "") + (this._mappedBtn(b.id) ? " mapped" : "");
    btn.dataset.btn = b.id;
    btn.innerHTML = this._esc(b.label) + '<span class="dot"></span>';
    const m = this._mappedBtn(b.id);
    btn.title = m ? ("Mapped: " + m.name) : "Click to learn this button";
    btn.addEventListener("click", () => this._startWizard(b));
    return btn;
  }

  // --- middle: automations view or wizard ---
  _actionIcon(a) {
    const s = a.service || "";
    if (s.includes("light")) return "💡";
    if (s.includes("fan")) return "🌀";
    if (s.includes("cover") || s.includes("curtain")) return "🪟";
    if (s.includes("climate") || s.includes("ac")) return "❄️";
    if (s.includes("switch")) return "🔌";
    if (s.includes("media_player")) return "📺";
    if (s.includes("script")) return "📜";
    if (s.includes("scene")) return "🎬";
    if (s.includes("lock")) return "🔒";
    return "⚡";
  }
  _actionLabel(a) {
    const name = this._entName(a.target);
    const svc = (a.service || "").split(".").pop() || "";
    const verb = svc.replace(/_/g, " ");
    if (a.mode === "level") {
      const unit = (a.service || "").includes("cover") ? "position" : "brightness";
      return `${name} — set ${unit} to ${a.value}%`;
    }
    if (a.mode === "step") {
      const dir = (a.service || "").includes("cover") ? (a.stepDir == -1 ? "close" : "open") : "adjust";
      return `${name} — ${dir} by ${a.stepPct}%`;
    }
    return `${name} — ${verb}`;
  }
  _renderMiddle() {
    if (this._wiz) return this._renderWizard();
    const el = this._$("middle");
    const maps = this._curMaps();
    if (!maps.length) {
      el.innerHTML = `<h2>Automations — ${this._esc(this._curRemote().name)}</h2><div class="map-empty">No automations on this remote.<br>Click a button on the remote to create one, or use an AI agent with the AGENTS.md guide.</div>`;
      return;
    }
    const cards = maps.map(m => {
      const actions = m.actions || [{service: m.service, target: m.target, mode: m.mode || "service", value: m.value, stepPct: m.stepPct, stepDir: m.stepDir, data: m.data}];
      const actionRows = actions.map(a =>
        `<div class="auto-action-row">${this._actionIcon(a)}<span class="auto-action-text">${this._esc(this._actionLabel(a))}</span></div>`
      ).join("");
      const countBadge = actions.length > 1 ? `<span class="badge" style="font-size:10px">${actions.length} actions</span>` : "";
      return `<div class="auto-card">
        <div class="auto-header">
          <div class="auto-title">${this._esc(m.name || "Untitled")}</div>
          <div class="auto-controls">
            <span class="lk" data-edit="${m.id}" style="font-size:12px">edit</span>
            <span class="lk del" data-del="${m.id}" style="font-size:12px">delete</span>
          </div>
        </div>
        <div class="auto-trigger">
          <span class="auto-btn-badge">${this._esc(this._label(m.button))}</span>
          <span class="mono" style="font-size:11px;color:var(--secondary-text-color)">${this._esc(m.ir_code)}</span>
          ${countBadge}
        </div>
        <div class="auto-actions">${actionRows}</div>
      </div>`;
    }).join("");
    el.innerHTML = `<h2>Automations — ${this._esc(this._curRemote().name)} (${maps.length})</h2>${cards}`;
    el.querySelectorAll("[data-del]").forEach(x => x.addEventListener("click", () => {
      this._curRemote().mappings = this._curMaps().filter(m => m.id !== x.dataset.del);
      this._saveConfig(); this._renderAll(); this._toast("Deleted");
    }));
    el.querySelectorAll("[data-edit]").forEach(x => x.addEventListener("click", () => {
      const m = this._curMaps().find(mm => mm.id === x.dataset.edit);
      const b = BroadlinkIRPanel.BTNS.find(bb => bb.id === m.button);
      this._startWizard(b, m);
    }));
  }

  _actionSummary(a) {
    const vk = s => s.includes("cover") ? "position" : "brightness_pct";
    const name = this._entName(a.target);
    if (a.mode === "level") return name + " → " + vk(a.service) + "=" + a.value + "%";
    if (a.mode === "step") {
      const dir = a.service?.includes("cover") ? (a.stepDir == -1 ? "↓" : "↑") : "";
      return name + " → step " + dir + a.stepPct + "%";
    }
    return a.service + " → " + name;
  }
  _summary(m) {
    const actions = m.actions || [{service: m.service, target: m.target, mode: m.mode || "service", value: m.value, stepPct: m.stepPct, stepDir: m.stepDir}];
    if (actions.length === 1) return this._actionSummary(actions[0]);
    return actions.length + " actions: " + actions.map(a => this._entName(a.target)).join(", ");
  }

  // --- wizard ---
  _defaultAction() {
    return {
      service: this._services.find(s => s === "light.toggle") || this._services[0] || "light.toggle",
      target: (this._entities.find(e => e.id.startsWith("light.")) || this._entities[0] || {id:""}).id,
      mode: "service", value: 30, stepPct: 10, stepDir: 1, data: ""
    };
  }
  _migrateActions(m) {
    if (m.actions) return m.actions;
    return [{ service: m.service, target: m.target, mode: m.mode || "service", value: m.value || 30, stepPct: m.stepPct || 10, stepDir: m.stepDir || 1, data: m.data || "" }];
  }
  _entName(entityId) {
    const e = this._entities.find(x => x.id === entityId);
    return e ? e.name : entityId;
  }
  _startWizard(b, existing) {
    this._cancelCapture();
    if (existing) {
      this._wiz = Object.assign({ step: 2, button: b.id, capturing: false, captureMode: "ir", captureError: null }, existing);
      this._wiz.actions = this._migrateActions(existing);
    } else {
      this._wiz = { step: 1, button: b.id, capturing: true, ir_code: null,
          captureMode: "ir", captureError: null,
          actions: [this._defaultAction()],
          name: "IR " + b.id.replace("_", " ") };
    }
    this._wiz.activeAction = 0;
    if (this._wiz.step === undefined) this._wiz.step = 1;
    this._renderRemote();
    this._renderWizard();
    if (this._wiz.step === 1) this._startCapture();
  }

  _renderWizard() {
    const el = this._$("middle");
    const w = this._wiz;
    const pip = n => `<div class="step-pip ${w.step >= n ? "on" : ""}"></div>`;
    let body = "";
    if (w.step === 1) body = this._stepCapture();
    else if (w.step === 2) body = this._stepAction();
    else body = this._stepSave();
    el.innerHTML = `<h2>Learn wizard — ${this._esc(this._label(w.button))} · ${this._esc(this._curRemote().name)}</h2>
      <div class="steps">${pip(1)}${pip(2)}${pip(3)}</div>${body}`;
    this._bindWizard();
  }

  _stepCapture() {
    const w = this._wiz;
    const devType = this._entries[this._activeEntry]?.dev_type || 0;
    const isRF = BroadlinkIRPanel.RF_DEVTYPES.has(devType);
    const modeToggle = isRF ? `<div class="mode-tabs" style="margin-bottom:14px">
      <div class="mode-tab ${(w.captureMode||"ir") === "ir" ? "on" : ""}" data-cap="ir">IR</div>
      <div class="mode-tab ${w.captureMode === "rf" ? "on" : ""}" data-cap="rf">RF</div>
    </div>` : "";

    if (w.capturing) {
      const isRFcap = w.captureMode === "rf";
      const phase = w.rfPhase || 0;
      let rfGuide = "";
      if (isRFcap && phase === 1) {
        rfGuide = `<div style="font-size:16px;font-weight:600">Step 1: Finding frequency…</div>
          <div style="color:var(--secondary-text-color);font-size:13px;margin-top:6px"><b>Hold down</b> the <b>${this._esc(this._label(w.button))}</b> button on your remote (keep holding for 3-5 seconds)</div>
          <div style="color:var(--secondary-text-color);font-size:11px;margin-top:4px">The device is scanning for the RF frequency your remote uses.</div>`;
      } else if (isRFcap && phase === 2) {
        rfGuide = `<div style="font-size:16px;font-weight:600;color:#4caf50">Frequency found!</div>
          <div style="font-size:15px;margin-top:10px">Step 2: Capturing code…</div>
          <div style="color:var(--secondary-text-color);font-size:13px;margin-top:6px">Now <b>short-press</b> the <b>${this._esc(this._label(w.button))}</b> button once</div>`;
      } else {
        rfGuide = `<div style="font-size:16px">Now receiving IR…</div>
          <div style="color:var(--secondary-text-color);font-size:13px;margin-top:6px">Press the <b>${this._esc(this._label(w.button))}</b> button on your physical remote</div>`;
      }
      return `${modeToggle}<div class="capture-box"><div class="pulse">${isRFcap ? "📻" : "📡"}</div>
        ${rfGuide}</div>
        <div class="row-btns"><button class="btn ghost" id="wzCancel">Cancel</button></div>`;
    }

    if (w.captureError) return `${modeToggle}<div class="capture-box"><div style="color:#f44336;font-size:16px">Capture failed</div>
      <div style="color:var(--secondary-text-color);font-size:13px;margin-top:6px">${this._esc(w.captureError)}</div></div>
      <div class="row-btns"><button class="btn ghost" id="wzCancel">Cancel</button><button class="btn primary" id="wzRetry">Retry</button></div>`;

    const proto = w.captureMode === "rf" ? "RF" : "NEC";
    return `${modeToggle}<div class="capture-box"><div style="color:var(--secondary-text-color);font-size:13px">Captured ${w.captureMode === "rf" ? "RF" : "IR"} code</div>
      <div class="code-result">${this._esc(w.ir_code)}</div><div style="color:var(--secondary-text-color);font-size:12px">protocol: ${proto}</div></div>
      <div class="row-btns"><button class="btn ghost" id="wzRetry">Retry</button><button class="btn primary" id="wzNext">Next →</button></div>`;
  }

  _renderActionCard(a, idx, total) {
    const pfx = "wza" + idx + "_";
    const svcField = (lbl, id, opts, sel) => `<div class="field"><label>${lbl}</label><select id="${id}">${opts.map(o => `<option value="${this._esc(o)}" ${o === sel ? "selected" : ""}>${this._esc(o)}</option>`).join("")}</select></div>`;
    const entField = (lbl, id, sel) => `<div class="field"><label>${lbl} <span class="lk wzRefreshEnt" style="font-size:10px;cursor:pointer;margin-left:6px" title="Refresh entity list">↻ refresh</span></label><select id="${id}">${this._entities.map(e => `<option value="${this._esc(e.id)}" ${e.id === sel ? "selected" : ""}>${this._esc(e.name)} — ${this._esc(e.id)}</option>`).join("")}</select></div>`;
    const tab = (mode, txt) => `<div class="mode-tab ${a.mode === mode ? "on" : ""}" data-actidx="${idx}" data-amode="${mode}">${txt}</div>`;
    let fields = "";
    if (a.mode === "service") {
      fields = svcField("Service", pfx+"svc", this._services, a.service) +
        entField("Target entity", pfx+"tgt", a.target) +
        `<div class="field"><label>Extra data (JSON, optional)</label><textarea id="${pfx}data" placeholder='{ "brightness_pct": 80 }'>${this._esc(a.data || "")}</textarea></div>`;
    } else if (a.mode === "level") {
      const lvlSvc = this._services.filter(s => /cover\.|light\.turn_on/.test(s));
      fields = svcField("Service", pfx+"svc", lvlSvc, a.service) +
        entField("Target entity", pfx+"tgt", a.target) +
        `<div class="field"><label>Level: <b id="${pfx}valLbl">${a.value}%</b></label><input type="range" id="${pfx}val" min="0" max="100" value="${a.value}"></div>`;
    } else {
      const stepSvc = this._services.filter(s => /cover\.|light\.turn_on/.test(s));
      const isCover = (a.service || "").includes("cover");
      const dirHtml = isCover ? `<div class="field"><label>Direction</label><select id="${pfx}dir"><option value="1" ${a.stepDir == 1 ? "selected" : ""}>↑ Open (increase)</option><option value="-1" ${a.stepDir == -1 ? "selected" : ""}>↓ Close (decrease)</option></select></div>` : "";
      fields = svcField("Service", pfx+"svc", stepSvc, a.service) +
        entField("Target entity", pfx+"tgt", a.target) + dirHtml +
        `<div class="field"><label>Step per press: <b id="${pfx}stepLbl">${a.stepPct}%</b></label><input type="range" id="${pfx}step" min="5" max="50" step="5" value="${a.stepPct}"></div>`;
    }
    const removeBtn = total > 1 ? `<span class="lk del" data-rmact="${idx}" style="float:right;font-size:11px;cursor:pointer">✕ Remove</span>` : "";
    return `<div class="action-card" data-aidx="${idx}" style="border:1px solid var(--divider-color,#313742);border-radius:8px;padding:12px;margin-bottom:10px;background:rgba(0,0,0,.15)">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <span style="font-size:12px;font-weight:600;color:var(--primary-color,#03a9f4)">Action ${idx + 1}</span>${removeBtn}
      </div>
      <div class="mode-tabs" style="margin-bottom:10px">${tab("service","Service call")}${tab("level","Set level")}${tab("step","Step level")}</div>
      ${fields}
    </div>`;
  }

  _stepAction() {
    const w = this._wiz;
    const cards = w.actions.map((a, i) => this._renderActionCard(a, i, w.actions.length)).join("");
    return `<div class="wz-title">What should <span class="mono" style="color:var(--primary-color,#03a9f4)">${this._esc(w.ir_code)}</span> do?</div>
      <div id="actionCards">${cards}</div>
      <button class="btn ghost" id="wzAddAction" style="width:100%;margin-bottom:14px;padding:8px;font-size:12px">＋ Add another action</button>
      <div class="field"><label>Live preview</label><div class="preview" id="wzPrev"></div></div>
      <div class="row-btns"><button class="btn ghost" id="wzBack">← Back</button><button class="btn primary" id="wzToSave">Next →</button></div>`;
  }

  _stepSave() {
    const w = this._wiz;
    return `<div class="field"><label>Mapping name</label><input type="text" id="wzName" value="${this._esc(w.name)}"></div>
      <div class="field"><label>Action preview</label><div class="preview" id="wzYaml">${this._esc(this._previewText())}</div></div>
      <div style="font-size:11px;color:var(--secondary-text-color);margin-bottom:6px"><b>Save</b> stores this mapping. The integration executes the service call automatically whenever this IR/RF code is received — no separate automation needed.</div>
      <div class="row-btns"><button class="btn ghost" id="wzBack2">← Back</button><button class="btn primary" id="wzSave">Save mapping</button></div>`;
  }

  _previewAction(a) {
    let s = "service: " + a.service + "\ntarget:\n  entity_id: " + a.target;
    if (a.mode === "level") {
      const k = a.service.includes("cover") ? "position" : "brightness_pct";
      s += "\ndata:\n  " + k + ": " + a.value;
    } else if (a.mode === "step") {
      if (a.service.includes("cover")) {
        s += "\ndata:\n  position: current " + (a.stepDir == -1 ? "- " : "+ ") + a.stepPct;
      } else {
        s += "\ndata:\n  brightness_step_pct: " + a.stepPct;
      }
    } else if (a.data && a.data.trim()) {
      s += "\ndata: " + a.data;
    }
    return s;
  }
  _previewText() {
    const w = this._wiz;
    return w.actions.map((a, i) => (w.actions.length > 1 ? `# Action ${i+1}\n` : "") + this._previewAction(a)).join("\n---\n");
  }

  _bindWizard() {
    const w = this._wiz;
    if (w.step === 1) {
      const cancel = this._$("wzCancel");
      if (cancel) cancel.addEventListener("click", () => { this._cancelCapture(); this._wiz = null; this._renderAll(); });
      const retry = this._$("wzRetry");
      if (retry) retry.addEventListener("click", () => { w.step = 1; w.captureError = null; this._startCapture(); });
      const next = this._$("wzNext");
      if (next) next.addEventListener("click", () => { w.step = 2; this._renderWizard(); });
      this.shadowRoot.querySelectorAll("[data-cap]").forEach(t => t.addEventListener("click", () => {
        w.captureMode = t.dataset.cap;
        w.captureError = null;
        this._cancelCapture();
        this._startCapture();
      }));
    } else if (w.step === 2) {
      this.shadowRoot.querySelectorAll("[data-amode]").forEach(t => t.addEventListener("click", () => {
        const idx = parseInt(t.dataset.actidx);
        const a = w.actions[idx];
        if (!a) return;
        a.mode = t.dataset.amode;
        if (a.mode !== "service" && !/cover\.|light\.turn_on/.test(a.service)) a.service = this._services.find(s => /cover\.set_cover_position|light\.turn_on/.test(s)) || a.service;
        this._renderWizard();
      }));
      const syncAll = () => {
        w.actions.forEach((a, i) => {
          const pfx = "wza" + i + "_";
          const svc = this._$(pfx+"svc"); if (svc) a.service = svc.value;
          const tgt = this._$(pfx+"tgt"); if (tgt) a.target = tgt.value;
          const dat = this._$(pfx+"data"); if (dat) a.data = dat.value;
          const val = this._$(pfx+"val"); if (val) { a.value = val.value; const lbl = this._$(pfx+"valLbl"); if (lbl) lbl.textContent = a.value + "%"; }
          const stp = this._$(pfx+"step"); if (stp) { a.stepPct = stp.value; const lbl = this._$(pfx+"stepLbl"); if (lbl) lbl.textContent = a.stepPct + "%"; }
          const dir = this._$(pfx+"dir"); if (dir) a.stepDir = parseInt(dir.value);
        });
        const prev = this._$("wzPrev"); if (prev) prev.textContent = this._previewText();
      };
      w.actions.forEach((a, i) => {
        const pfx = "wza" + i + "_";
        [pfx+"svc", pfx+"tgt", pfx+"data", pfx+"val", pfx+"step", pfx+"dir"].forEach(id => {
          const el = this._$(id); if (el) el.addEventListener("input", syncAll);
        });
        const svcEl = this._$(pfx+"svc");
        if (svcEl && a.mode === "step") svcEl.addEventListener("change", () => { syncAll(); this._renderWizard(); });
      });
      this.shadowRoot.querySelectorAll("[data-rmact]").forEach(btn => {
        btn.addEventListener("click", () => {
          const idx = parseInt(btn.dataset.rmact);
          w.actions.splice(idx, 1);
          this._renderWizard();
        });
      });
      const addBtn = this._$("wzAddAction");
      if (addBtn) addBtn.addEventListener("click", () => { w.actions.push(this._defaultAction()); this._renderWizard(); });
      this.shadowRoot.querySelectorAll(".wzRefreshEnt").forEach(btn => {
        btn.addEventListener("click", async () => { await this._loadHA(); this._renderWizard(); });
      });
      syncAll();
      this._$("wzBack").addEventListener("click", () => { w.step = 1; w.capturing = false; this._renderWizard(); });
      this._$("wzToSave").addEventListener("click", () => { w.step = 3; this._renderWizard(); });
    } else {
      this._$("wzName").addEventListener("input", () => {
        w.name = this._$("wzName").value;
        this._$("wzYaml").textContent = this._previewText();
      });
      this._$("wzBack2").addEventListener("click", () => { w.step = 2; this._renderWizard(); });
      this._$("wzSave").addEventListener("click", () => this._saveMapping());
    }
  }

  _saveMapping() {
    const w = this._wiz;
    const actions = w.actions.map(a => ({
      service: a.service, target: a.target, mode: a.mode || "service",
      value: Number(a.value || 30), stepPct: Number(a.stepPct || 10),
      stepDir: Number(a.stepDir || 1), data: a.data || ""
    }));
    const rec = {
      id: w.id || ("m" + Date.now()),
      button: w.button, ir_code: w.ir_code,
      actions, name: w.name
    };
    const remote = this._curRemote();
    remote.mappings = remote.mappings.filter(m => m.id !== rec.id && m.button !== rec.button).concat(rec);
    this._wiz = null;
    this._saveConfig();
    this._renderAll();
    this._toast("Saved — mapping active immediately");
  }

  // --- log ---
  _renderLogFilter() {
    const sel = this._$("logFilter");
    if (!sel) return;
    let html = '<option value="">All devices</option>';
    for (const [id, e] of Object.entries(this._entries)) {
      html += `<option value="${id}" ${this._logFilter === id ? "selected" : ""}>${this._esc(e.name)}</option>`;
    }
    sel.innerHTML = html;
    sel.onchange = () => {
      this._logFilter = sel.value || null;
      this._renderLog(false);
    };
  }

  _renderLog(flashFirst) {
    const el = this._$("log");
    if (!el) return;

    let codes = this._codes;
    if (this._logFilter) {
      const filterHost = this._entries[this._logFilter]?.host;
      if (filterHost) codes = codes.filter(c => c.host === filterHost);
    }

    if (!codes.length) {
      el.innerHTML = `<div class="map-empty">No IR/RF received yet.<br>Press a button on your physical remote.</div>`;
      return;
    }
    el.innerHTML = codes.map((c, i) => {
      const code = c.nec_code || (c.raw_hex || "").substring(0, 16) || "-";
      const proto = c.protocol || "Unknown";
      const t = this._fmtTime(c.timestamp);
      const devName = c.device || c.host || "?";
      const m = this._curMaps().find(x => x.ir_code === code);
      const protoCls = proto === "NEC" ? "nec" : proto === "RF" ? "rf" : "";
      return `<div class="logrow ${flashFirst && i === 0 ? "new" : ""}">
        <div class="lr-top"><span>${t}</span><span style="font-size:11px;font-weight:500;color:var(--primary-color,#03a9f4)">${this._esc(devName)}</span><span class="badge ${protoCls}">${this._esc(proto)}</span></div>
        <div class="lr-code mono">${this._esc(code)}</div>
        <div class="lr-match ${m ? "match" : "nomatch"}">${m ? "→ " + this._esc(this._label(m.button)) + " · " + this._esc(this._curRemote().name) : "unmapped"}</div>
      </div>`;
    }).join("");
  }
}

customElements.define("broadlink-ir-panel", BroadlinkIRPanel);
