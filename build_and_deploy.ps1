#!/usr/bin/env powershell
# ============================================================================
# Al-Ahram Pay V3 — سكريبت PowerShell للبناء والرفع
# تشغيل: .uild_and_deploy.ps1
# ============================================================================

# ─── إعدادات الألوان ───
function Write-Color($text, $color) {
    Write-Host $text -ForegroundColor $color
}

$green = "Green"
$cyan = "Cyan"
$yellow = "Yellow"
$red = "Red"
$white = "White"

# ─── الإعدادات ───
$projectPath = "C:\Users\Administrator\Desktop\vodafone-cash-v2\vodafone-cash-v2\mobile_app"
$serverHost = "ahrampay.com"
$serverUser = "root"
$deployPath = "/var/www/ahrampay/downloads"
$apkName = "AhramPay-v3.0.0.apk"

Write-Color "═══════════════════════════════════════════════════════════════" $cyan
Write-Color "  🔨 Al-Ahram Pay V3 — بناء ورفع APK" $cyan
Write-Color "═══════════════════════════════════════════════════════════════" $cyan
Write-Color "" $white

# ─── التحقق من Flutter ───
Write-Color "🔍 التحقق من Flutter..." $yellow
$flutterPath = Get-Command flutter -ErrorAction SilentlyContinue
if (-not $flutterPath) {
    Write-Color "❌ Flutter غير موجود في PATH!" $red
    Write-Color "   جارٍ البحث في المسارات الشائعة..." $yellow
    
    $possiblePaths = @(
        "C:\flutter\bin\flutter.bat",
        "C:\Users\Administrator\flutter\bin\flutter.bat",
        "C:\tools\flutter\bin\flutter.bat",
        "C:\Program Files\flutter\bin\flutter.bat"
    )
    
    $found = $false
    foreach ($p in $possiblePaths) {
        if (Test-Path $p) {
            $env:Path += ";" + (Split-Path -Parent $p)
            Write-Color "   ✅ Flutter موجود: $p" $green
            $found = $true
            break
        }
    }
    
    if (-not $found) {
        Write-Color "" $white
        Write-Color "❌ لم يتم العثور على Flutter!" $red
        Write-Color "   1. ثبّت Flutter من: https://docs.flutter.dev/get-started/install" $yellow
        Write-Color "   2. أو أضفه للـ PATH يدوياً" $yellow
        Write-Color "" $white
        Read-Host "اضغط Enter للخروج"
        exit 1
    }
} else {
    $version = & flutter --version 2>$null | Select-Object -First 1
    Write-Color "   ✅ Flutter: $version" $green
}

# ─── التحقق من المشروع ───
Write-Color "" $white
Write-Color "🔍 التحقق من المشروع..." $yellow
if (-not (Test-Path $projectPath)) {
    Write-Color "❌ مجلد المشروع غير موجود: $projectPath" $red
    Write-Color "   جارٍ البحث..." $yellow
    
    # محاولة العثور على المجلد
    $possibleProjectPaths = @(
        "C:\Users\Administrator\Desktop\vodafone-cash-v2\vodafone-cash-v2\mobile_app",
        "C:\Users\Administrator\Desktop\vodafone-cash-v2\mobile_app",
        "$PSScriptRoot\mobile_app",
        "$PSScriptRoot\vodafone-cash-v2\mobile_app"
    )
    
    $foundProject = $false
    foreach ($p in $possibleProjectPaths) {
        if (Test-Path $p) {
            $projectPath = $p
            Write-Color "   ✅ المشروع موجود: $projectPath" $green
            $foundProject = $true
            break
        }
    }
    
    if (-not $foundProject) {
        Write-Color "" $white
        Write-Color "❌ لم يتم العثور على المشروع!" $red
        Write-Color "   جارٍ سحب المشروع من GitHub..." $yellow
        
        $clonePath = "C:\Users\Administrator\Desktop"
        Set-Location $clonePath
        git clone https://github.com/frpbypassen-rgb/vodafone-cash-v2.git 2>$null
        
        $projectPath = "$clonePath\vodafone-cash-v2\mobile_app"
        if (-not (Test-Path $projectPath)) {
            Write-Color "❌ فشل سحب المشروع!" $red
            Read-Host "اضغط Enter للخروج"
            exit 1
        }
    }
} else {
    Write-Color "   ✅ المشروع موجود: $projectPath" $green
}

# ─── بناء APK ───
Write-Color "" $white
Write-Color "═══════════════════════════════════════════════════════════════" $cyan
Write-Color "  🔨 جارٍ بناء APK..." $cyan
Write-Color "═══════════════════════════════════════════════════════════════" $cyan
Write-Color "" $white

