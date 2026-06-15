# Multi-Device Management + RF Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Manage multiple BroadLink IR/RF devices from one panel with per-device mappings, inline add/remove, and RF capture for RM4 Pro.

**Architecture:** Restructure mappings store from flat to per-device keyed by `entry_id`. Add 3 new WS commands (`add_device`, `remove_device`, `start_rf_capture`). Extend panel with device top bar, device-scoped config, RF mode in wizard, device-tagged log. Config flow gains a `ws` source for programmatic entry creation.

**Tech Stack:** Python 3.12 (HA custom component), broadlink library, HA WebSocket API, Shadow DOM web component (panel.js)

**Spec:** `docs/superpowers/specs/2026-06-15-multi-device-rf-design.md`

**No test framework** in this project. Verification is manual on live HA via REST/WS API + panel interaction. Each task includes specific verification steps.

---

### Task 1: Add RF constants to const.py

**Files:**
- Modify: `custom_components/broadlink_ir_receiver/const.py`

- [ ] **Step 1: Add RF_CAPABLE_DEVTYPES set and STORE_VERSION**

```python
DOMAIN = "broadlink_ir_receiver"
DEFAULT_POLL_INTERVAL = 0.1
DEFAULT_DEBOUNCE = 0.3
EVENT_IR_COMMAND = "broadlink_ir_command"
MAX_CODE_HISTORY = 100
PLATFORMS = ["switch", "sensor"]

RF_CAPABLE_DEVTYPES = {
    0x51DA, 0x61A2, 0x649B, 0x653C,
    0x653A, 0x6508, 0x6539, 0x648D,
    0x6184, 0x6070, 0x610E, 0x610F,
    0x62BC, 0x62BE, 0x6364, 0x6476,
}
```

- [ ] **Step 2: Commit**

```
git add custom_components/broadlink_ir_receiver/const.py
git commit -m "feat: add RF_CAPABLE_DEVTYPES constant for RM4 Pro detection"
```

---

### Task 2: Restructure mappings store for per-device scoping

**Files:**
- Modify: `custom_components/broadlink_ir_receiver/mappings.py`

- [ ] **Step 1: Update default_data and add migration logic**

Replace the entire `default_data` function and add a migration helper:

```python
STORE_VERSION = 1

def default_data():
    return {"version": 2, "devices": {}}

def _migrate_v1(data: dict, first_entry_id: str | None) -> dict:
    """Migrate flat v2.2.0 format to per-device v2.3.0 format."""
    if data.get("version") == 2:
        return data
    if "remotes" in data and first_entry_id:
        return {
            "version": 2,
            "devices": {
                first_entry_id: {
                    "remotes": data["remotes"],
                    "sel": data.get("sel", "r1"),
                }
            },
        }
    return default_data()
```

- [ ] **Step 2: Update MappingsStore.__init__ to accept entry_ids for migration**

```python
class MappingsStore:

    def __init__(self, hass: HomeAssistant) -> None:
        self._hass = hass
        self._store = Store(hass, STORE_VERSION, STORE_KEY)
        self._data: dict | None = None
        self._unsub = None

    async def async_load(self, first_entry_id: str | None = None) -> None:
        raw = await self._store.async_load()
        if raw is None:
            self._data = default_data()
        else:
            self._data = _migrate_v1(raw, first_entry_id)
            if raw != self._data:
                await self.async_save()
        if "devices" not in self._data:
            self._data = default_data()
```

- [ ] **Step 3: Add ensure_device helper**

```python
    def ensure_device(self, entry_id: str) -> None:
        """Create default device config if entry_id not in store."""
        if entry_id not in self._data.get("devices", {}):
            self._data.setdefault("devices", {})[entry_id] = {
                "remotes": [{"id": "r1", "name": "Remote 1", "mappings": []}],
                "sel": "r1",
            }

    def remove_device(self, entry_id: str) -> None:
        """Remove device config from store."""
        self._data.get("devices", {}).pop(entry_id, None)
```

- [ ] **Step 4: Update executor to match per-device (code + host)**

Replace `start_executor`:

