#!/bin/sh
# Santé de Photon : une vraie recherche doit renvoyer au moins un résultat.
# Usage : healthcheck.sh [URL de base]   (défaut : http://localhost:2322)
# Code de sortie 0 = OK, 1 = KO. Sert à Docker, à cron ou à un service de surveillance.
BASE="${1:-http://localhost:2322}"
BODY=$(curl -fsS --max-time 8 "$BASE/api?q=Tour%20Eiffel&limit=1&lang=fr") || {
  echo "KO: pas de réponse de $BASE"
  exit 1
}
case "$BODY" in
  *'"features":[{'*) echo "OK"; exit 0 ;;
  *) echo "KO: réponse sans résultat"; exit 1 ;;
esac
