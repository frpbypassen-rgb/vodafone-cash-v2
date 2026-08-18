# Ahram Pay Mobile

## Firebase push configuration

The APK initializes Firebase from compile-time values. It does not store the
server service-account key. Obtain the Android application values for
`com.ahrampay.mobile_app` from Firebase and build with:

```powershell
flutter build apk --release `
  --dart-define=API_BASE_URL=https://ahrampay.com/api/mobile `
  --dart-define=FIREBASE_API_KEY=... `
  --dart-define=FIREBASE_PROJECT_ID=... `
  --dart-define=FIREBASE_MESSAGING_SENDER_ID=... `
  --dart-define=FIREBASE_ANDROID_APP_ID=... `
  --dart-define=FIREBASE_STORAGE_BUCKET=...
```

The production server separately requires `FCM_ENABLED=true` and either
`FIREBASE_SERVICE_ACCOUNT_BASE64` or the three service-account fields listed
in the root `.env.example`. Never put the service-account JSON or private key
inside the APK or Git.

If Firebase values are omitted, the application still starts and retains the
existing polling notification fallback, but closed-app push delivery remains
disabled.
