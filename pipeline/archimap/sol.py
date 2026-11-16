"""Minimal reader for Flash shared objects (.sol files, AMF0 encoding).

The Dofus Retro client caches its game data (maps, sub-areas...) as
shared objects; this is enough to read them.
"""

from __future__ import annotations

import struct
from pathlib import Path
from typing import Any


class _Reader:
    def __init__(self, data: bytes):
        self.data = data
        self.pos = 0

    def take(self, n: int) -> bytes:
        self.pos += n
        return self.data[self.pos - n:self.pos]

    def u8(self) -> int:
        return self.take(1)[0]

    def u16(self) -> int:
        return struct.unpack(">H", self.take(2))[0]

    def u32(self) -> int:
        return struct.unpack(">I", self.take(4))[0]

    def text(self, n: int) -> str:
        return self.take(n).decode("utf-8", "replace")

    def properties(self) -> dict[str, Any]:
        out = {}
        while True:
            key = self.text(self.u16())
            if key == "" and self.data[self.pos] == 0x09:  # object end marker
                self.pos += 1
                return out
            out[key] = self.value()

    def value(self) -> Any:
        kind = self.u8()
        if kind == 0x00:
            return struct.unpack(">d", self.take(8))[0]
        if kind == 0x01:
            return bool(self.u8())
        if kind == 0x02:
            return self.text(self.u16())
        if kind == 0x03:
            return self.properties()
        if kind in (0x05, 0x06):
            return None
        if kind == 0x08:  # ECMA array: count, then properties
            self.u32()
            return self.properties()
        if kind == 0x0A:
            return [self.value() for _ in range(self.u32())]
        if kind == 0x0B:  # date: not needed
            self.take(10)
            return None
        if kind == 0x0C:
            return self.text(self.u32())
        if kind == 0x10:  # typed object: class name, then properties
            self.text(self.u16())
            return self.properties()
        raise ValueError(f"unsupported AMF0 type 0x{kind:02x} at byte {self.pos - 1}")


def read_sol(path: Path) -> dict[str, Any]:
    reader = _Reader(path.read_bytes())
    reader.pos = 16  # header: magic, size, "TCSO", padding
    reader.text(reader.u16())  # shared object name
    reader.take(4)  # AMF version
    out = {}
    while reader.pos < len(reader.data):
        key = reader.text(reader.u16())
        out[key] = reader.value()
        reader.take(1)  # trailing zero after each entry
    return out
