@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo === PVF Parser VSIX 打包 ===
echo.

echo [1/3] 安装依赖...
call npm install
if %errorlevel% neq 0 ( echo npm install 失败 ^& pause ^& exit /b 1 )

echo [2/3] 构建...
call npm run vscode:prepublish
if %errorlevel% neq 0 ( echo 构建失败 ^& pause ^& exit /b 1 )

echo [3/3] 打包 VSIX...
call npx @vscode/vsce package --allow-missing-repository
if %errorlevel% neq 0 ( echo 打包失败 ^& pause ^& exit /b 1 )

echo.
echo === 完成 ===
pause
