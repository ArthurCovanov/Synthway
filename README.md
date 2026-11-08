# 🎹 Synthway

> Synthétiseur audio modulaire et surface de contrôle temps réel multiplateforme (Windows & Linux).
> Architecture en 3 piliers : **Moteur C/C++ (miniaudio)** ➔ **Serveur Python (FastAPI/WebSockets)** ➔ **Interface Web (React/Vite)**.

---

## 🏛️ Vue d'ensemble de l'Architecture

Synthway est structuré en **3 sous-projets indépendants et hautement découplés**, permettant à des développeurs humains ou des agents IA de travailler en parallèle sur chaque couche :

```mermaid
flowchart LR
    subgraph UI ["synthway-ui (Frontend)"]
        React["React + TypeScript + Vite"]
        UI_Controls["Instrument Creator, Composer, Analyzer, Réglages"]
    end

    subgraph Server ["synthway-server (Ordonnanceur)"]
        FastAPI["FastAPI (REST & WebSockets)"]
        Bridge["Pont FFI (ctypes)"]
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
    Bridge -->|Appels C ABI (synthway.dll / libsynthway.so)| Engine
    Engine --> Miniaudio
    Devices --> Miniaudio
    Midi --> RtMidi
    Miniaudio -->|Audio Buffer| Hardware["Haut-parleurs / Casque"]
    RtMidi <-->|Messages MIDI| Controllers["Claviers / Contrôleurs MIDI"]
```

Le détail des échanges entre les couches (qui stocke quoi, où vit le signal audio, trajet d'une note de l'UI jusqu'à la carte son) est dans [`docs/architecture.md`](docs/architecture.md).

---

## 📁 Arborescence Globale du Répertoire

```text
synthway/
├── .gitignore                  # Fichiers ignorés (builds C, venvs Python, node_modules)
├── README.md                   # Ce document (guide d'ensemble humains & agents)
├── AGENTS.md                   # Règles communes aux agents IA (Claude, Gemini) et aux humains
├── CLAUDE.md                   # Point d'entrée de Claude Code (importe AGENTS.md)
├── .claude/skills/             # Skills partagés par les agents (procédures pas à pas)
├── .agents/skills.json         # Redirige Antigravity (Gemini) vers .claude/skills
├── docs/journal.md             # Journal : qui travaille sur quoi
├── docs/architecture.md        # Fonctionnement : flux de données entre les couches
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
│       └── models.py           # Modèles Pydantic / Dataclasses
│
└── synthway-ui/                # 3. Interface Graphique Utilisateur (React + Vite)
    ├── README.md               # Guide dédié de l'UI (composants, proxy, stack)
    ├── package.json            # Dépendances Node.js (React, Vite, Lucide)
    ├── tsconfig.json           # Configuration TypeScript
    ├── vite.config.ts          # Configuration Vite avec proxy backend
    ├── index.html              # Page web hôte
    ├── scripts/                # Déclinaisons du logo, serveur factice muet
    └── src/                    # Code source de l'IHM
        ├── App.tsx             # Navigation entre les 4 écrans
        ├── screens/            # Instrument Creator, Composer, Analyzer, Réglages
        ├── components/         # Barre latérale, contrôles, oscilloscope, clavier
        ├── lib/                # Client API/WebSocket, modèles, état partagé
        ├── styles/             # Thème synthwave (couleurs du logo), polices
        └── assets/             # Logo décliné, polices OFL
```

---

## ⚡ Démarrage Rapide

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

### Étape 3 : Lancer l'Interface Graphique (`synthway-ui`)

```bash
cd synthway-ui
npm install
npm run dev
```
Ouvrez [http://localhost:5173](http://localhost:5173) pour utiliser le synthétiseur dans votre navigateur. Si le serveur tourne sur un autre port que 18741, ou pour travailler sans lui avec le serveur factice muet, voir le [README de l'UI](synthway-ui/README.md).

---

## 💻 Compatibilité Multiplateforme (Windows & Linux / WSL)

Le projet est conçu pour fonctionner de manière transparente sous **Windows** et **Linux (Debian / WSL)** sans aucun chemin codé en dur (`no hardcoded paths`) :

- **Résolution dynamique des chemins** : Le pont Python `core_bridge.py` localise automatiquement `synthway.dll` ou `libsynthway.so` selon l'OS et l'emplacement relatif (`../synthway-core/build/lib/`).
- **Interopérabilité WSL** : Si vous travaillez via un lien symbolique sous WSL Debian (ex: `/home/Abyssal/workspace/synthway` pointant vers le disque Windows), vous pouvez indifféremment exécuter les commandes côté Linux ou côté Windows.
- **Backend audio miniaudio** : Utilise nativement **WASAPI** sous Windows et **ALSA / PulseAudio / JACK** sous Linux avec détection dynamique.
- **Backend MIDI RtMidi** : **WinMM** sous Windows, **ALSA** sous Linux, **CoreMIDI** sous macOS.

---

## 🤖 Guide pour les Développeurs Humains et Agents IA

L'utilisateur, Claude et Gemini travaillent dans ce même dossier. Les règles de travail communes (journal, conventions, skills partagés) sont dans [`AGENTS.md`](AGENTS.md).

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
