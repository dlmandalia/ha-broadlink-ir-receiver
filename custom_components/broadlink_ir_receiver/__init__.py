import asyncio
import logging
import threading
import time

import broadlink

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import CONF_HOST, CONF_NAME
from homeassistant.core import HomeAssistant

from .const import DEFAULT_DEBOUNCE, DEFAULT_POLL_INTERVAL, DOMAIN, EVENT_IR_COMMAND

_LOGGER = logging.getLogger(__name__)


def decode_nec(data: bytes) -> str | None:
    """Decode NEC IR protocol from BroadLink raw data.

    Returns an 8-char hex string like '00FF807F' for a valid 32-bit NEC frame,
    or None for repeat frames, partial data, or non-IR signals.
    """
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
    """Listens for IR signals on a BroadLink RM device and fires HA events."""

    def __init__(self, hass: HomeAssistant, host: str, name: str) -> None:
        self._hass = hass
        self._host = host
        self._name = name
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None
        self._dev = None

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

    def _fire_event(self, nec_code: str) -> None:
        self._hass.bus.fire(
            EVENT_IR_COMMAND,
            {"nec_code": nec_code, "device": self._name, "host": self._host},
        )

    def _run(self) -> None:
        while not self._stop_event.is_set():
            if not self._connect():
                self._stop_event.wait(10)
                continue

            self._drain_buffer()
            _LOGGER.info("Listening for IR codes on %s", self._name)

            last_code = None
            last_time = 0.0
            learning = False

            while not self._stop_event.is_set():
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
                    if not nec:
                        continue

                    now = time.monotonic()
                    if nec == last_code and (now - last_time) < DEFAULT_DEBOUNCE:
                        continue

                    last_code = nec
                    last_time = now

                    _LOGGER.debug("IR received: NEC=%s len=%d", nec, len(data))
                    self._fire_event(nec)

                except broadlink.exceptions.DeviceOfflineError:
                    _LOGGER.warning("Device %s offline, reconnecting...", self._name)
                    self._stop_event.wait(10)
                    learning = False
                    break

                except Exception:
                    _LOGGER.exception("Error in IR listener for %s", self._name)
                    self._stop_event.wait(2)
                    learning = False


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    hass.data.setdefault(DOMAIN, {})

    host = entry.data[CONF_HOST]
    name = entry.data.get(CONF_NAME, f"BroadLink {host}")

    listener = BroadlinkIRListener(hass, host, name)
    hass.data[DOMAIN][entry.entry_id] = listener

    await hass.async_add_executor_job(listener.start)

    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    listener = hass.data[DOMAIN].pop(entry.entry_id, None)
    if listener:
        await hass.async_add_executor_job(listener.stop)
    return True
