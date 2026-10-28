"""What the iOS / Android app and App Store review need from the backend.

CORS for the native shells, readable trip errors (no raw PRIM body), account deletion (guideline 5.1.1(v)),
moderation of community reports (guideline 1.2: flag, hide, author hash, word filter).
Database flows run on an in-memory fake (tests/fakedb.py) and, when TEST_DATABASE_URL is set, on PostgreSQL.
"""
import base64
import os
import time

import httpx
import pytest
from fastapi.testclient import TestClient

from app import db, limits, main, moderation, reports, sources, verify
from tests import fakedb

client = TestClient(main.app)  # no `with`: no startup (poller, warm-up)
REPORT = {"categorie": "escalier", "temporaire": False, "gravite": "bloquant", "confiance": 0.9,
          "description": "Escalier sans rampe", "lat": 48.8874, "lon": 2.2504}
BBOX = "2.24,48.88,2.26,48.89"


# --- CORS (native shells) -------------------------------------------------------

@pytest.mark.parametrize("origin", ["capacitor://localhost", "https://localhost", "http://localhost"])
def test_preflight_allows_the_native_origins(origin):
    r = client.options("/api/users/12", headers={
        "Origin": origin, "Access-Control-Request-Method": "DELETE",
        "Access-Control-Request-Headers": "content-type, x-user-token"})
    assert r.status_code == 200
    assert r.headers["access-control-allow-origin"] == origin
    allowed = {m.strip() for m in r.headers["access-control-allow-methods"].split(",")}
    assert {"GET", "POST", "DELETE", "OPTIONS"} <= allowed
    headers = r.headers["access-control-allow-headers"].lower()
    assert "x-user-token" in headers and "content-type" in headers
    assert "access-control-allow-credentials" not in r.headers


def test_simple_request_from_the_ios_app_gets_cors_headers():
    r = client.get("/health", headers={"Origin": "capacitor://localhost"})
    assert r.status_code == 200 and r.headers["access-control-allow-origin"] == "capacitor://localhost"


@pytest.mark.parametrize("origin", ["https://evil.example", "capacitor://evil", "http://localhost:8000"])
def test_other_origins_are_not_allowed(origin):
    r = client.options("/api/reports", headers={"Origin": origin, "Access-Control-Request-Method": "POST"})
    assert r.status_code == 400 and "access-control-allow-origin" not in r.headers
    assert "access-control-allow-origin" not in client.get("/health", headers={"Origin": origin}).headers


def test_same_origin_web_app_is_unchanged():
    r = client.get("/health")
    assert r.status_code == 200 and "access-control-allow-origin" not in r.headers


def test_errors_carry_cors_headers_too(monkeypatch):
    """The app can only read an error's detail if the error has CORS headers (even an unexpected 500)."""
    r = client.get("/api/journey", params={"from": "a", "to": "b", "profile": "licorne"},
                   headers={"Origin": "capacitor://localhost"})
    assert r.status_code == 400 and r.headers["access-control-allow-origin"] == "capacitor://localhost"

    def boom():
        raise RuntimeError("bug")
    monkeypatch.setattr(main.sources, "stairs", boom)
    r = TestClient(main.app, raise_server_exceptions=False).get("/api/stairs", headers={"Origin": "capacitor://localhost"})
    assert r.status_code == 500 and r.json()["code"] == "internal" and "bug" not in r.text
    assert r.headers["access-control-allow-origin"] == "capacitor://localhost"


def test_validation_errors_are_one_readable_sentence():
    r = client.get("/api/suggest", params={"q": "a"})
    assert r.status_code == 422 and isinstance(r.json()["detail"], str) and "q" in r.json()["detail"]
    assert r.json()["code"] == "invalid"


# --- Journey errors: never the raw PRIM body ----------------------------------------

class PrimResp:
    def __init__(self, status, body=None, text=None):
        self.status_code, self._body = status, body
        self.text = text if text is not None else str(body)

    def json(self):
        if self._body is None:
            raise ValueError("not json")
        return self._body


NO_SOLUTION = {"context": {"current_datetime": "20261023T164809", "timezone": "Europe/Paris"}, "disruptions": [],
               "error": {"id": "no_solution", "message": "no solution found for this journey"}}


