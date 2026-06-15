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
    await Promise.all([this._loadState(), this._loadConfig(), this._loadHA()]);
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
      if (!this._config || !this._config.remotes) this._config = { remotes: [{ id: "r1", name: "Remote 1", mappings: [] }], sel: "r1" };
    } catch (e) {
      console.error("IR: load config failed", e);
      this._config = { remotes: [{ id: "r1", name: "Remote 1", mappings: [] }], sel: "r1" };
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
      this._entities = (states || []).map(s => s.entity_id).sort();
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

  // --- helpers ---
  _esc(s) { if (s == null) return ""; const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }
  _$(id) { return this.shadowRoot.getElementById(id); }
  _curRemote() { return this._config.remotes.find(r => r.id === this._config.sel) || this._config.remotes[0]; }
  _curMaps() { return this._curRemote().mappings; }
  _mappedBtn(id) { return this._curMaps().find(m => m.button === id); }
  _label(id) { return id.toUpperCase().replace("_", " "); }
  _toast(m) { const t = this._$("toast"); if (!t) return; t.textContent = m; t.classList.add("show"); setTimeout(() => t.classList.remove("show"), 1800); }
  _fmtTime(ts) { return new Date(ts * 1000).toLocaleTimeString(); }

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
      this._renderControls();
    } catch (e) { console.error("IR: toggle failed", e); }
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

  // --- IR capture (real) ---
  async _startCapture() {
    this._wiz.capturing = true;
    this._wiz.ir_code = null;
    this._renderWizard();
    try {
      this._captureSub = await this._hass.connection.subscribeEvents((ev) => {
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

      .controls{display:flex;gap:12px;margin-bottom:16px}
      .ctl{flex:1;display:flex;align-items:center;justify-content:space-between;gap:10px;
        background:var(--card-background-color,#232830);border:1px solid var(--divider-color,#313742);border-radius:10px;padding:10px 14px}
      .ctl .cname{font-size:13px}
      .ctl .cstate{font-size:11px;color:var(--secondary-text-color,#9aa3ad)}
      .sw{width:44px;height:24px;border-radius:12px;background:#444;position:relative;cursor:pointer;transition:.15s;flex:none}
      .sw::after{content:"";position:absolute;top:2px;left:2px;width:20px;height:20px;border-radius:50%;background:#fff;transition:.15s}
      .sw.on{background:var(--primary-color,#03a9f4)}
      .sw.on::after{left:22px}

      .map-empty{color:var(--secondary-text-color,#9aa3ad);text-align:center;padding:26px 10px;font-size:14px}
      table{width:100%;border-collapse:collapse;font-size:13px}
      th{text-align:left;color:var(--secondary-text-color,#9aa3ad);font-weight:500;font-size:11px;text-transform:uppercase;letter-spacing:.4px;padding:8px;border-bottom:1px solid var(--divider-color,#313742)}
      td{padding:10px 8px;border-bottom:1px solid #262b32}
      .badge{font-size:11px;padding:2px 7px;border-radius:4px;background:#1b3a4a;color:#8fd3f0}
      .badge.nec{background:#1b5e20;color:#a5d6a7}
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
      .log-actions{display:flex;gap:6px}
      .sbtn{background:var(--primary-color,#03a9f4);color:#fff;border:none;border-radius:8px;padding:6px 10px;font-size:12px;cursor:pointer}
      .sbtn.ghost{background:transparent;border:1px solid var(--divider-color,#313742);color:var(--secondary-text-color,#9aa3ad)}
      .sbtn:hover{opacity:.9}
      .logrow{padding:9px 4px;border-bottom:1px solid #262b32}
      .logrow.new{animation:flashrow 1s ease-out}
      @keyframes flashrow{0%{background:rgba(3,169,244,.18)}100%{background:transparent}}
      .lr-top{display:flex;align-items:center;justify-content:space-between;font-size:12px;color:var(--secondary-text-color,#9aa3ad)}
      .lr-code{font-size:15px;margin:3px 0;color:var(--primary-color,#03a9f4)}
      .lr-match{font-size:12px}
      .log-scroll{max-height:560px;overflow-y:auto}
      .match{color:#4caf50}.nomatch{color:var(--secondary-text-color,#9aa3ad)}
      #toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%) translateY(80px);background:var(--primary-color,#03a9f4);color:#fff;padding:10px 22px;border-radius:22px;font-size:14px;transition:.3s;z-index:50}
      #toast.show{transform:translateX(-50%) translateY(0)}
    `;
    this.shadowRoot.innerHTML = `<style>${S}</style>
      <div class="header"><h1>IR Remote &amp; Automation Wizard</h1></div>
      <div class="layout">
        <div class="panel"><div class="remote-pick"><select id="remoteSel"></select><button class="iconbtn" id="newRemote" title="New remote">＋</button><button class="iconbtn danger" id="delRemote" title="Delete remote">🗑</button></div><h2 id="remoteTitle">Remote</h2><div class="remote"><div id="remoteGrid"></div><div class="cont"><div class="lbl"><span>Continuous control</span></div><div class="readout" id="cVal">30%</div><input type="range" id="cSlider" min="0" max="100" value="30"><div class="rocker"><button class="key" id="cMinus">– hold</button><button class="key" id="cPlus">+ hold</button></div><div class="presets"><button class="chip" data-p="20">20%</button><button class="chip" data-p="30">30%</button><button class="chip" data-p="50">50%</button></div><div class="note">Hold –/+ to ramp. UX for step-mode mappings.</div></div></div></div>
        <div><div class="controls" id="controls"></div><div class="panel" id="middle"></div></div>
        <div class="panel"><div class="log-hdr"><h2 style="margin:0">Live IR Log</h2><div class="log-actions"><button class="sbtn ghost" id="clearLog">Clear</button></div></div><div class="log-scroll" id="log"></div></div>
      </div>
      <div id="toast"></div>`;
    this._bindShell();
  }

  _bindShell() {
    this._$("newRemote").addEventListener("click", () => {
      const name = prompt("New remote name:", "Remote " + (this._config.remotes.length + 1));
      if (!name) return;
      const id = "r" + Date.now();
      this._config.remotes.push({ id, name, mappings: [] });
      this._config.sel = id;
      this._wiz = null;
      this._saveConfig();
      this._renderAll();
    });
    this._$("delRemote").addEventListener("click", () => {
      if (this._config.remotes.length <= 1) { this._toast("Keep at least one remote"); return; }
      if (!confirm('Delete remote "' + this._curRemote().name + '" and its mappings?')) return;
      this._config.remotes = this._config.remotes.filter(r => r.id !== this._config.sel);
      this._config.sel = this._config.remotes[0].id;
      this._wiz = null;
      this._saveConfig();
      this._renderAll();
    });
    this._$("remoteSel").addEventListener("change", (e) => {
      this._config.sel = e.target.value;
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
    this._renderSelector();
    this._renderControls();
    this._renderRemote();
    this._renderMiddle();
    this._renderLog(false);
  }

  _renderSelector() {
    const sel = this._$("remoteSel");
    sel.innerHTML = this._config.remotes.map(r =>
      `<option value="${r.id}" ${r.id === this._config.sel ? "selected" : ""}>${this._esc(r.name)} (${r.mappings.length})</option>`
    ).join("");
  }

  _renderControls() {
    const el = this._$("controls");
    const ids = Object.keys(this._entries);
    let html = "";
    for (const id of ids) {
      const e = this._entries[id];
      html += `<div class="ctl"><div><div class="cname">${this._esc(e.name)}</div><div class="cstate">${e.enabled ? "Listening" : "Off"}</div></div><div class="sw ${e.enabled ? "on" : ""}" data-eid="${id}"></div></div>`;
    }
    // notifications switch — check entity state
    const ntEntity = Object.values(this._hass.states || {}).find(s => s.entity_id.endsWith("_notifications"));
    if (ntEntity) {
      const ntOn = ntEntity.state === "on";
      html += `<div class="ctl"><div><div class="cname">Notifications</div><div class="cstate">${ntOn ? "On" : "Off"}</div></div><div class="sw ${ntOn ? "on" : ""}" data-ntid="${ntEntity.entity_id}"></div></div>`;
    }
    el.innerHTML = html;
    el.querySelectorAll(".sw[data-eid]").forEach(sw => {
      sw.addEventListener("click", () => {
        const on = !sw.classList.contains("on");
        this._toggleEntry(sw.dataset.eid, on);
      });
    });
    el.querySelectorAll(".sw[data-ntid]").forEach(sw => {
      sw.addEventListener("click", () => {
        const on = !sw.classList.contains("on");
        const svc = on ? "switch.turn_on" : "switch.turn_off";
        const [domain, s] = svc.split(".");
        this._hass.callService(domain, s, { entity_id: sw.dataset.ntid });
        sw.classList.toggle("on", on);
        sw.closest(".ctl").querySelector(".cstate").textContent = on ? "On" : "Off";
      });
    });
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

  // --- middle: mappings table or wizard ---
  _renderMiddle() {
    if (this._wiz) return this._renderWizard();
    const el = this._$("middle");
    const maps = this._curMaps();
    if (!maps.length) {
      el.innerHTML = `<h2>Mapped buttons — ${this._esc(this._curRemote().name)}</h2><div class="map-empty">No buttons mapped on this remote.<br>Click a button on the remote to start the learn wizard.</div>`;
      return;
    }
    const rows = maps.map(m => `<tr>
      <td>${this._esc(this._label(m.button))}</td>
      <td class="mono">${this._esc(m.ir_code)}</td>
      <td><span class="badge">${this._esc(m.mode)}</span> ${this._esc(this._summary(m))}</td>
      <td style="text-align:right;white-space:nowrap"><span class="lk" data-edit="${m.id}">edit</span> · <span class="lk del" data-del="${m.id}">delete</span></td>
    </tr>`).join("");
    el.innerHTML = `<h2>Mapped buttons — ${this._esc(this._curRemote().name)} (${maps.length})</h2>
      <table><thead><tr><th>Button</th><th>IR code</th><th>Action</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
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

  _summary(m) {
    const vk = s => s.includes("cover") ? "position" : "brightness_pct";
    const sk = s => s.includes("cover") ? "position_step" : "brightness_step_pct";
    if (m.mode === "service") return m.service + " → " + (m.target || "—");
    if (m.mode === "level") return m.service + " " + vk(m.service) + "=" + m.value;
    if (m.mode === "step") return m.service + " " + sk(m.service) + "=" + m.stepPct;
    return "";
  }

  // --- wizard ---
  _startWizard(b, existing) {
    this._cancelCapture();
    this._wiz = existing
      ? Object.assign({ step: 2, button: b.id, capturing: false }, existing)
      : { step: 1, button: b.id, capturing: true, ir_code: null, mode: "service",
          service: this._services.find(s => s === "light.toggle") || this._services[0] || "light.toggle",
          target: this._entities.find(s => s.startsWith("light.")) || this._entities[0] || "",
          value: 30, stepPct: 10, data: "", name: "IR " + b.id.replace("_", " ") };
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
    if (w.capturing) return `<div class="capture-box"><div class="pulse">📡</div>
      <div style="font-size:16px">Now receiving…</div>
      <div style="color:var(--secondary-text-color);font-size:13px;margin-top:6px">Press the <b>${this._esc(this._label(w.button))}</b> button on your physical remote</div></div>
      <div class="row-btns"><button class="btn ghost" id="wzCancel">Cancel</button></div>`;
    return `<div class="capture-box"><div style="color:var(--secondary-text-color);font-size:13px">Captured IR code</div>
      <div class="code-result">${this._esc(w.ir_code)}</div><div style="color:var(--secondary-text-color);font-size:12px">protocol: NEC</div></div>
      <div class="row-btns"><button class="btn ghost" id="wzRetry">Retry</button><button class="btn primary" id="wzNext">Next →</button></div>`;
  }

  _stepAction() {
    const w = this._wiz;
    const tab = (id, txt) => `<div class="mode-tab ${w.mode === id ? "on" : ""}" data-mode="${id}">${txt}</div>`;
    const selField = (lbl, id, opts, sel) => `<div class="field"><label>${lbl}</label><select id="${id}">${opts.map(o => `<option ${o === sel ? "selected" : ""}>${this._esc(o)}</option>`).join("")}</select></div>`;
    let fields = "";
    if (w.mode === "service") {
      fields = selField("Service", "wzService", this._services, w.service) +
        selField("Target entity", "wzTarget", this._entities, w.target) +
        `<div class="field"><label>Extra data (JSON, optional)</label><textarea id="wzData" placeholder='{ "brightness_pct": 80 }'>${this._esc(w.data)}</textarea></div>`;
    } else if (w.mode === "level") {
      const lvlSvc = this._services.filter(s => /set_cover_position|turn_on/.test(s));
      fields = selField("Service", "wzService", lvlSvc, w.service) +
        selField("Target entity", "wzTarget", this._entities, w.target) +
        `<div class="field"><label>Level: <b id="wzValLbl">${w.value}%</b></label><input type="range" id="wzValue" min="0" max="100" value="${w.value}"></div>`;
    } else {
      const stepSvc = this._services.filter(s => /set_cover_position|turn_on/.test(s));
      fields = selField("Service", "wzService", stepSvc, w.service) +
        selField("Target entity", "wzTarget", this._entities, w.target) +
        `<div class="field"><label>Step per press: <b id="wzStepLbl">${w.stepPct}%</b></label><input type="range" id="wzStep" min="5" max="50" step="5" value="${w.stepPct}"></div>
        <div style="font-size:11px;color:var(--secondary-text-color)">Holding the IR button repeats → ramps by this step.</div>`;
    }
    return `<div class="wz-title">What should <span class="mono" style="color:var(--primary-color,#03a9f4)">${this._esc(w.ir_code)}</span> do?</div>
      <div class="mode-tabs">${tab("service", "Service call")}${tab("level", "Set level")}${tab("step", "Step level")}</div>${fields}
      <div class="field"><label>Live preview</label><div class="preview" id="wzPrev"></div></div>
      <div class="row-btns"><button class="btn ghost" id="wzBack">← Back</button><button class="btn primary" id="wzToSave">Next →</button></div>`;
  }

  _stepSave() {
    const w = this._wiz;
    return `<div class="field"><label>Mapping name</label><input type="text" id="wzName" value="${this._esc(w.name)}"></div>
      <div class="field"><label>Action preview</label><div class="preview" id="wzYaml">${this._esc(this._previewText())}</div></div>
      <div style="font-size:11px;color:var(--secondary-text-color);margin-bottom:6px"><b>Save</b> stores this mapping. The integration executes the service call automatically whenever this IR code is received — no separate automation needed.</div>
      <div class="row-btns"><button class="btn ghost" id="wzBack2">← Back</button><button class="btn primary" id="wzSave">Save mapping</button></div>`;
  }

  _previewText() {
    const w = this._wiz;
    let s = "service: " + w.service + "\ntarget:\n  entity_id: " + w.target;
    if (w.mode === "level") {
      const k = w.service.includes("cover") ? "position" : "brightness_pct";
      s += "\ndata:\n  " + k + ": " + w.value;
    } else if (w.mode === "step") {
      const k = w.service.includes("cover") ? "position_step" : "brightness_step_pct";
      s += "\ndata:\n  " + k + ": " + w.stepPct;
    } else if (w.data && w.data.trim()) {
      s += "\ndata: " + w.data;
    }
    return s;
  }

  _bindWizard() {
    const w = this._wiz;
    if (w.step === 1) {
      const cancel = this._$("wzCancel");
      if (cancel) cancel.addEventListener("click", () => { this._cancelCapture(); this._wiz = null; this._renderAll(); });
      const retry = this._$("wzRetry");
      if (retry) retry.addEventListener("click", () => { w.step = 1; this._startCapture(); });
      const next = this._$("wzNext");
      if (next) next.addEventListener("click", () => { w.step = 2; this._renderWizard(); });
    } else if (w.step === 2) {
      this.shadowRoot.querySelectorAll(".mode-tab").forEach(t => t.addEventListener("click", () => {
        w.mode = t.dataset.mode;
        if (w.mode !== "service" && !/set_cover_position|turn_on/.test(w.service)) w.service = this._services.find(s => /turn_on/.test(s)) || w.service;
        this._renderWizard();
      }));
      const sync = () => {
        const svc = this._$("wzService"); if (svc) w.service = svc.value;
        const tgt = this._$("wzTarget"); if (tgt) w.target = tgt.value;
        const dat = this._$("wzData"); if (dat) w.data = dat.value;
        const val = this._$("wzValue"); if (val) { w.value = val.value; const lbl = this._$("wzValLbl"); if (lbl) lbl.textContent = w.value + "%"; }
        const stp = this._$("wzStep"); if (stp) { w.stepPct = stp.value; const lbl = this._$("wzStepLbl"); if (lbl) lbl.textContent = w.stepPct + "%"; }
        const prev = this._$("wzPrev"); if (prev) prev.textContent = this._previewText();
      };
      ["wzService", "wzTarget", "wzData", "wzValue", "wzStep"].forEach(id => {
        const el = this._$(id); if (el) el.addEventListener("input", sync);
      });
      sync();
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
    const rec = {
      id: w.id || ("m" + Date.now()),
      button: w.button, ir_code: w.ir_code, mode: w.mode,
      service: w.service, target: w.target,
      value: Number(w.value), stepPct: Number(w.stepPct),
      data: w.data, name: w.name
    };
    const remote = this._curRemote();
    remote.mappings = remote.mappings.filter(m => m.id !== rec.id && m.button !== rec.button).concat(rec);
    this._wiz = null;
    this._saveConfig();
    this._renderAll();
    this._toast("Saved — mapping active immediately");
  }

  // --- log ---
  _renderLog(flashFirst) {
    const el = this._$("log");
    if (!el) return;
    if (!this._codes.length) {
      el.innerHTML = `<div class="map-empty">No IR received yet.<br>Press a button on your physical remote.</div>`;
      return;
    }
    el.innerHTML = this._codes.map((c, i) => {
      const code = c.nec_code || (c.raw_hex || "").substring(0, 16) || "-";
      const proto = c.protocol || "Unknown";
      const t = this._fmtTime(c.timestamp);
      const m = this._curMaps().find(x => x.ir_code === code);
      return `<div class="logrow ${flashFirst && i === 0 ? "new" : ""}">
        <div class="lr-top"><span>${t}</span><span class="badge ${proto === "NEC" ? "nec" : ""}">${this._esc(proto)}</span></div>
        <div class="lr-code mono">${this._esc(code)}</div>
        <div class="lr-match ${m ? "match" : "nomatch"}">${m ? "→ " + this._esc(this._label(m.button)) + " · " + this._esc(this._curRemote().name) : "unmapped"}</div>
      </div>`;
    }).join("");
  }
}

customElements.define("broadlink-ir-panel", BroadlinkIRPanel);