```python
    def start_executor(self) -> None:
        @callback
        def _handle_ir(event):
            code = event.data.get("nec_code") or event.data.get("raw_hex", "")[:16]
            host = event.data.get("host")
            if not code or not host:
                return
            entry_id = self._find_entry_by_host(host)
            if not entry_id:
                return
            device_data = self._data.get("devices", {}).get(entry_id, {})
            for remote in device_data.get("remotes", []):
                for m in remote.get("mappings", []):
                    if m.get("ir_code") != code:
                        continue
                    _LOGGER.info(
                        "IR match: %s → %s on remote '%s' (device %s)",
                        code,
                        m.get("service"),
                        remote.get("name"),
                        entry_id,
                    )
                    self._execute(m, host)
                    return

        self._unsub = self._hass.bus.async_listen(EVENT_IR_COMMAND, _handle_ir)

    def _find_entry_by_host(self, host: str) -> str | None:
        for entry_id, data in self._hass.data.get(DOMAIN, {}).items():
            if isinstance(data, dict) and "listener" in data:
                if data["listener"].host == host:
                    return entry_id
        return None
```

- [ ] **Step 5: Commit**

```
git add custom_components/broadlink_ir_receiver/mappings.py
git commit -m "feat: restructure mappings store for per-device scoping with v1 migration"
```

---

### Task 3: Expose dev_type in ws_get_state

**Files:**
- Modify: `custom_components/broadlink_ir_receiver/__init__.py`

- [ ] **Step 1: Update ws_get_state to include dev_type**

In `ws_get_state`, change the entries dict construction to include `dev_type` from the config entry data:

```python
@websocket_api.websocket_command(
    {vol.Required("type"): "broadlink_ir_receiver/get_state"}
)
@websocket_api.async_response
async def ws_get_state(hass, connection, msg):
    entries = {}
    for entry_id, data in hass.data.get(DOMAIN, {}).items():
        if not isinstance(data, dict) or "listener" not in data:
            continue
        listener = data["listener"]
        dev_type = data.get("dev_type", 0)
        entries[entry_id] = {
            "enabled": listener.enabled,
            "host": listener.host,
            "name": listener.name,
            "dev_type": dev_type,
            "codes": list(data.get("code_history", [])),
        }
    connection.send_result(msg["id"], {"entries": entries})
```

- [ ] **Step 2: Store dev_type in hass.data during setup**

In `async_setup_entry`, add `dev_type` to the entry data dict:

```python
    hass.data[DOMAIN][entry.entry_id] = {
        "listener": listener,
        "code_history": deque(maxlen=MAX_CODE_HISTORY),
        "dev_type": entry.data.get("dev_type", 0),
    }
```

- [ ] **Step 3: Update mappings store load to pass first entry_id for migration**

In `async_setup_entry`, change the mappings store init block:

```python
    if "_mappings_store" not in hass.data[DOMAIN]:
        store = MappingsStore(hass)
        await store.async_load(first_entry_id=entry.entry_id)
        store.start_executor()
        hass.data[DOMAIN]["_mappings_store"] = store

    store = hass.data[DOMAIN]["_mappings_store"]
    store.ensure_device(entry.entry_id)
    await store.async_save()
```

- [ ] **Step 4: Commit**

```
git add custom_components/broadlink_ir_receiver/__init__.py
git commit -m "feat: expose dev_type in WS state, ensure per-device mappings on setup"
```

---

### Task 4: Add ws_add_device and ws_remove_device commands

**Files:**
- Modify: `custom_components/broadlink_ir_receiver/__init__.py`

- [ ] **Step 1: Import RF_CAPABLE_DEVTYPES in __init__.py**

Add to the existing const imports:

```python
from .const import (
    DEFAULT_DEBOUNCE,
    DEFAULT_POLL_INTERVAL,
    DOMAIN,
    EVENT_IR_COMMAND,
    MAX_CODE_HISTORY,
    PLATFORMS,
    RF_CAPABLE_DEVTYPES,
)
```

- [ ] **Step 2: Add ws_add_device command**

