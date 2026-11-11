@echo off
rem Runs bulkcheck.ps1 with Windows PowerShell. Usage: bulkcheck A B [options]
rem Example: bulkcheck "C:\Release 2.3" "C:\Release 2.4" -Html report.html
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0bulkcheck.ps1" %*
exit /b %ERRORLEVEL%
