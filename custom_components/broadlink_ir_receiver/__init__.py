import asyncio
import logging
import threading
import time
from collections import deque

import broadlink
import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.components.frontend import async_register_built_in_panel
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import CONF_HOST, CONF_NAME
from homeassistant.core import HomeAssistant

from .const import (
    DEFAULT_DEBOUNCE,
    DEFAULT_POLL_INTERVAL,
    DOMAIN,
    EVENT_IR_COMMAND,
    MAX_CODE_HISTORY,
    PLATFORMS,
    RF_CAPABLE_DEVTYPES,
)
from .mappings import MappingsStore, ws_get_config, ws_set_config

_LOGGER = logging.getLogger(__name__)


def decode_nec(data: bytes) -> str | None:
    if len(data) < 6 or data[0] != 0x26:
        return None
    timings = list(data[6:])
    while timings and timings[-1] == 0:
        timings.pop()
    if len(timings) < 4:
        return None
    bits = []
    i = 2
    while i + 1 < len(timings):
        mark = timings[i]
        space = timings[i + 1]
        if mark < 10:
            break
        bits.append(1 if space > 35 else 0)
        i += 2
    if len(bits) >= 32:
        val = 0
        for b in bits[:32]:
            val = (val << 1) | b
        return f"{val:08X}"
    return None


