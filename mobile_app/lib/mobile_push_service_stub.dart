void registerMobilePushBackgroundHandler() {}

class MobilePushService {
  MobilePushService._();

  static final instance = MobilePushService._();

  Future<bool> configure() async => false;

  Future<void> requestPermissionAndRegister() async {}

  Future<void> registerStoredSession() async {}

  Future<void> unregisterCurrentSession() async {}
}
