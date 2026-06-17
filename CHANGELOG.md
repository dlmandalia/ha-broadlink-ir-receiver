# Changelog

All notable changes to the BroadLink IR Receiver integration.

## [2.7.0] - 2025-06-17

### Added
- Remote type selection: each remote is now tagged as IR or RF when created
- 2-phase guided RF capture: Phase 1 (hold button for frequency sweep) → Phase 2 (short-press for code capture)
- Remote type badge shown in selector dropdown and heading

### Changed
- Wizard capture mode determined by remote type — no manual IR/RF toggle in wizard
- RF capture split into two WS commands (`rf_sweep` + `rf_capture`) for step-by-step user guidance

## [2.6.0] - 2025-06-17

### Added
- 3-way listen mode selector: IR only / RF only / IR + RF
- RF sweep cycle for RM4 Pro devices (`sweep_frequency` + `find_rf_packet`)
- `set_listen_mode` WebSocket command replacing `toggle_rf`
- Per-device `listen_mode` and `rf_capable` in `get_state` response

### Changed
- Panel RF toggle button replaced with dropdown selector
- Backend `rf_enabled` boolean replaced with `listen_mode` string (ir/rf/both)

### Fixed
- RM4 Pro devtype 0x520B added to RF_CAPABLE_DEVTYPES

## [2.5.0] - 2025-06-16

### Added
- Multi-device support: add/remove devices from panel
- Per-device listener with independent on/off control
- Device cards in panel top bar
- RM4 Pro (0x520B) device type recognition
- RF capability detection per device
- Cache-busting for panel.js via query param

### Changed
- Config and mappings stored per-device by entry_id
- Panel redesigned with device chips and 3-column wizard layout

## [2.4.0] - 2025-06-15

### Added
- IR Remote & Automation Wizard (3-column layout)
- Button mapping create/delete from panel
- Service call execution for mapped buttons
- `codes` action to list recently captured IR codes

## [2.3.0] - 2025-06-14

### Added
- Mappings store (`mappings.py`) with event executor
- WebSocket commands for CRUD on button mappings
- Panel integration with mapping management

## [2.2.0] - 2025-06-13

### Added
- Initial multi-device architecture
- Device add/remove WebSocket commands
- Per-device toggle and notification controls

## [2.1.0] - 2025-06-12

### Added
- Notification toggle per device
- Persistent notification option for received codes

## [2.0.0] - 2025-06-11

### Added
- Full panel rewrite with sidebar integration
- Live code display with copy-to-clipboard
- NEC protocol decoding
- Switch and sensor entities
- HACS compatibility

## [1.0.0] - 2025-06-10

### Added
- Initial release
- Basic IR receiver functionality
- Event firing for received codes
