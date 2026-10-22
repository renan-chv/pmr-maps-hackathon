#!/usr/bin/env bash
# Télécharge (ou met à jour) l'index Photon France publié chaque semaine par GraphHopper,
# vérifie son empreinte MD5, le décompresse dans un dossier neuf, bascule dessus,
# redémarre Photon et revient à l'index précédent si la recherche ne répond plus.
#
# Usage (depuis deploy/photon/) :
#   ./update-index.sh            # première installation ou mise à jour
#   ./update-index.sh --no-restart   # prépare l'index sans toucher au service
#
# À lancer chaque semaine par cron, par exemple le mardi à 4 h :
#   0 4 * * 2 cd /opt/roulib-photon && ./update-index.sh >> update.log 2>&1
#
# Place disque nécessaire au pire : archive (~5,1 Go) + nouvel index + index précédent.
set -euo pipefail

# Index "1.0" = format des Photon 1.x. Changer seulement si le jar change de version majeure.
INDEX_URL="${INDEX_URL:-https://download1.graphhopper.com/public/europe/france-monacco/photon-db-france-monacco-1.0-latest.tar.bz2}"
MD5_URL="${MD5_URL:-${INDEX_URL}.md5}"
DATA_DIR="${DATA_DIR:-$(pwd)/data}"
RESTART=1
[ "${1:-}" = "--no-restart" ] && RESTART=0

for cmd in curl tar md5sum docker; do
  command -v "$cmd" >/dev/null || { echo "Commande manquante : $cmd"; exit 1; }
done
# pbzip2 décompresse sur plusieurs coeurs quand l'archive le permet, sinon bzip2.
if command -v pbzip2 >/dev/null; then BUNZIP="pbzip2 -dc"; else BUNZIP="bzip2 -dc"; fi

STAMP=$(date +%Y%m%d-%H%M)
mkdir -p "$DATA_DIR/releases" "$DATA_DIR/incoming"
ARCHIVE="$DATA_DIR/incoming/photon-db.tar.bz2"

echo "[$(date -Is)] Téléchargement de $INDEX_URL"
curl -fL --retry 3 --retry-delay 30 -C - -o "$ARCHIVE" "$INDEX_URL"

echo "[$(date -Is)] Vérification MD5"
EXPECTED=$(curl -fsSL "$MD5_URL" | awk '{print $1}')
ACTUAL=$(md5sum "$ARCHIVE" | awk '{print $1}')
if [ -z "$EXPECTED" ] || [ "$EXPECTED" != "$ACTUAL" ]; then
  echo "MD5 incorrect (attendu '$EXPECTED', obtenu '$ACTUAL'). Archive conservée pour analyse, rien n'est changé."
  exit 1
fi

NEW="$DATA_DIR/releases/$STAMP"
mkdir -p "$NEW"
echo "[$(date -Is)] Décompression dans $NEW (plusieurs dizaines de minutes possibles)"
$BUNZIP "$ARCHIVE" | tar -x -C "$NEW"
[ -d "$NEW/photon_data" ] || { echo "photon_data absent de l'archive, abandon."; rm -rf "$NEW"; exit 1; }
rm -f "$ARCHIVE"

PREVIOUS=""
[ -L "$DATA_DIR/current" ] && PREVIOUS=$(readlink "$DATA_DIR/current")
# Lien relatif : il reste valable dans le conteneur (le dossier data y est monté sur /photon).
ln -sfn "releases/$STAMP" "$DATA_DIR/current"
echo "[$(date -Is)] Index actif : releases/$STAMP (précédent : ${PREVIOUS:-aucun})"

if [ "$RESTART" = 1 ]; then
  docker compose restart photon
  echo "Attente du démarrage de Photon (jusqu'à 10 min)"
  for _ in $(seq 1 60); do
    if docker compose exec -T photon photon-healthcheck >/dev/null 2>&1; then
      echo "[$(date -Is)] Photon répond avec le nouvel index."
      break
    fi
    sleep 10
  done
  if ! docker compose exec -T photon photon-healthcheck >/dev/null 2>&1; then
    if [ -n "$PREVIOUS" ]; then
      echo "Photon ne répond pas : retour à $PREVIOUS"
      ln -sfn "$PREVIOUS" "$DATA_DIR/current"
      docker compose restart photon
    fi
    echo "Échec de la mise à jour. Le nouvel index reste dans $NEW pour analyse."
    exit 1
  fi
fi

# Ménage : on garde l'index actif et le précédent, on supprime les plus anciens.
KEEP_CURRENT=$(readlink "$DATA_DIR/current")
for dir in $(ls -1d "$DATA_DIR"/releases/* | sort | head -n -2); do
  rel="releases/$(basename "$dir")"
  [ "$rel" = "$KEEP_CURRENT" ] || { echo "Suppression de l'ancien index $rel"; rm -rf "$dir"; }
done
echo "[$(date -Is)] Terminé."