@pytest.fixture
def live(monkeypatch):
    """Live journey route with a fake PRIM key; set `answer` to what PRIM returns (or an exception)."""
    state = {"answer": PrimResp(404, NO_SOLUTION), "calls": 0}

    def fake_get(url, **kw):
        state["calls"] += 1
        assert url == main.PRIM_JOURNEYS
        if isinstance(state["answer"], Exception):
            raise state["answer"]
        return state["answer"]

    monkeypatch.setattr(main, "PRIM_API_KEY", "test-key")
    monkeypatch.setattr(main.httpx, "get", fake_get)
    monkeypatch.setattr(main.sources, "lifts", lambda: {"rows": [], "fetched_at": "2026-10-23T16:00:00+00:00"})
    return state


LOUVRE, DEFENSE = "2.3364,48.8606", "2.2382,48.8918"


def journey(profile="manuel", **extra):
    return client.get("/api/journey", params={"from": LOUVRE, "to": DEFENSE, "profile": profile, **extra},
                      headers={"Origin": "capacitor://localhost"})


def test_prim_no_solution_is_a_404_no_route(live):
    r = journey()
    assert r.status_code == 404
    body = r.json()
    assert body["code"] == "no_route" and body["reason"] == "no_solution"
    assert body["detail"] == "IDFM ne trouve aucun trajet sans marche à cette heure-là. Essayez une autre heure."
    assert "context" not in r.text and "PRIM a répondu" not in r.text and "PRIM answered" not in r.text  # nothing of the upstream body
    assert r.headers["access-control-allow-origin"] == "capacitor://localhost"


def test_no_solution_for_a_profile_that_can_take_stairs_does_not_say_step_free(live):
    body = journey(profile="malvoyant").json()
    assert body["code"] == "no_route" and "sans marche" not in body["detail"]


@pytest.mark.parametrize("error_id", ["no_origin", "no_destination", "no_origin_nor_destination", "date_out_of_bounds"])
def test_other_no_trip_answers_are_no_route(live, error_id):
    live["answer"] = PrimResp(404, {"error": {"id": error_id, "message": "x"}})
    r = journey()
    assert r.status_code == 404 and r.json()["code"] == "no_route" and r.json()["reason"] == error_id


def test_prim_200_without_journeys_is_no_route(live):
    live["answer"] = PrimResp(200, {"journeys": []})
    assert journey().json()["code"] == "no_route"


@pytest.mark.parametrize("answer", [
    PrimResp(500, None, text="<html>Internal error with stack trace</html>"),
    PrimResp(401, {"message": "Invalid key"}),
    PrimResp(502, {"error": {"id": "internal_error"}}),
    PrimResp(429, {"message": "quota"}),
    httpx.ReadTimeout("timed out"),
    httpx.ConnectError("refused"),
])
def test_other_upstream_failures_are_503_upstream_in_plain_words(live, answer):
    live["answer"] = answer
    r = journey()
    assert r.status_code == 503
    body = r.json()
    assert body["code"] == "upstream" and set(body) == {"detail", "code"}
    assert "Réessayez" in body["detail"]
    for leak in ("stack trace", "Invalid key", "quota", "internal_error", "refused", "test-key"):
        assert leak not in r.text


def test_prim_timeout_is_bounded(live, monkeypatch):
    seen = {}
    monkeypatch.setattr(main.httpx, "get", lambda url, **kw: seen.update(kw) or PrimResp(404, NO_SOLUTION))
    journey()
    assert seen["timeout"].read <= 30 and seen["timeout"].connect <= 10


def test_plan_b_failure_keeps_the_blocked_itineraries(live, monkeypatch):
    calls = []

    def navitia(a, b, forbidden=(), **kw):
        calls.append(tuple(forbidden))
        if forbidden:
            raise main.ApiError(404, "no", "no_route")
        return [{"sections": []}]
    monkeypatch.setattr(main, "_navitia", navitia)
    monkeypatch.setattr(main, "_check_all", lambda js, *a, prefix="it", **k: [
        {"id": f"{prefix}1", "verdict": "bloque", "confidence": 3, "duration_min": 10, "steps": []}])
    monkeypatch.setattr(main.verify, "blocking_stop_areas", lambda it: ["stop_area:X"])
    r = journey()
    assert r.status_code == 200 and calls == [(), ("stop_area:X",)] and r.json()["itineraries"][0]["id"] == "it1"


@pytest.mark.parametrize("point", ["0,0", "48.8606,2.3364", "nan,nan", "5.37,43.30"])
def test_points_outside_ile_de_france_are_a_400(live, point):
    r = client.get("/api/journey", params={"from": point, "to": DEFENSE})
    assert r.status_code == 400 and r.json()["code"] == "outside_area"
    assert live["calls"] == 0  # PRIM is not asked (1000 calls a day)


