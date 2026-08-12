class ExecutorAlertService {
  ExecutorAlertService._();

  static final instance = ExecutorAlertService._();

  Future<void> configure() async {}

  Future<void> requestPermissionsAndStart() async {}

  Future<void> startForStoredExecutor() async {}

  Future<void> setAppVisible(bool visible) async {}

  Future<void> stop() async {}
}
