"""Mappings engine — stores per-device IR/RF-to-action mappings and executes on match."""

import logging

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.storage import Store

from .const import DOMAIN, EVENT_IR_COMMAND

_LOGGER = logging.getLogger(__name__)

STORE_KEY = f"{DOMAIN}.mappings"
STORE_VERSION = 1


def default_data():
    return {"version": 2, "devices": {}}


def _migrate_v1(data: dict, first_entry_id: str | None) -> dict:
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

    async def async_save(self) -> None:
        await self._store.async_save(self._data)

    @property
    def data(self) -> dict:
        return self._data

    async def async_set_data(self, data: dict) -> None:
        self._data = data
        await self.async_save()

    def ensure_device(self, entry_id: str) -> None:
        if entry_id not in self._data.get("devices", {}):
            self._data.setdefault("devices", {})[entry_id] = {
                "remotes": [{"id": "r1", "name": "Remote 1", "mappings": []}],
                "sel": "r1",
            }

    def remove_device(self, entry_id: str) -> None:
        self._data.get("devices", {}).pop(entry_id, None)

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

    def stop_executor(self) -> None:
        if self._unsub:
            self._unsub()
            self._unsub = None

    def _execute(self, mapping: dict, host: str) -> None:
        service = mapping.get("service", "")
        if "." not in service:
            return
        domain, svc = service.split(".", 1)
        service_data = {}
        target = mapping.get("target")
        if target:
            service_data["entity_id"] = target

        mode = mapping.get("mode", "service")
        if mode == "level":
            key = "position" if "cover" in service else "brightness_pct"
            service_data[key] = int(mapping.get("value", 0))
        elif mode == "step":
            step_pct = int(mapping.get("stepPct", 10))
            if "cover" in service:
                step_dir = int(mapping.get("stepDir", 1))
                current = 0
                if target:
                    state = self._hass.states.get(target)
                    if state:
                        current = int(state.attributes.get("current_position", 0))
                new_pos = max(0, min(100, current + step_pct * step_dir))
                service_data["position"] = new_pos
            else:
                service_data["brightness_step_pct"] = step_pct
        elif mode == "service":
            extra = mapping.get("data")
            if extra and isinstance(extra, str):
                import json

                try:
                    extra = json.loads(extra)
                except (json.JSONDecodeError, ValueError):
                    extra = None
            if isinstance(extra, dict):
                service_data.update(extra)

        self._hass.async_create_task(
            self._hass.services.async_call(domain, svc, service_data)
        )


# ---------------------------------------------------------------------------
# WebSocket commands
# ---------------------------------------------------------------------------


@websocket_api.websocket_command(
    {vol.Required("type"): f"{DOMAIN}/get_config"}
)
@websocket_api.async_response
async def ws_get_config(hass, connection, msg):
    store: MappingsStore | None = hass.data.get(DOMAIN, {}).get("_mappings_store")
    if not store:
        connection.send_error(msg["id"], "not_ready", "Mappings store not loaded")
        return
    connection.send_result(msg["id"], store.data)


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/set_config",
        vol.Required("config"): dict,
    }
)
@websocket_api.async_response
async def ws_set_config(hass, connection, msg):
    store: MappingsStore | None = hass.data.get(DOMAIN, {}).get("_mappings_store")
    if not store:
        connection.send_error(msg["id"], "not_ready", "Mappings store not loaded")
        return
    await store.async_set_data(msg["config"])
    connection.send_result(msg["id"], {"success": True})
