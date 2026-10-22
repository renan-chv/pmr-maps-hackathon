import json
from pathlib import Path

from app import verify

FIX = Path(__file__).resolve().parent.parent / "static" / "fixtures"
LIFTS = json.loads((FIX / "lifts_demo.json").read_text())["rows"]
DEMO = json.loads((FIX / "navitia_demo.json").read_text())


def lift(status, direction, situation="", lon=2.0, lat=48.0, liftid="L"):
    return {"liftid": liftid, "zdcid": "1", "zdcname": "Test", "liftstatus": status, "liftdirection": direction,
            "liftsituation": situation, "liftstateupdate": "2026-10-22T07:52", "centroidzdc": {"lon": lon, "lat": lat}}


def test_line_tokens():
    assert verify.line_tokens("Métro", "14") == ["M14", "ligne 14", "L14"]
    assert verify.line_tokens("RER", "A") == ["RER A"]


def test_only_lifts_of_the_line_count():
    rows = [lift("notavailable", "Ligne M4", liftid="a"), lift("available", "Ligne M14", liftid="b")]
    c = verify.lift_check(2.0, 48.0, "Test", "Métro", "14", rows, None, "manuel")
    assert c["status"] == "ok" and c["effect"] == "sans_effet"


def test_all_lifts_down_blocks_wheelchair_not_blind():
    rows = [lift("notavailable", "Ligne M1", liftid="a")]
    assert verify.lift_check(2.0, 48.0, "T", "Métro", "1", rows, None, "manuel")["effect"] == "bloquant"
    assert verify.lift_check(2.0, 48.0, "T", "Métro", "1", rows, None, "malvoyant")["effect"] == "sans_effet"


def test_some_lifts_down_is_a_risk_not_a_block():
    rows = [lift("notavailable", "Ligne M1", liftid="a"), lift("available", "Ligne M1", liftid="b")]
    c = verify.lift_check(2.0, 48.0, "T", "Métro", "1", rows, None, "manuel")
    assert c["status"] == "partiel" and c["effect"] == "genant"


def test_direction_keeps_lifts_of_the_platform():
    rows = [lift("available", "Ligne M2 direction Nation", liftid="a"),
            lift("notavailable", "Ligne M2 direction Porte Dauphine", liftid="b")]
    c = verify.lift_check(2.0, 48.0, "T", "Métro", "2", rows, None, "manuel", direction="Porte Dauphine (Paris)")
    assert c["status"] == "en_panne"


def test_no_lift_data_is_unknown_with_lowest_confidence():
    c = verify.lift_check(2.0, 48.0, "T", "Métro", "1", [], None, "manuel")
    assert c["status"] == "inconnu" and c["confidence"] == 1 and c["effect"] == "genant"


def square(x, y, d=0.00005):
    return {"type": "Polygon", "coordinates": [[[x - d, y - d], [x + d, y - d], [x + d, y + d], [x - d, y + d], [x - d, y - d]]]}


def test_stairs_crossed_by_walk_block_wheelchair():
    line = [[2.3500, 48.8500], [2.3510, 48.8500]]
    checks = verify.walk_checks(line, "manuel", stairs=[{"geometry": square(2.3505, 48.8500)}])
    assert [c["kind"] for c in checks] == ["stairs"] and checks[0]["effect"] == "bloquant"


def test_stairs_beside_the_walk_are_ignored():
    line = [[2.3500, 48.8500], [2.3510, 48.8500]]
    # 8 m north of the walking line: next to it, not on it
    assert verify.walk_checks(line, "manuel", stairs=[{"geometry": square(2.3505, 48.85015)}]) == []


def test_far_works_are_ignored():
    line = [[2.3500, 48.8500], [2.3510, 48.8500]]
    works = [{"geometry": {"type": "Polygon", "coordinates": [[[2.36, 48.86], [2.361, 48.86], [2.361, 48.861]]]}}]
    assert verify.walk_checks(line, "manuel", works=works) == []


