# Formats de fichier

Synthway enregistre deux sortes de fichiers, écrits et lus par `synthway-ui` (le serveur n'y touche pas). Ce sont des fichiers JSON en UTF-8, indentés, lisibles et modifiables à la main.

| Extension | Contenu | Écrit par | Lu par | Code |
| --- | --- | --- | --- | --- |
| `.swsong` | Un morceau du Composer, avec une copie des instruments qu'il utilise | Composer, bouton Enregistrer (Ctrl+S) | Composer, bouton Ouvrir (Ctrl+O) | `synthway-ui/src/lib/compositionFile.ts` |
| `.swinst` | Un instrument | Instrument Creator, bouton Exporter | Instrument Creator, bouton Importer | `synthway-ui/src/lib/instrumentFile.ts` |

Un fichier renommé en `.json` s'ouvre aussi. Le nom du fichier n'a pas d'importance : c'est le champ `format` qui dit ce qu'il contient.

Toute modification du modèle du Composer ou de l'Instrument Creator passe par le skill `file-formats`.

## En-tête commun

| Champ | Type | Rôle |
| --- | --- | --- |
| `format` | texte | `"synthway-composition"` ou `"synthway-instrument"` |
| `version` | entier ≥ 1 | Version du format. Version actuelle : 1 pour les deux |
| `savedAt` | date ISO 8601 | Date d'écriture, pour information ; non lue |

Un fichier d'une version plus récente que celle que l'interface sait lire est refusé, avec un message qui le dit.

## Morceau (`synthway-composition`, version 1)

```json
{
  "format": "synthway-composition",
  "version": 1,
  "savedAt": "2026-11-08T09:12:00.000Z",
  "composition": {
    "bpm": 98,
    "beatsPerBar": 4,
    "bars": 4,
    "tracks": [
      {
        "name": "Mélodie",
        "instrumentId": "neon-lead",
        "instrumentName": "Neon Lead",
        "hue": "pink",
        "basePitch": 12,
        "muted": false,
        "hidden": false,
        "notes": [
          { "pitch": 69, "start": 0, "length": 2 },
          { "pitch": 72, "start": 2, "length": 4, "bend": [{ "at": 2, "semitones": 2 }] }
        ],
        "automation": {
          "volume": {
            "points": [{ "at": 0, "value": 1 }, { "at": 16, "value": 0.25 }],
            "right": [{ "at": 0, "value": 1 }, { "at": 32, "value": 0 }]
          },
          "lowPass": { "points": [{ "at": 0, "value": 400 }, { "at": 16, "value": 12000 }] }
        }
      }
    ]
  },
  "instruments": [ { "id": "neon-lead", "name": "Neon Lead", "…": "comme dans un fichier .swinst" } ]
}
```

| Champ | Type | Lecture (valeur absente ou hors limites) |
| --- | --- | --- |
| `composition.bpm` | nombre, 40 à 240 | 98, ou ramené dans les limites |
| `composition.beatsPerBar` | entier, 1 à 16 | 4 |
| `composition.bars` | entier, 1 à 9 999 | 4, ou ramené dans les limites |
| `composition.tracks` | liste, au moins une piste | fichier refusé s'il n'y en a aucune |
| `tracks[].name` | texte, 24 caractères | « Piste n » |
| `tracks[].instrumentId` | texte | identifiant de l'instrument dans la bibliothèque (voir plus bas) |
| `tracks[].instrumentName` | texte, facultatif | nom de l'instrument à l'enregistrement : affiché s'il est introuvable |
| `tracks[].hue` | couleur néon (`pink`, `blue`…) | couleur de rang n |
| `tracks[].basePitch` | entier (numéro MIDI) | 12 (C0) |
| `tracks[].muted`, `tracks[].hidden` | booléens | `false` |
| `tracks[].notes[].pitch` | entier, 0 à 127 (MIDI) | 60 |
| `tracks[].notes[].start`, `length` | entiers, en pas (double croche), `length` ≥ 1 | 0 et 1 |
| `tracks[].notes[].bend` | liste facultative de `{ at, semitones }`, 32 au plus | `at` en pas depuis le début de la note (> 0), `semitones` en demi-tons depuis sa hauteur, triés par `at` |
| `tracks[].automation` | objet facultatif : une courbe par réglage, clés `volume`, `pan`, `lowPass`, `highPass`, `resonance`, `reverb`, `detune` | absent : les réglages de l'instrument tout le morceau ; clé inconnue ou courbe sans point ignorée |
| `automation.<réglage>.points` | liste de `{ at, value }`, 256 au plus : `at` en pas depuis le début du morceau (fractions permises), `value` dans l'unité du réglage | triés par `at` ; `at` ramené dans 0 à 639 936 (9 999 mesures de 16 temps), `value` dans ses limites, sinon sa valeur neutre (volume 1, passe-bas 20 000, passe-haut 20, autres 0) |
| `automation.<réglage>.right` | même chose, facultative : la courbe de droite (stéréo), `points` étant celle de gauche | ignorée pour `pan` et `detune`, qui n'ont qu'une courbe |
| `instruments` | liste d'instruments | une copie de chaque instrument utilisé par une piste, sans son verrou |

Les identifiants des pistes et des notes ne sont pas écrits : ils sont recréés à l'ouverture. Ne sont pas enregistrés non plus : la sélection, le zoom, la zone de boucle, le verrou des pistes, l'historique d'annulation.

Unités et limites des réglages d'automation : `volume` 0 à 1 (part du volume de l'instrument), `pan` -1 (gauche) à 1 (droite), `lowPass` et `highPass` 20 à 20 000 Hz, `resonance` et `reverb` 0 à 1, `detune` 0 à 100 cents. Une courbe va en ligne droite d'un point au suivant (en octaves pour `lowPass` et `highPass`), tient la valeur du premier point avant lui et celle du dernier après ; deux points au même `at` font un saut.

