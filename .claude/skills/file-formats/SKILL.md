---
name: file-formats
description: Garde à jour les formats de fichier .swsong (morceaux du Composer) et .swinst (instruments de l'Instrument Creator) quand le modèle change. À utiliser avant de modifier Composition, Track, Note, Instrument, TimbrePartial ou Envelope (synthway-ui/src/lib/composition.ts, instruments.ts), d'ajouter au Composer ou à l'Instrument Creator un réglage qui fait partie du morceau ou du son, ou de toucher à compositionFile.ts ou instrumentFile.ts.
---

# Formats de fichier du Composer et de l'Instrument Creator

Le Composer enregistre ses morceaux dans des fichiers `.swsong`, l'Instrument Creator exporte ses instruments en `.swinst`. Ces fichiers vivent hors de l'application : ceux écrits aujourd'hui devront encore s'ouvrir après tes changements. Un changement du modèle du Composer ou d'un instrument demande donc presque toujours de mettre à jour le format.

- **Spécification :** `docs/formats-de-fichier.md` (champs, limites, instrument introuvable, import, historique).
- **Code :** `synthway-ui/src/lib/compositionFile.ts` (morceau), `synthway-ui/src/lib/instrumentFile.ts` (instrument, aussi embarqué dans les morceaux), `synthway-ui/src/lib/files.ts` (dialogues, téléchargement, outils de lecture).

## 1. Le changement va-t-il dans le fichier ?

- **Oui**, si c'est de la musique ou du son : notes, pistes, tempo, mesure, volume ou effet d'une piste, réglage d'un instrument ou d'un partiel.
- **Non**, si c'est de l'affichage ou de la session : sélection, zoom, défilement, zone de boucle, verrou des pistes, nom du document, historique d'annulation, octave du clavier.

Si c'est non, rien à faire ici ; vérifie seulement que l'écriture ne l'emporte pas par accident (elle choisit ses champs un par un).

## 2. Compatible ou non ?

- **Champ ajouté et facultatif :** même version. Les fichiers déjà écrits ne l'ont pas : la lecture doit lui donner une valeur par défaut.
- **Champ renommé, supprimé, rendu obligatoire, ou dont le sens ou l'unité change :** la version augmente de 1 (`COMPOSITION_FORMAT_VERSION` ou `INSTRUMENT_FORMAT_VERSION`), et la lecture gagne une étape qui convertit la version précédente, dans `parseCompositionFile` ou `parseInstrumentFile`. Ne retire jamais la lecture d'une ancienne version.

## 3. Modifier le code

1. **Écriture :** `compositionFileText` (pistes et notes champ par champ, sans identifiants) ou `exportedInstrument` / `instrumentFileText`.
2. **Lecture :** `readTrack`, `readNote` ou `readInstrument` / `readPartial` / `readEnvelope`. Chaque champ est vérifié : type, valeur par défaut, limites (celles de l'éditeur et celles que `synthway-server` accepte). Une valeur hors limites est ramenée dedans, pas refusée.
3. **Instrument :** un champ qui ne concerne que l'édition (comme `locked` ou `octave`) doit aussi être retiré dans `essence()` d'`instrumentFile.ts`, sinon un import identique serait pris pour une autre version et dupliqué.
4. **`localStorage` :** le même modèle y est gardé. La bibliothèque passe par `migrateInstrument` (`instruments.ts`) ; la composition est relue telle quelle (`useUndoablePersistentState`), donc un nouveau champ doit aussi avoir sa valeur par défaut là où il est lu.

## 4. Documenter

Mets à jour `docs/formats-de-fichier.md` : tableau des champs, exemple JSON, ligne dans l'historique (date, format, version, changement). Si l'usage change pour l'utilisateur, aussi la section « Fichiers » de `synthway-ui/README.md`.

## 5. Vérifier

Avec le skill `ui-build` (serveur factice, aucun son) :

1. Avant ton changement, enregistre un morceau (et exporte un instrument) qui utilise ce que tu modifies ; garde ces fichiers hors du dépôt.
2. Après : ouvre-les. Ils doivent s'ouvrir sans erreur et donner le même résultat qu'avant (même partition, même son envoyé au moteur : voir le journal du serveur factice).
3. Enregistre de nouveau, rouvre, compare : rien ne doit se perdre à l'aller-retour.
4. Ouvre un fichier abîmé (champ manquant, valeur absurde) : il s'ouvre avec des valeurs par défaut, ou il est refusé avec un message clair.

Dans le navigateur de l'aperçu, les dialogues du système ne se pilotent pas : remplace `window.showSaveFilePicker` et le `click()` des `<input type="file">` par des versions qui capturent ou fournissent le texte du fichier.