Set-Location $projectPath

Write-Color "🧹 جارٍ التنظيف..." $yellow
& flutter clean 2>&1 | Out-Null

Write-Color "📦 جارٍ تثبيت الحزم..." $yellow
& flutter pub get 2>&1 | Out-Null

Write-Color "🔨 جارٍ بناء APK (قد يستغرق 5-10 دقائق)..." $yellow
& flutter build apk --release 2>&1 | ForEach-Object {
    if ($_ -match "error|Error|ERROR") {
        Write-Color $_ $red
    } elseif ($_ -match "Built") {
        Write-Color $_ $green
    }
}

# ─── التحقق من APK ───
$apkPath = "$projectPath\build\app\outputs\flutter-apk\app-release.apk"

if (-not (Test-Path $apkPath)) {
    # محاولة المسار البديل
    $apkPathAlt = "$projectPath\build\app\outputs\apk\release\app-release.apk"
    if (Test-Path $apkPathAlt) {
        $apkPath = $apkPathAlt
    }
}

if (Test-Path $apkPath) {
    $size = (Get-Item $apkPath).Length / 1MB
    Write-Color "" $white
    Write-Color "═══════════════════════════════════════════════════════════════" $green
    Write-Color "  ✅ APK جاهز!" $green
    Write-Color "  📦 المسار: $apkPath" $green
    Write-Color "  📊 الحجم: $($size.ToString('0.00')) MB" $green
    Write-Color "═══════════════════════════════════════════════════════════════" $green
} else {
    Write-Color "" $white
    Write-Color "❌ فشل البناء! APK غير موجود." $red
    Read-Host "اضغط Enter للخروج"
    exit 1
}

# ─── عرض أوامر الرفع ───
Write-Color "" $white
Write-Color "═══════════════════════════════════════════════════════════════" $cyan
Write-Color "  📡 أوامر رفع APK للسيرفر:" $cyan
Write-Color "═══════════════════════════════════════════════════════════════" $cyan
Write-Color "" $white

Write-Color "الطريقة 1: SCP (إذا كان SSH متاحاً):" $yellow
Write-Color "" $white
Write-Color "scp -o StrictHostKeyChecking=no `"$apkPath`" ${serverUser}@${serverHost}:${deployPath}/${apkName}" $white
Write-Color "" $white
Write-Color "ssh -o StrictHostKeyChecking=no ${serverUser}@${serverHost} `"cd ${deployPath} && ln -sf ${apkName} AhramPay-latest.apk`"" $white
Write-Color "" $white

Write-Color "الطريقة 2: WinSCP (أسهل):" $yellow
Write-Color "   Host:     $serverHost" $white
Write-Color "   Port:     22" $white
Write-Color "   Protocol: SFTP" $white
Write-Color "   User:     $serverUser" $white
Write-Color "   Path:     $deployPath" $white
Write-Color "   File:     $apkName" $white
Write-Color "" $white

Write-Color "الطريقة 3: GitHub Actions (أسهل):" $yellow
Write-Color "   https://github.com/frpbypassen-rgb/vodafone-cash-v2/actions" $white
Write-Color "   اضغط على آخر workflow ثم حمّل APK من Artifacts" $white
Write-Color "" $white

Write-Color "═══════════════════════════════════════════════════════════════" $cyan
Write-Color "  🔗 رابط التحميل النهائي:" $cyan
Write-Color "  https://${serverHost}/downloads/AhramPay-latest.apk" $cyan
Write-Color "═══════════════════════════════════════════════════════════════" $cyan

# ─── حفظ أوامر الرفع في ملف ───
$deployScriptPath = "$projectPath\..\deploy_commands.bat"
$deployCommands = @"
@echo off
chcp 65001 >nul
echo ═══════════════════════════════════════════════════════════════
echo   📡 رفع APK لـ $serverHost
echo ═══════════════════════════════════════════════════════════════
echo.
echo جارٍ الرفع...
scp -o StrictHostKeyChecking=no "$apkPath" $serverUser@$serverHost:$deployPath/$apkName
ssh -o StrictHostKeyChecking=no $serverUser@$serverHost "cd $deployPath && ln -sf $apkName AhramPay-latest.apk"
echo.
echo ✅ تم الرفع بنجاح!
echo رابط التحميل: https://$serverHost/downloads/AhramPay-latest.apk
echo.
pause
"@

$deployCommands | Out-File -FilePath $deployScriptPath -Encoding UTF8
Write-Color "" $white
Write-Color "📄 تم إنشاء ملف الرفع: $deployScriptPath" $green

# ─── نهاية ───
Write-Color "" $white
Read-Host "اضغط Enter للخروج"
