# Synthway — instructions pour les agents

Ce fichier est lu automatiquement par Gemini (Antigravity) et par Claude Code (via `CLAUDE.md`).
Il vaut aussi pour les humains : c'est la référence commune sur la façon de travailler dans ce dépôt.

## Le projet

Synthway est un synthétiseur audio en trois parties :

| Dossier | Rôle | Techno | État |
| --- | --- | --- | --- |
| `synthway-core/` | Moteur bas niveau : périphériques, synthèse, lecture, acquisition, MIDI | C11 + miniaudio (audio) + RtMidi (MIDI, C++), compilé en bibliothèque partagée | Premier jet |
| `synthway-server/` | API et ordonnancement, pilote le core | Python, FastAPI, pont `ctypes` | Premier jet |
| `synthway-ui/` | Interface de contrôle du serveur | React, TypeScript, Vite | Premier jet |
| `synthway-demucs/` | Facultatif : séparation de sources de l'onglet Decomposer, lancée par le serveur dans un processus à part | Demucs v4 (Python, PyTorch), environnement uv à lui | Essai local |

- **Présentation publique (GitLab / GitHub) :** `README.md` à la racine, en anglais, et sa version française `README.fr.md`, avec les captures d'écran de `docs/images/`. Garde-les courts et vendeurs, et modifie toujours les deux ensemble ; le détail technique va dans `docs/developpement.md`.
- **Lancer Synthway :** `synthway.bat` (Windows, double-clic), `synthway.sh` (Linux) ou `python3 synthway.py`, depuis les sources ; `packaging/build_windows.py` fabrique le zip Windows prêt à l'emploi, sans rien à installer (`packaging/build_windows.bat` construit d'abord l'interface, par WSL sans Node.js sous Windows) (voir « Le lanceur » et « Le zip Windows » dans `docs/developpement.md`). Le serveur y sert lui-même l'interface construite (`synthway-ui/dist`), sur le port 18741.
- **Vue d'ensemble technique et démarrage :** `docs/developpement.md`.
- **Règles d'architecture par couche :** section « Guide pour les Développeurs Humains et Agents IA » de `docs/developpement.md`. Lis-la avant de modifier une couche.
- **Détail de chaque partie :** le `README.md` de son dossier.

Principe directeur : le son est produit par le core, dans son thread audio. Le serveur et l'UI n'envoient que des commandes ; aucun flux audio ne passe par Python ni par le réseau.

## Qui travaille ici

Trois contributeurs travaillent dans le même dossier, parfois en même temps : l'utilisateur, Claude (Claude Code) et Gemini (Antigravity).

- **Relis un fichier juste avant de le modifier.** Un autre contributeur a pu le changer depuis ta dernière lecture.
- **Ne défais pas une modification que tu n'as pas faite** et ne la « corrige » pas sans demander à l'utilisateur.
- **Tiens le journal** `docs/journal.md` : une entrée avant de commencer une tâche qui modifie des fichiers, mise à jour quand tu as fini. Voir le skill `worklog`.
- **Si une entrée « en cours » d'un autre contributeur touche les mêmes fichiers que toi, arrête-toi et demande à l'utilisateur.**

## Environnement

