"""Checks of the visually impaired profile (malvoyant), on small synthetic layers shaped like the open data."""
import json
from datetime import datetime, timezone
from pathlib import Path

from app import profiles, verify

FIX = Path(__file__).resolve().parent.parent / "static" / "fixtures"
DEMO = json.loads((FIX / "navitia_demo.json").read_text())
LIFTS = json.loads((FIX / "lifts_demo.json").read_text())["rows"]
MONDAY = datetime(2026, 10, 19, 10, 0, tzinfo=timezone.utc)
AT = "2026-10-22T06:00:00+00:00"


def layer(rows):
    return {"fetched_at": AT, "rows": rows}


def stop(arrid, lon, lat, kind="metro", audio="true", visual="true", name="Stop"):
    return {"arrid": arrid, "arrname": name, "arrtype": kind, "arraudiblesignals": audio, "arrvisualsigns": visual,
            "arrgeopoint": {"lon": lon, "lat": lat}}


def lv(stops=(), lines=(), assist=(), equip=(), lights=(), sound=(), missing=()):
    raw = {"stop_signals": layer(list(stops)), "line_signals": layer(list(lines)),
           "sncf_assistance": layer(list(assist)), "sncf_equipment": layer(list(equip)),
           "crossing_lights": layer(list(lights)), "sound_modules": layer(list(sound))}
    for k in missing:
        raw[k] = None
    return raw


def idx(**kw):
    return verify.low_vision_index(lv(**kw))


def light(code, lon, lat):
    return {"cod_ouvrag": code, "geo_point_2d": {"lon": lon, "lat": lat}}


# --- profiles -----------------------------------------------------------------

def test_only_the_visually_impaired_profile_gets_these_checks():
    assert verify.cares_about_low_vision("malvoyant")
    for p in ("manuel", "electrique", "poussette", "deambulateur", "valide"):
        assert not verify.cares_about_low_vision(p)


def test_silent_traffic_light_is_a_risk_never_a_block():
    assert profiles.effect("feu_sans_son", "malvoyant") == "genant"
    assert profiles.effect("feu_sans_son", "manuel") == "sans_effet"


# --- stops ---------------------------------------------------------------------

def test_announced_stop_is_ok():
    c = verify.station_audio_check(2.35, 48.86, "Châtelet", "Métro", None, idx(stops=[stop("1", 2.3501, 48.86)]), "malvoyant")
    assert c["status"] == "ok" and c["effect"] == "sans_effet" and c["confidence"] == 3
    assert "announced aloud" in c["message"] and "screens" in c["message"]


def test_stop_without_announcements_is_a_risk():
    c = verify.station_audio_check(2.35, 48.86, "X", "Métro", None,
                                   idx(stops=[stop("1", 2.3501, 48.86, audio="false")]), "malvoyant")
    assert c["status"] == "absent" and c["effect"] == "genant" and c["obstacle"] == "pas_annonce_sonore"


def test_partial_announcements_are_a_risk():
    rows = [stop("1", 2.3501, 48.86, kind="rail", audio="partial"), stop("2", 2.3502, 48.86, kind="rail", audio="unknown")]
    c = verify.station_audio_check(2.35, 48.86, "X", "RER", None, idx(stops=rows), "malvoyant")
    assert c["status"] == "partiel" and c["effect"] == "genant"


def test_only_stops_of_the_same_mode_count():
    # a bus stop with no announcement next to a metro station says nothing about the metro
    rows = [stop("1", 2.3501, 48.86, kind="bus", audio="false")]
    c = verify.station_audio_check(2.35, 48.86, "X", "Métro", None, idx(stops=rows), "malvoyant")
    assert c["status"] == "inconnu" and c["effect"] == "sans_effet" and c["confidence"] == 1


def test_navitia_stop_point_id_wins_over_distance():
    rows = [stop("22092", 2.3600, 48.86, audio="true"), stop("9", 2.3500, 48.86, audio="false")]
    c = verify.station_audio_check(2.35, 48.86, "X", "Métro", "stop_point:IDFM:22092", idx(stops=rows), "malvoyant")
    assert c["status"] == "ok"


def test_missing_stop_layer_degrades_to_unknown():
    c = verify.station_audio_check(2.35, 48.86, "X", "Métro", None, idx(missing=["stop_signals"]), "malvoyant")
    assert c["status"] == "inconnu" and c["effect"] == "sans_effet" and "unavailable" in c["message"]


