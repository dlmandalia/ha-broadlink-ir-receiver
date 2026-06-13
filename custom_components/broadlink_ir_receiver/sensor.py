from homeassistant.components.sensor import SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import CONF_HOST, CONF_NAME
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN, EVENT_IR_COMMAND


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    async_add_entities([BroadlinkLastCodeSensor(entry)])


class BroadlinkLastCodeSensor(SensorEntity):
    _attr_has_entity_name = True
    _attr_name = "Last IR Code"
    _attr_icon = "mdi:remote"

    def __init__(self, entry: ConfigEntry) -> None:
        self._entry = entry
        self._attr_unique_id = f"{entry.entry_id}_last_code"
        self._attr_device_info = {
            "identifiers": {(DOMAIN, entry.entry_id)},
            "name": entry.data.get(CONF_NAME, "BroadLink IR Receiver"),
            "manufacturer": "BroadLink",
            "model": "IR Receiver",
        }
        self._attr_native_value = None
        self._attr_extra_state_attributes = {}

    async def async_added_to_hass(self) -> None:
        host = self._entry.data.get(CONF_HOST)

        @callback
        def handle_event(event):
            if event.data.get("host") != host:
                return
            code = event.data.get("nec_code") or event.data.get("raw_hex", "")[:16]
            self._attr_native_value = code
            self._attr_extra_state_attributes = {
                "protocol": event.data.get("protocol", "Unknown"),
                "nec_code": event.data.get("nec_code"),
                "raw_hex": event.data.get("raw_hex"),
            }
            self.async_write_ha_state()

        self.async_on_remove(
            self.hass.bus.async_listen(EVENT_IR_COMMAND, handle_event)
        )
