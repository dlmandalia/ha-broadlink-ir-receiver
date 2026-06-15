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
        self, hass: HomeAssistant, host: str, name: str, entry_id: str
    ) -> None:
        self._hass = hass
        self._host = host
        self._name = name
        self._entry_id = entry_id
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None
        self._dev = None
        self._enabled = True

    @property
    def enabled(self) -> bool:
        return self._enabled

    @enabled.setter
    def enabled(self, value: bool) -> None:
        self._enabled = value
        _LOGGER.info(
            "IR listener %s for %s", "enabled" if value else "disabled", self._name
        )

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
                self._stop_event.wait(0.5)
                continue

            if not self._connect():
                self._stop_event.wait(10)
                continue

            self._drain_buffer()
            _LOGGER.info("Listening for IR codes on %s", self._name)

            last_code = None
            last_time = 0.0
            learning = False

            while not self._stop_event.is_set():
                if not self._enabled:
                    learning = False
                    break

                try:
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
                    protocol = "NEC" if nec else "Unknown"
                    code_key = nec or data[:8].hex()

                    now = time.monotonic()
                    if code_key == last_code and (now - last_time) < DEFAULT_DEBOUNCE:
                        continue
                    last_code = code_key
                    last_time = now

                    _LOGGER.debug(
                        "IR received: protocol=%s code=%s len=%d",
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
                    _LOGGER.exception("Error in IR listener for %s", self._name)
                    self._stop_event.wait(2)
                    learning = False


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
        entries[entry_id] = {
            "enabled": listener.enabled,
            "host": listener.host,
            "name": listener.name,
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
    {vol.Required("type"): "broadlink_ir_receiver/clear_codes"}
)
@websocket_api.async_response
async def ws_clear_codes(hass, connection, msg):
    for data in hass.data.get(DOMAIN, {}).values():
        if isinstance(data, dict) and "code_history" in data:
            data["code_history"].clear()
    connection.send_result(msg["id"], {})


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
                "module_url": f"/api/{DOMAIN}/panel.js",
            }
        },
        require_admin=False,
    )


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    hass.data.setdefault(DOMAIN, {})

    host = entry.data[CONF_HOST]
    name = entry.data.get(CONF_NAME, f"BroadLink {host}")

    listener = BroadlinkIRListener(hass, host, name, entry.entry_id)

    hass.data[DOMAIN][entry.entry_id] = {
        "listener": listener,
        "code_history": deque(maxlen=MAX_CODE_HISTORY),
    }

    await hass.async_add_executor_job(listener.start)

    if "_panel_registered" not in hass.data[DOMAIN]:
        websocket_api.async_register_command(hass, ws_get_state)
        websocket_api.async_register_command(hass, ws_toggle)
        websocket_api.async_register_command(hass, ws_clear_codes)
        websocket_api.async_register_command(hass, ws_get_config)
        websocket_api.async_register_command(hass, ws_set_config)
        await _register_panel(hass)
        hass.data[DOMAIN]["_panel_registered"] = True

    if "_mappings_store" not in hass.data[DOMAIN]:
        store = MappingsStore(hass)
        await store.async_load()
        store.start_executor()
        hass.data[DOMAIN]["_mappings_store"] = store

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
