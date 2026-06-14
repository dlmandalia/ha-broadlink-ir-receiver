import time

from homeassistant.components import persistent_notification
from homeassistant.components.switch import SwitchEntity
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
    data = hass.data[DOMAIN][entry.entry_id]
    async_add_entities(
        [
            BroadlinkReceiverSwitch(entry, data["listener"]),
            BroadlinkNotificationsSwitch(entry),
        ]
    )


def _device_info(entry: ConfigEntry) -> dict:
    return {
        "identifiers": {(DOMAIN, entry.entry_id)},
        "name": entry.data.get(CONF_NAME, "BroadLink IR Receiver"),
        "manufacturer": "BroadLink",
        "model": "IR Receiver",
    }


class BroadlinkReceiverSwitch(SwitchEntity):
    _attr_has_entity_name = True
    _attr_name = "Receiver"
    _attr_icon = "mdi:remote"

    def __init__(self, entry: ConfigEntry, listener) -> None:
        self._listener = listener
        self._attr_unique_id = f"{entry.entry_id}_receiver_switch"
        self._attr_device_info = _device_info(entry)

    @property
    def is_on(self) -> bool:
        return self._listener.enabled

    async def async_turn_on(self, **kwargs) -> None:
        self._listener.enabled = True
        self.async_write_ha_state()

    async def async_turn_off(self, **kwargs) -> None:
        self._listener.enabled = False
        self.async_write_ha_state()


class BroadlinkNotificationsSwitch(SwitchEntity):
    """When on, posts a persistent notification for each received IR code.

    Useful while developing automations; leave off in production to avoid
    cluttering the Home Assistant notification panel.
    """

    _attr_has_entity_name = True
    _attr_name = "Notifications"
    _attr_icon = "mdi:bell"

    def __init__(self, entry: ConfigEntry) -> None:
        self._entry = entry
        self._on = False
        self._attr_unique_id = f"{entry.entry_id}_notifications_switch"
        self._attr_device_info = _device_info(entry)

    @property
    def is_on(self) -> bool:
        return self._on

    async def async_turn_on(self, **kwargs) -> None:
        self._on = True
        self.async_write_ha_state()

    async def async_turn_off(self, **kwargs) -> None:
        self._on = False
        self.async_write_ha_state()

    async def async_added_to_hass(self) -> None:
        host = self._entry.data.get(CONF_HOST)

        @callback
        def handle_event(event):
            if not self._on:
                return
            if event.data.get("host") != host:
                return
            protocol = event.data.get("protocol") or "Unknown"
            code = (
                event.data.get("nec_code")
                or event.data.get("raw_hex", "")[:16]
                or "-"
            )
            timestamp = event.data.get("timestamp") or time.time()
            persistent_notification.async_create(
                self.hass,
                f"{protocol} - {code}",
                title="IR Code Received",
                notification_id=f"{DOMAIN}_ir_{timestamp}",
            )

        self.async_on_remove(
            self.hass.bus.async_listen(EVENT_IR_COMMAND, handle_event)
        )
