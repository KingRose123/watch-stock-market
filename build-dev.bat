@echo off
rem 本机调试用：起 Metro 并把调试版装到已连接的设备。
rem
rem ANDROID_HOME 未设置时按默认安装位置推断 —— 刻意不写死绝对路径，
rem 免得把本机的用户名（C:\Users\xxx\...）带进公开仓库。
if not defined ANDROID_HOME set "ANDROID_HOME=%LOCALAPPDATA%\Android\Sdk"
set "PATH=%ANDROID_HOME%\platform-tools;%PATH%"
cd /d "%~dp0"
call npm run android
