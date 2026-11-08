"""Home Assistant boundary for Sarvesh Illam.

The browser never receives the Home Assistant access token. This module keeps
the dashboard on a deliberately small allow-list of configured entities.
"""
import logging
import os
import json
import re
import threading
from pathlib import Path
from typing import Any, Iterable

import httpx

log = logging.getLogger(__name__)


class HomeAssistant:
    def __init__(self, config: dict[str, Any], layout_path: Path | None = None,
                 providers: Iterable[Any] = ()):
        self.config = config or {}
        self.url = os.environ.get("HOME_ASSISTANT_URL", "").rstrip("/")
        self.token = os.environ.get("HOME_ASSISTANT_TOKEN", "")
        self.layout_path = layout_path
        self._lock = threading.Lock()
        self.providers = {provider.name: provider for provider in providers if provider.enabled}
        self._base_entities = {}
        for item in self.config.get("entities", []):
            if self.url and self.token and item.get("id") and item.get("entity_id"):
                copied = item.copy()
                copied["provider"] = "home_assistant"
                self._base_entities[item["id"]] = copied
        for provider in self.providers.values():
            for item in provider.entities():
                self._base_entities[item["id"]] = item.copy()
        self._layout = self._read_layout()
        self.entities: dict[str, dict[str, Any]] = {}
        self._rebuild_entities()

    def _read_layout(self) -> dict[str, Any]:
        if not self.layout_path or not self.layout_path.is_file():
            return {"entities": {}, "added": {}, "rooms": []}
        try:
            data = json.loads(self.layout_path.read_text())
            return {"entities": data.get("entities", {}), "added": data.get("added", {}),
                    "rooms": data.get("rooms", [])}
        except (OSError, json.JSONDecodeError):
            log.warning("Ignoring invalid Home dashboard layout file")
            return {"entities": {}, "added": {}, "rooms": []}

    def _save_layout(self) -> None:
        if not self.layout_path:
            return
        temp = self.layout_path.with_suffix(".tmp")
        temp.write_text(json.dumps(self._layout, indent=2) + "\n")
        temp.replace(self.layout_path)

    def _rebuild_entities(self) -> None:
        entities = {key: value.copy() for key, value in self._base_entities.items()}
        for item_id, changes in self._layout["entities"].items():
            if item_id in entities and not changes.get("hidden"):
                entities[item_id].update({key: value for key, value in changes.items() if key != "hidden"})
            elif item_id in entities:
                entities.pop(item_id)
        for item_id, item in self._layout["added"].items():
            entities[item_id] = item.copy()
        self.entities = entities

    @staticmethod
    def _valid_entity_id(entity_id: str) -> bool:
        return bool(re.fullmatch(r"(?:light|switch|sensor)\.[a-z0-9_]+", entity_id))

    @staticmethod
    def _safe_id(value: str) -> str:
        return re.sub(r"[^a-z0-9_]+", "_", value.lower()).strip("_")[:60]

    @property
    def enabled(self) -> bool:
        ha_ready = bool(self.url and self.token and any(
            item.get("provider", "home_assistant") == "home_assistant"
            for item in self.entities.values()))
        return ha_ready or bool(self.providers)

    def public_config(self) -> dict[str, Any]:
        return {"enabled": self.enabled, "configured": bool(self.entities),
                "rooms": self.rooms(),
                "entities": [{k: v for k, v in item.items()
                              if k in {"id", "entity_id", "name", "room", "icon", "type", "read_only", "provider",
                                       "device_id", "device_name"}}
                             for item in self.entities.values()]}

    def rooms(self) -> list[str]:
        return sorted(set(self._layout["rooms"]) | {item.get("room", "Home") for item in self.entities.values()})

    def add_room(self, room: str) -> list[str]:
        room = room.strip()[:60]
        if not room:
            raise ValueError("room name is required")
        with self._lock:
            if room not in self._layout["rooms"]:
                self._layout["rooms"].append(room)
                self._save_layout()
        return self.rooms()

    def rename_room(self, room: str, name: str) -> list[str]:
        name = name.strip()[:60]
        if not name:
            raise ValueError("room name is required")
        with self._lock:
            self._layout["rooms"] = [name if value == room else value for value in self._layout["rooms"]]
            for item_id, item in self.entities.items():
                if item.get("room", "Home") == room:
                    changes = self._layout["entities"].setdefault(item_id, {})
                    changes["room"] = name
            for item in self._layout["added"].values():
                if item.get("room", "Home") == room:
                    item["room"] = name
            self._rebuild_entities()
            self._save_layout()
        return self.rooms()

    def add_entity(self, values: dict[str, Any]) -> dict[str, Any]:
        entity_id = str(values.get("entity_id", "")).strip()
        if not self._valid_entity_id(entity_id):
            raise ValueError("choose a light, switch, or sensor entity ID")
        with self._lock:
            if any(item["entity_id"] == entity_id for item in self.entities.values()):
                raise ValueError("that Home Assistant entity is already on the dashboard")
            item_id = self._safe_id(str(values.get("id") or entity_id.replace(".", "_")))
            if not item_id or item_id in self.entities:
                item_id = f"{entity_id.split('.', 1)[0]}_{len(self.entities) + 1}"
            domain = entity_id.split(".", 1)[0]
            item = {"id": item_id, "entity_id": entity_id,
                    "name": str(values.get("name") or entity_id).strip()[:80],
                    "room": str(values.get("room") or "Home").strip()[:60],
                    "icon": str(values.get("icon") or {"light": "💡", "switch": "🔌", "sensor": "◌"}[domain])[:8],
                    "type": domain, "read_only": domain == "sensor",
                    "provider": "home_assistant"}
            self._layout["added"][item_id] = item
            self._rebuild_entities()
            self._save_layout()
        return item

    def update_entity(self, item_id: str, values: dict[str, Any]) -> dict[str, Any]:
        allowed = {"name", "room", "icon"}
        changes = {key: str(value).strip()[:(80 if key == "name" else 60 if key == "room" else 8)]
                   for key, value in values.items() if key in allowed and value is not None}
        if not changes:
            raise ValueError("no editable fields supplied")
        if any(not value for value in changes.values()):
            raise ValueError("name, room, and icon cannot be empty")
        with self._lock:
            if item_id in self._layout["added"]:
                self._layout["added"][item_id].update(changes)
            elif item_id in self._base_entities:
                self._layout["entities"].setdefault(item_id, {}).update(changes)
            else:
                raise KeyError(item_id)
            self._rebuild_entities()
            self._save_layout()
            return self.entities[item_id]

    def remove_entity(self, item_id: str) -> None:
        with self._lock:
            if item_id in self._layout["added"]:
                self._layout["added"].pop(item_id)
            elif item_id in self._base_entities:
                self._layout["entities"].setdefault(item_id, {})["hidden"] = True
            else:
                raise KeyError(item_id)
            self._rebuild_entities()
            self._save_layout()

    def turn_off_room(self, room: str) -> dict[str, Any]:
        targets = [item_id for item_id, item in self.entities.items()
                   if item.get("room", "Home") == room and not item.get("read_only") and
                   item.get("type", item["entity_id"].split(".", 1)[0]) in {"light", "switch"}]
        errors = []
        for item_id in targets:
            try:
                self.command(item_id, "turn_off")
            except (ValueError, RuntimeError, httpx.HTTPError) as exc:
                errors.append({"id": item_id, "error": str(exc)})
        return {"ok": not errors, "turned_off": targets, "errors": errors}

    def _client(self):
        if not self.url or not self.token:
            raise RuntimeError("Home Assistant is not configured")
        return httpx.Client(base_url=self.url, timeout=8,
                            headers={"Authorization": f"Bearer {self.token}"})

    def states(self) -> list[dict[str, Any]]:
        result = []
        ha_items = [item for item in self.entities.values()
                    if item.get("provider", "home_assistant") == "home_assistant"]
        ha_states = {}
        if ha_items and self.url and self.token:
            try:
                # One bounded request keeps an optional/offline Home Assistant
                # from delaying local providers once per configured entity.
                with httpx.Client(
                        base_url=self.url,
                        timeout=httpx.Timeout(2.0, connect=1.0),
                        headers={"Authorization": f"Bearer {self.token}"}) as client:
                    response = client.get("/api/states")
                    response.raise_for_status()
                    ha_states = {raw.get("entity_id"): raw for raw in response.json()}
            except (httpx.HTTPError, ValueError, TypeError):
                log.warning("Home Assistant unavailable; returning local device states")
        for item in ha_items:
            raw = ha_states.get(item["entity_id"],
                                {"state": "unavailable", "attributes": {}})
            result.append(self._state_record(item, raw.get("state", "unknown"),
                                             raw.get("attributes", {})))
        for provider_name, provider in self.providers.items():
            provider_states = {item["id"]: item for item in provider.states()}
            for item in self.entities.values():
                if item.get("provider") != provider_name:
                    continue
                raw = provider_states.get(item["id"], {"state": "unavailable", "attributes": {}})
                result.append(self._state_record(item, raw["state"], raw.get("attributes", {})))
        return result

    @staticmethod
    def _state_record(item: dict[str, Any], state: str,
                      attributes: dict[str, Any]) -> dict[str, Any]:
        return {"id": item["id"], "entity_id": item["entity_id"],
                "name": item.get("name", item["id"]),
                "room": item.get("room", "Home"),
                "icon": item.get("icon", "⌂"),
                "type": item.get("type", item["entity_id"].split(".")[0]),
                "read_only": item.get("read_only", False),
                "provider": item.get("provider", "home_assistant"),
                "device_id": item.get("device_id"),
                "device_name": item.get("device_name"),
                "state": state, "attributes": attributes}

    def command(self, item_id: str, action: str, data: dict[str, Any] | None = None):
        item = self.entities.get(item_id)
        if not item:
            raise KeyError(item_id)
        provider_name = item.get("provider", "home_assistant")
        if provider_name != "home_assistant":
            provider = self.providers.get(provider_name)
            if not provider:
                raise RuntimeError(f"Device provider {provider_name} is unavailable")
            return provider.command(item_id, action, data)
        domain = item["entity_id"].split(".", 1)[0]
        if domain not in {"light", "switch"}:
            raise ValueError("this entity is read-only")
        allowed = {"turn_on", "turn_off"}
        if domain == "light":
            allowed.add("set")
        if action not in allowed:
            raise ValueError("unsupported action")
        payload: dict[str, Any] = {"entity_id": item["entity_id"]}
        if action == "set":
            data = data or {}
            if "brightness_pct" in data:
                payload["brightness_pct"] = max(1, min(100, int(data["brightness_pct"])))
            if "color_temp_kelvin" in data:
                payload["color_temp_kelvin"] = max(1500, min(6500, int(data["color_temp_kelvin"])))
            if "rgb_color" in data and isinstance(data["rgb_color"], list) and len(data["rgb_color"]) == 3:
                payload["rgb_color"] = [max(0, min(255, int(v))) for v in data["rgb_color"]]
            if "effect" in data and isinstance(data["effect"], str):
                payload["effect"] = data["effect"][:100]
            service = "turn_on"
        else:
            service = action
        with self._client() as client:
            response = client.post(f"/api/services/{domain}/{service}", json=payload)
            response.raise_for_status()
        return {"ok": True}

    def publish_event(self, event) -> None:
        if not self.enabled or not self.config.get("publish_camera_events", False):
            return
        try:
            with self._client() as client:
                response = client.post("/api/events/sarvesh_illam_camera_alert",
                    json={"camera": event.camera, "label": event.label,
                          "kind": event.kind, "state": event.state,
                          "message": event.message, "timestamp": event.ts})
                response.raise_for_status()
        except Exception:
            log.exception("Home Assistant camera event publish failed")