class BroadlinkIRListener:

    def __init__(
        self, hass: HomeAssistant, host: str, name: str, entry_id: str, dev_type: int = 0
    ) -> None:
        self._hass = hass
        self._host = host
        self._name = name
        self._entry_id = entry_id
        self._dev_type = dev_type
        self._stop_event = threading.Event()
        self._idle_event = threading.Event()
        self._thread: threading.Thread | None = None
        self._dev = None
        self._enabled = True
        self._listen_mode = "ir"

    @property
    def enabled(self) -> bool:
        return self._enabled

    @enabled.setter
    def enabled(self, value: bool) -> None:
        self._enabled = value
        _LOGGER.info(
            "Listener %s for %s", "enabled" if value else "disabled", self._name
        )

    @property
    def listen_mode(self) -> str:
        return self._listen_mode

    @listen_mode.setter
    def listen_mode(self, value: str) -> None:
        if value not in ("ir", "rf", "both"):
            value = "ir"
        self._listen_mode = value
        _LOGGER.info("Listen mode → %s for %s", value, self._name)

    @property
    def rf_enabled(self) -> bool:
        return self._listen_mode in ("rf", "both")

    @property
    def host(self) -> str:
        return self._host

    @property
    def name(self) -> str:
        return self._name

    def start(self) -> None:
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()
        _LOGGER.info("IR listener started for %s (%s)", self._name, self._host)

    def stop(self) -> None:
        self._stop_event.set()
        if self._thread:
            self._thread.join(timeout=5)
        _LOGGER.info("IR listener stopped for %s", self._name)

    def _connect(self) -> bool:
        try:
            devices = broadlink.discover(timeout=5, discover_ip_address=self._host)
            if not devices:
                _LOGGER.error("Device not found at %s", self._host)
                return False
            self._dev = devices[0]
            self._dev.auth()
            _LOGGER.info(
                "Connected to %s (type=0x%04x) at %s",
                self._name,
                self._dev.devtype,
                self._host,
            )
            return True
        except Exception:
            _LOGGER.exception("Failed to connect to %s", self._host)
            return False

    def _drain_buffer(self) -> None:
        for _ in range(10):
            try:
                self._dev.check_data()
            except Exception:
                break

    def _fire_event(self, nec_code: str | None, raw_data: bytes, protocol: str) -> None:
        raw_hex = raw_data.hex() if raw_data else ""
        event_data = {
            "nec_code": nec_code,
            "raw_hex": raw_hex,
            "protocol": protocol,
            "device": self._name,
            "host": self._host,
            "timestamp": time.time(),
        }

        entry_data = self._hass.data.get(DOMAIN, {}).get(self._entry_id)
        if entry_data and "code_history" in entry_data:
            entry_data["code_history"].append(event_data)

        self._hass.bus.fire(EVENT_IR_COMMAND, event_data)

    def _run(self) -> None:
        while not self._stop_event.is_set():
            if not self._enabled:
                self._idle_event.set()
                self._stop_event.wait(0.5)
                continue

            self._idle_event.clear()
            if not self._dev:
                if not self._connect():
                    self._stop_event.wait(10)
                    continue

            self._drain_buffer()
            _LOGGER.info("Listening on %s (mode=%s)", self._name, self._listen_mode)

            last_code = None
            last_time = 0.0
            learning = False
            is_rf_capable = self._dev_type in RF_CAPABLE_DEVTYPES

            while not self._stop_event.is_set():
                if not self._enabled:
                    learning = False
                    break

                mode = self._listen_mode if is_rf_capable else "ir"

                try:
                    # --- RF-only mode: continuous sweep ---
                    if mode == "rf":
                        learning = False
                        data = self._rf_listen_cycle()
                        if data:
                            code_key = data[:8].hex()
                            now = time.monotonic()
                            if code_key != last_code or (now - last_time) >= DEFAULT_DEBOUNCE:
                                last_code = code_key
                                last_time = now
                                self._fire_event(nec_code=None, raw_data=data, protocol="RF")
                        continue

                    # --- Both mode: alternate IR + RF ---
                    if mode == "both":
                        if not hasattr(self, "_both_ir_count"):
                            self._both_ir_count = 0
                        self._both_ir_count += 1
                        if self._both_ir_count >= 20:
                            self._both_ir_count = 0
                            learning = False
                            data = self._rf_listen_cycle()
                            if data:
                                code_key = data[:8].hex()
                                now = time.monotonic()
                                if code_key != last_code or (now - last_time) >= DEFAULT_DEBOUNCE:
                                    last_code = code_key
                                    last_time = now
                                    self._fire_event(nec_code=None, raw_data=data, protocol="RF")
                            continue

                    # --- IR mode (and IR phase of "both") ---
                    if not learning:
                        try:
                            self._dev.enter_learning()
                            learning = True
                        except Exception as exc:
                            if "storage is full" in str(exc):
                                self._drain_buffer()
                                continue
                            raise

                    self._stop_event.wait(DEFAULT_POLL_INTERVAL)
                    if self._stop_event.is_set():
                        break

                    try:
                        data = self._dev.check_data()
                    except broadlink.exceptions.ReadError:
                        continue
                    except Exception as exc:
                        if "storage is full" in str(exc):
                            self._drain_buffer()
                            learning = False
                            continue
                        raise

                    if not data:
                        continue

                    learning = False

                    nec = decode_nec(data)
                    if nec:
                        protocol = "NEC"
                    elif is_rf_capable and (len(data) < 6 or data[0] != 0x26):
                        protocol = "RF"
                    else:
                        protocol = "Unknown"
                    code_key = nec or data[:8].hex()

                    now = time.monotonic()
                    if code_key == last_code and (now - last_time) < DEFAULT_DEBOUNCE:
                        continue
                    last_code = code_key
                    last_time = now

                    _LOGGER.debug(
                        "Received: protocol=%s code=%s len=%d",
                        protocol,
                        code_key,
                        len(data),
                    )
                    self._fire_event(nec_code=nec, raw_data=data, protocol=protocol)

                except broadlink.exceptions.DeviceOfflineError:
                    _LOGGER.warning("Device %s offline, reconnecting...", self._name)
                    self._stop_event.wait(10)
                    learning = False
                    break

                except Exception:
                    _LOGGER.exception("Error in listener for %s", self._name)
                    self._stop_event.wait(2)
                    learning = False

    @staticmethod
    def _is_valid_rf_freq(freq):
        for center in (315, 390, 418, 433.92):
            if abs(freq - center) < 5:
                return True
        return False

    def _rf_listen_cycle(self) -> bytes | None:
        """RF listen cycle: sweep_frequency to init RF hardware, find freq,
        then find_rf_packet(freq) → poll check_data for signal."""
        freq = getattr(self, "_rf_freq", None)

        if not freq:
            try:
                self._dev.sweep_frequency()
            except Exception:
                self._stop_event.wait(1)
                return None

            deadline = time.monotonic() + 8
            while time.monotonic() < deadline:
                self._stop_event.wait(0.2)
                if self._stop_event.is_set() or not self._enabled:
                    try:
                        self._dev.cancel_sweep_frequency()
                    except Exception:
                        pass
                    return None
                if self._listen_mode not in ("rf", "both"):
                    try:
                        self._dev.cancel_sweep_frequency()
                    except Exception:
                        pass
                    return None
                try:
                    found, f = self._dev.check_frequency()
                    if found and self._is_valid_rf_freq(f):
                        freq = f
                        self._rf_freq = f
                        break
                except Exception:
                    pass
            else:
                try:
                    self._dev.cancel_sweep_frequency()
                except Exception:
                    pass
                return None

        try:
            self._dev.find_rf_packet(freq)
        except Exception:
            self._stop_event.wait(1)
            return None

        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            self._stop_event.wait(DEFAULT_POLL_INTERVAL)
            if self._stop_event.is_set() or not self._enabled:
                return None
            if self._listen_mode not in ("rf", "both"):
                return None
            try:
                data = self._dev.check_data()
                if data:
                    return data
            except Exception:
                continue
        return None


