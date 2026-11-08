# Synthway Demucs (`synthway-demucs`)

Séparation de sources pour l'onglet **Decomposer** de l'interface : un morceau est décomposé en pistes (batterie, basse, voix, autres ; guitare et piano avec le modèle à 6 sources) par [Demucs v4](https://github.com/adefossez/demucs), un réseau de neurones. On peut ensuite analyser une piste seule dans l'Analyzer, sans le beat ni les autres instruments.

Cette partie est **facultative et à part** : elle a son propre Python et PyTorch, que le serveur n'importe jamais. Sans elle, le reste de Synthway marche pareil et l'onglet Decomposer dit pourquoi il ne peut rien décomposer.

## ⚠️ Licence : essai local seulement

| Élément | Licence | Statut |
| --- | --- | --- |
| Code de Demucs (`vendor/demucs/`) | MIT (© Meta Platforms, Inc. et affiliés) | Conforme aux règles du projet |
| Poids pré-entraînés (téléchargés au premier usage dans `models/`) | **Non précisée** | **Exception décidée par l'utilisateur le 2026-11-01** |

Le README de Demucs dit que la licence des poids n'est pas claire : MusDB, la base d'entraînement, contient des morceaux réservés à la recherche, et le modèle à 6 sources (`htdemucs_6s`), entraîné sur des données internes de Meta, relève probablement de CC-BY-NC (non commercial). Les pages Hugging Face des modèles n'indiquent aucune licence.

Les règles du projet (`AGENTS.md`, skill `third-party-resources`) refusent normalement une ressource sans licence explicite. L'utilisateur a décidé une exception **pour un essai local** :

- les poids restent sur la machine (`models/` est ignoré par git) : ils ne sont ni commités ni distribués ;
- avant toute version distribuée de Synthway, cette exception est à revoir : retirer `synthway-demucs/`, ou trouver des poids sous licence claire.

Les paquets installés dans `.venv/` (vérifiés le 2026-11-01) sont sous licences permissives (MIT, BSD, Apache-2.0, PSF, MPL-2.0 pour `tqdm`), à deux exceptions près, elles aussi limitées à cette machine :

- `lameenc` (LGPL-3.0 ou plus), tiré par Demucs pour écrire du MP3, que Synthway n'utilise pas ;
- les bibliothèques CUDA et cuDNN de NVIDIA, livrées dans le paquet `torch` (licence propriétaire de NVIDIA).

## Contenu

| Chemin | Rôle | Dans git |
| --- | --- | --- |
| `vendor/demucs/` | Dépôt amont [adefossez/demucs](https://github.com/adefossez/demucs), commit `829d21890023800713e5dd231c67e43ecc06069b` (2026-10-26), sans modification, sauf `test.mp3`, un extrait musical sans licence indiquée, laissé de côté | Oui |
| `pyproject.toml`, `uv.lock` | L'environnement : Demucs depuis `vendor/demucs`, PyTorch pour CUDA 13.0 sous Windows | Oui |
| `separate.py` | Le script que lance le serveur : sépare un fichier, écrit les pistes et `result.json`, rapporte sa progression en JSON | Oui |
| `.venv/` | L'environnement Python (environ 3 Go avec PyTorch CUDA) | Non |
| `models/` | Les poids téléchargés depuis Hugging Face (80 Mo pour `htdemucs`, 320 Mo pour `htdemucs_ft`) | Non |
| `work/` | Le dernier morceau envoyé et ses pistes (WAV 16 bits stéréo) | Non |

Pour mettre à jour Demucs : remplacer `vendor/demucs/` par la nouvelle version amont (sans `.git` ni `test.mp3`), noter le commit ici, puis `uv lock --upgrade-package demucs` et `uv sync`.

## Installation

Il faut [uv](https://docs.astral.sh/uv/). Il télécharge son propre Python (le Python de MSYS2 n'a pas de PyTorch utilisable), puis PyTorch et Demucs :

```powershell
cd synthway-demucs
uv sync
```

Sous Windows, PyTorch est la version CUDA 13.0 : une carte NVIDIA récente (les Blackwell demandent CUDA 12.8 ou plus) avec un pilote assez récent. Sans carte compatible, Demucs tourne sur le processeur, plus lentement.

Essai à la main, sans le serveur et sans rien jouer :

```powershell
.venv\Scripts\python separate.py "..\assets\audio\un morceau.mp3" work\essai --model htdemucs
```

## Comment le serveur l'utilise

`synthway-server/src/separation.py` lance `.venv/Scripts/python -I separate.py <morceau> work/stems --model <modèle>` dans un processus à part, lit ses lignes JSON (`loading`, `reading`, `progress`, `saving`, `done` ou `error`) et sert ensuite les pistes. Voir l'API dans `synthway-server/README.md`. C'est un traitement de fichier hors ligne : aucun flux audio temps réel ne passe par Python.

| Modèle | Pistes | Remarque |
| --- | --- | --- |
| `htdemucs` | batterie, basse, voix, autres | Par défaut, le plus rapide |
| `htdemucs_ft` | les mêmes | Un peu plus propre, environ 4 fois plus lent |
| `htdemucs_6s` | + guitare, piano | Le piano déborde beaucoup sur les autres pistes (selon l'auteur) ; licence des poids probablement non commerciale |

Demucs sépare par catégorie : deux synthés rangés dans « autres » restent mélangés, et chaque piste garde un peu des autres.

## Désactiver ou retirer

- **Désactiver :** lancer le serveur avec `SYNTHWAY_DEMUCS=0`. L'onglet reste, mais dit que le Decomposer est désactivé.
- **Retirer :** supprimer ce dossier. Pour enlever aussi l'onglet : `synthway-ui/src/screens/Decomposer.*`, son entrée dans `Sidebar.tsx`, `App.tsx` et `icons.tsx`, ses fonctions dans `lib/api.ts` et `types.ts`, ses routes dans `scripts/mock-server.mjs` ; côté serveur, `src/separation.py`, `tests/test_separation.py` et la section « Decomposer » de `src/main.py`.