Add after the existing WS commands (after `ws_clear_codes`):

```python
@websocket_api.websocket_command(
    {
        vol.Required("type"): "broadlink_ir_receiver/add_device",
        vol.Required("host"): str,
        vol.Optional("name"): str,
    }
)
@websocket_api.async_response
async def ws_add_device(hass, connection, msg):
    host = msg["host"]
    name = msg.get("name") or f"BroadLink {host}"

    for eid, data in hass.data.get(DOMAIN, {}).items():
        if isinstance(data, dict) and "listener" in data:
            if data["listener"].host == host:
                connection.send_error(msg["id"], "already_configured", f"Device at {host} already configured")
                return

    try:
        devices = await hass.async_add_executor_job(broadlink.discover, 5, None, host)
        if not devices:
            connection.send_error(msg["id"], "cannot_connect", f"No device found at {host}")
            return
        dev = devices[0]
        await hass.async_add_executor_job(dev.auth)
    except Exception as exc:
        connection.send_error(msg["id"], "cannot_connect", str(exc))
        return

    result = await hass.config_entries.flow.async_init(
        DOMAIN,
        context={"source": "ws"},
        data={
            "host": host,
            "name": name,
            "dev_type": dev.devtype,
            "mac": ":".join(f"{b:02x}" for b in dev.mac),
        },
    )

    if result.get("type") == "create_entry":
        connection.send_result(msg["id"], {
            "success": True,
            "entry_id": result["result"].entry_id,
            "dev_type": dev.devtype,
        })
    else:
        connection.send_error(msg["id"], "setup_failed", "Could not create config entry")
```

- [ ] **Step 3: Add ws_remove_device command**

```python
@websocket_api.websocket_command(
    {
        vol.Required("type"): "broadlink_ir_receiver/remove_device",
        vol.Required("entry_id"): str,
    }
)
@websocket_api.async_response
async def ws_remove_device(hass, connection, msg):
    entry_id = msg["entry_id"]
    entry = hass.config_entries.async_get_entry(entry_id)
    if not entry or entry.domain != DOMAIN:
        connection.send_error(msg["id"], "not_found", "Config entry not found")
        return

    store = hass.data.get(DOMAIN, {}).get("_mappings_store")
    if store:
        store.remove_device(entry_id)
        await store.async_save()

    await hass.config_entries.async_remove(entry_id)
    connection.send_result(msg["id"], {"success": True})
```

- [ ] **Step 4: Register new WS commands in async_setup_entry**

In the `if "_panel_registered" not in hass.data[DOMAIN]:` block, add:

```python
        websocket_api.async_register_command(hass, ws_add_device)
        websocket_api.async_register_command(hass, ws_remove_device)
```

- [ ] **Step 5: Commit**

```
git add custom_components/broadlink_ir_receiver/__init__.py
git commit -m "feat: add ws_add_device and ws_remove_device WS commands"
```

---

### Task 5: Add config flow ws source

**Files:**
- Modify: `custom_components/broadlink_ir_receiver/config_flow.py`

- [ ] **Step 1: Add async_step_ws method**

Add after `async_step_user`:

```python
    async def async_step_ws(self, data=None):
        """Handle config entry creation from WebSocket (panel add device)."""
        if data is None:
            return self.async_abort(reason="no_data")

        host = data.get("host")
        if not host:
            return self.async_abort(reason="no_host")

        for entry in self._async_current_entries():
            if entry.data.get(CONF_HOST) == host:
                return self.async_abort(reason="already_configured")

        name = data.get("name", f"BroadLink {host}")
        return self.async_create_entry(
            title=name,
            data={
                CONF_HOST: host,
                CONF_NAME: name,
                "dev_type": data.get("dev_type", 0),
                "mac": data.get("mac", ""),
            },
        )
```

- [ ] **Step 2: Commit**

```
git add custom_components/broadlink_ir_receiver/config_flow.py
git commit -m "feat: add ws config flow source for panel-driven device addition"
```

---

### Task 6: Add ws_start_rf_capture command

**Files:**
- Modify: `custom_components/broadlink_ir_receiver/__init__.py`