# ---------------------------------------------------------------------------
# WebSocket API
# ---------------------------------------------------------------------------


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
        dt = data.get("dev_type", 0)
        entries[entry_id] = {
            "enabled": listener.enabled,
            "listen_mode": listener.listen_mode,
            "rf_capable": dt in RF_CAPABLE_DEVTYPES,
            "host": listener.host,
            "name": listener.name,
            "dev_type": dt,
            "codes": list(data.get("code_history", [])),
        }
    connection.send_result(msg["id"], {"entries": entries})


@websocket_api.websocket_command(
    {
        vol.Required("type"): "broadlink_ir_receiver/toggle",
        vol.Required("entry_id"): str,
        vol.Required("enabled"): bool,
    }
)
@websocket_api.async_response
async def ws_toggle(hass, connection, msg):
    data = hass.data.get(DOMAIN, {}).get(msg["entry_id"])
    if data and "listener" in data:
        data["listener"].enabled = msg["enabled"]
        connection.send_result(msg["id"], {"enabled": msg["enabled"]})
    else:
        connection.send_error(msg["id"], "not_found", "Entry not found")


@websocket_api.websocket_command(
    {
        vol.Required("type"): "broadlink_ir_receiver/set_listen_mode",
        vol.Required("entry_id"): str,
        vol.Required("mode"): str,
    }
)
@websocket_api.async_response
async def ws_set_listen_mode(hass, connection, msg):
    data = hass.data.get(DOMAIN, {}).get(msg["entry_id"])
    if not data or "listener" not in data:
        connection.send_error(msg["id"], "not_found", "Entry not found")
        return
    mode = msg["mode"]
    if mode not in ("ir", "rf", "both"):
        connection.send_error(msg["id"], "invalid_mode", "Mode must be ir, rf, or both")
        return
    dt = data.get("dev_type", 0)
    if mode in ("rf", "both") and dt not in RF_CAPABLE_DEVTYPES:
        connection.send_error(msg["id"], "not_supported", "Device does not support RF")
        return
    data["listener"].listen_mode = mode
    connection.send_result(msg["id"], {"listen_mode": mode})


@websocket_api.websocket_command(
    {vol.Required("type"): "broadlink_ir_receiver/clear_codes"}
)
@websocket_api.async_response
async def ws_clear_codes(hass, connection, msg):
    for data in hass.data.get(DOMAIN, {}).values():
        if isinstance(data, dict) and "code_history" in data:
            data["code_history"].clear()
    connection.send_result(msg["id"], {})


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


@websocket_api.websocket_command(
    {
        vol.Required("type"): "broadlink_ir_receiver/remove_device",
        vol.Required("entry_id"): str,
    }
)
@websocket_api.async_response
async def ws_remove_device(hass, connection, msg):
    entry_id = msg["entry_id"]

    store = hass.data.get(DOMAIN, {}).get("_mappings_store")
    if store:
        store.remove_device(entry_id)
        await store.async_save()

    entry = hass.config_entries.async_get_entry(entry_id)
    if entry and entry.domain == DOMAIN:
        try:
            await hass.config_entries.async_remove(entry_id)
        except Exception as exc:
            _LOGGER.warning("Error removing config entry %s: %s", entry_id, exc)

    entry_data = hass.data.get(DOMAIN, {}).pop(entry_id, None)
    if entry_data and "listener" in entry_data:
        try:
            await hass.async_add_executor_job(entry_data["listener"].stop)
        except Exception:
            pass

    connection.send_result(msg["id"], {"success": True})


