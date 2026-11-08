"""Local Smarteefi SE51 provider for the Sarvesh Illam Home dashboard.

The strips accept UDP broadcasts only. This provider therefore runs beside the
dashboard service on each home's LAN and exposes ordinary switch records to the
shared Home API. No Smarteefi cloud account or activation code is required.
"""
from __future__ import annotations

import ipaddress
import logging
import random
import re
import socket
import struct
import time
from typing import Any

log = logging.getLogger(__name__)

COMMAND_PORT = 10201
COMMAND_GET = 0x1130
COMMAND_SET = 0x10CC
RESPONSE_GET = 0x1131
ALL_PORTS = 0x1F
PORT_COUNT = 5


class SmarteefiError(RuntimeError):
    """Base error for a local strip operation."""


class SmarteefiUnavailable(SmarteefiError):
    """The configured strip did not answer a status request."""


def _safe_id(value: str) -> str:
    return re.sub(r"[^a-z0-9_]+", "_", value.lower()).strip("_")[:60]


def _packet(command: int, serial: str, switch_map: int, value: int = 0) -> bytes:
    serial_bytes = serial.encode("ascii")
    if not 1 <= len(serial_bytes) <= 12:
        raise ValueError("Smarteefi serial must be 1-12 ASCII characters")
    packet = bytearray(64)
    struct.pack_into("<H", packet, 0, command)
    struct.pack_into("<H", packet, 2, 16)
    struct.pack_into("<I", packet, 4, random.getrandbits(32))
    packet[8:24] = b"\x01" * 16
    packet[24:24 + len(serial_bytes)] = serial_bytes
    struct.pack_into("<I", packet, 48, switch_map)
    struct.pack_into("<I", packet, 52, value)
    return bytes(packet)


def _response(data: bytes) -> dict[str, Any] | None:
    if len(data) < 66 or struct.unpack_from("<H", data, 2)[0] != RESPONSE_GET:
        return None
    return {
        # Response fields are shifted two bytes from their request positions.
        "serial": data[26:42].split(b"\x00", 1)[0].decode("ascii", "replace"),
        "result": struct.unpack_from("<i", data, 50)[0],
        "error": struct.unpack_from("<i", data, 54)[0],
        "status_map": struct.unpack_from("<I", data, 62)[0],
    }


def _broadcast_for(ip: str, netmask: str) -> str:
    return str(ipaddress.IPv4Network(f"{ip}/{netmask}", strict=False).broadcast_address)


