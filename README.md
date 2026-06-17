# BroadLink IR/RF Receiver for Home Assistant

Turn your **BroadLink RM4 Mini** or **RM4 Pro** into a passive IR and RF receiver for Home Assistant. Use **any remote** to trigger automations — no BroadLink cloud, no app required.

[![HACS](https://img.shields.io/badge/HACS-Custom-orange.svg)](https://github.com/hacs/integration)
![Version](https://img.shields.io/badge/version-2.7.0-blue)

## Features

- **3-Column Automation Wizard** — visual remote layout, action builder, and live log side by side
- **IR + RF Support** — IR for all devices, RF for RM4 Pro with guided 2-phase capture
- **Multi-Device Management** — add/remove BroadLink devices from the panel, each with independent listeners
- **Per-Remote Type** — create IR or RF remotes, each with their own button mappings
- **Listen Mode Selector** — switch between IR only, RF only, or both (per device)
- **Button Mapping** — map any remote button to HA service calls (lights, switches, scenes, media players, etc.)
- **Live Code Log** — real-time display of received IR/RF codes with protocol badges and copy button
- **NEC Protocol Decoding** — automatic decode of NEC hex codes, raw capture for other protocols
- **Event-Driven** — fires `broadlink_ir_command` events for direct automation triggers
- **Sensor + Switch Entities** — toggle listener and notifications from HA UI or automations
- **HACS Compatible** — easy install and updates

## How It Works

```
IR/RF Remote --> BroadLink RM4 --> This Integration --> HA Event --> Your Automation
                                        |
                              Panel: Remote Wizard + Live Log
```

The integration continuously listens for IR signals (and RF on RM4 Pro). When a signal is received:
1. Fires a `broadlink_ir_command` event with code, protocol, device, and host
2. Updates the Last IR Code sensor entity
3. Displays the code live in the panel log
4. Executes any mapped button actions automatically

## Requirements

- BroadLink RM4 Mini, RM4 Pro, RM Mini 3, or any RM-series device
- Home Assistant 2024.1 or later
- HACS (recommended) or manual installation

## Installation

### HACS (Recommended)

1. Open **HACS** in Home Assistant
2. Click **...** (top right) → **Custom repositories**
3. Paste: `https://github.com/dlmandalia/ha-broadlink-ir-receiver`
4. Set category to **Integration** → **Add**
5. Search for **BroadLink IR Receiver** → **Download**
6. **Restart Home Assistant**

### Manual

1. Clone or download this repository
2. Copy `custom_components/broadlink_ir_receiver` to your HA `config/custom_components/` directory
3. **Restart Home Assistant**

## Setup

1. **Settings → Devices & Services → Add Integration**
2. Search **BroadLink IR Receiver**
3. Enter device IP address and friendly name
4. Click **Submit** — listener starts immediately
5. **IR Receiver** panel appears in sidebar

## Panel Overview

The panel has a **3-column layout**:

### Left: Remote Control
- **Remote selector** — switch between remotes, each tagged `[IR]` or `[RF]`
- **Visual remote layout** — buttons matching a standard remote (power, numpad, d-pad, volume, channel)
- **Button status dots** — green = mapped, empty = unmapped
- Click any button to start the learn wizard

### Middle: Automation Wizard
A 3-step wizard for mapping buttons:

**Step 1 — Capture Code**
- **IR remotes**: press the button on your physical remote, code captured instantly via event listener
- **RF remotes**: guided 2-phase flow:
  1. *"Hold down button for 3-5 seconds"* — device scans for RF frequency
  2. *"Frequency found! Short-press button once"* — captures the RF packet

**Step 2 — Configure Action**
- Pick a HA entity and service (toggle, turn on/off, set level, etc.)
- Supports service call mode (simple) and step mode (for dimmers/volume)

**Step 3 — Save**
- Name the mapping and save — button dot turns green

### Right: Live Log
- Real-time feed of received IR/RF codes
- Protocol badges: NEC (green), Unknown (orange)
- One-click copy codes to clipboard
- Filter by device when multiple devices active

## Multi-Device Management

The **top bar** shows device cards for each BroadLink device:

- **Add/remove devices** directly from the panel (no need to go to Settings)
- **Per-device toggle** — enable/disable listener independently
- **Listen mode selector** (RM4 Pro only) — choose IR only / RF only / IR + RF
- **Device type badges** — IR for RM4 Mini, IR+RF for RM4 Pro

### Adding a New Device
Click **+ Add Device** in the top bar, enter IP address and optional name.

### Listen Modes (RM4 Pro)
The RM4 Pro supports 3 listen modes:
| Mode | Description |
|------|-------------|
| **IR only** | Standard IR learning (default) |
| **RF only** | Continuous RF frequency sweep |
| **IR + RF** | Both active (hardware alternates) |

> **Note:** BroadLink hardware can only do one mode at a time. "IR + RF" alternates between modes, catching both signal types.

## Remote Types

When creating a new remote on an RF-capable device (RM4 Pro), you choose:

| Type | Capture Method | Use For |
|------|---------------|---------|
| **IR** | Event-based instant capture | TV remotes, AC remotes, fan remotes |
| **RF** | 2-phase guided capture (sweep → packet) | RF gate openers, RF switches, RF fans |

The wizard automatically uses the correct capture flow based on remote type.

## Entities Created

| Entity | Type | Description |
|--------|------|-------------|
| `switch.broadlink_ir_receiver_receiver` | Switch | Toggle the IR/RF listener on/off |
| `switch.broadlink_ir_receiver_notifications` | Switch | Persistent notification per received code |
| `sensor.broadlink_ir_receiver_last_ir_code` | Sensor | Last received code with protocol attributes |

## Creating Automations

### Via the Panel Wizard (Recommended)

1. Select your remote in the left column
2. Click a button → wizard starts → code captured automatically
3. Pick entity + service → save
4. Done — button now triggers the action when pressed

### Via YAML (Manual)

```yaml
automation:
  - alias: "IR Remote - Toggle Ceiling Light"
    trigger:
      - platform: event
        event_type: broadlink_ir_command
        event_data:
          nec_code: "00FF807F"
    action:
      - service: light.toggle
        target:
          entity_id: light.ceiling_light
```

### Filter by Device

```yaml
trigger:
  - platform: event
    event_type: broadlink_ir_command
    event_data:
      nec_code: "00FF807F"
      host: "10.0.3.41"
```

## NEC Protocol

This integration decodes **NEC infrared protocol**, used by most IR remotes. The 8-character hex code (e.g., `00FF807F`) uniquely identifies each button.

Format: `AACCBBDD` — AA = device address, CC = inverted address, BB = command, DD = inverted command.

Non-NEC remotes are also captured via raw hex data.

## Supported Devices

| Device | IR | RF | Tested |
|--------|----|----|--------|
| RM4 Mini | Yes | No | Yes |
| RM4 Pro | Yes | Yes | Yes |
| RM Mini 3 | Yes | No | — |
| RM Pro | Yes | Yes | — |
| RM Pro+ | Yes | Yes | — |

## Troubleshooting

| Problem | Solution |
|---------|----------|
| **Device not found** | Check IP, ensure same network, try pinging |
| **No codes appearing** | Check HA logs, ensure receiver toggle is ON |
| **RF not working** | Ensure RM4 Pro, set listen mode to RF or Both |
| **RF capture times out** | Hold button longer during Phase 1 (frequency sweep) |
| **Panel shows old version** | HACS redownload → HA restart → hard refresh browser (Ctrl+Shift+R) |
| **Panel not in sidebar** | Restart HA — panel registers on first setup |

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for version history.

## License

MIT License
