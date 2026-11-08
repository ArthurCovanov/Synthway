# 🎛️ Synthway Server (`synthway-server`)

> Serveur d'orchestration, API REST & WebSockets temps réel pour piloter le moteur audio `synthway-core`.

---

## 🎯 Rôle et Périmètre

`synthway-server` agit comme le chef d'orchestre de l'écosystème Synthway :
1. **Pont FFI (`src/core_bridge.py`)** : Interagit avec la bibliothèque native `synthway.dll` (Windows) ou `libsynthway.so` (Linux) via `ctypes` avec typage strict, sans dépendre de chemins en dur.
2. **API REST (FastAPI)** : Expose les fonctionnalités de haut niveau (découverte des cartes son / périphériques, démarrage/arrêt du moteur, statuts, gestion des presets et profils).
3. **Canal WebSocket ultra basse latence (`/ws/synth`)** : Permet à l'interface graphique (`synthway-ui`) ou à des contrôleurs MIDI d'envoyer des événements temps réel (`note_on`, `note_off`, pitch bend, réglage dynamique des potentiomètres/knobs).

---

## 🏗️ Structure des Fichiers

```text
synthway-server/
├── README.md               # Ce document
├── requirements.txt        # Dépendances Python (FastAPI, Uvicorn, Pydantic, WebSockets)
├── pyproject.toml          # Métadonnées du projet Python
├── src/
│   ├── __init__.py         # Package init
│   ├── main.py             # Point d'entrée de l'application FastAPI & mode autonome
│   ├── core_bridge.py      # Wrapper Python ctypes vers libsynthway (cross-platform)
│   ├── models.py           # Modèles de données (Pydantic avec fallback Dataclasses)
│   └── separation.py       # Decomposer : lance Demucs (synthway-demucs) dans un processus à part
└── tests/                  # Tests sans son : le core y est remplacé par des doublures
```

> **Harmonie de structure** : Comme `synthway-core` et `synthway-ui`, `synthway-server` utilise le sous-dossier `src/` pour son code source. Cela évite les noms redondants (pas de `synthway-server/synthway_server`) et maintient une nomenclature propre et professionnelle. Une fois installé (`pip install .`), ce dossier devient le paquet Python `synthway_server` (voir `pyproject.toml`).

---

## 🚀 Installation & Démarrage

### 1. Prérequis
Assurez-vous d'avoir compilé `synthway-core` au préalable (voir le README de `synthway-core`).

### 2. Installation des dépendances Python

```bash
# Dans le dossier synthway-server :
pip install -r requirements.txt
```

### 3. Lancer le serveur

