    #!/usr/bin/env bash
    set -u

    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    cd "$SCRIPT_DIR" || exit 1

    if [ ! -f "index.html" ]; then
      echo "Fehler: Keine index.html im selben Ordner gefunden:"
      echo "  $SCRIPT_DIR"
      exit 1
    fi

    PYTHON_CMD=""

    if command -v python3 >/dev/null 2>&1; then
      PYTHON_CMD="python3"
    elif command -v python >/dev/null 2>&1; then
      PYTHON_CMD="python"
    else
      echo "Fehler: Python ist nicht installiert oder nicht im PATH verfügbar."
      echo
      echo "Bitte installiere Python 3 und starte das Script erneut."
      echo "macOS: https://www.python.org/downloads/"
      echo "Linux: meist über den Paketmanager, z. B. sudo apt install python3"
      exit 1
    fi

    PORT="$($PYTHON_CMD - <<'PY'
import socket, sys
for p in range(8000, 8101):
    with socket.socket() as s:
        try:
            s.bind(("127.0.0.1", p))
            print(p)
            sys.exit(0)
        except OSError:
            continue
print("")
PY
)"

    if [ -z "$PORT" ]; then
      echo "Fehler: Konnte keinen freien Port finden."
      exit 1
    fi

    URL="http://localhost:$PORT/index.html"

    echo "Starte lokalen Server mit: $PYTHON_CMD"
    echo "Ordner: $SCRIPT_DIR"
    echo "URL: $URL"

    "$PYTHON_CMD" -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1 &
    SERVER_PID=$!

    cleanup() {
      if kill -0 "$SERVER_PID" >/dev/null 2>&1; then
        echo
        echo "Beende lokalen Server..."
        kill "$SERVER_PID" >/dev/null 2>&1
      fi
    }
    trap cleanup EXIT INT TERM

    sleep 1

    if command -v open >/dev/null 2>&1; then
      open "$URL"
    elif command -v xdg-open >/dev/null 2>&1; then
      xdg-open "$URL" >/dev/null 2>&1
    elif command -v sensible-browser >/dev/null 2>&1; then
      sensible-browser "$URL" >/dev/null 2>&1
    else
      echo "Kein Browser-Öffner gefunden."
      echo "Bitte öffne die Seite manuell:"
      echo "  $URL"
    fi

    echo "Server läuft. Mit Ctrl+C beenden."
    wait "$SERVER_PID"
