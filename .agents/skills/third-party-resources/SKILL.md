---
name: third-party-resources
description: Règles et vérifications pour intégrer des bibliothèques (C/C++, Python, npm) ou des assets (icônes, polices, sons, images) open-source et libres de droit dans le respect strict de leurs termes d'utilisation. À utiliser avant d'ajouter ou de mettre à jour une dépendance ou un asset externe dans n'importe quelle partie du projet.
---

# Bibliothèques et assets tiers (Open-source & Libres de droit)

Tout ajout externe dans Synthway (code tiers, paquet, asset visuel ou sonore) doit répondre à des critères stricts de licence et d'utilisation. Les agents IA et contributeurs doivent appliquer les règles suivantes.

## 1. Critères obligatoires

1. **Open-source et libre de droit (Royalty-free) :**
   - La ressource doit être diffusable, modifiable et utilisable sans redevance, y compris dans un cadre commercial.
   - **Licences autorisées :**
     - Code : MIT, Apache-2.0, BSD (2-Clause / 3-Clause), ISC, zlib, Unlicense, CC0 (Domaine public).
     - Assets (icônes, images, audio, polices) : CC0, Public Domain, SIL Open Font License (OFL), Apache-2.0, MIT, CC-BY (avec attribution conforme).
   - **Strictement interdit :**
     - Tout asset ou code propriétaire, payant ou sans licence explicite (« All rights reserved »).
     - Les licences restreignant l'usage commercial (ex. Creative Commons avec clause `-NC` comme CC-BY-NC, CC-BY-NC-SA, ou licences logicielles non-commerciales).
     - Les licences copyleft incompatibles (ex. GPL v2/v3 ou AGPL pour du code lié ou incorporé).

2. **Respect absolu des termes d'utilisation :**
   - **Conservation des mentions :** Ne supprime jamais les notices de copyright, en-têtes de licence ou fichiers `LICENSE` d'origine.
   - **Attribution :** Si la licence exige une attribution (ex. CC-BY, Apache-2.0), ajoute explicitement le crédit (nom de l'auteur, lien vers la source originale et nom de la licence) dans la documentation du dossier concerné (`README.md` ou document de crédits dédié).
   - **Marques et conditions de service :** Respecte les restrictions relatives aux marques et logos déposés, ainsi que les quotas ou conditions d'accès aux APIs tierces éventuelles.

## 2. Procédure par composant

### Dans `synthway-core` (C / C++)
- Ne dépose du code tiers que dans `synthway-core/vendor/<nom>/` (fichiers amont bruts, sans modification).
- Référence la version, l'URL amont et la licence dans `synthway-core/vendor/README.md`.
- Suis la procédure de compilation et d'isolation décrite dans le skill `vendor-update`.

### Dans `synthway-server` (Python)
- Ajoute les dépendances dans `synthway-server/requirements.txt`.
- Vérifie la licence du paquet sur [PyPI](https://pypi.org) avant ajout (éviter toute bibliothèque sous GPL ou licence restrictive).

### Dans `synthway-ui` (React / TypeScript / Vite)
- Ajoute les dépendances logicielles via `package.json` (npm).
- Vérifie la licence (`npm view <nom-du-paquet> license`). Privilégie les bibliothèques d'icônes ou d'UI reconnues sous MIT/ISC (ex. Lucide, Radix, Tailwind...).
- Pour les assets statiques (polices, SVG, sons, images) placés dans `public/` ou `src/assets/` :
  - Consigne la provenance, la licence exacte et l'auteur dans `synthway-ui/README.md` (section Crédits / Assets).

## 3. Checklist avant validation

Avant de commiter ou de marquer la tâche comme terminée, vérifie :
- [ ] La licence est-elle permissive et autorise-t-elle l'usage commercial ?
- [ ] Y a-t-il une absence totale de clause non-commerciale (`-NC`) ?
- [ ] Les mentions de copyright et le fichier de licence sont-ils conservés ou documentés ?
- [ ] L'attribution est-elle présente si la licence le requiert ?
