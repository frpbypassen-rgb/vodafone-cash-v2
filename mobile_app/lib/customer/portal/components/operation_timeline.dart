import 'package:flutter/material.dart';

import '../../customer_report_dashboard.dart';
import '../customer_theme.dart';

class CustomerTimelineEntry {
  const CustomerTimelineEntry({
    required this.reference,
    required this.amount,
    required this.status,
    required this.statusColor,
    this.time,
    this.onTap,
  });

  final String reference;
  final String amount;
  final String status;
  final Color statusColor;
  final String? time;
  final VoidCallback? onTap;
}

class CustomerOperationTimeline extends StatelessWidget {
  const CustomerOperationTimeline({
    super.key,
    required this.entries,
    this.emptyTitle = 'لا توجد عمليات',
    this.emptyMessage = 'ستظهر العمليات هنا فور تسجيلها.',
  });

  final List<CustomerTimelineEntry> entries;
  final String emptyTitle;
  final String emptyMessage;

  @override
  Widget build(BuildContext context) {
    if (entries.isEmpty) {
      return Container(
        padding: const EdgeInsets.all(24),
        decoration: CustomerTheme.surfaceCard(context),
        child: Column(
          children: [
            Icon(
              Icons.receipt_long_outlined,
              size: 40,
              color: Theme.of(context).colorScheme.onSurfaceVariant,
            ),
            const SizedBox(height: 10),
            Text(
              emptyTitle,
              style: const TextStyle(fontWeight: FontWeight.w900),
            ),
            const SizedBox(height: 4),
            Text(
              emptyMessage,
              textAlign: TextAlign.center,
              style: TextStyle(
                color: Theme.of(context).colorScheme.onSurfaceVariant,
                fontSize: 13,
              ),
            ),
          ],
        ),
      );
    }

    return Column(
      children: [
        for (var i = 0; i < entries.length; i++)
          Padding(
            padding: EdgeInsets.only(bottom: i == entries.length - 1 ? 0 : 9),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Column(
                  children: [
                    Container(
                      width: 10,
                      height: 10,
                      decoration: BoxDecoration(
                        color: entries[i].statusColor,
                        shape: BoxShape.circle,
                      ),
                    ),
                    if (i < entries.length - 1)
                      Container(
                        width: 2,
                        height: 44,
                        color: Theme.of(context).colorScheme.outlineVariant,
                      ),
                  ],
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: CustomerOperationCard(
                    reference: entries[i].reference,
                    amount: entries[i].amount,
                    status: entries[i].status,
                    statusColor: entries[i].statusColor,
                    onTap: entries[i].onTap,
                  ),
                ),
              ],
            ),
          ),
      ],
    );
  }
}

/// Horizontal strip for home — last 3 operations.
class CustomerRecentOpsStrip extends StatelessWidget {
  const CustomerRecentOpsStrip({
    super.key,
    required this.entries,
    required this.onViewAll,
  });

  final List<CustomerTimelineEntry> entries;
  final VoidCallback onViewAll;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    if (entries.isEmpty) return const SizedBox.shrink();

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Text(
              'آخر العمليات',
              style: TextStyle(
                fontWeight: FontWeight.w900,
                fontSize: 15,
                color: colors.onSurface,
              ),
            ),
            const Spacer(),
            TextButton(onPressed: onViewAll, child: const Text('عرض الكل')),
          ],
        ),
        const SizedBox(height: 8),
        SizedBox(
          height: 92,
          child: ListView.separated(
            scrollDirection: Axis.horizontal,
            itemCount: entries.length,
            separatorBuilder: (_, _) => const SizedBox(width: 10),
            itemBuilder: (context, index) {
              final entry = entries[index];
              return SizedBox(
                width: 220,
                child: CustomerOperationCard(
                  reference: entry.reference,
                  amount: entry.amount,
                  status: entry.status,
                  statusColor: entry.statusColor,
                  onTap: entry.onTap,
                ),
              );
            },
          ),
        ),
      ],
    );
  }
}
