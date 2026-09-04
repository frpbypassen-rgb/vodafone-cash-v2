param(
  [string]$ApiBaseUrl = 'https://ahrampay.com/api/mobile'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not $env:GRADLE_USER_HOME) {
  $env:GRADLE_USER_HOME = Join-Path $env:USERPROFILE '.gradle'
}

$keyProps = Join-Path $root 'android\key.properties'
$keystore = Join-Path $root 'android\app\upload-keystore.jks'
if (-not (Test-Path $keyProps) -or -not (Test-Path $keystore)) {
  throw 'Missing android/key.properties or android/app/upload-keystore.jks. Generate the upload key locally before building release.'
}

flutter pub get
flutter test test/workspace_kind_test.dart test/agent_workspace_test.dart test/company_gallery_test.dart test/customer_wallet_test.dart test/smart_transfer_parser_test.dart test/executor_workspace_test.dart test/executor_reports_ui_test.dart test/executor_task_privacy_ui_test.dart test/executor_employees_ui_test.dart

flutter build apk --release --dart-define=API_BASE_URL=$ApiBaseUrl

$apk = Join-Path $root 'build\app\outputs\flutter-apk\app-release.apk'
if (-not (Test-Path $apk)) {
  throw "Release APK was not produced at $apk"
}

$releases = Join-Path (Split-Path -Parent $root) 'releases'
New-Item -ItemType Directory -Force -Path $releases | Out-Null
$version = (Select-String -Path (Join-Path $root 'pubspec.yaml') -Pattern '^version:\s*(.+)$').Matches[0].Groups[1].Value.Trim()
$target = Join-Path $releases "ahrampay-$version.apk"
Copy-Item -Force $apk $target
Write-Host "Release APK copied to $target"
