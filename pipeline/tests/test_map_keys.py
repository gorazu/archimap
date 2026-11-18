import random

from archimap.map_keys import CellModel, decrypt, key_length, map_data, zone_map_data

# A few cells, repeated like on a real map: mostly the same floor and walls.
CELLS = ["HhGaeaaaaa", "Hhaaeaaaaa", "HhN2eaaaaa", "HhGaePliaa", "Hhazeaaaaa", "GhaaeaaadA", "bhGaeaaaaa"]
WEIGHTS = [60, 20, 8, 5, 4, 2, 1]


def fake_map(rng: random.Random, cells: int = 479) -> str:
    """Cells in runs, as maps are drawn: floor areas, walls."""
    out = []
    while len(out) < cells:
        out += [rng.choices(CELLS, WEIGHTS)[0]] * rng.randint(1, 12)
    return "".join(out[:cells])


def encrypt(text: str, key: bytes) -> bytes:
    return bytes(ord(c) ^ key[i % len(key)] for i, c in enumerate(text))


def model() -> CellModel:
    rng = random.Random(1)
    return CellModel([fake_map(rng) for _ in range(200)])


def test_recovers_the_cells_under_a_repeating_key():
    m = model()
    rng = random.Random(2)
    for length in (131, 140, 177, 250):  # 140 and 250: whole cell columns per key byte
        text = fake_map(rng)
        key = bytes(rng.randint(32, 126) for _ in range(length))
        assert decrypt(encrypt(text, key), m) == text, length


def test_the_key_length_is_the_shortest_that_reads_well():
    m = model()
    rng = random.Random(3)
    text = fake_map(rng)
    half = bytes(rng.randint(32, 126) for _ in range(95))
    # Both halves differ by a case change only: 95 bytes pass the alphabet, but read badly.
    key = half + bytes(b ^ 0x20 if chr(b).isalpha() else b for b in half)
    assert key_length(encrypt(text, key), m) == 190


def test_map_data_from_hex_or_plain():
    m = model()
    text = fake_map(random.Random(4))
    key = bytes(random.Random(5).randint(32, 126) for _ in range(160))
    assert map_data(encrypt(text, key).hex(), m) == text
    # Some encrypted files hold the cells as they are.
    assert map_data(text, m) == text
    assert map_data("not cells!", m) is None


def test_a_zone_is_decrypted_with_a_model_of_its_own_maps():
    # A cave: its cells aren't the ones the general model learned.
    cave = ["Hhaaeaaaaa", "HhGaeaaa4H", "HhGaeaaa4I", "Hhaaeaaa4J", "HhGaeaaa4K"]
    rng = random.Random(6)

    def cave_map() -> str:
        out = []
        while len(out) < 479:
            out += [rng.choices(cave, [70, 10, 8, 7, 5])[0]] * rng.randint(1, 12)
        return "".join(out[:479])

    texts = {i: cave_map() for i in range(8)}
    keys = {i: bytes(rng.randint(32, 126) for _ in range(rng.choice([131, 140, 157, 170, 203]))) for i in texts}
    raws = {i: encrypt(t, keys[i]).hex() for i, t in texts.items()}
    readable = [cave_map() for _ in range(3)]
    assert zone_map_data(raws, readable, model()) == texts
