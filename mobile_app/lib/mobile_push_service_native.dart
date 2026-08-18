import 'dart:async';
import 'dart:io';

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';

import 'firebase_options.dart';
import 'mobile_api.dart';

const _executorTaskChannelId = 'executor_tasks';
const _executorTaskChannelName = 'طلبات التنفيذ الجديدة';

bool _backgroundHandlerRegistered = false;

void registerMobilePushBackgroundHandler() {
  if (_backgroundHandlerRegistered || !AhramFirebaseOptions.isConfigured) {
    return;
  }
  FirebaseMessaging.onBackgroundMessage(ahramFirebaseBackgroundHandler);
  _backgroundHandlerRegistered = true;
}

int _notificationId(String value) {
  var hash = 17;
  for (final unit in value.codeUnits) {
    hash = ((hash * 31) + unit) & 0x7fffffff;
  }
  return hash == 0 ? 7201 : hash;
}

Future<void> _initializeFirebase() async {
  if (Firebase.apps.isNotEmpty || !AhramFirebaseOptions.isConfigured) return;
  await Firebase.initializeApp(options: AhramFirebaseOptions.currentPlatform);
}

Future<FlutterLocalNotificationsPlugin> _initializeLocalNotifications() async {
  final notifications = FlutterLocalNotificationsPlugin();
  await notifications.initialize(
    settings: const InitializationSettings(
      android: AndroidInitializationSettings('@mipmap/ic_launcher'),
      iOS: DarwinInitializationSettings(
        requestAlertPermission: false,
        requestBadgePermission: false,
        requestSoundPermission: false,
      ),
    ),
  );
  const channel = AndroidNotificationChannel(
    _executorTaskChannelId,
    _executorTaskChannelName,
    description: 'تنبيهات فورية ومتكررة للعمليات التي تنتظر التنفيذ.',
    importance: Importance.max,
    playSound: true,
    enableVibration: true,
  );
  final android = notifications
      .resolvePlatformSpecificImplementation<
        AndroidFlutterLocalNotificationsPlugin
      >();
  await android?.createNotificationChannel(channel);
  return notifications;
}

Future<void> _handleCancellation(
  FlutterLocalNotificationsPlugin notifications,
  Map<String, dynamic> data,
) async {
  final transactionId = '${data['transactionId'] ?? ''}'.trim();
  if (transactionId.isEmpty) return;
  await notifications.cancel(id: _notificationId(transactionId));
}

@pragma('vm:entry-point')
Future<void> ahramFirebaseBackgroundHandler(RemoteMessage message) async {
  if (!AhramFirebaseOptions.isConfigured) return;
  await _initializeFirebase();
  if (message.data['action'] != 'cancel_executor_task_notification') return;
  final notifications = await _initializeLocalNotifications();
  await _handleCancellation(notifications, message.data);
}

class MobilePushService {
  MobilePushService._();

  static final instance = MobilePushService._();

  final SessionStore _store = SessionStore();
  FlutterLocalNotificationsPlugin? _notifications;
  StreamSubscription<RemoteMessage>? _foregroundSubscription;
  StreamSubscription<String>? _tokenSubscription;
  Timer? _registrationRetry;
  bool _configured = false;
  Future<bool>? _configureFuture;

  Future<bool> configure() {
    if (_configured) return Future<bool>.value(true);
    if (!AhramFirebaseOptions.isConfigured) return Future<bool>.value(false);
    return _configureFuture ??= _configure().whenComplete(() {
      _configureFuture = null;
    });
  }

  Future<bool> _configure() async {
    try {
      registerMobilePushBackgroundHandler();
      await _initializeFirebase();
      _notifications = await _initializeLocalNotifications();
      await FirebaseMessaging.instance
          .setForegroundNotificationPresentationOptions(
            alert: false,
            badge: true,
            sound: false,
          );
      _foregroundSubscription ??= FirebaseMessaging.onMessage.listen(
        _handleForegroundMessage,
      );
      _tokenSubscription ??= FirebaseMessaging.instance.onTokenRefresh.listen(
        (_) => registerStoredSession(),
      );
      FirebaseMessaging.onMessageOpenedApp.listen(
        (message) => unawaited(_handleOpenedMessage(message)),
      );
      final initialMessage = await FirebaseMessaging.instance
          .getInitialMessage();
      if (initialMessage != null) await _handleOpenedMessage(initialMessage);
      _configured = true;
      return true;
    } catch (_) {
      return false;
    }
  }

