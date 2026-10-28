# Checklist de mise en production de Roulib

Public visé : familles et personnes à mobilité réduite à Paris. Une erreur de l'app peut envoyer quelqu'un devant un escalier. Les points marqués **BLOQUANT** sont à régler avant toute annonce publique.

Sources consultées le 22/10/2026. Légende : **[mesuré]** lu sur la source ou dans les en-têtes HTTP, **[estimé]** déduction, **[à vérifier]** non confirmé.
Kit Photon et note de résilience : [`deploy/photon/README.md`](photon/README.md).

## 0. Les 5 bloquants

1. **BLOQUANT. Chantiers et escaliers de rue cassés dans le code actuel.** Dans `app/sources.py`, la ligne `PARIS = (2.3522, 48.8566)` (bloc Photon) écrase la constante `PARIS` qui contient l'URL de opendata.paris.fr. `works()` et `stairs()` appellent donc une URL invalide. Elles servent au mieux le dernier cache disque, au pire une erreur. Introduit par le commit `86c7c63`. Correctif : renommer la constante du bloc Photon (ex. `PARIS_CENTER`), puis vérifier `curl <app>/api/works` et `curl <app>/api/stairs`. À faire par l'équipe qui tient `app/`.
2. **BLOQUANT. RGPD : données de handicap.** Le profil de mobilité (fauteuil manuel ou électrique, etc.) est une donnée de santé au sens de la CNIL. Il faut un consentement explicite, une notice de confidentialité, un registre, une AIPD et des durées de conservation. Aujourd'hui rien de cela n'existe dans l'app (détail au point 5).
3. **BLOQUANT. Quota PRIM.** Le calcul d'itinéraire a un quota par défaut de **1 000 requêtes par jour** et 5 par seconde. Chaque recherche d'itinéraire fait 1 ou 2 appels, sans cache. Soit environ 500 itinéraires par jour pour toute l'app. Demander la hausse à 20 000 par jour (page « Ma consommation API » du compte PRIM) avant le lancement.
4. **FAIT EN PARTIE (23/10, `app/limits.py`) : limites par personne sur agent, signalements, confirmations, profils et analyse photo, plafond quotidien de l'agent, IP lue en fin de X-Forwarded-For. Reste : plafond de dépense sur la clé Anthropic.** Ancien constat : `POST /api/agent` (modèle Claude Opus) n'a aucune limite de débit. `POST /api/reports` et `POST /api/users` non plus (spam de signalements possible). La limite de `/api/reports/analyze` se base sur le premier `X-Forwarded-For`, que le client peut falsifier. À prévoir : une limite par IP fiable sur ces routes et un plafond de dépense dans la console Anthropic.
5. **BLOQUANT. Recherche sur l'instance publique Photon.** Sans garantie et bridée en cas de gros volume. Monter l'instance du kit `deploy/photon/` et renseigner `PHOTON_URL`. En parallèle, corriger les mentions de sources (point 4) : la liste des sources affiche encore « Place search: IGN Géoplateforme » sans citer Photon ni OpenStreetMap pour la recherche.

## 1. Variables d'environnement

Ne jamais écrire de valeur dans le dépôt, un ticket ou un chat. Seulement les noms.

