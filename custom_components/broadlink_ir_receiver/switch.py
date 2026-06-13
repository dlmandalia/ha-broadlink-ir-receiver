from homeassistant.components.switch import SwitchEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import CONF_NAME
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    data = hass.data[DOMAIN][entry.entry_id]
    async_add_entities([BroadlinkReceiverSwitch(entry, data["listener"])])


class BroadlinkReceiverSwitch(SwitchEntity):
    _attr_has_entity_name = True
    _attr_name = "Receiver"
    _attr_icon = "mdi:remote"

    def __init__(self, entry: ConfigEntry, listener) -> None:
        self._listener = listener
        self._attr_unique_id = f"{entry.entry_id}_receiver_switch"
        self._attr_device_info = {
            "identifiers": {(DOMAIN, entry.entry_id)},
            "name": entry.data.get(CONF_NAME, "BroadLink IR Receiver"),
            "manufacturer": "BroadLink",
            "model": "IR Receiver",
        }

    @property
    def is_on(self) -> bool:
        return self._listener.enabled

    async def async_turn_on(self, **kwargs) -> None:
        self._listener.enabled = True
        self.async_write_ha_state()

    async def async_turn_off(self, **kwargs) -> None:
        self._listener.enabled = False
        self.async_write_ha_state()
