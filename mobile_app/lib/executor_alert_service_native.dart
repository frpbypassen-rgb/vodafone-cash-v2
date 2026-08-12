import 'dart:async';
import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_background_service/flutter_background_service.dart';
import 'package:flutter_background_service_android/flutter_background_service_android.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';

import 'mobile_api.dart';

const _monitorChannelId = 'executor_monitoring';
const _taskChannelId = 'executor_tasks';
const _urgentChannelId = 'executor_urgent_alerts';
const _monitorNotificationId = 7100;
const _apiBaseUrl = String.fromEnvironment(
  'API_BASE_URL',
  defaultValue: 'https://ahrampay.com/api/mobile',
);

class ExecutorAlertService {
  ExecutorAlertService._();

  static final instance = ExecutorAlertService._();

  final FlutterLocalNotificationsPlugin _notifications =
      FlutterLocalNotificationsPlugin();
  bool _configured = false;

  Future<void> configure() async {
    if (kIsWeb || _configured) return;
    const initialization = InitializationSettings(
      android: AndroidInitializationSettings('@mipmap/ic_launcher'),
      iOS: DarwinInitializationSettings(
        requestAlertPermission: false,
        requestBadgePermission: false,
        requestSoundPermission: false,
      ),
    );
    await _notifications.initialize(settings: initialization);
    await _createChannels(_notifications);
    await FlutterBackgroundService().configure(
      androidConfiguration: AndroidConfiguration(
        onStart: executorAlertBackgroundEntry,
        autoStart: false,
        autoStartOnBoot: false,
        isForegroundMode: true,
        notificationChannelId: _monitorChannelId,
        initialNotificationTitle: 'مراقبة التنفيذ تعمل',
        initialNotificationContent: 'يتم فحص طلبات التنفيذ الجديدة.',
        foregroundServiceNotificationId: _monitorNotificationId,
        foregroundServiceTypes: const [AndroidForegroundType.dataSync],
      ),
      iosConfiguration: IosConfiguration(
        autoStart: false,
        onForeground: executorAlertBackgroundEntry,
      ),
    );
    _configured = true;
  }

  Future<void> requestPermissionsAndStart() async {
    await configure();
    if (kIsWeb) return;
    final android = _notifications
        .resolvePlatformSpecificImplementation<
          AndroidFlutterLocalNotificationsPlugin
        >();
    await android?.requestNotificationsPermission();
    final ios = _notifications
        .resolvePlatformSpecificImplementation<
          IOSFlutterLocalNotificationsPlugin
        >();
    await ios?.requestPermissions(alert: true, badge: true, sound: true);
    await startForStoredExecutor();
  }

  Future<void> startForStoredExecutor() async {
    await configure();
    if (kIsWeb) return;
    final session = await SessionStore().read();
    final isAccountant = session?.context['executorRole'] == 'accountant';
    if (session?.accountType != 'executor' || isAccountant) return;
    final service = FlutterBackgroundService();
    if (!await service.isRunning()) {
      await service.startService();
    }
  }

  Future<void> setAppVisible(bool visible) async {
    if (kIsWeb) return;
    FlutterBackgroundService().invoke('app_visible', {'value': visible});
  }

  Future<void> stop() async {
    if (kIsWeb) return;
    FlutterBackgroundService().invoke('stop');
  }
}

Future<void> _createChannels(
  FlutterLocalNotificationsPlugin notifications,
) async {
  const monitorChannel = AndroidNotificationChannel(
    _monitorChannelId,
    'مراقبة المنفذ',
    description: 'تشغيل مراقبة طلبات التنفيذ في الخلفية.',
    importance: Importance.low,
    playSound: false,
  );
  const taskChannel = AndroidNotificationChannel(
    _taskChannelId,
    'طلبات التنفيذ الجديدة',
    description: 'تنبيهات وصول طلبات التنفيذ الجديدة.',
    importance: Importance.max,
    playSound: true,
    enableVibration: true,
  );
  const urgentChannel = AndroidNotificationChannel(
    _urgentChannelId,
    'إنذارات الاستعجال',
    description:
        'تنبيه مرتفع الأولوية للطلبات العاجلة التي تحتاج تدخلاً فورياً.',
    importance: Importance.max,
    playSound: true,
    enableVibration: true,
  );
  final android = notifications
      .resolvePlatformSpecificImplementation<
        AndroidFlutterLocalNotificationsPlugin
      >();
  await android?.createNotificationChannel(monitorChannel);
  await android?.createNotificationChannel(taskChannel);
  await android?.createNotificationChannel(urgentChannel);
}

