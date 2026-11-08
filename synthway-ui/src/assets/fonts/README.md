# Polices

Les polices sont embarquées dans l'application, pour qu'elle fonctionne hors ligne, sans dépendre de Google Fonts. Elles sont toutes sous **SIL Open Font License 1.1** : usage commercial autorisé, y compris intégrées à un logiciel vendu. La licence interdit seulement de vendre les polices seules, et elle impose de livrer son texte avec les fichiers (dossier `licenses/`).

| Fichier | Police | Usage dans l'UI | Copyright | Licence |
| --- | --- | --- | --- | --- |
| `michroma-latin-400.woff2` | Michroma 400 | Titres, libellés de navigation (rappelle le mot « SYNTHWAY » du logo) | 2011 The Michroma Project Authors | [OFL 1.1](licenses/OFL-Michroma.txt) |
| `inter-latin-wght.woff2` | Inter, variable 100–900 | Texte courant | 2016 The Inter Project Authors | [OFL 1.1](licenses/OFL-Inter.txt) |
| `jetbrains-mono-latin-wght.woff2` | JetBrains Mono, variable 100–800 | Valeurs numériques (Hz, BPM, %) | 2020 The JetBrains Mono Project Authors | [OFL 1.1](licenses/OFL-JetBrainsMono.txt) |

Source : paquets Fontsource 5.3.0 (`@fontsource/michroma`, `@fontsource-variable/inter`, `@fontsource-variable/jetbrains-mono`), sous-ensemble `latin`, qui couvre les accents du français.

Pour ajouter une police : vérifie d'abord que sa licence autorise l'usage commercial (OFL, Apache 2.0 ou MIT), puis ajoute son fichier, son texte de licence et une ligne à ce tableau.