def test_sncf_list_fills_an_unknown_train_station():
    assist = [{"nom_gare": "Paris Gare de Lyon", "code_uic": 87686030, "typepriseencharge": "RESERVE ET SPONTANE",
               "typetarification": "GRATUIT", "premierauderniertrain": None,
               "position_geographique": {"lon": 2.3735, "lat": 48.8449}, "horaires_jour_nominal_lundi": "06:15 - 01:00"}]
    # different UIC code for the same station: joined on the name
    equip = [{"uic": 87686006, "nom_de_la_gare": "Paris Gare de Lyon", "accessibilite": a}
             for a in ("Information sonore en gare et/ou sur les quais", "Bande d'éveil de vigilance sur les quais")]
    i = idx(stops=[stop("1", 2.3734, 48.8445, kind="rail", audio="unknown")], assist=assist, equip=equip)
    c = verify.station_audio_check(2.3734, 48.8445, "Gare de Lyon", "RER", None, i, "malvoyant")
    assert c["status"] == "ok" and c["source"].startswith("SNCF")
    a = verify.assistance_checks(2.3734, 48.8445, "Gare de Lyon", "RER", i, MONDAY)
    assert [x["kind"] for x in a] == ["assistance", "tactile"]
    assert "book ahead or ask on the spot" in a[0]["message"] and "06:15 - 01:00" in a[0]["message"]
    assert all(x["effect"] == "sans_effet" for x in a)
    # no assistance on Sunday at this (fictitious) station: said plainly, not a risk
    sunday = datetime(2026, 10, 25, 10, 0, tzinfo=timezone.utc)
    assert verify.assistance_checks(2.3734, 48.8445, "Gare de Lyon", "RER", i, sunday)[0]["status"] == "inconnu"
    # metro: SNCF assistance does not apply
    assert verify.assistance_checks(2.3734, 48.8445, "Gare de Lyon", "Métro", i, MONDAY) == []


# --- on board ----------------------------------------------------------------------

def test_onboard_announcements_from_the_line_register():
    lines = [{"id_line": "C01038", "audiblesigns_available": "false"}, {"id_line": "C01039", "audiblesigns_available": "true"},
             {"id_line": "C01040", "audiblesigns_available": "unknown"}]
    i = idx(lines=lines)
    off = verify.onboard_audio_check("C01038", "Bus", "38", i, "malvoyant")
    assert off["status"] == "absent" and off["effect"] == "genant" and off["label"] == "On-board announcements, Bus 38"
    assert verify.onboard_audio_check("C01039", "Bus", "39", i, "malvoyant")["status"] == "ok"
    assert verify.onboard_audio_check("C01040", "Bus", "40", i, "malvoyant") is None  # unknown: no noise
    assert verify.onboard_audio_check(None, "Bus", "41", i, "malvoyant") is None


def test_line_id_read_from_navitia_links():
    assert verify._line_id({"links": [{"type": "line", "id": "line:IDFM:C01371"}]}) == "C01371"
    assert verify._line_id({"display_informations": {"links": [{"type": "line", "id": "line:IDFM:C01742"}]}}) == "C01742"
    assert verify._line_id({}) is None


# --- walks -------------------------------------------------------------------------

WALK = [[2.3500, 48.8500], [2.3530, 48.8500]]


def test_traffic_lights_with_and_without_sound():
    i = idx(lights=[light("S1", 2.3510, 48.85005), light("S1", 2.3511, 48.84995), light("S2", 2.3520, 48.8501),
                    light("S3", 2.3510, 48.8530)],  # S3 is 330 m away: not on this walk
            sound=[{"code_ouvrage": "S1"}])
    c = verify.crossing_check(WALK, i, "malvoyant")
    assert c["status"] == "partiel" and c["effect"] == "genant" and c["obstacle"] == "feu_sans_son"
    # The warning is about the silent crossings, and says what the remote is for.
    assert c["label"] == "Crossings without sound"
    assert c["message"].startswith("1 crossing without sound on this walk; 1 has sound with the universal remote")
    assert "standard remote control" not in c["message"]


def test_all_traffic_lights_audible_is_ok():
    i = idx(lights=[light("S1", 2.3510, 48.85005)], sound=[{"code_ouvrage": "S1"}])
    c = verify.crossing_check(WALK, i, "malvoyant")
    assert c["status"] == "ok" and c["effect"] == "sans_effet" and c["message"].startswith("The crossing on this walk has sound")
    assert c["label"] == "Crossings with sound"


