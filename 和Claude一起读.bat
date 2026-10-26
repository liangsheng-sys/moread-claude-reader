@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem 伴读模式：Claude 用 Monitor 监听阅读器，「问 Claude」和主动陪读任务实时到达（见 .claude\skills\companion）
claude "/companion"