def test_journey_without_lift_data_is_a_503_not_a_trip_shown_as_fine(live, monkeypatch):
    live["answer"] = PrimResp(200, {"journeys": [{"sections": []}]})

    def down():
        raise httpx.ConnectError("idfm down")
    monkeypatch.setattr(main.sources, "lifts", down)
    r = journey()
    assert r.status_code == 503 and r.json()["code"] == "upstream"
    assert client.get("/api/lifts").status_code == 503


def test_geocoder_down_is_a_503(monkeypatch, live):
    def down(q):
        raise httpx.ConnectError("ign down")
    monkeypatch.setattr(main.sources, "geocode", down)
    r = client.get("/api/journey", params={"from": "Gare de Lyon", "to": DEFENSE})
    assert r.status_code == 503 and r.json()["code"] == "upstream"
    assert client.get("/api/geocode", params={"q": "Gare de Lyon"}).status_code == 503


def test_overlong_journey_text_is_refused(live):
    assert client.get("/api/journey", params={"from": "x" * 500, "to": DEFENSE}).status_code == 422


# --- Places: a time budget instead of a 70 s request ---------------------------------

def test_world_sized_bbox_is_refused_before_listing_tiles():
    t = time.perf_counter()
    r = client.get("/api/places", params={"bbox": "-180,-90,180,90"})
    assert r.status_code == 400 and time.perf_counter() - t < 1


@pytest.mark.parametrize("bbox", ["nan,48,2,49", "2,48,inf,49", "2.4,48.8,2.3,48.9", "a,b,c,d"])
def test_bad_bbox_is_a_400(bbox):
    assert client.get("/api/places", params={"bbox": bbox}).status_code == 400
    assert client.get("/api/bus-stops", params={"bbox": bbox}).status_code == 400


def place_row(i, lon, lat):
    return {"id": f"p{i}", "name": f"Place {i}", "longitude": lon, "latitude": lat, "entree_plain_pied": True}


def test_slow_tiles_give_a_partial_answer_that_is_not_cached(monkeypatch):
    monkeypatch.setattr(main, "PLACES_BUDGET_S", 0.3)
    loaded = set()  # like sources.cached: a tile loaded once is answered at once

    def tile(tx, ty):
        if tx == 233 and (tx, ty) not in loaded:
            time.sleep(1.0)  # cold tile on a slow Acceslibre
        loaded.add((tx, ty))
        return {"fetched_at": "2026-10-23T16:00:00+00:00", "rows": [place_row(tx, tx * 0.01 + 0.005, ty * 0.01 + 0.005)]}
    monkeypatch.setattr(main.sources, "places_tile", tile)
    t = time.perf_counter()
    r = client.get("/api/places", params={"bbox": "2.335,48.851,2.345,48.855"})  # tiles 233 and 234
    assert time.perf_counter() - t < 0.9
    assert r.status_code == 200 and r.json()["meta"]["incomplete"] is True and r.json()["meta"]["missing_tiles"] == 1
    assert len(r.json()["features"]) == 1 and r.headers["cache-control"] == "no-store"
    time.sleep(1.0)  # the slow tile went on loading in the background
    full = client.get("/api/places", params={"bbox": "2.335,48.851,2.345,48.855"})
    assert full.json()["meta"]["incomplete"] is False and "s-maxage" in full.headers["cache-control"]


def test_no_tile_ready_is_a_503_to_retry(monkeypatch):
    monkeypatch.setattr(main, "PLACES_BUDGET_S", 0.1)
    monkeypatch.setattr(main.sources, "places_tile", lambda tx, ty: time.sleep(0.5) or {"fetched_at": "x", "rows": []})
    r = client.get("/api/places", params={"bbox": "2.501,48.801,2.502,48.802"})
    assert r.status_code == 503 and r.json()["code"] == "upstream" and r.headers["retry-after"] == "5"


def test_failed_tiles_never_crash_the_route(monkeypatch):
    def tile(tx, ty):
        raise httpx.ReadTimeout("acceslibre 504")
    monkeypatch.setattr(main.sources, "places_tile", tile)
    r = client.get("/api/places", params={"bbox": "2.601,48.801,2.602,48.802"})
    assert r.status_code == 503 and r.json()["code"] == "upstream"