| Variable | Rôle | Sans elle | Aiven | Vercel |
|---|---|---|---|---|
| `DATABASE_URL` | PostgreSQL : historique des ascenseurs, comptes, signalements, journal de l'agent | Pas de comptes ni de signalements (les routes répondent 503), historique en mémoire | Oui (fournie par le service PostgreSQL Aiven) | Oui : Neon, posée par l'intégration Vercel |
| `PRIM_API_KEY` | Clé PRIM pour le calcul d'itinéraire Navitia (en-tête `apiKey`) | Pas d'itinéraire en direct | Oui | Oui |
| `ANTHROPIC_API_KEY` | Agent conversationnel et analyse des photos de signalement | Ces deux fonctions répondent qu'elles sont indisponibles | Oui si l'on veut ces fonctions | Oui si l'on veut ces fonctions |
| `PHOTON_URL` | Adresse de Photon, doit finir par `/api/` | Instance publique `photon.komoot.io` | Oui, vers l'instance auto-hébergée | Oui, même valeur |
| `AGENT_MODEL` | Modèle de l'agent (défaut `claude-opus-5-5`) | Défaut | Optionnel | Sans effet sans clé |
| `REPORTS_MODEL` | Modèle de l'analyse photo (défaut `claude-sonnet-5-5`) | Défaut | Optionnel | Sans effet sans clé |
| `REPORTS_ANALYZE_LIMIT` | Analyses de photo par client et par 10 min (défaut 30) | Défaut | Optionnel, baisser à 5 ou 10 au lancement | Sans effet |
| `AGENT_PER_HOUR` | Questions à l'agent par personne et par heure (défaut 10) | Défaut | Optionnel | Limite par instance |
| `AGENT_DAILY_LIMIT` | Réponses de l'agent par jour pour toute l'app (défaut 50, environ 1,50 € au plus) | Défaut | Optionnel | Limite par instance |
| `REPORTS_PER_HOUR` | Signalements par personne et par heure (défaut 10) | Défaut | Optionnel | Limite par instance |
| `POLL_SECONDS` | Intervalle de relevé des ascenseurs (défaut 900 s) | Défaut | Optionnel | Sans effet (pas de tâche de fond sur Vercel) |
| `PLACES_WARM_BBOX` | Zone `minLon,minLat,maxLon,maxLat` dont les lieux sont préchargés au démarrage | Pas de préchargement | Optionnel | Sans effet |
| `CACHE_DIR` | Dossier du cache disque (défaut `/tmp/pmr-cache`) | Défaut | Optionnel | Laisser le défaut |
| `VERCEL` | Posée automatiquement par Vercel, coupe les tâches de fond | | Ne pas définir | Automatique |

Où les saisir :

