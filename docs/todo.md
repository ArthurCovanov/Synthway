# À faire

Ce qui est prévu sans être commencé. Une ligne par sujet ; on la retire quand le travail est fait (le journal, `docs/journal.md`, garde la trace de qui l'a fait).

## Analyzer

- **Importer des sons mono dans l'onglet Fichier.** L'onglet Fichier travaille en stéréo, le Micro en mono ; il faut que l'application accepte aussi un fichier mono. Demandé par l'utilisateur le 31/10/2026.
- **Une enveloppe par partiel pour les instruments créés depuis l'Analyzer.** Aujourd'hui, tous leurs partiels ont la même enveloppe. Il faudra suivre le niveau de chaque partiel sur la zone (attaque, maintien, extinction), et pour bien rendre les sons qui s'éteignent (piano, cloche), une extinction exponentielle dans le moteur. Remis à plus tard par l'utilisateur le 31/10/2026.
- **Les partiels qui glissent ou ne durent que l'attaque.** Dans la basse de « Chasing Shadows » (40,0 à 40,5 s), le sub en G1 est fort au début de chaque note (−4 dB) mais glisse d'environ 60 Hz à 49 Hz en quelques dizaines de millisecondes (glissando de hauteur, ou grosse caisse jouée avec chaque note) : ni la médiane d'une zone ni « harmoniques seulement » ne le gardent. Il faudra un partiel avec sa propre enveloppe de hauteur, mesurée sur une seule note, avec l'enveloppe par partiel.
- **Mesurer l'énergie d'un partiel plutôt que la hauteur de son pic.** Un vibrato large étale les harmoniques aiguës dans une fenêtre longue : leur pic baisse, et leur amplitude est sous-estimée (vu à ±20 cents sur 170 ms : l'harmonique 6 lue vers 0,13 au lieu de 0,17). Sommer la puissance sur le lobe du pic corrigerait. Une fenêtre plus courte limite déjà l'effet.