### Instrument introuvable

Une piste désigne son instrument par son identifiant (`instrumentId`). À l'ouverture d'un morceau :

1. l'instrument est dans la bibliothèque : c'est lui qui joue, tel qu'il y est. S'il a changé depuis l'enregistrement du morceau, le message d'ouverture le dit ;
2. sinon, le fichier en a une copie : elle est ajoutée à la bibliothèque, verrouillée, et le message d'ouverture le dit ;
3. sinon (instrument supprimé avant l'enregistrement, ou fichier écrit à la main) : la piste garde l'identifiant et le nom de son instrument, sa liste d'instruments passe en rouge (« ⚠ Nom · introuvable »), et elle est jouée avec **Hologram Sine**, le préréglage tel qu'il est livré (même s'il a été supprimé de la bibliothèque). Le message d'ouverture le signale.

Le cas 3 arrive aussi sans fichier, quand on supprime de la bibliothèque un instrument qu'une piste utilise. Importer de nouveau l'instrument (même identifiant) répare la piste : elle le retrouve d'elle-même.

## Instrument (`synthway-instrument`, version 1)

```json
{
  "format": "synthway-instrument",
  "version": 1,
  "savedAt": "2026-11-08T09:12:00.000Z",
  "instrument": {
    "id": "neon-lead",
    "name": "Neon Lead",
    "description": "Dent de scie tranchante, taillée pour les mélodies.",
    "category": "lead",
    "hue": "pink",
    "volume": 0.3,
    "partials": [
      {
        "id": "p1",
        "ratio": 1,
        "amplitude": 1,
        "waveform": 3,
        "envelope": { "attack": 0.01, "decay": 0.25, "sustain": 0.7, "release": 0.35 },
        "hue": "pink"
      }
    ],
    "filter": { "lowCutoff": 20, "cutoff": 6500, "resonance": 0.35 }
  }
}
```

| Champ | Type | Lecture (valeur absente ou hors limites) |
| --- | --- | --- |
| `id` | texte | gardé tel quel, pour que les morceaux qui l'utilisent le retrouvent ; recréé s'il manque |
| `name` | texte, 40 caractères | « Instrument importé » |
| `description` | texte, 120 caractères | vide |
| `category` | `lead`, `bass`, `pad`, `pluck` ou `fx` | `lead` |
| `hue` | couleur néon | `violet` |
| `volume` | 0 à 1 | 0,3 |
| `partials[].ratio` | 0,01 à 1000 (1 : la note jouée) | 1 |
| `partials[].amplitude` | 0 à 1 | 0,5 |
| `partials[].waveform` | 0 sinus, 1 carré, 2 triangle, 3 dent de scie | 0 |
| `partials[].envelope` | `attack`, `decay`, `release` en secondes (0 à 10), `sustain` 0 à 1 ; `curve`, `release_curve` (0 linéaire, 1 exponentielle) et `attack_curve` (0 linéaire, 1 convexe) facultatifs | 0,01 / 0,2 / 0,3 et 0,7 |
| `partials[].hue`, `muted`, `locked` | couleur, booléens facultatifs | — |
| `filter` | `lowCutoff` et `cutoff` en Hz (20 à 20 000, `cutoff` ≥ `lowCutoff` × 1,05), `resonance` 0 à 1 | aucun filtre |
| `reverb` | 0 à 1, facultatif | aucune |
| `unison` | `voices` (1 à 8), `detune` (cents, 0 à 100), `spread` (0 à 1), facultatif | aucun |
| `octave` | octave du clavier (1 à 6), facultatif | 4 |

Les champs inconnus sont ignorés. Un instrument enregistré avant les partiels (`waveform` et `envelope` à la racine) est converti comme dans la bibliothèque (`migrateInstrument`). Le verrou de l'instrument (`locked`) n'est jamais écrit.

### Import

Un instrument importé arrive **verrouillé** : on le déverrouille (cadenas, ou bouton « Déverrouiller » de l'éditeur) pour le modifier.

- Son identifiant est libre dans la bibliothèque : il est ajouté sous cet identifiant.
- Un instrument de même identifiant y est déjà, identique (son, nom et description ; verrous et octave du clavier ne comptent pas) : rien n'est ajouté, il est sélectionné.
- Un instrument de même identifiant y est déjà, différent : l'importé est ajouté à côté, avec un nouvel identifiant et le nom « Nom (importé) ». Celui de la bibliothèque n'est jamais remplacé, pour ne pas changer en silence les morceaux qui l'utilisent.

## Faire évoluer un format

- **Champ ajouté, facultatif :** pas de nouvelle version. L'écriture l'ajoute ; la lecture lui donne une valeur par défaut quand il manque (les fichiers déjà écrits n'en ont pas) et le ramène dans ses limites.
- **Champ renommé, supprimé, rendu obligatoire, ou dont le sens ou l'unité change :** `COMPOSITION_FORMAT_VERSION` ou `INSTRUMENT_FORMAT_VERSION` augmente de 1, et la lecture gagne une étape qui convertit un fichier de la version précédente. Les fichiers des anciennes versions doivent toujours s'ouvrir.
- Dans les deux cas, mettre à jour ce document : tableaux, exemple et historique ci-dessous.

## Historique

| Date | Format | Version | Changement |
| --- | --- | --- | --- |
| 2026-11-08 | morceau et instrument | 1 | Création |
| 2026-11-08 | morceau | 1 | Champ facultatif `tracks[].automation` (courbes d'automation) ; les fichiers sans lui s'ouvrent comme avant |
| 2026-11-08 | morceau | 1 | `composition.bars` jusqu'à 9 999 au lieu de 256 (le Composer en fixe le nombre librement) ; lecture seulement plus large, les fichiers déjà écrits s'ouvrent comme avant |
