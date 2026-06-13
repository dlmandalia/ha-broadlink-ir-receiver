# BroadLink IR Receiver for Home Assistant

Turn your **BroadLink RM4 Mini** (or any RM-series device) into a passive IR receiver for Home Assistant. Use **any IR remote** to trigger automations — no BroadLink cloud, no app required.

## How It Works

```
IR Remote → BroadLink RM4 Mini → This Integration → HA Event → Your Automation
```

The integration continuously listens for IR signals using BroadLink's learning mode. When it receives a signal, it decodes the NEC protocol and fires a `broadlink_ir_command` event with the decoded button code. You create automations that trigger on specific codes.

## Requirements

- BroadLink RM4 Mini (or RM Mini 3, RM Pro, etc.) on your local network
- Home Assistant 2024.1 or later
- HACS (recommended) or manual installation

## Installation

### HACS (Recommended)

1. Open HACS in Home Assistant
2. Click the three dots menu → **Custom repositories**
3. Add `https://github.com/dlmandalia/ha-broadlink-ir-receiver` with category **Integration**
4. Search for "BroadLink IR Receiver" and install
5. Restart Home Assistant

### Manual Installation

1. Download the `custom_components/broadlink_ir_receiver` folder from this repository
2. Copy it to your Home Assistant `config/custom_components/` directory
3. Restart Home Assistant

## Configuration

1. Go to **Settings → Devices & Services → Add Integration**
2. Search for **BroadLink IR Receiver**
3. Enter your BroadLink device's IP address
4. Done! The integration starts listening immediately

## Finding Button Codes

After setup, press any button on your IR remote. The integration fires a `broadlink_ir_command` event. To see the codes:

1. Go to **Developer Tools → Events → Listen to events**
2. Enter `broadlink_ir_command` and click **Start listening**
3. Press buttons on your remote — you'll see events like:

```json
{
  "event_type": "broadlink_ir_command",
  "data": {
    "nec_code": "00FF807F",
    "device": "BroadLink IR Receiver",
    "host": "10.0.3.41"
  }
}
```

4. Note down the `nec_code` for each button you want to use

## Creating Automations

### Example: Toggle a light with a remote button

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

### Example: Control TV volume

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

  - alias: "IR Remote - Volume Down"
    trigger:
      - platform: event
        event_type: broadlink_ir_command
        event_data:
          nec_code: "00FFC03F"
    action:
      - service: media_player.volume_down
        target:
          entity_id: media_player.living_room_tv
```

### Example: Scene activation with multiple buttons

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

You can add multiple BroadLink devices — each one becomes an independent IR receiver. Events include the `device` name and `host` IP so you can distinguish which device received the signal.

## NEC Protocol

This integration decodes **NEC infrared protocol**, which is used by the vast majority of IR remotes (TV remotes, fan remotes, light remotes, AC remotes, etc.). The 8-character hex code (e.g., `00FF807F`) uniquely identifies each button on a remote.

The code format is: `AACCBBDD` where:
- `AA` = device address
- `CC` = inverted device address  
- `BB` = command
- `DD` = inverted command

## Troubleshooting

**Device not found**: Ensure the BroadLink device is on the same network and the IP is correct. Try pinging the IP.

**No events firing**: Check the Home Assistant logs for errors. The integration logs connection status at startup.

**Inconsistent codes**: Some non-NEC remotes may not work. The integration only decodes NEC protocol frames.

**Events firing but automation not triggering**: Make sure the `nec_code` in your automation exactly matches (case-sensitive, 8 characters).

## License

MIT License — use it however you want.
