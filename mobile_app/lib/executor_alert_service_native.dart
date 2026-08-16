import 'dart:async';
import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_background_service/flutter_background_service.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';

import 'mobile_api.dart';

const _monitorChannelId = 'executor_monitoring';
const _taskChannelId = 'executor_tasks';
const _urgentChannelId = 'executor_urgent_alerts';
const _customerChannelId = 'customer_account_alerts';
const _rateAlertChannelId = 'rate_change_alerts';
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
        autoStart: true,
        autoStartOnBoot: true,
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
    await startForStoredAccount();
  }

  Future<void> startForStoredExecutor() async {
    await startForStoredAccount();
  }

  Future<void> startForStoredAccount() async {
    await configure();
    if (kIsWeb) return;
    final session = await SessionStore().read();
    final isAccountant = session?.context['executorRole'] == 'accountant';
    final isCustomer = session?.accountType == 'client_user' ||
        session?.accountType == 'client_company' ||
        session?.accountType == 'sub_client' ||
        session?.accountType == 'agent_staff';
    final customerNotifications =
        await SessionStore().readCustomerNotificationsEnabled();
    if ((session?.accountType != 'executor' || isAccountant) &&
        (!isCustomer || !customerNotifications)) {
      return;
    }
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
  const customerChannel = AndroidNotificationChannel(
    _customerChannelId,
    'إشعارات حساب العميل',
    description: 'إشعارات الإيداع والتحويل وردود الدعم.',
    importance: Importance.high,
    playSound: true,
    enableVibration: true,
  );
  const rateAlertChannel = AndroidNotificationChannel(
    _rateAlertChannelId,
    'تنبيهات تغيّر سعر الصرف',
    description: 'تنبيهات طارئة قبل تطبيق سعر الصرف الجديد.',
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
  await android?.createNotificationChannel(customerChannel);
  await android?.createNotificationChannel(rateAlertChannel);
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

  final initialSession = await SessionStore().read();
  final customerSession = initialSession?.accountType == 'client_user' ||
      initialSession?.accountType == 'client_company' ||
      initialSession?.accountType == 'sub_client' ||
      initialSession?.accountType == 'agent_staff';
  if (service is AndroidServiceInstance) {
    service.on('stop').listen((_) => service.stopSelf());
    service.setAsForegroundService();
    service.setForegroundNotificationInfo(
      title: customerSession ? 'إشعارات الحساب تعمل' : 'مراقبة التنفيذ تعمل',
      content: customerSession
          ? 'سيصلك تنبيه بالإيداعات والعمليات الجديدة.'
          : 'سيصلك تنبيه فوري عند وصول طلب جديد.',
    );
  }

  var initialized = false;
  var appVisible = false;
  final seenTaskIds = <String>{};
  final seenCustomerNotificationIds = <String>{};

  service.on('app_visible').listen((event) {
    appVisible = event?['value'] == true;
  });

  Future<void> poll() async {
    final session = await SessionStore().read();
    final isExecutor = session?.accountType == 'executor';
    final isCustomer = session?.accountType == 'client_user' ||
        session?.accountType == 'client_company' ||
        session?.accountType == 'sub_client' ||
        session?.accountType == 'agent_staff';
    if (!isExecutor && !isCustomer) {
      service.stopSelf();
      return;
    }
    try {
      if (isCustomer) {
        final enabled = await SessionStore().readCustomerNotificationsEnabled();
        if (!enabled) {
          service.stopSelf();
          return;
        }
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
        ).get<dynamic>('/client/notifications', queryParameters: <String, dynamic>{
          'unreadOnly': 'true',
          'limit': 20,
        });
        final body = response.data is Map
            ? Map<String, dynamic>.from(response.data as Map)
            : <String, dynamic>{};
        final customerNotifications = body['notifications'] is List
            ? (body['notifications'] as List)
                .whereType<Map>()
                .map((item) => Map<String, dynamic>.from(item))
                .toList()
            : <Map<String, dynamic>>[];
        final ids = customerNotifications
            .map((item) => '${item['id'] ?? ''}')
            .where((id) => id.isNotEmpty)
            .toSet();
        final newNotifications = initialized
            ? customerNotifications
                .where((item) => !seenCustomerNotificationIds.contains('${item['id']}'))
                .toList()
            : <Map<String, dynamic>>[];
        seenCustomerNotificationIds
          ..clear()
          ..addAll(ids);
        if (!initialized) {
          initialized = true;
          // A price change may be scheduled while the app is starting. Show a
          // fresh rate notification instead of treating it as old baseline data.
          final freshRateChange = customerNotifications.where((item) {
            if ('${item['type'] ?? ''}' != 'rate_change') return false;
            final createdAt = DateTime.tryParse('${item['createdAt'] ?? ''}');
            return createdAt != null &&
                DateTime.now().difference(createdAt.toLocal()).abs() <=
                    const Duration(minutes: 2);
          }).toList();
          if (freshRateChange.isNotEmpty) {
            await _showCustomerAlert(
              notificationsPlugin: notifications,
              notification: freshRateChange.first,
            );
          }
          return;
        }
        if (newNotifications.isNotEmpty) {
          await _showCustomerAlert(
            notificationsPlugin: notifications,
            notification: newNotifications.first,
          );
        }
        return;
      }
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
  // Price changes have a 60-second activation window, so customer alerts must
  // be checked more frequently than the previous one-minute interval.
  Timer.periodic(const Duration(seconds: 15), (_) => poll());
}

Future<void> _showCustomerAlert({
  required FlutterLocalNotificationsPlugin notificationsPlugin,
  required Map<String, dynamic> notification,
}) {
  final title = '${notification['title'] ?? 'إشعار جديد'}';
  final message = '${notification['message'] ?? ''}';
  final isRateAlert = '${notification['type'] ?? ''}' == 'rate_change';
  return notificationsPlugin.show(
    id: DateTime.now().millisecondsSinceEpoch.remainder(1 << 31),
    title: title,
    body: message,
    notificationDetails: NotificationDetails(
      android: AndroidNotificationDetails(
        isRateAlert ? _rateAlertChannelId : _customerChannelId,
        isRateAlert ? 'تنبيهات تغيّر سعر الصرف' : 'إشعارات حساب العميل',
        channelDescription: isRateAlert
            ? 'تنبيهات طارئة قبل تطبيق سعر الصرف الجديد.'
            : 'إشعارات الإيداع والتحويل وردود الدعم.',
        importance: isRateAlert ? Importance.max : Importance.high,
        priority: isRateAlert ? Priority.max : Priority.high,
        playSound: true,
        enableVibration: true,
      ),
    ),
  );
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
