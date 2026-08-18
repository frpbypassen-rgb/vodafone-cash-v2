import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/services.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';

import 'firebase_options.dart';
import 'mobile_api.dart';
import 'mobile_notification_catalog.dart';
import 'mobile_notification_interaction.dart';

const _notificationSettingsChannel = MethodChannel(
  'com.ahrampay.mobile_app/notification_settings',
);
const _taskActionOpen = 'executor_open';
const _taskActionSnooze = 'executor_snooze_5m';
const _urgentActionStop = 'executor_stop_alarm';

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

String _notificationIdentity(Map<String, dynamic> data) {
  return '${data['transactionId'] ?? data['ticketId'] ?? data['referenceId'] ?? data['sentAt'] ?? data['category'] ?? DateTime.now().millisecondsSinceEpoch}';
}

Future<void> _initializeFirebase() async {
  if (Firebase.apps.isNotEmpty || !AhramFirebaseOptions.isConfigured) return;
  await Firebase.initializeApp(options: AhramFirebaseOptions.currentPlatform);
}

Importance _importanceFor(MobileNotificationDefinition definition) {
  return switch (definition.priority) {
    'critical' || 'urgent' => Importance.max,
    'high' => Importance.high,
    _ => Importance.defaultImportance,
  };
}

Priority _priorityFor(MobileNotificationDefinition definition) {
  return switch (definition.priority) {
    'critical' || 'urgent' => Priority.max,
    'high' => Priority.high,
    _ => Priority.defaultPriority,
  };
}

Int64List _vibrationFor(String category) {
  if (category == 'executor_urgent_alert') {
    return Int64List.fromList(<int>[0, 700, 250, 700, 250, 1000]);
  }
  if (<String>{
    'executor_task_new',
    'executor_task_routed',
    'executor_task_reminder',
  }.contains(category)) {
    return Int64List.fromList(<int>[0, 450, 180, 450]);
  }
  return Int64List.fromList(<int>[0, 240]);
}

List<AndroidNotificationAction> _actionsFor(String category) {
  if (category == 'executor_urgent_alert') {
    return const <AndroidNotificationAction>[
      AndroidNotificationAction(
        _taskActionOpen,
        'فتح العملية',
        showsUserInterface: true,
        cancelNotification: true,
      ),
      AndroidNotificationAction(
        _urgentActionStop,
        'إيقاف الإنذار',
        cancelNotification: true,
      ),
    ];
  }
  if (<String>{
    'executor_task_new',
    'executor_task_routed',
    'executor_task_reminder',
  }.contains(category)) {
    return const <AndroidNotificationAction>[
      AndroidNotificationAction(
        _taskActionOpen,
        'فتح العملية',
        showsUserInterface: true,
        cancelNotification: true,
      ),
      AndroidNotificationAction(
        _taskActionSnooze,
        'كتم 5 دقائق',
        cancelNotification: true,
      ),
    ];
  }
  return const <AndroidNotificationAction>[
    AndroidNotificationAction(
      _taskActionOpen,
      'فتح',
      showsUserInterface: true,
      cancelNotification: true,
    ),
  ];
}

Future<void> _createChannels(
  FlutterLocalNotificationsPlugin notifications,
) async {
  final android = notifications
      .resolvePlatformSpecificImplementation<
        AndroidFlutterLocalNotificationsPlugin
      >();
  if (android == null) return;
  for (final definition in mobileNotificationDefinitions.values) {
    await android.createNotificationChannel(
      AndroidNotificationChannel(
        definition.channelId,
        definition.channelName,
        description: definition.description,
        importance: _importanceFor(definition),
        playSound: true,
        sound: RawResourceAndroidNotificationSound(definition.sound),
        enableVibration: true,
        vibrationPattern: _vibrationFor(definition.category),
        showBadge: true,
      ),
    );
  }
}

Future<FlutterLocalNotificationsPlugin> _initializeLocalNotifications({
  DidReceiveNotificationResponseCallback? onResponse,
}) async {
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
    onDidReceiveNotificationResponse: onResponse,
    onDidReceiveBackgroundNotificationResponse:
        ahramNotificationResponseBackground,
  );
  await _createChannels(notifications);
  return notifications;
}

Map<String, dynamic> _payloadData(String? payload) {
  if (payload == null || payload.isEmpty) return <String, dynamic>{};
  try {
    final value = jsonDecode(payload);
    return value is Map
        ? Map<String, dynamic>.from(value)
        : <String, dynamic>{};
  } catch (_) {
    return <String, dynamic>{};
  }
}