- [ ] **Step 1: Add the RF capture WS command**

Add after `ws_remove_device`:

```python
@websocket_api.websocket_command(
    {
        vol.Required("type"): "broadlink_ir_receiver/start_rf_capture",
        vol.Required("entry_id"): str,
    }
)
@websocket_api.async_response
async def ws_start_rf_capture(hass, connection, msg):
    entry_id = msg["entry_id"]
    data = hass.data.get(DOMAIN, {}).get(entry_id)
    if not data or "listener" not in data:
        connection.send_error(msg["id"], "not_found", "Device not found")
        return

    dev_type = data.get("dev_type", 0)
    if dev_type not in RF_CAPABLE_DEVTYPES:
        connection.send_error(msg["id"], "not_supported", "Device does not support RF")
        return

    listener = data["listener"]
    if not listener._dev:
        connection.send_error(msg["id"], "not_connected", "Device not connected")
        return

    dev = listener._dev

    def _rf_capture():
        import time as _time

        dev.sweep_frequency()
        deadline = _time.monotonic() + 10
        while _time.monotonic() < deadline:
            _time.sleep(0.2)
            if dev.check_frequency():
                break
        else:
            return None, "Frequency scan timed out"

        dev.find_rf_packet()
        deadline = _time.monotonic() + 10
        while _time.monotonic() < deadline:
            _time.sleep(0.2)
            try:
                rf_data = dev.check_data()
                if rf_data:
                    return rf_data, None
            except Exception:
                continue
        return None, "RF packet capture timed out"

    try:
        rf_data, error = await hass.async_add_executor_job(_rf_capture)
    except Exception as exc:
        connection.send_error(msg["id"], "rf_error", str(exc))
        return

    if error:
        connection.send_error(msg["id"], "rf_timeout", error)
        return

    rf_hex = rf_data.hex() if rf_data else ""
    connection.send_result(msg["id"], {"rf_code": rf_hex[:16] or rf_hex, "raw_hex": rf_hex})
```

- [ ] **Step 2: Register the command**

In the `if "_panel_registered"` block, add:

```python
        websocket_api.async_register_command(hass, ws_start_rf_capture)
```

- [ ] **Step 3: Update _fire_event to tag RF protocol for Pro devices**

In `BroadlinkIRListener._fire_event`, change protocol detection. First, add `dev_type` to the listener constructor:

In `__init__` method of BroadlinkIRListener, add parameter:

```python
    def __init__(
        self, hass: HomeAssistant, host: str, name: str, entry_id: str, dev_type: int = 0
    ) -> None:
        self._hass = hass
        self._host = host
        self._name = name
        self._entry_id = entry_id
        self._dev_type = dev_type
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None
        self._dev = None
        self._enabled = True
```

Then in `_run`, after `nec = decode_nec(data)`, update protocol detection:

```python
                    nec = decode_nec(data)
                    if nec:
                        protocol = "NEC"
                    elif self._dev_type in RF_CAPABLE_DEVTYPES and (len(data) < 6 or data[0] != 0x26):
                        protocol = "RF"
                    else:
                        protocol = "Unknown"
                    code_key = nec or data[:8].hex()
```

Import `RF_CAPABLE_DEVTYPES` at the top of `__init__.py` (already done in Task 4 Step 1).

- [ ] **Step 4: Pass dev_type when creating listener in async_setup_entry**

```python
    listener = BroadlinkIRListener(hass, host, name, entry.entry_id, entry.data.get("dev_type", 0))
```

- [ ] **Step 5: Commit**

```
git add custom_components/broadlink_ir_receiver/__init__.py
git commit -m "feat: add RF capture WS command and RF protocol tagging"
```

---

### Task 7: Update panel.js — device top bar

**Files:**
- Modify: `custom_components/broadlink_ir_receiver/panel.js`

- [ ] **Step 1: Add RF_DEVTYPES constant and _activeDevice tracking**

Add at the top of the class after the existing constructor properties:

```javascript
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
    this._activeEntry = null;  // NEW: selected device entry_id
    this._logFilter = null;    // NEW: null = all, or entry_id
  }
```

