#!/usr/bin/env python3
"""Builds the Windows package of Synthway: a zip that runs without installing anything.

    python packaging/build_windows.py

or double-click packaging/build_windows.bat, which builds the interface
first (through WSL when Node.js is not installed on Windows).

The zip holds synthway-core already compiled, the interface already built,
python.org's embeddable Python with the server's packages, the launcher
(synthway.bat, synthway.py) and every licence. Whoever downloads it unzips it
and double-clicks synthway.bat.

Needs, on the Windows machine that builds it: what synthway.py needs to build
from the sources (MSYS2's compiler, Node.js), a Python with pip, and an
internet connection (embeddable Python, the server's packages). Without
Node.js on Windows, build the interface beforehand wherever Node.js is
(`npm ci`, then `npm run build` in synthway-ui, from WSL for instance): an up
to date synthway-ui/dist and node_modules (for the licences) are enough.

Output, in dist/ (ignored by git): Synthway-<version>-windows-x64.zip, and the
folder it was made from.
"""

import hashlib
import json
import shutil
import subprocess
import sys
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import synthway as launcher  # noqa: E402  (the same preparation as a launch from the sources)

# python.org's embeddable package; SHA-256 from python.org's release files
# (https://www.python.org/api/v2/downloads/release_file/?release=<id>)
PYTHON_VERSION = "3.14.10"
PYTHON_SHA256 = "90905e64a840557d8c1bc4f5b74db3d7ee85e3ffb217611cac1c7813acea4159"
PYTHON_URL = f"https://www.python.org/ftp/python/{PYTHON_VERSION}/python-{PYTHON_VERSION}-embed-amd64.zip"
PYTHON_TAG = "cp" + "".join(PYTHON_VERSION.split(".")[:2])  # cp314

DIST = ROOT / "dist"
CACHE = DIST / "cache"

READ_ME = """\
Synthway {version} pour Windows
================================

Lancer Synthway : double-cliquez sur synthway.bat.

Une fenêtre s'ouvre, puis Synthway s'affiche dans le navigateur
(http://127.0.0.1:18741). Activez l'audio avec le bouton marche/arrêt du
clavier, en bas de l'écran. Pour quitter : fermez la fenêtre, ou Ctrl+C.

Rien n'est installé sur l'ordinateur : tout est dans ce dossier, Python
compris. Pour désinstaller, supprimez le dossier. Vos instruments et vos
morceaux restent dans le navigateur.

Si Windows demande une confirmation au premier lancement (« Windows a protégé
votre ordinateur »), cliquez sur « Informations complémentaires », puis
« Exécuter quand même ».

Le Decomposer (séparation des pistes d'un morceau) n'est pas inclus : il
demande PyTorch, environ 3 Go. Voir le dépôt du projet pour l'installer.

Licence : Apache 2.0 (LICENSE). Les composants tiers gardent la leur : voir
le dossier licences.
"""

LICENCES_READ_ME = """\
Composants tiers inclus dans Synthway pour Windows
==================================================

Synthway lui-même : Apache 2.0, voir LICENSE à la racine.

Moteur audio (synthway-core\\build\\lib\\synthway.dll), qui contient :
  - miniaudio : domaine public ou MIT No Attribution, au choix (moteur\\miniaudio.txt)
  - RtMidi : licence de type MIT (moteur\\rtmidi-LICENSE)
  - libogg : BSD-3-Clause, (c) Xiph.Org Foundation (moteur\\libogg-COPYING)
  - libvorbis : BSD-3-Clause, (c) Xiph.Org Foundation (moteur\\libvorbis-COPYING)
  - les bibliothèques d'exécution de GCC (libgcc, libstdc++, winpthreads),
    sous licence GPL avec l'exception GCC Runtime Library, ou licence MIT
    (winpthreads) : leur usage dans un programme compilé n'impose rien.

Python {python} (python\\) : Python Software Foundation License, et les
bibliothèques qu'il inclut : python\\LICENSE.txt.

Paquets Python du serveur (python\\Lib\\site-packages) : la licence de chacun
est dans son dossier *.dist-info. Tous sous licences permissives (MIT, BSD,
Apache 2.0, PSF).

Interface (synthway-ui\\dist) :
  - paquets npm intégrés : interface\\<paquet>\\ ({npm})
  - polices Michroma, Inter et JetBrains Mono : SIL Open Font License 1.1
    (polices\\)
"""


