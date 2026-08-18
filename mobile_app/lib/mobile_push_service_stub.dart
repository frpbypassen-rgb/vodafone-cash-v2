import 'dart:async';

import 'mobile_notification_interaction.dart';

void registerMobilePushBackgroundHandler() {}

class MobilePushService {
  MobilePushService._();

  static final instance = MobilePushService._();

  Stream<MobileNotificationInteraction> get interactions =>
      const Stream<MobileNotificationInteraction>.empty();

  Future<bool> configure() async => false;

  Future<Map<String, dynamic>> localDiagnostics() async => <String, dynamic>{
    'clientConfigured': false,
    'permissionEnabled': false,
    'platform': 'web',
  };

  Future<void> requestPermissionAndRegister() async {}

  Future<void> registerStoredSession() async {}

  Future<MobileNotificationInteraction?> takePendingInteraction() async => null;

  Future<void> previewCategory(String category) async {}

  Future<void> openNotificationSettings() async {}

  Future<void> openBackgroundSettings() async {}

  Future<void> unregisterCurrentSession() async {}
}