def _get_rf_device(hass, msg, connection):
    """Validate entry and return (dev, data) or send error and return None."""
    entry_id = msg["entry_id"]
    data = hass.data.get(DOMAIN, {}).get(entry_id)
    if not data or "listener" not in data:
        connection.send_error(msg["id"], "not_found", "Device not found")
        return None, None
    if data.get("dev_type", 0) not in RF_CAPABLE_DEVTYPES:
        connection.send_error(msg["id"], "not_supported", "Device does not support RF")
        return None, None
    listener = data["listener"]
    if not listener._dev:
        connection.send_error(msg["id"], "not_connected", "Device not connected")
        return None, None
    return listener._dev, data


@websocket_api.websocket_command(
    {
        vol.Required("type"): "broadlink_ir_receiver/rf_sweep",
        vol.Required("entry_id"): str,
    }
)
@websocket_api.async_response
async def ws_rf_sweep(hass, connection, msg):
    """Phase 1: sweep for RF frequency. User holds button during this."""
    dev, data = _get_rf_device(hass, msg, connection)
    if dev is None:
        return

    listener = data["listener"]
    was_enabled = listener.enabled
    if was_enabled:
        listener.enabled = False
        idle_ok = await hass.async_add_executor_job(listener._idle_event.wait, 5)
        if not idle_ok:
            _LOGGER.warning("Listener did not go idle in 5s, proceeding anyway")

    def _sweep():
        import time as _time

        try:
            dev.cancel_sweep_frequency()
        except Exception:
            pass
        try:
            dev.check_data()
        except Exception:
            pass
        _time.sleep(0.3)

        _LOGGER.info("RF sweep started on %s", msg["entry_id"])
        dev.sweep_frequency()
        deadline = _time.monotonic() + 15
        while _time.monotonic() < deadline:
            _time.sleep(0.25)
            try:
                result = dev.check_frequency()
            except Exception as ex:
                _LOGGER.warning("check_frequency error: %s", ex)
                continue
            _LOGGER.debug("check_frequency raw: %s (type=%s)", result, type(result))
            if isinstance(result, tuple):
                found, freq = result
                if found:
                    if BroadlinkIRListener._is_valid_rf_freq(freq):
                        _LOGGER.info("RF frequency found: %.2f MHz", freq)
                        return freq
                    _LOGGER.warning("Ignoring noise frequency %.2f MHz", freq)
            elif result:
                _LOGGER.warning("check_frequency returned non-tuple: %s", result)
        dev.cancel_sweep_frequency()
        _LOGGER.info("RF sweep timed out — no valid frequency found")
        return None

    try:
        freq = await hass.async_add_executor_job(_sweep)
    except Exception as exc:
        _LOGGER.error("RF sweep exception: %s", exc)
        if was_enabled:
            listener.enabled = True
        connection.send_error(msg["id"], "rf_error", str(exc))
        return

    if freq is None:
        if was_enabled:
            listener.enabled = True
        connection.send_error(msg["id"], "rf_timeout", "No RF frequency detected — hold the button longer")
        return

    data["_rf_frequency"] = freq
    data["_rf_restore_listener"] = was_enabled
    listener._rf_freq = freq
    connection.send_result(msg["id"], {"status": "frequency_found", "frequency": round(freq, 2)})


