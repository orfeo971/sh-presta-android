# SH Presta Terrain

Application Android du **prestataire Smart Hands** pour les interventions au datacenter de
[SH Presta](https://github.com/orfeo971/sh-presta) (dépôt privé) : récupération du matériel au siège,
chargement de la bandothèque TS4300, contrôles visuels, anomalies avec photos, retour au siège.

Elle fonctionne **sans réseau au datacenter** : le dossier de chaque intervention est enregistré sur le
téléphone avant le départ, chaque geste est conservé puis envoyé au retour du réseau, avec son heure réelle.

## Ce que fait l'application

| | |
|---|---|
| Mes interventions | en cours, du jour, à venir, terminées récemment ; « prête hors connexion » quand le dossier est sur le téléphone |
| Historique | toutes les interventions passées de l'entreprise, tous intervenants confondus et sans limite de durée : recherche, filtre par statut, regroupement par mois ; rapport PDF et mouvements réalisés de chaque intervention |
| Étape 1 — siège | pointage des cartouches (scan, douchette ou toucher) et du matériel à récupérer |
| Étape 2 — datacenter | TS4300 par touchers (poser, retirer, déplacer, « placer selon le plan »), contrôles visuels, opération ponctuelle, anomalies avec photos |
| Étape 3 — retour | restitution des cartouches retirées ou non chargées, du matériel à ramener |
| Hors connexion | bandeau « N actions en attente », envoi automatique au retour du réseau, refus du serveur listés (réessayer / abandonner) |
| Session | reste ouverte sur le terrain (jeton de renouvellement) ; si elle expire, reconnexion sans perdre les actions |
| Sécurité | verrouillage par empreinte ou code du téléphone (facultatif) ; aucune donnée dans les sauvegardes Google |
| Notifications | intervention attribuée, matériel prêt, déplacée, annulée — vérifié toutes les 30 min environ, même application fermée |
| Mises à jour | depuis l'application (Réglages › Mises à jour), via `@orfeo/updater` et les Releases de ce dépôt |

L'adresse du serveur est saisie au premier lancement (rien n'est écrit dans l'APK). Le HTTP n'est accepté que
vers une adresse du réseau de l'entreprise (IP privée, nom interne) ; ailleurs, HTTPS est obligatoire.

## Prérequis côté serveur

Le serveur SH Presta doit inclure les évolutions pour l'application mobile (branche `ccr-a6b35641-fs8r6b`
de `orfeo971/sh-presta`) : horodatage réel (`X-Realise-Le`), idempotence (`Idempotency-Key`), jeton de
renouvellement (`/api/auth/refresh`), dossier terrain (`/api/interventions/:id/terrain`), CORS de l'application.
Les tables nécessaires sont créées automatiquement au démarrage de l'API.

Le téléphone doit joindre le serveur : réseau de l'entreprise ou VPN.

## Installer l'APK

Chaque envoi sur `main` compile l'APK (workflow `SH Presta APK`, procédure commune de
`orfeo971/orfeo-android-commun`) et le publie dans les **Releases** (`SH-Presta-0.1.N.apk`).
Le dépôt est public : aucun jeton GitHub n'est nécessaire sur les téléphones pour les mises à jour.

### Clé de signature (une seule fois, avant la première publication)

Toutes les versions doivent être signées avec la **même clé**, sinon Android refuse la mise à jour.
La clé reste hors du dépôt :

```bash
keytool -genkeypair -v -keystore shpresta-signing.jks -alias shpresta -keyalg RSA -keysize 4096 -validity 36500 \
  -dname "CN=SH Presta, O=orfeo971, C=FR"
base64 -w0 shpresta-signing.jks > shpresta-signing.b64      # macOS : base64 -i shpresta-signing.jks -o shpresta-signing.b64
```

Puis dans GitHub : Settings › Secrets and variables › Actions › **Repository secrets** :
`ANDROID_KEYSTORE_BASE64` (contenu du fichier .b64) et `ANDROID_KEYSTORE_PASSWORD` (le mot de passe choisi,
le même pour le magasin et la clé). Garder `shpresta-signing.jks` et son mot de passe en lieu sûr.

## Développement

```bash
npm ci
npm test          # logique terrain, file d'envoi, TS4300, adresse, notifications
npm run serve     # version web sur http://localhost:8080 (scanner et verrouillage : APK seulement)
npm run sync      # build/ puis copie dans android/
```

Pour la version web contre un serveur de développement, ajouter `http://localhost:8080` à `FRONTEND_ORIGIN`.

| Fichier | Rôle |
|---|---|
| `www/js/app.js` | écrans et événements |
| `www/js/regles.js` | règles des étapes (identiques au serveur) |
| `www/js/actions.js` | gestes de terrain → requêtes (identifiant unique, heure réelle) |
| `www/js/optimiste.js` | vue d'une intervention = dossier reçu + actions en attente |
| `www/js/file.js` | envoi dans l'ordre, coupures, session, refus, photos d'anomalies créées hors connexion |
| `www/js/ts4300.js` | brouillon de chargement de la bandothèque, grille des magasins |
| `www/js/stockage.js` | IndexedDB : dossiers, actions, photos, brouillons |
| `www/js/api.js` | session et appels au serveur |
| `www/js/native.js` | scanner ML Kit, appareil photo, vibration, réseau, verrouillage, notifications |
| `www/js/adresse.js`, `www/js/veille.js` | adresse du serveur ; notifications |
| `android/…/VeilleService.java`, `VeillePlugin.java` | vérification périodique, application fermée |
| `.github/workflows/android.yml` | compilation et publication de l'APK |
