---
name: ui-build
description: Vérifie les types, compile et prévisualise synthway-ui (React + Vite), sans jouer de son. À utiliser après toute modification dans synthway-ui, ou quand l'utilisateur demande de lancer, tester ou montrer l'interface.
---

# Vérifier et prévisualiser synthway-ui

Node n'est pas installé sous Windows : tout passe par WSL.
- **Distribution `archlinux` :** a Node et npm ; c'est elle qui sert aux vérifications.
- **Distribution `Debian` :** l'utilisateur y lance `npm run dev`, sur le port 5173.
- **`node_modules` :** les deux distributions partagent le même dossier.

## 1. Vérifier et compiler

Depuis Windows, sur une seule ligne :

```powershell
wsl -d archlinux -e bash -c "cd /mnt/c/msys64/home/112165/workspace/synthway/synthway-ui && npm run typecheck && SYNTHWAY_SERVER_URL=http://127.0.0.1:18742 node node_modules/vite/bin/vite.js build --outDir /tmp/synthway-ui-dist --emptyOutDir"
```

- `npm run typecheck` ne doit afficher aucune erreur.
- `SYNTHWAY_SERVER_URL` pointe vers le serveur factice de l'étape 2. Il est lu à la compilation : la page compilée appelle directement cette adresse depuis le navigateur.
- Le build doit se terminer par `✓ built`. Il écrit dans `/tmp` de WSL, donc rien n'est ajouté au dépôt.
- Ne lance pas `npm install` pendant que l'utilisateur fait tourner `npm run dev` : ça change les `node_modules` qu'il utilise. Demande-lui d'abord. Une nouvelle dépendance passe par le skill `third-party-resources`.

## 2. Prévisualiser sans son

Pour tester l'interface connectée, utilise le serveur factice `scripts/mock-server.mjs`. Il imite l'API de synthway-server, ne joue aucun son et journalise ce que l'interface envoie. Il écoute sur 18742, jamais sur 18741, le port du vrai serveur : si l'utilisateur fait tourner synthway-server, l'aperçu ne peut pas l'atteindre par erreur.

Lance ces deux commandes en arrière-plan :

```powershell
wsl -d archlinux -e bash -c "cd /mnt/c/msys64/home/112165/workspace/synthway/synthway-ui && node scripts/mock-server.mjs 18742"
```

```powershell
wsl -d archlinux -e bash -c "cd /mnt/c/msys64/home/112165/workspace/synthway/synthway-ui && node node_modules/vite/bin/vite.js preview --outDir /tmp/synthway-ui-dist --port 4174 --strictPort --host 127.0.0.1"
```

Si le serveur factice refuse de démarrer parce que le port est pris, n'en change pas pour 18741.

Puis ouvre http://localhost:4174. N'utilise jamais le port 5173 : c'est celui de l'utilisateur.

Vérifie :
1. La console du navigateur ne montre aucune erreur.
2. Les trois écrans s'ouvrent depuis la barre latérale.
3. Le point d'état en bas de la barre latérale est vert ; dans les Réglages, « Server connected » (« Serveur connecté » en français).
4. L'interface s'ouvre en anglais, la langue par défaut. Dans les Réglages, carte « Language », « Français » passe tout en français, et « English » revient à l'anglais. Un texte ajouté ou modifié se vérifie dans les deux langues ; une clé qui affiche son nom (`composer.xxx`) au lieu d'un texte manque dans les fichiers de langue.
5. Après « Enable audio » (« Activer l’audio »), le journal du serveur factice montre `POST /api/engine/start`, puis `POST /api/synth/tone` avec `"enabled":false`. Une touche du clavier envoie `note_on`, et son relâchement `note_off`.

Après un nouveau build, recharge vraiment la page : changer seulement l'ancre de l'URL (`#/composer`) ne recharge rien.

## 3. Arrêter

```powershell
wsl -d archlinux -e pkill -f "[v]ite.js preview|[m]ock-server.mjs"
```

Les crochets empêchent `pkill` de reconnaître, et donc de tuer, son propre shell.

## Son

Face au vrai synthway-server lancé sous Windows, « Enable audio » (« Activer l’audio »), le clavier et les notes posées dans le Composer jouent du son sur la sortie de l'utilisateur. Ne les déclenche pas sans son accord ; utilise le serveur factice.