  Future<void> _handleForegroundMessage(RemoteMessage message) async {
    final notifications = _notifications;
    if (notifications == null) return;
    if (message.data['action'] == 'cancel_executor_task_notification') {
      await _handleCancellation(notifications, message.data);
      return;
    }
    unawaited(_acknowledgeTask('${message.data['transactionId'] ?? ''}'));

    final title = message.notification?.title ?? 'وصل طلب تنفيذ جديد';
    final body = message.notification?.body ?? 'افتح التطبيق لمراجعة العملية.';
    final transactionId =
        '${message.data['transactionId'] ?? message.messageId ?? ''}';
    await notifications.show(
      id: _notificationId(transactionId),
      title: title,
      body: body,
      notificationDetails: const NotificationDetails(
        android: AndroidNotificationDetails(
          _executorTaskChannelId,
          _executorTaskChannelName,
          channelDescription:
              'تنبيهات فورية ومتكررة للعمليات التي تنتظر التنفيذ.',
          importance: Importance.max,
          priority: Priority.max,
          playSound: true,
          enableVibration: true,
          category: AndroidNotificationCategory.alarm,
        ),
        iOS: DarwinNotificationDetails(
          presentAlert: true,
          presentBadge: true,
          presentSound: true,
        ),
      ),
      payload: transactionId,
    );
  }

  Future<void> _handleOpenedMessage(RemoteMessage message) async {
    if (message.data['action'] == 'cancel_executor_task_notification') {
      final notifications = _notifications;
      if (notifications != null) {
        await _handleCancellation(notifications, message.data);
      }
      return;
    }
    await _acknowledgeTask('${message.data['transactionId'] ?? ''}');
  }

  Future<void> _acknowledgeTask(String transactionId) async {
    final taskId = transactionId.trim();
    if (taskId.isEmpty) return;
    try {
      final installationId = await _store.readOrCreatePushInstallationId();
      await MobileApi(_store).acknowledgePushTask(
        installationId: installationId,
        transactionId: taskId,
      );
    } catch (_) {
      // A later reminder or application refresh can retry acknowledgement.
    }
  }

  String _permissionName(AuthorizationStatus status) {
    return switch (status) {
      AuthorizationStatus.authorized => 'authorized',
      AuthorizationStatus.provisional => 'provisional',
      AuthorizationStatus.denied => 'denied',
      AuthorizationStatus.notDetermined => 'not_determined',
    };
  }

  Future<void> requestPermissionAndRegister() async {
    if (!await configure()) return;
    await FirebaseMessaging.instance.requestPermission(
      alert: true,
      announcement: false,
      badge: true,
      carPlay: false,
      criticalAlert: false,
      provisional: false,
      sound: true,
    );
    unawaited(registerStoredSession());
  }

  Future<void> registerStoredSession() async {
    if (!await configure()) return;
    final session = await _store.read();
    if (session == null) return;
    final supported = <String>{
      'executor',
      'client_user',
      'client_company',
      'sub_client',
      'agent_staff',
    };
    if (!supported.contains(session.accountType)) return;

    final settings = await FirebaseMessaging.instance.getNotificationSettings();
    final permissionStatus = _permissionName(settings.authorizationStatus);
    if (permissionStatus == 'denied') return;
    final token = await FirebaseMessaging.instance.getToken();
    if (token == null || token.isEmpty) {
      _scheduleRegistrationRetry();
      return;
    }

    try {
      final installationId = await _store.readOrCreatePushInstallationId();
      await MobileApi(_store).registerPushDevice(
        installationId: installationId,
        token: token,
        platform: Platform.isIOS ? 'ios' : 'android',
        permissionStatus: permissionStatus,
        appVersion: const String.fromEnvironment(
          'APP_VERSION',
          defaultValue: '1.2.19+24',
        ),
        deviceName: Platform.operatingSystemVersion,
        locale: Platform.localeName,
        timeZone: DateTime.now().timeZoneName,
      );
      _registrationRetry?.cancel();
      _registrationRetry = null;
    } catch (_) {
      _scheduleRegistrationRetry();
    }
  }

  void _scheduleRegistrationRetry() {
    if (_registrationRetry?.isActive ?? false) return;
    _registrationRetry = Timer(const Duration(minutes: 2), () {
      _registrationRetry = null;
      registerStoredSession();
    });
  }

  Future<void> unregisterCurrentSession() async {
    _registrationRetry?.cancel();
    _registrationRetry = null;
    final session = await _store.read();
    if (session == null) return;
    try {
      final installationId = await _store.readOrCreatePushInstallationId();
      await MobileApi(_store)
          .unregisterPushDevice(installationId)
          .timeout(const Duration(seconds: 6));
    } catch (_) {
      // The expired token is deactivated automatically after an FCM failure.
    }
    if (_configured) {
      try {
        await FirebaseMessaging.instance.deleteToken();
      } catch (_) {
        // Server-side invalid-token handling remains the final cleanup path.
      }
    }
  }
}
