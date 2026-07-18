@echo off
setlocal enabledelayedexpansion

REM ==========================================================================
REM wechat-claude-code Windows daemon manager
REM Uses: PowerShell to launch background process with proper PID tracking
REM ==========================================================================

set "DATA_DIR=%USERPROFILE%\.wechat-claude-code"
set "PROJECT_DIR=%~dp0.."
set "PID_FILE=%DATA_DIR%\daemon.pid"

if "%1"=="" goto :usage
if "%1"=="start" goto :start
if "%1"=="stop" goto :stop
if "%1"=="status" goto :status
if "%1"=="logs" goto :logs
if "%1"=="restart" goto :restart
goto :usage

:start
  if not exist "%DATA_DIR%" mkdir "%DATA_DIR%"
  if exist "%PID_FILE%" (
    set /p OLD_PID=<"%PID_FILE%"
    tasklist /FI "PID eq !OLD_PID!" 2>nul | findstr /C:"!OLD_PID!" >nul
    if !errorlevel! equ 0 (
      echo Already running (PID: !OLD_PID!)
      exit /b 0
    )
    del "%PID_FILE%"
  )
  REM Use PowerShell to start node and capture the actual PID
  powershell -Command "$p = Start-Process -FilePath 'node' -ArgumentList '%PROJECT_DIR:\=\%\dist\main.js start' -WindowStyle Hidden -PassThru; Write-Output $p.Id" > "%PID_FILE%"
  set /p PID=<"%PID_FILE%"
  echo Started wechat-claude-code daemon (PID: !PID!)
  exit /b 0

:stop
  if not exist "%PID_FILE%" (
    echo Not running
    exit /b 0
  )
  set /p PID=<"%PID_FILE%"
  taskkill /T /F /PID !PID! 2>nul
  del "%PID_FILE%"
  echo Stopped (PID: !PID!)
  exit /b 0

:status
  if not exist "%PID_FILE%" (
    echo Not running
    exit /b 0
  )
  set /p PID=<"%PID_FILE%"
  tasklist /FI "PID eq !PID!" 2>nul | findstr /C:"!PID!" >nul
  if errorlevel 1 (
    echo Not running (stale PID file)
    del "%PID_FILE%"
  ) else (
    echo Running (PID: !PID!)
  )
  exit /b 0

:logs
  set "LOG_DIR=%DATA_DIR%\logs"
  if not exist "%LOG_DIR%" (
    echo No logs found
    exit /b 0
  )
  for /f %%f in ('dir /b /o-d "%LOG_DIR%\bridge-*.log" 2^>nul') do (
    type "%LOG_DIR%\%%f"
    exit /b 0
  )
  echo No bridge logs found
  exit /b 0

:restart
  call :stop
  timeout /t 2 /nobreak >nul
  call :start
  exit /b 0

:usage
  echo Usage: daemon.cmd {start^|stop^|restart^|status^|logs}
  echo Platform: Windows (PowerShell background job)
  exit /b 1
