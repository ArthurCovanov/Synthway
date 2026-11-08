# Bibliothèques tierces

Chaque sous-dossier contient **uniquement des fichiers amont, non modifiés**. Une mise à jour consiste à remplacer ces fichiers par ceux de la nouvelle version : voir le skill `vendor-update` (`.claude/skills/vendor-update/SKILL.md`).

Chaque bibliothèque est compilée à part, en bibliothèque statique (`build/vendor/<plateforme>/lib<nom>.a`), avec ses propres options et sans avertissements, puis liée dans `synthway.dll` / `libsynthway.so`. Les scripts de build ne la recompilent que si ses sources ont changé.

| Bibliothèque | Version | Licence | Source | Fichiers repris |
| --- | --- | --- | --- | --- |
| miniaudio | 0.11.25 | Domaine public ou MIT-0, au choix (texte en fin de `miniaudio.h`) | https://github.com/mackron/miniaudio | `miniaudio.h` |
| RtMidi | 6.1.0 | Type MIT ; la demande de renvoyer les modifications n'est pas contraignante (`rtmidi/LICENSE`) | https://github.com/thestk/rtmidi | `RtMidi.h`, `RtMidi.cpp`, `rtmidi_c.h`, `rtmidi_c.cpp`, `LICENSE` |

## Ce qui est à nous

La configuration de chaque bibliothèque vit dans `src/`, pas ici :

- `src/miniaudio_config.h` choisit les modules de miniaudio compilés ; `src/miniaudio_impl.c` contient son implémentation.
- Les backends RtMidi sont choisis par les systèmes de build : WinMM sous Windows (`RTMIDI_API_WINMM`), ALSA sous Linux (`RTMIDI_API_ALSA`), CoreMIDI sous macOS (`RTMIDI_API_CORE`).

## Dépendances système

- **Windows :** aucune ; `winmm` et `ole32` font partie du système. Le runtime C++ est lié en statique, pour que la DLL se charge sans MSYS2 dans le `PATH`.
- **Linux :** en-têtes ALSA pour compiler (`libasound2-dev` sous Debian, `alsa-lib` sous Arch), `libasound` à l'exécution.