Add as static:

```javascript
  static get RF_DEVTYPES() {
    return new Set([0x51DA,0x61A2,0x649B,0x653C,0x653A,0x6508,0x6539,0x648D,0x6184,0x6070,0x610E,0x610F,0x62BC,0x62BE,0x6364,0x6476]);
  }
```

- [ ] **Step 2: Add device top bar CSS**

Add to the style string (after the `.header` rules):

```css
      .topbar{display:flex;gap:10px;margin-bottom:18px;padding:12px 16px;background:var(--card-background-color,#1c2025);border:1px solid var(--divider-color,#313742);border-radius:12px;flex-wrap:wrap;align-items:center;max-width:1320px}
      .dev-chip{display:flex;align-items:center;gap:8px;background:var(--card-background-color,#232830);border:1px solid var(--divider-color,#313742);border-radius:8px;padding:10px 14px;cursor:pointer;min-width:180px;transition:.15s}
      .dev-chip:hover{border-color:var(--primary-color,#03a9f4)}
      .dev-chip.active{border-color:var(--primary-color,#03a9f4);box-shadow:0 0 0 1px var(--primary-color,#03a9f4)}
      .dev-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
      .dev-dot.on{background:#4caf50}
      .dev-dot.off{background:#f44336}
      .dev-name{font-size:13px;font-weight:500}
      .dev-meta{font-size:10px;color:var(--secondary-text-color,#9aa3ad)}
      .badge.ir{background:#1b5e20;color:#a5d6a7}
      .badge.rf{background:#1a237e;color:#9fa8da}
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
```

- [ ] **Step 3: Update _renderShell to add topbar div**

Replace the header + layout HTML in `_renderShell`:

```javascript
    this.shadowRoot.innerHTML = `<style>${S}</style>
      <div class="header"><h1>IR Remote &amp; Automation Wizard</h1></div>
      <div class="topbar" id="topbar"></div>
      <div class="layout">
        <div class="panel"><div class="remote-pick"><select id="remoteSel"></select><button class="iconbtn" id="newRemote" title="New remote">＋</button><button class="iconbtn danger" id="delRemote" title="Delete remote">🗑</button></div><h2 id="remoteTitle">Remote</h2><div class="remote"><div id="remoteGrid"></div><div class="cont"><div class="lbl"><span>Continuous control</span></div><div class="readout" id="cVal">30%</div><input type="range" id="cSlider" min="0" max="100" value="30"><div class="rocker"><button class="key" id="cMinus">– hold</button><button class="key" id="cPlus">+ hold</button></div><div class="presets"><button class="chip" data-p="20">20%</button><button class="chip" data-p="30">30%</button><button class="chip" data-p="50">50%</button></div><div class="note">Hold –/+ to ramp. UX for step-mode mappings.</div></div></div></div>
        <div><div class="controls" id="controls"></div><div class="panel" id="middle"></div></div>
        <div class="panel"><div class="log-hdr"><h2 style="margin:0">Live IR/RF Log</h2><div class="log-actions"><select id="logFilter" style="background:var(--card-background-color,#232830);color:var(--primary-text-color,#e4e7eb);border:1px solid var(--divider-color,#313742);border-radius:6px;padding:4px 8px;font-size:11px"><option value="">All devices</option></select><button class="sbtn ghost" id="clearLog">Clear</button></div></div><div class="log-scroll" id="log"></div></div>
      </div>
      <div id="toast"></div>`;
    this._bindShell();
```

- [ ] **Step 4: Add _renderTopbar method**

