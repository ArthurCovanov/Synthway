#!/bin/sh
# Synthway launcher for Linux: ./synthway.sh, or a double-click in the file manager.
# Finds Python 3.9 or newer, then hands over to synthway.py (options passed on).
# Started outside a terminal (a double-click), it opens itself in one: to show its
# messages, and to stop Synthway with Ctrl+C or by closing the window.
cd "$(dirname "$0")" || exit 1
self="$PWD/$(basename "$0")"

if [ ! -t 1 ] && [ -z "$SYNTHWAY_TERMINAL" ] && [ -n "$DISPLAY$WAYLAND_DISPLAY" ]; then
  for terminal in x-terminal-emulator gnome-terminal konsole xfce4-terminal xterm; do
    if command -v "$terminal" >/dev/null 2>&1; then
      export SYNTHWAY_TERMINAL=1
      case $terminal in
        gnome-terminal) exec gnome-terminal -- "$self" "$@" ;;
        xfce4-terminal) exec xfce4-terminal -x "$self" "$@" ;;
        *) exec "$terminal" -e "$self" "$@" ;;
      esac
    fi
  done
fi

# Keeps the terminal opened by a double-click on an error, so that it can be read
pause() {
  if [ -n "$SYNTHWAY_TERMINAL" ]; then
    printf '[synthway] Appuyez sur Entrée pour fermer cette fenêtre.'
    read -r _
  fi
}

for python in python3 python; do
  if "$python" -c 'import sys; sys.exit(sys.version_info < (3, 9))' >/dev/null 2>&1; then
    # Ctrl+C reaches synthway.py too, which stops the server: this shell waits for it
    trap : INT
    "$python" synthway.py "$@"
    code=$?
    [ "$code" -eq 0 ] || pause
    exit "$code"
  fi
done

echo "[synthway] Python 3.9 ou plus récent est introuvable. Installez-le :"
echo "[synthway]   Debian / Ubuntu : sudo apt install python3 python3-venv"
echo "[synthway]   Fedora : sudo dnf install python3"
echo "[synthway]   Arch : sudo pacman -S python"
echo "[synthway] Puis relancez synthway.sh."
pause
exit 1
