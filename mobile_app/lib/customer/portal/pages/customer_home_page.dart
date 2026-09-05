import 'dart:async';

import 'package:flutter/material.dart';

import '../../../mobile_api.dart';
import '../../customer_wallet_hero.dart';
import '../customer_breakpoints.dart';
import '../customer_format.dart';
import '../customer_portal_scope.dart';
import '../customer_theme.dart';
import '../components/operation_timeline.dart';
import '../components/quick_action_orb.dart';

/// Customer home hub — wallet, quick actions, and recent operations.
class CustomerHomePage extends StatefulWidget {
  const CustomerHomePage({
    super.key,
    required this.controller,
    required this.onNavigateTab,
    this.onOpenAccountSettings,
  });

  final SessionController controller;
  final void Function(int tabIndex) onNavigateTab;
  final VoidCallback? onOpenAccountSettings;

  @override
  State<CustomerHomePage> createState() => _CustomerHomePageState();
}

class _CustomerHomePageState extends State<CustomerHomePage> {
  bool _loading = true;
  Object? _error;
  List<Map<String, dynamic>> _recent = const [];

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      await widget.controller.refreshHome();
      final today = DateTime.now();
      final date =
          '${today.year}-${today.month.toString().padLeft(2, '0')}-${today.day.toString().padLeft(2, '0')}';
      final txs = await widget.controller.api.clientTransactions(
        dateFrom: date,
        dateTo: date,
      );
      if (mounted) {
        setState(() => _recent = txs.take(8).toList());
      }
    } catch (error) {
      if (mounted) setState(() => _error = error);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  List<CustomerTimelineEntry> _entries() {
    return _recent
        .map(
          (tx) => CustomerTimelineEntry(
            reference: '${tx['customId'] ?? tx['txId'] ?? '-'}',
            amount:
                '${customerFormatEgp(customerNumber(tx['amount']))} ج.م',
            status: customerStatusLabel(tx['status']?.toString()),
            statusColor: customerStatusColor(tx['status']?.toString()),
            onTap: () => CustomerPortalScope.maybeOf(context)?.setInspector(
              _transactionInspector(tx),
              title: 'تفاصيل العملية',
            ),
          ),
        )
        .toList();
  }

  Widget _transactionInspector(Map<String, dynamic> tx) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          '${tx['customId'] ?? tx['txId'] ?? '-'}',
          style: const TextStyle(fontWeight: FontWeight.w900, fontSize: 16),
        ),
        const SizedBox(height: 12),
        _detailRow(
          'المبلغ',
          '${customerFormatEgp(customerNumber(tx['amount']))} ج.م',
        ),
        _detailRow('الحالة', customerStatusLabel(tx['status']?.toString())),
        _detailRow(
          'الخدمة',
          customerServiceLabel(tx['transferType']?.toString()),
        ),
      ],
    );
  }

  Widget _detailRow(String label, String value) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Row(
        children: [
          Expanded(
            child: Text(
              label,
              style: TextStyle(
                color: Theme.of(context).colorScheme.onSurfaceVariant,
              ),
            ),
          ),
          Text(value, style: const TextStyle(fontWeight: FontWeight.w800)),
        ],
      ),
    );
  }

  int _todayCompleted() {
    return _recent
        .where((tx) => '${tx['status']}'.toLowerCase() == 'completed')
        .length;
  }

  @override
  Widget build(BuildContext context) {
    final session = widget.controller.session;
    if (session == null) {
      return const Center(child: CircularProgressIndicator());
    }

    final width = MediaQuery.sizeOf(context).width;
    final desktop = customerLayoutMode(width) == CustomerLayoutMode.desktop;
    final balance = session.balance;
    final available = session.availableToSpend ?? session.balance;

    if (_loading && _recent.isEmpty) {
      return const Center(child: CircularProgressIndicator());
    }

    final wallet = CustomerWalletHero(balance: balance, available: available);
    final quickActions = CustomerQuickActionRow(
      actions: [
        CustomerQuickAction(
          label: 'تحويل',
          icon: Icons.send_to_mobile_outlined,
          onTap: () => widget.onNavigateTab(1),
        ),
        CustomerQuickAction(
          label: 'أسعار',
          icon: Icons.currency_exchange_outlined,
          color: CustomerTheme.success,
          onTap: () => widget.onNavigateTab(2),
        ),
        CustomerQuickAction(
          label: 'تقرير',
          icon: Icons.assessment_outlined,
          onTap: () => widget.onNavigateTab(3),
        ),
        CustomerQuickAction(
          label: 'دعم',
          icon: Icons.support_agent_outlined,
          onTap: () => widget.onNavigateTab(4),
        ),
      ],
    );

    final recentStrip = CustomerRecentOpsStrip(
      entries: _entries().take(3).toList(),
      onViewAll: () => widget.onNavigateTab(3),
    );

    final settingsCard = widget.onOpenAccountSettings == null
        ? const SizedBox.shrink()
        : Padding(
            padding: const EdgeInsets.only(top: 16),
            child: Material(
              color: Theme.of(context).colorScheme.surface,
              borderRadius: BorderRadius.circular(CustomerTheme.radiusMd),
              child: InkWell(
                onTap: widget.onOpenAccountSettings,
                borderRadius: BorderRadius.circular(CustomerTheme.radiusMd),
                child: Container(
                  padding: const EdgeInsets.all(16),
                  decoration: CustomerTheme.surfaceCard(context),
                  child: Row(
                    children: [
                      Container(
                        width: 44,
                        height: 44,
                        decoration: BoxDecoration(
                          color: CustomerTheme.action.withValues(alpha: 0.12),
                          shape: BoxShape.circle,
                        ),
                        child: const Icon(
                          Icons.account_circle_outlined,
                          color: CustomerTheme.action,
                        ),
                      ),
                      const SizedBox(width: 12),
                      const Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              'الحساب والإعدادات',
                              style: TextStyle(fontWeight: FontWeight.w900),
                            ),
                            SizedBox(height: 2),
                            Text(
                              'الملف · الأمان · التفضيلات',
                              style: TextStyle(fontSize: 12),
                            ),
                          ],
                        ),
                      ),
                      Icon(
                        Icons.chevron_left,
                        color: Theme.of(context).colorScheme.onSurfaceVariant,
                      ),
                    ],
                  ),
                ),
              ),
            ),
          );

    if (desktop) {
      return RefreshIndicator(
        onRefresh: _load,
        child: ListView(
          padding: const EdgeInsets.all(20),
          children: [
            Text(
              'محطة التحكم',
              style: Theme.of(context).textTheme.headlineSmall?.copyWith(
                fontWeight: FontWeight.w900,
              ),
            ),
            const SizedBox(height: 4),
            Text(
              '${session.name} · عميل',
              style: TextStyle(
                color: Theme.of(context).colorScheme.onSurfaceVariant,
              ),
            ),
            const SizedBox(height: 16),
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  flex: 3,
                  child: Column(
                    children: [
                      wallet,
                      const SizedBox(height: 14),
                      quickActions,
                    ],
                  ),
                ),
                const SizedBox(width: 14),
                Expanded(
                  flex: 2,
                  child: _DesktopKpiColumn(
                    available: available,
                    todayCount: _recent.length,
                    completedCount: _todayCompleted(),
                    onTransfer: () => widget.onNavigateTab(1),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 18),
            recentStrip,
            settingsCard,
          ],
        ),
      );
    }

    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 100),
        children: [
          if (_error != null) ...[
            Text(
              'تعذر تحميل آخر العمليات',
              style: TextStyle(color: Theme.of(context).colorScheme.error),
            ),
            const SizedBox(height: 12),
          ],
          wallet,
          const SizedBox(height: 14),
          quickActions,
          const SizedBox(height: 18),
          recentStrip,
          settingsCard,
        ],
      ),
    );
  }
}

