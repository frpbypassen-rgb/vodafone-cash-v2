// ============================================================================
// Al-Ahram Pay V3 — Notification Hub
// نظام إشعارات متكامل: FCM + Local + Socket.IO
// ============================================================================

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';

// ═════════════════════════════════════════════════════════════════════════════
// نموذج الإشعار
// ═════════════════════════════════════════════════════════════════════════════

class AhramNotification {
  final String? id;
  final String type;
  final String title;
  final String body;
  final String priority; // high, normal, low
  final String? imageUrl;
  final Map<String, dynamic>? payload;
  final DateTime timestamp;
  final bool isRead;

  const AhramNotification({
    this.id,
    required this.type,
    required this.title,
    required this.body,
    this.priority = 'normal',
    this.imageUrl,
    this.payload,
    required this.timestamp,
    this.isRead = false,
  });

  factory AhramNotification.fromRemoteMessage(RemoteMessage message) {
    return AhramNotification(
      id: message.messageId ?? '${DateTime.now().millisecondsSinceEpoch}',
      type: message.data['type'] ?? 'general',
      title: message.notification?.title ??
          message.data['title'] ??
          'Al-Ahram Pay',
      body: message.notification?.body ?? message.data['body'] ?? '',
      priority: message.data['priority'] ?? 'normal',
      imageUrl: message.notification?.android?.imageUrl,
      payload: message.data,
      timestamp: DateTime.now(),
    );
  }

  factory AhramNotification.fromJson(Map<String, dynamic> json) {
    return AhramNotification(
      id: json['id'] as String?,
      type: json['type'] as String? ?? 'general',
      title: json['title'] as String? ?? '',
      body: json['body'] as String? ?? '',
      priority: json['priority'] as String? ?? 'normal',
      imageUrl: json['imageUrl'] as String?,
      payload: json['payload'] as Map<String, dynamic>?,
      timestamp: DateTime.parse(json['timestamp'] as String),
      isRead: json['isRead'] as bool? ?? false,
    );
  }

  Map<String, dynamic> toJson() => {
    'id': id,
    'type': type,
    'title': title,
    'body': body,
    'priority': priority,
    'imageUrl': imageUrl,
    'payload': payload,
    'timestamp': timestamp.toIso8601String(),
    'isRead': isRead,
  };

