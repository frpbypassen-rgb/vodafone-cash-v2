import 'package:flutter/material.dart';

import '../brand_theme.dart';

class CustomerReportMetrics extends StatelessWidget {
  const CustomerReportMetrics({
    super.key,
    required this.transactionCount,
    required this.completedCount,
    required this.totalEgp,
    required this.totalLyd,
    this.showCost = true,
  });

  final int transactionCount;
  final int completedCount;
  final String totalEgp;
  final String totalLyd;
  final bool showCost;

  @override
  Widget build(BuildContext context) {
    final items = <(String, String, Color)>[
      ('العمليات', '$transactionCount', AhramColors.ink),
      ('الناجحة', '$completedCount', AhramColors.emerald),
      ('المصري', totalEgp, AhramColors.gold),
      if (showCost) ('التكلفة', totalLyd, const Color(0xFF3366CC)),
    ];
    return LayoutBuilder(
      builder: (context, constraints) {
        final columns = constraints.maxWidth >= 430 ? 2 : 2;
        final width = (constraints.maxWidth - (8 * (columns - 1))) / columns;
        return Wrap(
          spacing: 8,
          runSpacing: 8,
          children: items
              .map(
                (item) => SizedBox(
                  width: width,
                  child: _MetricCard(
                    label: item.$1,
                    value: item.$2,
                    color: item.$3,
                  ),
                ),
              )
              .toList(),
        );
      },
    );
  }
}

class _MetricCard extends StatelessWidget {
  const _MetricCard({
    required this.label,
    required this.value,
    required this.color,
  });

  final String label;
  final String value;
  final Color color;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.fromLTRB(12, 12, 12, 10),
      decoration: BoxDecoration(
        color: colors.surface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: color.withValues(alpha: 0.22)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            label,
            style: TextStyle(
              color: colors.onSurfaceVariant,
              fontSize: 12,
              fontWeight: FontWeight.w700,
            ),
          ),
          const SizedBox(height: 6),
          FittedBox(
            fit: BoxFit.scaleDown,
            alignment: AlignmentDirectional.centerStart,
            child: Text(
              value,
              maxLines: 1,
              style: TextStyle(
                color: colors.onSurface,
                fontWeight: FontWeight.w900,
                fontSize: 22,
                height: 1.1,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class CustomerServiceShare {
  const CustomerServiceShare({
    required this.label,
    required this.count,
    required this.color,
  });

  final String label;
  final int count;
  final Color color;
}

class CustomerServiceShareBars extends StatelessWidget {
  const CustomerServiceShareBars({super.key, required this.shares});

  final List<CustomerServiceShare> shares;

  @override
  Widget build(BuildContext context) {
    if (shares.isEmpty) return const SizedBox.shrink();
    final maxCount = shares
        .map((item) => item.count)
        .fold<int>(0, (current, next) => next > current ? next : current);
    final colors = Theme.of(context).colorScheme;
    return Column(
      children: shares.map((share) {
        final ratio = maxCount == 0 ? 0.0 : share.count / maxCount;
        return Padding(
          padding: const EdgeInsets.only(bottom: 10),
          child: Row(
            children: [
              SizedBox(
                width: 88,
                child: Text(
                  share.label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w800,
                    color: colors.onSurface,
                  ),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: ClipRRect(
                  borderRadius: BorderRadius.circular(99),
                  child: LinearProgressIndicator(
                    value: ratio,
                    minHeight: 10,
                    color: share.color,
                    backgroundColor: share.color.withValues(alpha: 0.12),
                  ),
                ),
              ),
              const SizedBox(width: 8),
              Text(
                '${share.count}',
                style: const TextStyle(fontWeight: FontWeight.w900),
              ),
            ],
          ),
        );
      }).toList(),
    );
  }
}

class CustomerOperationCard extends StatelessWidget {
  const CustomerOperationCard({
    super.key,
    required this.reference,
    required this.amount,
    required this.status,
    required this.statusColor,
    this.onTap,
  });

  final String reference;
  final String amount;
  final String status;
  final Color statusColor;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Material(
      color: colors.surface,
      borderRadius: BorderRadius.circular(12),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(12),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: colors.outlineVariant),
          ),
          child: Row(
            children: [
              Expanded(
                child: Text(
                  reference,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontWeight: FontWeight.w800),
                ),
              ),
              const SizedBox(width: 8),
              Text(
                amount,
                style: const TextStyle(
                  fontWeight: FontWeight.w900,
                  fontSize: 15,
                ),
              ),
              const SizedBox(width: 8),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                decoration: BoxDecoration(
                  color: statusColor.withValues(alpha: 0.12),
                  borderRadius: BorderRadius.circular(99),
                ),
                child: Text(
                  status,
                  style: TextStyle(
                    color: statusColor,
                    fontSize: 11,
                    fontWeight: FontWeight.w800,
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