class _DesktopKpiColumn extends StatelessWidget {
  const _DesktopKpiColumn({
    required this.available,
    required this.todayCount,
    required this.completedCount,
    required this.onTransfer,
  });

  final double available;
  final int todayCount;
  final int completedCount;
  final VoidCallback onTransfer;

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        _KpiTile(label: 'عمليات اليوم', value: '$todayCount'),
        const SizedBox(height: 10),
        _KpiTile(
          label: 'الناجحة',
          value: '$completedCount',
          color: CustomerTheme.success,
        ),
        const SizedBox(height: 10),
        _KpiTile(
          label: 'المتاح',
          value: '${CustomerWalletHero.formatMoney(available)} د.ل',
          color: CustomerTheme.action,
        ),
        const SizedBox(height: 14),
        FilledButton.icon(
          onPressed: onTransfer,
          icon: const Icon(Icons.add_circle_outline),
          label: const Text('تحويل جديد'),
          style: FilledButton.styleFrom(
            backgroundColor: CustomerTheme.action,
            foregroundColor: CustomerTheme.canvas,
            minimumSize:
                const Size.fromHeight(CustomerTheme.buttonHeightDesktop),
          ),
        ),
      ],
    );
  }
}

class _KpiTile extends StatelessWidget {
  const _KpiTile({
    required this.label,
    required this.value,
    this.color,
  });

  final String label;
  final String value;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(14),
      decoration: CustomerTheme.surfaceCard(context, accent: color),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            label,
            style: TextStyle(
              fontSize: 12,
              fontWeight: FontWeight.w700,
              color: Theme.of(context).colorScheme.onSurfaceVariant,
            ),
          ),
          const SizedBox(height: 6),
          Text(
            value,
            style: TextStyle(
              fontWeight: FontWeight.w900,
              fontSize: CustomerTheme.metricFs,
              color: color ?? Theme.of(context).colorScheme.onSurface,
            ),
          ),
        ],
      ),
    );
  }
}
