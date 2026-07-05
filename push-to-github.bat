@echo off
setlocal
cd /d "%~dp0"

echo.
echo === Times ^& Presence: pubblica su GitHub (main) ===
echo.

git rev-parse --is-inside-work-tree >nul 2>&1
if errorlevel 1 (
  echo Questa cartella non e' un repository git. Esegui prima "git init".
  pause
  exit /b 1
)

git remote get-url origin >nul 2>&1
if errorlevel 1 (
  echo Nessun remote "origin" configurato.
  echo Crea prima un repository su GitHub, poi esegui:
  echo   git remote add origin https://github.com/TUO-UTENTE/TUO-REPO.git
  pause
  exit /b 1
)

git add -A

git diff --cached --quiet
if %errorlevel%==0 (
  echo Nessuna modifica da pubblicare.
  pause
  exit /b 0
)

set "msg=Aggiornamento %date% %time%"
git commit -m "%msg%"
if errorlevel 1 (
  echo Commit non riuscito.
  pause
  exit /b 1
)

git push origin main
if errorlevel 1 (
  echo Push non riuscito. Controlla la connessione o le credenziali GitHub.
  pause
  exit /b 1
)

echo.
echo Pubblicato su GitHub. Le modifiche saranno online tra 1-2 minuti.
echo.
pause