@websocket_api.websocket_command(
    {
        vol.Required("type"): "broadlink_ir_receiver/rf_capture",
        vol.Required("entry_id"): str,
    }
)
@websocket_api.async_response
async def ws_rf_capture(hass, connection, msg):
    """Phase 2: capture RF packet. User short-presses button."""
    dev, data = _get_rf_device(hass, msg, connection)
    if dev is None:
        return

    freq = data.get("_rf_frequency")
    _LOGGER.info("RF capture phase 2: freq=%s for %s", freq, msg["entry_id"])

    def _capture():
        import time as _time
        _LOGGER.info("Calling find_rf_packet(freq=%s)", freq)
        dev.find_rf_packet(freq)
        deadline = _time.monotonic() + 10
        while _time.monotonic() < deadline:
            _time.sleep(0.25)
            try:
                rf_data = dev.check_data()
                if rf_data:
                    _LOGGER.info("RF packet captured: %d bytes", len(rf_data))
                    return rf_data
            except Exception as ex:
                _LOGGER.debug("check_data: %s", ex)
                continue
        _LOGGER.info("RF capture timed out")
        return None

    def _restore():
        if data.get("_rf_restore_listener"):
            data["listener"].enabled = True
            data.pop("_rf_restore_listener", None)

    try:
        rf_data = await hass.async_add_executor_job(_capture)
    except Exception as exc:
        _restore()
        connection.send_error(msg["id"], "rf_error", str(exc))
        return

    _restore()

    if not rf_data:
        connection.send_error(msg["id"], "rf_timeout", "RF packet capture timed out — press button again")
        return

    rf_hex = rf_data.hex()
    connection.send_result(msg["id"], {"rf_code": rf_hex[:16] or rf_hex, "raw_hex": rf_hex})


# ---------------------------------------------------------------------------
# Panel + setup
# ---------------------------------------------------------------------------


async def _register_panel(hass: HomeAssistant) -> None:
    from homeassistant.components.http import StaticPathConfig

    await hass.http.async_register_static_paths(
        [
            StaticPathConfig(
                f"/api/{DOMAIN}/panel.js",
                hass.config.path(f"custom_components/{DOMAIN}/panel.js"),
                cache_headers=False,
            )
        ]
    )
    async_register_built_in_panel(
        hass,
        component_name="custom",
        sidebar_title="IR Receiver",
        sidebar_icon="mdi:remote",
        frontend_url_path="broadlink-ir-receiver",
        config={
            "_panel_custom": {
                "name": "broadlink-ir-panel",
                "module_url": f"/api/{DOMAIN}/panel.js?v=280",
            }
        },
        require_admin=False,
    )


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    hass.data.setdefault(DOMAIN, {})

    host = entry.data[CONF_HOST]
    name = entry.data.get(CONF_NAME, f"BroadLink {host}")
    dev_type = entry.data.get("dev_type", 0)

    listener = BroadlinkIRListener(hass, host, name, entry.entry_id, dev_type)

    hass.data[DOMAIN][entry.entry_id] = {
        "listener": listener,
        "code_history": deque(maxlen=MAX_CODE_HISTORY),
        "dev_type": dev_type,
    }

    await hass.async_add_executor_job(listener.start)

    if "_panel_registered" not in hass.data[DOMAIN]:
        websocket_api.async_register_command(hass, ws_get_state)
        websocket_api.async_register_command(hass, ws_toggle)
        websocket_api.async_register_command(hass, ws_set_listen_mode)
        websocket_api.async_register_command(hass, ws_clear_codes)
        websocket_api.async_register_command(hass, ws_get_config)
        websocket_api.async_register_command(hass, ws_set_config)
        websocket_api.async_register_command(hass, ws_add_device)
        websocket_api.async_register_command(hass, ws_remove_device)
        websocket_api.async_register_command(hass, ws_rf_sweep)
        websocket_api.async_register_command(hass, ws_rf_capture)
        await _register_panel(hass)
        hass.data[DOMAIN]["_panel_registered"] = True

    if "_mappings_store" not in hass.data[DOMAIN]:
        store = MappingsStore(hass)
        await store.async_load(first_entry_id=entry.entry_id)
        store.start_executor()
        hass.data[DOMAIN]["_mappings_store"] = store

    store = hass.data[DOMAIN]["_mappings_store"]
    store.ensure_device(entry.entry_id)
    await store.async_save()

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)

    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    unload_ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)

    if unload_ok:
        data = hass.data[DOMAIN].pop(entry.entry_id, None)
        if data and "listener" in data:
            await hass.async_add_executor_job(data["listener"].stop)

        remaining = {
            k for k in hass.data.get(DOMAIN, {}) if not k.startswith("_")
        }
        if not remaining:
            store = hass.data[DOMAIN].pop("_mappings_store", None)
            if store:
                store.stop_executor()

    return unload_ok