def test_all_crossings_silent_says_so_plainly():
    i = idx(lights=[light("S1", 2.3510, 48.85005), light("S2", 2.3520, 48.8501)], sound=[])
    c = verify.crossing_check(WALK, i, "malvoyant")
    assert c["status"] == "absent" and c["message"].startswith("2 crossings without sound on this walk.")


def test_walk_far_from_any_mapped_light_is_unknown():
    i = idx(lights=[light("S1", 2.40, 48.80)], sound=[])
    c = verify.crossing_check(WALK, i, "malvoyant")
    assert c["status"] == "inconnu" and c["effect"] == "sans_effet" and "inside Paris" in c["message"]


def test_missing_light_layers_degrade_to_unknown():
    c = verify.crossing_check(WALK, idx(missing=["sound_modules"]), "malvoyant")
    assert c["status"] == "inconnu" and c["effect"] == "sans_effet"


# --- whole journeys --------------------------------------------------------------------

def demo_layers():
    j = DEMO["journeys"][0]
    pt = next(s for s in j["sections"] if s["type"] == "public_transport")
    a, b = pt["from"]["stop_point"]["coord"], pt["to"]["stop_point"]["coord"]
    walk = next(s for s in j["sections"] if s["type"] == "street_network")["geojson"]["coordinates"]
    return lv(stops=[stop("1", float(a["lon"]), float(a["lat"])), stop("2", float(b["lon"]), float(b["lat"]), audio="false")],
              lights=[light("S9", walk[1][0], walk[1][1])], sound=[])


def test_journey_gets_low_vision_checks_for_malvoyant():
    it = verify.verify_journey(DEMO["journeys"][0], "malvoyant", LIFTS, low_vision=demo_layers(), now=MONDAY)
    kinds = [c["kind"] for st in it["steps"] for c in st["checks"]]
    assert "audio" in kinds and "crossings" in kinds
    transit = next(st for st in it["steps"] if st["type"] == "transit")
    audio = [c for c in transit["checks"] if c["kind"] == "audio"]
    assert [c["at"] for c in audio] == ["from", "to"] and audio[1]["effect"] == "genant"
    assert transit["verdict"] == "risque" and it["verdict"] == "risque"
    assert not any(c["effect"] == "bloquant" for st in it["steps"] for c in st["checks"])


def test_other_profiles_are_unchanged_by_the_low_vision_layers():
    for p in ("manuel", "electrique", "poussette", "deambulateur", "valide"):
        for j in DEMO["journeys"]:
            with_lv = verify.verify_journey(j, p, LIFTS, low_vision=demo_layers(), now=MONDAY)
            without = verify.verify_journey(j, p, LIFTS, now=MONDAY)
            assert with_lv == without, p


def test_malvoyant_without_layers_keeps_the_previous_result():
    j = DEMO["journeys"][0]
    it = verify.verify_journey(j, "malvoyant", LIFTS, now=MONDAY)
    assert not any(c["kind"] in ("audio", "crossings", "assistance", "tactile") for st in it["steps"] for c in st["checks"])


def test_long_diagonal_walk_is_checked_fast_and_finds_the_same_lights():
    # Hundreds of lights in the bounding box of a 5 km diagonal walk: only those along the path count,
    # and the check must stay well under a second (it took seconds per walk, 28 s per trip).
    import random
    import time
    rnd = random.Random(1)
    idx = {"lights": {}, "sound": set(), "at": {}}
    for i in range(6000):
        x, y = rnd.uniform(2.25, 2.42), rnd.uniform(48.82, 48.90)
        verify._grid_add(idx["lights"], x, y, (x, y, str(i)))
        if i % 3 == 0:
            idx["sound"].add(str(i))
    line = [[2.30 + 0.12 * k / 600 + (0.0002 if k % 2 else 0), 48.84 + 0.04 * k / 600] for k in range(601)]
    t = time.perf_counter()
    out = verify.crossing_check(line, idx, "malvoyant")
    assert time.perf_counter() - t < 0.5
    expected = {c for g in idx["lights"].values() for x, y, c in g
                if verify.point_to_line_m([x, y], line) <= verify.CROSSING_NEAR_M}
    silent = len(expected - idx["sound"])
    assert out["message"].startswith(f"{silent} crossings without sound")
