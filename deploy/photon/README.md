# Photon auto-hébergé pour Roulib

Roulib cherche les adresses et les lieux avec Photon, le géocodeur OpenStreetMap de Komoot.
Aujourd'hui l'app appelle l'instance publique `https://photon.komoot.io`. Elle est gratuite mais
sans garantie : Komoot accepte un usage « raisonnable », bride ou bannit les gros volumes, et ne
promet aucune disponibilité ([README Photon, section Demo server](https://github.com/komoot/photon#demo-server)).
On observe des réponses 503 et 1 à 3 s de latence. Pour un lancement public, il faut notre propre instance.

Ce dossier contient tout ce qu'il faut :

| Fichier | Rôle |
|---|---|
| `Dockerfile` | Image Photon officielle (jar GitHub de komoot/photon, Java 21) |
| `docker-compose.yml` | Photon + Caddy (HTTPS automatique) |
| `Caddyfile` | N'expose que `/api`, `/reverse` et `/status` |
| `update-index.sh` | Télécharge l'index France, vérifie le MD5, bascule, redémarre, revient en arrière si KO |
| `healthcheck.sh` | Fait une vraie recherche et dit OK ou KO |

Légende des chiffres : **[mesuré]** lu sur la source citée, **[estimé]** calcul ou ordre de grandeur, **[à vérifier]** pas confirmé.
Sources consultées le 22/10/2026.

## 1. Le choix technique

### Ce qui existe

- **Version de Photon** : 1.3.0, publiée le 07/08/2026, un seul fichier `photon-1.3.0.jar` (98 Mo). Java 21 minimum. OpenSearch est embarqué, rien d'autre à installer. [mesuré] [releases](https://github.com/komoot/photon/releases), [README](https://github.com/komoot/photon)
- **Index prêts à l'emploi** publiés par GraphHopper, un par semaine. [mesuré] [dossier France](https://download1.graphhopper.com/public/europe/france-monacco/)
  - France + Monaco : `photon-db-france-monacco-1.0-latest.tar.bz2`, **5,1 Go compressé**, avec un fichier `.md5`.
  - Le format « 1.0 » correspond aux Photon 1.x. Un index 0.7 ne marche pas avec Photon 1.x.
  - L'ancien dossier `/public/extracts/by-country-code/fr/` est figé à juillet 2025 (ancien format) : ne pas l'utiliser.
- **Pas d'index Île-de-France seule.** [mesuré] Pour en faire un, il faut soit importer une base Nominatim de la région, soit filtrer soi-même le dump JSON France (1,6 Go) car Photon n'a pas de filtre par zone ([usage.md](https://github.com/komoot/photon/blob/master/docs/usage.md)).
- **Image Docker** : Komoot n'en publie pas. La plus suivie est [rtuszik/photon-docker](https://github.com/rtuszik/photon-docker) (non officielle, 2.4.0 du 17/08/2026, accepte `REGION=fr`). Elle télécharge par défaut depuis un miroir communautaire, pas depuis GraphHopper. [mesuré]

### Ce qu'on retient : l'index France complet, avec le jar officiel

C'est l'option la plus légère **à faire tourner et à maintenir** :

- aucun Nominatim (une base PostgreSQL de plus, des heures d'import, des réglages) ;
- un seul téléchargement par semaine, vérifié par MD5, depuis la source officielle ;
- le surcoût de la France entière par rapport à l'Île-de-France est de quelques Go de disque, pas plus cher sur un petit serveur. L'app filtre déjà les résultats sur l'Île-de-France (`IDF_BBOX` dans `app/sources.py`).

On n'utilise pas l'image rtuszik pour garder une chaîne simple et vérifiable (jar GitHub + index GraphHopper). Elle reste un bon plan B : `REGION=fr`, `UPDATE_STRATEGY=PARALLEL`, `UPDATE_INTERVAL=7d`.

### Dimensionnement

| Ressource | Valeur | Statut |
|---|---|---|
| Téléchargement | 5,1 Go | [mesuré] |
| Index décompressé | environ 7,5 à 8 Go | [estimé] : la planète fait 62,9 Go compressée et environ 95 Go sur disque, soit un facteur 1,5 |
| Disque au pire pendant une mise à jour | environ 21 Go (archive + nouvel index + ancien) | [estimé] |
| Disque conseillé | 40 Go minimum, 80 Go confortable, SSD/NVMe | [estimé] ; le README Photon recommande SSD, NVMe mieux |
| RAM | 8 Go conseillés, mémoire Java `-Xmx3g` | [estimé] : aucune valeur officielle par pays. Pour la planète entière, le README recommande 64 Go |
| CPU | 2 à 4 vCPU | [estimé] : le trafic de Roulib est faible, le cache de l'app absorbe les répétitions |
| Durée d'installation | 5 à 45 min (téléchargement puis décompression bzip2) | [estimé], à mesurer au premier lancement |
| Fréquence de mise à jour | hebdomadaire (nouvel index chaque semaine) | [mesuré] sur le dossier GraphHopper |

## 2. Où l'héberger

| Option | Machine | Prix/mois | Avis |
|---|---|---|---|
| **Hetzner Cloud CX33** (recommandé) | 4 vCPU, 8 Go RAM, 80 Go NVMe, 20 To de trafic | **8,99 € HT** | Le moins cher pour la bonne taille. Centres de données en Allemagne et en Finlande (UE), environ 10 à 20 ms de Paris [estimé]. |
| Hetzner CX23 (budget serré) | 2 vCPU, 4 Go, 40 Go | 5,99 € HT | Possible avec `-Xmx2g`, mais 4 Go de RAM et 40 Go de disque sont justes [à vérifier]. |
| Scaleway DEV1-M (Paris) | 3 vCPU, 4 Go | 14,74 € + disque (environ 0,10 €/Go/mois, soit ~3 € pour 30 Go) + IPv4 | Hébergé à Paris, plus cher, RAM juste. |
| Fly.io | shared-cpu-2x, 4 Go + volume 30 Go | environ 25 $ + 4,50 $ | Plus cher, volumes à gérer, région Paris à vérifier. |
| Aiven Runtime | 0,5 CPU, 0,25 à 8 Go, dès 7 $/mois | Ne convient pas | Les pages de doc lues décrivent un service **sans état** et ne mentionnent pas de disque persistant. Un index de 8 Go doit survivre aux redémarrages. [à vérifier auprès d'Aiven] |

Sources prix : [Hetzner cost-optimized](https://www.hetzner.com/cloud/cost-optimized/), [Scaleway instances](https://www.scaleway.com/en/pricing/virtual-instances/), [Scaleway stockage](https://www.scaleway.com/en/pricing/storage/), [Fly.io](https://docs.fly.io/about/pricing), [Aiven Runtime](https://aiven.io/pricing/runtime), [doc Aiven Runtime](https://aiven.io/docs/products/runtime).
Attention : le jour de la consultation, la page Hetzner affichait les offres « currently unavailable ». Vérifier la disponibilité dans la console, sinon prendre CAX21 (Arm, 4 vCPU, 8 Go, 80 Go, 10,99 €), l'image Temurin existe en Arm.

**Recommandation : Hetzner CX33, environ 9 € HT par mois, avec ce kit.**

## 3. Installation pas à pas

Prérequis : un serveur Ubuntu 24.04 (ou Debian 12), un accès SSH, et un sous-domaine (ex. `photon.roulib.fr`) dont l'enregistrement DNS de type A pointe vers l'IP du serveur.

1. **Installer Docker et les outils** (sur le serveur) :
   ```bash
   curl -fsSL https://get.docker.com | sudo sh
   sudo apt-get install -y pbzip2 git
   sudo usermod -aG docker $USER   # puis se déconnecter et se reconnecter
   ```
2. **Ouvrir le pare-feu** : ports 22, 80 et 443 seulement (pare-feu Hetzner dans la console, ou `ufw`).
3. **Copier le kit** :
   ```bash
   sudo mkdir -p /opt/roulib-photon && sudo chown $USER /opt/roulib-photon
   git clone --depth 1 <url du dépôt Roulib> /tmp/roulib
   cp -r /tmp/roulib/deploy/photon/. /opt/roulib-photon/
   cd /opt/roulib-photon
   ```
4. **Télécharger l'index** (5,1 Go, puis décompression ; lancer dans `tmux` ou `screen`) :
   ```bash
   ./update-index.sh --no-restart
   ```
5. **Démarrer** :
   ```bash
   export PHOTON_DOMAIN=photon.roulib.fr
   docker compose up -d --build
   docker compose logs -f photon    # attendre que le serveur écoute (quelques minutes)
   ```
6. **Vérifier** depuis votre ordinateur :
   ```bash
   curl -s https://photon.roulib.fr/status
   # attendu : {"status":"Ok","import_date":"...","version":"1.3.0",...}
   curl -s "https://photon.roulib.fr/api?q=10%20rue%20de%20Rivoli&limit=2&lang=fr"
   ./healthcheck.sh https://photon.roulib.fr     # affiche OK
   ```
7. **Programmer la mise à jour hebdomadaire** : `crontab -e`, puis ajouter
   ```
   0 4 * * 2 cd /opt/roulib-photon && PHOTON_DOMAIN=photon.roulib.fr ./update-index.sh >> update.log 2>&1
   ```
   Le script garde l'index précédent et y revient si le nouveau ne répond pas.

## 4. Brancher Roulib dessus

L'app lit l'adresse dans la variable `PHOTON_URL` (`app/sources.py`). Elle doit finir par `/api/`.

- **Aiven** : console Aiven, service de l'app, onglet des variables d'environnement, ajouter `PHOTON_URL` = `https://photon.roulib.fr/api/`, puis « Deploy latest commit ».
- **Vercel** : projet `roulib`, Settings, Environment Variables, ajouter `PHOTON_URL` pour Production, puis `vercel deploy --prod`.

Vérifier côté app :
```bash
curl -s "https://<domaine de l'app>/api/suggest?q=boulangerie%20rue%20oberkampf" | head -c 400
```
Dans les journaux de l'app, il ne doit plus y avoir de « Photon unavailable … falling back to the IGN geocoder ».

Retour arrière : supprimer `PHOTON_URL` et redéployer. L'app reprend l'instance publique.

## 5. Sécurité et exploitation

- Photon n'a pas d'authentification. Caddy n'expose que la recherche (`/api`, `/reverse`, `/status`). Le port 2322 n'est pas publié. La route de mise à jour `/nominatim-update` n'est jamais exposée (la doc Photon l'interdit en public).
- Pour réserver l'instance à Roulib : ajouter une authentification basique dans le Caddyfile (`basic_auth`) et mettre les identifiants dans `PHOTON_URL` (`https://user:motdepasse@photon.roulib.fr/api/`). httpx transmet ces identifiants, mais **à tester** avant la prod. `PHOTON_URL` devient alors un secret.
- Surveillance : faire appeler `https://photon.roulib.fr/status` toutes les 5 minutes par un service gratuit (UptimeRobot, Better Stack, Hetzner n'en fournit pas).
- Mises à jour système : `sudo apt-get install unattended-upgrades` sur le serveur.
- Attribution : les données viennent d'OpenStreetMap (ODbL). L'app doit afficher « © OpenStreetMap contributors » et peut citer Photon (voir `deploy/CHECKLIST.md`).

## 6. Si Photon tombe : comportement actuel et pistes

Ce que fait le code aujourd'hui (`app/sources.py`, fonctions `suggest` et `_suggest_photon`) :

1. Chaque recherche appelle Photon avec un délai maximal de 6 s.
2. Sur une réponse 429 ou 503, l'app attend 0,4 s et réessaie une fois.
3. Sur toute autre erreur (délai dépassé, réseau, 5xx, JSON illisible) ou si Photon ne renvoie rien, elle bascule sur le géocodeur IGN (`data.geopf.fr/geocodage/search`) : deux appels (lieux puis adresses, délai 8 s chacun).
4. Les réponses Photon réussies sont gardées 24 h en mémoire (clé : texte, position arrondie, nombre de résultats ; vidé au-delà de 5 000 entrées). Les réponses IGN ne sont pas gardées dans ce cache.
5. En plus, `/api/suggest` et `/api/geocode` sont servies avec `s-maxage=3600` et `stale-while-revalidate=86400` (`app/http_cache.py`). Sur Vercel, le CDN sert donc la même recherche pendant 1 h sans appeler l'app.

Conséquences :

- Photon en panne franche (refus de connexion) : la recherche marche avec l'IGN, résultats un peu moins bons pour les commerces et les lieux.
- Photon lent ou qui ne répond pas : jusqu'à 6 s perdues (12,4 s si 503 puis délai) avant la bascule, puis jusqu'à 16 s d'IGN. C'est le pire cas pour l'utilisateur.
- Sur Vercel, le cache mémoire est perdu à chaque démarrage à froid d'une fonction. Le CDN reste le vrai cache.

Pistes d'amélioration (non implémentées, à décider par l'équipe) :

1. **Coupe-circuit** : après 3 échecs Photon en 1 minute, passer directement par l'IGN pendant 2 minutes. Supprime les 6 s d'attente répétées.
2. **Délai plus court** pour l'autocomplétion : 2 à 3 s au lieu de 6 s sur une instance auto-hébergée (elle répond en général en moins de 100 ms [estimé]).
3. **Deux URL Photon** : `PHOTON_URL` (la nôtre) puis l'instance publique en secours, avant l'IGN.
4. **Mettre aussi en cache les réponses IGN** (quelques heures) pour ne pas rappeler l'IGN pour la même saisie.
5. **Appels IGN en parallèle** (lieux et adresses en même temps) pour diviser par deux la latence de secours.
6. **Rendre la panne visible** : compteur des bascules vers l'IGN dans `/health`, pour l'alerte.
