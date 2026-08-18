@echo off
chcp 65001 >nul
title Power Pay AL-Ahram - مدير تشغيل المنظومة
color 0A

echo ===============================================================
echo        Power Pay AL-Ahram - مدير تشغيل المنظومة
echo ===============================================================
echo.
echo [1] Cloudflare: متوقف ولن يتم تشغيل أي tunnel خارجي.
echo [2] فتح واجهة التشغيل الرسومية...
echo [3] تشغيل السيرفر المحلي على المنفذ 3000.
echo.

start "" "%~dp0public\startup-monitor.html"

echo ===============================================================
echo        سجل التشغيل الحي
echo ===============================================================
echo.

if not exist "%~dp0node_modules\dotenv\package.json" (
    echo [تنبيه] اعتمادات التشغيل غير مكتملة. جار تثبيتها الآن...
    call npm ci --omit=dev
    if errorlevel 1 (
        echo [خطأ] فشل تثبيت اعتمادات التشغيل. راجع رسائل npm أعلاه.
        pause >nul
        exit /b 1
    )
)

node app.js

echo.
echo توقف السيرفر. اضغط أي زر لإغلاق النافذة.
pause >nul