def test_background_work_runs_once_per_key():
    runs = []

    def slow():
        runs.append(1)
        time.sleep(0.2)
        return 42
    futs = [sources.in_background("test-once", slow) for _ in range(5)]
    assert {f.result() for f in futs} == {42} and len(runs) == 1


def test_slow_place_search_is_a_503_not_a_30_s_wait(monkeypatch):
    from app import search
    monkeypatch.setattr(search, "SEARCH_BUDGET_S", 0.2)
    monkeypatch.setattr(sources, "_get_json", lambda *a, **k: time.sleep(1) or {"data": []})
    t = time.perf_counter()
    r = client.get("/api/places/search", params={"q": "boulangerie lente"})
    assert r.status_code == 503 and time.perf_counter() - t < 0.8


def test_photo_id_is_checked():
    assert client.get("/api/photo", params={"lat": 48.85, "lon": 2.35, "id": "../../etc/passwd"}).status_code == 422
    assert client.get("/api/photo", params={"lat": 1000, "lon": 2.35}).status_code == 422


def test_disk_cache_names_never_come_from_user_text():
    assert sources._disk("psearch_../../x").name.startswith("h_")
    assert sources._disk("psearch_café de flore").name.startswith("h_")
    assert sources._disk("places_233_4885").name == "places_233_4885.json"


# --- Verification engine ----------------------------------------------------------------

def test_low_vision_index_is_built_once_per_refresh():
    lv = {"stop_signals": None, "line_signals": None, "sncf_assistance": None,
          "sncf_equipment": {"fetched_at": "t", "rows": [{"uic": "1", "nom_de_la_gare": "Gare", "accessibilite": "x"}]},
          "crossing_lights": None, "sound_modules": None}
    first = verify.low_vision_index(lv)
    assert verify.low_vision_index(lv) is first  # a station name used to overwrite the cache key


def test_report_with_a_naive_date_does_not_crash():
    from datetime import datetime, timezone
    now = datetime(2026, 10, 23, 12, tzinfo=timezone.utc)
    assert verify._report_confidence({"created_at": "2026-10-23T10:00", "confirmations": 2}, now) == 4


# --- Word filter ------------------------------------------------------------------------

@pytest.mark.parametrize("text", ["Quel connard ce chantier", "SALOPE", "enculés", "f*ck this ramp", "motherfucker",
                                  "s4lope", "sale nègre", "Bâtard", "retarded lift"])
def test_obvious_slurs_and_obscenities_are_caught(text):
    assert moderation.is_offensive(text)


@pytest.mark.parametrize("text", ["Escalier sans rampe", "Scunthorpe", "technique", "salopette", "retard du métro",
                                  "4 marches", "Three steps, no ramp", "dog shit on the sidewalk",
                                  "de la merde de chien partout", "chink between the paving stones", "M14 en panne",
                                  "Rue de la Conception", ""])
def test_normal_descriptions_pass(text):
    assert not moderation.is_offensive(text)


def test_offensive_report_is_a_422_before_any_database_call(monkeypatch):
    monkeypatch.setattr(db, "DATABASE_URL", None)  # would be a 503 if the database were reached
    r = client.post("/api/reports", json={**REPORT, "description": "Putain de connard de chantier"})
    assert r.status_code == 422 and r.json()["code"] == "offensive" and "ne pouvons pas publier" in r.json()["detail"]


# --- Accounts and moderation on the in-memory database ------------------------------------

@pytest.fixture
def fake(monkeypatch):
    monkeypatch.setattr(reports, "_salt", None)
    monkeypatch.delenv("REPORT_AUTHOR_SALT", raising=False)
    return fakedb.install(monkeypatch, db)


def new_user(c=client):
    r = c.post("/api/users", json={"display_name": "Léa", "profile": "manuel"})
    assert r.status_code == 200, r.text
    return r.json()


def new_report(user_id=None, **change):
    r = client.post("/api/reports", json={**REPORT, "user_id": user_id, **change})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def features():
    r = client.get("/api/reports", params={"bbox": BBOX})
    assert r.status_code == 200, r.text
    return {f["properties"]["id"]: f["properties"] for f in r.json()["features"]}


def flag(rid, ip, token=None, **body):
    headers = {"X-Real-IP": ip, **({"X-User-Token": token} if token else {})}
    return client.post(f"/api/reports/{rid}/flag", json=body, headers=headers)


