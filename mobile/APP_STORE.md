# Roulib sur l'App Store

L'app iOS est une coque Capacitor 8 autour du front web (`static/`). L'interface est embarquée dans l'app, ce qui permet d'ouvrir l'app sans réseau. Les données arrivent du backend hébergé sur Aiven, qui garde toutes les clés API (PRIM, Anthropic, base de données). **Aucune clé n'est dans l'app**, et il ne faut jamais en mettre : un fichier `.ipa` se décompresse en deux minutes.

## Construire et lancer

```bash
cd mobile
npm install
npm run sync          # copie static/ dans www/ (MapLibre et la police en local), puis cap sync
npx cap run ios       # simulateur iPhone
npx cap open ios      # ouvre Xcode : Product › Archive pour l'App Store
npx cap run android   # émulateur Android
```

À refaire après chaque changement dans `static/` : `npm run sync`.

L'adresse du backend est dans `static/native.js` (`window.ROULIB_API`). Pour la production, mieux vaut un nom de domaine stable (par exemple `api.roulib.fr`) que l'adresse Aiven actuelle.

## Ce qui est déjà prêt

- Bundle ID `fr.roulib.app`, nom affiché « Roulib », version 1.0 (1), iPhone uniquement, portrait.
- Icône 1024 × 1024 sans transparence et écran de lancement (`assets/`, copiés dans `Assets.xcassets`).
- Phrases d'autorisation : position, appareil photo, photothèque, micro, reconnaissance vocale.
- `ITSAppUsesNonExemptEncryption = false` : uniquement du HTTPS standard, aucune déclaration d'export à faire.
- Manifeste de confidentialité `PrivacyInfo.xcprivacy` : aucun pistage, données déclarées ci-dessous.
- Fonctions natives (règle 4.2, pas un simple site emballé) : position native, retour haptique, navigateur intégré, barre d'état, écran de lancement, interface et cartes hors ligne.
- Suppression du compte (règle 5.1.1(v)) : Profil › Supprimer mes données.
- Contenus publiés par les utilisateurs (règle 1.2) : signaler un contenu, masquer une personne, filtre de mots, masquage automatique après signalements.
- Politique de confidentialité : `static/privacy.html`, servie par le backend à `/static/privacy.html`.

## Ce qu'il te reste à faire (ça demande ton compte Apple)

1. **Apple Developer Program** (99 €/an) : https://developer.apple.com/programs/enroll/. Compte 24 à 48 h de validation.
2. Dans Xcode : `npx cap open ios`, puis la cible **App** › Signing & Capabilities › choisis ton équipe (Team). La signature automatique crée les certificats.
3. Sur **App Store Connect** (https://appstoreconnect.apple.com) : My Apps › + › New App. Plateforme iOS, nom « Roulib » (s'il est pris : « Roulib – Accessible trips »), langue principale **Français**, bundle ID `fr.roulib.app`, SKU `roulib-ios-1`.
4. Dans Xcode : choisis l'appareil « Any iOS Device (arm64) », puis Product › **Archive** › Distribute App › App Store Connect › Upload.
5. Remplis la fiche avec les textes ci-dessous, ajoute les captures d'écran (iPhone 6,9" : 1320 × 2868, au moins 3) et envoie en review.

## Fiche App Store (à copier) – langue principale : français

**Nom** : Roulib
**Sous-titre** (30 car.) : Trajets sans marche, vérifiés
**Catégorie** : Navigation (secondaire : Voyages)
**Classification** : 4+ (contenus des utilisateurs modérés)
**URL de la politique de confidentialité** : https://01a1630f-d719-7e22-99af-faa332f9258b-8080.eur-1.aiven.app/static/privacy.html
**URL d'assistance** : https://github.com/renan-chv/pmr-maps-hackathon/issues

**Texte promotionnel** :
Avant de partir, sachez si votre trajet passe vraiment : chaque ascenseur, chaque chantier et chaque marche sur le chemin, vérifiés en direct pour votre fauteuil, votre déambulateur ou votre poussette.

**Description** :
Roulib vérifie chaque étape d'un trajet en transports en commun à Paris et en Île-de-France, de votre porte à la porte de votre destination, selon votre façon de vous déplacer.

• Choisissez votre profil une fois : fauteuil manuel ou électrique, déambulateur ou canne, poussette, malvoyance.
• Cherchez une gare, un lieu ou une adresse. Roulib vérifie chaque étape avec des données en direct : état des ascenseurs d'Île-de-France Mobilités, travaux sur les trottoirs de la Ville de Paris, escaliers, et accessibilité de votre destination grâce à Acceslibre.
• Un ascenseur en panne ? Vous le savez avant de partir, avec la raison et un plan B en un geste.
• Chaque vérification indique sa source et sa fraîcheur. Une information inconnue n'est jamais présentée comme accessible.
• Gares : ascenseurs en direct, et leur fiabilité.
• Lieux : entrée de plain-pied, largeur de porte et toilettes adaptées pour les restaurants et commerces autour de vous.
• Communauté : un ascenseur en panne, un trottoir bloqué ? Signalez-le en quelques secondes, en photo, à la voix ou en quelques mots. Tout le monde sur le trajet est prévenu.

Pas de compte avec mot de passe, pas de publicité, pas de pistage.

**Mots-clés** (100 car.) :
fauteuil,PMR,accessible,ascenseur,métro,RER,Paris,handicap,poussette,mobilité réduite,trajet,sans marche

**Version anglaise** (localisation en-US, facultative) :
- Name : Roulib – Subtitle : Step-free trips, checked live
- Keywords : wheelchair,accessible,lift,elevator,metro,RER,Paris,step-free,mobility,pushchair,transit

## Confidentialité dans App Store Connect (App Privacy)

| Donnée | Collectée | Liée à l'utilisateur | Pistage | Usage |
|---|---|---|---|---|
| Position précise | Oui | Non | Non | Fonctionnement de l'app |
| Photos | Oui (photos des signalements) | Oui | Non | Fonctionnement de l'app |
| Autres contenus utilisateur | Oui (texte des signalements, questions à l'assistant) | Oui | Non | Fonctionnement de l'app |
| Nom | Oui (prénom facultatif) | Oui | Non | Fonctionnement de l'app |

Tout le reste : **non collecté**.

## Notes pour la review (App Review Information › Notes)

Roulib works for public transport in Paris and Île-de-France (France). Live trip checks need a start and a destination in that area. To see the full flow from anywhere, use "Voir un trajet d'exemple (enregistré)" ("See a sample trip, recorded") on the home screen: it opens a real trip recorded on 22 October 2026, clearly labelled as a recorded example, not live. The app is in French. No login is needed. Community reports can be flagged ("Signaler comme inapproprié") and hidden per author ("Masquer les signalements de cette personne"); a report with two flags is removed automatically. Account and data deletion: Profil › Supprimer mes données.

## Avant chaque nouvelle version

- Mettre à jour `MARKETING_VERSION` / `CURRENT_PROJECT_VERSION` dans Xcode (cible App › General).
- `npm run sync`, tester sur le simulateur, puis Archive.
