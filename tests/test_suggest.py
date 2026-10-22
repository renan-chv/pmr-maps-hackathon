"""Search box ranking: Photon results mapped to suggestions (no network)."""
from app import sources


def _feat(lon, lat, **props):
    return {"geometry": {"coordinates": [lon, lat]}, "properties": props}


def test_address_label_and_place_category():
    addr = sources._photon_item(_feat(2.33, 48.87, osm_value="house", housenumber="15", street="Rue de la Paix",
                                      postcode="75002", city="Paris"))
    assert addr == {"kind": "address", "label": "15 Rue de la Paix", "sub": "75002 Paris", "lon": 2.33, "lat": 48.87}
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
