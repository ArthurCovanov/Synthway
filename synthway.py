#!/usr/bin/env python3
"""Synthway launcher: starts Synthway in one go and opens it in the browser.

    Windows:  double-click synthway.bat (or: python synthway.py)
    Linux:    python3 synthway.py

synthway-server serves the built interface itself: one program, one port.
In the Windows package (packaging/build_windows.py) everything is built
already and only the server starts. From the sources, each run first prepares
what is missing or out of date:
  1. synthway-core: built when its library is missing or older than its sources;
  2. the server's Python packages: this Python's if it has them, else
     synthway-server/.venv (MSYS2's Python: pacman, see the server's README);
  3. the interface: npm packages (npm ci), then built (vite build) when
     synthway-ui/dist is missing or older than its sources.
Ctrl+C, or closing the window, stops Synthway.

Standard library only: it runs before anything is installed. Starting plays
no sound: the engine only starts from the interface.
"""

import argparse
import json
import os
import shutil
import socket
import subprocess
import sys
import sysconfig
import time
import urllib.request
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CORE = ROOT / "synthway-core"
SERVER = ROOT / "synthway-server"
UI = ROOT / "synthway-ui"
UI_DIST = UI / "dist"
VENV = SERVER / ".venv"

WINDOWS = sys.platform == "win32"
MACOS = sys.platform == "darwin"
# pip cannot build pydantic-core for MSYS2's Python: pacman provides the packages
MSYS2_PYTHON = sysconfig.get_platform().startswith("mingw")

DEFAULT_PORT = 18741
STARTUP_TIMEOUT = 60  # seconds
STOP_TIMEOUT = 5

# The modules of synthway-server/requirements.txt, by import name
# (python-multipart: python_multipart, or multipart before 0.0.13)
SERVER_PACKAGES_CHECK = (
    "import importlib.util as u, sys\n"
    "found = all(u.find_spec(m) for m in ('fastapi', 'uvicorn', 'pydantic', 'websockets'))\n"
    "found = found and (u.find_spec('python_multipart') or u.find_spec('multipart'))\n"
    "sys.exit(0 if found else 1)\n"
)

# Never crash on a character the console cannot show
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(errors="replace")
    except AttributeError:
        pass


class LaunchError(Exception):
    """A step failed; the message tells the user what to do."""


def say(message):
    print(f"[synthway] {message}", flush=True)


def run(command, cwd, what, env=None):
    """Runs a preparation step in the foreground; True if it succeeded."""
    say(what)
    try:
        return subprocess.run(command, cwd=cwd, env=env).returncode == 0
    except OSError as e:
        say(f"Impossible de lancer {command[0]} : {e}")
        return False


def out_of_date(target, sources):
    """True when `target` is missing or older than a file of `sources` (files or folders)."""
    if not target.exists():
        return True
    built = target.stat().st_mtime
    for source in sources:
        if not source.exists():
            continue
        for path in (source.rglob("*") if source.is_dir() else [source]):
            if path.is_file() and path.stat().st_mtime > built:
                return True
    return False


# --------------------------------------------------------------------------
# synthway-core
# --------------------------------------------------------------------------

def core_library():
    name = "synthway.dll" if WINDOWS else "libsynthway.dylib" if MACOS else "libsynthway.so"
    return CORE / "build" / "lib" / name


def has_compiler():
    if WINDOWS:
        # build.ps1 looks in MSYS2 when the compilers are not on PATH
        msys2 = (Path(r"C:\msys64\ucrt64\bin\c++.exe"), Path(r"C:\msys64\mingw64\bin\c++.exe"))
        return any(p.exists() for p in msys2) or bool(shutil.which("g++") or shutil.which("c++"))
    return bool(shutil.which(os.environ.get("CC", "gcc")) and shutil.which(os.environ.get("CXX", "g++")))


def prepare_core():
    library = core_library()
    if not (CORE / "src").is_dir():  # the Windows package: built already
        if not library.exists():
            raise LaunchError(f"Le moteur est introuvable : {library}")
        return
    if not out_of_date(library, [CORE / "include", CORE / "src", CORE / "vendor"]):
        return
    if not has_compiler():
        if library.exists():
            say("Attention : les sources du moteur ont changé, mais aucun compilateur n'est installé : "
                "le moteur déjà compilé est utilisé.")
            return
        if WINDOWS:
            raise LaunchError(
                "Pour compiler le moteur, il faut le compilateur C/C++ de MSYS2 :\n"
                "  1. installez MSYS2 : winget install MSYS2.MSYS2 (ou https://www.msys2.org) ;\n"
                "  2. dans le terminal « MSYS2 UCRT64 » : pacman -S --needed mingw-w64-ucrt-x86_64-gcc\n"
                "Puis relancez Synthway. Sans compilateur, prenez plutôt le zip Windows de la page Releases."
            )
        if MACOS:
            raise LaunchError("Pour compiler le moteur, il faut un compilateur C/C++ : xcode-select --install")
        raise LaunchError(
            "Pour compiler le moteur, il faut gcc, g++ et les en-têtes ALSA.\n"
            "Debian / Ubuntu : sudo apt install build-essential libasound2-dev"
        )
    if WINDOWS:
        command = ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(CORE / "build.ps1")]
    else:
        command = ["bash", str(CORE / "build.sh")]
    what = "Compilation du moteur (synthway-core)..." if not library.exists() else "Recompilation du moteur (sources modifiées)..."
    if not run(command, CORE, what):
        hint = ""
        if WINDOWS and library.exists():
            hint = "\nSi un autre serveur Synthway tourne, arrêtez-le : il garde la bibliothèque ouverte."
        elif not WINDOWS and not MACOS:
            hint = "\nSous Linux, il faut aussi les en-têtes ALSA : sudo apt install libasound2-dev"
        raise LaunchError("La compilation du moteur a échoué (messages ci-dessus)." + hint)


