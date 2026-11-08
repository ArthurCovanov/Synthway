---
name: new-skill
description: Crée un skill pour le projet Synthway, lisible à la fois par Claude Code et par Gemini (Antigravity). À utiliser quand l'utilisateur demande un nouveau skill, une procédure réutilisable ou un runbook pour les agents.
---

# Créer un skill partagé

Claude Code et Antigravity utilisent le même format de skill, mais pas les mêmes dossiers. Pour qu'un skill serve aux deux, respecte ce qui suit.

## Emplacement

`.claude/skills/<nom>/SKILL.md`, et nulle part ailleurs. Claude Code ne lit que ce dossier ; Antigravity y est redirigé par `.agents/skills.json`. Un skill placé dans `.agents/skills/` serait invisible pour Claude.

## Format

```markdown
---
name: <nom>
description: <ce que fait le skill>. À utiliser quand <situation>.
---

# Titre

Étapes numérotées, commandes exactes, et comment vérifier que ça a marché.
```

- **Frontmatter :** uniquement `name` et `description`. Les autres champs (`allowed-tools`, `model`, `trigger`…) sont propres à un agent : l'autre les ignore ou les refuse.
- **`name` :** minuscules, chiffres et tirets, identique au nom du dossier. Évite les noms des skills intégrés aux agents (`run`, `init`, `plugin`, `automation`…).
- **`description` :** c'est elle qui décide si l'agent charge le skill. Dis ce qu'il fait **et** quand l'utiliser.
- **Contenu :** en français, court. Ne nomme pas d'outil propre à un agent (« utilise l'outil Bash ») : donne la commande à lancer.
- **Ressources externes :** Si le skill implique d'intégrer des bibliothèques ou assets tiers, rappelle l'obligation d'utiliser des ressources open-source, libres de droit et respectant les termes d'utilisation (voir `third-party-resources`).
- **Fichiers annexes :** `scripts/`, `references/` à côté de `SKILL.md`, reliés par des liens relatifs. Un script doit marcher sous Windows et sous WSL : fournis `.ps1` et `.sh`, ou un script Python.

## Après la création

1. Ajoute le skill au tableau « Skills partagés » de `AGENTS.md`.
2. Vérifie qu'il est vu : dans Claude Code, il apparaît dans la liste des skills ; dans Antigravity, demande à Gemini la liste des skills disponibles.
