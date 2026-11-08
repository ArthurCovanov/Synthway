# 🎹 Synthway Core (`synthway-core`)

> Moteur audio temps-réel basse latence et bibliothèque C/C++ pour le projet Synthway, reposant sur **`miniaudio`** pour l'audio et **`RtMidi`** pour le MIDI.

---

## 🎯 Rôle et Périmètre

`synthway-core` constitue le cœur bas niveau de Synthway. Il est conçu pour être compilé :
1. **En bibliothèque partagée dynamique** (`synthway.dll` sous Windows, `libsynthway.so` sous Linux, `libsynthway.dylib` sous macOS) avec une ABI C standard (`extern "C"`), consommable directement par `synthway-server` (via Python `ctypes`, `cffi`, ou `nanobind`).
2. **En exécutable autonome de test CLI** (`synthway_cli`) pour valider immédiatement le matériel audio, tester l'énumération des périphériques et générer des fréquences pures ou arpeggios sans aucune dépendance externe.

---

## 🏗️ Architecture et Structure des Dossiers

```text
synthway-core/
├── CMakeLists.txt              # Configuration CMake multiplateforme (Linux/Windows/macOS)
├── Makefile                    # Makefile standard portable (Linux Debian/WSL, MSYS2)
├── build.ps1                   # Script de compilation rapide PowerShell (Windows)
├── build.sh                    # Script de compilation rapide Bash (Linux/Debian/WSL)
├── README.md                   # Ce document
├── include/synthway/           # API C publique : la seule partie que voient le CLI, les tests et le serveur
│   ├── synthway.h              # En-tête unique à inclure : version, codes d'erreur ; inclut les quatre suivants
│   ├── types.h                 # Types, structures, énumérations (codes de retour, formes d'onde, analyse)
│   ├── devices.h               # Sorties et entrées audio, ports MIDI           → src/io/
│   ├── engine.h                # Moteur : cycle de vie, réglages, hors ligne    → src/engine/
│   └── analyzer.h              # Analyseur : note jouée et partiels d'un son    → src/analyzer/
├── src/                        # Deux chaînes de sous-couches, voir « Sous-couches du moteur » plus bas
│   ├── synthway.c              # Version et textes des codes d'erreur
│   ├── engine/                 # Chef d'orchestre
│   │   ├── engine_internal.h   # struct synthway_engine : assemble les deux autres couches
│   │   ├── engine.c            # Cycle de vie (create, init, start, stop, destroy), rendu d'un bloc
│   │   ├── engine_params.h/.c  # Frontière entre threads : paramètres atomiques, setters et getters
│   │   └── engine_offline.c    # Rendu hors ligne, en mémoire ou en WAV
│   ├── synth/                  # Calcul du son : ni thread, ni entrée/sortie, ni miniaudio
│   │   ├── synth.h/.c          # Une voix : lissage, gate, oscillateur × enveloppe × volume
│   │   ├── oscillator.h/.c     # Formes d'onde et phase
│   │   ├── envelope.h/.c       # Enveloppe ADSR, linéaire ou exponentielle
│   │   └── reverb.h/.c         # Réverbération stéréo (structure et réglages de Freeverb)
│   ├── interpreter/            # Lecture des positions de notes de composition
│   │   └── interpreter.h/.c    # Notes actives à un pas donné, sans allocation
│   ├── analyzer/               # Chef d'orchestre de l'analyse, indépendant du moteur
│   │   └── analyzer.c          # struct synthway_analyzer : micro, fichier chargé, mémoire de calcul
│   ├── analysis/               # Calcul de l'analyse : ni thread, ni entrée/sortie, ni allocation
│   │   ├── analysis.h/.c       # Une fenêtre (~170 ms) : niveau, note, partiels, spectre ; note vérifiée par les partiels
│   │   ├── notes.h/.c          # Plusieurs notes jouées ensemble : la plus saillante, ses harmoniques retirées, la suivante…
│   │   ├── waveform.h/.c       # Forme d'onde d'une note : niveau de chaque harmonique, comparé aux formes à travers un passe-bas
│   │   ├── pitch.h/.c          # Note jouée : méthode de McLeod (MPM, fonction de différence normalisée)
│   │   ├── spectrum.h/.c       # Spectre (fenêtre de Blackman), pics devenus partiels, spectre d'affichage
│   │   └── fft.h/.c            # FFT complexe radix 2
│   └── io/                     # Tout ce qui touche le monde extérieur
│       ├── audio_output.h/.c   # Carte son (miniaudio) et son thread audio
│       ├── audio_input.h/.c    # Micro (miniaudio) : tampon circulaire des derniers échantillons, rien n'est enregistré
│       ├── audio_file.h/.c     # Décodage d'un fichier WAV, FLAC ou MP3 en mémoire, en mono
│       ├── audio_devices.c     # Énumération des sorties et entrées audio
│       ├── midi_ports.c        # Énumération des ports MIDI (RtMidi)
│       ├── wav_file.h/.c       # Écriture de fichiers WAV 16 bits
│       ├── ma_result.h         # Conversion des codes d'erreur de miniaudio
│       ├── miniaudio_config.h  # Modules de miniaudio compilés (partagé par tous les .c qui l'utilisent)
│       └── miniaudio_impl.c    # Implémentation de miniaudio, compilée à part (libminiaudio.a)
├── examples/
│   └── cli_main.c              # Application CLI de démonstration et tests
├── tests/
│   ├── render_test.c           # Test automatique du son, en rendu hors ligne (aucun son joué)
│   └── analysis_test.c         # Test de l'analyse : des sons rendus par le moteur, analysés (sans micro)
├── tools/
│   └── analyze_wav.py          # Mesure un WAV rendu : niveau, fréquence (Python standard)
└── vendor/                     # Code tiers, fichiers amont non modifiés
    ├── README.md               # Versions, licences, sources et dépendances système
    ├── miniaudio/
    │   └── miniaudio.h         # Bibliothèque audio mono-fichier (Mackron)
    └── rtmidi/
        └── RtMidi.h, RtMidi.cpp, rtmidi_c.h, rtmidi_c.cpp, LICENSE   # Bibliothèque MIDI (C++, API C)
```

---

## 🧱 Sous-couches du moteur

```
            include/synthway/  (API publique, C pur, chargée par ctypes)
                    │ implémentée par
                    ▼
     src/engine/  chef d'orchestre du son              src/analyzer/  chef d'orchestre de l'analyse
       │      │                                          │      │
       ▼      └──────────────► src/io/ ◄─────────────────┘      ▼
  src/synth/                   miniaudio, RtMidi,           src/analysis/
  calcul du son                fichiers (ne connaît          calcul de l'analyse
  (ne connaît personne)        ni l'engine ni l'analyzer)    (ne connaît personne)
```