# --------------------------------------------------------------------------
# synthway-server's Python
# --------------------------------------------------------------------------

def has_server_packages(python):
    try:
        return subprocess.run([str(python), "-c", SERVER_PACKAGES_CHECK], capture_output=True).returncode == 0
    except OSError:
        return False


def venv_python():
    for relative in ("Scripts/python.exe", "bin/python.exe", "bin/python"):
        if (VENV / relative).exists():
            return VENV / relative
    return None


def server_python():
    """This Python if it has the server's packages, else the one of synthway-server/.venv."""
    if has_server_packages(sys.executable):
        return sys.executable
    if MSYS2_PYTHON:
        raise LaunchError(
            "Il manque des paquets au Python de MSYS2 pour le serveur. Installez-les, dans le terminal « MSYS2 UCRT64 » :\n"
            "  pacman -S --needed mingw-w64-ucrt-x86_64-python-fastapi mingw-w64-ucrt-x86_64-uvicorn "
            "mingw-w64-ucrt-x86_64-python-websockets mingw-w64-ucrt-x86_64-python-python-multipart"
        )

    requirements = SERVER / "requirements.txt"
    # Copy of the requirements installed, to install again when they change
    installed = VENV / "synthway-requirements.txt"
    python = venv_python()
    if (python and installed.exists() and installed.read_bytes() == requirements.read_bytes()
            and has_server_packages(python)):
        return str(python)

    if python is None:
        if not run([sys.executable, "-m", "venv", str(VENV)], ROOT,
                   "Création de l'environnement Python du serveur (synthway-server/.venv)..."):
            raise LaunchError(
                "Impossible de créer synthway-server/.venv (messages ci-dessus)."
                + ("" if WINDOWS or MACOS else "\nDebian / Ubuntu : sudo apt install python3-venv, puis supprimez synthway-server/.venv")
            )
        python = venv_python()
        if python is None:
            raise LaunchError("synthway-server/.venv a été créé sans Python : supprimez ce dossier et relancez.")
    if not run([str(python), "-m", "pip", "install", "-r", str(requirements)], SERVER,
               "Installation des paquets Python du serveur..."):
        raise LaunchError(
            "L'installation des paquets du serveur a échoué (messages ci-dessus). Vérifiez la connexion, "
            "ou supprimez synthway-server/.venv pour repartir de zéro."
        )
    shutil.copyfile(requirements, installed)
    return str(python)


# --------------------------------------------------------------------------
# synthway-ui
# --------------------------------------------------------------------------

def find_node(required):
    """(node, npm), or (None, None) when Node.js is missing and not `required`."""
    node, npm = shutil.which("node"), shutil.which("npm")
    if not node or not npm:
        if not required:
            return None, None
        raise LaunchError(
            "Pour construire l'interface, il faut Node.js 18 ou plus récent :\n"
            + ("  winget install OpenJS.NodeJS.LTS (ou https://nodejs.org), puis rouvrez cette fenêtre.\n"
               "Sans Node.js, prenez plutôt le zip Windows de la page Releases."
               if WINDOWS else "  https://nodejs.org, ou le gestionnaire de paquets du système.")
        )
    version = subprocess.run([node, "--version"], capture_output=True, text=True).stdout.strip()
    try:
        major = int(version.lstrip("v").split(".")[0])
    except ValueError:
        major = 0
    if major < 18:
        raise LaunchError(f"Node.js {version or '?'} est trop ancien : il faut la version 18 ou plus récente (https://nodejs.org).")
    return node, npm


def ui_packages_ready():
    modules = UI / "node_modules"
    marker = modules / ".package-lock.json"  # written by npm at each install
    if not (modules / "vite" / "bin" / "vite.js").exists():
        return False
    if out_of_date(marker, [UI / "package.json", UI / "package-lock.json"]):
        return False
    # Installed by another system sharing this folder (WSL on the Windows drive, say):
    # its native esbuild does not run here
    native = modules / "@esbuild"
    system = "win32" if WINDOWS else "darwin" if MACOS else "linux"
    if native.is_dir() and not any(p.name.startswith(system + "-") for p in native.iterdir()):
        say("Attention : synthway-ui/node_modules a été installé par un autre système (WSL ?). "
            "Il est réinstallé pour celui-ci ; l'autre devra refaire « npm install » avant de relancer Vite.")
        return False
    return True


