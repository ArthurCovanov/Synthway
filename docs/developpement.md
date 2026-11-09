# 🎹 Synthway — guide de développement

Ce document s'adresse à ceux qui développent Synthway, humains et agents IA : architecture, arborescence, compilation et règles de chaque couche. La présentation du projet est dans le [README](../README.md).

> Synthétiseur audio modulaire et surface de contrôle temps réel multiplateforme (Windows & Linux).
> Architecture en 3 piliers : **Moteur C/C++ (miniaudio)** ➔ **Serveur Python (FastAPI/WebSockets)** ➔ **Interface Web (React/Vite)**.

---

## 🏛️ Vue d'ensemble de l'Architecture

Synthway est structuré en **3 sous-projets indépendants et hautement découplés**, permettant à des développeurs humains ou des agents IA de travailler en parallèle sur chaque couche :

```mermaid
flowchart LR
    subgraph UI ["synthway-ui (Frontend)"]
        React["React + TypeScript + Vite"]
        UI_Controls["Instrument Creator, Composer, Analyzer, Decomposer, Réglages"]
    end

    subgraph Server ["synthway-server (Ordonnanceur)"]
        FastAPI["FastAPI (REST & WebSockets)"]
        Bridge["Pont FFI (ctypes)"]
    end

    subgraph Demucs ["synthway-demucs (facultatif)"]
        Separate["Demucs v4 (PyTorch), processus à part"]
    end

    subgraph Core ["synthway-core (Moteur Audio)"]
        Engine["Moteur Audio C11 (Oscillateurs, DSP)"]
        Devices["Énumération Périphériques"]
        Miniaudio["miniaudio (WASAPI / ALSA / PulseAudio)"]
        Midi["Énumération Ports MIDI"]
        RtMidi["RtMidi (WinMM / ALSA / CoreMIDI)"]
    end

    UI_Controls -->|REST: Découverte & Config| FastAPI
    UI_Controls <-->|WebSocket: Note On/Off, Knobs temps réel| FastAPI
    FastAPI --> Bridge
    FastAPI -->|Séparation de sources d'un fichier, hors ligne| Separate
    Bridge -->|Appels C ABI (synthway.dll / libsynthway.so)| Engine
    Engine --> Miniaudio
    Devices --> Miniaudio
    Midi --> RtMidi
    Miniaudio -->|Audio Buffer| Hardware["Haut-parleurs / Casque"]
    RtMidi <-->|Messages MIDI| Controllers["Claviers / Contrôleurs MIDI"]
```

