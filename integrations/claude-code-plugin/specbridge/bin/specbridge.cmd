@echo off
rem SpecBridge CLI wrapper (Windows). Invokes the bundled CLI next to this
rem script; %~dp0 handles installation paths with spaces, %* forwards all
rem arguments, and the exit code is preserved.
node "%~dp0..\dist\cli.cjs" %*
exit /b %errorlevel%
