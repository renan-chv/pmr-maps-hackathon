# Photon (géocodeur OpenStreetMap de Komoot), version officielle, sans image tierce.
# Le jar vient des releases GitHub de komoot/photon. L'index n'est PAS dans l'image :
# il est monté dans /photon (voir docker-compose.yml et update-index.sh).
FROM eclipse-temurin:21-jre

ARG PHOTON_VERSION=1.3.0
# Empreinte SHA-256 du jar, à renseigner pour verrouiller le téléchargement (vide = pas de contrôle).
ARG PHOTON_SHA256=""

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL -o /opt/photon.jar \
      "https://github.com/komoot/photon/releases/download/${PHOTON_VERSION}/photon-${PHOTON_VERSION}.jar" \
 && if [ -n "${PHOTON_SHA256}" ]; then echo "${PHOTON_SHA256}  /opt/photon.jar" | sha256sum -c -; fi

COPY healthcheck.sh /usr/local/bin/photon-healthcheck
RUN chmod 755 /usr/local/bin/photon-healthcheck

# /photon/current contient photon_data/ (l'index en service). update-index.sh prépare ce dossier.
ENV JAVA_OPTS="-Xmx3g"
EXPOSE 2322
HEALTHCHECK --interval=60s --timeout=10s --start-period=300s --retries=3 CMD ["photon-healthcheck"]
CMD ["sh", "-c", "exec java $JAVA_OPTS -jar /opt/photon.jar serve -data-dir /photon/current -listen-ip 0.0.0.0 -listen-port 2322 -default-language fr"]