- **Aiven** : console Aiven, projet, service de l'application (Runtime), section des variables d'environnement du service. `DATABASE_URL` vient de l'intégration avec le service PostgreSQL. [à vérifier : libellé exact du menu dans la console]
- **Vercel** : projet `roulib` (compte `luigi-6d97`, https://roulib-gray.vercel.app), Settings, Environment Variables, cocher « Production ». En ligne de commande : `vercel env add PHOTON_URL production`. Une variable modifiée ne s'applique qu'au prochain déploiement.

## 2. Redéployer

- **Aiven** : un push ne redéploie pas. Console Aiven, service de l'app, bouton **« Deploy latest commit »**. Puis vérifier `curl https://<domaine Aiven>/health`.
- **Vercel** (serveur de l'app iOS), depuis la racine du dépôt :
  ```bash
  vercel link --project roulib   # une seule fois
  vercel deploy --prod
  ```
- Après chaque déploiement, tester :
  ```bash
  curl -s https://<app>/health
  # attendu sur Aiven : {"ok":true,"db":true,"prim":true,...}   sur Vercel : "db":false
  curl -s "https://<app>/api/suggest?q=gare%20de%20lyon" | head -c 300
  curl -s https://<app>/api/lifts | head -c 300
  curl -s https://<app>/api/works | head -c 300
  ```

## 3. Appels externes et limites

Liste tirée du code (`app/*.py`, `static/`).

| Service | Appelé depuis | Usage | Clé | Limite connue | Cache côté app |
|---|---|---|---|---|---|
| PRIM IDFM, Navitia `marketplace/v2/navitia/journeys` | `main._navitia` | Itinéraires accessibles | Oui | 1 000/jour par défaut, 20 000 sur demande, 5/s [mesuré, [offre PRIM](https://prim.iledefrance-mobilites.fr/fr/notre-offre)]. Quota des clés créées après 09/2024 [à vérifier] | Aucun (`no-store`) |
| data.iledefrance.fr, `etat-des-ascenseurs` | `sources.lifts`, poller | État des ascenseurs | Non | 10 000 requêtes/jour par client anonyme, remise à zéro 00:00 UTC [mesuré, en-têtes] | 5 min, relevé toutes les 15 min |
| data.iledefrance-mobilites.fr, `arrets`, `accessibilite-en-gare` | `sources.stations`, `bus_stops`, `train_stations` | Arrêts et gares | Non | 1 000 000/jour [mesuré, en-têtes] | 24 h |
| ressources.data.sncf.com, `etat-fonctionnement-elevatique-gare` | `sources.lifts_sncf` | Ascenseurs des gares SNCF | Non | 10 000/jour [mesuré, en-têtes] | 30 min |
| opendata.paris.fr, `chantiers-a-paris`, `plan-de-voirie-voies-en-escalier` | `sources.works`, `stairs` | Chantiers sur trottoir, escaliers | Non | 10 000/jour [mesuré, en-têtes] | 1 h et 24 h |
| tabular-api.data.gouv.fr (export Acceslibre) | `sources.places_tile`, `photos` | Accessibilité des lieux | Non | 100 req/s déclarés ([API tabulaire](https://www.data.gouv.fr/dataservices/api-tabulaire-data-gouv-fr-beta)) ; pages de 200 lignes acceptées [mesuré] | 24 h par tuile |
| Photon `photon.komoot.io` (ou `PHOTON_URL`) | `sources._suggest_photon` | Recherche d'adresses et de lieux | Non | Usage « raisonnable », pas de chiffre ([Photon](https://github.com/komoot/photon#demo-server)) | 24 h en mémoire |
| IGN Géoplateforme `data.geopf.fr/geocodage/search` | `sources._suggest_ign`, `geocode` | Secours de la recherche | Non | 50 req/s par IP ([cartes.gouv.fr](https://cartes.gouv.fr/aide/fr/guides-utilisateur/utiliser-les-services-de-la-geoplateforme/geocodage/)) | Aucun (sauf CDN Vercel 1 h) |
| Dispotrains `dispotrains.membrives.fr` | `reliability` | Historique de fiabilité des ascenseurs | Non | Site personnel non officiel, pas de conditions publiées [à vérifier avec son auteur] | Oui |
| Wikimedia Commons API | `photos._commons_near` | Photo libre prise près du lieu | Non | Politique d'API Wikimedia : User-Agent descriptif obligatoire. Le nôtre cite encore `pmr-maps-hackathon.vercel.app` : mettre le domaine Roulib et un contact | 24 h |
| Sites web des lieux (balise `og:image`) | `photos._site_image` | Photo du lieu | Non | Aucune. L'image est affichée en lien direct depuis le site tiers | 24 h |
| Anthropic API | `agent`, `reports.analyser` | Agent, analyse de photo | Oui | Limites du compte. Fixer un plafond de dépense | Non |
| tiles.openfreemap.org (navigateur) | `static/app.js` | Fond de carte | Non | Pas de limite de vues, sans SLA, peut s'arrêter sans préavis ([CGU](https://openfreemap.org/tos/)) | Navigateur |
| unpkg.com, fonts.googleapis.com (navigateur) | `static/index.html` | MapLibre, police Atkinson | Non | | Navigateur |

## 4. Licences et mentions obligatoires

| Donnée | Licence | Ce qu'il faut afficher |
|---|---|---|
| OpenStreetMap (via Photon et OpenFreeMap) | ODbL | « © OpenStreetMap contributors » avec lien vers https://www.openstreetmap.org/copyright, en coin de carte (repliable en bouton « i »). Les géocodeurs basés sur OSM doivent aussi le créditer ([guide OSMF](https://osmfoundation.org/wiki/Licence/Attribution_Guidelines)) |
| OpenFreeMap | Service gratuit, données OpenMapTiles + OSM | « OpenFreeMap © OpenMapTiles Data from OpenStreetMap ». MapLibre l'affiche seul : ne pas désactiver le contrôle d'attribution |
| Photon | Logiciel Apache 2.0, données OSM | Mention OSM ci-dessus. Citer « Recherche : Photon (Komoot) » dans la liste des sources |
| IDFM, état des ascenseurs | Licence Mobilité (base ODbL, IDFM peut demander qui utilise ; [licences PRIM](https://prim.iledefrance-mobilites.fr/fr/licences)) | Source, lien vers le jeu, date. Déjà affiché dans l'app |
| IDFM, itinéraires PRIM | Licence Mobilité + CGU PRIM de juillet 2022 | Source IDFM. Lire les CGU PRIM [à faire] |
| IDFM, arrêts et accessibilité en gare | Licence Ouverte 2.0 (Etalab) ou ODbL selon le jeu | Source et date. Vérifier la licence de chaque jeu sur sa page |
| SNCF Gares & Connexions | ODbL | Source et lien |
| Ville de Paris (chantiers, escaliers) | ODbL ([CGU](https://opendata.paris.fr/terms/terms-and-conditions/)) | Source, lien vers le jeu et vers la licence |
| Acceslibre | Licence Ouverte 2.0 (Etalab) | « Acceslibre (beta.gouv.fr) » et date. Déjà affiché |
| IGN Géoplateforme | Licence Ouverte 2.0 (Etalab) | « IGN Géoplateforme ». Mention exacte exigée par l'annexe 2 des [CGU](https://cartes.gouv.fr/cgu/#annexe-2-offre-geoplateforme) [à vérifier] |
| Wikimedia Commons | Licence de chaque photo (souvent CC BY-SA) | Auteur et licence sous la photo. Déjà fait (`credit`) |
| Photos des sites des lieux | Droit d'auteur du site | Risque juridique faible mais réel. Prévoir un retrait rapide sur demande |

À faire : mettre à jour la ligne « Place search: IGN Géoplateforme » dans `static/app.js` (`#sources-list`) pour citer Photon et OpenStreetMap, avec IGN en secours.

## 5. RGPD

### Ce que l'app traite

| Donnée | Où | Sensible |
|---|---|---|
| Profil de mobilité (`user_profile.profile` : fauteuil, poussette, etc.), pseudo | PostgreSQL, et `localStorage` du navigateur | **Oui** : la CNIL range le handicap dans les données de santé ([CNIL](https://www.cnil.fr/fr/quest-ce-ce-quune-donnee-de-sante)) |
| Signalements : position, catégorie, texte libre, miniature photo, date, `user_id` | PostgreSQL (`user_reports`) | Position + profil = localisation d'une personne handicapée |
| Photo envoyée pour analyse | Transmise à Anthropic (États-Unis), non stockée par l'app | Peut montrer des visages ou des plaques |
| Questions posées à l'agent | PostgreSQL (`agent_runs.question`) | Texte libre, peut contenir n'importe quoi |
| Adresse IP | Journaux de l'hébergeur, limite de débit en mémoire | Donnée personnelle |
| Position GPS de l'appareil | Navigateur, envoyée aux routes de recherche et d'itinéraire | Non stockée par l'app [estimé d'après le code] |

Point positif : la photo est redessinée dans un `canvas` côté navigateur (`static/app.js`), ce qui supprime les métadonnées EXIF, dont la position GPS.

### Ce qu'il faut faire

1. **Base légale** : consentement explicite (article 9.2.a du RGPD) pour le profil de mobilité. Case à cocher non pré-cochée, avant l'envoi du profil au serveur. Sans consentement, garder le profil seulement dans le navigateur.
2. **Registre des traitements** : obligatoire même sous 250 salariés, car il y a des données de santé ([CNIL, registre](https://www.cnil.fr/fr/RGPD-le-registre-des-activites-de-traitement), [modèle](https://www.cnil.fr/sites/default/files/atoms/files/registre-traitement-simplifie.ods)).
3. **AIPD** (analyse d'impact) : obligatoire dès 2 critères sur 9. Ici : données sensibles, personnes vulnérables, localisation ([CNIL, AIPD](https://www.cnil.fr/fr/ce-quil-faut-savoir-sur-lanalyse-dimpact-relative-la-protection-des-donnees-aipd), [liste des traitements](https://www.cnil.fr/fr/liste-traitements-aipd-requise)).
4. **Durées de conservation** à fixer et à appliquer par une tâche automatique. Proposition :
   - signalement temporaire (chantier, panne) : 30 jours après sa création ou sa dernière confirmation ;
   - signalement permanent (marche, escalier) : 2 ans, puis revue ;
   - miniature photo : 90 jours ;
   - compte sans activité : 12 mois, puis suppression ;
   - `agent_runs` : 3 mois, ou anonymiser la question.
   Aujourd'hui le code ne supprime rien. Il n'y a ni route de suppression ni tâche de purge ([CNIL, durées](https://www.cnil.fr/fr/les-durees-de-conservation-des-donnees)).
5. **Droits des personnes** : prévoir une adresse de contact et un moyen de supprimer son compte et ses signalements.
6. **Notice de confidentialité** (article 13), accessible depuis l'app et au moment de créer un profil. Contenu minimal ([CNIL, information](https://www.cnil.fr/fr/conformite-rgpd-information-des-personnes-et-transparence)) :
   - responsable du traitement et contact ;
   - finalités : itinéraires adaptés, signalements communautaires, analyse automatique des photos ;
   - base légale : consentement pour le profil, intérêt légitime pour les signalements (à valider) ;
   - destinataires et sous-traitants : Aiven (hébergement et base), Vercel, Anthropic (analyse des photos et agent, transfert hors UE), Photon auto-hébergé ;
   - durées de conservation (point 4) ;
   - droits : accès, rectification, effacement, retrait du consentement, réclamation à la CNIL ;
   - caractère facultatif du profil et de la photo.
7. **Signalements publics** : rappeler de ne pas photographier de personnes. Les miniatures sont visibles par tous. Prévoir un bouton « signaler un contenu » et une modération.
8. **Sous-traitants** : signer ou accepter les DPA d'Aiven, Vercel et Anthropic. Choisir une région UE pour Aiven et pour la base.
9. **Ressources chargées depuis des tiers** : Google Fonts et unpkg reçoivent l'IP des visiteurs. Héberger la police et MapLibre dans `static/` supprime ce point.
10. **HDS** (hébergement de données de santé) : probablement non applicable, car l'app n'est pas utilisée dans un cadre de soins ou de suivi médico-social. À confirmer par un juriste avant tout partenariat avec un établissement de santé ou médico-social. [à vérifier]

## 6. Surveillance minimale

- **Disponibilité** : un service gratuit (UptimeRobot, Better Stack) appelle toutes les 5 min :
  - `https://<app Aiven>/health` (alerte si pas 200 ou `"db": false`) ;
  - `https://<app Vercel>/health` ;
  - `https://<photon>/status`, ou `deploy/photon/healthcheck.sh https://<photon>`.
- **Journaux à surveiller** (console Aiven, `vercel logs`) :
  - `Photon unavailable … falling back to the IGN geocoder` : Photon en panne ;
  - `upstream failed …, serving stale data` : une source open data est en panne, l'app sert une copie ancienne ;
  - `PRIM answered 429` : quota PRIM atteint ;
  - `database init failed` : base inaccessible.
- **Quotas** : consulter chaque semaine « Ma consommation API » sur PRIM, et la console Anthropic (fixer un plafond mensuel et une alerte).
- **Base** : sauvegardes automatiques Aiven activées. Tester une restauration une fois avant le lancement.
- **Fraîcheur** : `/api/lifts` renvoie `fetched_at`. Une alerte si la donnée a plus de 2 h en journée [estimé : IDFM publie environ 3 fois par jour, SNCF toutes les heures].

## 7. Autres points avant lancement

- Le README racine liste encore l'agent et la clé PRIM dans « À faire ». Le mettre à jour.
- `photos._site_image` va chercher une URL issue des données Acceslibre. Bloquer les adresses IP privées et locales pour éviter qu'une donnée piégée fasse appeler le réseau interne (risque faible).
- Faire relire l'accessibilité (WCAG) sur mobile par des utilisateurs concernés, déjà commencé par l'audit du commit `10387c4`.