@pragma('vm:entry-point')
void executorAlertBackgroundEntry(ServiceInstance service) async {
  final notifications = FlutterLocalNotificationsPlugin();
  await notifications.initialize(
    settings: const InitializationSettings(
      android: AndroidInitializationSettings('@mipmap/ic_launcher'),
    ),
  );
  await _createChannels(notifications);

  if (service is AndroidServiceInstance) {
    service.on('stop').listen((_) => service.stopSelf());
    service.setAsForegroundService();
    service.setForegroundNotificationInfo(
      title: 'مراقبة التنفيذ تعمل',
      content: 'سيصلك تنبيه فوري عند وصول طلب جديد.',
    );
  }

  var initialized = false;
  var appVisible = false;
  final seenTaskIds = <String>{};

  service.on('app_visible').listen((event) {
    appVisible = event?['value'] == true;
  });

  Future<void> poll() async {
    final session = await SessionStore().read();
    if (session?.accountType != 'executor') {
      service.stopSelf();
      return;
    }
    try {
      final response = await Dio(
        BaseOptions(
          baseUrl: _apiBaseUrl,
          connectTimeout: const Duration(seconds: 20),
          receiveTimeout: const Duration(seconds: 30),
          headers: <String, dynamic>{
            'Accept': 'application/json',
            'Authorization': 'Bearer ${session!.token}',
          },
        ),
      ).get<dynamic>('/executor/live-tasks');
      final body = response.data is Map
          ? Map<String, dynamic>.from(response.data as Map)
          : <String, dynamic>{};
      final rawTasks = body['data'];
      final tasks = rawTasks is List
          ? rawTasks
                .whereType<Map>()
                .map((item) => Map<String, dynamic>.from(item))
                .toList()
          : <Map<String, dynamic>>[];
      final rawAlerts = body['alerts'];
      final urgentAlerts = rawAlerts is List
          ? rawAlerts
                .whereType<Map>()
                .map((item) => Map<String, dynamic>.from(item))
                .toList()
          : <Map<String, dynamic>>[];
      final openTasks = tasks.where((task) {
        final status = '${task['status'] ?? ''}';
        return status == 'processing' || status == 'accepted';
      }).toList();
      final taskIds = openTasks
          .map((task) => '${task['id'] ?? ''}')
          .where((id) => id.isNotEmpty)
          .toSet();
      final newTasks = initialized
          ? openTasks
                .where((task) => !seenTaskIds.contains('${task['id']}'))
                .toList()
          : <Map<String, dynamic>>[];
      seenTaskIds
        ..clear()
        ..addAll(taskIds);
      if (!initialized) {
        initialized = true;
        if (!appVisible && urgentAlerts.isNotEmpty) {
          await _showUrgentAlert(notifications, urgentAlerts.first);
        }
        return;
      }
      if (appVisible) return;
      if (urgentAlerts.isNotEmpty) {
        await _showUrgentAlert(notifications, urgentAlerts.first);
      } else if (newTasks.isNotEmpty) {
        await _showTaskAlert(notifications, newTasks.first, reminder: false);
      } else if (openTasks.isNotEmpty) {
        await _showTaskAlert(notifications, openTasks.first, reminder: true);
      }
    } catch (_) {
      // The next scheduled check reconnects after temporary network failures.
    }
  }

  await poll();
  Timer.periodic(const Duration(minutes: 1), (_) => poll());
}

Future<void> _showUrgentAlert(
  FlutterLocalNotificationsPlugin notifications,
  Map<String, dynamic> task,
) {
  final phone = '${task['recipientNumber'] ?? '-'}';
  final message = '${task['emergencyAlert'] ?? 'طلب يحتاج إلى تدخل عاجل'}';
  return notifications.show(
    id: DateTime.now().millisecondsSinceEpoch.remainder(1 << 31),
    title: 'إنذار استعجال - تدخل مطلوب',
    body: '$message | رقم العميل: $phone',
    notificationDetails: const NotificationDetails(
      android: AndroidNotificationDetails(
        _urgentChannelId,
        'إنذارات الاستعجال',
        channelDescription:
            'تنبيه مرتفع الأولوية للطلبات العاجلة التي تحتاج تدخلاً فورياً.',
        importance: Importance.max,
        priority: Priority.max,
        playSound: true,
        enableVibration: true,
      ),
    ),
  );
}

Future<void> _showTaskAlert(
  FlutterLocalNotificationsPlugin notifications,
  Map<String, dynamic> task, {
  required bool reminder,
}) {
  final phone = '${task['recipientNumber'] ?? '-'}';
  final amount = '${task['amount'] ?? '-'}';
  return notifications.show(
    id: DateTime.now().millisecondsSinceEpoch.remainder(1 << 31),
    title: reminder ? 'يوجد طلب تنفيذ بانتظارك' : 'وصل طلب تنفيذ جديد',
    body: 'رقم العميل: $phone | القيمة: $amount ج.م',
    notificationDetails: const NotificationDetails(
      android: AndroidNotificationDetails(
        _taskChannelId,
        'طلبات التنفيذ الجديدة',
        channelDescription: 'تنبيهات وصول طلبات التنفيذ الجديدة.',
        importance: Importance.max,
        priority: Priority.high,
        playSound: true,
        enableVibration: true,
      ),
    ),
  );
}
