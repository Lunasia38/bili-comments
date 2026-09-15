如果被Window安全给防了，可以自己复制下面的代码创建一个.bat文件


@echo off
rem ============================================================
rem  Bili Comments WebUI Launcher
rem  1) cd to script dir  2) locate webui.mjs (same dir or any
rem     subfolder)  3) locate Node.js >= 18  4) start + browser
rem  Content is ASCII-only on purpose: path contains non-ASCII
rem  chars, so we always use %~dp0 instead of hardcoded paths.
rem ============================================================
setlocal EnableDelayedExpansion
cd /d "%~dp0"

set "PORT=5177"
rem 1min = 60s = 60000ms
@REM  set "HEARTBEAT_TTL_MS=9000"

rem ------------------------------------------------------------
rem  Locate webui.mjs: first next to this bat; if not there,
rem  search all subfolders (covers the bat sitting one level up,
rem  e.g. in tools\ while webui.mjs is in tools\webui\).
rem ------------------------------------------------------------
set "WEBUI="
if exist "%~dp0webui.mjs" (
    set "WEBUI=%~dp0webui.mjs"
) else (
    for /f "delims=" %%f in ('dir /b /s "%~dp0webui.mjs" 2^>nul') do (
        if not defined WEBUI set "WEBUI=%%f"
    )
)
if not defined WEBUI (
    echo [ERROR] webui.mjs was not found next to this file or in any subfolder.
    echo         Please keep the extracted folder structure intact and try again.
    pause
    exit /b 1
)
echo WebUI script: %WEBUI%

rem ------------------------------------------------------------
rem  Locate Node.js >= 18. A candidate is used only if it runs
rem  and reports a major version >= 18 (the tool needs the global
rem  fetch API). Search order:
rem
rem   1) every "node" on PATH - covers direct installs and the
rem      shims of any version manager that is currently enabled
rem      (nvm-windows / Volta / fnm / nvs / Scoop / ...)
rem   2) manager shims that may be missing from PATH:
rem        nvm-windows : %NVM_SYMLINK%\node.exe
rem        Volta       : %ProgramFiles%\Volta\node.exe, %VOLTA_HOME%\bin\node.exe
rem   3) common install dirs (direct / Chocolatey / winget / Scoop):
rem        %ProgramFiles%\nodejs, %ProgramFiles(x86)%\nodejs,
rem        %LOCALAPPDATA%\Programs\nodejs,
rem        %SCOOP%\apps\nodejs(lts)\current
rem   4) version stores of mainstream managers, newest first:
rem        nvm-windows : %NVM_HOME%\v*\node.exe          (dflt %APPDATA%\nvm)
rem        Volta       : %VOLTA_HOME%\tools\image\node\* (dflt %LOCALAPPDATA%\Volta)
rem        fnm         : %FNM_DIR%\node-versions\v*\installation\node.exe
rem                      (also %LOCALAPPDATA%\fnm and %APPDATA%\fnm)
rem        nvs         : %NVS_HOME%\node\*\x64\node.exe  (also %LOCALAPPDATA%\nvs, %APPDATA%\nvs)
rem        Scoop       : %SCOOP%\apps\nodejs\*\node.exe
rem ------------------------------------------------------------
set "NODE="

rem ---- 1) PATH (may list several node.exe; take the first >= 18) ----
for /f "delims=" %%i in ('where node 2^>nul') do call :try "%%i"

rem ---- 2) version-manager shims ----
if defined NVM_SYMLINK call :try "%NVM_SYMLINK%\node.exe"
call :try "%ProgramFiles%\Volta\node.exe"
if defined VOLTA_HOME (call :try "%VOLTA_HOME%\bin\node.exe") else (call :try "%LOCALAPPDATA%\Volta\bin\node.exe")

rem ---- 3) common install dirs ----
call :try "%ProgramFiles%\nodejs\node.exe"
call :try "%ProgramFiles(x86)%\nodejs\node.exe"
call :try "%LOCALAPPDATA%\Programs\nodejs\node.exe"
if defined SCOOP (set "SCOOPROOT=%SCOOP%") else (set "SCOOPROOT=%USERPROFILE%\scoop")
call :try "%SCOOPROOT%\apps\nodejs\current\node.exe"
call :try "%SCOOPROOT%\apps\nodejs-lts\current\node.exe"

rem ---- 4) nvm-windows version store ----
if not defined NODE (
    if defined NVM_HOME (set "R=%NVM_HOME%") else (set "R=%APPDATA%\nvm")
    for /f "delims=" %%v in ('dir /b /ad /o-n "!R!\v*" 2^>nul') do call :try "!R!\%%v\node.exe"
)

