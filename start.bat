@echo off
chcp 65001 >nul
cd /d "%~dp0"

where python >nul 2>&1
if errorlevel 1 (
    echo.
    echo Python не найден.
    echo Установите Python 3.10+ с https://www.python.org/downloads/
    echo При установке отметьте "Add python.exe to PATH".
    echo.
    pause
    exit /b 1
)

where ffmpeg >nul 2>&1
if errorlevel 1 (
    echo.
    echo FFmpeg не найден — нужен для MP3 и M4A.
    echo Установите: winget install Gyan.FFmpeg
    echo или скачайте с https://ffmpeg.org/download.html
    echo.
)

echo Установка зависимостей (один раз)...
python -m pip install -r requirements.txt -q
if errorlevel 1 (
    echo Ошибка установки. Попробуйте: python -m pip install -r requirements.txt
    pause
    exit /b 1
)

echo Остановка старого сервера, если он ещё работает...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":5000" ^| findstr "LISTENING"') do taskkill /F /PID %%a >nul 2>&1

echo.
echo Готовые тексты сохраняются в папку results
echo Можно закрыть браузер после начала обработки — не закрывайте это окно.
echo.
echo Запуск сервера...
start "" "http://127.0.0.1:5000"
python server.py