class PackageError(Exception):
    pass


def say(message):
    print(f"[package] {message}", flush=True)


def version():
    return json.loads((launcher.UI / "package.json").read_text(encoding="utf-8"))["version"]


def check_prepared():
    """Builds synthway-core and the interface like a launch does, then checks they are up to date."""
    launcher.prepare_core()
    library = launcher.core_library()
    if launcher.out_of_date(library, [launcher.CORE / name for name in ("include", "src", "vendor")]):
        raise PackageError(f"{library} est plus ancien que ses sources : compilez le moteur (build.ps1).")
    launcher.prepare_ui()
    index = launcher.UI_DIST / "index.html"
    ui_sources = [launcher.UI / name for name in
                  ("src", "public", "index.html", "vite.config.ts", "package.json", "package-lock.json")]
    if launcher.out_of_date(index, ui_sources):
        raise PackageError("synthway-ui/dist est plus ancien que ses sources : lancez « npm run build » dans synthway-ui.")
    # The page must call the server that serves it: no address built in
    bundle = "".join(p.read_text(encoding="utf-8", errors="replace") for p in (launcher.UI_DIST / "assets").glob("*.js"))
    if "127.0.0.1:18741" in bundle or "127.0.0.1:18742" in bundle:
        raise PackageError("synthway-ui/dist a été construit avec SYNTHWAY_SERVER_URL : reconstruisez-le sans.")
    check_dll_imports(library)


def check_dll_imports(library):
    """The DLL must load on any Windows: no MSYS2 runtime DLL among its imports."""
    objdump = shutil.which("objdump") or r"C:\msys64\ucrt64\bin\objdump.exe"
    if not Path(objdump).exists():
        say("objdump introuvable : dépendances de la DLL non vérifiées.")
        return
    dump = subprocess.run([objdump, "-p", str(library)], capture_output=True, text=True).stdout
    names = sorted({line.split(":", 1)[1].strip() for line in dump.splitlines() if "DLL Name:" in line})
    foreign = [n for n in names if n.lower().startswith(("lib", "msys-"))]
    if foreign:
        raise PackageError(f"synthway.dll dépend de DLL de MSYS2 ({', '.join(foreign)}) : elle ne tournerait pas ailleurs.")
    say(f"synthway.dll n'importe que des DLL de Windows : {', '.join(names)}")


def embedded_python(target):
    """Unzips python.org's embeddable Python into `target`, with the server's packages."""
    CACHE.mkdir(parents=True, exist_ok=True)
    archive = CACHE / Path(PYTHON_URL).name
    if not archive.exists():
        say(f"Téléchargement de {PYTHON_URL}...")
        with urllib.request.urlopen(PYTHON_URL, timeout=60) as response:
            archive.write_bytes(response.read())
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    if digest != PYTHON_SHA256:
        archive.unlink()
        raise PackageError(f"Somme SHA-256 inattendue pour {archive.name} : {digest}")
    with zipfile.ZipFile(archive) as zf:
        zf.extractall(target)

    # The embeddable Python only looks where its ._pth file says: add site-packages
    site_packages = target / "Lib" / "site-packages"
    site_packages.mkdir(parents=True)
    pth = next(target.glob("python*._pth"))
    pth.write_text(pth.read_text(encoding="utf-8").rstrip("\n") + "\nLib\\site-packages\n", encoding="utf-8")

    say(f"Installation des paquets du serveur pour Python {PYTHON_VERSION}...")
    command = [sys.executable, "-m", "pip", "install", "--disable-pip-version-check", "--no-compile",
               "--only-binary=:all:", "--platform", "win_amd64", "--implementation", "cp",
               "--python-version", PYTHON_VERSION.rsplit(".", 1)[0], "--abi", PYTHON_TAG,
               "--target", str(site_packages), "-r", str(launcher.SERVER / "requirements.txt")]
    if subprocess.run(command).returncode != 0:
        raise PackageError("pip n'a pas pu installer les paquets du serveur (messages ci-dessus).")
    shutil.rmtree(site_packages / "bin", ignore_errors=True)  # console scripts: not used


