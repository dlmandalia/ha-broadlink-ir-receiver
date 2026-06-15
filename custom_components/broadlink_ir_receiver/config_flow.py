import broadlink
import voluptuous as vol

from homeassistant import config_entries
from homeassistant.const import CONF_HOST, CONF_NAME

from .const import DOMAIN


class BroadlinkIRReceiverConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    VERSION = 1

    async def async_step_user(self, user_input=None):
        errors = {}

        if user_input is not None:
            host = user_input[CONF_HOST]

            for entry in self._async_current_entries():
                if entry.data.get(CONF_HOST) == host:
                    return self.async_abort(reason="already_configured")

            try:
                devices = await self.hass.async_add_executor_job(
                    broadlink.discover, 5, None, host
                )
                if not devices:
                    errors["base"] = "cannot_connect"
                else:
                    dev = devices[0]
                    await self.hass.async_add_executor_job(dev.auth)
                    name = user_input.get(CONF_NAME, f"BroadLink {host}")
                    return self.async_create_entry(
                        title=name,
                        data={
                            CONF_HOST: host,
                            CONF_NAME: name,
                            "dev_type": dev.devtype,
                            "mac": ":".join(f"{b:02x}" for b in dev.mac),
                        },
                    )
            except Exception:
                errors["base"] = "cannot_connect"

        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema(
                {
                    vol.Required(CONF_HOST): str,
                    vol.Optional(CONF_NAME, default="BroadLink IR Receiver"): str,
                }
            ),
            errors=errors,
        )

    async def async_step_ws(self, data=None):
        if data is None:
            return self.async_abort(reason="no_data")

        host = data.get("host")
        if not host:
            return self.async_abort(reason="no_host")

        for entry in self._async_current_entries():
            if entry.data.get(CONF_HOST) == host:
                return self.async_abort(reason="already_configured")

        name = data.get("name", f"BroadLink {host}")
        return self.async_create_entry(
            title=name,
            data={
                CONF_HOST: host,
                CONF_NAME: name,
                "dev_type": data.get("dev_type", 0),
                "mac": data.get("mac", ""),
            },
        )
