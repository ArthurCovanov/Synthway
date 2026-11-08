# Synthway UI (`synthway-ui`)

> Interface de Synthway : créer des instruments, composer, régler l'audio. Elle pilote `synthway-server`, qui pilote `synthway-core`.

L'interface n'envoie que des commandes. Le son est produit par le core, jamais par le navigateur.

---

## Écrans

La barre latérale, inspirée de [Voicebox](https://voicebox.sh/), donne accès à cinq écrans. L'écran courant est gardé dans l'URL (`#/instruments`, `#/composer`, `#/analyzer`, `#/decomposer`, `#/settings`).

| Écran | Contenu | Relié au moteur aujourd'hui |
| --- | --- | --- |
| **Instrument Creator** | Bibliothèque d'instruments (cartes), éditeur de partiels (spectre, enveloppes, onde résultante, volume, filtre, réverbération, couleur), liste et réglages de chaque partiel, clavier en bas d'écran | Partiels (le timbre), volume, notes jouées au clavier |
| **Composer** | Pistes (muet, visibilité, instrument), piano roll multi-pistes (notes fantômes en transparence) et transport avec vue d'ensemble | Lecture et pause, reprise, déplacement du curseur, addition des notes actives via le timbre du moteur (64 partiels au plus) |
| **Analyzer** | Source (micro ou fichier), accordeur (note, écart en cents, fréquence, netteté, niveau), spectre mesuré, liste des partiels | Micro écouté par le core en direct (`/ws/analyzer`), fichier décodé et analysé par le core ; lecture du fichier et de l'enregistrement dans le navigateur |
| **Decomposer** | Un morceau décomposé en pistes (batterie, basse, voix, autres ; guitare et piano avec 6 pistes) par Demucs, chaque piste lue, téléchargée ou envoyée à l'Analyzer | Aucun : la séparation est faite par Demucs, lancé par le serveur ; les pistes sont lues par le navigateur |
| **Réglages** | État du serveur, sortie audio et fréquence d'échantillonnage, MIDI, apparence, à propos | Démarrage et arrêt du moteur, choix de la sortie |

Les réglages qui pilotent le moteur portent un badge **Moteur**. Ceux qui ne sont pas encore pris en charge par le core portent un badge **Bientôt** : filtre et choix du clavier MIDI. Ils sont quand même édités et enregistrés.

**Barre d'espace :** dans l'Analyzer (fichier ou enregistrement de l'onglet affiché), le Decomposer (piste sélectionnée) et le Composer, elle fait lecture / pause, toujours à partir du curseur, au lieu de faire défiler la page. Elle reste aux champs de saisie (texte, nombre, liste) et prend la place d'un clic sur le bouton qui a le focus (qui sinon serait cliqué une deuxième fois). Code : `useSpaceBar` dans `src/lib/keyboard.ts`.

### Partiels

Un instrument est un ensemble de partiels, sa carte d'identité. Chaque partiel a son oscillateur et son enveloppe : un rapport à la note jouée (×1 la note, ×2 son octave, ×2,76 un partiel inharmonique, de ×0,01 à ×1000), une amplitude, une forme d'onde, une enveloppe ADSR et une couleur. Les partiels sont numérotés 1, 2, 3… dans l'ordre de la liste : le numéro ne change pas quand on change le rapport.

- **Spectre :** une barre par partiel, à son rapport (horizontal) et à son amplitude (vertical). On la fait glisser à la souris ; près d'un rapport entier, l'**aimant** l'y accroche (Alt pour l'ignorer, bouton pour le couper). Un double-clic place un nouveau partiel. Une onde non sinusoïdale contient déjà ses propres harmoniques : elles sont dessinées en pointillés, dans la couleur du partiel. Au clavier, les flèches déplacent le partiel sélectionné (Maj pour aller plus vite).
- **Verrous :** le cadenas à côté du nom d'un partiel le fige : plus de glisser, de réglage, d'interrupteur actif/inactif ni de suppression (un petit cadenas le signale dans la liste et sur le spectre). « À tous » le saute, et « Générer » le garde, en tête de la liste. Le bouton **Verrouillé / Déverrouillé**, à côté du nom de l'instrument, fige tout l'instrument comme une sauvegarde : nom, description, catégorie, volume, filtre, couleur, octave du clavier, partiels et leurs cadenas, suppression depuis la bibliothèque. L'instrument se joue toujours, et sa copie (Dupliquer) est déverrouillée. Les deux verrous sont enregistrés avec l'instrument.
- **Actif / inactif :** l'interrupteur au début de chaque ligne de la liste (et en tête des réglages du partiel) retire un partiel du son sans le supprimer. Inactif, il reste dans la liste et sur le spectre, estompé, mais il n'est ni envoyé au moteur, ni compté dans l'onde résultante, les enveloppes et les avertissements.
- **Filtre :** un passe-bande appliqué au son de l'instrument, dans l'Instrument Creator comme au clavier et dans le Composer, piloté en direct. Ses deux bornes sont les deux poignées d'une même barre « Bande passante », de 20 Hz à 20 kHz sur une échelle logarithmique (`RangeSlider` dans `components/ui.tsx`) : tout à gauche, la borne basse ne coupe rien et s'affiche 0 Hz ; tout à droite, la borne haute ne coupe rien ; les deux aux extrémités, il n'y a pas de filtre (« aucun filtre »). Une poignée s'arrête contre l'autre (la borne haute reste au moins 5 % au-dessus de la basse). Résonance en dessous. Les réglages sont enregistrés avec l'instrument.
- **Unisson :** sous la réverbération, trois barres : **Voix par partiel** (1 à 8 ; 1, la valeur d'un instrument qui n'en a pas : champ `unison` absent), **Désaccord** (±0 à ±50 cents sur la barre, jusqu'à ±100 à la saisie) et **Largeur stéréo** (0 à 100 %). Chaque partiel est alors joué par plusieurs oscillateurs un peu désaccordés, qui battent entre eux et épaississent le son, comme une « supersaw ». Envoyé en direct, au clavier et dans le Composer avec l'instrument ; enregistré avec lui. L'avertissement de saturation compte que les crêtes peuvent monter jusqu'à √voix fois.
- **Enveloppe du partiel, segment par segment :** **Attaque**, **Déclin** et **Relâchement** ont chacun leur réglage et leur courbe, **Linéaire** ou **Exponentielle** (d'autres pourront s'ajouter) ; le **Maintien** reste un pourcentage. Une attaque exponentielle est lente au début puis de plus en plus rapide (le carré d'une rampe droite, qu'on entend comme une montée exponentielle) et se règle en durée. Un segment linéaire se règle en durée ; un déclin ou un relâchement exponentiel se règle en **dB/s**, la vitesse à laquelle il tombe (barre logarithmique de 6 à 6000 dB/s, saisie jusqu'à 60000), avec sa durée pour perdre 60 dB en rappel. Un instrument enregistré avant que le relâchement ait sa propre courbe relâche comme il décline ; changer la courbe du déclin fige alors celle du relâchement. Les courbes sont dessinées sur les graphiques d'enveloppe et copiées par « À tous ».
- **Réverbération :** une barre « Son réverbéré », de 0 % (aucune, la valeur d'un instrument qui n'en a pas : champ `reverb` absent) à 100 % (la réverbération seule), envoyée en direct au moteur comme le filtre, et au clavier et dans le Composer avec l'instrument. Le moteur simule une salle d'environ 2 s. Comme la réverbération fait monter les crêtes (jusqu'à environ 1 + 2 × sa part), l'avertissement de saturation en tient compte. Enregistrée avec l'instrument.
- **Saisie au clavier :** un clic sur la valeur d'un curseur (rapport, amplitude, temps de l'enveloppe, volume, filtre) ouvre une petite fenêtre pour la taper, virgule ou point acceptés ; Entrée valide, Échap ou un clic à côté annule. La saisie peut dépasser la course du curseur, jusqu'aux limites du serveur (10 s pour les temps, ×1000 pour le rapport). La fenêtre du rapport a aussi ÷2, ×2 et **Harmoniser** (arrondi à l'harmonique la plus proche).
- **Enveloppes :** celles de tous les partiels sur une même note, multipliées par leur amplitude, celle du partiel sélectionné au premier plan. La note est tenue jusqu'à ce que le partiel le plus lent atteigne son maintien, 4 s au plus.
- **Courbe exponentielle :** le niveau perd autant de dB chaque seconde, comme une corde pincée. Les instruments créés depuis une zone de l'Analyzer ont un déclin et un relâchement exponentiels. Changer de courbe garde les temps tels quels.
- **Onde résultante :** la somme des partiels, recalculée en JavaScript (comme dans le core, chaque partiel part de la phase 0).
- **Générer depuis une forme d'onde :** remplace les partiels non verrouillés par les 16 premières harmoniques sinusoïdales d'une dent de scie, d'un carré ou d'un triangle, pour voir comment ces formes se construisent.
- **Limite du moteur :** 64 partiels par instrument, la valeur donnée par le serveur (`max_partials`). Le compteur l'affiche et le bouton « Ajouter » se désactive à la limite.
- **Avertissements :** un partiel qui dépasse la moitié de la fréquence d'échantillonnage sur une note du clavier (jusqu'à C8) se replie en une autre fréquence : il est signalé avec la première note concernée. Si la somme des amplitudes × le volume dépasse 100 %, le son peut saturer. Ce ne sont que des avertissements : rien n'est bloqué.

Les instruments enregistrés avant les partiels (une forme d'onde et une enveloppe) deviennent un instrument à un partiel, qui sonne pareil ; trois préréglages additifs (Glass Organ, Plucked String, Neon Bell) sont ajoutés à leur bibliothèque.

**Shadow Supersaw**, ajoutée plus tard, est proposée une seule fois à chaque bibliothèque, même ancienne (clé `synthway.offered-presets.v2`, écrite par un effet une fois la bibliothèque chargée : supprimée, elle ne revient pas). La v1 était écrite pendant la création de l'état, que le StrictMode de React fait deux fois en développement : le préréglage y était marqué comme proposé sans avoir été ajouté. Elle a été réglée par mesure sur la note La5 + Ré6 de « Chasing Shadows » (piste other de Demucs, 96,2 s) : douze harmoniques d'une dent de scie aux aigus adoucis, 7 voix d'unisson à ±15 cents, largeur 60 %, réverbération 20 %, attaque convexe de 90 ms (la remontée après chaque coup de grosse caisse), octave 5. Au même volume que l'original, sa corrélation gauche/droite est de 0,69 (original : 0,73). Pour l'accord, place La5 et Ré6 ensemble dans le Composer, une note par temps.

**Shadow Chord**, proposée de la même façon, joue tout l'accord La5 + Ré6 sur une seule touche, Ré4 : ses deux notes sont les harmoniques 3 et 4 de Ré4, mesurées par le core avec les leurs sur 116,28–116,78 s, après le coup de grosse caisse, où seul cet accord joue (14 harmoniques). 5 voix d'unisson à ±8 cents, largeur 50 %, réverbération 20 %, attaque convexe de 90 ms, déclin et relâchement exponentiels, volume 0,14. Réglée par mesure contre l'original, au même volume : spectre à 2,5 dB près en moyenne, corrélation gauche/droite 0,71 (original : 0,73) ; elle ondule encore un peu plus (14 dB contre 10).

Dans le piano roll, la molette fait défiler les notes ; **Ctrl + molette** (ou un pincement du pavé tactile, ou Alt + molette) zoome horizontalement autour du pointeur, sans zoomer le navigateur ; le clic milieu maintenu déplace la vue. Un clic dans une case vide ajoute une note et la sélectionne. Cliquer sur une note existante la sélectionne (mise en surbrillance blanche et néon, audition sonore si l'audio est actif) au lieu de la supprimer. Clic maintenu sur une note puis glisser : elle suit le pointeur, dans le temps (pas par pas) et en hauteur (demi-ton par demi-ton, audition à chaque nouvelle hauteur si l'audio est actif) ; elle ne passe jamais sur une autre note de même hauteur de sa piste (elle attend à sa dernière place libre) et ne bouge pas sur une piste verrouillée. Chaque note possède des bordures interactives (poignées gauche et droite avec curseur de redimensionnement) permettant d'étirer ou raccourcir sa durée personnalisée directement à la souris : le bord glissé va à la ligne de la grille la plus proche du pointeur, sans passer sur la note voisine de même hauteur, et l'inspecteur affiche la durée en doubles croches (par exemple `5/16`). Sur une piste verrouillée, les poignées n'apparaissent pas. **Notes qui glissent :** un double-clic sur une note y ajoute un point de courbe, posé sur la ligne (la note ne change pas encore) ; on le glisse ensuite à la souris, par quarts de pas et demi-tons, ou librement avec **Maj** (au centième de demi-ton près, comme un thérémine), sans jamais dépasser ses voisins ; un double-clic sur un point le retire. La note part de sa hauteur, va en ligne droite (en demi-tons) d'un point à l'autre, puis garde la hauteur du dernier jusqu'à sa fin ; elle est alors dessinée en ruban qui traverse la grille, et ses points (32 au plus) n'apparaissent que sélectionnée. Les points suivent la note quand on la déplace ou la transpose ; tirer son début les garde à leur place dans le temps (ceux qu'il dépasse disparaissent), et un point au-delà de la fin ne plie la ligne que jusqu'à elle. Glisser un point fait entendre chaque nouveau demi-ton (chaque quart de demi-ton avec Maj) si l'audio est actif. À la lecture, la note envoie toute sa courbe au moteur en démarrant (glissés du core, suivis à l'échantillon près) ; une lecture qui commence au milieu d'une note (curseur, boucle) reprend la courbe où elle en est. Une courbe changée pendant que sa note sonne ne s'entend qu'à son prochain départ. L'inspecteur indique le nombre de points (« Glissé ») et le bouton **Aplatir** retire la courbe. Au-dessus de la grille, un inspecteur donne également accès aux propriétés de la note sélectionnée ; il reste à sa place, vide et grisé quand aucune note n'est sélectionnée, pour que la grille ne bouge pas sous le pointeur au premier clic sur une note : transposition de la hauteur (±1 demi-ton, ±1 octave), modification de sa durée (1/16, 1/8, 1/4, 1/2), déplacement temporel (pas précédent / suivant) et bouton de suppression. La touche **Suppr** (ou Retour arrière) efface directement la note sélectionnée, **Échap** la désélectionne, et les flèches du clavier permettent de la transposer (Haut/Bas) ou de la déplacer (Gauche/Droite). La piste sélectionnée est celle sur laquelle on travaille (notes en couleur pleine, interactives) ; les autres pistes visibles s'affichent en transparence (notes fantômes dans la couleur de leur instrument) pour composer en voyant l'arrangement global. Chaque piste dispose d'un bouton **Afficher / Masquer** (œil) pour masquer ou afficher ses notes sur le piano roll, et d'un bouton **Muet** (**M**) pour couper son audio. Sélectionner une piste la recentre automatiquement sur sa note de base.

La lecture du Composer joue chaque note de la partition comme une note à part du moteur (polyphonie) : elle démarre à son premier pas avec sa propre attaque, même pendant qu'une autre note est tenue, et elle est relâchée après son dernier pas. Chaque piste a son propre instrument dans le moteur (emplacements 1 à 15, envoyés au lancement et à chaque changement), avec son timbre, son filtre, sa réverbération et son unisson. Le volume d'une note est celui de son instrument : les notes s'additionnent, plusieurs pistes fortes à la fois peuvent saturer. Une note déplacée pendant la lecture repart à sa nouvelle place ; une piste rendue muette se tait aussitôt. L'audition d'une note au clic joue sur l'instrument de sa piste, par-dessus la lecture. Le curseur avance au tempo, suit le scroll horizontal, peut être déplacé en cliquant sur la règle (curseur en barre de texte, comme sur la forme d'onde de l'Analyzer) et la lecture peut être mise en pause puis reprise (bouton ou barre d'espace), depuis le curseur. **Boucle :** glisser sur la règle choisit une zone (pas entiers, du pas pressé à celui sous le pointeur), marquée en rose sur la règle et sur la grille ; le curseur va à son début, et la lecture y reste : arrivée à la fin de la zone, elle repart de son début (les notes du début sont rejouées). Lancée hors de la zone, la lecture part de son début. Un clic sur la règle, Échap (quand aucune note n'est sélectionnée) ou le bouton Boucle du transport, allumé tant qu'il y a une zone, la retire. Comme dans l'Analyzer, la zone n'est pas enregistrée. Au clavier, Entrée sélectionne la piste qui a le focus : la barre d'espace, elle, lit ou met en pause. Le piano roll étend sa grille dans le sens du défilement : les octaves déjà parcourues gardent leur place, et les zones sans note restent vides. Chaque piste possède une note de base (C0 par défaut pour les nouvelles pistes) ; le champ accepte les notes comme `C0`, `B10` ou `A-3`, et le bouton de recentrage place cette note au centre du roll. Les notes restent conservées hors de la zone actuellement affichée. La plage audible reste liée aux limites physiques de fréquence du moteur. Le moteur joue jusqu'à 32 notes à la fois : au-delà, la plus ancienne laisse sa place.

### Analyzer

L'analyse est faite par `synthway-core`. Pour lire un fichier ou un enregistrement, le navigateur joue le WAV que le serveur lui fournit ; le micro reste géré par le core.

- **Micro :** choisir une entrée (la liste vient du serveur), puis **Écouter**. Le core ouvre le micro, et l'interface reçoit 20 analyses par seconde. Le micro se ferme sur **Arrêter**, en passant au mode Fichier ou en quittant l'onglet. Une seule page l'écoute à la fois. L'écran dit si le core a obtenu le mode exclusif (le son arrive sans les effets audio de Windows, et les autres applications ne peuvent pas utiliser le micro pendant l'écoute) ou seulement le mode partagé : un avertissement explique alors que la réduction de bruit de Windows peut étouffer une note tenue, et comment la couper.
- **Enregistrement :** sous le micro, **Enregistrer** ouvre le micro s'il est fermé et enregistre tout ce qu'il entend, dans le core, sans limite de durée (le badge compte les secondes) ; **Arrêter l'enregistrement** le termine, de même qu'**Arrêter** ou quitter l'onglet. La forme d'onde de l'enregistrement s'affiche alors comme celle d'un fichier, le curseur sur son moment le plus net. Placer le curseur (clic, flèches) coupe l'écoute en direct : la note, le spectre et les partiels sont ceux du moment choisi. **Lire** joue l'enregistrement dans le navigateur à partir du curseur (au début s'il n'y en a pas, et depuis la fin, il recommence), et le curseur le suit ; lire coupe aussi l'écoute, et placer le curseur met la lecture en pause. Le graphique se zoome, et un glissé y choisit une zone lue en boucle, comme pour un fichier ; **Écouter** retire aussi la zone. **Écouter** reprend le direct et retire le curseur, pour ne jamais mélanger les deux. **Télécharger .wav** récupère l'enregistrement en WAV mono 16 bits. Le serveur garde le dernier enregistrement : il revient à la réouverture de l'onglet ; un nouvel enregistrement le remplace.
- **Fichier :** **Importer un son** ou déposer un fichier WAV, FLAC ou MP3. Il est envoyé entier au serveur, qui le garde : il revient à la réouverture de l'onglet. La forme d'onde sépare les canaux **L** et **R** et montre en points roses la note tout le long du fichier. Le graphique affiche le zoom, à ×1 au départ ; la **roulette** (ou **Ctrl + roulette**, comme un pincement du pavé tactile) zoome horizontalement autour du pointeur, sans faire défiler la page ni zoomer le navigateur tant que le pointeur est sur la forme d'onde (Alt + roulette marche aussi : Alt empêche le défilement de la page dans toute l'application), jusqu'à ne plus voir qu'une trentaine d'échantillons, et le clic milieu maintenu déplace l'affichage horizontalement. Comme dans un éditeur audio, la forme d'onde est la vraie à tout zoom : le serveur donne, pour la partie affichée (et autant de chaque côté), le plus bas et le plus haut échantillon de chaque colonne de pixels, puis les échantillons eux-mêmes, reliés, avec un point chacun quand ils sont assez écartés. Elle est redemandée au plus toutes les 50 ms en zoomant ou en déplaçant ; en attendant, ou sans serveur à jour, c'est l'aperçu de 1000 crêtes qui s'affiche. Un clic au bouton gauche place le curseur, les flèches le déplacent de 10 ms (Maj : 100 ms). Un glissé au bouton gauche choisit une zone (au-delà de 4 pixels ; le curseur se place à son début) : **Lire** la joue alors en boucle, depuis le curseur s'il est dedans, sinon depuis son début. Le retour au début se fait par un saut du lecteur, vérifié toutes les 10 ms : la boucle peut dépasser un peu la fin de la zone, et un court blanc peut s'entendre au raccord. Un clic simple ou Échap retire la zone. **Lire** joue le fichier décodé en WAV par le navigateur à partir du curseur (depuis la fin, il recommence) ; le curseur et l'analyse le suivent, 20 fois par seconde. Cliquer ou glisser sur la forme d'onde met la lecture en pause et choisit le moment analysé, d'où repartira **Lire**. La lecture est en mono, même pour un fichier stéréo. **Moment le plus net** place le curseur sur la note la plus nette.
- **Accordeur :** la note la plus proche (en anglais et en solfège), l'écart en cents sur une jauge (vert à ±5 cents, jaune à ±15), la fréquence, la netteté et le niveau. Sous 0,5 de netteté ou sous −80 dBFS, aucune note n'est affichée ; entre 0,5 et 0,8, elle est estompée (« incertaine »). Au micro, la dernière note nette reste 1,2 s, estompée. Le La de référence se règle (440 Hz par défaut).
- **Spectre :** en dBFS sur une échelle de fréquences logarithmique, avec les partiels dans leur couleur, leur rapport à la note au-dessus des plus forts, et les harmoniques de la note en pointillés.
- **Anti-bruit :** sous le spectre, désactivé par défaut (0). En le montant, une ligne jaune apparaît sur le spectre, de −99 à −20 dBFS : le core ignore les pics en dessous (ce ne sont plus des partiels, et sans partiel au-dessus, pas de note). Il suffit de la placer juste au-dessus du bruit de fond visible (ventilateur, souffle). Il vaut pour le micro, en direct, et pour le fichier. Pour un réglage fin, un clic sur sa valeur ouvre une petite fenêtre de saisie, au dixième de décibel, de −120 (désactivé) à 0 dBFS, au-delà de la course du curseur ; son bouton **Désactiver** remet le seuil à −120.
- **Fenêtre d'analyse :** sous l'anti-bruit, de 20 à 320 ms (170 par défaut, gardée dans `synthway.analyzer.window-ms.v1`), avec la même petite fenêtre de saisie. Sans zone, le curseur analyse cette durée autour de lui, montrée sur la forme d'onde par des bornes vertes |—|—| (et une bande verte pâle). Plus courte, l'analyse est plus précise dans le temps ; plus longue, plus fine en fréquence et meilleure pour les notes graves. En direct, au micro, l'analyse garde sa fenêtre habituelle.
- **Zone :** quand une zone est choisie, les panneaux montrent l'analyse de toute la zone, faite par le core : des fenêtres de la taille choisie passées d'un bout à l'autre (100 au plus, à 10 ms d'écart au moins), puis la médiane. Chaque partiel est reconnu d'un moment à l'autre par son rapport à la note, que le vibrato ne change pas, et gardé s'il est présent dans au moins la moitié des moments. Le mode curseur n'est qu'un cas particulier : une zone de la taille de la fenêtre. Pendant la lecture en boucle, l'analyse de la zone reste fixe.
- **Avertissements :** sous la fenêtre d'analyse, quand elle est trop courte pour la note (il faut environ 6 périodes pour séparer ses harmoniques : 123 ms pour un G1) ; dans les partiels, quand plus d'un quart d'une zone est sur une autre note (d'après le suivi de la note).
- **Note de référence :** sous l'accordeur. **Auto** prend la note entendue ; sur une zone, la plus basse de ses notes nettes (corrigée par le core), pour qu'une fondamentale qui s'éteint avant ses harmoniques ne la fasse pas monter d'une octave. **Fixée** prend la note choisie (son nom, et l'octave avec − et +), accordée sur ce que l'Analyzer entend de cette note dans n'importe quelle octave : si l'Analyzer entend G2 alors que la note jouée est G1, fixe G1, et les partiels de la couche G2 deviennent 2, 4, 6… La note fixée ne dure que le temps de la visite (elle va avec un son), et ne vaut pas pour l'écoute en direct.
- **Harmoniques seulement :** en tête des partiels, activé par défaut et gardé dans `synthway.analyzer.harmonics-only.v1`. Ne garde que les partiels à moins de 30 cents d'un rapport entier, et le plus fort de chaque harmonique : dans un mix, ça écarte l'essentiel des autres instruments, et un instrument créé n'a pas deux partiels presque à la même fréquence, qui battraient. À couper pour un son inharmonique (cloche). Ne vaut pas pour l'écoute en direct.
- **Notes de la zone :** avec une zone, l'Analyzer cherche aussi les notes qui y jouent, même plusieurs à la fois (`/notes`, `synthway_analyzer_find_notes`), et les affiche en puces sous l'en-tête des partiels : la note, son temps dans la zone et sa force (estompée sous 50 % de la plus forte : une trace d'un autre son). Avec plusieurs notes fortes, un avertissement dit que l'analyse de la zone les prend pour une seule. Un clic sur une puce analyse cette note seule : la zone devient son temps, et la note de référence est fixée sur elle (avec « Harmoniques seulement », les autres notes sont écartées ; leurs harmoniques communes restent mêlées). **Toute la zone** revient à la zone d'avant et à la référence automatique ; choisir une autre zone à la main l'oublie. Garder la zone entière donne un instrument qui joue tout l'accord sur une seule touche.
- **Forme d'onde :** sous les puces, la carte « Forme d'onde » dit de quelle forme la note analysée (celle de la zone, ou celle d'une puce) est la plus proche (`/waveform-fit`, `synthway_analyzer_fit_waveform`) : dent de scie, carré, triangle, impulsion (avec son rapport cyclique) ou sinus, chacune avec le passe-bas qui lui va le mieux, et son écart moyen en dB avec les harmoniques mesurées (vert pour la plus proche). Deux repères : les harmoniques paires (présentes, affaiblies ou absentes face aux impaires voisines) et la pente en dB par octave. Un graphique montre les 32 premières harmoniques mesurées (grises : partagées avec une autre note et écartées ; pâles : pas au-dessus du fond) et, en points, la forme choisie. Une note jamais entendue seule (un accord sur sa fondamentale absente) n'a pas de forme : la carte invite à choisir une puce ; une note faible de la zone est signalée ; au-delà de 5 dB d'écart, aucune forme ne colle et les partiels mesurés restent plus fidèles. Marche aussi sur un moment (la fenêtre du curseur) et sur l'enregistrement du micro, pas en direct.
- **Essai fait de :** dans la carte, ce dont « Essayer l'instrument » fait l'instrument à l'essai : **Partiels mesurés** (par défaut, comme avant), **Forme la plus proche**, ou une forme choisie (un clic sur une forme la choisit aussi). Une forme donne ses harmoniques en sinusoïdes (jusqu'à 20 kHz sur la note analysée, 64 au plus, sans celles qui tombent 60 dB sous la plus forte à travers le passe-bas), son passe-bas dans le filtre de l'instrument (réglable ensuite dans l'Instrument Creator) et, sur une zone, l'enveloppe mesurée de son partiel le plus fort pour toutes. Changer de choix propose « Mettre à jour » ; la barre de l'essai dit la forme.
- **Partiels :** une ligne dit ce qui est analysé (le direct, l'instant et sa fenêtre, ou la zone, et la note des rapports), puis, pour chaque partiel : fréquence, note la plus proche, rapport, harmonique la plus proche avec l'écart en cents (au-delà de 30 cents : « inharmonique »), amplitude relative au plus fort.
- **Essayer l'instrument :** fait un instrument à l'essai avec les partiels affichés (leur rapport à la note et leur amplitude, en sinusoïdes), sans rien ajouter à la bibliothèque. Une barre « Instrument à l'essai » et un clavier, le même que celui de l'Instrument Creator, s'ouvrent en bas de l'écran. Le clavier part de l'octave de la note analysée, et cette note y est marquée d'un point vert : jouée, elle doit sonner comme l'original. L'instrument s'appelle comme la source et la note (« Enregistrement · A3 »), et sa description dit d'où il vient. Son volume est choisi pour que la somme des partiels ne sature pas, et son filtre est grand ouvert. Il faut une note : sans note, le bouton est grisé.
  - **Mis à jour sur demande seulement :** l'instrument à l'essai ne bouge pas quand la sélection ou un réglage change (zone, curseur, puce de note, note de référence, fenêtre, anti-bruit, harmoniques, La4). La barre le signale, et **Mettre à jour** (dans la barre, ou « Mettre à jour l'essai » en tête des partiels) le refait avec la sélection et les réglages affichés. Un volume réglé à la main dans la barre est gardé. **Revenir à sa sélection** remet la zone (ou le moment) et la note de référence d'où vient l'instrument, après un clic de trop sur la forme d'onde.
  - **Lire l'original :** lit en boucle la zone sélectionnée, comme « Lire », pour comparer. Il faut une zone.
  - **Sauvegarder** ajoute l'instrument à la bibliothèque (avec le volume et la dernière octave jouée) et l'ouvre dans l'Instrument Creator. **Abandonner** ferme l'essai. Quitter l'écran le perd aussi.
  - **Depuis une zone :** le core mesure aussi l'enveloppe de chaque partiel sur la zone (`/envelopes`, le bouton affiche « Mesure des enveloppes… ») : attaque, extinction exponentielle, maintien s'il tient, relâchement de 0,3 s au plus. Les amplitudes deviennent les pics des partiels. Pour un résultat net, la zone va de l'attaque d'une seule note jusqu'à la note suivante. Une erreur s'affiche sous le bouton (ou dans la barre de l'essai), et l'instrument à l'essai reste tel qu'il était.
  - **Depuis le curseur ou le direct :** tous les partiels ont la même enveloppe (attaque 10 ms, maintien plein, relâchement 200 ms) : le spectre mesuré, tenu.

### Decomposer

Sépare un morceau en ses pistes pour analyser un instrument sans le beat ni les autres. La séparation est faite par [Demucs v4](https://github.com/adefossez/demucs), un réseau de neurones que le serveur lance dans un processus à part (dossier `synthway-demucs/`, facultatif). Un encart « Powered by Demucs v4 » le crédite en haut de l'écran : outil tiers open source, licence MIT pour le code ; les poids pré-entraînés n'ont pas de licence claire, d'où un usage en essai local seulement (voir `synthway-demucs/README.md`).

- **Morceau :** **Importer un morceau** ou déposer un fichier WAV, FLAC, MP3 ou OGG. Il est envoyé entier au serveur. L'écran démarre vide au lancement du serveur ; le bouton **Retirer** permet de vider le morceau et ses pistes à tout moment. **Lire** joue le morceau tel qu'envoyé, à partir du curseur.
- **Modèle :** **4 pistes** (`htdemucs`, par défaut, le plus rapide), **4 pistes, affiné** (`htdemucs_ft`, un peu plus propre, environ 4 fois plus lent) ou **6 pistes** (`htdemucs_6s`, ajoute guitare et piano ; le piano déborde beaucoup). Le choix est gardé dans `synthway.decomposer.model.v1`.
- **Decompose :** lance la séparation en tâche de fond. Une barre suit l'étape (démarrage, chargement du modèle, téléchargé à sa première utilisation, lecture, séparation en %, écriture) et dit si elle tourne sur la carte graphique (CUDA) ou le processeur. **Annuler** l'arrête. Mesuré sur un morceau de 4 min 53 s avec une RTX PRO 1000 : environ 7 s de séparation, 30 à 40 s au total la première fois (téléchargement du modèle compris).
- **Pistes :** une ligne par piste, avec sa forme d'onde (les hauteurs se comparent d'une piste à l'autre). Un clic sur la forme d'onde sélectionne la piste et y place le curseur, sans la lire (ce qui jouait se met en pause) ; le bouton ▶ ou la barre d'espace la lit ou la met en pause ; une seule piste joue à la fois, dans le navigateur. Le morceau et ses pistes sont calés : un seul curseur pour tous, montré sur chaque piste (vif sur celle sélectionnée, la dernière lue), et une autre piste reprend où il est, sans revenir au début (sauf depuis la fin). La barre d'espace lit ou met en pause la piste sélectionnée (le morceau si aucune n'a été lue). Le bouton de téléchargement donne la piste en WAV stéréo 16 bits, nommée d'après le morceau. **Analyser** la charge dans l'Analyzer, à la place de son fichier, et l'ouvre sur l'onglet Fichier.
- **Sans Demucs :** si `synthway-demucs` n'est pas installé ou que le serveur le désactive (`SYNTHWAY_DEMUCS=0`), l'écran dit pourquoi et **Decompose** reste grisé.

### Jouer au clavier

- **Clavier de l'ordinateur :** par position physique des touches, en AZERTY comme en QWERTY. La rangée du milieu joue les touches blanches, celle du dessus les noires. Les deux touches à gauche de la rangée du bas (`W`/`X` en AZERTY) changent d'octave.
- **Octave :** le clavier montre deux octaves à partir du do de l'octave affichée (« Oct 4 » : de C4 à C6), de 1 à 6. Chaque instrument garde la dernière octave jouée et la retrouve quand on le rouvre (4 pour un instrument qui n'en a pas encore). Un instrument créé dans l'Analyzer part de l'octave de la note analysée : un C2 donne l'octave 2, un F4 l'octave 4. Sur un instrument verrouillé, l'octave change le temps de jouer mais n'est pas gardée.
- **Souris :** clic, ou glissé d'une touche à l'autre.
- **Polyphonie :** chaque touche est une note à part : un accord sonne en entier, et une touche enfoncée pendant que d'autres sont tenues a sa propre attaque. Relâcher une touche ne relâche qu'elle. Le clavier joue l'instrument 0 du moteur, celui que l'écran règle en direct ; l'affichage de la note montre la dernière touche enfoncée.
- **Accord nécessaire :** rien ne sonne tant que l'audio n'est pas activé par le bouton ⏻ en bas à gauche, ou dans les Réglages.

### Données enregistrées

Instruments, composition, réglages audio, apparence et réglages de l'Analyzer (source, entrée, La de référence, anti-bruit) sont gardés dans le `localStorage` du navigateur. Ils ne sont pas encore enregistrés côté serveur : changer de navigateur repart des préréglages.

---

## Style

- **Couleurs :** relevées sur le logo `assets/logo/v4.png`. Fond `#000008`, néons du rose `#ff1aa8` au bleu `#2e4dff` en passant par le magenta et le violet. Pour distinguer les partiels, s'y ajoutent le cyan, le vert, le jaune, l'orange, le rouge et le blanc (couleur du premier partiel). Toutes les couleurs sont des variables CSS dans `src/styles/theme.css`, reprises dans `src/lib/neon.ts`.
- **Ambiance :** synthwave, avec un halo dans la brume et une grille d'horizon en perspective.
- **Polices :** Michroma pour les titres, qui rappelle le mot « SYNTHWAY » du logo ; Inter pour le texte ; JetBrains Mono pour les valeurs.
- **Icônes :** Lucide, sauf les quatre de la navigation, dessinées pour Synthway dans `src/components/icons.tsx`. L'Instrument Creator est une sinusoïde sculptée en signal carré, avec une étincelle ; le Composer est un motif de piano roll ; l'Analyzer est une onde qui traverse une loupe révélant ses partiels ; le Decomposer est une onde qui se sépare en trois pistes.
- **Apparence réglable :** les lueurs et les animations se coupent dans les Réglages. Les animations se coupent aussi quand le système demande moins de mouvement.

---

## Structure

```text
synthway-ui/
├── index.html
├── vite.config.ts            # Adresse de synthway-server, polling sous WSL
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
    │   ├── api.ts            # REST, WebSocket /ws/synth et /ws/analyzer, envoi d'un fichier à analyser ou à décomposer
    │   ├── SynthServer.tsx   # Connexion au serveur, état du moteur, notes
    │   ├── appearance.tsx    # Lueurs / animations
    │   ├── instruments.ts    # Modèle (partiels), préréglages, migration des anciens instruments
    │   ├── instrumentSound.ts # Ce que le moteur joue d'un instrument, envoyé tant que l'audio est actif
    │   ├── partials.ts       # Partiels : harmoniques d'une onde, repliement, génération, envoi au moteur
    │   ├── waveShapes.ts     # Formes d'onde de l'Analyzer : niveaux, passe-bas, instrument fait d'une forme
    │   ├── composition.ts    # Modèle de composition (pistes, notes)
    │   ├── music.ts          # Notes MIDI et noms de notes, cents, formes d'onde (mêmes formules que le core)
    │   ├── neon.ts           # Couleurs d'accent et des partiels
    │   ├── storage.ts        # localStorage tolérant aux erreurs
    │   └── useElementSize.ts # Taille d'un élément, pour les graphiques en pixels
    ├── components/           # Barre latérale, contrôles, spectre, enveloppes, oscilloscope, clavier,
    │                         # accordeur, spectre mesuré, forme d'onde d'un fichier…
    └── screens/              # InstrumentCreator, Composer, Analyzer, Decomposer, Settings
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

L'interface est sur [http://localhost:5173](http://localhost:5173). Vite ne sert que la page : le navigateur appelle directement `synthway-server` (REST et WebSockets), par défaut sur `http://127.0.0.1:18741`. Le serveur l'accepte parce que la page est servie par cette machine (sa règle CORS). Quand le serveur tourne sous Windows et Vite dans WSL, aucune requête ne passe donc par WSL. Si ce port est pris par autre chose, l'interface l'indique (« Port 18741 occupé ») ; lance alors le serveur sur un autre port et indique-le à Vite :

```bash
SYNTHWAY_SERVER_URL=http://127.0.0.1:18751 npm run dev
```

Cette adresse est fixée au lancement de `npm run dev`, ou à la compilation pour `npm run build`. Les messages de l'interface (« Port … occupé », commande pour lancer le serveur) citent son port.

Sous WSL, le projet est sur le disque Windows (`/mnt/c/...`), où les modifications faites depuis Windows ne déclenchent pas d'événements de fichiers. `vite.config.ts` passe donc automatiquement en scrutation (polling), pour que le rechargement à chaud fonctionne.

Pour vérifier le code : `npm run typecheck`, puis `npm run build` (voir le skill `ui-build`).

### Sans le vrai serveur

`scripts/mock-server.mjs` imite l'API de `synthway-server` sans core et sans aucun son, et journalise tout ce que l'interface envoie. Pour l'Analyzer, il n'ouvre aucun micro et ne décode aucun fichier : un faux micro chante autour de La 3, un peu bas, avec vibrato ; un « enregistrement » ne garde que sa durée (ce même chanteur, et un WAV de silence au téléchargement) ; tout fichier WAV, FLAC ou MP3 devient une corde pincée en Sol 3 de 3 s. Pratique pour travailler sur l'UI sans risquer de jouer du son. Il écoute par défaut sur le port 18742, à côté de celui du vrai serveur (18741) mais jamais dessus : l'interface ne peut pas atteindre le vrai moteur par erreur.

```bash
npm run mock-server
SYNTHWAY_SERVER_URL=http://127.0.0.1:18742 npm run dev
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

Toutes les ressources tierces autorisent l'usage commercial (règle du skill `third-party-resources`), sauf peut-être les poids de Demucs : exception décidée par l'utilisateur pour un essai local, à revoir avant toute distribution.

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
| Demucs v4 | Séparation du Decomposer, lancée par le serveur (rien n'est livré avec l'UI) ; crédité dans l'écran | Meta Platforms, Inc. et affiliés, Alexandre Défossez | Code MIT ; poids sans licence claire, **exception d'essai local** | https://github.com/adefossez/demucs |

Les textes de licence des polices sont livrés avec elles, dans `src/assets/fonts/licenses/` (détails dans [src/assets/fonts/README.md](src/assets/fonts/README.md)). Les icônes de navigation et les illustrations (oscilloscope, enveloppe, grille) sont dessinées pour Synthway.