def test_new_user_gets_a_secret_token_and_only_its_hash_is_stored(fake):
    u = new_user()
    assert set(u) == {"id", "token"} and len(u["token"]) >= 32
    stored = fake.users[u["id"]]["token_hash"]
    assert stored == reports.token_hash(u["token"]) and u["token"] not in stored
    assert new_user()["token"] != u["token"]


def test_delete_needs_the_right_token(fake):
    u = new_user()
    url = f"/api/users/{u['id']}"
    assert client.delete(url).status_code == 403
    assert client.delete(url, headers={"X-User-Token": "wrong"}).status_code == 403
    assert client.delete(url, headers={"X-User-Token": u["token"] + "x"}).status_code == 403
    assert client.delete(url, headers={"X-User-Token": "x" * 5000}).status_code == 403
    assert client.delete(url, headers={"X-User-Token": u["token"]}).json() == {"deleted": True}
    assert u["id"] not in fake.users
    again = client.delete(url, headers={"X-User-Token": u["token"]})
    assert again.status_code == 404 and again.json()["code"] == "not_found"


def test_delete_unknown_or_impossible_id_is_404_or_422(fake):
    assert client.delete("/api/users/999", headers={"X-User-Token": "t"}).status_code == 404
    assert client.delete("/api/users/0").status_code == 422
    assert client.delete(f"/api/users/{2**31}").status_code == 422
    assert client.delete("/api/users/abc").status_code == 422


def test_delete_removes_every_report_of_the_user_and_their_thumbnails(fake):
    u, other = new_user(), new_user()
    thumb = "data:image/jpeg;base64,/9j/4AAQSkZJRg=="
    mine = [new_report(u["id"], photo_thumb=thumb), new_report(str(u["id"]))]
    kept = new_report(other["id"])
    anon = new_report()
    flag(kept, "203.0.113.1", token=u["token"], user_id=u["id"])
    assert client.delete(f"/api/users/{u['id']}", headers={"X-User-Token": u["token"]}).status_code == 200
    assert set(fake.reports) == {kept, anon}
    assert all(thumb != r["photo_thumb"] for r in fake.reports.values())
    assert not [f for f in fake.flags if f["user_id"] == u["id"]]  # their flags are gone too
    assert set(features()) == {kept, anon} and not set(mine) & set(features())


def test_report_photos_are_served_on_their_own_and_cached(fake):
    """The map list carries a photo address, not the photo (up to 300 KB each, up to 500 per list)."""
    thumb = "data:image/jpeg;base64,/9j/4AAQSkZJRg=="
    with_photo, without = new_report(photo_thumb=thumb), new_report()
    p = features()
    assert "photo_thumb" not in p[with_photo] and p[with_photo]["photo_url"] == f"/api/reports/{with_photo}/thumb"
    assert p[without]["photo_url"] is None
    r = client.get(p[with_photo]["photo_url"])
    assert r.status_code == 200 and r.headers["content-type"] == "image/jpeg"
    assert r.content == base64.b64decode(thumb.split(",", 1)[1])
    assert "max-age=604800" in r.headers["cache-control"] and "immutable" in r.headers["cache-control"]
    assert client.get(f"/api/reports/{without}/thumb").status_code == 404
    assert client.get("/api/reports/999/thumb").status_code == 404
    assert client.get("/api/reports/0/thumb").status_code == 422


def test_hidden_or_deleted_reports_no_longer_serve_their_photo(fake):
    u = new_user()
    thumb = "data:image/jpeg;base64,/9j/4AAQSkZJRg=="
    flagged, mine = new_report(photo_thumb=thumb), new_report(u["id"], photo_thumb=thumb)
    flag(flagged, "203.0.113.1"); flag(flagged, "198.51.100.2")
    assert client.get(f"/api/reports/{flagged}/thumb").status_code == 404
    assert client.get(f"/api/reports/{mine}/thumb").status_code == 200
    assert client.delete(f"/api/users/{u['id']}", headers={"X-User-Token": u["token"]}).status_code == 200
    assert client.get(f"/api/reports/{mine}/thumb").status_code == 404


def test_unreadable_stored_thumbnails_are_a_404_not_a_500():
    assert reports.decode_thumb(None) is None
    assert reports.decode_thumb("https://example.com/x.jpg") is None
    assert reports.decode_thumb("data:image/jpeg;base64,***") is None
    assert reports.decode_thumb("data:text/html;base64,PGI+") is None
    assert reports.decode_thumb("data:image/png;base64,iVBORw0KGgo=")[0] == "image/png"


