# Multi-Device Management + RF Support — Design Spec

**Date:** 2026-06-15
**Status:** Approved
**Version:** v2.3.0
**Scope:** Panel-driven multi-device management, per-device mappings, RF learning for RM4 Pro

## Goal

Manage multiple BroadLink devices (RM4 Mini IR-only, RM4 Pro IR+RF) from a single panel page. Add/remove devices without leaving the page. Each device has its own remotes and mappings. Log shows which device received each signal.

## Panel Layout

### Top Bar — Device Management

Horizontal row of device cards above the 3-column layout. Each card shows:
- Device name (editable)
- IP address
- Type badge: **IR** (RM4 Mini) or **IR+RF** (RM4 Pro)
- Status dot (green = listening, red = off)
- Receiver toggle (on/off)
- Notifications toggle (on/off)
- Active highlight when selected

**`+ Add Device`** button at end of row. Opens inline form:
- IP address field
- Name field (defaults to "BroadLink {ip}")
- Discover + Add button
- Creates config entry via new `add_device` WS command
- On success: device appears in top bar, auto-selected as active
- On error: inline error message (device not found, already configured, auth failed)

**Remove device**: kebab menu (⋮) on each device card → "Remove device" with confirmation dialog. Calls `remove_device` WS command → removes config entry.

### 3-Column Layout (unchanged structure, now device-scoped)

**Left — Remote**
- Remote selector dropdown scoped to active device
- Add/delete remote per device
- Button mappings scoped to active device's remotes
- Same TV-style button layout (power, numpad, dpad, vol, ch)
- Continuous control widget (unchanged)

**Middle — Wizard + Mappings**
- Mappings table shows active device's mappings only
- Wizard capture step:
  - IR devices: subscribes to `broadlink_ir_command` events, filters by active device's `host`
  - IR+RF devices: shows IR/RF mode toggle before capture. IR mode = same as before. RF mode = calls `start_rf_capture` WS command (sweep → check → find flow)
- Action step: unchanged (service call / set level / step level)
- Save step: mapping stored under active device's entry in the store

**Right — Live IR/RF Log**
- Shows events from ALL devices by default
- Each log entry shows device name + type badge (IR/RF)
- Filter dropdown: "All devices" / per-device names
- Flash animation only on active device's remote buttons

## Backend Changes

### 1. Mappings Store — Per-Device Structure

Old (v2.2.0):
```json
{
  "remotes": [{ "id": "r1", "name": "Remote 1", "mappings": [...] }],
  "sel": "r1"
}
```

New (v2.3.0):
```json
{
  "version": 2,
  "devices": {
    "<entry_id>": {
      "remotes": [{ "id": "r1", "name": "Living Room TV", "mappings": [...] }],
      "sel": "r1"
    }
  }
}
```

**Migration:** On load, if `version` key missing and `remotes` key present, wrap existing data under first config entry's `entry_id`. Set `version: 2`.

### 2. Executor — Per-Device Matching

Current: matches `ir_code` across all remotes, ignores device.

New: on `broadlink_ir_command` event, read `host` from event data → find matching config entry by host → search only that entry's mappings. If match found, call `hass.services.async_call()`.

### 3. New WS Commands

**`broadlink_ir_receiver/add_device`**
- Input: `{ host: string, name?: string }`
- Runs `broadlink.discover(timeout=5, discover_ip_address=host)` + `dev.auth()`
- Checks not already configured (duplicate host)
- Creates config entry via `hass.config_entries.flow.async_init(DOMAIN, context={"source": "ws"}, data={host, name, dev_type, mac})`
- Returns: `{ success: true, entry_id: "..." }` or error

**`broadlink_ir_receiver/remove_device`**
- Input: `{ entry_id: string }`
- Calls `hass.config_entries.async_remove(entry_id)`
- Returns: `{ success: true }` or error

**`broadlink_ir_receiver/start_rf_capture`**
- Input: `{ entry_id: string }`
- Requires RM4 Pro device type
- Flow:
  1. Call `dev.sweep_frequency()` — device starts scanning for RF
  2. Poll `dev.check_frequency()` every 200ms until frequency found or timeout (10s)
  3. Call `dev.find_rf_packet()` — device captures the RF packet
  4. Poll `dev.check_data()` every 200ms until data received or timeout (10s)
  5. Decode and return RF code
- Returns: `{ rf_code: "hex string", frequency: float }` or error/timeout

**`broadlink_ir_receiver/get_config`** — updated
- Returns per-device structure (migrated if needed)

**`broadlink_ir_receiver/set_config`** — updated
- Accepts per-device structure

### 4. Device Type Detection

Expose `dev_type` in `ws_get_state` response per entry. Panel uses it to show IR vs IR+RF badge and enable/disable RF capture in wizard.

RM4 Pro devtypes (support RF): `0x51da`, `0x61a2`, `0x649b`, `0x653c`

RM4 Mini devtypes (IR only): `0x51e7`, `0x520c`, `0x5216`, `0x5218`

Store these in `const.py` as `RF_CAPABLE_DEVTYPES` set.

### 5. Config Flow — Add `ws` Source

New `async_step_ws` in config_flow.py. Called by `add_device` WS command. Takes pre-validated data (host, name, dev_type, mac), creates entry directly. Skips UI form since panel already collected input.

### 6. Listener — RF Protocol Tagging

Current listener tags signals as "NEC" or "Unknown". Add heuristic: if device is RM4 Pro and data doesn't start with `0x26` (IR marker), tag as "RF" protocol. Event data gains `rf_code` field alongside existing `nec_code` / `raw_hex`.

## Data Model — Mapping (unchanged)

```json
{
  "id": "m1718...",
  "button": "power",
  "ir_code": "00FF807F",
  "mode": "service",
  "service": "light.toggle",
  "target": "light.living_room",
  "value": 30,
  "stepPct": 10,
  "data": "",
  "name": "IR power"
}
```

RF mappings use the same structure — `ir_code` field holds the RF hex code. Field name is a misnomer but avoids breaking changes. (Could rename to `code` in v3.)

## What Stays The Same

- Switch entities (receiver/notifications) — already per-config-entry
- Sensor entity — already per-config-entry
- Event structure — already includes `host` and `device` fields
- Remote button layout (power, numpad, dpad, vol, ch)
- Wizard 3-step flow (capture → action → save)
- Continuous control widget
- HACS deployment (tracks master, no releases)

## Out of Scope (future)

- Custom button layouts per remote (always TV-style for now)
- RF frequency display in log
- Device auto-discovery (scan network for all BroadLink devices)
- Rename device from panel (use HA Settings for now)
