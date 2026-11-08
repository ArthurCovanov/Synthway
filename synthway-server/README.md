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
│   └── models.py           # Modèles de données (Pydantic avec fallback Dataclasses)
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

- **Mode Web API complet (FastAPI + Uvicorn)** :
  ```bash
  cd synthway-server/src
  uvicorn main:app --reload --port 18741
  ```
  La documentation interactive Swagger sera immédiatement accessible sur [http://localhost:18741/docs](http://localhost:18741/docs).

  Le port de Synthway est **18741**, choisi parce que peu d'outils l'utilisent ; le 8000 est souvent pris (Open WebUI, Django…). Garde `--port 18741` : sans lui, uvicorn écoute sur son propre défaut, 8000. C'est le port que l'interface cherche par défaut.

  Le serveur n'écoute que sur cette machine (`127.0.0.1`), et seules les pages servies localement peuvent l'appeler directement (CORS). Ajouter `--host 0.0.0.0` l'ouvre au réseau : n'importe qui sur le réseau pourrait alors piloter ta sortie audio. Ne le fais qu'en connaissance de cause.

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

Le pont expose aussi ce rendu : `SynthwayCore.render()` (échantillons en mémoire) et `SynthwayCore.render_to_wav()` (fichier WAV), sur un moteur séparé du moteur temps réel.

---

## 🔈 Comportement du moteur

- **Démarrage muet :** `/api/engine/start` démarre le moteur sans son. Le son ne vient qu'avec un `note_on`, ou avec `"enabled": true` sur `/api/synth/tone`.
- **`note_on` sans moteur :** si le moteur n'est pas démarré, `note_on` le démarre d'abord, puis joue la note demandée.
- **Une note à la fois :** le moteur est monophonique, et `note_off` coupe le son sans arrêter le moteur.
  - **Composer :** les commandes directes `note_on` restent monophoniques. Pour lire une composition, l'UI envoie au même WebSocket un timbre temporaire assemblé depuis les notes simultanées, puis commande la hauteur de référence ; le core additionne ses partiels. La limite est celle de `max_partials` (64 par défaut).
- **Enveloppe :** `note_on` lance l'attaque et `note_off` le relâchement de l'enveloppe ADSR. Un `note_on` sur une note déjà ouverte change la hauteur sans relancer l'attaque (legato). Le serveur garde l'enveloppe et l'applique à chaque démarrage du moteur : on peut la régler avant de démarrer l'audio.
- **Analyzer :** deux analyseurs du core (`synthway_analyzer_t`), indépendants du moteur et créés au premier usage : l'un pour le micro, l'autre pour le fichier chargé, pour qu'un long décodage ne bloque pas l'analyse en direct. Le micro est ouvert par le core, seulement quand une page envoie `start` sur `/ws/analyzer`, et fermé à `stop` ou quand la page se déconnecte. Une seule page l'écoute à la fois. Rien n'est enregistré ni joué : seuls les résultats de l'analyse sortent du core. Un fichier importé arrive entier dans le corps de la requête, et le core le décode en mémoire (WAV, FLAC, MP3 ; 256 Mo et 10 minutes au plus).
- **Timbre (synthèse additive) :** un timbre remplace la forme d'onde et l'enveloppe par une liste de partiels, chacun avec son rapport à la note jouée, son amplitude, sa forme d'onde et son enveloppe. Comme l'enveloppe, le serveur le garde et l'applique à chaque démarrage du moteur. 64 partiels au plus (`max_partials` dans `/api/engine/status`, `MAX_PARTIALS` dans `models.py`, vérifié contre le core au chargement de la bibliothèque). Le serveur ne prévient ni des partiels au-delà de la moitié de la fréquence d'échantillonnage ni de la saturation : l'UI s'en charge.

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
| `POST` | `/api/synth/tone` | Modifie la fréquence ($Hz$), le volume ($0.0 - 1.0$), ou la forme d'onde |
| `POST` | `/api/synth/envelope` | Règle l'enveloppe `{"attack", "decay", "sustain", "release"}` : durées de 0 à 10 s, maintien de 0 à 1 (sinon 422) |
| `POST` | `/api/synth/timbre` | Fait jouer les notes par des partiels : `{"partials": [{"ratio", "amplitude", "waveform", "envelope"}, ...]}`, rapport dans ]0, 1000], amplitude de 0 à 1, 64 partiels au plus (sinon 422) |
| `DELETE` | `/api/synth/timbre` | Revient à l'oscillateur unique (forme d'onde et enveloppe) |
| `POST` | `/api/analyzer/clip?name=…` | Charge un fichier audio, envoyé tel quel dans le corps de la requête, à la place du précédent. Renvoie sa durée, sa fréquence d'échantillonnage, sa forme d'onde (`overview` : 1000 crêtes) et la note tout du long (`track` : fréquence, netteté et niveau toutes les 20 ms, 1000 points au plus). 400 si vide, 413 si trop gros ou trop long, 415 si ce n'est ni du WAV, ni du FLAC, ni du MP3 |
| `GET` | `/api/analyzer/clip` | Le dernier fichier chargé, comme ci-dessus, ou `null` |
| `GET` | `/api/analyzer/clip/analysis?time=…&noise_gate_db=…` | Analyse du fichier autour de `time` secondes : note (`frequency`, `clarity`, `level_db`), partiels (`frequency`, `ratio`, `amplitude`) et spectre (`spectrum_db`, 256 points de `spectrum_min_hz` à `spectrum_max_hz` sur une échelle logarithmique). `noise_gate_db`, facultatif, de −120 (désactivé, par défaut) à 0 : les pics sous ce niveau sont ignorés comme bruit ambiant (422 hors de ces bornes). 404 sans fichier |

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
    "envelope": { "attack": 0.01, "decay": 0.2, "sustain": 0.7, "release": 0.3 } }
  ```
- **Timbre en direct** (`"timbre": null` revient à l'oscillateur unique) :
  ```json
  { "type": "set_param", "timbre": { "partials": [
      { "ratio": 1, "amplitude": 0.6, "waveform": 0,
        "envelope": { "attack": 0.002, "decay": 3.0, "sustain": 0, "release": 0.8 } },
      { "ratio": 2.76, "amplitude": 0.2, "waveform": 0,
        "envelope": { "attack": 0.002, "decay": 1.1, "sustain": 0, "release": 0.8 } } ] } }
  ```
- **Retour du serveur** :
  À chaque modification, le serveur renvoie l'état synchronisé du moteur audio à tous les clients connectés.
- **Message invalide** (JSON cassé, valeur hors bornes) : le serveur répond `{"error": "..."}` et la connexion reste ouverte.

### Canal WebSocket (`/ws/analyzer`)

Analyse en direct du micro. Le core écoute et analyse ; le serveur envoie un résultat toutes les 50 ms. Rien n'est enregistré.

- **De la page :** `{ "type": "start", "device_index": -1, "sample_rate": 0, "noise_gate_db": -120 }` ouvre l'entrée choisie (`-1` : celle du système ; `0` : sa propre fréquence d'échantillonnage ; `noise_gate_db` facultatif, seuil anti-bruit de −120, désactivé, à 0), `{ "type": "set", "noise_gate_db": -70 }` change le seuil pendant l'écoute, `{ "type": "stop" }` la ferme.
- **Du serveur :** `{ "type": "started", "device_index": -1, "sample_rate": 48000, "exclusive": true }` (`exclusive` : le core a obtenu le mode exclusif, sans les effets audio du système ; `false` : mode partagé, avec eux), puis `{ "type": "analysis", "analysis": { ... } }` (même contenu que `/api/analyzer/clip/analysis`) jusqu'à `{ "type": "stopped" }`. Une erreur (micro introuvable, micro déjà écouté par une autre page, message invalide) donne `{ "type": "error", "error": "..." }` et la connexion reste ouverte.
- Le micro se ferme aussi quand la page se déconnecte.
