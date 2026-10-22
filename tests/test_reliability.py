from datetime import datetime

from app import reliability

NOW = datetime.fromisoformat("2026-10-22T12:00:00+02:00")


def state(state, begin, end):
    return {"state": state, "begin": begin, "end": end}


def test_night_shutdowns_do_not_count_as_failures():
    data = {"States": [
        state("Disponible", "2026-10-21T05:00:00+02:00", "2026-10-22T12:00:00+02:00"),
        state("Hors-service", "2026-10-20T22:00:00+02:00", "2026-10-21T05:00:00+02:00"),
        state("Disponible", "2026-10-20T06:00:00+02:00", "2026-10-20T22:00:00+02:00"),
    ]}
    rel = reliability.parse(data, now=NOW)
    assert rel["availability"] == 1.0 and rel["outages"] == 0


def test_daytime_failure_lowers_availability():
    data = {"States": [
        state("Disponible", "2026-10-21T12:00:00+02:00", "2026-10-22T12:00:00+02:00"),
        state("Hors-service", "2026-10-21T09:00:00+02:00", "2026-10-21T12:00:00+02:00"),
        state("Disponible", "2026-10-21T06:00:00+02:00", "2026-10-21T09:00:00+02:00"),
    ]}
    rel = reliability.parse(data, now=NOW)
    # daytime window: 21/10 06h-21h (15 h) + 22/10 06h-12h (6 h) = 21 h, 3 h lost
    assert rel["availability"] == round(1 - 3 / 21, 3) and rel["outages"] == 1


def test_latest_failure_is_still_ongoing():
    data = {"States": [
        state("Hors-service", "2026-10-22T09:00:00+02:00", "2026-10-22T09:00:00+02:00"),
        state("Disponible", "2026-10-22T06:00:00+02:00", "2026-10-22T09:00:00+02:00"),
    ]}
    assert reliability.parse(data, now=NOW)["availability"] == 0.5


def test_empty_history():
    assert reliability.parse({"States": []}, now=NOW) is None
    assert reliability.parse({}, now=NOW) is None
