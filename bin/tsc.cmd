@echo off
rem tsc shim shipped with the hands plugin.
rem There is no guaranteed global npm here, so look for a local typescript
rem and forward every argument unchanged.
rem Do NOT fall back to PATH: this bin dir is prepended to PATH, that would loop.
setlocal
set "TS="
if exist "%~dp0..\node_modules\typescript\bin\tsc" set "TS=%~dp0..\node_modules\typescript\bin\tsc"
if not defined TS if defined HANDS_TSC if exist "%HANDS_TSC%" set "TS=%HANDS_TSC%"
if not defined TS (
  echo tsc: typescript not found. Put it in ..\node_modules\typescript or set HANDS_TSC. 1>&2
  exit /b 127
)
node "%TS%" %*
exit /b %ERRORLEVEL%