@echo off
rem Builds all of dist\ in one go: double-click it, or run it from a terminal.
rem   1. the interface (synthway-ui\dist): npm run build, through WSL when Node.js is not
rem      installed on Windows (WSL's default distribution, or the one given: build_windows.bat Debian);
rem   2. packaging\build_windows.py: the engine when its sources changed, then the package
rem      (dist\Synthway-<version>-windows-x64) and its zip.
rem Synthway launched from the sources (synthway.bat at the root) gets the new version too.
setlocal
chcp 65001 >nul
cd /d "%~dp0.."

where node >nul 2>nul && goto python
set "DISTRO="
if not "%~1"=="" set "DISTRO=-d %~1"
echo [package] Construction de l'interface dans WSL (npm run build)...
wsl %DISTRO% --cd "%CD%\synthway-ui" -- npm run build
rem Not "if errorlevel 1": wsl's own errors (unknown distribution...) give negative codes
if "%errorlevel%"=="0" goto python
echo.
echo [package] La construction de l'interface a échoué : voir les messages ci-dessus.
echo [package] Il faut WSL, avec Node.js 18 ou plus récent et les paquets de l'interface
echo [package] installés dans cette distribution (npm install, dans synthway-ui).
goto failed

:python
rem A Windows Python with pip: pip fetches the server's packages for the embedded Python
set "PYTHON=py -3"
call :check && goto build
set "PYTHON=python"
call :check && goto build
set "PYTHON=C:\msys64\ucrt64\bin\python.exe"
call :check && goto build
echo [package] Il faut un Python 3.9 ou plus récent pour Windows, avec pip : celui de MSYS2,
echo [package] ou celui de python.org (winget install Python.Python.3.13).
goto failed

:build
%PYTHON% packaging\build_windows.py
if not "%errorlevel%"=="0" goto failed
echo.
echo [package] Terminé : le dossier du paquet et son zip sont dans dist\.
pause
exit /b 0

:failed
echo.
echo [package] Échec : voir les messages ci-dessus.
pause
exit /b 1

:check
%PYTHON% -c "import sys, pip; sys.exit(sys.version_info < (3, 9))" >nul 2>nul
exit /b
