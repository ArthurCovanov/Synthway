@echo off
rem Synthway launcher for Windows: double-click it, or run it from a terminal.
rem Finds Python 3.9 or newer, then hands over to synthway.py (options passed on):
rem the one of the Windows package first (python\), then the installed ones.
setlocal
chcp 65001 >nul
cd /d "%~dp0"

set "PYTHON=python\python.exe"
if exist "%PYTHON%" goto run
set "PYTHON=py -3"
call :check && goto run
set "PYTHON=python"
call :check && goto run
set "PYTHON=C:\msys64\ucrt64\bin\python.exe"
call :check && goto run

echo [synthway] Python 3.9 ou plus récent est introuvable. Le plus simple : le zip Windows
echo [synthway] de la page Releases, qui l'inclut. Sinon, installez Python :
echo [synthway]   winget install Python.Python.3.13
echo [synthway] ou depuis https://www.python.org/downloads/ en cochant « Add python.exe to PATH ».
echo [synthway] Puis relancez synthway.bat.
pause
exit /b 1

:run
%PYTHON% synthway.py %*
set "CODE=%errorlevel%"
rem Keeps the window open on an error, when it was opened by a double-click
if not "%CODE%"=="0" pause
exit /b %CODE%

:check
%PYTHON% -c "import sys; sys.exit(sys.version_info < (3, 9))" >nul 2>nul
exit /b
