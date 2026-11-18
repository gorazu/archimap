"""Read encrypted map files ("<id>_<date>X.swf") without their key.

Their mapData is the usual cell text (10 characters per cell, from a
64-character alphabet) XORed with a repeating key, written in hex. The key
isn't in the client: the game server sends it. But the cell text is very
regular, so the key can be worked out from the data alone:

1. Each key byte, for a given key length: among the values turning all
   the bytes it covers into characters of the alphabet, the one whose
   characters are the most likely, from how often each character appears
   at each place of a cell in the client's readable maps.
2. Key length: the shortest one giving text about as likely as twice that
   length. Multiples of it fit as well, and a wrong length can pass the alphabet
   (key bytes differing by a case change still give letters), but its
   text is far less likely.
3. Then each key byte again, now from the characters around the ones it
   gives (the cell before, the same cell's neighbouring characters),
   which come from other key bytes: maps repeat cells a lot. A few rounds
   settle the bytes the frequencies alone couldn't tell.
4. When the key length shares a factor with the cell size, a whole column
   of cells can be changed alike and still read well (see
   _settle_columns): whole cells, as seen in readable maps, settle it.
5. Within a zone, all over again with a model of the zone's own maps
   (zone_map_data): a cave's cells aren't like a town's.

Checked on 307 of the maps that also have a readable version (older,
usually the same): 303 decrypt to it, give or take edits to the map.
"""

from __future__ import annotations

import math
from collections import Counter
from functools import lru_cache
from pathlib import Path

ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_"
CELL = 10
_CODES = [ord(c) for c in ALPHABET]
_ALLOWED = frozenset(_CODES)
_ROUNDS = 4
# Mean log-probability per character: the right key length reads about this close to its double.
_LENGTH_MARGIN = 1.0
# Maps needed for a zone's own model.
_ZONE_MIN = 5


class CellModel:
    """How likely each character is at each place of a cell: alone, after
    the cell before's character at that place, and after the previous
    character of the same cell. Learned from readable map data."""

    def __init__(self, samples: list[str]):
        alone = [Counter() for _ in range(CELL)]
        above = [Counter() for _ in range(CELL)]  # (previous cell's char, char)
        before = [Counter() for _ in range(CELL)]  # (previous char in the cell, char)
        cells = Counter()
        for data in samples:
            cells.update(data[i:i + CELL] for i in range(0, len(data) - CELL + 1, CELL))
            for i, ch in enumerate(data):
                pos = i % CELL
                alone[pos][ch] += 1
                if i >= CELL:
                    above[pos][(data[i - CELL], ch)] += 1
                if pos:
                    before[pos][(data[i - 1], ch)] += 1
        self.alone = [_log_table(c) for c in alone]
        self.above = [_pair_table(c) for c in above]
        self.before = [_pair_table(c) for c in before]
        # Whole cells, for what the characters around can't tell.
        total = sum(cells.values())
        self.cells = {cell: math.log(n / total) for cell, n in cells.items()}
        self.unseen_cell = math.log(0.5 / total)

    def cell_score(self, text: bytes) -> float:
        """How likely the cells of a text are, as whole cells."""
        return sum(self.cells.get(text[i:i + CELL].decode(), self.unseen_cell) for i in range(0, len(text) - CELL + 1, CELL))


def _log_table(counts: Counter) -> dict[int, float]:
    total = sum(counts.values()) + len(ALPHABET)
    return {ord(ch): math.log((counts[ch] + 1) / total) for ch in ALPHABET}


def _pair_table(counts: Counter) -> dict[int, dict[int, float]]:
    """log P(char | previous), smoothed so unseen pairs stay possible."""
    rows: dict[str, Counter] = {}
    for (prev, ch), n in counts.items():
        rows.setdefault(prev, Counter())[ch] = n
    return {ord(prev): _log_table(row) for prev, row in rows.items()}


@lru_cache(maxsize=4)
def model_from_maps(maps_dir: Path, every: int = 8) -> CellModel:
    """A model learned from every `every`-th readable map file."""
    from .client_maps import swf_variables

    plain = sorted(p for p in maps_dir.glob("*.swf") if not p.stem.endswith("X"))
    return CellModel([str(swf_variables(p)["mapData"]) for p in plain[::every]])


def _frequency_key(cipher: bytes, length: int, model: CellModel) -> tuple[float, list[list[int]], list[int]] | None:
    """For a key length: the key bytes possible at each place, the most
    likely one by character frequencies, and how likely the text then is
    (mean log-probability per character). None if some key byte can't fit."""
    n = len(cipher)
    options, key, total = [], [], 0.0
    for r in range(length):
        values = _possible_bytes(cipher, length, r)
        if not values:
            return None
        scored = [(sum(model.alone[i % CELL][cipher[i] ^ k] for i in range(r, n, length)), k) for k in values]
        best, k = max(scored)
        options.append(values)
        key.append(k)
        total += best
    return total / n, options, key


def key_length(cipher: bytes, model: CellModel) -> int | None:
    """The key length."""
    found = _find_key(cipher, model)
    return found[0] if found else None


