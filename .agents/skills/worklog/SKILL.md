---
name: worklog
description: Tient le journal partagé docs/journal.md pour que l'utilisateur, Codex et Gemini ne se marchent pas dessus. À utiliser au début de toute tâche qui va modifier des fichiers du dépôt, puis à la fin de cette tâche.
---

# Journal partagé

Le journal `docs/journal.md` dit qui travaille sur quoi. Les entrées les plus récentes sont en haut.

## Au début d'une tâche

1. Lis les entrées du haut de `docs/journal.md`.
2. Si une entrée **en cours** d'un autre contributeur touche les mêmes fichiers ou le même sujet, arrête-toi et demande à l'utilisateur comment procéder.
3. Sinon, ajoute ton entrée juste sous le paragraphe d'introduction, au-dessus de toutes les autres :

   ```markdown
   ## 2026-10-28 17:10 · Codex · en cours
   **Tâche :** ajouter le choix du périphérique de sortie au CLI
   **Fichiers :** synthway-core/examples/cli_main.c
   ```

   Date et heure locales, ton nom (`Codex`, `Gemini`, ou le prénom de l'utilisateur), statut `en cours`.

## À la fin

Relis le journal, puis mets à jour **ton** entrée :

- statut `terminé` (ou `abandonné`, ou `bloqué`) ;
- **Fichiers :** la liste réelle des fichiers modifiés ;
- **Résultat :** une ou deux phrases sur ce qui est fait, ce qui ne l'est pas et ce qui n'a pas été vérifié.

## Avant de rendre la main

Arrête tout serveur de développement que tu as lancé ou repris pour ta tâche avant de terminer. Relis le haut de docs/journal.md pour vérifier qu’aucun autre agent n’en dépend au même moment. Si un autre agent en a explicitement besoin, laisse-le tourner et indique dans le résultat de ton entrée le serveur concerné, son port si connu, et l’agent qui en dépend. Dans tous les cas, précise dans le journal si le serveur a été arrêté ou laissé actif. Ne coupe pas un serveur déjà lancé par l’utilisateur ou un autre agent et que tu n’as pas repris pour ta tâche.

## Règles

- Ne modifie jamais l'entrée d'un autre contributeur.
- Relis le fichier juste avant d'écrire : un autre agent a pu ajouter une entrée entre-temps.
- Pas d'entrée pour une tâche qui ne fait que lire ou répondre à une question.
