# SH Presta Terrain : consignes pour Claude

- Tout ce qui s'affiche dans l'application, les messages de commit et la documentation est en **français**.
- Même architecture que Plouf et Level Up : Capacitor 8, code dans `www/` sans framework, esbuild pour l'APK.
- La logique pure (règles des étapes, actions, vue hors connexion, file d'envoi, TS4300, adresse, notifications)
  vit dans des modules sans dépendance, couverts par `tests/` (`npm test`). L'interface est dans `www/js/app.js`.
- Les règles des étapes (`www/js/regles.js`) reproduisent celles du serveur `orfeo971/sh-presta`
  (`backend/src/modules/etapes-terrain/routes.ts`) : toute évolution côté serveur doit y être répercutée.
- Chaque geste devient une action (`www/js/actions.js`) avec un identifiant unique (`Idempotency-Key`) et son heure réelle
  (`X-Realise-Le`) ; ne jamais envoyer une modification au serveur autrement que par la file.
- Dépôt **public** : aucune adresse de serveur, aucun identifiant, aucune clé de signature dans le code.
- Mise à jour de l'application : paquet commun `@orfeo/updater` (dépôt `orfeo971/orfeo-android-commun`), ne pas recopier son code.
- La vérification en arrière-plan (`android/…/VeilleService.java`) applique la même règle que `www/js/veille.js`.