rem ---- 5) Volta runtime store ----
if not defined NODE (
    if defined VOLTA_HOME (set "R=%VOLTA_HOME%") else (set "R=%LOCALAPPDATA%\Volta")
    for /f "delims=" %%v in ('dir /b /ad /o-n "!R!\tools\image\node" 2^>nul') do call :try "!R!\tools\image\node\%%v\node.exe"
)

rem ---- 6) fnm version store (FNM_DIR, Local, Roaming) ----
if not defined NODE (
    if defined FNM_DIR call :scanfnm "%FNM_DIR%"
    call :scanfnm "%LOCALAPPDATA%\fnm"
    call :scanfnm "%APPDATA%\fnm"
)

rem ---- 7) nvs version store (NVS_HOME, Local, Roaming) ----
if not defined NODE (
    if defined NVS_HOME call :scannvs "%NVS_HOME%"
    call :scannvs "%LOCALAPPDATA%\nvs"
    call :scannvs "%APPDATA%\nvs"
)

rem ---- 8) Scoop app versions ----
if not defined NODE (
    for /f "delims=" %%v in ('dir /b /ad /o-n "%SCOOPROOT%\apps\nodejs" 2^>nul') do call :try "%SCOOPROOT%\apps\nodejs\%%v\node.exe"
)

if not defined NODE (
    echo [ERROR] Node.js 18 or newer was not found on this PC.
    echo         Install the LTS version from https://nodejs.org/
    echo         or via a version manager ^(nvm-windows / Volta / fnm / nvs / Scoop^),
    echo         then double-click this file again.
    pause
    exit /b 1
)

echo Using Node: %NODE%
"%NODE%" -v

rem ---- if service already running on PORT, just open the page ----
netstat -ano | findstr /R /C:"127\.0\.0\.1\:%PORT% .*LISTENING" >nul
if not errorlevel 1 (
    echo Service already running on port %PORT%, opening page...
    start "" "http://localhost:%PORT%/"
    exit /b 0
)

rem ---- start service in a separate minimized window ----
rem (window title = BiliCommentsWebUI; it closes automatically on clean stop)
echo Starting WebUI service on port %PORT% ...
start "BiliCommentsWebUI" /min cmd /c ""%NODE%" "%WEBUI%" %PORT% || pause"

rem ---- wait until the port is listening (max ~15s) ----
set "WAITED=0"
:waitport
netstat -ano | findstr /R /C:"127\.0\.0\.1\:%PORT% .*LISTENING" >nul
if not errorlevel 1 goto openpage
timeout /t 1 /nobreak >nul
set /a WAITED+=1
if %WAITED% lss 15 goto waitport
echo [WARN] Timeout waiting for port %PORT%, opening page anyway...

:openpage
start "" "http://localhost:%PORT%/"
echo Opened http://localhost:%PORT%/ in default browser.
echo The service runs in a minimized window; it stops automatically
echo about 90s after all WebUI pages are closed in the browser.
exit /b 0

rem ============================================================
rem  :try  %1 = candidate node.exe path
rem  Sets NODE to %1 if the file exists and runs Node >= 18.
rem  No-op once NODE has been found.
rem ============================================================
:try
if defined NODE exit /b 0
if not exist "%~1" exit /b 1
call :nodeok "%~1"
if errorlevel 1 exit /b 1
set "NODE=%~1"
exit /b 0

rem ============================================================
rem  :nodeok  %1 = full path of node.exe
rem  returns errorlevel 0 if the executable runs and reports
rem  a Node major version >= 18, non-zero otherwise
rem ============================================================
:nodeok
"%~1" -e "process.exit(Number(process.versions.node.split('.')[0]) >= 18 ? 0 : 1)" >nul 2>&1
exit /b %errorlevel%

rem ============================================================
rem  :scanfnm  %1 = fnm root dir; try each node-versions\v*\installation
rem ============================================================
:scanfnm
for /f "delims=" %%v in ('dir /b /ad /o-n "%~1\node-versions\v*" 2^>nul') do call :try "%~1\node-versions\%%v\installation\node.exe"
exit /b 0

rem ============================================================
rem  :scannvs  %1 = nvs root dir; try each node\<ver>\x64
rem ============================================================
:scannvs
for /f "delims=" %%v in ('dir /b /ad /o-n "%~1\node" 2^>nul') do call :try "%~1\node\%%v\x64\node.exe"
exit /b 0