def test_demo_journey_blocks_at_esplanade_and_offers_plan_b():
    its = [verify.verify_journey(j, "manuel", LIFTS, it_id=f"it{i + 1}") for i, j in enumerate(DEMO["journeys"])]
    its = verify.pick_plan_b(its)
    assert its[0]["verdict"] == "bloque" and its[0]["blocked_at"] == "Esplanade de la Défense"
    assert its[0]["plan_b_id"] == "it2" and its[1]["verdict"] != "bloque"
    assert verify.blocking_stop_areas(its[0]) == ["stop_area:IDFM:71485"]


def test_demo_journey_passes_for_blind_profile():
    it = verify.verify_journey(DEMO["journeys"][0], "malvoyant", LIFTS)
    assert it["verdict"] != "bloque"


def test_unreliable_lift_warns_even_when_in_service():
    rows = [lift("available", "Ligne M1", liftid="a")]
    rel = {"a": {"availability": 0.6, "window_days": 11.2, "outages": 4, "source": "Dispotrains"}}
    c = verify.lift_check(2.0, 48.0, "T", "Métro", "1", rows, None, "manuel", reliability=rel)
    assert c["status"] == "ok" and c["effect"] == "genant" and c["reliability"] == 0.6
    assert "60%" in c["message"] and "11.2" in c["message"] and "4 outages" in c["message"]


def test_reliable_lift_stays_clear():
    rows = [lift("available", "Ligne M1", liftid="a")]
    rel = {"a": {"availability": 0.99, "window_days": 10, "outages": 0, "source": "Dispotrains"}}
    assert verify.lift_check(2.0, 48.0, "T", "Métro", "1", rows, None, "manuel", reliability=rel)["effect"] == "sans_effet"


def test_lifts_found_by_station_id_even_far_from_centroid():
    rows = [dict(lift("notavailable", "Ligne M1", liftid="a", lon=2.10, lat=48.10), zdcid="71485")]
    c = verify.lift_check(2.0, 48.0, "T", "Métro", "1", rows, None, "manuel", stop_area="stop_area:IDFM:71485")
    assert c["status"] == "en_panne"


def test_crow_fly_line_is_not_checked_for_obstacles():
    j = {"duration": 600, "sections": [{"type": "crow_fly", "duration": 600, "from": {"name": "A"}, "to": {"name": "B"},
                                         "geojson": {"type": "LineString", "coordinates": [[2.3500, 48.85], [2.3510, 48.85]]}}]}
    it = verify.verify_journey(j, "manuel", [], stairs=[{"geometry": square(2.3505, 48.8500)}])
    assert it["verdict"] == "passe"


def _lift_report(liftid, at):
    return {"categorie": "ascenseur_panne", "target_type": "lift", "target_id": liftid, "created_at": at,
            "confirmations": 1, "temporaire": True}


def test_fresh_report_overrides_older_official_status():
    from datetime import datetime, timezone
    now = datetime(2026, 10, 22, 12, 0, tzinfo=timezone.utc)
    rows = [lift("available", "Ligne M1", liftid="a")]  # official update 07:52 Paris
    c = verify.lift_check(2.0, 48.0, "T", "Métro", "1", rows, None, "manuel",
                          reports=[_lift_report("a", "2026-10-22T11:30:00+00:00")], now=now)
    assert c["status"] == "en_panne" and c["effect"] == "bloquant" and c["confidence"] == 2
    assert "Signalement" in c["source"] and "plus récent" in c["source"]


def test_report_older_than_official_update_is_ignored():
    from datetime import datetime, timezone
    now = datetime(2026, 10, 22, 12, 0, tzinfo=timezone.utc)
    rows = [lift("available", "Ligne M1", liftid="a")]  # official 07:52 Paris = 05:52 UTC
    c = verify.lift_check(2.0, 48.0, "T", "Métro", "1", rows, None, "manuel",
                          reports=[_lift_report("a", "2026-10-22T05:00:00+00:00")], now=now)
    assert c["status"] == "ok"


def test_report_older_than_a_day_no_longer_overrides():
    from datetime import datetime, timezone
    now = datetime(2026, 10, 23, 12, 0, tzinfo=timezone.utc)
    rows = [lift("available", "Ligne M1", liftid="a")]
    c = verify.lift_check(2.0, 48.0, "T", "Métro", "1", rows, None, "manuel",
                          reports=[_lift_report("a", "2026-10-22T09:00:00+00:00")], now=now)
    assert c["status"] == "ok"
