---
name: sound-check
description: Vérifie ce que produit le moteur audio de synthway-core sans haut-parleur et sans jouer de son, par rendu hors ligne et mesure (fréquence, niveau, silence). À utiliser après toute modification de la synthèse (oscillateurs, enveloppe, filtre, lissage, volume), quand un test de rendu échoue, ou pour répondre à « est-ce que ça sonne juste ? ».
---

# Vérifier le son sans l'écouter

Le moteur sait produire ses échantillons sans carte son (rendu hors ligne). Ce sont exactement ceux que recevrait la carte son, car le callback temps réel et le rendu hors ligne passent par la même fonction, `sw_engine_render` dans `src/engine/engine.c`, qui fait calculer le bloc par `sw_synth_render` (`src/synth/synth.c`). Le son se vérifie donc par la mesure, sans rien jouer.

Commence par compiler avec le skill `core-build`.

## 1. Test automatique

Depuis la racine du dépôt :

```powershell
powershell -ExecutionPolicy Bypass -File synthway-core/build.ps1 -Test
```

Sous Linux : `bash synthway-core/build.sh --test`.

Le test (`synthway-core/tests/render_test.c`) doit se terminer par `OK: 0 failure(s)`. Chaque ligne affiche les valeurs mesurées : fréquence, crête, RMS.

## 2. Vérification ponctuelle

Pour un cas que le test ne couvre pas : rends un WAV, puis mesure-le.

```powershell
synthway-core/build/bin/synthway_cli.exe --render synthway-core/build/note.wav 220 0.5 3
python synthway-core/tools/analyze_wav.py synthway-core/build/note.wav --expect-hz 220
```

- Arguments de `--render` : `<fichier.wav> [fréquence] [secondes] [forme]`, la forme valant 0 = sinus, 1 = carré, 2 = triangle, 3 = dent de scie. Le CLI rend à un volume de 0,2.
- Pour un timbre (synthèse additive), ajoute `--partials rapport:amplitude[:forme],...`, par exemple `--partials 1:0.6,2.76:0.3`. Chaque partiel prend l'enveloppe par défaut. La fréquence mesurée par `analyze_wav.py` (passages par zéro) n'a alors de sens que si la fondamentale domine : pour vérifier chaque partiel, mesure plutôt son amplitude à sa fréquence (voir plus bas).
- `analyze_wav.py` n'utilise que la bibliothèque standard de Python. Avec `--expect-hz`, son code de sortie vaut 1 si la fréquence s'écarte de plus de 0,5 %, ou si le fichier est silencieux.
- Écris les WAV dans `synthway-core/build/` ou dans un dossier temporaire, jamais à la racine du dépôt.

Valeurs de référence, pour une amplitude A, après 50 ms de lissage :

| Forme | Crête | RMS |
| --- | --- | --- |
| Sinus | A | A × 0,7071 |
| Carré | A | A |
| Triangle | A | A × 0,5774 |
| Dent de scie | A | A × 0,5774 |

## 3. Quand tu ajoutes une fonction de synthèse

Ajoute sa vérification dans `synthway-core/tests/render_test.c`, sur le modèle des tests existants : moteur hors ligne via `offline_engine()`, rendu via `render()`, mesure, puis `check()`. Les tests de l'enveloppe (`test_envelope_shape` et suivants) montrent la méthode : avec une onde carrée, la valeur absolue de chaque échantillon vaut exactement volume × niveau de l'enveloppe, ce qui permet de lire la courbe point par point. Pour un futur filtre, mesure plutôt l'atténuation d'une fréquence au-dessus de la coupure. Pour les partiels d'un timbre, `measure_amplitude()` donne l'amplitude d'une seule fréquence (un point de transformée de Fourier) ; elle est exacte quand la fenêtre contient un nombre entier de périodes de chaque partiel, par exemple 0,5 s à 200 Hz pour les rapports 1, 3 et 2,76 (`test_timbre_partials`).

Un paramètre partagé avec le thread audio suit le schéma décrit dans `src/engine/engine_params.h` : champ `_Atomic`, écriture relâchée dans le setter, lecture unique par bloc dans `sw_engine_params_snapshot`.

## 4. Depuis Python

`SynthwayCore.render()` renvoie les échantillons en mémoire et `SynthwayCore.render_to_wav()` écrit un WAV (`synthway-server/src/core_bridge.py`). Ils utilisent un moteur à part : le moteur temps réel n'est pas touché. Les tests de `synthway-server/tests/test_render.py` s'en servent.

## Son

Rien dans ce skill ne joue de son. Pour une écoute réelle, propose à l'utilisateur d'ouvrir lui-même le fichier WAV rendu, plutôt que de lancer le CLI en mode `--tone`.
