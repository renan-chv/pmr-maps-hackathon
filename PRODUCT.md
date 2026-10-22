# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users
People with reduced mobility in Île-de-France: manual or electric wheelchair users, parents with a pushchair, people with a walker or cane, people with low vision. Many are not at ease with apps. They use Roulib on a phone, often outdoors or on the move, before or during a trip, to know whether a journey will actually work for them.

## Product Purpose
Roulib checks every link of a public-transport journey, from the door of departure to the door of arrival, against live data (IDFM lift status, Paris roadworks on sidewalks, stair streets, the destination's accessibility from Acceslibre, community reports). It says whether the trip works for *your* mobility profile, gives a confidence level for every step, and proposes a plan B before you get stuck. Success: the user avoids a dead end (a broken lift, a blocked sidewalk) they would have discovered on the spot.

## Positioning
Mainstream trip planners (Google Maps, Citymapper, the IDFM app) say "wheelchair accessible" from static data. Roulib verifies each step live for the user's own profile, shows how fresh each piece of information is, and warns before departure.

## Operating Context
- Mobile web app (PWA) deployed on Vercel; installed with "Add to home screen". No native app.
- Hackathon demo on 22/10/2026: 3-minute demo on a shared phone screen, recorded scenario available with `?replay=demo`.
- Team workstreams (roadmap): A UX/UI (static/*), B community reports and photo analysis, C API keys and data sources, D verification engine and plan B, E agent and benchmark. Changes go through pull requests.

## Capabilities and Constraints
- Journey verification via `/api/journey` (Navitia wheelchair=true + checks per step), profiles `manuel`, `electrique`, `poussette`, `deambulateur`, `malvoyant`; verdict `passe` / `risque` / `bloque`; confidence 1–5 (roadmap §4.3).
- Live layers: lifts (IDFM, polled every 15 min), stations and platforms accessibility, bus stops, Paris roadworks on sidewalks, Acceslibre places (restaurants, shops) with a computed wheelchair verdict.
- Lift reliability from the Dispotrains archive (about 11 days of history only).
- Photos of places come from the place's own website (og:image) or Wikimedia Commons nearby, credited; never invented.
- Without a PRIM key, live journeys are unavailable; only the recorded demo works.
- Community reports (chantier B) are not live yet: the UI must say so rather than simulate them.

## Brand Commitments
- Name: **Roulib**.
- Must not feel technical (jargon, data overload), childish (candy colours, infantilising tone), like a copy of Google Maps, or sad/medical (hospital, pity, administrative grey). Take the best patterns of leading mobility apps.
- Follow the team roadmap document (screens and contracts of chantier A).
- Standing preference (22/10): keep the incumbent Roulib look (warm light ground, colour tiles, Atkinson Hyperlegible) and follow Citymapper's interaction model at Citymapper's craft level: search first, Home/Work shortcuts, ranked route options with a row of line chips and big minutes, step-by-step timeline. Better than Citymapper on accessibility: verdict per profile, why a route is blocked, freshness of every check.

## Evidence on Hand
- Live open data (IDFM, Ville de Paris, Acceslibre, Wikimedia Commons, Dispotrains) and the recorded demo journey `static/fixtures/journey_demo.json`.
- No real users, testimonials or benchmark results yet: never fabricate them. The demo persona (Léa) is fictional.

## Product Principles
1. Say the verdict first, in plain words; details come after.
2. Always show where information comes from and how fresh it is; never present recorded or community data as official live data.
3. Unknown is never shown as accessible.
4. One task per screen, reachable with one hand and large targets.
5. Respect: adults with a disability, addressed as capable people.

## Accessibility & Inclusion
WCAG 2.2 AA minimum: contrast ≥ 4.5:1, targets ≥ 44 px, never colour alone (colour + icon + words), text enlargement (A+), voice input, works with screen readers (VoiceOver, TalkBack) for low-vision users, reduced motion respected.
