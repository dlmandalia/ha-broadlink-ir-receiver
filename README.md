# BroadLink IR Receiver for Home Assistant

Turn your **BroadLink RM4 Mini** (or any RM-series device) into a passive IR receiver for Home Assistant. Use **any IR remote** to trigger automations — no BroadLink cloud, no app required.

## Features

- **Dedicated IR Receiver Panel** — sidebar page showing live received codes in real-time
- **Toggle ON/OFF** — enable or disable the IR listener from the panel or via a switch entity
- **Multi-protocol display** — NEC decoded hex codes + raw data for unknown protocols
- **Copy codes** — one-click copy of received codes for use in automations
- **Sensor entity** — shows the last received IR code with protocol attributes
- **Event-driven** — fires `broadlink_ir_command` events for automation triggers
- **HACS compatible** — easy install and updates

## How It Works

```
IR Remote --> BroadLink RM4 Mini --> This Integration --> HA Event --> Your Automation
                                         |
                                    IR Receiver Panel (live view)
```

The integration continuously listens for IR signals using BroadLink's learning mode. When it receives a signal, it decodes the NEC protocol (or captures raw data for other protocols) and:
1. Fires a `broadlink_ir_command` event
2. Updates the Last IR Code sensor entity
3. Displays the code live in the IR Receiver panel

## Requirements

- BroadLink RM4 Mini (or RM Mini 3, RM Pro, etc.) on your local network
- Home Assistant 2024.1 or later
- HACS (recommended) or manual installation

## Installation

### HACS (Recommended)

1. Open **HACS** in Home Assistant
2. Click the three dots menu (**...**) in the top right corner
3. Select **Custom repositories**
4. Paste the repository URL:
   ```
   https://github.com/dlmandalia/ha-broadlink-ir-receiver
   ```
5. Set category to **Integration** and click **Add**
6. Go back to HACS, search for **BroadLink IR Receiver**
7. Click **Download** and confirm
8. **Restart Home Assistant**

### Manual Installation

1. Download this repository (Code -> Download ZIP, or clone it):
   ```bash
   git clone https://github.com/dlmandalia/ha-broadlink-ir-receiver.git
   ```
2. Copy the `custom_components/broadlink_ir_receiver` folder to your Home Assistant `config/custom_components/` directory:
   ```
   config/
     custom_components/
       broadlink_ir_receiver/
         __init__.py
         config_flow.py
         const.py
         manifest.json
         panel.js
         sensor.py
         switch.py
         strings.json
         translations/
           en.json
   ```
3. **Restart Home Assistant**

## Setup

1. Go to **Settings -> Devices & Services -> Add Integration**
2. Search for **BroadLink IR Receiver**
3. Enter your BroadLink device's **IP address** and a friendly name
4. Click **Submit** — the integration starts listening immediately
5. The **IR Receiver** panel appears in the sidebar

## Using the IR Receiver Panel

After setup, click **IR Receiver** in the sidebar. You'll see:

- **Device card** — shows your BroadLink device with IP, status (listening/off), and an ON/OFF toggle button
- **Received Codes list** — live-updating table with:
  - **Time** — when the code was received
  - **Protocol** — NEC (green badge), Unknown (orange badge), or RF (blue badge, future)
  - **Code** — the decoded hex value (NEC) or raw data prefix
  - **Copy button** — copies the code to your clipboard

Press any button on your IR remote and the code appears instantly in the panel.

## Entities Created

| Entity | Type | Description |
|--------|------|-------------|
| `switch.broadlink_ir_receiver_receiver` | Switch | Toggle the IR listener on/off |
| `sensor.broadlink_ir_receiver_last_ir_code` | Sensor | Shows the last received IR code with protocol attributes |

## Finding Button Codes

The easiest way is to use the **IR Receiver panel**:

1. Click **IR Receiver** in the sidebar
2. Make sure the receiver is **ON** (toggle button should be cyan/blue)
3. Point your remote at the BroadLink device and press buttons
4. Codes appear in the list — click **Copy** to copy the code

Alternatively, use **Developer Tools -> Events -> Listen to events**, enter `broadlink_ir_command`, and press remote buttons to see:

```json
{
  "event_type": "broadlink_ir_command",
  "data": {
    "nec_code": "00FF807F",
    "raw_hex": "2600a80094...",
    "protocol": "NEC",
    "device": "BroadLink IR Receiver",
    "host": "10.0.3.41",
    "timestamp": 1718359200.123
  }
}
```

## Creating Automations

### Toggle a light with a remote button

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

### Control TV volume

```yaml
automation:
  - alias: "IR Remote - Volume Up"
    trigger:
      - platform: event
        event_type: broadlink_ir_command
        event_data:
          nec_code: "00FF40BF"
    action:
      - service: media_player.volume_up
        target:
          entity_id: media_player.living_room_tv
```

### Scene activation

```yaml
automation:
  - alias: "IR Remote - Movie Mode"
    trigger:
      - platform: event
        event_type: broadlink_ir_command
        event_data:
          nec_code: "00FF20DF"
    action:
      - service: scene.turn_on
        target:
          entity_id: scene.movie_mode
```

## Multiple Devices

You can add multiple BroadLink devices — each one becomes an independent IR receiver. Events include the `device` name and `host` IP so you can filter by device in automations:

```yaml
trigger:
  - platform: event
    event_type: broadlink_ir_command
    event_data:
      nec_code: "00FF807F"
      host: "10.0.3.41"
```

## NEC Protocol

This integration decodes **NEC infrared protocol**, used by the vast majority of IR remotes (TV, fan, light, AC, etc.). The 8-character hex code (e.g., `00FF807F`) uniquely identifies each button.

Code format: `AACCBBDD`
- `AA` = device address
- `CC` = inverted device address
- `BB` = command
- `DD` = inverted command

Non-NEC remotes are also captured — the raw hex data is displayed and can be used in automations via the `raw_hex` field.

## Troubleshooting

| Problem | Solution |
|---------|----------|
| **Device not found** | Ensure the BroadLink device is on the same network and the IP is correct. Try pinging the IP. |
| **No codes appearing** | Check HA logs (**Settings -> System -> Logs**). Make sure the receiver is toggled ON. |
| **"Failed to set up"** | Check that `broadlink>=0.18.0` is installed. Restart HA after installation. |
| **Codes appear but automation doesn't trigger** | Ensure the `nec_code` matches exactly (case-sensitive, 8 characters). |
| **Panel not in sidebar** | Restart HA. The panel registers on first setup. |

## Supported Devices

Any BroadLink device that supports learning mode:
- RM4 Mini (tested)
- RM4 Pro
- RM Mini 3
- RM Pro
- RM Pro+

## License

MIT License
