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


def test_stairs_near_walk_block_wheelchair():
    line = [[2.3500, 48.8500], [2.3510, 48.8500]]
    stairs = [{"geometry": {"type": "LineString", "coordinates": [[2.3505, 48.85005], [2.3505, 48.8502]]}}]
    checks = verify.walk_checks(line, "manuel", stairs=stairs)
    assert [c["kind"] for c in checks] == ["stairs"] and checks[0]["effect"] == "bloquant"


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
    assert "60 %" in c["message"] and "11.2" in c["message"] and "4 panne" in c["message"]


def test_reliable_lift_stays_clear():
    rows = [lift("available", "Ligne M1", liftid="a")]
    rel = {"a": {"availability": 0.99, "window_days": 10, "outages": 0, "source": "Dispotrains"}}
    assert verify.lift_check(2.0, 48.0, "T", "Métro", "1", rows, None, "manuel", reliability=rel)["effect"] == "sans_effet"