- Machine Windows. Les compilateurs C et C++ sont ceux de MSYS2 UCRT64 (`C:\msys64\ucrt64\bin`, commandes `cc` et `c++`).
- Le même dossier est accessible depuis WSL : ce sont les mêmes fichiers, pas une copie.
  - Distribution `Debian` (celle de l'utilisateur) : `/home/Abyssal/workspace/synthway`, lien symbolique vers le dossier Windows. Elle a aussi `gcc`, `g++` et ALSA (constaté le 2026-11-09) : un lanceur qui y tourne recompile le moteur s'il est périmé.
  - Distribution `archlinux` (celle par défaut de `wsl`) : `/mnt/c/msys64/home/112165/workspace/synthway`. Elle a `gcc`, `g++` et ALSA ; c'est elle qui sert aux builds Linux.
- Les builds rangent leurs objets par plateforme (`build/obj/windows`, `build/obj/linux`) : un build WSL et un build Windows ne se mélangent pas.
- WSL n'a ni vraie carte son ni MIDI : teste l'audio et le MIDI sous Windows.
- Le serveur tourne sous Windows, avec le Python de MSYS2 UCRT64 (`C:\msys64\ucrt64\bin\python.exe`, dépendances installées par `pacman`, voir le README du serveur) : dans WSL, le son passe par WSLg et arrive avec environ une demi-seconde de retard. Vite reste dans la Debian.
- Le navigateur appelle le serveur directement (`http://127.0.0.1:18741`, accepté par sa règle CORS) ; Vite ne sert que la page. Ça marche sans réglage réseau de WSL : le réseau « mirrored » a été essayé et refusait de redémarrer (`0x8007054f`).
- Le lanceur `synthway.bat` vise un Windows sans WSL. Sur cette machine, Node n'est pas installé sous Windows : le lanceur prend un `synthway-ui/dist` déjà construit (`npm run build` dans WSL, ou double-clic sur `packaging/build_windows.bat`, qui refait aussi le paquet), sinon il demande Node. Ne lance pas le lanceur avec un Node Windows dans ce dossier sans l'accord de l'utilisateur : il réinstallerait `node_modules` pour Windows, et Vite ne marcherait plus dans WSL.

## Conventions

- **Langues :** code, identifiants et commentaires en anglais ; documentation (READMEs des dossiers, `docs/`, ce fichier, skills) en français, sauf le `README.md` racine, en anglais (avec `README.fr.md`).
- **Textes de l'interface :** jamais écrits en dur dans le code. Chaque texte visible (y compris `title`, `aria-label`, `placeholder`) a sa clé dans `synthway-ui/src/i18n/locales/en.json` **et** dans `fr.json` ; l'anglais est la langue par défaut. Voir « Langues de l'interface » dans `docs/developpement.md`.
- **Licence du projet :** Apache-2.0, texte dans `LICENSE` à la racine. Le code tiers garde sa propre licence. Une dépendance doit pouvoir être distribuée avec du code Apache-2.0 : pas de GPLv2 seule, par exemple.
- **API du core :** préfixe `synthway_`, macro `SYNTHWAY_API`, retour `synthway_result_t` quand la fonction peut échouer. L'API reste en C pur, car le serveur la charge par FFI. Toute modification passe par le skill `core-api-change`.
- **Code tiers, bibliothèques et assets :** Tout élément externe introduit dans le projet (dépendances C/C++, paquets Python ou npm, polices, icônes, échantillons audio, images...) doit impérativement être **open-source**, **libre de droit** (permettant un usage commercial sans redevance : MIT, Apache-2.0, BSD, ISC, zlib, CC0 / Domaine Public...) et **respecter scrupuleusement les termes d'utilisation et de licence** (attribution requise, conservation des notices de copyright et conditions de distribution). Aucune ressource propriétaire, à usage non-commercial restreint (ex. CC-BY-NC) ou sous licence virale incompatible (ex. GPL liée en statique) n'est acceptée. Pour `synthway-core/vendor/`, suivre le skill `vendor-update`. Pour toute dépendance ou asset externe, suivre `third-party-resources`.
  - **Exception, essai local :** les poids pré-entraînés de Demucs (`synthway-demucs/`) n'ont pas de licence claire. L'utilisateur les accepte pour un essai sur sa machine, jamais commités ni distribués. À revoir avant toute version distribuée (voir `synthway-demucs/README.md`).
- **Son :** ne lance jamais rien qui joue du son sans l'accord de l'utilisateur. Ça vaut pour le CLI du core sans argument ou avec `--tone`/`--waveform`, pour `python main.py` dans le serveur, et pour l'appel de `/api/engine/start` ou l'envoi de `note_on`. `synthway_cli --list`, `--midi`, `--render` et `--analyze` sont sans risque. Le lanceur (`synthway.py`, `synthway.bat`, `synthway.sh`, le zip) ne joue rien par lui-même : il démarre le vrai serveur sans démarrer le moteur, et ouvre l'interface face à lui ; pour un agent, `--no-browser`, et `--port` si le serveur de l'utilisateur tourne déjà. Dans WSL, un agent lance `python3 synthway.py` plutôt que `synthway.sh`, qui, sans terminal, ouvrirait une fenêtre de terminal par WSLg. Pour vérifier un son, rends-le hors ligne et mesure-le (skill `sound-check`) au lieu de le jouer.
- **Micro :** de même, n'ouvre jamais le micro sans l'accord de l'utilisateur : `synthway_cli --listen`, `synthway_analyzer_open_input`, le message `start` de `/ws/analyzer` du vrai serveur, ou le bouton « Écouter » de l'Analyzer face au vrai serveur. Le serveur factice de l'UI n'ouvre aucun micro. Pour vérifier l'analyse, fais analyser des sons rendus hors ligne (`synthway_analysis_test`, `--analyze`).

## Skills partagés

Les skills sont dans `.claude/skills/<nom>/SKILL.md`, le seul dossier que Claude Code lit. Antigravity y est redirigé par `.agents/skills.json`. Il n'en existe donc qu'un exemplaire.

| Skill | Quand l'utiliser |
| --- | --- |
| `core-build` | Compiler `synthway-core` et vérifier qu'il fonctionne (Windows ou WSL) |
| `core-api-change` | Ajouter ou modifier une fonction publique du core, un type public ou un fichier source |
| `sound-check` | Vérifier le son produit par le moteur sans haut-parleur (rendu hors ligne, mesure de WAV) |
| `ui-build` | Vérifier, compiler et prévisualiser `synthway-ui` (via WSL, avec un serveur factice muet) |
| `file-formats` | Modifier le modèle du Composer ou des instruments : mettre à jour les formats de fichier `.swsong` et `.swinst` |
| `vendor-update` | Mettre à jour une bibliothèque tierce du core (miniaudio, RtMidi) ou en ajouter une |
| `third-party-resources` | Ajouter ou mettre à jour une dépendance (C/C++, Python, npm) ou un asset (icône, police, son, image) externe |
| `worklog` | Commencer ou terminer une tâche qui modifie des fichiers |
| `new-skill` | Créer un skill pour ce projet |

Ne crée pas de skill dans `.agents/skills/` : Claude Code ne le verrait pas. Suis `new-skill`.
