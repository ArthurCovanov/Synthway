---
name: core-api-change
description: Procédure pour ajouter ou modifier une fonction publique de synthway-core, un type public, un code d'erreur ou un fichier source, en gardant le pont Python synchronisé. À utiliser avant de toucher à synthway-core/include/synthway/ ou d'ajouter un fichier dans synthway-core/src/.
---

# Modifier l'API publique de synthway-core

Le serveur charge la bibliothèque par `ctypes` (`synthway-server/src/core_bridge.py`). L'API doit donc rester une API C pure, et chaque changement doit être répercuté côté Python, sinon le serveur plante ou lit des valeurs fausses sans erreur visible.

## Règles de l'API

- Déclaration dans l'en-tête public de sa couche, dans `synthway-core/include/synthway/` : `engine.h` (moteur), `devices.h` (périphériques audio et MIDI) ou `synthway.h` (version, codes d'erreur). Types dans `types.h`. `synthway.h` inclut les autres : c'est le seul que le CLI et les tests incluent.
- Préfixe `synthway_`, macro `SYNTHWAY_API` sur la déclaration **et** sur la définition. Une fonction interne, appelée d'un fichier à l'autre, prend le préfixe `sw_<module>_` et pas de `SYNTHWAY_API` : elle n'est pas exportée.
- Une fonction qui peut échouer renvoie un `synthway_result_t`. Les résultats passent par des pointeurs de sortie (`out_...`).
- Pas de structure passée ou renvoyée par valeur, pas de type C++, pas de `FILE*` : des types C de base, des pointeurs, et le handle opaque `synthway_engine_t*`.
- Énumérations : valeurs explicites. On ajoute à la fin, sans renuméroter : le code Python dépend des valeurs.
- La bibliothèque n'écrit pas sur la sortie standard : l'affichage appartient au CLI.

## Étapes

1. Déclare la fonction et ses types dans les en-têtes publics, avec un commentaire `/** ... */` qui dit ce qu'elle fait.
2. Implémente-la dans le dossier de sa couche, en respectant les règles de dépendance de la section « Sous-couches du moteur » de `synthway-core/README.md` :
   - `src/engine/` : cycle de vie (`engine.c`), réglages temps réel (`engine_params.c`), rendu hors ligne (`engine_offline.c`) ;
   - `src/synth/` : le calcul du son, appelé par l'engine (jamais de fonction publique ici) ;
   - `src/io/` : carte son, périphériques, MIDI, fichiers. Seule cette couche inclut miniaudio ou RtMidi.

   Valide les paramètres et renvoie `SYNTHWAY_INVALID_PARAM` si besoin.
3. Si le code tourne dans le thread audio ou partage des données avec lui, respecte les règles temps réel du `README.md` racine : pas d'allocation, pas de verrou, pas d'entrée/sortie. Une valeur écrite par un thread et lue par le thread audio passe par un champ `_Atomic` de `sw_engine_params` (`engine_params.h`) : écriture relâchée dans le setter, lecture dans `sw_engine_params_snapshot`, qui la copie dans `sw_synth_params` pour le synthé.
4. Nouveau code d'erreur : ajoute-le aussi dans `synthway_result_to_string` (`src/synthway.c`).
5. **Nouveau fichier source :** ajoute-le dans les quatre systèmes de build, sinon l'un d'eux cassera. Les chemins sont relatifs à `src/`, dans un dossier de couche (un seul niveau : `src/<couche>/<nom>.c`) :
   - `CMakeLists.txt` : `SYNTHWAY_SOURCES` (`${SYNTHWAY_SRC_DIR}/synth/filter.c`)
   - `Makefile` : `SRCS` (`src/synth/filter.c`)
   - `build.sh` : la liste `SOURCES` (`synth/filter`)
   - `build.ps1` : le tableau `$sources` (`"synth/filter"`)

   Les en-têtes internes (`.h` à côté des `.c`) n'ont pas à être déclarés. Une bibliothèque tierce ne s'ajoute pas ici : suis le skill `vendor-update`.
6. **Pont Python :** dans `synthway-server/src/core_bridge.py`, déclare `argtypes` et `restype` de chaque nouvelle fonction et ajoute la méthode correspondante à `SynthwayCore`. Si une structure publique change, mets à jour sa copie `ctypes.Structure` : même ordre de champs, mêmes types. Si une énumération change, mets à jour `synthway-server/src/models.py` et `synthway-ui/src/types.ts`.
7. Si la fonctionnalité est utile à la main, expose-la dans `examples/cli_main.c` et mets à jour `print_usage`.
8. Mets à jour la section API de `synthway-core/README.md`, et celle de `synthway-server/README.md` si un endpoint change.
9. Compile et vérifie avec le skill `core-build`.