```javascript
  _renderTopbar() {
    const el = this._$("topbar");
    if (!el) return;
    const ids = Object.keys(this._entries);
    const isRF = dt => BroadlinkIRPanel.RF_DEVTYPES.has(dt);

    let html = ids.map(id => {
      const e = this._entries[id];
      const active = id === this._activeEntry;
      const typeBadge = isRF(e.dev_type)
        ? '<span class="badge rf" style="font-size:9px;padding:1px 5px">IR+RF</span>'
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
            <button data-toggle="${id}">${e.enabled ? "Turn off" : "Turn on"}</button>
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

    // bind chip clicks (select active device)
    el.querySelectorAll(".dev-chip").forEach(chip => {
      chip.addEventListener("click", (ev) => {
        if (ev.target.closest(".dev-menu")) return;
        this._activeEntry = chip.dataset.eid;
        this._renderAll();
      });
    });

    // bind kebab menus
    el.querySelectorAll(".dev-menu-btn").forEach(btn => {
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const drop = this._$("menu-" + btn.dataset.menu);
        if (drop) drop.classList.toggle("open");
      });
    });

    // bind toggle
    el.querySelectorAll("[data-toggle]").forEach(btn => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.toggle;
        const on = !(this._entries[id]?.enabled);
        this._toggleEntry(id, on);
      });
    });

    // bind remove
    el.querySelectorAll("[data-remove]").forEach(btn => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.remove;
        const name = this._entries[id]?.name || id;
        if (!confirm(`Remove device "${name}"? Its mappings will also be deleted.`)) return;
        this._removeDevice(id);
      });
    });

    // bind add device
    this._$("addDevBtn").addEventListener("click", () => {
      this._$("addDevBtn").style.display = "none";
      this._$("addDevForm").style.display = "flex";
      this._$("addDevHost").focus();
    });
    this._$("addDevCancel").addEventListener("click", () => {
      this._$("addDevForm").style.display = "none";
      this._$("addDevBtn").style.display = "flex";
    });
    this._$("addDevGo").addEventListener("click", () => this._addDevice());
  }
```

- [ ] **Step 5: Add _addDevice and _removeDevice methods**

```javascript
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
```

- [ ] **Step 6: Update _renderAll to include _renderTopbar, set default active entry**

```javascript
  _renderAll() {
    if (!this._activeEntry) {
      const ids = Object.keys(this._entries);
      this._activeEntry = ids[0] || null;
    }
    this._renderTopbar();
    this._renderSelector();
    this._renderControls();
    this._renderRemote();
    this._renderMiddle();
    this._renderLog(false);
    this._renderLogFilter();
  }
```

- [ ] **Step 7: Commit**

```
git add custom_components/broadlink_ir_receiver/panel.js
git commit -m "feat: add device top bar with add/remove/select to panel"
```

---

### Task 8: Update panel.js — per-device config scoping

**Files:**
- Modify: `custom_components/broadlink_ir_receiver/panel.js`

- [ ] **Step 1: Update _loadConfig to handle per-device structure**

```javascript
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
```

- [ ] **Step 2: Update _curRemote, _curMaps, _mappedBtn to be device-scoped**

```javascript
  _deviceConfig() {
    if (!this._activeEntry || !this._config.devices) return { remotes: [{ id: "r1", name: "Remote 1", mappings: [] }], sel: "r1" };
    return this._config.devices[this._activeEntry] || { remotes: [{ id: "r1", name: "Remote 1", mappings: [] }], sel: "r1" };
  }
  _curRemote() { const dc = this._deviceConfig(); return dc.remotes.find(r => r.id === dc.sel) || dc.remotes[0]; }
  _curMaps() { return this._curRemote().mappings; }
  _mappedBtn(id) { return this._curMaps().find(m => m.button === id); }
```

- [ ] **Step 3: Update _saveConfig to write full per-device structure**

No change needed — `_saveConfig` already sends the whole `this._config` object via `set_config`. The structure is now `{ version: 2, devices: { ... } }`.

- [ ] **Step 4: Update remote selector binding (newRemote, delRemote, remoteSel)**

In `_bindShell`, update the remote management to use `_deviceConfig()`:

```javascript
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
```

- [ ] **Step 5: Update _renderSelector to read from _deviceConfig()**

```javascript
  _renderSelector() {
    const sel = this._$("remoteSel");
    const dc = this._deviceConfig();
    sel.innerHTML = dc.remotes.map(r =>
      `<option value="${r.id}" ${r.id === dc.sel ? "selected" : ""}>${this._esc(r.name)} (${r.mappings.length})</option>`
    ).join("");
  }
```