def test_flag_with_the_token_header_counts_once_per_person(fake):
    """The app sends X-User-Token on flags (static/app.js flagReport): the same person on two connections flags once."""
    u = new_user()
    rid = new_report()
    assert flag(rid, "203.0.113.1", token=u["token"], user_id=str(u["id"])).json()["flags"] == 1
    assert flag(rid, "198.51.100.7", token=u["token"], user_id=str(u["id"])).json()["flags"] == 1


def test_legacy_profile_without_token_cannot_be_deleted_by_anyone(fake):
    fake.users[50] = {"id": 50, "display_name": "old", "profile": None, "token_hash": None}
    assert client.delete("/api/users/50", headers={"X-User-Token": "anything"}).status_code == 403


def test_delete_is_rate_limited(fake, monkeypatch):
    monkeypatch.setitem(limits.RULES, "delete_user", (2, 3600))
    codes = [client.delete("/api/users/999", headers={"X-User-Token": "t"}).status_code for _ in range(3)]
    assert codes == [404, 404, 429]


def test_two_flags_from_two_people_hide_a_report_from_map_and_journeys(fake):
    rid, other = new_report(), new_report()
    assert flag(rid, "203.0.113.1", reason="insulting").json() == {"flags": 1, "hidden": False}
    assert rid in features()
    assert flag(rid, "203.0.113.1").json() == {"flags": 1, "hidden": False}  # same person again: no effect
    assert flag(rid, "198.51.100.2").json() == {"flags": 2, "hidden": True}
    assert rid not in features() and other in features()
    seen = {r["id"] for r in main._reports()}
    assert rid not in seen and other in seen


def test_a_proven_user_flags_once_even_from_two_connections(fake):
    u = new_user()
    rid = new_report()
    flag(rid, "203.0.113.1", token=u["token"], user_id=u["id"])
    assert flag(rid, "198.51.100.2", token=u["token"], user_id=str(u["id"])).json() == {"flags": 1, "hidden": False}
    assert [f["client_key"] for f in fake.flags] == [f"user:{u['id']}"]


def test_a_user_id_without_its_token_counts_as_anonymous(fake):
    """Ids are sequential: a bare user_id proves nothing, so it cannot be used to add or block flags."""
    u = new_user()
    rid = new_report()
    flag(rid, "203.0.113.1", token="forged", user_id=u["id"])
    assert fake.flags[0]["user_id"] is None and fake.flags[0]["client_key"].startswith("ip:")
    assert flag(rid, "203.0.113.1", user_id=u["id"]).json()["flags"] == 1  # same connection: still one
    assert flag(rid, "203.0.113.1", token=u["token"], user_id=u["id"]).json() == {"flags": 2, "hidden": True}


def test_flag_bad_input(fake):
    rid = new_report()
    assert client.post("/api/reports/999/flag", json={}).status_code == 404
    assert client.post(f"/api/reports/{2**40}/flag", json={}).status_code == 422
    assert client.post(f"/api/reports/{rid}/flag", json={"reason": "x" * 201}).status_code == 400
    assert client.post(f"/api/reports/{rid}/flag", json={"user_id": "abc"}).status_code == 400
    assert client.post(f"/api/reports/{rid}/flag").status_code == 200  # empty body is fine
    assert all("testclient" not in f["client_key"] and len(f["client_key"]) == 35 for f in fake.flags)  # IP hashed


def test_flag_is_rate_limited(fake, monkeypatch):
    monkeypatch.setitem(limits.RULES, "flag", (1, 3600))
    rid = new_report()
    assert [client.post(f"/api/reports/{rid}/flag", json={}).status_code for _ in range(2)] == [200, 429]


def test_author_is_a_short_stable_hash_and_null_when_anonymous(fake):
    a, b = new_user(), new_user()
    r1, r2, r3, r4 = new_report(a["id"]), new_report(a["id"]), new_report(b["id"]), new_report()
    p = features()
    assert p[r1]["author"] == p[r2]["author"] != p[r3]["author"]
    assert p[r4]["author"] is None
    h = p[r1]["author"]
    assert len(h) == 10 and int(h, 16) >= 0 and str(a["id"]) != h
    salt = fake.settings["author_salt"]
    assert len(salt) == 32  # random, kept in the database: ids cannot be recovered without it
    import hashlib
    assert h not in {hashlib.sha256(str(i).encode()).hexdigest()[:10] for i in range(1, 1000)}


