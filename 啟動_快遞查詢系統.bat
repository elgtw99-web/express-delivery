@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo   快遞物流狀態查詢系統
echo ============================================
echo.

REM 檢查是否安裝 Python
python --version >nul 2>&1
if errorlevel 1 (
  echo [錯誤] 找不到 Python。
  echo 請先到 https://www.python.org/downloads/ 下載安裝，
  echo 安裝時務必勾選「Add Python to PATH」，再重新執行本檔。
  echo.
  pause
  exit /b
)

echo 正在檢查/安裝必要套件（第一次會比較久）...
python -m pip install -r requirements.txt >nul 2>&1

echo.
echo 啟動中，瀏覽器將自動開啟 http://127.0.0.1:5000
echo 若沒自動開啟，請手動在瀏覽器輸入該網址。
echo 【關閉這個黑色視窗即停止服務】
echo.
start "" http://127.0.0.1:5000
python app.py
pause