class SmarteefiProvider:
    name = "smarteefi"

    def __init__(self, config: dict[str, Any] | None = None):
        config = config or {}
        self.timeout = max(0.5, min(15.0, float(config.get("timeout", 3.0))))
        self.retries = max(1, min(5, int(config.get("retries", 2))))
        self.netmask = str(config.get("netmask", "255.255.255.0"))
        self.strips: dict[str, dict[str, Any]] = {}
        self._entities: dict[str, dict[str, Any]] = {}
        for raw in config.get("strips", []):
            self._add_strip(raw)

    @property
    def enabled(self) -> bool:
        return bool(self.strips)

    def _add_strip(self, raw: dict[str, Any]) -> None:
        serial = str(raw.get("serial", "")).strip()
        try:
            serial.encode("ascii")
        except UnicodeEncodeError as exc:
            raise ValueError("Smarteefi serial must be ASCII") from exc
        if not 1 <= len(serial) <= 12:
            raise ValueError("Smarteefi serial must be 1-12 characters")
        strip_id = _safe_id(str(raw.get("id") or serial))
        if not strip_id or strip_id in self.strips:
            raise ValueError(f"Duplicate or invalid Smarteefi strip id: {strip_id!r}")
        ip = str(raw.get("ip", "")).strip()
        if ip:
            ipaddress.IPv4Address(ip)
        broadcast = str(raw.get("broadcast", "")).strip()
        if broadcast:
            ipaddress.IPv4Address(broadcast)
        elif ip:
            broadcast = _broadcast_for(ip, self.netmask)
        else:
            broadcast = "255.255.255.255"
        strip = {
            "id": strip_id,
            "serial": serial,
            "ip": ip,
            "broadcast": broadcast,
            "name": str(raw.get("name") or "Smarteefi strip")[:80],
            "room": str(raw.get("room") or "Home")[:60],
        }
        self.strips[strip_id] = strip
        port_config = raw.get("ports", {}) or {}
        for port in range(1, PORT_COUNT + 1):
            details = port_config.get(port, port_config.get(str(port), {})) or {}
            item_id = f"{strip_id}_port_{port}"
            self._entities[item_id] = {
                "id": item_id,
                "entity_id": f"smarteefi.{strip_id}.port_{port}",
                "name": str(details.get("name") or f"Outlet {port}")[:80],
                "room": str(details.get("room") or strip["room"])[:60],
                "icon": str(details.get("icon") or "🔌")[:8],
                "type": "switch",
                "read_only": False,
                "provider": self.name,
                "device_id": strip_id,
                "device_name": strip["name"],
                "strip_id": strip_id,
                "port": port,
            }

    def entities(self) -> list[dict[str, Any]]:
        return [item.copy() for item in self._entities.values()]

    def _socket(self) -> socket.socket:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        sock.bind(("0.0.0.0", 0))
        return sock

    def _status_map(self, strip: dict[str, Any]) -> int:
        request = _packet(COMMAND_GET, strip["serial"], ALL_PORTS)
        deadline = time.monotonic() + self.timeout
        next_send = 0.0
        sent = 0
        with self._socket() as sock:
            sock.settimeout(0.35)
            while time.monotonic() < deadline:
                now = time.monotonic()
                if sent < self.retries and now >= next_send:
                    sock.sendto(request, (strip["broadcast"], COMMAND_PORT))
                    sent += 1
                    next_send = now + 0.8
                try:
                    data, address = sock.recvfrom(2048)
                except socket.timeout:
                    continue
                parsed = _response(data)
                if not parsed or parsed["serial"] != strip["serial"]:
                    continue
                if strip["ip"] and address[0] != strip["ip"]:
                    continue
                # SE51 firmware revisions disagree on whether a successful
                # result is 0 or 1; the dedicated error field is stable.
                if parsed["error"] != 0:
                    raise SmarteefiError(
                        f"Strip {strip['id']} returned result={parsed['result']} error={parsed['error']}")
                return int(parsed["status_map"])
        raise SmarteefiUnavailable(f"No reply from Smarteefi strip {strip['id']}")

    def states(self) -> list[dict[str, Any]]:
        result: list[dict[str, Any]] = []
        for strip_id, strip in self.strips.items():
            try:
                status_map = self._status_map(strip)
            except (SmarteefiError, OSError) as exc:
                log.warning("%s", exc)
                status_map = None
            for item in self._entities.values():
                if item["strip_id"] != strip_id:
                    continue
                state = "unavailable" if status_map is None else (
                    "on" if status_map & (1 << (item["port"] - 1)) else "off")
                result.append({
                    "id": item["id"],
                    "state": state,
                    "attributes": {
                        "strip": strip["name"],
                        "serial": strip["serial"],
                        "port": item["port"],
                    },
                })
        return result

    def command(self, item_id: str, action: str, _data: dict[str, Any] | None = None) -> dict[str, Any]:
        item = self._entities.get(item_id)
        if not item:
            raise KeyError(item_id)
        if action not in {"turn_on", "turn_off"}:
            raise ValueError("Smarteefi outlets support only turn_on and turn_off")
        strip = self.strips[item["strip_id"]]
        bit = 1 << (item["port"] - 1)
        request = _packet(COMMAND_SET, strip["serial"], bit, bit if action == "turn_on" else 0)
        desired = action == "turn_on"
        try:
            with self._socket() as sock:
                for attempt in range(2):
                    sock.sendto(request, (strip["broadcast"], COMMAND_PORT))
                    time.sleep(0.4)
                    status_map = self._status_map(strip)
                    if bool(status_map & bit) == desired:
                        return {"ok": True, "state": "on" if desired else "off"}
                    if attempt:
                        break
        except OSError as exc:
            raise SmarteefiUnavailable(f"Could not reach Smarteefi strip {strip['id']}") from exc
        raise SmarteefiError(f"Strip {strip['id']} outlet {item['port']} did not change")
