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
    assert "report" in c["source"] and "newer" in c["source"]


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


def test_photo_report_near_station_makes_a_working_lift_risky():
    from datetime import datetime, timezone
    now = datetime(2026, 10, 22, 12, 0, tzinfo=timezone.utc)
    rows = [lift("available", "Ligne M1", liftid="a", lon=2.0, lat=48.0)]
    photo = {"id": 7, "categorie": "ascenseur_panne", "target_type": "photo", "target_id": None,
             "lon": 2.0003, "lat": 48.0002, "created_at": "2026-10-22T11:40:00+00:00", "confirmations": 1}
    c = verify.lift_check(2.0, 48.0, "T", "Métro", "1", rows, None, "manuel", reports=[photo], now=now)
    assert c["status"] == "signale" and c["effect"] == "genant" and c["report_id"] == 7
    far = {**photo, "lon": 2.05}
    assert verify.lift_check(2.0, 48.0, "T", "Métro", "1", rows, None, "manuel", reports=[far], now=now)["status"] == "ok"


def test_zero_length_hop_inside_a_station_is_dropped():
    sec = lambda **k: {"type": "public_transport", "duration": k.get("d", 0), "display_informations": {"code": "14", "commercial_mode": "Métro"},
                       "from": {"name": k["a"], "stop_point": {"coord": {"lon": "2.34", "lat": "48.85"}}},
                       "to": {"name": k["b"], "stop_point": {"coord": {"lon": "2.34", "lat": "48.85"}}}}
    j = {"duration": 600, "sections": [sec(a="Châtelet", b="Châtelet", d=-60), sec(a="Châtelet", b="Bercy", d=540)]}
    it = verify.verify_journey(j, "manuel", [], None)
    assert [(s["from"], s["to"]) for s in it["steps"]] == [("Châtelet", "Bercy")]


def test_several_worksites_on_one_walk_give_one_calm_line():
    line = [[2.3500, 48.8500], [2.3530, 48.8500]]
    works = [{"geometry": square(x, 48.8500), "properties": {"summary": "Gas works", "end": "2026-11-03"}}
             for x in (2.3505, 2.3512, 2.3520)]
    checks = verify.walk_checks(line, "manuel", works=works)
    assert len(checks) == 1
    c = checks[0]
    assert c["kind"] == "works" and c["count"] == 3 and c["effect"] == "sans_effet" and c["status"] == "info"
    assert c["message"].startswith("3 roadworks on the sidewalk along this walk; usually passable")


def test_roadworks_alone_do_not_make_a_trip_risky():
    walk = {"type": "street_network", "duration": 120, "from": {"name": "A"}, "to": {"name": "B"},
            "geojson": {"type": "LineString", "coordinates": [[2.3500, 48.85], [2.3530, 48.85]]}}
    works = [{"geometry": square(2.3505, 48.8500), "properties": {"summary": "Works"}}]
    it = verify.verify_journey({"duration": 120, "sections": [walk]}, "manuel", [], works=works)
    assert it["verdict"] == "passe" and it["steps"][0]["checks"][0]["kind"] == "works"


def test_roadworks_not_shown_to_the_helper_profile():
    line = [[2.3500, 48.8500], [2.3530, 48.8500]]
    assert verify.walk_checks(line, "valide", works=[{"geometry": square(2.3505, 48.8500)}]) == []


def _walk_of(m):
    # west-east line of about m metres at Paris latitude
    return [[2.35, 48.85], [2.35 + m / (111320 * 0.6578), 48.85]]


def test_long_walk_follows_the_profile_thresholds():
    assert verify.walk_checks(_walk_of(479), "manuel") == []  # was "479 m on foot" for everyone
    c = verify.walk_checks(_walk_of(863), "deambulateur")[0]
    assert c["effect"] == "genant" and " m to walk: plan a rest" in c["message"] and c["confidence"] is None
    c = verify.walk_checks(_walk_of(900), "manuel")[0]
    assert c["effect"] == "genant" and " m to roll" in c["message"]
    c = verify.walk_checks(_walk_of(1200), "deambulateur")[0]
    assert c["effect"] == "bloquant" and abs(c["length_m"] - 1200) < 10 and "too far" in c["message"]
    assert verify.walk_checks(_walk_of(3000), "malvoyant") == []


def _blocked(it_id, checks, minutes=30):
    return {"id": it_id, "verdict": "bloque", "duration_min": minutes, "blocked_reason": checks[0]["label"],
            "steps": [{"checks": checks}]}


def test_way_out_points_to_the_least_blocked_option():
    lift_down = {"kind": "lift", "effect": "bloquant", "label": "Line 1 elevator"}
    walk = {"kind": "walk", "effect": "bloquant", "label": "Long walk", "length_m": 1100}
    longer = {**walk, "length_m": 1600}
    its = [_blocked("it1", [lift_down]), _blocked("it2", [longer]), _blocked("it3", [walk], minutes=50)]
    w = verify.way_out(its, "deambulateur")
    assert w["least_blocked_id"] == "it3" and w["try_other_time"] and w["pam"] is True
    assert verify.way_out(its, "poussette")["pam"] is False  # PAM is not for strollers


def test_no_way_out_needed_when_one_option_works():
    ok = {"id": "it2", "verdict": "risque", "duration_min": 40, "steps": []}
    lift_down = {"kind": "lift", "effect": "bloquant", "label": "Line 1 elevator"}
    assert verify.way_out([_blocked("it1", [lift_down]), ok], "manuel") is None
    assert verify.way_out([], "manuel") is None
