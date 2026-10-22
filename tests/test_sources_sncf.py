from app import sources

IDFM = [
    {"liftid": "33847f22-e286-4df8-b743-da81a3b8e059", "liftstatus": "available", "liftreason": None,
     "liftstateupdate": "2026-10-22T07:13", "zdcname": "Paris Saint-Lazare"},
    {"liftid": "a0e923d1-6ffc-4e50-b2b3-36cb7ce2a103", "liftstatus": "available", "liftreason": None,
     "liftstateupdate": "2026-10-22T07:13", "zdcname": "Gare de Lyon"},
    {"liftid": "RATP:LiftEquipment:1", "liftstatus": "notavailable", "liftreason": "Panne",
     "liftstateupdate": "2026-10-22T08:00", "zdcname": "Châtelet"},
    {"liftid": "bc2dd5a7-b130-4586-ba8c-4e390b282542", "liftstatus": "notavailable", "liftreason": "Panne",
     "liftstateupdate": "2026-10-22T06:00", "zdcname": "Gare du Nord"},
]
SNCF = [
    {"id": "33847f22-e286-4df8-b743-da81a3b8e059", "etat_de_fonctionnement": "OK"},
    {"id": "a0e923d1-6ffc-4e50-b2b3-36cb7ce2a103", "etat_de_fonctionnement": "KO"},
    {"id": "bc2dd5a7-b130-4586-ba8c-4e390b282542", "etat_de_fonctionnement": "Inconnu"},
    {"id": "not-in-idfm", "etat_de_fonctionnement": "KO"},
]
AT = "2026-10-22T10:05:00+00:00"


def test_same_status_is_tagged_but_unchanged():
    rows, n = sources.overlay_sncf(IDFM, SNCF, AT)
    r = rows[0]
    assert n == 2
    assert r["liftstatus"] == "available" and r["status_source"] == "SNCF"
    assert r["liftstateupdate"] == "2026-10-22T07:13"


def test_fresher_sncf_breakdown_overrides_idfm():
    rows, _ = sources.overlay_sncf(IDFM, SNCF, AT)
    r = rows[1]
    assert r["liftstatus"] == "notavailable" and r["liftstatus_idfm"] == "available"
    assert r["liftstateupdate"] == "2026-10-22T12:05"  # SNCF read time, Paris local like IDFM


def test_unknown_sncf_status_and_other_networks_keep_idfm():
    rows, _ = sources.overlay_sncf(IDFM, SNCF, AT)
    assert rows[2] == IDFM[2]   # RATP lift: untouched
    assert rows[3] == IDFM[3]   # SNCF says "Inconnu": keep the IDFM status


def test_lifts_survive_sncf_outage(monkeypatch):
    sources._cache.clear()
    monkeypatch.setattr(sources, "fetch_lifts_raw", lambda: list(IDFM))
    monkeypatch.setattr(sources, "lifts_sncf", lambda: (_ for _ in ()).throw(RuntimeError("down")))
    monkeypatch.setattr(sources, "CACHE_DIR", sources.Path("/tmp/pmr-cache-test"))
    data = sources.lifts(force=True)
    assert [r["liftstatus"] for r in data["rows"]] == [r["liftstatus"] for r in IDFM]
    assert "sncf_refreshed" not in data