def test_author_salt_can_come_from_the_environment(fake, monkeypatch):
    monkeypatch.setenv("REPORT_AUTHOR_SALT", "s3cret")
    rid = new_report(new_user()["id"])
    assert features()[rid]["author"] and "author_salt" not in fake.settings


def test_huge_user_id_in_a_report_is_a_400_not_a_500(fake):
    assert client.post("/api/reports", json={**REPORT, "user_id": 2**40}).status_code == 400


# --- The same flows on PostgreSQL (TEST_DATABASE_URL) -----------------------------------------

TEST_DB = os.getenv("TEST_DATABASE_URL")


@pytest.fixture
def database(monkeypatch):
    if not TEST_DB:
        pytest.skip("TEST_DATABASE_URL not set")
    monkeypatch.setattr(db, "DATABASE_URL", TEST_DB)
    monkeypatch.setattr(db, "_conn", None)
    monkeypatch.setattr(reports, "_salt", None)
    db.init_schema()
    db.init_schema()  # idempotent: it runs at every startup
    created = {"u": [], "r": []}
    yield created
    with db.conn().cursor() as cur:
        cur.execute("DELETE FROM user_reports WHERE id = ANY(%s) OR user_id = ANY(%s)", (created["r"], created["u"]))
        cur.execute("DELETE FROM report_flags WHERE user_id = ANY(%s)", (created["u"],))
        cur.execute("DELETE FROM user_profile WHERE id = ANY(%s)", (created["u"],))
    db.conn().close()


def test_pg_account_deletion(database):
    u = new_user()
    database["u"].append(u["id"])
    rid = new_report(u["id"], photo_thumb="data:image/jpeg;base64,/9j/4AAQSkZJRg==")
    database["r"].append(rid)
    other = new_report()
    database["r"].append(other)
    flag(other, "203.0.113.9", token=u["token"], user_id=u["id"])
    with db.conn().cursor() as cur:
        cur.execute("SELECT count(*) FROM report_flags WHERE report_id = %s AND user_id = %s", (other, u["id"]))
        assert cur.fetchone()[0] == 1
        cur.execute("SELECT token_hash FROM user_profile WHERE id = %s", (u["id"],))
        assert cur.fetchone()[0] == reports.token_hash(u["token"])
    assert client.delete(f"/api/users/{u['id']}", headers={"X-User-Token": "nope"}).status_code == 403
    assert client.delete(f"/api/users/{u['id']}", headers={"X-User-Token": u["token"]}).json() == {"deleted": True}
    with db.conn().cursor() as cur:
        cur.execute("SELECT count(*) FROM user_reports WHERE id = %s OR user_id = %s", (rid, u["id"]))
        assert cur.fetchone()[0] == 0
        cur.execute("SELECT count(*) FROM user_profile WHERE id = %s", (u["id"],))
        assert cur.fetchone()[0] == 0
        cur.execute("SELECT count(*) FROM report_flags WHERE report_id = %s", (other,))
        assert cur.fetchone()[0] == 0
    assert client.delete(f"/api/users/{u['id']}", headers={"X-User-Token": u["token"]}).status_code == 404


def test_pg_flags_hide_and_author(database):
    a = new_user()
    database["u"].append(a["id"])
    rid, mine = new_report(), new_report(a["id"])
    database["r"] += [rid, mine]
    assert flag(rid, "203.0.113.1", reason="spam").json() == {"flags": 1, "hidden": False}
    assert flag(rid, "203.0.113.1").json() == {"flags": 1, "hidden": False}
    assert flag(rid, "198.51.100.2", token=a["token"], user_id=a["id"]).json() == {"flags": 2, "hidden": True}
    assert flag(rid, "192.0.2.3", token=a["token"], user_id=a["id"]).json()["flags"] == 2  # same user, other IP
    p = features()
    assert rid not in p and p[mine]["author"] and len(p[mine]["author"]) == 10
    assert rid not in {r["id"] for r in main._reports()} and mine in {r["id"] for r in main._reports()}
    with db.conn().cursor() as cur:
        cur.execute("SELECT client_key FROM report_flags WHERE report_id = %s", (rid,))
        assert all("203.0.113" not in k for (k,) in cur.fetchall())  # hashed, not the IP itself


# --- Source cache: an expired layer never blocks a request ------------------------------------

