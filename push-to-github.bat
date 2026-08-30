@echo off
setlocal
cd /d "%~dp0"

echo.
echo === Times ^& Presence: aggiorna e pubblica ===
echo.

git rev-parse --is-inside-work-tree >nul 2>&1
if errorlevel 1 goto nogit

git remote get-url origin >nul 2>&1
if errorlevel 1 goto noremote

where npm >nul 2>&1
if errorlevel 1 goto nonpm

rem La ricompilazione va fatta PRIMA di "git add": native.js e' generato ma
rem finisce nel commit, quindi deve essere gia' aggiornato a questo punto.
echo [1/3] Ricompilo APK e file del sito. Puo' richiedere qualche minuto...
echo.
call npm run apk:debug
if errorlevel 1 goto apkfallita
echo.
echo    APK aggiornata: Presencer-debug.apk
echo    File del sito aggiornati.
goto pubblica

:apkfallita
echo.
echo    === APK NON compilata ===
echo    Di solito manca il JDK ^(serve dalla 17 alla 24^) o l'SDK Android.
echo    Provo ad aggiornare almeno i file del sito...
echo.
call npm run prepare:web
if errorlevel 1 goto buildfallita
echo.
echo    File del sito aggiornati. L'APK resta quella di prima.
set /p "vai=   Pubblico lo stesso solo il sito? [s/N] "
if /i not "%vai%"=="s" goto annullato
goto pubblica

:nonpm
echo    ATTENZIONE: npm non e' disponibile in questa finestra.
echo    Non posso ricompilare niente: pubblicherei i file come sono adesso.
set /p "vai=   Continuo? [s/N] "
if /i not "%vai%"=="s" goto annullato
goto pubblica

:pubblica
echo.
echo [2/3] Preparo il commit...
git add -A

git diff --cached --quiet
if %errorlevel%==0 goto nienteDaFare

set "msg=Aggiornamento %date% %time%"
git commit -m "%msg%"
if errorlevel 1 goto commitfallito

echo.
echo [3/3] Pubblico su GitHub...
git push origin main
if errorlevel 1 goto pushfallito

echo.
echo === Fatto ===
echo Il sito sara' online tra 1-2 minuti.
echo L'APK resta in questa cartella e NON viene caricata su GitHub:
echo installala dal telefono partendo da Presencer-debug.apk.
echo.
pause
exit /b 0

:nienteDaFare
echo.
echo Nessuna modifica da pubblicare: il sito online e' gia' aggiornato.
if exist "Presencer-debug.apk" echo L'APK in questa cartella e' stata comunque ricompilata.
echo.
pause
exit /b 0

:nogit
echo Questa cartella non e' un repository git. Esegui prima "git init".
pause
exit /b 1

:noremote
echo Nessun remote "origin" configurato.
echo Crea prima un repository su GitHub, poi esegui:
echo   git remote add origin https://github.com/TUO-UTENTE/TUO-REPO.git
pause
exit /b 1

:buildfallita
echo.
echo Ricompilazione non riuscita. Non pubblico niente per non mandare online
echo file a meta'. Controlla il messaggio d'errore qui sopra.
pause
exit /b 1

:commitfallito
echo Commit non riuscito.
pause
exit /b 1

:pushfallito
echo Push non riuscito. Controlla la connessione o le credenziali GitHub.
pause
exit /b 1

:annullato
echo Annullato: non ho pubblicato niente.
pause
exit /b 1