- **Sous Windows, pour jouer (recommandé)** :

  Lance le serveur sous Windows, pas dans WSL. Sous WSL, le son passe par WSLg (PulseAudio, puis une liaison RDP jusqu'à Windows) : mesuré à environ 0,5 s de retard, qui grandit tant que le moteur tourne, parce que les horloges de WSL et de Windows dérivent. Sous Windows, le core sort par WASAPI avec un tampon de 30 ms (3 × 10 ms, le minimum du mode partagé).

  Le Python de MSYS2 UCRT64 suffit. Installe une fois ses dépendances avec `pacman` : `pip` ne trouve pas de version compilée de `pydantic-core` pour ce Python.
  ```bash
  pacman -S --needed mingw-w64-ucrt-x86_64-python-fastapi mingw-w64-ucrt-x86_64-uvicorn mingw-w64-ucrt-x86_64-python-websockets mingw-w64-ucrt-x86_64-python-python-multipart
  ```
  Puis, dans PowerShell :
  ```powershell
  cd synthway-server
  C:\msys64\ucrt64\bin\python.exe -m uvicorn main:app --app-dir src --port 18741
  ```
  - **Sans `--reload` pour jouer :** avec lui, chaque modification du code du serveur (par toi, Claude ou Gemini) le redémarre et coupe le son. Ajoute-le seulement pour travailler sur le serveur.
  - **Un seul serveur sur 18741 :** n'en lance pas un autre dans la Debian en même temps. WSL relaie ses ports vers le `localhost` de Windows, et le second à démarrer trouve le port pris (`[winerror 10048] une seule utilisation de chaque adresse de socket…`).
  - **L'interface ne change pas :** Vite se lance dans la Debian (`npm run dev`), sur [http://localhost:5173](http://localhost:5173). Le navigateur appelle directement le serveur sur `http://127.0.0.1:18741`, sans passer par WSL.
  - **Sortie :** garde 48000 Hz dans les Réglages de l'interface si c'est la fréquence de ta sortie (`/api/devices` l'indique) : sinon, Windows rééchantillonne. Un casque Bluetooth ajoute souvent un retard à lui seul.

- **Mode Web API complet (FastAPI + Uvicorn)** :
  ```bash
  cd synthway-server/src
  uvicorn main:app --reload --port 18741
  ```
  La documentation interactive Swagger sera immédiatement accessible sur [http://localhost:18741/docs](http://localhost:18741/docs).

  Le port de Synthway est **18741**, choisi parce que peu d'outils l'utilisent ; le 8000 est souvent pris (Open WebUI, Django…). Garde `--port 18741` : sans lui, uvicorn écoute sur son propre défaut, 8000. C'est le port que l'interface cherche par défaut.

  Le serveur n'écoute que sur cette machine (`127.0.0.1`), et seules les pages servies localement peuvent l'appeler directement : par la règle CORS pour les routes HTTP, et en vérifiant l'en-tête `Origin` pour `/ws/synth` et `/ws/analyzer`, que le CORS ne couvre pas (un autre site est refusé, code 1008 / HTTP 403 ; un programme, sans en-tête `Origin`, est accepté). Sans cette vérification, n'importe quelle page ouverte dans le navigateur pourrait jouer des notes ou ouvrir le micro. Ajouter `--host 0.0.0.0` l'ouvre au réseau : n'importe qui sur le réseau pourrait alors piloter ta sortie audio. Ne le fais qu'en connaissance de cause.

- **Paquet installé** :
  ```bash
  pip install ./synthway-server
  SYNTHWAY_CORE_LIB=/chemin/vers/libsynthway.so synthway-server
  ```

  | Variable | Rôle | Défaut |
  |---|---|---|
  | `SYNTHWAY_HOST` | Adresse d'écoute | `127.0.0.1` |
  | `SYNTHWAY_PORT` | Port d'écoute (utile si 18741 est pris) | `18741` |
  | `SYNTHWAY_CORE_LIB` | Chemin de `synthway.dll` / `libsynthway.so` | Recherché dans `synthway-core/build` |
  | `SYNTHWAY_DEMUCS` | `0` désactive le Decomposer (la séparation par Demucs) | Activé s'il est installé |
  | `SYNTHWAY_DEMUCS_DIR` | Dossier `synthway-demucs` | À côté de `synthway-server` |

- **Mode test autonome (sans dépendances web)** :
  ```bash
  cd synthway-server/src
  python main.py
  ```
  Si FastAPI est installé, cette commande lance simplement le serveur. Sinon, elle valide le chargement de `libsynthway`, énumère les périphériques audio connectés et **joue un son de test de 1,5 s**.

### 4. Lancer les tests

```bash
# Dans le dossier synthway-server :
pip install -r requirements.txt pytest httpx
python -m pytest
```

Aucun test ne produit de son :
- `test_server.py` remplace le core par des doublures et n'a pas besoin de `synthway-core` compilé.
- `test_render.py` charge la vraie bibliothèque, mais seulement pour du rendu hors ligne, sans carte son. Il mesure la fréquence et le niveau de ce que produit le moteur. Il est ignoré si `synthway-core` n'est pas compilé.
- `test_analysis.py` charge aussi la vraie bibliothèque : il fait analyser par le core des sons rendus hors ligne (une carte de type cloche, un fichier WAV passé en mémoire) et vérifie qu'on retrouve la note et les partiels. Il n'ouvre jamais le micro.
- `test_separation.py` remplace Demucs par un faux script, qui rapporte sa progression comme le vrai : aucun modèle n'est chargé.

Le pont expose aussi ce rendu : `SynthwayCore.render()` (échantillons en mémoire) et `SynthwayCore.render_to_wav()` (fichier WAV), sur un moteur séparé du moteur temps réel.

---

## 🔈 Comportement du moteur

- **Démarrage muet :** `/api/engine/start` démarre le moteur sans son. Le son ne vient qu'avec un `note_on`, ou avec `"enabled": true` sur `/api/synth/tone`.
- **`note_on` sans moteur :** si le moteur n'est pas démarré, `note_on` le démarre d'abord, puis joue la note demandée.
- **La note unique :** un `note_on` sans `id` joue la note unique du moteur, sur l'instrument 0 (celui de `set_param` et de `/api/synth/*`), et `note_off` sans `id` coupe le son sans arrêter le moteur.
- **Polyphonie :** un `note_on` avec un `id` joue une note de plus, avec ses propres enveloppes, sur l'un des 16 instruments du moteur (`instrument`, 0 par défaut), réglés par `set_instrument` : jusqu'à 32 notes à la fois, en plus de la note unique. `note_off` avec le même `id` la relâche, `all_notes_off` les relâche toutes. Le serveur garde les instruments 1 à 15 et les applique à chaque démarrage du moteur, comme l'instrument 0. Le clavier de l'UI et la lecture du Composer jouent ainsi : chaque note a sa vraie attaque, même pendant qu'une autre est tenue.
- **Glissés :** `note_glide` fait glisser une note (avec `id`) vers une fréquence en un temps donné, en ligne droite en demi-tons (`synthway_engine_note_glide`). Les glissés d'une note s'enchaînent ; un glissé vers la même fréquence la tient. Le core les suit à l'échantillon près : passés dans le `note_on` (`"glides"`), ils partent avec la note.
- **Enveloppe :** `note_on` lance l'attaque et `note_off` le relâchement de l'enveloppe ADSR. Un `note_on` sans `id` sur la note unique déjà ouverte change la hauteur sans relancer l'attaque (legato) ; avec un `id` qui sonne encore, la note repart de son niveau courant avec une nouvelle attaque. Le serveur garde l'enveloppe et l'applique à chaque démarrage du moteur : on peut la régler avant de démarrer l'audio.
- **Analyzer :** deux analyseurs du core (`synthway_analyzer_t`), indépendants du moteur et créés au premier usage : l'un pour le micro, l'autre pour le fichier chargé, pour qu'un long décodage ne bloque pas l'analyse en direct. Le micro est ouvert par le core, seulement quand une page envoie `start` sur `/ws/analyzer`, et fermé à `stop` ou quand la page se déconnecte. Une seule page l'écoute à la fois. Rien n'est joué. Le micro n'est enregistré que si la page envoie `record` : le core garde l'enregistrement en mémoire, sans limite de durée, et ses échantillons ne passent par le serveur que lorsqu'on le télécharge en WAV. Le serveur l'alimente en appelant l'analyse en direct toutes les 50 ms. Sinon, seuls les résultats de l'analyse sortent du core. Un fichier importé arrive entier dans le corps de la requête, et le core le décode en mémoire (WAV, FLAC, MP3 ; 256 Mo et 10 minutes au plus).
- **Timbre (synthèse additive) :** un timbre remplace la forme d'onde et l'enveloppe par une liste de partiels, chacun avec son rapport à la note jouée, son amplitude, sa forme d'onde et son enveloppe. Comme l'enveloppe, le serveur le garde et l'applique à chaque démarrage du moteur. 64 partiels au plus (`max_partials` dans `/api/engine/status`, `MAX_PARTIALS` dans `models.py`, vérifié contre le core au chargement de la bibliothèque). Le serveur ne prévient ni des partiels au-delà de la moitié de la fréquence d'échantillonnage ni de la saturation : l'UI s'en charge.
- **Decomposer (séparation de sources) :** facultatif. Demucs v4 vit dans `synthway-demucs/`, avec son propre Python et PyTorch (`uv sync`), que le serveur n'importe jamais : `src/separation.py` lance `synthway-demucs/separate.py` dans un processus à part et suit les lignes JSON qu'il écrit. C'est un traitement de fichier hors ligne, aucun flux audio temps réel ne passe par Python. Un morceau à la fois, une séparation à la fois. Le Decomposer démarre vide à chaque lancement du serveur. Le morceau et ses pistes peuvent être retirés à tout moment (`DELETE /api/separation/source`). Les poids sont téléchargés au premier usage d'un modèle. Sans Demucs installé, ou avec `SYNTHWAY_DEMUCS=0`, les routes `/api/separation/...` répondent 503 et `GET /api/separation` dit pourquoi. Licence des poids non précisée : essai local seulement, voir `synthway-demucs/README.md`.
- **Filtre passe-bande :** `low_cutoff` (borne basse), `cutoff` (borne haute), de 20 à 20000 Hz, et `resonance`, de 0 à 1, sur `/api/synth/tone` ou dans un `set_param`. Chacun peut venir seul : les autres gardent leur valeur. La borne basse doit rester sous la borne haute, sinon le réglage est refusé (422, ou `{"error": ...}` sur le WebSocket) et le filtre ne change pas. Le serveur garde le filtre et l'applique à chaque démarrage du moteur, comme l'enveloppe. Par défaut, 20 Hz à 20 kHz sans résonance : le filtre est alors contourné, le son est inchangé.
- **Réverbération :** `reverb`, de 0 (aucune, par défaut) à 1 (la réverbération seule), la part de son réverbéré (`synthway_engine_set_reverb`), sur `/api/synth/tone` ou dans un `set_param`. Hors de 0 à 1 : 422, ou `{"error": ...}` sur le WebSocket. Le serveur la garde et l'applique à chaque démarrage du moteur, comme le filtre.
- **Unisson :** `unison` : `{"voices": 7, "detune": 15, "spread": 0.6}` (`synthway_engine_set_unison`), sur `/api/synth/tone` ou dans un `set_param` : chaque partiel du timbre joué par `voices` oscillateurs (1 à 8 ; 1 par défaut, pas d'unisson), désaccordés jusqu'à `detune` cents de part et d'autre (0 à 100), répartis en stéréo selon `spread` (0 à 1). Hors bornes : 422, ou `{"error": ...}` sur le WebSocket. Gardé par le serveur et appliqué à chaque démarrage du moteur.
- **Courbes de l'enveloppe :** l'enveloppe d'un partiel accepte `attack_curve` (0, par défaut, une rampe droite ; 1, une attaque convexe, lente puis de plus en plus rapide), `curve` pour le déclin et `release_curve` pour le relâchement (0 linéaire, 1 exponentielle). Sans `release_curve`, le relâchement prend la courbe du déclin, comme avant qu'il ait la sienne ; les réponses donnent toujours les trois.

---

## 📡 Spécification de l'API

### Endpoints REST

| Méthode | Route | Description |
|---|---|---|
| `GET` | `/health` | Statut du serveur et vérification du chargement de `synthway-core` |
| `GET` | `/api/devices` | Liste complète des périphériques audio (Sorties & Entrées) |
| `POST` | `/api/engine/start` | Démarre le moteur audio sur un périphérique choisi ou par défaut |
| `POST` | `/api/engine/stop` | Arrête le moteur audio |
| `GET` | `/api/engine/status` | Récupère l'état courant (fréquence, volume, forme d'onde, enveloppe, timbre ou `null`, `max_partials`, `sample_rate` du moteur ou `null`, statut) |
| `POST` | `/api/synth/tone` | Modifie la fréquence ($Hz$), le volume ($0.0 - 1.0$), la forme d'onde, le filtre passe-bande (`low_cutoff`, `cutoff`, `resonance`, voir plus haut ; 422 si la borne basse n'est pas sous la borne haute) la réverbération (`reverb`, de 0 à 1) ou l'unisson (`unison` : `voices`, `detune`, `spread`, voir plus haut) |
| `POST` | `/api/synth/envelope` | Règle l'enveloppe `{"attack", "decay", "sustain", "release"}` : durées de 0 à 10 s, maintien de 0 à 1 (sinon 422) |
| `POST` | `/api/synth/timbre` | Fait jouer les notes par des partiels : `{"partials": [{"ratio", "amplitude", "waveform", "envelope"}, ...]}`, rapport dans ]0, 1000], amplitude de 0 à 1, 64 partiels au plus (sinon 422). L'enveloppe d'un partiel accepte en plus `curve` : 0 (par défaut) linéaire, 1 exponentielle, où `decay` et `release` sont les temps pour perdre 60 dB |
| `DELETE` | `/api/synth/timbre` | Revient à l'oscillateur unique (forme d'onde et enveloppe) |
| `POST` | `/api/analyzer/clip?name=…` | Charge un fichier audio, envoyé tel quel dans le corps de la requête, à la place du précédent. Renvoie sa durée, sa fréquence d'échantillonnage, ses crêtes globales (`overview`) et gauche/droite (`overview_left`, `overview_right` : 1000 chacune) et la note tout du long (`track` : fréquence, netteté et niveau toutes les 20 ms, 1000 points au plus). 400 si vide, 413 si trop gros ou trop long, 415 si ce n'est ni du WAV, ni du FLAC, ni du MP3 |
| `GET` | `/api/analyzer/clip` | Le dernier fichier chargé, comme ci-dessus, ou `null` |
| `GET` | `/api/analyzer/clip.wav` | Le fichier chargé décodé en WAV pour le navigateur ; accepte les requêtes HTTP `Range` pour permettre la lecture à une position choisie |
| `GET` | `/api/analyzer/clip/analysis?time=…&window_ms=…&noise_gate_db=…` ou `?start=…&end=…&window_ms=…` | Analyse du fichier autour de `time` secondes, ou d'une zone de `start` à `end` (médiane de ses moments, voir `synthway_analyzer_analyze_clip_range`) : note (`frequency`, `clarity`, `level_db`), partiels (`frequency`, `ratio`, `amplitude`) et spectre (`spectrum_db`, 256 points de `spectrum_min_hz` à `spectrum_max_hz` sur une échelle logarithmique). `window_ms`, facultatif : la fenêtre d'analyse, de 10 à 500 ms, ou 0 (par défaut) pour l'habituelle, d'environ 170 ms. `noise_gate_db`, facultatif, de −120 (désactivé, par défaut) à 0 : les pics sous ce niveau sont ignorés comme bruit ambiant. `reference_hz`, facultatif : la note à laquelle les rapports sont pris, de 16 à 5000 Hz, ou 0 (par défaut) pour la note entendue (sauts d'octave corrigés sur une zone). `harmonic_cents`, facultatif : ne garde que les partiels à moins de ce nombre de cents d'un rapport entier (100 au plus), le plus fort de chaque harmonique, 0 (par défaut) pour tous. 422 hors de ces bornes, sans `time` ni zone, ou pour une zone vide ; 404 sans fichier |
| `GET` | `/api/analyzer/clip/waveform-fit?start=…&end=…` (et `window_ms`, `noise_gate_db` comme l'analyse, `reference_hz` : la note mesurée, 0 pour celle de la zone) | La forme d'onde dont la note est la plus proche (`synthway_analyzer_fit_waveform`) : `{"frequency", "moments", "harmonics": [{"level", "background", "state"}], "even_db", "even_count", "slope", "fits": [{"shape", "duty", "cutoff", "resonance", "error_db"}]}`. `shape` : 0 sinus, 1 carré, 2 triangle, 3 dent de scie, 4 impulsion ; `state` : 0 entendue, 1 pas au-dessus du fond, 2 partagée avec une autre note ; `cutoff` 0 : sans passe-bas ; `fits` vide quand la note n'est jamais entendue seule. Pour un moment, la zone de sa fenêtre. 422 hors bornes ; 404 sans fichier. `/api/analyzer/recording/waveform-fit` fait de même pour le dernier enregistrement |
| `GET` | `/api/analyzer/clip/notes?start=…&end=…` (et `window_ms`, `noise_gate_db`, comme l'analyse) | Les notes entendues dans la zone, même plusieurs à la fois, et quand chacune joue (`synthway_analyzer_find_notes`) : `[{"frequency", "start", "end", "strength"}]`, par début puis par fréquence, `strength` de 0 à 1 (1 pour la plus forte). 422 hors bornes ou pour une zone vide ; 404 sans fichier. `/api/analyzer/recording/notes` fait de même pour le dernier enregistrement |
| `GET` | `/api/analyzer/clip/envelopes?start=…&end=…` (et `window_ms`, `noise_gate_db`, `reference_hz`, `harmonic_cents`, comme l'analyse) | Les partiels d'une note du fichier et l'enveloppe de chacun, pour en faire un instrument (voir `synthway_analyzer_measure_envelopes`) : la zone va de l'attaque de la note à la suivante. Renvoie `{"analysis": ..., "envelopes": [...]}` : l'analyse de la zone, dont les amplitudes sont les pics des partiels, et une enveloppe exponentielle (`curve` 1) par partiel, dans le même ordre. 422 hors bornes ou pour une zone vide ; 404 sans fichier |
| `GET` | `/api/analyzer/clip/waveform?first=…&frames=…&count=…` | Forme d'onde d'une partie du fichier, pour la dessiner zoomée : les `frames` échantillons à partir de `first` (arrêtés à la fin du fichier), coupés en `count` parts égales (8192 au plus, jamais plus que d'échantillons), avec le plus bas et le plus haut échantillon de chaque canal dans chacune (`left_low`, `left_high`, `right_low`, `right_high`). Avec autant de parts que d'échantillons, chaque part est un échantillon. Renvoie aussi `first_frame` et `frame_count` (échantillons couverts). 404 sans fichier, 422 si `first` dépasse la fin |
| `GET` | `/api/analyzer/recording` | Le dernier enregistrement du micro, présenté comme un fichier (`name` : `"Enregistrement"`), ou `null` (aucun, ou enregistrement en cours). Il est distinct du fichier chargé |
| `GET` | `/api/analyzer/recording/analysis?time=…` ou `?start=…&end=…` (et `window_ms`, `noise_gate_db`) | Analyse de l'enregistrement, d'un instant ou d'une zone, comme pour un fichier. 404 sans enregistrement |
| `GET` | `/api/analyzer/recording/envelopes?start=…&end=…` | Les enveloppes d'une note de l'enregistrement, comme pour un fichier. 404 sans enregistrement |
| `GET` | `/api/analyzer/recording/waveform?first=…&frames=…&count=…` | Forme d'onde d'une partie de l'enregistrement, comme pour un fichier (mono : les deux canaux sont identiques). 404 sans enregistrement |
| `GET` | `/api/analyzer/recording.wav` | L'enregistrement en WAV mono 16 bits, écrit par le core, à télécharger (`Content-Disposition: attachment`) ; l'UI le lit aussi (le navigateur ignore alors cet en-tête) et il accepte les requêtes HTTP `Range` comme `clip.wav`. 404 sans enregistrement |
| `GET` | `/api/separation` | Decomposer : `available` et sinon `reason` (Demucs absent ou désactivé), `models`, le morceau chargé (`source` : `name`, `size`, ou `null`), la séparation (`job` : `state` `idle`/`running`/`done`/`error`/`cancelled`, `stage` `starting`/`loading`/`reading`/`separating`/`saving`, `progress` de 0 à 1, `model`, `device` `cuda` ou `cpu`, `error`) et son résultat (`result` : `model`, `device`, `sample_rate`, `duration`, `seconds` mis, `stems` : `name` et `peaks`, 1000 crêtes pour la dessiner ; ou `null`) |
| `POST` | `/api/separation/source?name=…` | Le morceau à décomposer (WAV, FLAC, MP3, OGG), envoyé tel quel dans le corps de la requête, à la place du précédent et de ses pistes. Renvoie l'état. 400 si vide, 413 si plus de 256 Mo, 409 pendant une séparation, 503 sans Demucs |
| `DELETE` | `/api/separation/source` | Retire le morceau et ses pistes, remet le Decomposer à vide. 409 pendant une séparation |
| `GET` | `/api/separation/source` | Le morceau tel qu'envoyé, pour l'écouter (accepte `Range`). 404 sans morceau |
| `POST` | `/api/separation/run` | `{"model": "htdemucs"}` (ou `htdemucs_ft`, `htdemucs_6s`) : lance la séparation en tâche de fond ; `GET /api/separation` la suit. 400 sans morceau, 409 si une séparation tourne déjà, 422 pour un modèle inconnu, 503 sans Demucs |
| `POST` | `/api/separation/cancel` | Arrête la séparation en cours (son processus est tué) ; `job.error` vaut alors « Décomposition annulée » |
| `GET` | `/api/separation/stems/{name}.wav` | Une piste en WAV 16 bits stéréo (accepte `Range`) ; `?download=true` la donne en pièce jointe, nommée d'après le morceau et la piste. 404 pour une piste inconnue |
| `POST` | `/api/separation/stems/{name}/analyzer` | Charge la piste dans l'Analyzer à la place de son fichier (nom : « morceau · piste ») et renvoie la même chose que `POST /api/analyzer/clip`. 404 pour une piste inconnue, 503 sans core |

### Canal WebSocket (`/ws/synth`)

Idéal pour l'interface graphique afin de limiter l'overhead HTTP :

- **Événement Note On** :
  ```json
  { "type": "note_on", "frequency": 440.0, "volume": 0.4 }
  ```
- **Événement Note Off** :
  ```json
  { "type": "note_off" }
  ```
- **Modification de paramètre en direct** (tous les champs sont facultatifs) :
  ```json
  { "type": "set_param", "frequency": 523.25, "waveform": 1,
    "envelope": { "attack": 0.01, "decay": 0.2, "sustain": 0.7, "release": 0.3 },
    "low_cutoff": 120, "cutoff": 6500, "resonance": 0.35, "reverb": 0.3 }
  ```
- **Timbre en direct** (`"timbre": null` revient à l'oscillateur unique) :
  ```json
  { "type": "set_param", "timbre": { "partials": [
      { "ratio": 1, "amplitude": 0.6, "waveform": 0,
        "envelope": { "attack": 0.002, "decay": 3.0, "sustain": 0, "release": 0.8 } },
      { "ratio": 2.76, "amplitude": 0.2, "waveform": 0,
        "envelope": { "attack": 0.002, "decay": 1.1, "sustain": 0, "release": 0.8, "curve": 1 } } ] } }
  ```
- **Polyphonie** : un instrument entier (un champ absent prend sa valeur par défaut : sinus, enveloppe du moteur, pas de timbre, filtre ouvert, ni réverbération ni unisson ; `slot` de 0 à 15, 0 étant celui de `set_param`), puis des notes nommées par `id` (entier de 0 à 2³² − 1, choisi par la page), en plus de la note unique :
  ```json
  { "type": "set_instrument", "slot": 1, "timbre": { "partials": [ ... ] },
    "low_cutoff": 20, "cutoff": 6500, "resonance": 0.35, "reverb": 0.2,
    "unison": { "voices": 3, "detune": 10, "spread": 0.5 } }
  { "type": "note_on", "id": 7, "instrument": 1, "frequency": 440.0, "volume": 0.3 }
  { "type": "note_off", "id": 7 }
  { "type": "all_notes_off" }
  ```
- **Glissés** (fréquence de 0 à 24000 Hz exclu, `seconds` de 0, un saut, à 600) : à la suite des glissés en attente de la note, ou dès son départ avec `"glides"` dans le `note_on` :
  ```json
  { "type": "note_on", "id": 7, "instrument": 1, "frequency": 220.0, "volume": 0.3,
    "glides": [ { "frequency": 440.0, "seconds": 1.0 }, { "frequency": 440.0, "seconds": 0.5 } ] }
  { "type": "note_glide", "id": 7, "frequency": 330.0, "seconds": 0.25 }
  ```
- **Retour du serveur** :
  À chaque modification, le serveur renvoie l'état synchronisé du moteur audio à tous les clients connectés.
- **Message invalide** (JSON cassé, champ obligatoire absent, valeur hors bornes) : le serveur répond `{"error": "..."}` et la connexion reste ouverte.

### Canal WebSocket (`/ws/analyzer`)

Analyse en direct du micro. Le core écoute et analyse ; le serveur envoie un résultat toutes les 50 ms. Rien n'est enregistré, sauf sur demande.

- **De la page :** `{ "type": "start", "device_index": -1, "sample_rate": 0, "noise_gate_db": -120 }` ouvre l'entrée choisie (`-1` : celle du système ; `0` : sa propre fréquence d'échantillonnage ; `noise_gate_db` facultatif, seuil anti-bruit de −120, désactivé, à 0), `{ "type": "set", "noise_gate_db": -70 }` change le seuil pendant l'écoute, `{ "type": "record" }` enregistre à partir de maintenant (micro ouvert), `{ "type": "stop_record" }` arrête l'enregistrement sans fermer le micro, `{ "type": "stop" }` ferme le micro.
- **Du serveur :** `{ "type": "started", "device_index": -1, "sample_rate": 48000, "exclusive": true }` (`exclusive` : le core a obtenu le mode exclusif, sans les effets audio du système ; `false` : mode partagé, avec eux), puis `{ "type": "analysis", "analysis": { ... } }` (même contenu que `/api/analyzer/clip/analysis`) jusqu'à `{ "type": "stopped" }`. Pendant un enregistrement : `{ "type": "recording" }` au début, `"recording": { "duration": 1.25, "lost": 0 }` dans chaque analyse (en secondes ; `lost` : échantillons que le core n'a pas eu le temps de prendre, remplacés par du silence), puis `{ "type": "recorded", "duration": 3.5, "lost": 0 }` à la fin, que la page l'ait demandée ou que le micro se ferme. Une erreur (micro introuvable, micro déjà écouté par une autre page, enregistrement sans micro, message invalide) donne `{ "type": "error", "error": "..." }` et la connexion reste ouverte.
- Le micro se ferme aussi quand la page se déconnecte ; un enregistrement en cours est alors gardé.
