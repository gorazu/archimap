import cv2

from archimap.models import Box
from archimap.transitions import TransitionConfig, segment
from conftest import black, frames_from, texture

CFG = TransitionConfig()


def test_splits_on_dark_frames():
    images = ([texture(1)] * 5 + [black()] * 2 + [texture(2)] * 4
              + [black()] * 3 + [texture(3)] * 6)
    visits = list(segment(frames_from(images), CFG))
    assert [v.index for v in visits] == [0, 1, 2]
    assert [round(v.start_time * 6) for v in visits] == [0, 7, 14]
    assert [round(v.end_time * 6) for v in visits] == [4, 10, 19]


def test_hard_cut_only_when_enabled():
    images = [texture(1)] * 4 + [texture(2)] * 4
    assert len(list(segment(frames_from(images), CFG))) == 1
    cuts = TransitionConfig(cut_diff=40.0)
    assert len(list(segment(frames_from(images), cuts))) == 2


def test_loading_back_to_same_map_is_one_visit():
    images = [texture(1)] * 4 + [black()] * 3 + [texture(1)] * 4
    (visit,) = segment(frames_from(images), CFG)
    assert round(visit.end_time * 6) == 10


def test_drops_short_segments():
    images = [texture(1)] * 4 + [black()] + [texture(2)] + [black()] + [texture(3)] * 4
    assert len(list(segment(frames_from(images), CFG))) == 2


def test_best_frame_avoids_popup():
    base = texture(5)
    blurry = cv2.GaussianBlur(base, (3, 3), 0)
    # A popup frame: sharp text panel, very different from the rest.
    popup = base.copy()
    cv2.rectangle(popup, (40, 30), (280, 150), (240, 240, 240), -1)
    for y in range(45, 150, 12):
        cv2.putText(popup, "Lorem ipsum dolor", (50, y), cv2.FONT_HERSHEY_PLAIN, 0.8, (0, 0, 0), 1)
    images = [blurry, blurry, popup, base, blurry, blurry]
    (visit,) = segment(frames_from(images), CFG)
    assert (visit.image == base).all()


def test_view_and_coords_boxes():
    images = [texture(1)] * 3
    view, coords = Box(10, 10, 100, 50), Box(0, 0, 40, 20)
    (visit,) = segment(frames_from(images), CFG, view, coords)
    assert visit.image.shape[:2] == (50, 100)
    assert len(visit.coord_crops) == 3
    assert visit.coord_crops[0].shape[:2] == (20, 40)


def test_splits_on_partial_fade():
    """Short fades where no sampled frame is fully dark still split visits."""
    fade = (texture(1) * 0.45).astype("uint8")
    images = [texture(1)] * 4 + [fade] + [texture(2)] * 4
    assert texture(1).mean() * 0.45 > CFG.dark_mean  # not caught by dark_mean alone
    assert len(list(segment(frames_from(images), CFG))) == 2
    no_dips = TransitionConfig(dip_ratio=0)
    assert len(list(segment(frames_from(images), no_dips))) == 1
