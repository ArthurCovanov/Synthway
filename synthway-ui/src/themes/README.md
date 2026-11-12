# Thèmes de l'interface

Chaque dossier de `src/themes/` est un thème. Les Réglages (**Settings**, carte **Appearance** / Apparence) les proposent sous le nom de leur dossier (`retro-light` s'affiche « Retro light »).

| Dossier | Allure |
| --- | --- |
| `default/` | Synthwave, l'allure d'origine : néons rose, violet et bleu sur nuit, brume et grille d'horizon. Contient **toutes** les feuilles de style de l'interface. |
| `retro-light/` | Clair et sobre : papier chaud, cartes blanches tracées de filets orange, texte encre, dégradé coucher de soleil des années 70 (ambre, orange, rouille), trois bandes rétro en haut de la fenêtre. Aucun halo. |
| `deep-blue/` | Sombre et plat : encre bleu nuit, un seul bleu électrique, texte blanc cassé, angles presque droits, grands titres fins, fin cadre bleu autour de la fenêtre, bouton principal blanc à texte bleu. Aucun halo. |
| `graphite/` | Noir et gris : fond noir, cartes graphite, accents gris neutres, bouton principal blanc à texte noir. Seuls les partiels, les pistes et les pistes séparées gardent des couleurs, adoucies, pour rester distincts. Aucun halo. |

## Les fichiers d'un thème

| Fichier | Rôle | Dans un autre thème |
| --- | --- | --- |
| `theme.css` | **Toutes les couleurs**, et polices, arrondis, fond de la fenêtre, halos : uniquement des variables, sur `:root`. | Presque toujours : c'est lui qui fait le thème. Il doit redéfinir **toutes** les variables de `default/theme.css`, qui explique chacune. |
| `overrides.css` | Chargé **après toutes les autres feuilles**, vide dans `default/`. | Les quelques règles que les variables ne suffisent pas à changer (une bordure, une police, un élément de plus), avec les sélecteurs de la page (`.Sidebar_logo img`). |
| `base.css` | Règles de toute la page : marges, barres de défilement, focus, réglages Lueurs et Animations. | Rarement : sans lui, le thème garde celui de `default/`. |
| `fonts.css` | Polices (`@font-face`). | Pour ajouter une police. |
| `App.module.css`, `components/*.module.css`, `screens/*.module.css` | Une feuille par composant ou par écran. | Pour refaire entièrement un composant. |

## Comment ça marche

- **Fichier par fichier.** Pour chaque feuille de `default/`, l'interface prend celle du thème choisi si elle existe au même chemin, sinon celle de `default/`. Un fichier remplacé l'est en entier : les règles de la version de `default/` ne s'appliquent plus.
- **Les couleurs ne sont que des variables.** Aucune feuille de `default/` n'écrit une couleur en dur : elles prennent toutes celles de `theme.css`, avec leurs nuances transparentes (`color-mix(in srgb, var(--accent) 30%, transparent)`). Même les dessins du code (oscilloscope, spectres, enveloppes, couleurs des partiels) lisent ces variables. Remplacer `theme.css` recolore donc toute l'interface.
- **Les rôles.** `--accent` (boutons, focus, sélection), `--accent-2` et `--accent-3` (deuxième et troisième couleurs), `--on-accent` (texte et marques posés sur un aplat de couleur), `--highlight` (la marque la plus visible sur le fond : tête de lecture, contour d'une note choisie), `--bg-0` à `--bg-5` (fonds, du plus profond au plus relevé), `--text-0` à `--text-3`, `--line`/`--grid` (filets et grilles). Les couleurs `--neon-*` sont celles des partiels, des pistes et des pistes séparées : il en faut dix bien distinctes, lisibles sur le fond.
- **Les halos.** `--glow` règle tous les halos néon : 1 tels quels, 0 aucun. Les trois plus forts (`--glow-pink`, `--glow-violet`, `--glow-blue`) sont des ombres complètes, que le réglage « Lueurs néon » coupe aussi.
- **Les noms de classes sont lisibles.** Dans la page, une classe s'appelle `<fichier>_<classe>` (`Sidebar_item`, `ui_btn`, `Composer_roll`), la même dans tous les thèmes. L'inspecteur du navigateur dit donc quelle règle viser dans `overrides.css`.
- **Changement immédiat.** Le choix du thème remplace aussitôt le texte des feuilles, sans recharger. Il est gardé dans le navigateur (`localStorage`, clé `synthway.theme.v1`). Si le thème gardé n'existe plus, c'est `default` qui s'affiche.

## Créer un thème

1. Crée le dossier `src/themes/<nom>/`, avec des tirets ou des soulignés entre les mots : `mon_theme` s'affiche « Mon theme ».
2. Copie `default/theme.css` (ou celui du thème le plus proche) et change les valeurs. Garde **toutes** les variables. Pour un fond clair, `color-scheme: light`.
3. Si besoin, ajoute un `overrides.css` pour les quelques détails restants. Les `overrides.css` de `retro-light/`, `deep-blue/` et `graphite/` en donnent des exemples : bandes ou cadre autour de la fenêtre, logo sans fondu, police des titres, chevron des listes déroulantes (une image dont la couleur ne peut pas venir d'une variable).
4. Essaie-le :
   - avec `npm run dev`, le thème apparaît dans les Réglages sans recharger la page, et chaque fichier enregistré s'affiche aussitôt ;
   - pour `synthway.bat`, le lanceur ou le zip Windows, reconstruis l'interface (`npm run build` dans WSL, ou double-clic sur `packaging/build_windows.bat`) : les thèmes sont compilés avec elle.

## Règles

- **Pas de couleur en dur dans les feuilles de `default/`.** Une nouvelle couleur devient une variable de `default/theme.css`, à ajouter aussi aux autres thèmes. Une nuance transparente passe par `color-mix(…, transparent)`, un halo (ombre sans décalage) par `calc(… * var(--glow))`.
- **Pas de `composes`.** La compilation s'arrête avec un message : regroupe plutôt les sélecteurs (`.card, .lane { … }`, comme dans `default/components/Automation.module.css`).
- **Chemins `url(…)` relatifs au fichier.** Une police ou une image propre au thème peut vivre dans son dossier (`url('./fonts/ma-police.woff2')`). Les polices communes sont dans `src/assets/fonts/` (`url('../../assets/fonts/inter-latin-wght.woff2')` depuis la racine du thème).
- **Ressources externes.** Une police, une image ou une icône ajoutée doit être open source et libre de droit, avec sa licence : suis le skill `third-party-resources`.
- **Ordre des feuilles.** `fonts.css`, `theme.css`, `base.css`, puis les feuilles des composants dans l'ordre des imports du code, et `overrides.css` en dernier : à spécificité égale, la dernière l'emporte.

## Ce qu'un thème ne change pas

- **Le logo et l'emblème** (`src/assets/brand/`) : des images. Sur un fond clair, `overrides.css` leur retire le fondu `screen`, sans quoi ils disparaissent.
- **Les teintes des notes** (`color-mix(…, #ffffff)` dans `Composer.module.css`) : un mélange avec du blanc pour éclaircir la couleur de la piste, le même dans tous les thèmes.

## Mécanique

Pour le développeur : le code importe ses feuilles par `@theme/<fichier>` (`import styles from '@theme/components/Sidebar.module.css'`). Le plugin `synthway-themes` de `vite.config.ts` fait de chaque import un petit module qui confie le fichier à `src/lib/themes.ts` ; celui-ci pose une balise `<style>` par fichier, dans l'ordre des imports, et en change le texte quand le thème change. Les textes de toutes les feuilles de tous les thèmes viennent de `src/lib/themeSources.ts` (`import.meta.glob`, compilés dans le script). Les dessins lisent les variables par `HUE_DRAW` et `themeColor()` (`src/lib/neon.ts`). Une nouvelle feuille de style se crée dans `default/`, puis s'importe par `@theme/…`.
