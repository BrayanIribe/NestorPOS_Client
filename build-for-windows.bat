@echo off
REM build-for-windows.bat — Pipeline completo del instalador Windows de NestorPOS_Client.
REM   1. go run build.go   (npm install + electron-builder NSIS, mapea la version)
REM   2. go run deploy.go  (sube el .exe al Fact — solo si el build fue OK)
REM
REM El instalador queda servido en la URL estable:
REM   https://pos-api.tecpyme.mx/downloads/latest/nestor-client-windows.exe?channel=prod
REM
REM Los flags se reenvian a AMBOS pasos para que la version/canal sean consistentes
REM entre el instalador compilado y el release publicado. Ejemplos:
REM   build-for-windows.bat                          (canal segun rama git)
REM   build-for-windows.bat --prod                   (forzar canal prod)
REM   build-for-windows.bat --version=1.7.0 --prod   (override de version)
REM
REM Requisitos: go, node/npm en PATH y NESTOR_DEPLOY_USER/PASS (en .env o el entorno).

setlocal
cd /d "%~dp0"

echo ========================================
echo  NestorPOS Client -- Build + Deploy (Windows)
echo ========================================

go run build.go %*
if errorlevel 1 (
    echo.
    echo [ERROR] build.go fallo con codigo %errorlevel%. Abortando deploy.
    exit /b %errorlevel%
)

go run deploy.go %*
if errorlevel 1 (
    echo.
    echo [ERROR] deploy.go fallo con codigo %errorlevel%.
    exit /b %errorlevel%
)

echo.
echo Listo. Instalador compilado y publicado en el Fact.
endlocal