def _find_key(cipher: bytes, model: CellModel) -> tuple[int, list[list[int]], list[int]] | None:
    """The shortest key length giving text about as likely as twice that
    length, with its possible and most likely key bytes. Multiples of the
    right length fit too (a little better: more freedom), and so can a
    wrong length (key bytes differing by a case change still give
    letters), but its text is then far less likely than at its double."""
    # At least 4 bytes per key byte, for the frequencies to mean something.
    for length in range(2, len(cipher) // 4 + 1):
        found = _frequency_key(cipher, length, model)
        if not found:
            continue
        double = _frequency_key(cipher, 2 * length, model) if 2 * length <= len(cipher) // 2 else None
        if not double or found[0] >= double[0] - _LENGTH_MARGIN:
            return length, found[1], found[2]
    return None


def _possible_bytes(cipher: bytes, length: int, r: int) -> list[int]:
    """Key byte values giving alphabet characters for all bytes at r, r + length, …"""
    values = [k for k in range(256) if cipher[r] ^ k in _ALLOWED]
    for i in range(r + length, len(cipher), length):
        values = [k for k in values if cipher[i] ^ k in _ALLOWED]
        if not values:
            break
    return values


def decrypt(cipher: bytes, model: CellModel) -> str | None:
    """The cell text under the encrypted data, or None if no key fits."""
    found = _find_key(cipher, model)
    if not found:
        return None
    length, options, key = found
    n = len(cipher)
    text = bytearray(c ^ key[i % length] for i, c in enumerate(cipher))

    def fit(i: int, ch: int) -> float:
        """How well character ch at i fits the characters around it."""
        pos = i % CELL
        score = 0.0
        if i >= CELL:
            score += model.above[pos].get(text[i - CELL], model.alone[pos])[ch]
        if i + CELL < n:
            nxt = text[i + CELL]
            score += model.above[pos].get(ch, model.alone[pos])[nxt]
        if pos:
            score += model.before[pos].get(text[i - 1], model.alone[pos])[ch]
        if pos < CELL - 1 and i + 1 < n:
            score += model.before[pos + 1].get(ch, model.alone[pos + 1])[text[i + 1]]
        return score

    for _ in range(_ROUNDS):
        changed = False
        for r, values in enumerate(options):
            if len(values) == 1:
                continue
            k = max(values, key=lambda k: sum(fit(i, cipher[i] ^ k) for i in range(r, n, length)))
            if k != key[r]:
                key[r] = k
                changed = True
                for i in range(r, n, length):
                    text[i] = cipher[i] ^ k
        if not changed:
            break
    _settle_columns(cipher, length, options, key, text, model)
    return text.decode()


def _settle_columns(cipher: bytes, length: int, options: list[list[int]], key: list[int], text: bytearray,
                    model: CellModel) -> None:
    """When the key length shares a factor with the cell size (140 for 10),
    each key byte only covers some places of a cell, and the same change to
    all the key bytes of those places gives text just as consistent around
    each character ('a' for 'G' on a whole column: no wall instead of
    floor). Whole cells tell them apart: keep the change giving the most
    likely ones."""
    step = math.gcd(length, CELL)
    if step == 1:
        return
    for column in range(step):
        group = range(column, length, step)
        changes = set.intersection(*({k ^ key[r] for k in options[r]} for r in group))
        best, best_score = 0, model.cell_score(bytes(text))
        for change in changes - {0}:
            trial = bytearray(text)
            for r in group:
                for i in range(r, len(cipher), length):
                    trial[i] ^= change
            score = model.cell_score(bytes(trial))
            if score > best_score:
                best, best_score = change, score
        if best:
            for r in group:
                key[r] ^= best
                for i in range(r, len(cipher), length):
                    text[i] ^= best


def zone_map_data(raws: dict[int, str], readable: list[str], model: CellModel) -> dict[int, str | None]:
    """Readable mapData of a zone's encrypted maps. Maps of a zone look alike
    (a cave's cells aren't a town's), so they're decrypted again with a
    model of the zone's own maps, when it has enough: its readable maps and
    the encrypted ones decrypted first with the general model, except those
    whose key length is a multiple of the cell size (see _settle_columns).
    Checked on maps with a readable version: never worse, and for those key
    lengths, far fewer wrong characters."""
    first = {i: map_data(raw, model) for i, raw in raws.items()}
    samples = list(readable)
    for i, text in first.items():
        if text is None:
            continue
        try:
            found = _find_key(bytes.fromhex(raws[i]), model)
        except ValueError:
            found = (1, [], [])  # plain data
        if found and found[0] % CELL:
            samples.append(text)
    if len(samples) < _ZONE_MIN:
        return first
    local = CellModel(samples)
    return {i: map_data(raw, local) for i, raw in raws.items()}


def map_data(raw: str, model: CellModel) -> str | None:
    """Readable mapData from an encrypted file's: decrypted when hex (some
    'encrypted' files hold plain data)."""
    try:
        cipher = bytes.fromhex(raw)
    except ValueError:
        return raw if set(raw) <= set(ALPHABET) else None
    return decrypt(cipher, model)
