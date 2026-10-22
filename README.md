# PMR Maps – Hackathon Future Founders: Data-Centric Agents

Carte de l'accessibilité en fauteuil roulant en Île-de-France, construite sur des données ouvertes en direct.
Toutes les données affichées sont **réelles** (API publiques). Aucune donnée simulée.

## Couches disponibles (MVP)

| Couche | Endpoint | Source | Fraîcheur |
|---|---|---|---|
| Ascenseurs (en service / en panne / inconnu) | `/api/lifts` | IDFM – État des ascenseurs (Licence Mobilité) | relevé toutes les 15 min, IDFM met à jour ~3×/jour |
| Quais métro / tram / RER accessibles | `/api/stations` | IDFM – Référentiel des arrêts (Etalab) | quotidien |
| Gares SNCF / RER, niveau d'accessibilité | `/api/train-stations` | IDFM – Accessibilité en gare (Etalab) | quotidien |
| Arrêts de bus accessibles (par zone) | `/api/bus-stops?bbox=…` | IDFM – Référentiel des arrêts (Etalab) | quotidien |
| Travaux actifs occupant le trottoir (Paris) | `/api/works` | Ville de Paris – Chantiers à Paris (ODbL) | horaire |
| Changements d'état des ascenseurs | `/api/alerts` | calculé par le poller | 15 min |
| Itinéraire accessible + ascenseurs en panne sur le trajet | `/api/journey?from=…&to=…` | PRIM / Navitia `wheelchair=true` | direct (**clé PRIM requise**) |
| Géocodage d'adresse | `/api/geocode?q=…` | IGN Géoplateforme | direct |

## Lancer en local

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn app.main:app --port 8080 --reload
# http://localhost:8080
```

Variables d'environnement (voir `.env.example`) :
- `DATABASE_URL` : PostgreSQL Aiven. Si absente, l'app tourne sans base (historique en mémoire).
- `PRIM_API_KEY` : clé gratuite sur https://prim.iledefrance-mobilites.fr, nécessaire pour l'itinéraire.
- `POLL_SECONDS` : intervalle de relevé des ascenseurs (900 par défaut).

## Déploiement Aiven Runtime

Conteneur unique (`Dockerfile`), port HTTP 8080, `DATABASE_URL` injectée par Aiven.
Un push ne redéploie pas : cliquer **« Deploy latest commit »**.

## Structure

```
app/main.py      API FastAPI + page
app/sources.py   appels aux API open data, cache TTL
app/poller.py    relevé des ascenseurs, détection des changements
app/db.py        PostgreSQL optionnel
sql/schema.sql   tables (historique ascenseurs, profil démo, trajets, signalements, agent_runs)
static/          carte MapLibre (fond OpenFreeMap / OpenStreetMap)
```

## À faire

- [ ] Lieux Acceslibre (clé API à demander, ou export CSV data.gouv)
- [ ] Clé PRIM pour l'itinéraire
- [ ] Cheminements piétons de Paris
- [ ] Agent Claude (outils : find_stations, lift_status, find_places, user_memory, save_report)
- [ ] Benchmark (40 questions, 3 configurations) stocké dans `agent_runs`
