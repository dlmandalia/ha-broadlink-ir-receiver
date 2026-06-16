# BroadLink IR Receiver — AI Agent Guide

This document enables AI agents to create, edit, and manage IR/RF automations for the BroadLink IR Receiver Home Assistant integration via the WebSocket API. No panel UI needed — everything works through chat.

## Quick Start

To create an automation, the agent needs to:
1. Connect to HA WebSocket at `ws://<ha_host>:8123/api/websocket`
2. Authenticate with a long-lived access token
3. Read current config via `broadlink_ir_receiver/get_config`
4. Modify the config (add/edit/remove mappings)
5. Save via `broadlink_ir_receiver/set_config`

## Authentication

```json
{"type": "auth", "access_token": "<LONG_LIVED_TOKEN>"}
```

The token is stored in the `.env` file (gitignored) as `HA_TOKEN`.

## WebSocket Commands

### Get device state

```json
{"id": 1, "type": "broadlink_ir_receiver/get_state"}
```

Returns all configured BroadLink devices with their entry_id, host, name, enabled status, dev_type, and recent IR codes.

**Response:**
```json
{
  "entries": {
    "<entry_id>": {
      "enabled": true,
      "host": "10.0.3.41",
      "name": "BroadLink IR RM4 mini",
      "dev_type": 21004,
      "codes": [
        {"nec_code": "00FF10EF", "raw_hex": "...", "protocol": "NEC", "device": "...", "host": "...", "timestamp": 1718...}
      ]
    }
  }
}
```

### Get mappings config

```json
{"id": 2, "type": "broadlink_ir_receiver/get_config"}
```

**Response (v2 format):**
```json
{
  "version": 2,
  "devices": {
    "<entry_id>": {
      "remotes": [
        {
          "id": "r1",
          "name": "Remote 1",
          "mappings": [
            {
              "id": "m1718000000000",
              "button": "1",
              "ir_code": "00FF10EF",
              "name": "Evening Mode",
              "actions": [
                {
                  "service": "light.turn_off",
                  "target": "light.bedroom",
                  "mode": "service",
                  "value": 30,
                  "stepPct": 10,
                  "stepDir": 1,
                  "data": ""
                },
                {
                  "service": "fan.turn_on",
                  "target": "fan.bedroom_fan",
                  "mode": "service",
                  "value": 30,
                  "stepPct": 10,
                  "stepDir": 1,
                  "data": ""
                }
              ]
            }
          ]
        }
      ],
      "sel": "r1"
    }
  }
}
```

### Save mappings config

```json
{"id": 3, "type": "broadlink_ir_receiver/set_config", "config": { ... full config object ... }}
```

**Important:** Always send the FULL config object. Read it first, modify, then save back.

### Toggle receiver on/off

```json
{"id": 4, "type": "broadlink_ir_receiver/toggle", "entry_id": "<entry_id>", "enabled": true}
```

### Clear code history

```json
{"id": 5, "type": "broadlink_ir_receiver/clear_codes"}
```

### Add a new BroadLink device

```json
{"id": 6, "type": "broadlink_ir_receiver/add_device", "host": "10.0.3.42", "name": "Living Room RM4"}
```

### Remove a device

```json
{"id": 7, "type": "broadlink_ir_receiver/remove_device", "entry_id": "<entry_id>"}
```

### Start RF capture (RM4 Pro only)

```json
{"id": 8, "type": "broadlink_ir_receiver/start_rf_capture", "entry_id": "<entry_id>"}
```

## Mapping Data Format

### Single-action mapping (legacy, still supported by executor)

```json
{
  "id": "m<timestamp>",
  "button": "power",
  "ir_code": "00FF10EF",
  "name": "TV Power",
  "service": "media_player.toggle",
  "target": "media_player.tv",
  "mode": "service",
  "value": 30,
  "stepPct": 10,
  "stepDir": 1,
  "data": ""
}
```

### Multi-action mapping (v2.4.0+, preferred)

```json
{
  "id": "m<timestamp>",
  "button": "1",
  "ir_code": "00FF10EF",
  "name": "Evening Mode",
  "actions": [
    {
      "service": "light.turn_off",
      "target": "light.bedroom",
      "mode": "service",
      "data": ""
    },
    {
      "service": "fan.turn_on",
      "target": "fan.bedroom_fan",
      "mode": "service",
      "data": ""
    },
    {
      "service": "cover.set_cover_position",
      "target": "cover.krishna_s_room_curtain",
      "mode": "level",
      "value": 50
    }
  ]
}
```

## Action Modes

### `service` — Direct service call

Calls any HA service with optional JSON data.

```json
{
  "service": "light.turn_on",
  "target": "light.bedroom",
  "mode": "service",
  "data": "{\"brightness_pct\": 80, \"color_temp\": 300}"
}
```

The `data` field is a JSON string that gets parsed and merged into the service call data.

### `level` — Set absolute value

For lights: sets `brightness_pct`. For covers: sets `position`.

```json
{
  "service": "cover.set_cover_position",
  "target": "cover.krishna_s_room_curtain",
  "mode": "level",
  "value": 50
}
```

