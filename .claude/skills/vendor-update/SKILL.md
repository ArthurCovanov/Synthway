---
name: vendor-update
description: Met à jour une bibliothèque tierce de synthway-core (miniaudio, RtMidi) vers une nouvelle version, ou en ajoute une nouvelle, toujours open-source, libre de droit et en conformité avec ses termes d'utilisation. À utiliser quand l'utilisateur demande de mettre à jour, de changer de version ou d'ajouter une bibliothèque externe au core.
---

# Mettre à jour une bibliothèque tierce

Les bibliothèques tierces sont dans `synthway-core/vendor/<nom>/` : **uniquement des fichiers amont, jamais modifiés**. Elles doivent impérativement être **open-source**, **libres de droit** et respecter scrupuleusement leurs **termes d'utilisation et licences**. Leur configuration est dans `src/io/` (`miniaudio_config.h`) ou dans les systèmes de build. Versions, licences et sources sont dans `synthway-core/vendor/README.md`.

## Mettre à jour

1. Trouve la dernière **version publiée**, jamais une branche :
   - miniaudio : https://github.com/mackron/miniaudio/releases
   - RtMidi : https://github.com/thestk/rtmidi/releases

   Lis les notes de version : changement d'API, de licence, fichiers ajoutés ou renommés.
2. Annonce à l'utilisateur la version visée et ce qui change, et attends son accord avant de télécharger.
3. Télécharge depuis l'**étiquette de version** (pas `master`), dans un dossier temporaire hors du dépôt :
   - miniaudio : `https://raw.githubusercontent.com/mackron/miniaudio/<version>/miniaudio.h`
   - RtMidi : `https://github.com/thestk/rtmidi/archive/refs/tags/<version>.tar.gz`, dont tu reprends `RtMidi.h`, `RtMidi.cpp`, `rtmidi_c.h`, `rtmidi_c.cpp` et `LICENSE`.
4. Remplace les fichiers de `vendor/<nom>/` par les nouveaux, tels quels.
5. Mets à jour la ligne de la bibliothèque dans `vendor/README.md` : version, et licence si elle a changé.
6. Recompile **tout** avec le skill `core-build`, en ajoutant `-Clean` ou `--clean`, sous Windows **et** sous WSL. Vérifie `--list` et `--midi`.
7. Si la compilation casse dans `src/`, adapte notre code, jamais les fichiers de `vendor/`. Seule la couche `src/io/` utilise les bibliothèques tierces (`audio_output.c`, `audio_devices.c`, `wav_file.c`, `midi_ports.c`, `ma_result.h`, `miniaudio_config.h`) : c'est là que se trouvent les adaptations.

## Ajouter une bibliothèque

1. Vérifie la licence et les termes d'utilisation avec l'utilisateur : la bibliothèque doit être **open-source**, **libre de droit** et permettre sans restriction un usage commercial (MIT, BSD, zlib, Apache-2.0, domaine public…). Pas de GPL. Pas de LGPL liée en statique. Conserve impérativement les fichiers de licence et notices de copyright amont dans `vendor/<nom>/` et référence-les dans `vendor/README.md`.
2. Crée `vendor/<nom>/` avec les seuls fichiers amont, et ajoute sa ligne dans `vendor/README.md`.
3. Compile-la comme miniaudio et RtMidi, **dans les quatre systèmes de build** (`build.ps1`, `build.sh`, `Makefile`, `CMakeLists.txt`) :
   - une bibliothèque statique à part, `build/vendor/<plateforme>/lib<nom>.a` (cible `STATIC` dans CMake) ;
   - options `-O2 -w`, plus `-fPIC` hors Windows ;
   - recompilée seulement si ses sources changent ;
   - liée dans `synthway` avant les bibliothèques système.
4. Ajoute ses adresses (versions publiées, fichiers à reprendre) aux étapes 1 et 3 de « Mettre à jour », dans ce skill.
