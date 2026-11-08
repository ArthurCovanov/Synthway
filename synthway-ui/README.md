# Synthway UI (`synthway-ui`)

> Interface de Synthway : créer des instruments, composer, régler l'audio. Elle pilote `synthway-server`, qui pilote `synthway-core`.

L'interface n'envoie que des commandes. Le son est produit par le core, jamais par le navigateur.

---

## Écrans

La barre latérale, inspirée de [Voicebox](https://voicebox.sh/), donne accès à quatre écrans. L'écran courant est gardé dans l'URL (`#/instruments`, `#/composer`, `#/analyzer`, `#/settings`).

| Écran | Contenu | Relié au moteur aujourd'hui |
| --- | --- | --- |
| **Instrument Creator** | Bibliothèque d'instruments (cartes), éditeur de partiels (spectre, enveloppes, onde résultante, volume, filtre, couleur), liste et réglages de chaque partiel, clavier en bas d'écran | Partiels (le timbre), volume, notes jouées au clavier |
| **Composer** | Pistes (muet, solo, instrument), piano roll et transport avec vue d'ensemble | Lecture et pause, reprise, déplacement du curseur, addition des notes actives via le timbre du moteur (64 partiels au plus) |
| **Analyzer** | Source (micro ou fichier), accordeur (note, écart en cents, fréquence, netteté, niveau), spectre mesuré, liste des partiels. Affichage seul : rien n'est enregistré ni joué | Micro écouté par le core en direct (`/ws/analyzer`), fichier décodé et analysé par le core |
| **Réglages** | État du serveur, sortie audio et fréquence d'échantillonnage, MIDI, apparence, à propos | Démarrage et arrêt du moteur, choix de la sortie |

Les réglages qui pilotent le moteur portent un badge **Moteur**. Ceux qui ne sont pas encore pris en charge par le core portent un badge **Bientôt** : filtre et choix du clavier MIDI. Ils sont quand même édités et enregistrés.

### Partiels

Un instrument est un ensemble de partiels, sa carte d'identité. Chaque partiel a son oscillateur et son enveloppe : un rapport à la note jouée (×1 la note, ×2 son octave, ×2,76 un partiel inharmonique, de ×0,01 à ×1000), une amplitude, une forme d'onde, une enveloppe ADSR et une couleur. Les partiels sont numérotés 1, 2, 3… dans l'ordre de la liste : le numéro ne change pas quand on change le rapport.

- **Spectre :** une barre par partiel, à son rapport (horizontal) et à son amplitude (vertical). On la fait glisser à la souris ; près d'un rapport entier, l'**aimant** l'y accroche (Alt pour l'ignorer, bouton pour le couper). Un double-clic place un nouveau partiel. Une onde non sinusoïdale contient déjà ses propres harmoniques : elles sont dessinées en pointillés, dans la couleur du partiel. Au clavier, les flèches déplacent le partiel sélectionné (Maj pour aller plus vite).
- **Verrous :** le cadenas à côté du nom d'un partiel le fige : plus de glisser, de réglage, d'interrupteur actif/inactif ni de suppression (un petit cadenas le signale dans la liste et sur le spectre). « À tous » le saute, et « Générer » le garde, en tête de la liste. Le bouton **Verrouillé / Déverrouillé**, à côté du nom de l'instrument, fige tout l'instrument comme une sauvegarde : nom, description, catégorie, volume, filtre, couleur, partiels et leurs cadenas, suppression depuis la bibliothèque. L'instrument se joue toujours, et sa copie (Dupliquer) est déverrouillée. Les deux verrous sont enregistrés avec l'instrument.
- **Actif / inactif :** l'interrupteur au début de chaque ligne de la liste (et en tête des réglages du partiel) retire un partiel du son sans le supprimer. Inactif, il reste dans la liste et sur le spectre, estompé, mais il n'est ni envoyé au moteur, ni compté dans l'onde résultante, les enveloppes et les avertissements.
- **Saisie au clavier :** un clic sur la valeur d'un curseur (rapport, amplitude, temps de l'enveloppe, volume, filtre) ouvre une petite fenêtre pour la taper, virgule ou point acceptés ; Entrée valide, Échap ou un clic à côté annule. La saisie peut dépasser la course du curseur, jusqu'aux limites du serveur (10 s pour les temps, ×1000 pour le rapport). La fenêtre du rapport a aussi ÷2, ×2 et **Harmoniser** (arrondi à l'harmonique la plus proche).
- **Enveloppes :** celles de tous les partiels sur une même note, multipliées par leur amplitude, celle du partiel sélectionné au premier plan.
- **Onde résultante :** la somme des partiels, recalculée en JavaScript (comme dans le core, chaque partiel part de la phase 0).
- **Générer depuis une forme d'onde :** remplace les partiels non verrouillés par les 16 premières harmoniques sinusoïdales d'une dent de scie, d'un carré ou d'un triangle, pour voir comment ces formes se construisent.
- **Limite du moteur :** 64 partiels par instrument, la valeur donnée par le serveur (`max_partials`). Le compteur l'affiche et le bouton « Ajouter » se désactive à la limite.
- **Avertissements :** un partiel qui dépasse la moitié de la fréquence d'échantillonnage sur une note du clavier (jusqu'à C8) se replie en une autre fréquence : il est signalé avec la première note concernée. Si la somme des amplitudes × le volume dépasse 100 %, le son peut saturer. Ce ne sont que des avertissements : rien n'est bloqué.

