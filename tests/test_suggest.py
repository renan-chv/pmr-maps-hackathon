"""Search box ranking: Photon results mapped to suggestions (no network)."""
from app import sources


def _feat(lon, lat, **props):
    return {"geometry": {"coordinates": [lon, lat]}, "properties": props}


def test_address_label_and_place_category():
    addr = sources._photon_item(_feat(2.33, 48.87, osm_value="house", housenumber="15", street="Rue de la Paix",
                                      postcode="75002", city="Paris"))
    assert addr == {"kind": "address", "label": "15 Rue de la Paix", "sub": "Adresse · 2e", "lon": 2.33, "lat": 48.87}
    resto = sources._photon_item(_feat(2.34, 48.85, osm_value="restaurant", name="Le Procope",
                                       street="Rue de l'Ancienne Comédie", city="Paris"))
    assert resto["kind"] == "place" and resto["sub"].startswith("Restaurant · ")


def test_noise_and_outside_idf_dropped():
    assert sources._photon_item(_feat(2.3, 48.8, osm_value="bicycle_rental", name="Vélib")) is None
    assert sources._photon_item(_feat(5.37, 43.29, osm_value="house", housenumber="1", street="Rue X")) is None


def test_falls_back_to_ign_when_photon_fails(monkeypatch):
    def boom(*a, **k):
        raise sources.httpx.ConnectError("down")
    monkeypatch.setattr(sources, "_suggest_photon", boom)
    monkeypatch.setattr(sources, "_suggest_ign", lambda q, limit=6: [{"label": "ign"}])
    assert sources.suggest("x") == [{"label": "ign"}]


def test_paris_open_data_url_is_not_shadowed():
    # Regression: a (lon, lat) constant named PARIS replaced the opendata.paris.fr URL and broke works/stairs.
    assert isinstance(sources.PARIS, str) and sources.PARIS.startswith("https://opendata.paris.fr")


def test_subtitle_says_what_the_result_is():
    museum = sources._photon_item(_feat(2.3266, 48.86, osm_key="tourism", osm_value="museum", name="Musée d'Orsay",
                                        street="Rue de la Légion d'Honneur", postcode="75007", city="Paris"))
    assert museum["sub"] == "Musée · Rue de la Légion d'Honneur, 7e"
    # Value not in the table: the tag key still gives a type.
    ferry = sources._photon_item(_feat(2.29, 48.86, osm_key="amenity", osm_value="ferry_terminal", name="Tour-Eiffel",
                                       postcode="75007", city="Paris"))
    assert ferry["sub"] == "Lieu · 7e"
    first = sources._photon_item(_feat(2.34, 48.86, osm_value="house", housenumber="1", street="Rue de Rivoli",
                                       postcode="75001", city="Paris"))
    assert first["sub"] == "Adresse · 1er"
    sixteenth = sources._photon_item(_feat(2.27, 48.86, osm_value="street", street="Avenue Foch", name="Avenue Foch",
                                           postcode="75116", city="Paris"))
    assert sixteenth["sub"] == "Rue · 16e"
    suburb = sources._photon_item(_feat(2.28, 48.82, osm_value="house", housenumber="3", street="Rue d'Issy",
                                        postcode="92130", city="Vanves"))
    assert suburb["sub"] == "Adresse · 92130 Vanves"


def test_exact_name_ranks_first_accents_ignored():
    items = [{"label": "Champ de Mars - Tour Eiffel"}, {"label": "Tour Eiffel 3e étage"}, {"label": "Tour Eiffel"}]
    assert sources.rank_exact_first("tour eiffel", items)[0]["label"] == "Tour Eiffel"
    assert sources.rank_exact_first("Musee d orsay", [{"label": "Musée d'Orsay / Bellechasse"},
                                                      {"label": "Musée d'Orsay"}])[0]["label"] == "Musée d'Orsay"
    # No exact match: Photon's order is kept.
    assert [x["label"] for x in sources.rank_exact_first("tour", items)] == [x["label"] for x in items]


def test_lift_text_mojibake_repaired():
    assert sources.fix_mojibake("Gare principale  /  Dalle routi\u00e0\u00a8re  /  Hall") == "Gare principale  /  Dalle routière  /  Hall"
    assert sources.fix_mojibake("Acc\u00c3\u00a8s quai") == "Accès quai"
    # Real French is left alone.
    assert sources.fix_mojibake("à droite, à côté de l'escalier") == "à droite, à côté de l'escalier"
    assert sources.fix_mojibake(None) is None


def test_lifts_feed_rows_are_repaired(monkeypatch):
    monkeypatch.setattr(sources, "_export", lambda *a, **k: [{"liftsituation": "Dalle routi\u00e0\u00a8re", "zdcid": 1}])
    assert sources.fetch_lifts_raw() == [{"liftsituation": "Dalle routière", "zdcid": 1}]
