"""CDN cache policy for the API (chantier A, performance).

Vercel's edge caches a response when it carries `s-maxage`. Each data source gets a lifetime that
matches how often it changes upstream; `stale-while-revalidate` keeps answers instant while the
edge refreshes in the background. The freshness shown in the UI still comes from each payload's
own `fetched_at`, so a cached answer never hides its age.
"""
from __future__ import annotations

import re
from pathlib import Path

from fastapi.responses import FileResponse

# (path pattern, s-maxage seconds, stale-while-revalidate seconds). First match wins.
POLICY = [
    (r"^/api/lifts$", 120, 600),                      # IDFM updates ~3x a day, we poll every 15 min
    (r"^/api/alerts$", 60, 120),
    (r"^/api/stations/[^/]+/reliability$", 6 * 3600, 86400),
    (r"^/api/(stations|train-stations|bus-stops|stairs)$", 86400, 7 * 86400),
    (r"^/api/works$", 3600, 6 * 3600),
    (r"^/api/places/search$", 3600, 86400),
    (r"^/api/places$", 6 * 3600, 86400),
    (r"^/api/photo$", 86400, 7 * 86400),
    (r"^/api/(suggest|geocode)$", 3600, 86400),
]
_COMPILED = [(re.compile(p), s, w) for p, s, w in POLICY]


_SW = Path(__file__).resolve().parent.parent / "static" / "sw.js"


def install(app) -> None:
    # The service worker must be served from the root to control "/".
    @app.get("/sw.js", include_in_schema=False)
    def service_worker():
        return FileResponse(_SW, media_type="application/javascript",
                            headers={"Cache-Control": "no-cache", "Service-Worker-Allowed": "/"})

    @app.middleware("http")
    async def cache_headers(request, call_next):
        response = await call_next(request)
        if request.method != "GET" or response.status_code != 200 or "cache-control" in response.headers:
            return response
        path = request.url.path
        if path == "/api/journey":
            # The recorded demo never changes; live journeys must always be fresh.
            if request.query_params.get("replay") == "demo":
                response.headers["Cache-Control"] = "public, max-age=300, s-maxage=3600"
            else:
                response.headers["Cache-Control"] = "no-store"
            return response
        for rx, smax, swr in _COMPILED:
            if rx.match(path):
                response.headers["Cache-Control"] = f"public, max-age=60, s-maxage={smax}, stale-while-revalidate={swr}"
                break
        return response