Les instruments enregistrés avant les partiels (une forme d'onde et une enveloppe) deviennent un instrument à un partiel, qui sonne pareil ; trois préréglages additifs (Glass Organ, Plucked String, Neon Bell) sont ajoutés à leur bibliothèque.

La lecture du Composer envoie au moteur un timbre temporaire constitué des partiels des notes actives. Le curseur avance au tempo, suit le scroll horizontal, peut être déplacé en cliquant sur la règle et la lecture peut être mise en pause puis reprise. Le piano roll étend sa grille dans le sens du défilement : les octaves déjà parcourues gardent leur place, et les zones sans note restent vides. Chaque piste possède une note de base (C0 par défaut pour les nouvelles pistes) ; le champ accepte les notes comme `C0`, `B10` ou `A-3`, et le bouton de recentrage place cette note au centre du roll. Les notes restent conservées hors de la zone actuellement affichée. La plage audible reste liée aux limites physiques de fréquence du moteur. Le moteur limite l'addition à `max_partials` (64 par défaut) ; les partiels au-delà sont ignorés pendant la lecture. Le transport ne change pas le mode monophonique utilisé par le clavier des autres écrans.

### Analyzer

L'analyse est faite par `synthway-core` : l'interface ne touche jamais au son, elle affiche ce que le serveur lui envoie.

- **Micro :** choisir une entrée (la liste vient du serveur), puis **Écouter**. Le core ouvre le micro, et l'interface reçoit 20 analyses par seconde. Le micro se ferme sur **Arrêter**, en passant au mode Fichier ou en quittant l'onglet. Une seule page l'écoute à la fois. L'écran dit si le core a obtenu le mode exclusif (le son arrive sans les effets audio de Windows, et les autres applications ne peuvent pas utiliser le micro pendant l'écoute) ou seulement le mode partagé : un avertissement explique alors que la réduction de bruit de Windows peut étouffer une note tenue, et comment la couper.
- **Fichier :** **Importer un son** ou déposer un fichier WAV, FLAC ou MP3. Il est envoyé entier au serveur, qui le garde : il revient à la réouverture de l'onglet. La forme d'onde montre en points roses la note tout le long du fichier (plus haut quand elle monte, plus vif quand elle est nette). Un clic ou un glissé place le curseur, les flèches le déplacent de 10 ms (Maj : 100 ms). Le curseur part du moment le plus net (bouton **Moment le plus net**), et **Parcourir** le fait avancer en temps réel, sans jouer le son.
- **Accordeur :** la note la plus proche (en anglais et en solfège), l'écart en cents sur une jauge (vert à ±5 cents, jaune à ±15), la fréquence, la netteté et le niveau. Sous 0,5 de netteté ou sous −80 dBFS, aucune note n'est affichée ; entre 0,5 et 0,8, elle est estompée (« incertaine »). Au micro, la dernière note nette reste 1,2 s, estompée. Le La de référence se règle (440 Hz par défaut).
- **Spectre :** en dBFS sur une échelle de fréquences logarithmique, avec les partiels dans leur couleur, leur rapport à la note au-dessus des plus forts, et les harmoniques de la note en pointillés.
- **Anti-bruit :** sous le spectre, désactivé par défaut (0). En le montant, une ligne jaune apparaît sur le spectre, de −99 à −20 dBFS : le core ignore les pics en dessous (ce ne sont plus des partiels, et sans partiel au-dessus, pas de note). Il suffit de la placer juste au-dessus du bruit de fond visible (ventilateur, souffle). Il vaut pour le micro, en direct, et pour le fichier. Pour un réglage fin, un clic sur sa valeur ouvre une petite fenêtre de saisie, au dixième de décibel, de −120 (désactivé) à 0 dBFS, au-delà de la course du curseur ; son bouton **Désactiver** remet le seuil à −120.
- **Partiels :** fréquence, note la plus proche, rapport, harmonique la plus proche avec l'écart en cents (au-delà de 30 cents : « inharmonique »), amplitude relative au plus fort.
- **À venir :** faire une carte de l'Instrument Creator à partir des partiels (badge **Bientôt**), suivre l'enveloppe de chaque partiel, écouter le fichier par le core.

### Jouer au clavier

- **Clavier de l'ordinateur :** par position physique des touches, en AZERTY comme en QWERTY. La rangée du milieu joue les touches blanches, celle du dessus les noires. Les deux touches à gauche de la rangée du bas (`W`/`X` en AZERTY) changent d'octave.
- **Souris :** clic, ou glissé d'une touche à l'autre.
- **Monophonie :** le moteur joue une note à la fois. Relâcher une touche rejoue la dernière touche encore tenue.
- **Accord nécessaire :** rien ne sonne tant que l'audio n'est pas activé par le bouton ⏻ en bas à gauche, ou dans les Réglages.

### Données enregistrées

Instruments, composition, réglages audio, apparence et réglages de l'Analyzer (source, entrée, La de référence, anti-bruit) sont gardés dans le `localStorage` du navigateur. Ils ne sont pas encore enregistrés côté serveur : changer de navigateur repart des préréglages.

---

## Style

- **Couleurs :** relevées sur le logo `assets/logo/v4.png`. Fond `#000008`, néons du rose `#ff1aa8` au bleu `#2e4dff` en passant par le magenta et le violet. Pour distinguer les partiels, s'y ajoutent le cyan, le vert, le jaune, l'orange, le rouge et le blanc (couleur du premier partiel). Toutes les couleurs sont des variables CSS dans `src/styles/theme.css`, reprises dans `src/lib/neon.ts`.
- **Ambiance :** synthwave, avec un halo dans la brume et une grille d'horizon en perspective.
- **Polices :** Michroma pour les titres, qui rappelle le mot « SYNTHWAY » du logo ; Inter pour le texte ; JetBrains Mono pour les valeurs.
- **Icônes :** Lucide, sauf les trois de la navigation, dessinées pour Synthway dans `src/components/icons.tsx`. L'Instrument Creator est une sinusoïde sculptée en signal carré, avec une étincelle ; le Composer est un motif de piano roll ; l'Analyzer est une onde qui traverse une loupe révélant ses partiels.
- **Apparence réglable :** les lueurs et les animations se coupent dans les Réglages. Les animations se coupent aussi quand le système demande moins de mouvement.

---

## Structure

```text
synthway-ui/
├── index.html
├── vite.config.ts            # Proxy vers synthway-server, polling sous WSL
├── public/favicon.png        # Généré depuis le logo
├── scripts/
│   ├── make-brand-assets.py  # Régénère emblème, favicon et logo depuis assets/logo
│   └── mock-server.mjs       # Faux synthway-server, muet, pour développer l'UI
└── src/
    ├── main.tsx, App.tsx     # Point d'entrée, navigation, état partagé
    ├── types.ts              # Types du serveur et du core (à garder synchronisés)
    ├── styles/               # theme.css (variables), fonts.css (@font-face)
    ├── assets/
    │   ├── brand/            # Emblème et logo allégés (générés)
    │   └── fonts/            # Polices + licences (voir son README)
    ├── lib/
    │   ├── api.ts            # REST, WebSocket /ws/synth et /ws/analyzer, envoi d'un fichier à analyser
    │   ├── SynthServer.tsx   # Connexion au serveur, état du moteur, notes
    │   ├── appearance.tsx    # Lueurs / animations
    │   ├── instruments.ts    # Modèle (partiels), préréglages, migration des anciens instruments
    │   ├── partials.ts       # Partiels : harmoniques d'une onde, repliement, génération, envoi au moteur
    │   ├── composition.ts    # Modèle de composition (pistes, notes)
    │   ├── music.ts          # Notes MIDI et noms de notes, cents, formes d'onde (mêmes formules que le core)
    │   ├── neon.ts           # Couleurs d'accent et des partiels
    │   ├── storage.ts        # localStorage tolérant aux erreurs
    │   └── useElementSize.ts # Taille d'un élément, pour les graphiques en pixels
    ├── components/           # Barre latérale, contrôles, spectre, enveloppes, oscilloscope, clavier,
    │                         # accordeur, spectre mesuré, forme d'onde d'un fichier…
    └── screens/              # InstrumentCreator, Composer, Analyzer, Settings
```

Les styles sont des modules CSS (`*.module.css`), un par composant ou écran.

---

## Démarrage

Prérequis : Node.js 18 ou plus récent. Sous Windows, Node n'est installé que dans WSL : lance ces commandes depuis WSL.

```bash
cd synthway-ui
npm install
npm run dev
```

L'interface est sur [http://localhost:5173](http://localhost:5173). Vite relaie `/api`, `/health` et `/ws` vers `synthway-server`, par défaut `http://localhost:18741`. Si ce port est pris par autre chose, l'interface l'indique (« Port 18741 occupé ») ; lance alors le serveur sur un autre port et indique-le à Vite :

```bash
SYNTHWAY_SERVER_URL=http://localhost:18751 npm run dev
```

Les messages de l'interface (« Port … occupé », commande pour lancer le serveur) citent le port de cette adresse. Il est fixé au lancement de `npm run dev`, ou à la compilation pour `npm run build`.

Sous WSL, le projet est sur le disque Windows (`/mnt/c/...`), où les modifications faites depuis Windows ne déclenchent pas d'événements de fichiers. `vite.config.ts` passe donc automatiquement en scrutation (polling), pour que le rechargement à chaud fonctionne.

Pour vérifier le code : `npm run typecheck`, puis `npm run build` (voir le skill `ui-build`).

### Sans le vrai serveur

`scripts/mock-server.mjs` imite l'API de `synthway-server` sans core et sans aucun son, et journalise tout ce que l'interface envoie. Pour l'Analyzer, il n'ouvre aucun micro et ne décode aucun fichier : un faux micro chante autour de La 3, un peu bas, avec vibrato, et tout fichier WAV, FLAC ou MP3 devient une corde pincée en Sol 3 de 3 s. Pratique pour travailler sur l'UI sans risquer de jouer du son. Il écoute par défaut sur le port 18742, à côté de celui du vrai serveur (18741) mais jamais dessus : l'interface ne peut pas atteindre le vrai moteur par erreur.

```bash
npm run mock-server
SYNTHWAY_SERVER_URL=http://localhost:18742 npm run dev
```

Il faut le tenir à jour quand l'API du serveur change.

---

## Logo

Le logo maître est `assets/logo/v4.png`, à la racine du dépôt. L'interface utilise des déclinaisons allégées : emblème 256 px, logo 640 px et favicon. Après un changement de logo, régénère-les depuis la racine du dépôt :

```bash
uv run --with pillow python synthway-ui/scripts/make-brand-assets.py assets/logo/v4.png
```

Le script attend la même composition : emblème en haut, mot « SYNTHWAY » en dessous, fond quasi noir. Le fond disparaît à l'écran grâce au mode de fusion `screen`.

---

## Choix technologiques

| Option | Technologies | Avantages | Idéal pour |
| --- | --- | --- | --- |
| **Retenue** | React + Vite + TypeScript | Développement rapide, rechargement à chaud, typage strict | Interface web, testable dans n'importe quel navigateur |
| Bureau léger | Tauri + React | Exécutable natif d'environ 10 Mo, WebView du système | Application de bureau finale |
| Bureau lourd | Electron | Écosystème riche, mais binaire d'environ 150 Mo | Déconseillé face à Tauri |

Les polices sont embarquées, sans Google Fonts : l'interface fonctionne hors ligne, ce qui prépare un éventuel passage à Tauri.

---

## Crédits et licences

Toutes les ressources tierces autorisent l'usage commercial (règle du skill `third-party-resources`).

| Ressource | Usage | Auteur | Licence | Source |
| --- | --- | --- | --- | --- |
| React, React DOM | Interface | Meta Platforms, Inc. | MIT | https://react.dev |
| Lucide (`lucide-react`) | Icônes | Lucide Contributors | ISC | https://lucide.dev |
| Vite, `@vitejs/plugin-react` | Outillage de build | VoidZero Inc. et contributeurs | MIT | https://vitejs.dev |
| TypeScript | Typage | Microsoft | Apache-2.0 | https://www.typescriptlang.org |
| Michroma | Police des titres | The Michroma Project Authors | SIL OFL 1.1 | https://github.com/googlefonts/Michroma-font |
| Inter | Police du texte | The Inter Project Authors | SIL OFL 1.1 | https://github.com/rsms/inter |
| JetBrains Mono | Police des valeurs | The JetBrains Mono Project Authors | SIL OFL 1.1 | https://github.com/JetBrains/JetBrainsMono |
| Pillow | Script `make-brand-assets.py` uniquement (non livré) | Jeffrey A. Clark et contributeurs | MIT-CMU | https://python-pillow.org |
| Logo Synthway | Emblème, favicon, logo | Projet Synthway | Propriété du projet | `assets/logo/` |

Les textes de licence des polices sont livrés avec elles, dans `src/assets/fonts/licenses/` (détails dans [src/assets/fonts/README.md](src/assets/fonts/README.md)). Les icônes de navigation et les illustrations (oscilloscope, enveloppe, grille) sont dessinées pour Synthway.
