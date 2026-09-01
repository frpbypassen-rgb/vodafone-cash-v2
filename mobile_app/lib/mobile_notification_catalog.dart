class MobileNotificationDefinition {
  const MobileNotificationDefinition({
    required this.category,
    required this.channelId,
    required this.channelName,
    required this.description,
    required this.sound,
    required this.preferenceKey,
    required this.route,
    required this.priority,
    this.urgent = false,
  });

  final String category;
  final String channelId;
  final String channelName;
  final String description;
  final String sound;
  final String preferenceKey;
  final String route;
  final String priority;
  final bool urgent;
}

const mobileNotificationDefinitions = <String, MobileNotificationDefinition>{
  'client_general': MobileNotificationDefinition(
    category: 'client_general',
    channelId: 'client_general_v1',
    channelName: 'إشعارات الحساب',
    description: 'تنبيهات الرصيد والعمليات والدعم الخاصة بحسابك.',
    sound: 'default',
    preferenceKey: 'general',
    route: 'notifications',
    priority: 'high',
  ),
  'executor_task_new': MobileNotificationDefinition(
    category: 'executor_task_new',
    channelId: 'executor_tasks_v2',
    channelName: 'عمليات التنفيذ الجديدة',
    description: 'تنبيه فوري عند وصول عملية جديدة متاحة للتنفيذ.',
    sound: 'ahram_task_arrival',
    preferenceKey: 'tasks',
    route: 'tasks',
    priority: 'urgent',
    urgent: true,
  ),
  'executor_task_routed': MobileNotificationDefinition(
    category: 'executor_task_routed',
    channelId: 'executor_routed_tasks_v1',
    channelName: 'العمليات الموجهة إليك',
    description: 'عملية وجهها المدير إلى حسابك مباشرة.',
    sound: 'ahram_task_assigned',
    preferenceKey: 'tasks',
    route: 'tasks',
    priority: 'urgent',
    urgent: true,
  ),
  'executor_task_reminder': MobileNotificationDefinition(
    category: 'executor_task_reminder',
    channelId: 'executor_task_reminders_v1',
    channelName: 'تذكير عمليات التنفيذ',
    description: 'تذكير بالعمليات التي لم تُفتح أو تُستلم بعد.',
    sound: 'ahram_task_reminder',
    preferenceKey: 'reminders',
    route: 'tasks',
    priority: 'urgent',
    urgent: true,
  ),
  'executor_urgent_alert': MobileNotificationDefinition(
    category: 'executor_urgent_alert',
    channelId: 'executor_urgent_alerts_v2',
    channelName: 'إنذارات الإدارة العاجلة',
    description: 'إنذار مرتفع الأولوية يتطلب مراجعة فورية.',
    sound: 'ahram_urgent_alarm',
    preferenceKey: 'urgent',
    route: 'tasks',
    priority: 'critical',
    urgent: true,
  ),
  'executor_task_accepted': MobileNotificationDefinition(
    category: 'executor_task_accepted',
    channelId: 'executor_task_status_v1',
    channelName: 'حالة عمليات التنفيذ',
    description: 'تحديثات قبول وسحب عمليات التنفيذ.',
    sound: 'ahram_status_update',
    preferenceKey: 'taskStatus',
    route: 'tasks',
    priority: 'normal',
  ),
  'executor_task_completed': MobileNotificationDefinition(
    category: 'executor_task_completed',
    channelId: 'executor_task_success_v1',
    channelName: 'العمليات الناجحة',
    description: 'تأكيد نجاح عملية التنفيذ.',
    sound: 'ahram_success',
    preferenceKey: 'taskStatus',
    route: 'reports',
    priority: 'normal',
  ),
  'executor_task_cancelled': MobileNotificationDefinition(
    category: 'executor_task_cancelled',
    channelId: 'executor_task_cancellation_v1',
    channelName: 'العمليات الملغية',
    description: 'إشعار إلغاء عملية وسبب الإلغاء.',
    sound: 'ahram_cancellation',
    preferenceKey: 'taskStatus',
    route: 'reports',
    priority: 'high',
  ),
  'executor_support_reply': MobileNotificationDefinition(
    category: 'executor_support_reply',
    channelId: 'executor_support_v1',
    channelName: 'الدعم الفني',
    description: 'رسائل وردود فريق الدعم الفني.',
    sound: 'ahram_support',
    preferenceKey: 'support',
    route: 'support',
    priority: 'high',
  ),
  'executor_balance_warning': MobileNotificationDefinition(
    category: 'executor_balance_warning',
    channelId: 'executor_finance_v1',
    channelName: 'تنبيهات الرصيد',
    description: 'تنبيهات انخفاض رصيد شركة التنفيذ.',
    sound: 'ahram_balance_warning',
    preferenceKey: 'balance',
    route: 'settings',
    priority: 'high',
  ),
  'executor_security_alert': MobileNotificationDefinition(
    category: 'executor_security_alert',
    channelId: 'executor_security_v1',
    channelName: 'أمان حساب التنفيذ',
    description: 'تنبيهات تسجيل الدخول والأجهزة الجديدة.',
    sound: 'ahram_security',
    preferenceKey: 'security',
    route: 'settings',
    priority: 'high',
  ),
  'executor_report_ready': MobileNotificationDefinition(
    category: 'executor_report_ready',
    channelId: 'executor_reports_v1',
    channelName: 'تقارير التنفيذ',
    description: 'تنبيه عند اكتمال تجهيز تقرير التنفيذ.',
    sound: 'ahram_report_ready',
    preferenceKey: 'reports',
    route: 'reports',
    priority: 'normal',
  ),
};

const defaultMobileNotificationPreferences = <String, bool>{
  'general': true,
  'tasks': true,
  'reminders': true,
  'urgent': true,
  'taskStatus': true,
  'support': true,
  'balance': true,
  'security': true,
  'reports': true,
};

MobileNotificationDefinition notificationDefinitionFor(String category) =>
    mobileNotificationDefinitions[category] ??
    mobileNotificationDefinitions['executor_task_accepted']!;