def test_expired_layer_is_served_at_once_and_refreshed_in_the_background(monkeypatch):
    monkeypatch.setattr(sources, "SERVERLESS", False)
    monkeypatch.setattr(sources, "CACHE_DIR", sources.Path("/tmp/pmr-cache-test"))
    key = "test_swr_layer"
    sources._cache[key] = (time.time() - 100, {"fetched_at": "old", "rows": [1]})

    def slow():
        time.sleep(0.5)
        return {"fetched_at": "new", "rows": [2]}
    t = time.perf_counter()
    assert sources.cached(key, 10, slow)["fetched_at"] == "old"
    assert time.perf_counter() - t < 0.2
    time.sleep(0.8)
    assert sources.cached(key, 10, slow)["fetched_at"] == "new"
    sources._cache.pop(key, None)


def test_refreshes_failing_for_long_mark_the_layer_stale(monkeypatch):
    monkeypatch.setattr(sources, "SERVERLESS", False)
    monkeypatch.setattr(sources, "CACHE_DIR", sources.Path("/tmp/pmr-cache-test"))
    key = "test_swr_failing"
    sources._cache[key] = (time.time() - 1000, {"fetched_at": "old", "rows": [1]})

    def down():
        raise httpx.ConnectError("down")
    first = sources.cached(key, 10, down)
    assert first["stale"] is True and first["fetched_at"] == "old"
    assert sources.cached(key, 10, down) is first  # same object: identity-keyed indexes stay valid
    sources._cache.pop(key, None)


def test_serverless_keeps_the_blocking_refresh(monkeypatch):
    monkeypatch.setattr(sources, "SERVERLESS", True)
    monkeypatch.setattr(sources, "CACHE_DIR", sources.Path("/tmp/pmr-cache-test"))
    key = "test_swr_serverless"
    sources._cache[key] = (time.time() - 100, {"fetched_at": "old", "rows": []})
    assert sources.cached(key, 10, lambda: {"fetched_at": "new", "rows": []})["fetched_at"] == "new"
    sources._cache.pop(key, None)


# --- Layers a journey depends on ----------------------------------------------------------------

WALK = {"type": "street_network", "duration": 300, "from": {"name": "A"}, "to": {"name": "B"},
        "geojson": {"type": "LineString", "coordinates": [[2.3400, 48.8600], [2.3420, 48.8610]]}}


def test_missing_stairs_layer_makes_walks_unknown_never_clear():
    it = verify.verify_journey({"sections": [WALK]}, "manuel", [], stairs=None)
    check = it["steps"][0]["checks"][-1]
    assert check["kind"] == "stairs" and check["status"] == "inconnu" and check["confidence"] == 1
    assert it["verdict"] == "risque"  # a risk to check, not a block, and never "passe"
    assert verify.verify_journey({"sections": [WALK]}, "manuel", [], stairs=[])["verdict"] == "passe"
    assert verify.verify_journey({"sections": [WALK]}, "malvoyant", [], stairs=None)["verdict"] == "passe"


def test_slow_layer_does_not_hold_the_journey(monkeypatch):
    monkeypatch.setitem(main.LAYER_BUDGET_S, "works", 0.2)
    monkeypatch.setattr(main.sources, "works", lambda: time.sleep(1.0) or {"fetched_at": "x", "rows": []})
    t = time.perf_counter()
    assert main._layer("works") == (None, None)
    assert time.perf_counter() - t < 0.6
    monkeypatch.setattr(main.sources, "stairs", lambda: (_ for _ in ()).throw(httpx.ConnectError("down")))
    assert main._layer("stairs") == (None, None)


def test_low_vision_layers_load_in_parallel_within_a_budget(monkeypatch):
    def layer(name, delay):
        def fn():
            time.sleep(delay)
            return {"fetched_at": "x", "rows": []}
        fn.__name__ = name
        return fn
    for name in ("stop_signals", "line_signals", "sncf_assistance", "sncf_equipment", "crossing_lights"):
        monkeypatch.setattr(sources, name, layer(f"{name}_t", 0.2))  # distinct in-flight keys for this test
    monkeypatch.setattr(sources, "sound_modules", layer("sound_modules_t", 2.0))  # opendata.paris.fr being slow
    t = time.perf_counter()
    out = sources.low_vision(budget_s=0.6)
    assert time.perf_counter() - t < 1.0  # in parallel: not 5 x 0.2 s + 2 s
    assert out["sound_modules_t"] is None and all(out[f"{n}_t"] for n in ("stop_signals", "crossing_lights"))
