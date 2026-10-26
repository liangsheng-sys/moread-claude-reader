@echo off
chcp 65001 >nul
cd /d "%~dp0"
node scripts\launch.mjs
timeout /t 3 >nul
