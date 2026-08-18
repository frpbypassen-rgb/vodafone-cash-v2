import 'dart:io';

import 'package:firebase_core/firebase_core.dart';

class AhramFirebaseOptions {
  const AhramFirebaseOptions._();

  static const _apiKey = String.fromEnvironment('FIREBASE_API_KEY');
  static const _projectId = String.fromEnvironment('FIREBASE_PROJECT_ID');
  static const _senderId = String.fromEnvironment(
    'FIREBASE_MESSAGING_SENDER_ID',
  );
  static const _commonAppId = String.fromEnvironment('FIREBASE_APP_ID');
  static const _androidAppId = String.fromEnvironment(
    'FIREBASE_ANDROID_APP_ID',
  );
  static const _iosAppId = String.fromEnvironment('FIREBASE_IOS_APP_ID');
  static const _storageBucket = String.fromEnvironment(
    'FIREBASE_STORAGE_BUCKET',
  );
  static const _iosBundleId = String.fromEnvironment(
    'FIREBASE_IOS_BUNDLE_ID',
    defaultValue: 'com.ahrampay.mobile_app',
  );

  static String get _appId {
    if (Platform.isIOS && _iosAppId.isNotEmpty) return _iosAppId;
    if (Platform.isAndroid && _androidAppId.isNotEmpty) return _androidAppId;
    return _commonAppId;
  }

  static bool get hasExplicitConfiguration =>
      _apiKey.isNotEmpty &&
      _projectId.isNotEmpty &&
      _senderId.isNotEmpty &&
      _appId.isNotEmpty;

  static bool get usesNativeAndroidConfiguration =>
      Platform.isAndroid && !hasExplicitConfiguration;

  static bool get isConfigured =>
      hasExplicitConfiguration || usesNativeAndroidConfiguration;

  static FirebaseOptions get currentPlatform => FirebaseOptions(
    apiKey: _apiKey,
    appId: _appId,
    messagingSenderId: _senderId,
    projectId: _projectId,
    storageBucket: _storageBucket.isEmpty ? null : _storageBucket,
    iosBundleId: Platform.isIOS ? _iosBundleId : null,
  );
}
