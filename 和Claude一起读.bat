@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem 伴读模式：阅读器里的「问 Claude」会实时推送到会话（channels 研究预览功能）
claude --mcp-config .claude\channel.mcp.json --dangerously-load-development-channels server:moread-channel