Future<void> _handleCancellation(
  FlutterLocalNotificationsPlugin notifications,
  Map<String, dynamic> data,
) async {
  final transactionId = '${data['transactionId'] ?? ''}'.trim();
  if (transactionId.isEmpty) return;
  await notifications.cancel(id: _notificationId(transactionId));
}

Future<void> _showRemoteNotification(
  FlutterLocalNotificationsPlugin notifications,
  Map<String, dynamic> data,
) async {
  final category = '${data['category'] ?? 'executor_task_new'}';
  final definition = notificationDefinitionFor(category);
  final title = '${data['notificationTitle'] ?? 'إشعار جديد من Ahram Pay'}';
  final body =
      '${data['notificationBody'] ?? 'افتح التطبيق لمراجعة التفاصيل.'}';
  final payload = jsonEncode(<String, dynamic>{
    ...data,
    'route': '${data['route'] ?? definition.route}',
  });
  final urgent = definition.urgent;

  await notifications.show(
    id: _notificationId(_notificationIdentity(data)),
    title: title,
    body: body,
    notificationDetails: NotificationDetails(
      android: AndroidNotificationDetails(
        definition.channelId,
        definition.channelName,
        channelDescription: definition.description,
        importance: _importanceFor(definition),
        priority: _priorityFor(definition),
        playSound: true,
        sound: RawResourceAndroidNotificationSound(definition.sound),
        enableVibration: true,
        vibrationPattern: _vibrationFor(category),
        category: urgent
            ? AndroidNotificationCategory.alarm
            : AndroidNotificationCategory.message,
        visibility: NotificationVisibility.private,
        ticker: title,
        ongoing: category == 'executor_urgent_alert',
        autoCancel: category != 'executor_urgent_alert',
        onlyAlertOnce: false,
        actions: _actionsFor(category),
      ),
      iOS: const DarwinNotificationDetails(
        presentAlert: true,
        presentBadge: true,
        presentSound: true,
      ),
    ),
    payload: payload,
  );
}

Future<void> _snoozeTask(Map<String, dynamic> data) async {
  final transactionId = '${data['transactionId'] ?? ''}'.trim();
  if (transactionId.isEmpty) return;
  try {
    final store = SessionStore();
    final installationId = await store.readOrCreatePushInstallationId();
    await MobileApi(store).snoozePushTask(
      installationId: installationId,
      transactionId: transactionId,
      minutes: 5,
    );
  } catch (_) {
    // The task remains available in the application if snoozing fails.
  }
}

Future<void> _acknowledgeTask(Map<String, dynamic> data) async {
  final transactionId = '${data['transactionId'] ?? ''}'.trim();
  if (transactionId.isEmpty) return;
  try {
    final store = SessionStore();
    final installationId = await store.readOrCreatePushInstallationId();
    await MobileApi(store).acknowledgePushTask(
      installationId: installationId,
      transactionId: transactionId,
    );
  } catch (_) {
    // A later application refresh can retry acknowledgement.
  }
}

Future<MobileNotificationInteraction?> _interactionFromResponse(
  NotificationResponse response, {
  required bool background,
}) async {
  final data = _payloadData(response.payload);
  if (data.isEmpty) return null;
  if (response.actionId == _taskActionSnooze ||
      response.actionId == _urgentActionStop) {
    await _snoozeTask(data);
    return null;
  }
  await _acknowledgeTask(data);
  final interaction = MobileNotificationInteraction(
    action: '${data['action'] ?? response.actionId ?? ''}',
    route:
        '${data['route'] ?? notificationDefinitionFor('${data['category']}').route}',
    data: data,
  );
  if (background) {
    await SessionStore().writePendingPushInteraction(interaction.encode());
  }
  return interaction;
}

@pragma('vm:entry-point')
Future<void> ahramNotificationResponseBackground(
  NotificationResponse response,
) async {
  await _interactionFromResponse(response, background: true);
}

@pragma('vm:entry-point')
Future<void> ahramFirebaseBackgroundHandler(RemoteMessage message) async {
  if (!AhramFirebaseOptions.isConfigured) return;
  await _initializeFirebase();
  final notifications = await _initializeLocalNotifications();
  final data = Map<String, dynamic>.from(message.data);
  if (data['action'] == 'cancel_executor_task_notification') {
    await _handleCancellation(notifications, data);
    return;
  }
  await _showRemoteNotification(notifications, data);
}

class MobilePushService {
  MobilePushService._();

  static final instance = MobilePushService._();