- [ ] **Step 6: Update _saveMapping to write to device-scoped remote**

No change needed — `_saveMapping` calls `this._curRemote()` which already resolves via `_deviceConfig()`.

- [ ] **Step 7: Commit**

```
git add custom_components/broadlink_ir_receiver/panel.js
git commit -m "feat: scope panel remotes/mappings to active device"
```

---

### Task 9: Update panel.js — RF capture in wizard

**Files:**
- Modify: `custom_components/broadlink_ir_receiver/panel.js`

- [ ] **Step 1: Update _startCapture to filter by active device host**

```javascript
  async _startCapture() {
    this._wiz.capturing = true;
    this._wiz.ir_code = null;
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
```

- [ ] **Step 2: Add _startRfCapture method**

```javascript
  async _startRfCapture() {
    try {
      const r = await this._hass.connection.sendMessagePromise({
        type: "broadlink_ir_receiver/start_rf_capture",
        entry_id: this._activeEntry,
      });
      this._wiz.ir_code = r.rf_code || r.raw_hex?.substring(0, 16);
      this._wiz.capturing = false;
      this._renderWizard();
    } catch (e) {
      console.error("RF: capture failed", e);
      this._wiz.capturing = false;
      this._wiz.captureError = e.message || "RF capture failed";
      this._renderWizard();
    }
  }
```

- [ ] **Step 3: Update _stepCapture to show IR/RF mode toggle for Pro devices**

```javascript
  _stepCapture() {
    const w = this._wiz;
    const devType = this._entries[this._activeEntry]?.dev_type || 0;
    const isRF = BroadlinkIRPanel.RF_DEVTYPES.has(devType);
    const modeToggle = isRF ? `<div class="mode-tabs" style="margin-bottom:14px">
      <div class="mode-tab ${(w.captureMode||"ir") === "ir" ? "on" : ""}" data-cap="ir">IR</div>
      <div class="mode-tab ${w.captureMode === "rf" ? "on" : ""}" data-cap="rf">RF</div>
    </div>` : "";

    if (w.capturing) return `${modeToggle}<div class="capture-box"><div class="pulse">${w.captureMode === "rf" ? "📻" : "📡"}</div>
      <div style="font-size:16px">Now receiving ${w.captureMode === "rf" ? "RF" : "IR"}…</div>
      <div style="color:var(--secondary-text-color);font-size:13px;margin-top:6px">Press the <b>${this._esc(this._label(w.button))}</b> button on your physical remote</div>
      ${w.captureMode === "rf" ? '<div style="color:var(--secondary-text-color);font-size:11px;margin-top:8px">Hold the button for 2-3 seconds during frequency scan, then press again when prompted.</div>' : ""}</div>
      <div class="row-btns"><button class="btn ghost" id="wzCancel">Cancel</button></div>`;

    if (w.captureError) return `${modeToggle}<div class="capture-box"><div style="color:#f44336;font-size:16px">Capture failed</div>
      <div style="color:var(--secondary-text-color);font-size:13px;margin-top:6px">${this._esc(w.captureError)}</div></div>
      <div class="row-btns"><button class="btn ghost" id="wzCancel">Cancel</button><button class="btn primary" id="wzRetry">Retry</button></div>`;

    const proto = w.captureMode === "rf" ? "RF" : "NEC";
    return `${modeToggle}<div class="capture-box"><div style="color:var(--secondary-text-color);font-size:13px">Captured ${w.captureMode === "rf" ? "RF" : "IR"} code</div>
      <div class="code-result">${this._esc(w.ir_code)}</div><div style="color:var(--secondary-text-color);font-size:12px">protocol: ${proto}</div></div>
      <div class="row-btns"><button class="btn ghost" id="wzRetry">Retry</button><button class="btn primary" id="wzNext">Next →</button></div>`;
  }
```

- [ ] **Step 4: Bind IR/RF mode tabs in _bindWizard step 1**

In `_bindWizard`, inside the `if (w.step === 1)` block, add:

```javascript
      this.shadowRoot.querySelectorAll("[data-cap]").forEach(t => t.addEventListener("click", () => {
        w.captureMode = t.dataset.cap;
        w.captureError = null;
        this._cancelCapture();
        this._startCapture();
      }));
```

- [ ] **Step 5: Commit**

```
git add custom_components/broadlink_ir_receiver/panel.js
git commit -m "feat: add RF capture mode in wizard for RM4 Pro devices"
```

---

### Task 10: Update panel.js — device-tagged log with filter

**Files:**
- Modify: `custom_components/broadlink_ir_receiver/panel.js`

- [ ] **Step 1: Add _renderLogFilter method**

```javascript
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
```

- [ ] **Step 2: Update _renderLog to show device name and apply filter**

```javascript
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
```

- [ ] **Step 3: Update _flashMatch to check all devices' mappings for the active one**

No change needed — `_flashMatch` already checks `_curMaps()` which is scoped to the active device.

- [ ] **Step 4: Commit**

```
git add custom_components/broadlink_ir_receiver/panel.js
git commit -m "feat: add device name and filter to live log"
```

---

### Task 11: Remove old controls bar, bump version, final commit

**Files:**
- Modify: `custom_components/broadlink_ir_receiver/panel.js`
- Modify: `custom_components/broadlink_ir_receiver/manifest.json`

- [ ] **Step 1: Remove _renderControls — toggles are now in device top bar**

Delete the `_renderControls` method entirely. Remove the `<div class="controls" id="controls"></div>` from the shell HTML. Remove `this._renderControls()` from `_renderAll()`.

Replace with a simpler notifications-only control if desired, or remove entirely since toggle is on the device chip menu.

Replace the `_renderAll` call's `_renderControls` with nothing:

```javascript
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
```

Update shell HTML to remove the controls div — change the middle column from:
```html
<div><div class="controls" id="controls"></div><div class="panel" id="middle"></div></div>
```
to:
```html
<div><div class="panel" id="middle"></div></div>
```

- [ ] **Step 2: Bump manifest.json version**

```json
  "version": "2.3.0"
```

- [ ] **Step 3: Commit all changes**

```
git add -A
git commit -m "feat: multi-device management + RF support (v2.3.0)

- Device top bar: add/remove/select devices inline
- Per-device mappings scoped by entry_id
- RF capture in wizard for RM4 Pro devices
- Device-tagged log with filter
- WS commands: add_device, remove_device, start_rf_capture
- Mappings store v1→v2 migration
- Protocol tagging: NEC/RF/Unknown"
```

- [ ] **Step 4: Push to GitHub**

```
git push origin master
```

---

### Task 12: Deploy and verify on HA

**Files:** None (operational)

- [ ] **Step 1: User redownloads via HACS**

User goes to HACS → BroadLink IR Receiver → Redownload.

- [ ] **Step 2: Restart HA via API**

```powershell
$token = (Get-Content "C:\Oreka\ha-broadlink-ir-receiver\.env" | Where-Object { $_ -match "HA_TOKEN=" }) -replace "HA_TOKEN=", ""
Invoke-RestMethod -Uri "http://homeassistant.local:8123/api/services/homeassistant/restart" -Method POST -Headers @{ Authorization = "Bearer $token" } -ContentType "application/json" -Body "{}"
```

- [ ] **Step 3: Verify panel loads with device top bar**

Navigate to `http://homeassistant.local:8123/broadlink-ir-receiver`. Confirm:
- Existing RM4 Mini device appears in top bar with IR badge
- Remote mappings from v2.2.0 migrated under that device
- Log shows device name per entry
- Wizard still works for IR capture

- [ ] **Step 4: Verify add device (when second device available)**

Click "+ Add Device" → enter IP of second BroadLink device → click Add. Confirm:
- New device appears in top bar
- Click new device chip → remote panel switches to empty (no mappings yet)
- Can create new mappings on second device

- [ ] **Step 5: Verify RF capture (when RM4 Pro available)**

Select RM4 Pro device → click remote button → wizard shows IR/RF toggle → select RF → presses physical RF remote button → code captured.
