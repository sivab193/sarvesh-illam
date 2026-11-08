import struct
import unittest

from service.smarteefi import (
    COMMAND_GET,
    SmarteefiProvider,
    _packet,
    _response,
)


class SmarteefiProtocolTests(unittest.TestCase):
    def test_get_packet_matches_wire_layout(self):
        packet = _packet(COMMAND_GET, "se5100000001", 0x1F)
        self.assertEqual(len(packet), 64)
        self.assertEqual(struct.unpack_from("<H", packet, 0)[0], COMMAND_GET)
        self.assertEqual(packet[24:36], b"se5100000001")
        self.assertEqual(struct.unpack_from("<I", packet, 48)[0], 0x1F)

    def test_response_serial_uses_shifted_offset(self):
        response = bytearray(66)
        struct.pack_into("<H", response, 2, 0x1131)
        response[26:38] = b"se5100000001"
        struct.pack_into("<I", response, 62, 19)
        parsed = _response(bytes(response))
        self.assertIsNotNone(parsed)
        self.assertEqual(parsed["serial"], "se5100000001")
        self.assertEqual(parsed["status_map"], 19)

    def test_provider_creates_five_switches_per_strip(self):
        provider = SmarteefiProvider({"strips": [{
            "id": "hall_strip",
            "serial": "se5100000001",
            "ip": "10.0.0.199",
            "ports": {1: {"name": "Lamp"}},
        }]})
        entities = provider.entities()
        self.assertEqual(len(entities), 5)
        self.assertEqual(entities[0]["id"], "hall_strip_port_1")
        self.assertEqual(entities[0]["name"], "Lamp")
        self.assertEqual(entities[0]["device_id"], "hall_strip")
        self.assertEqual(entities[0]["device_name"], "Smarteefi strip")
        self.assertTrue(all(item["provider"] == "smarteefi" for item in entities))


if __name__ == "__main__":
    unittest.main()
