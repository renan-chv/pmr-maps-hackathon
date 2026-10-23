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
- Suppression du compte (règle 5.1.1(v)) : Profil › Delete my data.
- Contenus publiés par les utilisateurs (règle 1.2) : signaler un contenu, masquer une personne, filtre de mots, masquage automatique après signalements.
- Politique de confidentialité : `static/privacy.html`, servie par le backend à `/static/privacy.html`.

## Ce qu'il te reste à faire (ça demande ton compte Apple)

1. **Apple Developer Program** (99 €/an) : https://developer.apple.com/programs/enroll/. Compte 24 à 48 h de validation.
2. Dans Xcode : `npx cap open ios`, puis la cible **App** › Signing & Capabilities › choisis ton équipe (Team). La signature automatique crée les certificats.
3. Sur **App Store Connect** (https://appstoreconnect.apple.com) : My Apps › + › New App. Plateforme iOS, nom « Roulib » (s'il est pris : « Roulib – Accessible trips »), langue principale English, bundle ID `fr.roulib.app`, SKU `roulib-ios-1`.
4. Dans Xcode : choisis l'appareil « Any iOS Device (arm64) », puis Product › **Archive** › Distribute App › App Store Connect › Upload.
5. Remplis la fiche avec les textes ci-dessous, ajoute les captures d'écran (iPhone 6,9" : 1320 × 2868, au moins 3) et envoie en review.

## Fiche App Store (à copier)

**Name** : Roulib
**Subtitle** (30 car.) : Step-free trips, checked live
**Category** : Navigation (secondaire : Travel)
**Age rating** : 4+ (contenus utilisateurs modérés)
**Privacy Policy URL** : https://01a1630f-d719-7e22-99af-faa332f9258b-8080.eur-1.aiven.app/static/privacy.html
**Support URL** : https://github.com/renan-chv/pmr-maps-hackathon/issues

**Promotional text** :
Before you leave, know if your trip really works: every lift, roadwork and step on the way, checked live for your wheelchair, walker or pushchair.

**Description** :
Roulib checks every step of a public-transport trip in Paris and Île-de-France, from your door to the door of your destination, for the way you move.

• Choose your profile once: manual or power wheelchair, walker or cane, pushchair, low vision.
• Search a station, a place or an address. Roulib checks each step of the trip against live data: lift status from Île-de-France Mobilités, roadworks on sidewalks from the City of Paris, stairs, and the accessibility of your destination from Acceslibre.
• A lift is out of order? You know before you leave, with the reason and a Plan B in one tap.
• Every check shows its source and how fresh it is. Unknown is never shown as accessible.
• Stations: live lifts and how often they fail.
• Places: step-free entrance, door width and adapted toilets for restaurants and shops nearby.
• Community: spot a broken lift or a blocked sidewalk? Report it in seconds with a photo, your voice or a few words. Everyone on the route is warned.

No account with a password, no ads, no tracking.

**Keywords** (100 car.) :
wheelchair,accessible,lift,elevator,metro,RER,Paris,PMR,handicap,step-free,mobility,pushchair,transit

**Version française** (à ajouter en localisation fr-FR) :
- Nom : Roulib
- Sous-titre : Trajets sans marche, vérifiés
- Mots-clés : fauteuil,PMR,accessible,ascenseur,métro,RER,Paris,handicap,poussette,mobilité réduite,trajet

## Confidentialité dans App Store Connect (App Privacy)

| Donnée | Collectée | Liée à l'utilisateur | Pistage | Usage |
|---|---|---|---|---|
| Position précise | Oui | Non | Non | Fonctionnement de l'app |
| Photos | Oui (photos des signalements) | Oui | Non | Fonctionnement de l'app |
| Autres contenus utilisateur | Oui (texte des signalements, questions à l'assistant) | Oui | Non | Fonctionnement de l'app |
| Nom | Oui (prénom facultatif) | Oui | Non | Fonctionnement de l'app |

Tout le reste : **non collecté**.

## Notes pour la review (App Review Information › Notes)

Roulib works for public transport in Paris and Île-de-France (France). Live trip checks need a start and a destination in that area. To see the full flow from anywhere, tap the search bar and use "See a sample trip (recorded)": it opens a real trip recorded on 22 October 2026, clearly labelled "Recorded example, not live". No login is needed. Community reports can be flagged ("Report as inappropriate") and hidden per author; a report with two flags is removed automatically. Account and data deletion: Profile › Delete my data.

## Avant chaque nouvelle version

- Mettre à jour `MARKETING_VERSION` / `CURRENT_PROJECT_VERSION` dans Xcode (cible App › General).
- `npm run sync`, tester sur le simulateur, puis Archive.
