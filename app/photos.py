"""Photos for places and stations, from real sources only (chantier A).

1. The place's own website (Acceslibre `site_internet`): its og:image / twitter:image.
2. Otherwise a photo taken nearby on Wikimedia Commons (free licence, author credited).
No source -> no photo. We never show a stock or invented picture.
"""
from __future__ import annotations

import html
import re
from typing import Optional
from urllib.parse import urljoin, urlparse

import httpx
from fastapi import APIRouter, Query

from . import sources

router = APIRouter()

ACCESLIBRE = sources.ACCESLIBRE
COMMONS = "https://commons.wikimedia.org/w/api.php"
UA = {"User-Agent": "PMRMaps/0.1 (https://pmr-maps-hackathon.vercel.app; github.com/renan-chv/pmr-maps-hackathon)"}
OG = re.compile(r'<meta[^>]+(?:property|name)=["\'](?:og:image(?::secure_url)?|twitter:image)["\'][^>]*>', re.I)
CONTENT = re.compile(r'content=["\']([^"\']+)["\']', re.I)
# Social pages need a login and give generic images: skip them.
SKIP_HOSTS = ("facebook.com", "instagram.com", "tripadvisor", "google.", "linktr.ee")
# Expired domains end up on parking pages: their image is the registrar's, not the place's.
PARKED = re.compile(r"hugedomains|sedo|afternic|dan\.com|godaddy|bodis|parkingcrew|domain(?:s)? (?:is )?for sale|ce domaine est à vendre|buy this domain", re.I)
TAG = re.compile(r"<[^>]+>")


def _site_image(site: str) -> Optional[str]:
    url = site if site.startswith(("http://", "https://")) else f"https://{site}"
    host = urlparse(url).hostname or ""
    if not host or any(s in host for s in SKIP_HOSTS):
        return None
    try:
        with httpx.stream("GET", url, headers=UA, timeout=httpx.Timeout(5, connect=3), follow_redirects=True) as r:
            if r.status_code != 200 or "html" not in r.headers.get("content-type", ""):
                return None
            body = b""
            for chunk in r.iter_bytes():
                body += chunk
                if len(body) > 400_000 or b"</head>" in body:
                    break
            final = str(r.url)
    except httpx.HTTPError:
        return None
    head = body.decode("utf-8", "ignore")
    if PARKED.search(head[:20000]) or PARKED.search(final):
        return None
    for tag in OG.findall(head):
        m = CONTENT.search(tag)
        if m:
            img = urljoin(final, html.unescape(m.group(1).strip()))
            if img.startswith("https://") and not PARKED.search(img) and not re.search(r"googleapis|gstatic|googleusercontent|ggpht", img):  # https only: no mixed content
                return img
    return None


def _commons_near(lat: float, lon: float, radius: int = 80) -> Optional[dict]:
    try:
        r = httpx.get(COMMONS, headers=UA, timeout=6, params={
            "action": "query", "format": "json", "generator": "geosearch", "ggscoord": f"{lat}|{lon}",
            "ggsradius": radius, "ggsnamespace": 6, "ggslimit": 12, "prop": "imageinfo",
            "iiprop": "url|extmetadata", "iiurlwidth": 720,
        })
        r.raise_for_status()
    except httpx.HTTPError:
        return None
    pages = sorted((r.json().get("query") or {}).get("pages", {}).values(), key=lambda p: p.get("index", 99))
    for p in pages:
        title = p.get("title", "")
        if re.search(r"plaque|plan|map|logo|\.svg$|\.pdf$", title, re.I):
            continue
        info = (p.get("imageinfo") or [{}])[0]
        meta = info.get("extmetadata") or {}
        src = info.get("thumburl") or info.get("url")
        if not src:
            continue
        artist = TAG.sub("", (meta.get("Artist") or {}).get("value", "")).strip() or "auteur inconnu"
        return {
            "src": src, "kind": "nearby", "link": info.get("descriptionurl"),
            "credit": f"{artist}, {(meta.get('LicenseShortName') or {}).get('value', 'licence libre')}",
            "caption": "Photo prise à proximité (Wikimedia Commons)",
        }
    return None


def _acceslibre_site(place_id: str) -> Optional[str]:
    try:
        r = httpx.get(ACCESLIBRE, timeout=8, params={"id__exact": place_id, "columns": "id,site_internet", "page_size": 1})
        r.raise_for_status()
        rows = r.json().get("data") or []
    except httpx.HTTPError:
        return None
    return (rows[0].get("site_internet") or "").strip() if rows else None


def _photo(place_id: Optional[str], lat: float, lon: float) -> dict:
    if place_id:
        site = _acceslibre_site(place_id)
        img = _site_image(site) if site else None
        if img:
            return {"photo": {"src": img, "kind": "site", "link": site, "credit": urlparse(site).hostname,
                              "caption": "Photo du site du lieu"}}
    return {"photo": _commons_near(lat, lon)}


@router.get("/api/photo")
def api_photo(lat: float, lon: float, id: Optional[str] = Query(None, description="Acceslibre place id")):
    key = f"photo_{id or ''}_{round(lat, 4)}_{round(lon, 4)}"
    return sources.cached(key, 86400, lambda: _photo(id, lat, lon))