  final SessionStore _store = SessionStore();
  final StreamController<MobileNotificationInteraction> _interactions =
      StreamController<MobileNotificationInteraction>.broadcast();
  FlutterLocalNotificationsPlugin? _notifications;
  StreamSubscription<RemoteMessage>? _foregroundSubscription;
  StreamSubscription<String>? _tokenSubscription;
  StreamSubscription<RemoteMessage>? _openedSubscription;
  Timer? _registrationRetry;
  bool _configured = false;
  Future<bool>? _configureFuture;

  Stream<MobileNotificationInteraction> get interactions =>
      _interactions.stream;

  Future<FlutterLocalNotificationsPlugin> _ensureLocalNotifications() async {
    final current = _notifications;
    if (current != null) return current;
    final initialized = await _initializeLocalNotifications(
      onResponse: (response) {
        unawaited(_handleLocalResponse(response));
      },
    );
    _notifications = initialized;
    return initialized;
  }

  Future<void> _dispatchInteraction(
    MobileNotificationInteraction interaction,
  ) async {
    if (_interactions.hasListener) {
      _interactions.add(interaction);
      return;
    }
    await _store.writePendingPushInteraction(interaction.encode());
  }

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
      await _ensureLocalNotifications();
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
      _openedSubscription ??= FirebaseMessaging.onMessageOpenedApp.listen(
        (message) => unawaited(_handleOpenedMessage(message)),
      );
      final initialMessage = await FirebaseMessaging.instance
          .getInitialMessage();
      if (initialMessage != null) await _handleOpenedMessage(initialMessage);
      final launchDetails = await _notifications
          ?.getNotificationAppLaunchDetails();
      final launchResponse = launchDetails?.notificationResponse;
      if (launchDetails?.didNotificationLaunchApp == true &&
          launchResponse != null) {
        await _handleLocalResponse(launchResponse);
      }
      _configured = true;
      return true;
    } catch (_) {
      return false;
    }
  }

  Future<void> _handleForegroundMessage(RemoteMessage message) async {
    final notifications = _notifications;
    if (notifications == null) return;
    final data = Map<String, dynamic>.from(message.data);
    if (data['action'] == 'cancel_executor_task_notification') {
      await _handleCancellation(notifications, data);
      return;
    }
    await _showRemoteNotification(notifications, data);
  }

  Future<void> _handleOpenedMessage(RemoteMessage message) async {
    final data = Map<String, dynamic>.from(message.data);
    if (data['action'] == 'cancel_executor_task_notification') {
      final notifications = _notifications;
      if (notifications != null) {
        await _handleCancellation(notifications, data);
      }
      return;
    }
    await _acknowledgeTask(data);
    await _dispatchInteraction(
      MobileNotificationInteraction(
        action: '${data['action'] ?? ''}',
        route:
            '${data['route'] ?? notificationDefinitionFor('${data['category']}').route}',
        data: data,
      ),
    );
  }

  Future<void> _handleLocalResponse(NotificationResponse response) async {
    final interaction = await _interactionFromResponse(
      response,
      background: false,
    );
    if (interaction != null) await _dispatchInteraction(interaction);
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
    final notifications = await _ensureLocalNotifications();
    if (Platform.isAndroid) {
      await notifications
          .resolvePlatformSpecificImplementation<
            AndroidFlutterLocalNotificationsPlugin
          >()
          ?.requestNotificationsPermission();
    } else if (Platform.isIOS) {
      await notifications
          .resolvePlatformSpecificImplementation<
            IOSFlutterLocalNotificationsPlugin
          >()
          ?.requestPermissions(alert: true, badge: true, sound: true);
    }
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
    await registerStoredSession();
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
          defaultValue: '1.2.20+25',
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

  Future<MobileNotificationInteraction?> takePendingInteraction() async {
    return MobileNotificationInteraction.decode(
      await _store.takePendingPushInteraction(),
    );
  }

  Future<void> previewCategory(String category) async {
    final notifications = await _ensureLocalNotifications();
    final definition = notificationDefinitionFor(category);
    await _showRemoteNotification(notifications, <String, dynamic>{
      'category': category,
      'route': definition.route,
      'notificationTitle': 'معاينة ${definition.channelName}',
      'notificationBody': 'هذه هي نغمة وتنبيه هذه القناة.',
      'sentAt': DateTime.now().toIso8601String(),
      'action': 'push_test',
    });
  }

  Future<void> openNotificationSettings() async {
    try {
      await _notificationSettingsChannel.invokeMethod<void>('open');
    } catch (_) {
      // The settings page still explains how to enable notifications manually.
    }
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