Le détail des échanges entre les couches (qui stocke quoi, où vit le signal audio, trajet d'une note de l'UI jusqu'à la carte son) est dans [`docs/architecture.md`](architecture.md).

---

## 📁 Arborescence Globale du Répertoire

```text
synthway/
├── .gitignore                  # Fichiers ignorés (builds C, venvs Python, node_modules)
├── .gitattributes              # Fins de ligne : CRLF pour les .bat, LF pour les .sh
├── synthway.py                 # Lanceur : prépare le moteur et l'interface, lance le serveur, ouvre le navigateur
├── synthway.bat                # Lanceur Windows (double-clic) : trouve Python, puis synthway.py
├── synthway.sh                 # Lanceur Linux (terminal ou double-clic) : trouve Python, puis synthway.py
├── packaging/build_windows.py  # Fabrique le zip Windows prêt à l'emploi (Python embarqué)
├── packaging/build_windows.bat # Double-clic : interface (par WSL sans Node.js), puis build_windows.py
├── README.md                   # Présentation publique du projet (GitLab / GitHub)
├── LICENSE                     # Licence Apache-2.0
├── AGENTS.md                   # Règles communes aux agents IA (Claude, Gemini) et aux humains
├── CLAUDE.md                   # Point d'entrée de Claude Code (importe AGENTS.md)
├── .claude/skills/             # Skills partagés par les agents (procédures pas à pas)
├── .agents/skills.json         # Redirige Antigravity (Gemini) vers .claude/skills
├── docs/developpement.md       # Ce document (guide de développement, humains & agents)
├── docs/journal.md             # Journal : qui travaille sur quoi
├── docs/architecture.md        # Fonctionnement : flux de données entre les couches
├── docs/formats-de-fichier.md  # Formats .swsong (morceaux) et .swinst (instruments)
├── docs/images/                # Captures d'écran du README
│
├── synthway-core/              # 1. Cœur audio temps réel C/C++ (miniaudio + RtMidi)
│   ├── CMakeLists.txt          # Configuration de build CMake cross-platform
│   ├── Makefile                # Makefile standard (Linux/WSL, MSYS2)
│   ├── build.ps1               # Script de compilation Windows PowerShell
│   ├── build.sh                # Script de compilation Linux Bash
│   ├── README.md               # Guide dédié du Core (API C, compilation, CLI)
│   ├── include/synthway/       # En-têtes C publics (synthway.h, qui inclut types.h, devices.h, engine.h)
│   ├── src/                    # Sources en trois sous-couches : engine/ (chef d'orchestre), synth/ (calcul du son), io/ (carte son, MIDI, fichiers)
│   ├── examples/               # Exécutable de test CLI (cli_main.c)
│   └── vendor/                 # Bibliothèques tierces non modifiées (miniaudio, RtMidi)
│
├── synthway-server/            # 2. Ordonnanceur & API Python (FastAPI + WebSockets)
│   ├── README.md               # Guide dédié du Serveur (endpoints, FFI, WebSocket)
│   ├── requirements.txt        # Dépendances Python
│   ├── pyproject.toml          # Spécification du projet Python
│   └── src/                    # Code source du serveur
│       ├── __init__.py         # Module Python
│       ├── main.py             # Application FastAPI & mode autonome
│       ├── core_bridge.py      # Pont ctypes vers libsynthway
│       ├── models.py           # Modèles Pydantic / Dataclasses
│       └── separation.py       # Decomposer : lance Demucs dans un processus à part
│
├── synthway-demucs/            # Facultatif : séparation de sources (Demucs v4), essai local
│   ├── README.md               # Installation (uv sync), licence, désactivation
│   ├── separate.py             # Script lancé par le serveur
│   └── vendor/demucs/          # Dépôt amont de Demucs, non modifié
│
└── synthway-ui/                # 3. Interface Graphique Utilisateur (React + Vite)
    ├── README.md               # Guide dédié de l'UI (composants, connexion au serveur, stack)
    ├── package.json            # Dépendances Node.js (React, Vite, Lucide)
    ├── tsconfig.json           # Configuration TypeScript
    ├── vite.config.ts          # Configuration Vite, adresse du serveur
    ├── index.html              # Page web hôte
    ├── scripts/                # Déclinaisons du logo, serveur factice muet
    └── src/                    # Code source de l'IHM
        ├── App.tsx             # Navigation entre les 5 écrans
        ├── screens/            # Instrument Creator, Composer, Analyzer, Decomposer, Réglages
        ├── components/         # Barre latérale, contrôles, oscilloscope, clavier
        ├── lib/                # Client API/WebSocket, modèles, état partagé
        ├── styles/             # Thème synthwave (couleurs du logo), polices
        └── assets/             # Logo décliné, polices OFL
```

---

## ⚡ Démarrage Rapide

Les commandes se lancent depuis la racine du dépôt.

### Le lanceur : tout en une fois

`synthway.bat` (Windows, double-clic), `./synthway.sh` (Linux, terminal ou double-clic) ou `python3 synthway.py` lance Synthway en un seul programme : `synthway-server`, qui sert aussi l'interface construite (`synthway-ui/dist`) sur [http://127.0.0.1:18741](http://127.0.0.1:18741). Pas de Vite au lancement. Depuis les sources, il prépare d'abord ce qui manque ou a changé :

1. **Moteur :** compilé par `build.ps1` (Windows) ou `build.sh` (Linux) quand sa bibliothèque manque ou qu'un fichier de `include/`, `src/` ou `vendor/` est plus récent qu'elle. Sans compilateur, une bibliothèque déjà compilée est gardée, avec un avertissement.
2. **Python du serveur :** celui qui exécute le lanceur s'il a les paquets du serveur. Sinon, le lanceur crée `synthway-server/.venv` et y installe `requirements.txt`, puis le réinstalle quand ce fichier change. Exception : avec le Python de MSYS2, `pip` ne sait pas compiler `pydantic-core`, et le lanceur donne la commande `pacman` (voir le [README du serveur](../synthway-server/README.md#3-lancer-le-serveur)).
3. **Interface :** `npm ci` quand `node_modules` manque ou date d'avant `package.json` ou `package-lock.json`, puis `vite build` quand `dist/index.html` est plus ancien qu'un fichier de `src/`, `public/`, `index.html`, `vite.config.ts` ou des `package*.json`. Le lanceur saute `tsc`, pour qu'une erreur de type ne bloque pas le lancement. Construite sans `SYNTHWAY_SERVER_URL`, la page appelle le serveur qui la sert. Sans Node.js, un `dist/` déjà construit est gardé, avec un avertissement.
4. **Lancement :** le serveur démarre sur 18741, et le navigateur s'ouvre dès qu'il répond. Si un Synthway répond déjà sur ce port (second double-clic), le lanceur ouvre seulement le navigateur ; si c'est un autre programme, il s'arrête et propose `--port`. Ctrl+C arrête le serveur proprement, puisqu'il reçoit lui aussi le Ctrl+C de la console. Au-delà de 5 s, ou en cas d'erreur, le lanceur arrête tout l'arbre de processus du serveur : sous Windows, le `python.exe` d'un venv lance le vrai interpréteur comme enfant.

Options : `--no-browser`, `--port N`. Rien ne joue au lancement : le moteur ne démarre qu'avec le bouton ⏻ de l'interface. Le lanceur n'utilise que la bibliothèque standard de Python, pour tourner avant toute installation.

- **`synthway.bat`** cherche Python dans cet ordre : `python\python.exe` (celui du zip Windows), `py -3`, `python` (pas l'alias du Microsoft Store, qui n'installe rien), puis `C:\msys64\ucrt64\bin\python.exe`. En cas d'erreur, il garde la fenêtre ouverte. Il doit garder ses fins de ligne CRLF (`.gitattributes`) : avec des LF, `cmd` lit mal ses étiquettes.
- **`synthway.sh`** cherche `python3`, puis `python` (3.9 ou plus récent), et donne la commande d'installation sinon. Lancé hors d'un terminal (double-clic dans le gestionnaire de fichiers), il se rouvre dans le premier terminal trouvé parmi `x-terminal-emulator`, `gnome-terminal`, `konsole`, `xfce4-terminal` et `xterm`. Le terminal sert à montrer ses messages et à pouvoir arrêter Synthway ; il reste ouvert en cas d'erreur. Selon le gestionnaire de fichiers, le double-clic peut aussi ouvrir le script dans un éditeur au lieu de le lancer : `./synthway.sh` dans un terminal marche partout.
  - Le script doit garder ses fins de ligne LF (`.gitattributes`) : avec des CRLF, `sh` lit un `\r` au bout de chaque commande.
  - Il doit aussi garder son bit exécutable dans git. Depuis Windows, où git ne le voit pas, utilisez `git add --chmod=+x synthway.sh`.
  - Pour un agent, sans terminal, `python3 synthway.py` : `synthway.sh` ouvrirait une fenêtre de terminal (WSLg).
- **Tout Windows, pas de WSL :** le lanceur prend le Node de Windows. Un `node_modules` installé depuis WSL (c'est le même dossier) ne contient que les binaires Linux d'esbuild et de Rollup. Le lanceur le réinstalle alors pour Windows, avec un avertissement, et Vite ne repartira dans WSL qu'après un nouveau `npm install` là-bas (et inversement).
- **Windows sans Node.js, avec WSL :** le lanceur garde le `dist/` déjà construit, même si les sources de l'interface ont changé. Pour le reconstruire, lancez `npm run build` dans `synthway-ui`, depuis WSL, ou double-cliquez sur `packaging/build_windows.bat`, qui refait aussi le paquet Windows (voir plus bas). Puis rechargez la page de Synthway.
- **Les données de l'interface** (bibliothèque d'instruments, réglages) sont dans le `localStorage` du navigateur, propre à chaque origine : celles de `http://127.0.0.1:18741` (lanceur, zip) ne sont pas celles de `http://localhost:5173` (Vite).
- **Pour travailler sur l'interface,** `npm run dev` reste le plus pratique (rechargement à chaud), face au serveur lancé par le lanceur ou à la main.

### Le zip Windows : rien à installer

`packaging/build_windows.py` fabrique `dist/Synthway-<version>-windows-x64.zip` (`dist/` est ignoré par git), à publier sur la page Releases. Il contient :
- le lanceur ;
- `synthway.dll` déjà compilée ;
- `synthway-server/src` et `synthway-ui/dist` ;
- le Python embarquable de python.org (`python\`, version et SHA-256 fixés dans le script), avec les paquets du serveur ;
- les licences (`licences\`).

Celui qui le télécharge le dézippe et double-clique sur `synthway.bat`. Le Decomposer n'y est pas (PyTorch, environ 3 Go).

Le plus simple : double-cliquez sur `packaging/build_windows.bat`. Il construit tout `dist/` d'un coup :
1. **L'interface :** `npm run build` dans `synthway-ui`. Il passe par WSL quand Node.js n'est pas installé sous Windows : la distribution par défaut, ou celle donnée en argument (`build_windows.bat Debian`), qui doit avoir Node.js et les paquets de l'interface. La construction peut tourner pendant `npm run dev`.
2. **Le paquet :** il lance `build_windows.py` avec le premier Python pour Windows qui a `pip` (`py -3`, `python`, puis celui de MSYS2).

Le résultat : `dist/Synthway-<version>-windows-x64` (le dossier, qu'on peut lancer tel quel par son `synthway.bat`) et son zip. Synthway lancé depuis les sources (`synthway.bat` à la racine) profite aussi de la nouvelle interface et du moteur recompilé. Fermez d'abord un Synthway lancé depuis le dossier du paquet : le script ne pourrait pas le remplacer, et le dit. Il faut une connexion : `pip` télécharge à chaque fois les paquets du serveur.

À la main :

```powershell
C:\msys64\ucrt64\bin\python.exe packaging\build_windows.py
```

- **À lancer sous Windows,** avec un Python qui a `pip` : celui de MSYS2 convient. `pip` installe les paquets pour le Python embarqué (`--platform win_amd64`, roues seulement). Il évalue les conditions de plateforme des dépendances avec le Python qui l'exécute : il faut donc un Python Windows.
- **Le moteur et l'interface** sont préparés comme par le lanceur, puis vérifiés :
  - la DLL doit être à jour et n'importer que des DLL de Windows (contrôle par `objdump`) ;
  - `dist/` doit être à jour et construit sans adresse fixe.

  Sans Node.js pour Windows, construisez l'interface avant, là où est Node (`npm ci`, puis `npm run build` dans `synthway-ui`, depuis WSL par exemple ; `build_windows.bat` le fait) : le script prend un `dist/` à jour, et lit les licences des paquets npm dans `node_modules`.
- **Licences :** le zip contient les licences du moteur (miniaudio, RtMidi, libogg et libvorbis, dont la licence BSD de Xiph exige la notice dans toute distribution binaire), des polices, des paquets npm intégrés à l'interface, de Python (`python\LICENSE.txt`) et de chaque paquet Python (dans son `*.dist-info`). `licences\LISEZ-MOI.txt` les récapitule.
- **Mettre à jour Python :** changer `PYTHON_VERSION` et `PYTHON_SHA256`, donné par `https://www.python.org/api/v2/downloads/release_file/?release=<id>`. Il faut une version publiée avec son paquet embarquable.

Les étapes suivantes lancent chaque couche à la main.

### Étape 1 : Compiler et Tester le Moteur Audio (`synthway-core`)

Le cœur n'a besoin que d'un compilateur C11 **et** C++17 (`gcc`/`g++` ou `clang`) et, sous Linux, des en-têtes ALSA (`libasound2-dev`). miniaudio et RtMidi sont fournis dans `synthway-core/vendor/`.

- **Sous Linux / WSL Debian** :
  ```bash
  cd synthway-core
  make
  ./build/bin/synthway_cli --list
  ./build/bin/synthway_cli --midi
  ./build/bin/synthway_cli --tone 440 2
  ```

- **Sous Windows (PowerShell)** :
  ```powershell
  cd synthway-core
  .\build.ps1
  .\build\bin\synthway_cli.exe --list
  .\build\bin\synthway_cli.exe --midi
  .\build\bin\synthway_cli.exe --tone 440 2
  ```

### Étape 2 : Lancer le Serveur Python (`synthway-server`)

Le serveur fait le lien entre la bibliothèque C compilée et le réseau :

```bash
cd synthway-server
pip install -r requirements.txt
cd src
uvicorn main:app --reload --port 18741
```
> *Astuce* : Vous pouvez aussi lancer `python main.py` pour un test autonome sans FastAPI.

> **Pour jouer, lancez le serveur sous Windows**, pas dans WSL : le son de WSL passe par WSLg et arrive avec environ une demi-seconde de retard. Commandes et réglages dans le [README du serveur](../synthway-server/README.md#3-lancer-le-serveur).

### Étape 3 : Lancer l'Interface Graphique (`synthway-ui`)

```bash
cd synthway-ui
npm install
npm run dev
```
Ouvrez [http://localhost:5173](http://localhost:5173) pour utiliser le synthétiseur dans votre navigateur. Vite ne sert que la page : le navigateur parle directement au serveur, sur `http://127.0.0.1:18741`. Si le serveur tourne sur un autre port que 18741, ou pour travailler sans lui avec le serveur factice muet, voir le [README de l'UI](../synthway-ui/README.md).

### Étape 4 (facultative) : la séparation de sources (`synthway-demucs`)

L'onglet Decomposer décompose un morceau en pistes avec Demucs v4. Il lui faut son propre environnement Python, créé par [uv](https://docs.astral.sh/uv/) (environ 3 Go avec PyTorch) :

```bash
cd synthway-demucs
uv sync
```

Puis redémarrez le serveur. Licence des poids non précisée : essai local seulement. Voir le [README de synthway-demucs](../synthway-demucs/README.md).

---

## 💻 Compatibilité Multiplateforme (Windows & Linux / WSL)

Le projet est conçu pour fonctionner de manière transparente sous **Windows** et **Linux (Debian / WSL)** sans aucun chemin codé en dur (`no hardcoded paths`) :

- **Résolution dynamique des chemins** : Le pont Python `core_bridge.py` localise automatiquement `synthway.dll` ou `libsynthway.so` selon l'OS et l'emplacement relatif (`../synthway-core/build/lib/`).
- **Interopérabilité WSL** : Si vous travaillez via un lien symbolique sous WSL Debian (ex: `/home/Abyssal/workspace/synthway` pointant vers le disque Windows), vous pouvez indifféremment exécuter les commandes côté Linux ou côté Windows.
- **Backend audio miniaudio** : Utilise nativement **WASAPI** sous Windows et **ALSA / PulseAudio / JACK** sous Linux avec détection dynamique.
- **Backend MIDI RtMidi** : **WinMM** sous Windows, **ALSA** sous Linux, **CoreMIDI** sous macOS.

---

## 🤖 Guide pour les Développeurs Humains et Agents IA

L'utilisateur, Claude et Gemini travaillent dans ce même dossier. Les règles de travail communes (journal, conventions, skills partagés) sont dans [`AGENTS.md`](../AGENTS.md).

Lors de l'ajout de nouvelles fonctionnalités, respectez scrupuleusement les frontières d'architecture :

1. **Règles pour `synthway-core` (Temps Réel)** :
   - Le code dans `synthway-core` doit rester en **C11 / C++ portable**, sans allocation dynamique (`malloc`/`free`), sans entrées/sorties disque, et sans appel système bloquant dans le thread audio : le callback de `src/io/audio_output.c`, `sw_engine_render` et tout `src/synth/`.
   - Tout paramètre partagé (fréquence, volume, forme d'onde) doit être modifiable sans blocage de verrou.
   - Ne jamais introduire de dépendance réseau ou HTTP dans `synthway-core`.
2. **Règles pour `synthway-server` (Ordonnancement)** :
   - Toute nouvelle fonction exportée par `synthway-core` doit avoir sa signature enregistrée dans `core_bridge.py`.
   - Utilisez le WebSocket `/ws/synth` pour les actions à haute fréquence (notes, modulations, télémétrie FFT/oscilloscope).
   - Utilisez les routes REST (`/api/*`) pour les opérations de configuration (choix de carte son, profils, presets).
3. **Règles pour `synthway-ui` (Ergonomie & Contrôle)** :
   - Conserver l'interface réactive et découplée : elle doit afficher l'état de synchronisation avec le serveur.
   - Pour une version application de bureau sans navigateur, préférer **Tauri** à Electron pour sa légèreté.
4. **Règles pour `synthway-demucs` (facultatif)** :
   - Le serveur n'importe jamais PyTorch ni Demucs : il lance `separate.py` avec le Python de `synthway-demucs/.venv`, dans un processus à part, et lit ses lignes JSON.
   - Tout doit continuer de marcher sans ce dossier : le Decomposer dit alors pourquoi il ne peut rien décomposer.
   - `vendor/demucs/` reste le dépôt amont, sans modification. Les poids téléchargés (`models/`) ne sont jamais commités.