  AhramNotification copyWith({bool? isRead}) => AhramNotification(
    id: id,
    type: type,
    title: title,
    body: body,
    priority: priority,
    imageUrl: imageUrl,
    payload: payload,
    timestamp: timestamp,
    isRead: isRead ?? this.isRead,
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// أنواع الإشعارات
// ═════════════════════════════════════════════════════════════════════════════

abstract final class NotificationTypes {
  static const String transaction = 'transaction';
  static const String rateAlert = 'rate_alert';
  static const String executorTask = 'executor_task';
  static const String supportReply = 'support_reply';
  static const String security = 'security';
  static const String deposit = 'deposit';
  static const String system = 'system';
  static const String general = 'general';

  static bool isUrgent(String type) =>
      type == executorTask || type == security;

  static bool isFinancial(String type) =>
      type == transaction || type == deposit;
}

// ═════════════════════════════════════════════════════════════════════════════
// Hub الرئيسي للإشعارات
// ═════════════════════════════════════════════════════════════════════════════

class AhramNotificationHub {
  static final AhramNotificationHub _instance = AhramNotificationHub._internal();
  factory AhramNotificationHub() => _instance;
  AhramNotificationHub._internal();

  final FlutterLocalNotificationsPlugin _localNotifications =
      FlutterLocalNotificationsPlugin();

  final StreamController<AhramNotification> _notificationStream =
      StreamController<AhramNotification>.broadcast();

  Stream<AhramNotification> get notificationStream => _notificationStream.stream;

  final List<AhramNotification> _inbox = [];
  List<AhramNotification> get inbox => List.unmodifiable(_inbox);

  int get unreadCount => _inbox.where((n) => !n.isRead).length;

  bool _initialized = false;
  bool get isInitialized => _initialized;

  // ───────────────────────────────────────────────────────────────────────────
  // التهيئة
  // ───────────────────────────────────────────────────────────────────────────

  Future<void> initialize({
    required Future<void> Function(String? token) onTokenRefresh,
    required Future<void> Function(AhramNotification notification)
        onNotificationTap,
  }) async {
    if (_initialized) return;

    try {
      // 1. تهيئة Firebase
      await Firebase.initializeApp();

      // 2. طلب الإذن
      await _requestPermissions();

      // 3. تهيئة الإشعارات المحلية
      await _initializeLocalNotifications(onNotificationTap);

      // 4. الاستماع للتوكن
      FirebaseMessaging.instance.onTokenRefresh.listen((token) {
        debugPrint('🔄 FCM Token refreshed: ${token.substring(0, 20)}...');
        onTokenRefresh(token);
      });

      final token = await FirebaseMessaging.instance.getToken();
      if (token != null) await onTokenRefresh(token);

      // 5. إعداد الـ handlers
      FirebaseMessaging.onBackgroundMessage(_firebaseBackgroundHandler);
      FirebaseMessaging.onMessage.listen(_handleForegroundMessage);
      FirebaseMessaging.onMessageOpenedApp.listen((message) {
        final notification = AhramNotification.fromRemoteMessage(message);
        onNotificationTap(notification);
      });

      // 6. التحقق من الإشعار الذي فتح التطبيق
      final initialMessage =
          await FirebaseMessaging.instance.getInitialMessage();
      if (initialMessage != null) {
        final notification = AhramNotification.fromRemoteMessage(initialMessage);
        onNotificationTap(notification);
      }

      _initialized = true;
      debugPrint('✅ AhramNotificationHub initialized successfully');
    } catch (e) {
      debugPrint('❌ Failed to initialize NotificationHub: $e');
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // طلب الإذن
  // ───────────────────────────────────────────────────────────────────────────

  Future<void> _requestPermissions() async {
    if (Platform.isIOS) {
      await FirebaseMessaging.instance.requestPermission(
        alert: true,
        badge: true,
        sound: true,
        provisional: false,
        announcement: false,
        carPlay: false,
        criticalAlert: false,
      );
      await FirebaseMessaging.instance.setForegroundNotificationPresentationOptions(
        alert: true,
        badge: true,
        sound: true,
      );
    } else if (Platform.isAndroid) {
      // Android 13+ requires explicit permission
      final AndroidFlutterLocalNotificationsPlugin? androidImplementation =
          _localNotifications.resolvePlatformSpecificImplementation<
              AndroidFlutterLocalNotificationsPlugin>();
      await androidImplementation?.requestNotificationsPermission();
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // تهيئة الإشعارات المحلية
  // ───────────────────────────────────────────────────────────────────────────

  Future<void> _initializeLocalNotifications(
    Future<void> Function(AhramNotification) onTap,
  ) async {
    const androidSettings = AndroidInitializationSettings('@drawable/app_logo');
    const darwinSettings = DarwinInitializationSettings(
      requestAlertPermission: false,
      requestBadgePermission: false,
      requestSoundPermission: false,
    );

    await _localNotifications.initialize(
      const InitializationSettings(
        android: androidSettings,
        iOS: darwinSettings,
      ),
      onDidReceiveNotificationResponse: (response) async {
        if (response.payload != null) {
          try {
            final data = jsonDecode(response.payload!) as Map<String, dynamic>;
            final notification = AhramNotification.fromJson(data);
            await onTap(notification);
          } catch (_) {
            debugPrint('Failed to parse notification payload');
          }
        }
      },
    );

    // إنشاء قنوات Android
    if (Platform.isAndroid) {
      await _createAndroidChannels();
    }
  }

  Future<void> _createAndroidChannels() async {
    final androidPlugin = _localNotifications
        .resolvePlatformSpecificImplementation<
            AndroidFlutterLocalNotificationsPlugin>();

    final channels = [
      _buildChannel(
        id: 'ahram_transaction',
        name: 'العمليات المالية',
        description: 'إشعارات نجاح أو فشل العمليات',
        importance: Importance.high,
        sound: 'ahram_success',
      ),
      _buildChannel(
        id: 'ahram_task',
        name: 'مهام التنفيذ',
        description: 'مهام جديدة للمنفذين',
        importance: Importance.max,
        sound: 'ahram_task_arrival',
        vibrationPattern: Int64List.fromList([0, 500, 200, 500, 200, 500]),
      ),
      _buildChannel(
        id: 'ahram_rate_alert',
        name: 'تنبيهات الأسعار',
        description: 'تغييرات أسعار الصرف',
        importance: Importance.high,
        sound: 'ahram_balance_warning',
      ),
      _buildChannel(
        id: 'ahram_support',
        name: 'ردود الدعم',
        description: 'رسائل فريق الدعم',
        importance: Importance.defaultImportance,
        sound: 'ahram_support',
      ),
      _buildChannel(
        id: 'ahram_security',
        name: 'التنبيهات الأمنية',
        description: 'تسجيل دخول أو نشاط مشبوه',
        importance: Importance.max,
        sound: 'ahram_security',
        vibrationPattern: Int64List.fromList([0, 1000, 500, 1000]),
      ),
      _buildChannel(
        id: 'ahram_deposit',
        name: 'الإيداعات',
        description: 'تأكيد الإيداعات والتحويلات الواردة',
        importance: Importance.high,
        sound: 'ahram_report_ready',
      ),
      _buildChannel(
        id: 'ahram_system',
        name: 'إشعارات النظام',
        description: 'تحديثات عامة',
        importance: Importance.low,
        sound: 'ahram_status_update',
      ),
    ];

    for (final channel in channels) {
      await androidPlugin?.createNotificationChannel(channel);
    }
  }

  AndroidNotificationChannel _buildChannel({
    required String id,
    required String name,
    required String description,
    required Importance importance,
    String? sound,
    Int64List? vibrationPattern,
  }) {
    return AndroidNotificationChannel(
      id,
      name,
      description: description,
      importance: importance,
      playSound: sound != null,
      sound: sound != null
          ? RawResourceAndroidNotificationSound(sound)
          : null,
      enableVibration: vibrationPattern != null,
      vibrationPattern: vibrationPattern,
      ledColor: const Color(0xFF1E5BB5),
      enableLights: true,
    );
  }

  // ───────────────────────────────────────────────────────────────────────────
  // معالجة الرسائل
  // ───────────────────────────────────────────────────────────────────────────

  void _handleForegroundMessage(RemoteMessage message) {
    final notification = AhramNotification.fromRemoteMessage(message);

    // إضافة للصندوق
    _addToInbox(notification);

    // إرسال للـ Stream
    _notificationStream.add(notification);

    // عرض إشعار محلي
    _showLocalNotification(notification);
  }

  Future<void> _showLocalNotification(AhramNotification notification) async {
    final channelId = 'ahram_${notification.type}';
    final soundName = _getSoundName(notification.type);

    final androidDetails = AndroidNotificationDetails(
      channelId,
      _getChannelName(notification.type),
      channelDescription: _getChannelDescription(notification.type),
      importance: _getImportance(notification.priority),
      priority: _getPriority(notification.priority),
      sound: RawResourceAndroidNotificationSound(soundName),
      playSound: true,
      enableVibration: true,
      vibrationPattern: _getVibrationPattern(notification.type),
      color: const Color(0xFF1E5BB5),
      largeIcon: const DrawableResourceAndroidBitmap('@drawable/app_logo'),
      styleInformation: notification.imageUrl != null
          ? BigPictureStyleInformation(
              FilePathAndroidBitmap(notification.imageUrl!),
              contentTitle: notification.title,
              summaryText: notification.body,
            )
          : BigTextStyleInformation(
              notification.body,
              contentTitle: notification.title,
            ),
    );

    final darwinDetails = DarwinNotificationDetails(
      presentAlert: true,
      presentBadge: true,
      presentSound: true,
      sound: '$soundName.wav',
    );

    await _localNotifications.show(
      notification.id.hashCode,
      notification.title,
      notification.body,
      NotificationDetails(
        android: androidDetails,
        iOS: darwinDetails,
      ),
      payload: jsonEncode(notification.toJson()),
    );
  }

  // ───────────────────────────────────────────────────────────────────────────
  // helpers
  // ───────────────────────────────────────────────────────────────────────────

  String _getSoundName(String type) => switch (type) {
    NotificationTypes.transaction => 'ahram_success',
    NotificationTypes.rateAlert => 'ahram_balance_warning',
    NotificationTypes.executorTask => 'ahram_task_arrival',
    NotificationTypes.supportReply => 'ahram_support',
    NotificationTypes.security => 'ahram_security',
    NotificationTypes.deposit => 'ahram_report_ready',
    _ => 'ahram_status_update',
  };

  Int64List _getVibrationPattern(String type) => switch (type) {
    NotificationTypes.executorTask =>
      Int64List.fromList([0, 500, 200, 500, 200, 500]),
    NotificationTypes.security =>
      Int64List.fromList([0, 1000, 500, 1000]),
    NotificationTypes.transaction =>
      Int64List.fromList([0, 300, 100, 300]),
    _ => Int64List.fromList([0, 250, 100, 250]),
  };

  String _getChannelName(String type) => switch (type) {
    NotificationTypes.transaction => 'العمليات المالية',
    NotificationTypes.rateAlert => 'تنبيهات الأسعار',
    NotificationTypes.executorTask => 'مهام التنفيذ',
    NotificationTypes.supportReply => 'ردود الدعم',
    NotificationTypes.security => 'التنبيهات الأمنية',
    NotificationTypes.deposit => 'الإيداعات',
    _ => 'إشعارات عامة',
  };

  String _getChannelDescription(String type) => switch (type) {
    NotificationTypes.transaction => 'إشعارات نجاح أو فشل العمليات',
    NotificationTypes.rateAlert => 'تغييرات أسعار الصرف',
    NotificationTypes.executorTask => 'مهام جديدة للمنفذين',
    NotificationTypes.supportReply => 'رسائل فريق الدعم',
    NotificationTypes.security => 'تسجيل دخول أو نشاط مشبوه',
    NotificationTypes.deposit => 'تأكيد الإيداعات والتحويلات',
    _ => 'إشعارات عامة',
  };

  Importance _getImportance(String priority) => switch (priority) {
    'high' || 'urgent' => Importance.high,
    'low' => Importance.low,
    _ => Importance.defaultImportance,
  };

  Priority _getPriority(String priority) => switch (priority) {
    'high' || 'urgent' => Priority.high,
    'low' => Priority.low,
    _ => Priority.defaultPriority,
  };

  // ───────────────────────────────────────────────────────────────────────────
  // صندوق الوارد (Inbox)
  // ───────────────────────────────────────────────────────────────────────────

  void _addToInbox(AhramNotification notification) {
    _inbox.insert(0, notification);
    // الحد الأقصى 100 إشعار
    if (_inbox.length > 100) _inbox.removeLast();
  }

  void markAsRead(String id) {
    final index = _inbox.indexWhere((n) => n.id == id);
    if (index != -1) {
      _inbox[index] = _inbox[index].copyWith(isRead: true);
    }
  }

  void markAllAsRead() {
    for (var i = 0; i < _inbox.length; i++) {
      _inbox[i] = _inbox[i].copyWith(isRead: true);
    }
  }

  void clearInbox() => _inbox.clear();

  List<AhramNotification> getByType(String type) =>
      _inbox.where((n) => n.type == type).toList();

  List<AhramNotification> getUnread() =>
      _inbox.where((n) => !n.isRead).toList();

  // ───────────────────────────────────────────────────────────────────────────
  // تنظيف
  // ───────────────────────────────────────────────────────────────────────────

  void dispose() {
    _notificationStream.close();
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Handler للخلفية
// ═════════════════════════════════════════════════════════════════════════════

@pragma('vm:entry-point')
Future<void> _firebaseBackgroundHandler(RemoteMessage message) async {
  debugPrint('🔔 Background message: ${message.messageId}');
  // يمكن إضافة منطق إضافي هنا مثل حفظ في قاعدة بيانات محلية
}