def prepare_ui():
    index = UI_DIST / "index.html"
    if not (UI / "package.json").exists():  # the Windows package: built already
        if not index.exists():
            raise LaunchError(f"L'interface est introuvable : {index}")
        return
    sources = [UI / name for name in ("src", "public", "index.html", "vite.config.ts", "package.json", "package-lock.json")]
    if not out_of_date(index, sources):
        return
    node, npm = find_node(required=not index.exists())
    if node is None:
        say("Attention : les sources de l'interface ont changé, mais Node.js n'est pas installé : "
            "l'interface déjà construite est utilisée.")
        return
    if not ui_packages_ready():
        if not run([npm, "ci", "--no-audit", "--no-fund"], UI, "Installation des paquets de l'interface (npm ci)..."):
            raise LaunchError(
                "L'installation des paquets de l'interface a échoué (messages ci-dessus). "
                "Vérifiez la connexion, ou lancez « npm install » dans synthway-ui."
            )
        (UI / "node_modules" / ".package-lock.json").touch()
    # Built without an address: the page calls the server that serves it
    env = {k: v for k, v in os.environ.items() if k.upper() != "SYNTHWAY_SERVER_URL"}
    if not run([node, str(UI / "node_modules" / "vite" / "bin" / "vite.js"), "build"], UI,
               "Construction de l'interface (vite build)...", env=env):
        raise LaunchError("La construction de l'interface a échoué (messages ci-dessus).")


# --------------------------------------------------------------------------
# The server
# --------------------------------------------------------------------------

def is_listening(port):
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.5):
            return True
    except OSError:
        return False


def synthway_answers(port):
    """True if a Synthway server answers on `port`."""
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=2) as response:
            return "core_loaded" in json.load(response)
    except (OSError, ValueError):
        return False


def stop(server, interrupted):
    if server is None or server.poll() is not None:
        return
    if interrupted:
        # Ctrl+C reached the server too: give it time to close the engine
        try:
            server.wait(timeout=STOP_TIMEOUT)
            return
        except subprocess.TimeoutExpired:
            pass
    if WINDOWS:
        # The whole tree: a venv's python.exe runs the real interpreter as its child
        subprocess.run(["taskkill", "/T", "/F", "/PID", str(server.pid)], capture_output=True)
    else:
        server.terminate()
        try:
            server.wait(timeout=STOP_TIMEOUT)
        except subprocess.TimeoutExpired:
            server.kill()
    server.wait()


def parse_args():
    parser = argparse.ArgumentParser(description="Lance Synthway et l'ouvre dans le navigateur.")
    parser.add_argument("--no-browser", action="store_true", help="ne pas ouvrir le navigateur")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"port du serveur (par défaut {DEFAULT_PORT})")
    return parser.parse_args()


def main():
    args = parse_args()
    if sys.version_info < (3, 9):
        say("Il faut Python 3.9 ou plus récent : https://www.python.org/downloads/")
        return 1
    url = f"http://127.0.0.1:{args.port}/"

    server = None
    interrupted = False
    try:
        if is_listening(args.port):
            if synthway_answers(args.port):
                say(f"Synthway tourne déjà : {url}")
                if not args.no_browser:
                    webbrowser.open(url)
                return 0
            raise LaunchError(f"Le port {args.port} est pris par un autre programme. "
                              f"Choisissez-en un autre : --port {args.port + 10}")

        prepare_core()
        python = server_python()
        prepare_ui()

        say(f"Démarrage du serveur sur le port {args.port}...")
        server = subprocess.Popen(
            [python, "-m", "uvicorn", "main:app", "--app-dir", str(SERVER / "src"),
             "--host", "127.0.0.1", "--port", str(args.port)],
            cwd=SERVER, stdin=subprocess.DEVNULL,
            env={**os.environ, "SYNTHWAY_UI_DIR": str(UI_DIST)},
        )
        deadline = time.monotonic() + STARTUP_TIMEOUT
        while not is_listening(args.port):
            if server.poll() is not None:
                raise LaunchError(f"Le serveur s'est arrêté au démarrage (code {server.returncode}) : voir ses messages ci-dessus.")
            if time.monotonic() > deadline:
                raise LaunchError(f"Le serveur ne répond toujours pas après {STARTUP_TIMEOUT} s.")
            time.sleep(0.3)

        say(f"Synthway est prêt : {url}")
        say("Activez l'audio avec le bouton marche/arrêt du clavier, en bas de l'écran.")
        say("Ctrl+C, ou fermer cette fenêtre, arrête Synthway.")
        if not args.no_browser:
            webbrowser.open(url)

        while server.poll() is None:
            time.sleep(0.5)
        say(f"Le serveur s'est arrêté (code {server.returncode}).")
        return 1
    except LaunchError as e:
        say(str(e))
        return 1
    except KeyboardInterrupt:
        interrupted = True
        say("Arrêt de Synthway...")
        return 0
    finally:
        stop(server, interrupted)


if __name__ == "__main__":
    sys.exit(main())
