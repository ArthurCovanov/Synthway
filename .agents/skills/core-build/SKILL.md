---
name: core-build
description: Compile synthway-core (bibliothèque partagée + CLI) sous Windows ou WSL et vérifie qu'il fonctionne. À utiliser après toute modification dans synthway-core, ou quand l'utilisateur demande de compiler, tester ou lancer le core.
---

# Compiler et vérifier synthway-core

## 1. Compiler

Les scripts sont la méthode de référence, testée sous Windows et sous WSL. Ils compilent miniaudio et RtMidi à part, dans `synthway-core/build/vendor/<plateforme>/`, et ne les recompilent que si leurs sources changent. Le reste est recompilé à chaque fois (quelques secondes). Les sorties vont dans `synthway-core/build/lib` et `synthway-core/build/bin`.

**Windows (PowerShell)**, la cible principale, depuis la racine du dépôt :

```powershell
powershell -ExecutionPolicy Bypass -File synthway-core/build.ps1
```

**Linux**, depuis la racine du dépôt :

```bash
bash synthway-core/build.sh
```

Depuis Windows, sans ouvrir de terminal WSL :

```powershell
wsl -d archlinux -e bash -c "cd /mnt/c/msys64/home/112165/workspace/synthway && bash synthway-core/build.sh"
```

Sous WSL, utilise la distribution `archlinux` (celle par défaut) : elle a `gcc`, `g++` et les en-têtes ALSA. La distribution `Debian` de l'utilisateur n'a pas encore de compilateur.

Options des scripts :
- `-Clean` (PowerShell) ou `--clean` (Bash) recompile tout, bibliothèques tierces comprises. C'est nécessaire après un changement d'options de compilation ou de bibliothèque tierce.
- `-Test` (PowerShell) ou `--test` (Bash) lance ensuite le test du son en rendu hors ligne, qui ne joue rien. Utilise-le à chaque fois.

**Autres systèmes de build**, qui suivent la même organisation :
- **`make` :** depuis un shell **MSYS2 UCRT64** sous Windows, pas depuis Git Bash ni PowerShell ; `make test` lance le test du son. Il n'est pas testé sous Linux, faute de `make` dans la distribution `archlinux`.
- **CMake :** il n'est pas installé dans MSYS2 ; `ctest` lance le test du son. Tant que GCC n'est pas réparé (voir plus bas), il faut lui passer `-DCMAKE_EXE_LINKER_FLAGS=-fno-use-linker-plugin -DCMAKE_SHARED_LINKER_FLAGS=-fno-use-linker-plugin`.

## 2. Vérifier

1. Le script se termine par `[+] Build complete!`.
2. Aucun avertissement. Le code tiers est compilé avec `-w` ; un avertissement vient donc forcément de `src/`, `examples/` ou `tests/`, et il faut le corriger.
3. Le test du son (`-Test` / `--test`) affiche `OK: 0 failure(s)`, chaque ligne étant `[PASS]`. Si une ligne est `[FAIL]`, le son produit a changé : suis le skill `sound-check`.
4. Le CLI liste les périphériques audio et les ports MIDI sans erreur :
   - Windows : `synthway-core/build/bin/synthway_cli.exe --list`, puis `--midi`
   - Linux : `synthway-core/build/bin/synthway_cli --list`, puis `--midi`
5. Windows seulement, si tu as touché aux options d'édition de liens : la DLL ne doit dépendre que de DLL système, sinon Python ne pourra pas la charger.

   ```bash
   objdump -p synthway-core/build/lib/synthway.dll | grep "DLL Name"
   ```

   Résultat attendu : `KERNEL32.dll`, `WINMM.dll` et des `api-ms-win-crt-*`, mais pas de `libstdc++`, `libgcc` ni `libwinpthread`.

Ne lance pas le CLI sans argument, ni avec `--tone` ou `--waveform`, sans l'accord de l'utilisateur : ces modes jouent du son.

## Ce qui est normal

- `MidiInWinMM::initialize: no MIDI input devices currently available.` sur stderr : c'est RtMidi qui signale qu'aucun clavier MIDI n'est branché.
- Sous Windows, la seule sortie MIDI est souvent `Microsoft GS Wavetable Synth`.
- Sous WSL, `--midi` affiche `MIDI backend unavailable` (WSL n'a pas de séquenceur ALSA), et `--list` n'affiche que « Discard all samples » (backend Null de miniaudio, faute de `libpulse`). Teste l'audio et le MIDI sous Windows.

## Problèmes connus

| Symptôme | Cause | Solution |
| --- | --- | --- |
| `'-fuse-linker-plugin', but liblto_plugin.dll not found` à l'édition de liens (Windows) | Paquet GCC de MSYS2 incomplet : `gcc.exe`, `g++.exe` et `liblto_plugin.dll` manquent | `build.ps1` et `Makefile` le contournent avec `-fno-use-linker-plugin`. Solution définitive, à faire par l'utilisateur dans MSYS2 UCRT64 : `pacman -S mingw-w64-ucrt-x86_64-gcc` |
| `make` détecte Linux sous Windows, ou ne trouve pas de fichier temporaire | `make` lancé depuis Git Bash ou PowerShell | Lance-le depuis un shell MSYS2 UCRT64, ou utilise `build.ps1` |
| `cannot open shared object file` ou DLL introuvable au lancement de Python | Le core n'est pas compilé pour cette plateforme | Compile-le sur la même plateforme que Python (Windows ou Linux) |