def npm_runtime_packages():
    """The npm packages built into the interface: package.json's dependencies, and theirs."""
    modules = launcher.UI / "node_modules"
    todo = list(json.loads((launcher.UI / "package.json").read_text(encoding="utf-8")).get("dependencies", {}))
    seen = set()
    while todo:
        name = todo.pop()
        if name in seen:
            continue
        seen.add(name)
        manifest = modules / name / "package.json"
        if not manifest.exists():
            raise PackageError(f"{manifest} introuvable : lancez « npm ci » dans synthway-ui.")
        todo += list(json.loads(manifest.read_text(encoding="utf-8")).get("dependencies", {}))
    return sorted(seen)


def licences(target):
    engine = target / "moteur"
    engine.mkdir(parents=True)
    vendor = launcher.CORE / "vendor"
    header = (vendor / "miniaudio" / "miniaudio.h").read_text(encoding="utf-8").splitlines()
    start = next(i for i, line in enumerate(header) if line.startswith("This software is available as a choice"))
    (engine / "miniaudio.txt").write_text("\n".join(header[start:]).rstrip(" */\n") + "\n", encoding="utf-8")
    shutil.copyfile(vendor / "rtmidi" / "LICENSE", engine / "rtmidi-LICENSE")
    shutil.copyfile(vendor / "libogg" / "COPYING", engine / "libogg-COPYING")
    shutil.copyfile(vendor / "libvorbis" / "COPYING", engine / "libvorbis-COPYING")

    shutil.copytree(launcher.UI / "src" / "assets" / "fonts" / "licenses", target / "polices")

    packages = npm_runtime_packages()
    for name in packages:
        folder = launcher.UI / "node_modules" / name
        files = [p for p in folder.iterdir() if p.is_file() and p.name.upper().startswith(("LICENSE", "LICENCE", "COPYING"))]
        if not files:
            raise PackageError(f"Pas de fichier de licence dans {folder}")
        for path in files:
            destination = target / "interface" / name / path.name
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, destination)

    text = LICENCES_READ_ME.format(python=PYTHON_VERSION, npm=", ".join(packages))
    (target / "LISEZ-MOI.txt").write_bytes(text.replace("\n", "\r\n").encode("utf-8"))


def assemble(folder):
    if folder.exists():
        try:
            shutil.rmtree(folder)
        except OSError as e:
            raise PackageError(f"Impossible de remplacer {folder} ({e.strerror}) : "
                               "si Synthway tourne depuis ce dossier, fermez-le, puis relancez.")
    folder.mkdir(parents=True)
    for name in ("synthway.bat", "synthway.py", "LICENSE"):
        shutil.copyfile(ROOT / name, folder / name)
    (folder / "LISEZ-MOI.txt").write_bytes(READ_ME.format(version=version()).replace("\n", "\r\n").encode("utf-8"))

    library = launcher.core_library()
    (folder / "synthway-core" / "build" / "lib").mkdir(parents=True)
    shutil.copyfile(library, folder / "synthway-core" / "build" / "lib" / library.name)
    (folder / "synthway-server" / "src").mkdir(parents=True)
    for source in (launcher.SERVER / "src").glob("*.py"):
        shutil.copyfile(source, folder / "synthway-server" / "src" / source.name)
    shutil.copytree(launcher.UI_DIST, folder / "synthway-ui" / "dist")

    embedded_python(folder / "python")
    licences(folder / "licences")


def make_zip(folder, archive):
    if archive.exists():
        archive.unlink()
    top = f"Synthway-{version()}"
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for path in sorted(folder.rglob("*")):
            if path.is_file() and "__pycache__" not in path.parts:
                zf.write(path, f"{top}/{path.relative_to(folder).as_posix()}")


def main():
    if not launcher.WINDOWS:
        say("Le paquet Windows se construit sous Windows (la DLL du moteur en vient).")
        return 1
    try:
        check_prepared()
        name = f"Synthway-{version()}-windows-x64"
        folder = DIST / name
        assemble(folder)
        archive = DIST / f"{name}.zip"
        make_zip(folder, archive)
    except (PackageError, launcher.LaunchError) as e:
        say(str(e))
        return 1
    say(f"Paquet prêt : {archive} ({archive.stat().st_size / 1e6:.1f} Mo)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
