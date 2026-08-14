import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

enum AppLanguageMode { system, arabic, english }

class LanguageController extends ChangeNotifier {
  static const _storageKey = 'ahram_pay_app_language_v1';

  LanguageController({FlutterSecureStorage? storage})
    : _storage = storage ?? const FlutterSecureStorage();

  final FlutterSecureStorage _storage;
  AppLanguageMode _mode = AppLanguageMode.system;

  AppLanguageMode get mode => _mode;
  Locale? get locale => switch (_mode) {
    AppLanguageMode.system => null,
    AppLanguageMode.arabic => const Locale('ar'),
    AppLanguageMode.english => const Locale('en'),
  };

  Future<void> restore() async {
    final stored = await _storage.read(key: _storageKey);
    _mode = switch (stored) {
      'ar' => AppLanguageMode.arabic,
      'en' => AppLanguageMode.english,
      _ => AppLanguageMode.system,
    };
    notifyListeners();
  }

  Future<void> setMode(AppLanguageMode value) async {
    if (_mode == value) return;
    _mode = value;
    notifyListeners();
    await _storage.write(
      key: _storageKey,
      value: switch (value) {
        AppLanguageMode.system => 'system',
        AppLanguageMode.arabic => 'ar',
        AppLanguageMode.english => 'en',
      },
    );
  }
}
