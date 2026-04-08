\
    @echo off
    setlocal EnableExtensions EnableDelayedExpansion

    cd /d "%~dp0"

    if not exist "3dmm-editor.html" (
        echo Fehler: Keine index.html im selben Ordner gefunden:
        echo   %cd%
        pause
        exit /b 1
    )

    set "PYTHON_CMD="

    where py >nul 2>nul
    if %errorlevel%==0 (
        set "PYTHON_CMD=py -3"
        goto python_found
    )

    where python >nul 2>nul
    if %errorlevel%==0 (
        set "PYTHON_CMD=python"
        goto python_found
    )

    where python3 >nul 2>nul
    if %errorlevel%==0 (
        set "PYTHON_CMD=python3"
        goto python_found
    )

    echo Fehler: Python ist nicht installiert oder nicht im PATH verfuegbar.
    echo.
    echo Bitte installiere Python 3 und starte die Datei erneut.
    echo Download: https://www.python.org/downloads/windows/
    pause
    exit /b 1

    :python_found

    for /f %%p in ('%PYTHON_CMD% -c "import socket, sys
for p in range(8000, 8101):
    import socket as s
    s1=s.socket()
    try:
        s1.bind((''127.0.0.1'', p))
        print(p)
        s1.close()
        sys.exit(0)
    except OSError:
        s1.close()
print()"
    "') do set "PORT=%%p"

    if not defined PORT (
        echo Fehler: Konnte keinen freien Port zwischen 8000 und 8100 finden.
        pause
        exit /b 1
    )

    set "URL=http://localhost:%PORT%/3dmm-editor.html"

    echo Starte lokalen Server mit: %PYTHON_CMD%
    echo Ordner: %cd%
    echo URL: %URL%

    start "Python Local Server" cmd /c "%PYTHON_CMD% -m http.server %PORT% --bind 127.0.0.1"

    timeout /t 2 /nobreak >nul

    start "" "%URL%"

    echo.
    echo Der Browser wurde geoeffnet.
    echo Der Python-Server laeuft in einem separaten Fenster.
    echo Dieses Fenster kann jetzt geschlossen werden.
    exit /b 0
