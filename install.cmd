@echo off
rem 把 dsh-migrate 装进一个 DSH profile。
rem
rem 用法：
rem   install.cmd [profile]      :: 默认 profile 是 web
setlocal
set "DIR=%~dp0"
set "PROFILE=%~1"
if "%PROFILE%"=="" set "PROFILE=web"

where dsh >nul 2>nul
if errorlevel 1 (
  echo 找不到 dsh 命令：请先 npm i -g @deepseek-ai/dsh@^<zip 里 manifest 记录的版本^>
  exit /b 1
)

echo == 把 %DIR% 安装到 profile %PROFILE%
dsh plugin --profile %PROFILE% add "%DIR%"
if errorlevel 1 exit /b 1
echo.
echo 装好了。重启 DSH 后：
echo   - 会话里可以用「打包大肥鱼」「释放大肥鱼」
echo   - Web UI 输入框下方出现两个按钮
