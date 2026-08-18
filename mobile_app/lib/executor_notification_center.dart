import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import 'mobile_api.dart';

class ExecutorNotificationCenterScreen extends StatefulWidget {
  const ExecutorNotificationCenterScreen({super.key, required this.api});

  final MobileApi api;

  @override
  State<ExecutorNotificationCenterScreen> createState() =>
      _ExecutorNotificationCenterScreenState();
}

class _ExecutorNotificationCenterScreenState
    extends State<ExecutorNotificationCenterScreen> {
  static const _filters = <String, String>{
    'all': 'الكل',
    'tasks': 'المهام',
    'reports': 'التقارير',
    'support': 'الدعم',
    'finance': 'المالية',
    'security': 'الأمان',
  };

  List<Map<String, dynamic>> _items = const <Map<String, dynamic>>[];
  String _filter = 'all';
  bool _loading = true;
  bool _markingAll = false;
  Object? _error;
  int _unread = 0;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    if (mounted) {
      setState(() {
        _loading = true;
        _error = null;
      });
    }
    try {
      final response = await widget.api.pushInbox(limit: 100);
      final rawItems = response['items'];
      final items = rawItems is List
          ? rawItems
                .whereType<Map>()
                .map((item) => Map<String, dynamic>.from(item))
                .toList()
          : <Map<String, dynamic>>[];
      if (!mounted) return;
      setState(() {
        _items = items;
        _unread = _integer(response['unread']);
      });
    } catch (error) {
      if (mounted) setState(() => _error = error);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  int _integer(Object? value) {
    if (value is num) return value.toInt();
    return int.tryParse('${value ?? ''}') ?? 0;
  }

  String _groupFor(String category) {
    if (category == 'executor_support_reply') return 'support';
    if (category == 'executor_balance_warning') return 'finance';
    if (category == 'executor_security_alert') return 'security';
    if (<String>{
      'executor_task_completed',
      'executor_task_cancelled',
      'executor_report_ready',
    }.contains(category)) {
      return 'reports';
    }
    return 'tasks';
  }

  List<Map<String, dynamic>> get _visibleItems {
    if (_filter == 'all') return _items;
    return _items
        .where((item) => _groupFor('${item['category'] ?? ''}') == _filter)
        .toList();
  }

  Future<void> _markAllRead() async {
    if (_markingAll || _unread == 0) return;
    setState(() => _markingAll = true);
    try {
      await widget.api.markAllPushNotificationsRead();
      if (!mounted) return;
      setState(() {
        _unread = 0;
        _items = _items
            .map(
              (item) => <String, dynamic>{
                ...item,
                'readAt': item['readAt'] ?? DateTime.now().toIso8601String(),
              },
            )
            .toList();
      });
    } finally {
      if (mounted) setState(() => _markingAll = false);
    }
  }

  Future<void> _open(Map<String, dynamic> item) async {
    final id = '${item['id'] ?? item['_id'] ?? ''}'.trim();
    if (id.isNotEmpty && item['readAt'] == null) {
      try {
        await widget.api.markPushNotificationRead(id);
      } catch (_) {
        // Navigation should still work during a short connectivity outage.
      }
    }
    if (!mounted) return;
    final rawData = item['data'];
    Navigator.of(context).pop(<String, dynamic>{
      'route': '${item['route'] ?? ''}',
      'data': rawData is Map
          ? Map<String, dynamic>.from(rawData)
          : <String, dynamic>{},
    });
  }

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final visibleItems = _visibleItems;
    return Scaffold(
      appBar: AppBar(
        title: const Text('مركز الإشعارات'),
        actions: [
          IconButton(
            tooltip: 'تحديث',
            onPressed: _loading ? null : _load,
            icon: const Icon(Icons.refresh_rounded),
          ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: _load,
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.fromLTRB(16, 14, 16, 28),
          children: [
            Container(
              padding: const EdgeInsets.all(16),
              decoration: BoxDecoration(
                color: colors.primaryContainer.withValues(alpha: 0.46),
                borderRadius: BorderRadius.circular(8),
                border: Border.all(
                  color: colors.primary.withValues(alpha: 0.18),
                ),
              ),
              child: Row(
                children: [
                  Container(
                    width: 48,
                    height: 48,
                    decoration: BoxDecoration(
                      color: colors.primary,
                      borderRadius: BorderRadius.circular(8),
                    ),
                    child: Icon(
                      Icons.notifications_active_outlined,
                      color: colors.onPrimary,
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          _unread == 0
                              ? 'لا توجد إشعارات غير مقروءة'
                              : 'لديك $_unread إشعار غير مقروء',
                          style: const TextStyle(
                            fontWeight: FontWeight.w900,
                            fontSize: 16,
                          ),
                        ),
                        const SizedBox(height: 3),
                        Text(
                          'المهام والتنبيهات والدعم في سجل واحد.',
                          style: TextStyle(
                            color: colors.onSurfaceVariant,
                            fontSize: 12,
                          ),
                        ),
                      ],
                    ),
                  ),
                  TextButton.icon(
                    onPressed: _markingAll || _unread == 0
                        ? null
                        : _markAllRead,
                    icon: _markingAll
                        ? const SizedBox.square(
                            dimension: 15,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Icon(Icons.done_all_rounded, size: 18),
                    label: const Text('قراءة الكل'),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 14),
            SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: Row(
                children: _filters.entries.map((entry) {
                  return Padding(
                    padding: const EdgeInsetsDirectional.only(end: 8),
                    child: FilterChip(
                      selected: _filter == entry.key,
                      onSelected: (_) => setState(() => _filter = entry.key),
                      avatar: Icon(_filterIcon(entry.key), size: 17),
                      label: Text(entry.value),
                    ),
                  );
                }).toList(),
              ),
            ),
            const SizedBox(height: 10),
            if (_loading && _items.isEmpty)
              const Padding(
                padding: EdgeInsets.only(top: 80),
                child: Center(child: CircularProgressIndicator()),
              )
            else if (_error != null && _items.isEmpty)
              _NotificationEmptyState(
                icon: Icons.cloud_off_outlined,
                title: 'تعذر تحميل الإشعارات',
                message: 'تحقق من الاتصال ثم أعد المحاولة.',
                actionLabel: 'إعادة المحاولة',
                onAction: _load,
              )
            else if (visibleItems.isEmpty)
              _NotificationEmptyState(
                icon: Icons.notifications_none_rounded,
                title: 'لا توجد إشعارات هنا',
                message: 'ستظهر التنبيهات الجديدة في هذا القسم فور وصولها.',
                actionLabel: 'عرض الكل',
                onAction: () => setState(() => _filter = 'all'),
              )
            else
              ...visibleItems.map(
                (item) => Padding(
                  padding: const EdgeInsets.only(bottom: 10),
                  child: _ExecutorNotificationTile(
                    item: item,
                    onTap: () => _open(item),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }

  IconData _filterIcon(String filter) => switch (filter) {
    'tasks' => Icons.assignment_turned_in_outlined,
    'reports' => Icons.description_outlined,
    'support' => Icons.support_agent_outlined,
    'finance' => Icons.account_balance_wallet_outlined,
    'security' => Icons.shield_outlined,
    _ => Icons.dashboard_outlined,
  };
}

class _ExecutorNotificationTile extends StatelessWidget {
  const _ExecutorNotificationTile({required this.item, required this.onTap});

  final Map<String, dynamic> item;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final category = '${item['category'] ?? ''}';
    final read = item['readAt'] != null;
    final visual = _visualFor(category, colors);
    return Material(
      color: read ? colors.surface : visual.color.withValues(alpha: 0.075),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(8),
        side: BorderSide(
          color: read
              ? colors.outlineVariant
              : visual.color.withValues(alpha: 0.38),
        ),
      ),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Container(
                width: 42,
                height: 42,
                decoration: BoxDecoration(
                  color: visual.color.withValues(alpha: 0.12),
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Icon(visual.icon, color: visual.color, size: 22),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Expanded(
                          child: Text(
                            '${item['title'] ?? 'إشعار'}',
                            style: TextStyle(
                              fontWeight: read
                                  ? FontWeight.w700
                                  : FontWeight.w900,
                            ),
                          ),
                        ),
                        if (!read)
                          Container(
                            width: 8,
                            height: 8,
                            decoration: BoxDecoration(
                              color: visual.color,
                              shape: BoxShape.circle,
                            ),
                          ),
                      ],
                    ),
                    if ('${item['body'] ?? ''}'.trim().isNotEmpty) ...[
                      const SizedBox(height: 5),
                      Text(
                        '${item['body']}',
                        maxLines: 3,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          color: colors.onSurfaceVariant,
                          height: 1.45,
                          fontSize: 12.5,
                        ),
                      ),
                    ],
                    const SizedBox(height: 8),
                    Row(
                      children: [
                        Icon(
                          Icons.schedule_outlined,
                          size: 14,
                          color: colors.onSurfaceVariant,
                        ),
                        const SizedBox(width: 4),
                        Text(
                          _formatDate(item['createdAt']),
                          style: TextStyle(
                            color: colors.onSurfaceVariant,
                            fontSize: 11,
                          ),
                        ),
                        const Spacer(),
                        Text(
                          'فتح',
                          style: TextStyle(
                            color: visual.color,
                            fontWeight: FontWeight.w800,
                            fontSize: 12,
                          ),
                        ),
                        Icon(
                          Icons.chevron_left_rounded,
                          color: visual.color,
                          size: 18,
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  static String _formatDate(Object? value) {
    final date = DateTime.tryParse('${value ?? ''}')?.toLocal();
    if (date == null) return '-';
    final now = DateTime.now();
    if (DateUtils.isSameDay(date, now)) {
      return 'اليوم ${DateFormat('hh:mm a', 'ar').format(date)}';
    }
    return DateFormat('yyyy/MM/dd - hh:mm a', 'ar').format(date);
  }

  static _NotificationVisual _visualFor(String category, ColorScheme colors) {
    if (category == 'executor_urgent_alert') {
      return const _NotificationVisual(
        Icons.notification_important_outlined,
        Color(0xFFD92D20),
      );
    }
    if (category == 'executor_task_completed') {
      return const _NotificationVisual(
        Icons.task_alt_rounded,
        Color(0xFF00875A),
      );
    }
    if (category == 'executor_task_cancelled') {
      return const _NotificationVisual(
        Icons.cancel_outlined,
        Color(0xFFC4323B),
      );
    }
    if (category == 'executor_support_reply') {
      return const _NotificationVisual(
        Icons.support_agent_outlined,
        Color(0xFF6F52C9),
      );
    }
    if (category == 'executor_balance_warning') {
      return const _NotificationVisual(
        Icons.account_balance_wallet_outlined,
        Color(0xFFC27A00),
      );
    }
    if (category == 'executor_security_alert') {
      return const _NotificationVisual(
        Icons.shield_outlined,
        Color(0xFF0057B8),
      );
    }
    if (category == 'executor_report_ready') {
      return const _NotificationVisual(
        Icons.description_outlined,
        Color(0xFF087F8C),
      );
    }
    return _NotificationVisual(
      Icons.assignment_turned_in_outlined,
      colors.primary,
    );
  }
}

class _NotificationVisual {
  const _NotificationVisual(this.icon, this.color);

  final IconData icon;
  final Color color;
}

class _NotificationEmptyState extends StatelessWidget {
  const _NotificationEmptyState({
    required this.icon,
    required this.title,
    required this.message,
    required this.actionLabel,
    required this.onAction,
  });

  final IconData icon;
  final String title;
  final String message;
  final String actionLabel;
  final VoidCallback onAction;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.only(top: 64),
      child: Column(
        children: [
          Icon(icon, size: 54, color: colors.outline),
          const SizedBox(height: 14),
          Text(
            title,
            style: const TextStyle(fontWeight: FontWeight.w900, fontSize: 17),
          ),
          const SizedBox(height: 6),
          Text(message, textAlign: TextAlign.center),
          const SizedBox(height: 16),
          OutlinedButton.icon(
            onPressed: onAction,
            icon: const Icon(Icons.refresh_rounded),
            label: Text(actionLabel),
          ),
        ],
      ),
    );
  }
}
