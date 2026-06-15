"""Mappings engine — stores IR-to-action mappings and executes them on match."""

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
    return {
        "remotes": [{"id": "r1", "name": "Remote 1", "mappings": []}],
        "sel": "r1",
    }


class MappingsStore:

    def __init__(self, hass: HomeAssistant) -> None:
        self._hass = hass
        self._store = Store(hass, STORE_VERSION, STORE_KEY)
        self._data: dict | None = None
        self._unsub = None

    async def async_load(self) -> None:
        self._data = await self._store.async_load() or default_data()
        if not self._data.get("remotes"):
            self._data = default_data()

    async def async_save(self) -> None:
        await self._store.async_save(self._data)

    @property
    def data(self) -> dict:
        return self._data

    async def async_set_data(self, data: dict) -> None:
        self._data = data
        await self.async_save()

    def start_executor(self) -> None:
        @callback
        def _handle_ir(event):
            code = event.data.get("nec_code") or event.data.get("raw_hex", "")[:16]
            host = event.data.get("host")
            if not code:
                return
            for remote in self._data.get("remotes", []):
                for m in remote.get("mappings", []):
                    if m.get("ir_code") != code:
                        continue
                    _LOGGER.info(
                        "IR match: %s → %s on remote '%s'",
                        code,
                        m.get("service"),
                        remote.get("name"),
                    )
                    self._execute(m, host)
                    return

        self._unsub = self._hass.bus.async_listen(EVENT_IR_COMMAND, _handle_ir)

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
            key = "position_step" if "cover" in service else "brightness_step_pct"
            service_data[key] = int(mapping.get("stepPct", 10))
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
