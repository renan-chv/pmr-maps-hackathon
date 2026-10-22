"""Place providers: one class per restaurant / shop API. The format is in app/places.py.

To plug an API:
1. Copy TemplateProvider, give it a key and its meta (name, url, license).
2. enabled(): return False when its API key is missing (read it from the environment).
3. fetch(bbox): call the API for this bbox and return the raw rows (list of dicts).
   Use sources._client for HTTP: it has the timeouts and the User-Agent.
4. normalize(row): map one row to Place / Access. Leave a field to None when the API
   does not say: None means "non renseigné", never "non".
5. Uncomment @register, add the API key to .env.example and the source to README.md.
Order between providers: PLACES_PROVIDERS=first,second (the first wins on name and position).
"""
from __future__ import annotations

from typing import List, Optional

from .places import Access, Bbox, Place, Provider, register  # noqa: F401  (register: for new providers)


# @register
class TemplateProvider(Provider):
    key = "template"
    meta = {"name": "Nom de la source", "url": "https://…", "license": "Licence"}
    ttl = 3600

    def enabled(self) -> bool:
        return False  # e.g. bool(os.getenv("XXX_API_KEY"))

    def fetch(self, bbox: Bbox) -> List[dict]:
        min_lon, min_lat, max_lon, max_lat = bbox
        raise NotImplementedError

    def normalize(self, row: dict) -> Optional[Place]:
        return Place(
            source=self.key,
            source_id=str(row["id"]),
            name=row["name"],
            category="restaurant",          # restaurant / cafe / food_shop / shop / other
            lon=row["lon"], lat=row["lat"],
            address=None,
            access=Access(
                level="unknown",            # ok / partial / ko / unknown
                step_free=None, steps=None, ramp=None, door_width_cm=None,
                toilets=None, parking=None, notes=[],
            ),
            url=None,
            updated_at=None,                # ISO date of the accessibility info
        )