```json
{
  "service": "light.turn_on",
  "target": "light.bedroom",
  "mode": "level",
  "value": 80
}
```

### `step` — Incremental per-press

For lights: uses HA's `brightness_step_pct`. For covers: reads current position and calculates new position.

```json
{
  "service": "cover.set_cover_position",
  "target": "cover.krishna_s_room_curtain",
  "mode": "step",
  "stepPct": 10,
  "stepDir": 1
}
```

- `stepPct`: percentage per press (5-50)
- `stepDir`: `1` = open/increase, `-1` = close/decrease (covers only)

## Button IDs

The panel remote layout has these button IDs:

| Button | ID |
|--------|----|
| Power | `power` |
| Mute | `mute` |
| 0-9 | `0` through `9` |
| Back | `back` |
| Home | `home` |
| D-pad | `up`, `down`, `left`, `right`, `ok` |
| Volume | `vol_up`, `vol_down` |
| Channel | `ch_up`, `ch_down` |

A mapping's `button` field must be one of these IDs.

## IR Code Format

IR codes are 8-character hex strings representing NEC-decoded values (e.g., `00FF10EF`). To capture a code:

1. Point remote at BroadLink device
2. Press button
3. Code appears in the device's `codes` array (via `get_state`)

Or use the panel wizard for interactive capture.

## Helper: Get available entities

Use HA's `get_states` command to list all entities:

```json
{"id": 10, "type": "get_states"}
```

Returns array of state objects with `entity_id`, `state`, and `attributes.friendly_name`.

## Helper: Get available services

```json
{"id": 11, "type": "get_services"}
```

Returns all registered services grouped by domain.

## Common Automation Recipes

### Map IR button to toggle a light

```json
{
  "id": "m1718000000001",
  "button": "power",
  "ir_code": "00FF10EF",
  "name": "Bedroom Light Toggle",
  "actions": [
    {"service": "light.toggle", "target": "light.bedroom", "mode": "service", "data": ""}
  ]
}
```

### Map IR button to scene (multiple devices)

```json
{
  "id": "m1718000000002",
  "button": "1",
  "ir_code": "00FF30CF",
  "name": "Movie Night",
  "actions": [
    {"service": "light.turn_off", "target": "light.living_room", "mode": "service", "data": ""},
    {"service": "light.turn_on", "target": "light.tv_backlight", "mode": "service", "data": "{\"brightness_pct\": 20}"},
    {"service": "cover.close_cover", "target": "cover.living_room_curtain", "mode": "service", "data": ""},
    {"service": "media_player.turn_on", "target": "media_player.tv", "mode": "service", "data": ""}
  ]
}
```

### Map volume buttons to light dimming

```json
{
  "id": "m1718000000003",
  "button": "vol_up",
  "ir_code": "00FF40BF",
  "name": "Brighten",
  "actions": [
    {"service": "light.turn_on", "target": "light.bedroom", "mode": "step", "stepPct": 10, "data": ""}
  ]
}
```

```json
{
  "id": "m1718000000004",
  "button": "vol_down",
  "ir_code": "00FFC03F",
  "name": "Dim",
  "actions": [
    {"service": "light.turn_on", "target": "light.bedroom", "mode": "step", "stepPct": -10, "data": ""}
  ]
}
```

### Map button to set curtain to specific position

```json
{
  "id": "m1718000000005",
  "button": "5",
  "ir_code": "00FFB04F",
  "name": "Curtain Half Open",
  "actions": [
    {"service": "cover.set_cover_position", "target": "cover.krishna_s_room_curtain", "mode": "level", "value": 50, "data": ""}
  ]
}
```

## Step-by-Step: Creating an Automation via Chat

When a user asks to create an automation:

1. **Get current config:**
   ```json
   {"id": 1, "type": "broadlink_ir_receiver/get_config"}
   ```

2. **Get device state** (to find entry_id):
   ```json
   {"id": 2, "type": "broadlink_ir_receiver/get_state"}
   ```

3. **Get available entities** (to find entity_ids):
   ```json
   {"id": 3, "type": "get_states"}
   ```

4. **Ask the user:**
   - Which IR code/button to use (or tell them to press a button and read from code history)
   - What actions to perform
   - Which entities to target

5. **Build the mapping** using the format above

6. **Insert into config:**
   - Find the correct device by entry_id
   - Find the correct remote (usually `r1`)
   - Add to or replace in `mappings` array
   - Use unique `id` field (e.g., `"m" + Date.now()`)
   - If replacing, filter out old mapping with same `button` or `id`

7. **Save config:**
   ```json
   {"id": 4, "type": "broadlink_ir_receiver/set_config", "config": { ...full config... }}
   ```

8. **Confirm:** The mapping is active immediately — no restart needed.

## Important Notes

- Always read config before modifying — never write partial config
- Mapping `id` must be unique within a remote
- One mapping per button per remote (saving a new mapping for an existing button replaces it)
- The `button` field corresponds to the panel remote layout, not physical remote buttons
- IR codes must match exactly (case-sensitive hex)
- The executor matches IR codes against all remotes for the device that received the code
- Multiple actions execute sequentially on each IR code match
- The integration fires `broadlink_ir_command` events for every received IR/RF code regardless of mappings