- **`engine/`, le chef d'orchestre** : il possède le cycle de vie, la frontière entre threads et relie le synthé à une sortie (la carte son, ou le rendu hors ligne). C'est la seule couche qui connaît les deux autres.
- **`synth/`, le calcul du son** : à partir de valeurs simples (fréquence, volume, forme d'onde, gate, enveloppe), il remplit un tampon d'échantillons. Il tient les voix (la voix 0 joue la note de l'API à une note, les autres sont attribuées par `sw_synth_note_on`) et, par instrument, le filtre et la réverbération de la somme de ses voix. Il n'envoie rien à personne et ignore jusqu'à l'existence de la carte son. C'est ce qui permet le rendu hors ligne : le même code remplit le tampon de la carte son, un tableau en mémoire ou un fichier WAV.
- **`io/`, la couche du bord** : la carte son, le micro, la liste des périphériques, les ports MIDI et les fichiers. C'est la carte son qui réclame les échantillons : son thread audio appelle la fonction de rendu que l'engine lui a donnée à l'ouverture.
- **`analyzer/`, le chef d'orchestre de l'analyse** : il relie un micro (`io/audio_input`) ou un fichier décodé (`io/audio_file`) au calcul de `analysis/`, et possède la mémoire de ce calcul (environ 600 Ko par analyseur). Il ne partage rien avec le moteur : on peut analyser moteur arrêté, ou pendant qu'il joue.
- **`analysis/`, le calcul de l'analyse** : à partir d'une fenêtre d'échantillons (environ 170 ms), il trouve le niveau, la note jouée, les partiels et le spectre d'affichage. Comme `synth/`, il ignore d'où vient le son, ce qui permet de le tester sur des sons rendus par le moteur.

Deux chemins traversent le moteur :

- **Commandes** (thread de l'appelant, le serveur par exemple) : `synthway_engine_set_*` → `engine_params.c` écrit un paramètre atomique, puis rend la main.
- **Notes** (thread de l'appelant) : `synthway_engine_note_on`, `note_off` et `all_notes_off` ajoutent un événement à une file circulaire de 1024 places (`sw_note_queue`, `engine_params.h`), sous un verrou que le thread audio ne prend jamais.
- **Son** (thread audio) : `io/audio_output.c` reçoit la demande de la carte son → `sw_engine_render` (`engine.c`) passe au synthé les notes en attente (`sw_engine_params_take_notes`), puis lit une fois les paramètres atomiques (`sw_engine_params_snapshot`) → `sw_synth_render` (`synth.c`) remplit le bloc. Le rendu hors ligne (`engine_offline.c`) appelle la même `sw_engine_render`, d'où des échantillons identiques.

L'analyseur a les siens :

- **Micro** (thread de capture de miniaudio) : `io/audio_input.c` copie chaque bloc reçu dans un tampon circulaire de 65 536 échantillons et avance un compteur atomique. Rien d'autre : ni calcul, ni allocation.
- **Analyse** (thread de l'appelant) : `synthway_analyzer_analyze_input` copie la dernière fenêtre du tampon (`sw_audio_input_read_latest`) puis lance `sw_analysis_run` (`analysis.c`). Pour un fichier, `synthway_analyzer_analyze_clip` prend la fenêtre centrée sur l'instant demandé.

### Règles de dépendance

- **`synth/`** n'inclut ni miniaudio, ni RtMidi, ni `<stdatomic.h>`, ni `engine/`. Pas d'allocation, pas de verrou, pas d'entrée/sortie : il tourne dans le thread audio.
- **`io/`** est la seule couche qui inclut `io/miniaudio_config.h` et `rtmidi_c.h`. Il ne connaît pas `struct synthway_engine`.
- **`engine/`** voit `synth/` et `io/`. Les atomiques du moteur ne sont manipulés que dans `engine_params.c`, et le thread audio n'en lit qu'un instantané par bloc.
- **`analysis/`** n'inclut ni miniaudio, ni `engine/`, ni `synth/`, et n'alloue rien : la mémoire de calcul (`sw_analysis_workspace`) lui est fournie.
- **`analyzer/`** voit `analysis/` et `io/`, jamais `engine/` ni `synth/`. Le seul atomique de l'analyse est le compteur d'écriture du micro, dans `io/audio_input.c`.
- **Inclusions** : toujours depuis `src/` (`#include "synth/synth.h"`, `#include "io/wav_file.h"`) ; l'API publique par `#include "synthway/synthway.h"`.
- **Nommage** : fonctions publiques `synthway_*` avec `SYNTHWAY_API` ; fonctions internes `sw_<module>_*` (`sw_envelope_release`, `sw_audio_output_open`), sans `SYNTHWAY_API`. Sous Linux et macOS, la bibliothèque est compilée avec `-fvisibility=hidden` : seules les `synthway_*` sont exportées. Sous Windows, `dllexport` a le même effet.

### Où ajouter quoi

| Je veux ajouter… | Où |
| --- | --- |
| Un calcul de son (filtre, LFO, nouvelle forme d'onde) | Un module `src/synth/<nom>.h/.c`, appelé depuis `synth.c` |
| Un réglage temps réel | Un champ atomique et son setter/getter dans `engine/engine_params.c`, la valeur dans `sw_synth_params`, la déclaration dans `engine.h` (skill `core-api-change`) |
| Une sortie ou une entrée (capture, entrée MIDI, autre format de fichier) | `src/io/` |
| Une mesure du son analysé (attaque, enveloppe d'un partiel, accord) | Un module `src/analysis/<nom>.h/.c`, appelé depuis `analysis.c`, et ses champs dans `synthway_analysis_t` (skill `core-api-change`) |
| Une fonction publique | Déclarée dans l'en-tête public de sa couche, implémentée dans le dossier correspondant (skill `core-api-change`) |

Suite possible : sous Linux, `libsynthway.so` exporte encore les symboles de miniaudio et RtMidi, compilés à part sans visibilité masquée.

---

## 🔊 Fonctionnalités Implémentées

- **Énumération structurée des périphériques audio** :
  - Classement distinct par catégorie : **Sorties (Playback)** et **Entrées (Capture)**.
  - Détection automatique du périphérique par défaut système (`[DEFAULT]`).
  - Détection des taux d'échantillonnage natifs (44.1 kHz, 48 kHz, etc.) et du nombre de canaux.
- **Synthèse sonore paramétrable** :
  - Oscillateur avec accumulation de phase 64-bit et plusieurs formes d'onde :
    - `SYNTHWAY_WAVEFORM_SINE` (Sinusoïde pure)
    - `SYNTHWAY_WAVEFORM_SQUARE` (Carrée)
    - `SYNTHWAY_WAVEFORM_TRIANGLE` (Triangle)
    - `SYNTHWAY_WAVEFORM_SAWTOOTH` (Dent de scie)
  - Contrôle de la fréquence en Hertz ($0.1\text{ Hz}$ à $24\text{ kHz}$).
  - Contrôle du volume ($0.0$ à $1.0$).
  - **Lissage de transition (anti-click / anti-pop)** : interpolation exponentielle pour éviter les bruits de coupure lors des sauts de fréquence ou changements de volume.
  - **Enveloppe ADSR** (attaque, déclin, maintien, relâchement), à segments linéaires, appliquée à chaque note (l'enveloppe d'un partiel peut aussi être exponentielle, voir le timbre) :
    - `set_tone_enabled(true)` ouvre la note et lance l'attaque ; `false` la ferme et lance le relâchement.
    - Une note rejouée pendant que la précédente est encore ouverte garde son niveau (legato).
    - Une nouvelle attaque repart du niveau courant, donc sans clic.
    - Par défaut : 5 ms d'attaque et 10 ms de relâchement, assez court pour paraître instantané, et la fin de note ne claque plus.
  - **Synthèse additive (timbre)** : au lieu de l'oscillateur unique, une note peut être jouée par un ensemble de partiels (`synthway_timbre_t`, 64 au plus, `SYNTHWAY_MAX_PARTIALS`). Chaque partiel a son propre oscillateur, à un rapport de la note jouée (×1 la note, ×2 son octave, ×2,76 un partiel inharmonique), et sa propre amplitude, forme d'onde et enveloppe. La somme est multipliée par le volume.
    - L'enveloppe d'un partiel a une courbe (`curve`) : `SYNTHWAY_ENVELOPE_LINEAR` (0, la valeur d'une structure mise à zéro), des rampes droites ; ou `SYNTHWAY_ENVELOPE_EXPONENTIAL` (1), une chute régulière en dB, comme une corde pincée, où `decay_s` et `release_s` sont les temps pour perdre 60 dB. Le déclin exponentiel s'applique à ce qui dépasse le maintien ; le relâchement s'arrête à −60 dB.
    - L'attaque d'un partiel a sa propre forme (`attack_curve`) : `SYNTHWAY_ATTACK_LINEAR` (0, par défaut), une rampe droite ; ou `SYNTHWAY_ATTACK_CONVEX` (1), le carré d'une rampe droite : lente au début puis de plus en plus rapide, ce qu'on entend comme une montée exponentielle (à mi-attaque, le niveau est au quart). Elle part elle aussi du niveau courant. C'est la forme mesurée sur les notes « pompées » par la grosse caisse de « Chasing Shadows » : pleine en 90 ms.
    - Le déclin et le relâchement ont chacun leur courbe : `curve` pour le déclin, `release_curve` pour le relâchement (`SYNTHWAY_ENVELOPE_LINEAR` ou `SYNTHWAY_ENVELOPE_EXPONENTIAL`). Avant, `curve` valait pour les deux : le serveur et l'UI donnent au relâchement la courbe du déclin quand elle manque, pour que les anciens instruments sonnent pareil.
    - Un timbre peut changer pendant une note : un partiel ajouté démarre son attaque aussitôt.
    - Un partiel qui part du silence repart à la phase 0 : un même timbre commence toujours par la même onde.
    - Rien ne protège des partiels au-delà de la moitié de la fréquence d'échantillonnage (ils se replient en d'autres fréquences) ni d'une somme qui dépasse 1 (elle est écrêtée) : c'est à l'appelant de prévenir. L'UI affiche ces deux avertissements.
  - **Polyphonie** : en plus de la note de l'API à une note, jusqu'à 32 notes sonnent à la fois (`SYNTHWAY_MAX_NOTES`), chacune avec ses propres enveloppes : une note qui démarre pendant qu'une autre est tenue a sa vraie attaque. Chaque note joue l'un des 16 instruments du moteur (`SYNTHWAY_MAX_INSTRUMENTS`) : forme d'onde ou timbre, enveloppe, filtre, réverbération et unisson. Un instrument filtre et réverbère la somme de ses notes, ce qui revient exactement au même que pour chacune (les deux sont linéaires) ; chaque instrument a sa propre réverbération, qui ne tourne que tant qu'elle sonne. L'instrument 0 est celui que règlent `set_waveform`, `set_envelope`, `set_timbre`, etc., et que joue la note de l'API à une note. Les notes s'additionnent : plusieurs notes fortes peuvent dépasser 1 et être écrêtées par la carte son.
  - Séparation stricte du callback audio temps réel et des threads de contrôle : les paramètres partagés sont atomiques (C11). Le timbre, trop gros pour un atomique, passe par un triple tampon : le thread audio lit toujours un timbre complet, sans jamais attendre.
- **Rendu hors ligne** : le moteur peut produire ses échantillons sans carte son, en mémoire ou dans un fichier WAV 16 bits. Les échantillons sont exactement ceux que recevrait la carte son, car le callback temps réel et le rendu hors ligne passent par la même fonction. C'est ce qui permet de tester le son sans haut-parleur (voir plus bas).
- **Énumération des ports MIDI** (RtMidi) :
  - Entrées (claviers, contrôleurs) et sorties (synthés, interfaces).
  - Backend WinMM sous Windows, ALSA sous Linux, CoreMIDI sous macOS.
- **Analyse du son** (`synthway_analyzer_t`, indépendant du moteur ; rien n'est joué ni enregistré) :
  - **Sources** : le micro (une entrée de la liste des captures, mixée en mono ; seules les ~1,4 dernières secondes restent en mémoire), un fichier WAV, FLAC ou MP3 décodé en mémoire (10 minutes au plus), ou des échantillons fournis par l'appelant.
  - **Micro en mode exclusif** : le micro est ouvert d'abord en mode exclusif, à son format natif. Sous Windows, le son arrive alors directement du pilote, sans les effets audio du mode partagé (réduction de bruit, gain automatique, traitements Dolby ou Intel), qui prennent une note tenue pour du bruit de fond et l'éteignent en une ou deux secondes. Pendant l'écoute, aucune autre application ne peut utiliser ce micro. Si le pilote, le système ou une autre application refuse le mode exclusif, le micro est ouvert en mode partagé (`synthway_analyzer_is_input_exclusive` le dit).
  - **Fenêtre** : environ 170 ms (8192 échantillons à 44,1 et 48 kHz). La note se mesure sur sa moitié centrale, qui doit tenir deux périodes : jusqu'à 23 Hz à 48 kHz, et jusqu'à 5000 Hz en haut.
  - **Note jouée** : méthode de McLeod (MPM) : la période est le premier décalage où le son se ressemble le mieux, d'où la `clarity` (de 0, bruit, à 1, son parfaitement périodique ; une note est fiable au-dessus de 0,8). Une fondamentale absente (seulement les partiels 2, 3, 4…) donne bien la note entendue.
  - **Partiels** : les pics du spectre (FFT, fenêtre de Blackman, interpolation parabolique), au plus 60 dB sous le plus fort et 20 dB au-dessus du bruit de fond, 64 au plus, avec leur fréquence, leur rapport à la note et leur amplitude relative.
  - **Note vérifiée par les partiels** : une note sous le premier partiel audible doit en être une fondamentale absente (partiels proches d'harmoniques, le premier au plus 3,5 fois la note) ; sinon, c'est une coïncidence d'un son inharmonique, comme une cloche, et la note devient ce partiel. Elle est ensuite affinée par ses 6 premières harmoniques.
  - **Seuil anti-bruit** (optionnel, désactivé par défaut) : les pics du spectre sous un niveau choisi (en dBFS) ne sont plus des partiels, et sans partiel au-dessus, il n'y a pas de note. Le bruit faible d'une pièce (ventilateur, souffle) disparaît de l'analyse ; le niveau et le spectre restent ceux mesurés. À `SYNTHWAY_ANALYZER_NOISE_GATE_OFF` (−120), il ne change rien.
  - **Précision mesurée** (sons du moteur) : la note à mieux que 0,3 cent du Mi grave d'une basse (41 Hz) au Do aigu du piano (4186 Hz), les rapports à 0,001 près, les amplitudes à 1 % près.

---

## 🛠️ Compilation

Le projet est conçu pour être compilé sans aucun chemin en dur (`no hardcoded paths`), compatible nativement sous **Windows** et **Linux (Debian / WSL)**.

### Prérequis

- Un compilateur C11 **et** C++17 (GCC ou Clang), car RtMidi est écrite en C++. Sous Windows : MSYS2 UCRT64.
- Sous Linux : les en-têtes ALSA (`libasound2-dev` sous Debian, `alsa-lib` sous Arch).

### Bibliothèques tierces

miniaudio et RtMidi sont compilées à part, en bibliothèques statiques (`build/vendor/<plateforme>/`), puis liées dans `synthway.dll` / `libsynthway.so`. Elles ne sont recompilées que si leurs sources changent, et les objets sont rangés par plateforme (`build/obj/windows`, `build/obj/linux`) : un build WSL ne réutilise jamais des objets Windows. Versions, licences et procédure de mise à jour : [`vendor/README.md`](vendor/README.md).

Sous Windows, la DLL embarque les runtimes GCC et C++ : elle ne dépend que de DLL système et se charge depuis Python sans MSYS2 dans le `PATH`.

### Option A : Via CMake (Recommandé)

```bash
# Dans le dossier synthway-core :
cmake -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release
ctest --test-dir build      # test du son en rendu hors ligne
```

Les exécutables se trouveront dans `build/bin/` et la bibliothèque dans `build/lib/`.

### Option B : Via Makefile (Linux / WSL Debian / MSYS2)

```bash
# Compilation de la lib, du CLI et du test :
make

# Test du son en rendu hors ligne (aucun son joué) :
make test

# Lancer directement le CLI (joue du son) :
make run

# Nettoyage :
make clean
```

### Option C : Scripts de build directs

- **Sous Windows (PowerShell)** :
  ```powershell
  .\build.ps1          # -Clean : tout recompiler ; -Test : lancer le test du son
  ```
- **Sous Linux / WSL Debian (Bash)** :
  ```bash
  chmod +x build.sh
  ./build.sh           # --clean : tout recompiler ; --test : lancer le test du son
  ```

---

## 🚀 Utilisation du CLI de Test (`synthway_cli`)

Une fois compilé, vous pouvez tester directement les capacités audio :

```bash
# 1. Lister tous les périphériques audio (Sorties & Entrées) :
./build/bin/synthway_cli --list

# 1 bis. Lister tous les ports MIDI (Entrées & Sorties) :
./build/bin/synthway_cli --midi

# 2. Jouer une note personnalisée (ex: La 440 Hz pendant 3 secondes) :
./build/bin/synthway_cli --tone 440 3

# 3. Jouer une onde carrée (0=Sine, 1=Square, 2=Triangle, 3=Sawtooth) :
./build/bin/synthway_cli --waveform 1

# 4. Mode démonstration par défaut (liste les périphériques, joue un La puis un arpège C-E-G-C) :
./build/bin/synthway_cli

# 5. Rendre une note dans un fichier WAV, sans carte son et sans rien jouer :
#    --render <fichier.wav> [fréquence] [secondes] [forme 0-3]
./build/bin/synthway_cli --render la.wav 440 1 0

# 6. Même chose avec des partiels (synthèse additive) au lieu de la forme d'onde :
#    --partials rapport:amplitude[:forme],...  (enveloppe par défaut pour chacun)
./build/bin/synthway_cli --render cloche.wav 220 2 --partials 1:0.6,2.76:0.3,5.4:0.15

# 6 bis. Une note qui glisse (synthway_engine_note_glide), dans un fichier WAV, sans rien jouer :
#    --glide <fichier.wav> <fréquence de départ> <fréquence:secondes>,...  [--partials ...]
#    Ici : de 220 à 440 Hz en 1 s, tenue 0,5 s, puis descente à 330 Hz en 0,25 s (et 0,5 s de tenue à la fin)
./build/bin/synthway_cli --glide glisse.wav 220 440:1,440:0.5,330:0.25 --partials 1:0.6,2:0.3,3:0.15

# 7. Note et partiels d'un fichier WAV, FLAC ou MP3, sans rien jouer :
#    --analyze <fichier> [secondes]  (par défaut : le moment où la note est la plus nette)
./build/bin/synthway_cli --analyze cloche.wav

# 8. Accordeur au micro, dans le terminal (ouvre le micro, n'enregistre rien) :
#    --listen [secondes] [entrée]  (par défaut : 10 s, l'entrée du système ; les entrées sont listées par --list ;
#    il dit si le micro est en mode exclusif, sans les effets audio du système, ou partagé)
./build/bin/synthway_cli --listen 20

# 9. --analyze et --listen acceptent un seuil anti-bruit : les pics sous -70 dBFS sont ignorés
./build/bin/synthway_cli --listen 20 --gate -70
```

---

## 🎧 Tester le son sans haut-parleur

Le son se vérifie par la mesure, pas à l'oreille. Personne n'a besoin d'écouter, et les agents IA, qui n'entendent rien, peuvent contrôler leurs modifications.

1. **Test automatique** : `tests/render_test.c` rend le son hors ligne et vérifie, pour les 4 formes d'onde, la fréquence, la crête et le niveau RMS. Il contrôle aussi le silence quand la note est coupée, le suivi d'un changement de note, le fondu au volume 0, l'égalité des canaux stéréo et l'export WAV. Côté enveloppe, il mesure la forme ADSR point par point, et vérifie le legato, la reprise sans saut, la fin de note sans clic et le refus des valeurs invalides. Côté timbre, il mesure l'amplitude de chaque partiel à sa fréquence (harmonique et inharmonique), l'enveloppe propre à chaque partiel, l'égalité entre un partiel sinus unique et l'oscillateur, les changements pendant une note, la tenue d'un partiel au-delà de la fréquence d'échantillonnage et le refus des valeurs invalides. Côté réverbération, il vérifie le niveau tenu, la queue après la note et sa décroissance, l'écart entre les canaux, et le retour exact au son sec. Il vérifie que le déclin et le relâchement suivent chacun leur courbe, mesure aussi l'attaque convexe point par point, et pour l'unisson : une voix laisse le son identique au bit près, les voix sont à leur fréquence et à leur niveau (1/√7 chacune), elles battent, la gauche et la droite diffèrent, l'intensité reste à 3 dB près, et les valeurs hors bornes sont refusées. On le lance avec `build.ps1 -Test`, `build.sh --test`, `make test` ou `ctest`.
2. **Test de l'analyse** : `tests/analysis_test.c` fait rendre au moteur des sons connus (sinus du Mi grave au Do aigu, dent de scie, cartes inharmoniques, fondamentale absente, note tenue 8 secondes, silence, bruit blanc et bruit aigu, fichier WAV relu depuis le disque puis la mémoire) et vérifie que l'analyseur retrouve leur note, leurs partiels et leur niveau. Il vérifie aussi la forme d'onde reconnue : dent de scie à travers le passe-bas du moteur (et sa coupure), carré, triangle, impulsion à 25 % (et son rapport cyclique), sinus, une note d'un accord (l'harmonique partagée écartée) et une note sur un Ré4 discret. Il n'ouvre ni carte son ni micro, et se lance avec le test du son.
3. **Vérification ponctuelle** : rendre un WAV avec le CLI, puis le mesurer :
   ```bash
   ./build/bin/synthway_cli --render note.wav 220 0.5 3
   python tools/analyze_wav.py note.wav --expect-hz 220
   ```
   L'outil affiche la durée, la crête (en dBFS), le niveau RMS et la fréquence. Avec `--expect-hz`, il renvoie un code d'erreur si la fréquence s'écarte de plus de 0,5 %.
   `synthway_cli --analyze note.wav` en donne aussi la note, à quelques dixièmes de cent près, et les partiels.
4. **Depuis Python** : `SynthwayCore.render()` renvoie les échantillons en mémoire, et `SynthwayCore.render_to_wav()` écrit un WAV. Les deux utilisent un moteur à part, sans toucher au moteur temps réel.

Un fichier WAV rendu peut aussi être écouté normalement par un humain : c'est exactement ce que la carte son aurait joué.

---

## 🔌 Interface C pour le Serveur Python

La bibliothèque partagée exporte les symboles avec convention d'appel standard C.
Exemple d'utilisation minimale en Python via `ctypes` :

```python
import ctypes
import os

# Chargement de la bibliothèque
lib_name = "synthway.dll" if os.name == "nt" else "libsynthway.so"
lib_path = os.path.join(os.path.dirname(__file__), "..", "synthway-core", "build", "lib", lib_name)
synth = ctypes.CDLL(lib_path)

# Configuration des signatures
synth.synthway_get_version.restype = ctypes.c_char_p
synth.synthway_engine_create.restype = ctypes.c_void_p
synth.synthway_engine_set_frequency.argtypes = [ctypes.c_void_p, ctypes.c_float]

# Utilisation
version = synth.synthway_get_version().decode("utf-8")
print(f"Synthway Core Version: {version}")

engine = synth.synthway_engine_create()
synth.synthway_engine_init(engine, None)
synth.synthway_engine_set_frequency(engine, ctypes.c_float(440.0))
synth.synthway_engine_start(engine)
# ...
synth.synthway_engine_stop(engine)
synth.synthway_engine_destroy(engine)
```

### Enveloppe

| Fonction | Rôle |
|---|---|
| `synthway_engine_set_envelope(engine, attack_s, decay_s, sustain_level, release_s)` | Règle l'enveloppe : durées de 0 à 10 s, niveau de maintien entre 0 et 1. Une valeur hors bornes renvoie `SYNTHWAY_INVALID_PARAM` et l'enveloppe en place est gardée. |
| `synthway_engine_set_filter(engine, low_cutoff_hz, high_cutoff_hz, resonance)` / `synthway_engine_get_filter(engine, &low_cutoff_hz, &high_cutoff_hz, &resonance)` | Règle ou lit le passe-bande : borne basse et borne haute entre 20 et 20000 Hz, borne basse strictement sous la borne haute, résonance de 0 à 1. Les deux sections sont appliquées après la somme des oscillateurs. |
| `synthway_engine_set_reverb(engine, mix)` / `synthway_engine_get_reverb(engine)` | Règle ou lit la réverbération, appliquée après le filtre : `mix` de 0 à 1 est la part de son réverbéré, en fondu à puissance constante (0 : aucune, par défaut ; 0,5 : autant de chaque ; 1 : la réverbération seule). Une salle d'environ 2 s (temps pour perdre 60 dB), qui continue de sonner après la note ; ses canaux gauche et droit diffèrent, le son devient stéréo. Une note tenue garde à peu près son niveau (à 2 dB près à 100 %), mais ses crêtes montent jusqu'à deux ou trois fois plus haut. Revenue à 0, la queue s'arrête en une milliseconde et le son est de nouveau exactement le son sec. Structure de Schroeder-Moorer avec les réglages de Freeverb (Jezar at Dreampoint, 2000, domaine public), réécrite dans `src/synth/reverb.c` : 8 filtres en peigne amortis en parallèle puis 4 passe-tout en série par canal, dans des tampons de taille fixe (aucune allocation), dimensionnés jusqu'à 192 kHz. La salle reçoit la moyenne de la gauche et de la droite ; chaque canal garde son propre son sec. |
| `synthway_engine_set_unison(engine, voices, detune_cents, spread)` / `synthway_engine_get_unison(engine, &voices, &detune_cents, &spread)` | Unisson du timbre (pas de l'oscillateur unique) : chaque partiel est joué par `voices` oscillateurs (1 à `SYNTHWAY_MAX_UNISON_VOICES`, 8 ; 1, par défaut : pas d'unisson, le son est alors exactement celui d'avant), désaccordés jusqu'à `detune_cents` au-dessous et au-dessus (0 à `SYNTHWAY_MAX_UNISON_DETUNE_CENTS`, 100). Les voix sont plus serrées près du partiel (écart en \|x\|^1,5 pour des positions x régulières de −1 à 1) : leurs écarts diffèrent, et elles ne se retrouvent jamais toutes en phase à intervalle régulier, ce qui ferait pulser le son. Leurs battements l'épaississent, comme une « supersaw ». `spread` (0 à 1) les répartit alternativement à gauche et à droite (0 : toutes au centre, mono ; 1 : les plus extrêmes tout à gauche et tout à droite ; une voix au centre garde son plein niveau des deux côtés). Les voix d'un partiel partagent son enveloppe ; chacune démarre ailleurs dans la forme d'onde (décalée de v × 0,618… période), et la somme est multipliée par 1/√voix pour garder à peu près la même intensité. Les crêtes peuvent monter jusqu'à √voix fois quand les voix se retrouvent en phase. Coût mesuré hors ligne : 16 partiels × 7 voix, environ 6 % d'un cœur ; 64 × 8, environ 30 %. Le filtre traite la gauche et la droite séparément. `SYNTHWAY_INVALID_PARAM` hors bornes (l'unisson en place est gardé). |
| `synthway_engine_get_envelope(engine, &attack, &decay, &sustain, &release)` | Lit l'enveloppe en place. |

Les quatre valeurs sont atomiques : on peut les changer pendant qu'une note joue, et elles s'appliquent au bloc audio suivant. Elles ne concernent que l'oscillateur unique : avec un timbre, chaque partiel a son enveloppe.

### Timbre (synthèse additive)

| Fonction | Rôle |
|---|---|
| `synthway_engine_set_timbre(engine, &timbre)` | Fait jouer chaque note par les partiels de `timbre` (`synthway_timbre_t` : `partial_count`, puis un tableau de `synthway_partial_t` avec `ratio` dans ]0, 1000], `amplitude` dans [0, 1], `waveform` et `envelope`, dont l'attaque `attack_curve` est droite ou convexe, le déclin `curve` et le relâchement `release_curve` linéaires ou exponentiels). `NULL` revient à l'oscillateur unique, le réglage par défaut. Un timbre sans partiel est muet. Une valeur hors bornes renvoie `SYNTHWAY_INVALID_PARAM` et le timbre en place est gardé. |
| `synthway_engine_get_timbre(engine, &timbre)` | Copie le timbre en place (`partial_count` à 0 avec l'oscillateur unique). |
| `synthway_engine_has_timbre(engine)` | Vrai si les notes sont jouées par un timbre, faux par l'oscillateur unique. |
| `synthway_get_max_partials()` | Nombre maximal de partiels (`SYNTHWAY_MAX_PARTIALS`, 64), pour le pont Python qui ne lit pas les `#define`. |

`SYNTHWAY_MAX_PARTIALS` est fixé à la compilation, car le thread audio n'alloue jamais de mémoire. Le changer modifie la taille de `synthway_timbre_t` : il faut alors mettre à jour `MAX_PARTIALS` dans `synthway-server/src/models.py` (le pont refuse de charger une bibliothèque qui ne correspond pas).

### Polyphonie : plusieurs notes, chacune sur un instrument

| Fonction | Rôle |
|---|---|
| `synthway_engine_set_instrument(engine, slot, &instrument)` / `synthway_engine_get_instrument(engine, slot, &instrument)` | Règle ou lit l'instrument `slot` (0 à `SYNTHWAY_MAX_INSTRUMENTS` − 1, soit 15). `synthway_instrument_t` réunit ce que règlent les fonctions ci-dessus : `waveform` et `envelope` de l'oscillateur unique (courbes ignorées, toujours linéaires), bornes et résonance du filtre, `reverb_mix`, unisson, et `has_timbre` avec `timbre`. Mêmes bornes que les fonctions ci-dessus ; une valeur hors bornes renvoie `SYNTHWAY_INVALID_PARAM` et l'instrument en place est gardé. S'applique au bloc suivant, aussi aux notes qui jouent. L'instrument 0 est celui de `set_waveform`, `set_timbre`, etc. |
| `synthway_engine_note_on(engine, note_id, slot, frequency_hz, volume)` | Démarre une note (fréquence dans ]0, 24000], volume de 0 à 1) sur l'instrument `slot`, en plus des autres. `note_id` est le nom que lui donne l'appelant, pour `note_off`. Si `note_id` sonne encore (tenue ou en relâchement), cette note repart de son niveau courant, à la nouvelle fréquence. Quand les 32 notes sont prises, la plus ancienne en relâchement laisse sa place, sinon la plus ancienne tenue. Une note qui part du silence prend aussitôt sa fréquence et son volume, sans glisser depuis la note d'avant de sa voix. |
| `synthway_engine_note_glide(engine, note_id, frequency_hz, seconds)` | Fait glisser la note `note_id` jusqu'à `frequency_hz` (]0, 24000]) en `seconds` (0 à `SYNTHWAY_MAX_GLIDE_SECONDS`, 600 ; 0 : un saut), en ligne droite en demi-tons : la fréquence est multipliée par le même facteur à chaque échantillon, et chaque demi-ton prend le même temps. Les glissés d'une note s'enchaînent : chacun part d'où et quand le précédent finit, le premier au bloc suivant. Un glissé vers la fréquence où est déjà la note la tient pendant ce temps. La note continue de glisser pendant son relâchement. Une note garde jusqu'à `SYNTHWAY_MAX_GLIDES` (64) glissés en attente ; les suivants sont ignorés, comme ceux d'une note qui ne sonne pas. Un `note_on` (même du même `note_id`) efface les glissés à venir. Le glissé est calculé dans le thread audio, à l'échantillon près : envoyés juste après leur `note_on`, ses glissés suivent la note sans dépendre du minuteur de l'appelant. |
| `synthway_engine_note_off(engine, note_id)` | Lance le relâchement de la note `note_id` ; rien si elle n'est pas tenue. |
| `synthway_engine_all_notes_off(engine)` | Lance le relâchement de toutes les notes de `note_on` (pas celle de l'API à une note). |
| `synthway_engine_get_sounding_notes(engine)` | Nombre de notes de `note_on` qui sonnent encore (tenues ou en relâchement), au dernier bloc audio. |

Les notes passent au thread audio par une file de 1024 événements, lue au début de chaque bloc (hors ligne : à chaque appel de `synthway_engine_render`). `note_on`, `note_glide`, `note_off` et `all_notes_off` renvoient `SYNTHWAY_ERROR` quand elle est pleine, ce qui n'arrive que si le thread audio ne tourne pas. Un instrument réglé juste avant un `note_on` est toujours vu par cette note. Mémoire : la réverbération de chaque instrument occupe environ 540 Ko, soit 8,6 Mo par moteur, alloués à sa création ; seules les réverbérations qui sonnent sont calculées.

### Rendu hors ligne

| Fonction | Rôle |
|---|---|
| `synthway_engine_init_offline(engine, config)` | Prépare le moteur sans ouvrir de carte son (fréquence d'échantillonnage et canaux de `config`). Un moteur est soit hors ligne, soit relié à une carte son. |
| `synthway_engine_render(engine, out_samples, frame_count)` | Écrit `frame_count` trames d'échantillons flottants entrelacés dans `out_samples`. |
| `synthway_engine_render_to_wav(engine, path, frame_count)` | Écrit `frame_count` trames dans un fichier WAV 16 bits. Le chemin est passé à `fopen()` : page de code ANSI sous Windows, UTF-8 ailleurs. |
| `synthway_engine_get_sample_rate(engine)`, `synthway_engine_get_channels(engine)` | Format réellement utilisé par le moteur. |

Les réglages (`set_frequency`, `set_volume`, `set_waveform`, `set_tone_enabled`) et les notes (`note_on`, `note_off`) s'appliquent aussi aux moteurs hors ligne. Un fichier impossible à écrire renvoie `SYNTHWAY_IO_ERROR`.

### Analyseur

Indépendant du moteur : il ne joue rien, et n'enregistre le micro que sur demande (`synthway_analyzer_start_recording`). Un analyseur n'est pas thread-safe : un thread à la fois (le serveur en utilise deux, un pour le micro et un pour les fichiers). Seul son micro tourne sur un thread à lui.

| Fonction | Rôle |
|---|---|
| `synthway_analyzer_create()`, `synthway_analyzer_destroy(analyzer)` | Crée un analyseur (environ 1,7 Mo, dont un tampon circulaire de 5 s pour le micro), sans micro ni fichier ; le détruit en fermant son micro. |
| `synthway_analyzer_analyze_samples(analyzer, samples, frame_count, sample_rate, &analysis)` | Analyse des échantillons mono autour de leur milieu (fréquence d'échantillonnage de 8 à 384 kHz). |
| `synthway_analyzer_open_input(analyzer, device_index, sample_rate)` | Ouvre une entrée (index de la liste des captures, -1 celle du système ; `sample_rate` 0 : sa propre fréquence) et commence à écouter, en mode exclusif si possible, sinon partagé. |
| `synthway_analyzer_is_input_exclusive(analyzer)` | Vrai si le micro a été ouvert en mode exclusif (sans les effets audio du système), faux en mode partagé ou micro fermé. |
| `synthway_analyzer_close_input(analyzer)`, `synthway_analyzer_is_input_open(analyzer)`, `synthway_analyzer_get_input_sample_rate(analyzer)` | Ferme le micro ; dit s'il est ouvert et à quelle fréquence. |
| `synthway_analyzer_analyze_input(analyzer, &analysis)` | Analyse ce que le micro vient d'entendre (la dernière fenêtre). Pendant un enregistrement, prend d'abord les nouveaux échantillons. `SYNTHWAY_INVALID_PARAM` micro fermé. |
| `synthway_analyzer_open_virtual_input(analyzer, sample_rate)`, `synthway_analyzer_write_input(analyzer, samples, frame_count)` | Une entrée sans périphérique, à la place du micro : l'appelant y écrit lui-même les échantillons, comme le ferait le thread de capture. Tout le reste marche comme avec un micro (analyse, enregistrement). Sert aux tests, qui n'ouvrent jamais le vrai micro. |
| `synthway_analyzer_start_recording(analyzer)` | Enregistre en mémoire ce que le micro entend à partir de maintenant, sans limite de durée (environ 11 Mo par minute à 48 kHz). `SYNTHWAY_NOT_RUNNING` micro fermé. Le thread de capture ne fait que remplir le tampon circulaire : l'enregistrement y prend les nouveaux échantillons à chaque `analyze_input` ou `get_recording_info`, à appeler au moins une fois par seconde. Ce qui a été écrasé entre-temps devient du silence, compté comme perdu. |
| `synthway_analyzer_stop_recording(analyzer)`, `synthway_analyzer_is_recording(analyzer)` | Arrête l'enregistrement, qui devient le fichier de l'analyseur (`analyze_clip`, `get_clip_overview`, `get_clip_track`, `save_clip_wav`) ; le micro reste ouvert. Fermer le micro arrête aussi un enregistrement en cours, et le garde. `SYNTHWAY_NOT_RUNNING` si rien n'était enregistré. |
| `synthway_analyzer_get_recording_info(analyzer, &frames, &lost_frames)` | Longueur de l'enregistrement en cours ou du dernier, et part de silence qui remplace des échantillons perdus. |
| `synthway_analyzer_load_clip(analyzer, path)`, `synthway_analyzer_load_clip_memory(analyzer, data, size)` | Charge un fichier WAV, FLAC ou MP3 (décodé en mémoire en stéréo ; l'analyse utilise le mix mono) à la place du précédent. `SYNTHWAY_IO_ERROR` illisible, `SYNTHWAY_FORMAT_ERROR` pas de l'audio, `SYNTHWAY_INVALID_PARAM` plus de 10 minutes (`SYNTHWAY_ANALYZER_MAX_CLIP_SECONDS`). |
| `synthway_analyzer_get_clip_info(analyzer, &frames, &sample_rate)` | Longueur et fréquence d'échantillonnage du fichier chargé (0 et 0 sans fichier). |
| `synthway_analyzer_analyze_clip(analyzer, time_s, &analysis)` | Analyse le fichier autour de `time_s` secondes. |
| `synthway_analyzer_analyze_clip_range(analyzer, start_s, end_s, window_s, reference_hz, harmonic_cents, &analysis)` | Analyse une zone du fichier avec des fenêtres de `window_s` secondes (`SYNTHWAY_ANALYZER_WINDOW_AUTO`, 0 : l'habituelle, environ 170 ms ; sinon de 0,01 à 0,5 s, 32768 échantillons au plus). Une zone pas plus longue qu'une fenêtre est analysée d'une seule fenêtre autour de son milieu : `[t − w/2, t + w/2]`, c'est l'instant `t` vu par une fenêtre de taille `w`. Une zone plus longue est analysée en 100 moments au plus, à 10 ms d'écart au moins, et le résultat est leur médiane : la note, et chaque partiel, reconnu d'un moment à l'autre par son rapport à la note (que le vibrato et une justesse imparfaite ne changent pas), gardé s'il est présent dans au moins la moitié des moments, avec la médiane de son rapport et de son amplitude ; le niveau, la netteté et le spectre point par point. `SYNTHWAY_INVALID_PARAM` sans fichier, zone vide ou fenêtre hors bornes. Une fenêtre qui n'est pas une puissance de deux est complétée de silence pour la FFT ; la note est prise sur la moitié centrale, ou sur toute la fenêtre quand elle est courte, pour trouver encore les notes graves. **Note de référence** : `reference_hz` donne la note à laquelle les rapports sont pris (de 16 à 5000 Hz) ; `SYNTHWAY_ANALYZER_REFERENCE_AUTO` (0) prend la note entendue, et pour une zone le bas de ses notes nettes (20 % des moments sont plus bas), pour qu'une fondamentale qui s'éteint avant ses harmoniques, et fait lire les moments suivants une octave plus haut, ne la fasse pas monter. Chaque moment net sur cette note, dans n'importe quelle octave (à 1,5 demi-ton près), a sa propre note ramenée dans l'octave de la référence, et ses rapports sont pris à elle : les sauts d'octave ne mélangent plus les rapports. Les attaques (moments peu nets, sous 0,5) et les autres notes sont écartés des médianes des partiels. **Harmoniques seulement** : `harmonic_cents` au-dessus de 0 (100 au plus) ne garde que les partiels à moins de ce nombre de cents d'un rapport entier, et seulement le plus fort de chaque harmonique (un pic faible à quelques dizaines de Hz d'une harmonique aiguë n'est pas un second partiel : jouer les deux les ferait battre), ce qui écarte l'essentiel des autres instruments d'un mix ; `SYNTHWAY_ANALYZER_ALL_PARTIALS` (0) les garde tous. |
| `synthway_analyzer_measure_envelopes(analyzer, start_s, end_s, window_s, reference_hz, harmonic_cents, &analysis, out_envelopes)` | L'enveloppe de chaque partiel sur une zone d'une seule note, de son attaque à la note suivante, pour en faire un instrument. Trouve les partiels comme `analyze_clip_range` (mêmes paramètres, mêmes erreurs), puis suit le niveau de chacun toutes les 5 ms à sa fréquence (filtre de Goertzel, fenêtre de 6 périodes de la note, de 20 à 100 ms) et en tire une enveloppe exponentielle : l'attaque est la montée jusqu'au pic ; le déclin, la chute régulière qui suit, jusqu'au silence ou à la remontée de la note suivante. Un partiel qui baisse de moins de 3 dB/s est tenu (maintien 1) ; une chute qui se stabilise donne son niveau de maintien ; sinon le partiel s'éteint (maintien 0). Le relâchement dure 0,3 s, comme un étouffoir, ou moins pour un partiel qui s'éteint plus vite. `out_envelopes` reçoit une enveloppe par partiel de `analysis`, dans le même ordre (place pour `SYNTHWAY_ANALYSIS_MAX_PARTIALS`), et les amplitudes deviennent les pics, relatifs au plus fort. Les attaques très courtes sont lues vers 10 ms. `SYNTHWAY_INVALID_PARAM` sans `out_envelopes`. |
| `synthway_analyzer_find_notes(analyzer, start_s, end_s, window_s, out_notes, capacity, &count)` | Les notes entendues dans une zone, même plusieurs à la fois (un accord, une mélodie sur une note tenue), et quand chacune commence et finit : `synthway_note_span_t` (`start_s`, `end_s`, `frequency_hz`, `strength` de 0 à 1, 1 pour la plus forte), triées par début puis par fréquence. Mêmes moments que `analyze_clip_range`. À chaque moment (`src/analysis/notes.c`), la note dont les harmoniques (à 30 cents, jusqu'à la 16e) expliquent le plus les partiels est prise d'abord : chaque harmonique compte pour son amplitude divisée par la racine de son rang, sans dépasser la moyenne d'elle et de ses voisines (une harmonique isolée ne prouve pas une note), et le tout est pondéré par la force de la fondamentale de la note face à sa plus forte harmonique. C'est ce qui écarte la fondamentale absente sous deux notes jouées ensemble : La5 et Ré6 sont les harmoniques 3 et 4 de Ré4, qu'une seule note prendrait pour la note jouée. Ses harmoniques sont retirées des partiels (une harmonique commune à deux notes garde le reste), puis la suivante est cherchée, jusqu'à 4 à la fois, tant qu'elle atteint le cinquième de la première. Une note suivie de moment en moment (à un demi-ton près, 3 moments manquants au plus) devient une plage ; une note entendue moins de 60 ms est écartée. Vérifié sur un accord de synthèse (Si♭5 + Ré6 puis La5 + Ré6 sur un Ré4 discret) et sur la piste de « Chasing Shadows ». `SYNTHWAY_INVALID_PARAM` comme `analyze_clip_range`, ou sans `out_notes`/`count`. |
| `synthway_analyzer_fit_waveform(analyzer, start_s, end_s, window_s, reference_hz, &fit)` | La forme d'onde dont une note est la plus proche : `SYNTHWAY_SHAPE_SAWTOOTH`, `SQUARE`, `TRIANGLE`, `PULSE` ou `SINE` (`synthway_wave_shape_t`, mêmes valeurs que `synthway_waveform_t`, plus l'impulsion), chacune à travers le passe-bas du moteur (12 dB par octave, `synthway_engine_set_filter`) qui lui va le mieux, car un son de synthé est rarement entendu sans filtre : une dent de scie filtrée tombe aussi vite qu'un triangle, ses harmoniques paires les distinguent. La note est celle de la zone (`analyze_clip_range`, harmoniques à 30 cents), ou `reference_hz`. À chaque moment de la zone où cette note est entendue (comme `find_notes` la trouverait), `src/analysis/waveform.c` mesure le niveau de chacune de ses harmoniques, même absente : la puissance à 40 cents d'elle (3 cases au moins), pour qu'un unisson étalé sur quelques cents compte en entier, face au fond entre les harmoniques. Une harmonique qu'une autre note joue aussi, assez fort pour la changer (l'une de ses 8 premières, sa force divisée par son rang atteignant 30 % de l'harmonique), est écartée à ce moment-là : La5 × 4 est Ré6 × 3, mais un Ré4 discret sous La5 laisse ses harmoniques tranquilles. Une note plus faible posée sur une harmonique de la note (la forte 3e d'un carré, lue comme une note) en fait partie. Les médianes sur les moments sont comparées à chaque forme : son niveau, sa coupure (6 par octave, de la note à la dernière harmonique) et sa résonance (jusqu'à 0,3) sont ajustés au plus près ; l'écart compte moins pour les harmoniques hautes (divisé par la racine du rang), et une harmonique de la forme sous le fond compte comme le fond. `synthway_waveform_fit_t` donne la note, les moments retenus, jusqu'à `SYNTHWAY_WAVEFORM_FIT_HARMONICS` (64) harmoniques (sous 16 kHz) avec leur niveau, leur fond et leur état (`SYNTHWAY_HARMONIC_HEARD`, `FAINT`, `SHARED`), deux repères (`even_db` : les paires face à leurs voisines impaires, vers −1 dB pour une dent de scie, très bas pour un carré ; `slope_db_per_octave` : la pente du maximum de chaque octave, −6 pour une dent de scie ou un carré, −12 pour un triangle) et `fits` : une `synthway_shape_fit_t` par forme (`duty`, `cutoff_hz` (0 : sans filtre), `resonance`, `error_db`), la plus proche d'abord. La phase n'est pas mesurée : elle ne s'entend pas sur une note tenue. Sans note, ou pour une note jamais entendue seule (un accord sur sa fondamentale absente), `fit_count` vaut 0. Vérifié sur des sons rendus (dent de scie filtrée à 3 kHz retrouvée à 3136 Hz, carré, triangle, impulsion à 25 %, sinus, accord, note discrète dessous) et sur la piste de « Chasing Shadows » (Si♭5, La5, Ré6 : dents de scie filtrées). 25 à 75 ms par zone. `SYNTHWAY_INVALID_PARAM` comme `analyze_clip_range`, ou sans `fit`. |
| `synthway_analyzer_get_clip_overview(analyzer, out_peaks, count)` | Forme d'onde pour l'affichage : la crête de chacune des `count` parts égales du fichier. |
| `synthway_analyzer_get_clip_stereo_overview(analyzer, out_left_peaks, out_right_peaks, count)` | Forme d'onde stéréo : les crêtes gauche et droite de chacune des `count` parts égales du fichier. Un enregistrement micro mono est dupliqué dans les deux sorties. |
| `synthway_analyzer_get_clip_waveform(analyzer, first_frame, frame_count, count, out_left_low, out_left_high, out_right_low, out_right_high)` | Forme d'onde d'une partie du clip, pour la dessiner à n'importe quel zoom : les `frame_count` échantillons à partir de `first_frame` (arrêtés à la fin du clip), coupés en `count` parts égales, avec le plus bas et le plus haut échantillon de chaque canal dans chacune (un clip mono donne les mêmes valeurs aux deux). Avec `count` égal à `frame_count`, chaque part est un échantillon. `SYNTHWAY_INVALID_PARAM` sans clip, avec `count` ou `frame_count` nul, ou si `first_frame` dépasse la fin. |
| `synthway_analyzer_get_clip_track(analyzer, count, out_frequency, out_clarity, out_level)` | La note tout le long du fichier, en `count` instants régulièrement espacés (sans partiels ni spectre : plus rapide). |
| `synthway_analyzer_save_clip_wav(analyzer, path)` | Écrit le fichier chargé ou le dernier enregistrement en WAV mono 16 bits, à sa fréquence d'échantillonnage. `SYNTHWAY_INVALID_PARAM` sans fichier, `SYNTHWAY_IO_ERROR` si l'écriture échoue. |
| `synthway_analyzer_set_noise_gate(analyzer, threshold_db)`, `synthway_analyzer_get_noise_gate(analyzer)` | Seuil anti-bruit, de `SYNTHWAY_ANALYZER_NOISE_GATE_OFF` (−120, désactivé : la valeur par défaut) à 0 dBFS, sinon `SYNTHWAY_INVALID_PARAM` et le seuil en place est gardé. Vaut pour toutes les analyses de cet analyseur, mais pas pour le suivi de la note d'un fichier. |
| `synthway_analysis_get_size()` | `sizeof(synthway_analysis_t)`, que le pont Python compare à sa copie de la structure. |

`synthway_analysis_t` donne la fréquence d'échantillonnage, la note (`frequency_hz`, 0 sans note), sa netteté (`clarity`), le niveau RMS (`level_db`), les partiels triés par fréquence (`frequency_hz`, `ratio` à la note, `amplitude` relative au plus fort) et un spectre d'affichage de 256 points (`spectrum_db`, de `spectrum_min_hz`, 20 Hz, à `spectrum_max_hz`, 20 kHz ou la moitié de la fréquence d'échantillonnage, sur une échelle logarithmique). Changer `SYNTHWAY_ANALYSIS_SPECTRUM_POINTS` ou `SYNTHWAY_MAX_PARTIALS` change sa taille : il faut alors mettre à jour `synthway-server/src/models.py` (le pont refuse de charger une bibliothèque qui ne correspond pas).
