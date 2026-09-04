import 'package:flutter/material.dart';

import '../brand_theme.dart';

class AgentHqMetric {
  const AgentHqMetric({
    required this.label,
    required this.value,
    required this.suffix,
    required this.color,
  });

  final String label;
  final String value;
  final String suffix;
  final Color color;
}

class AgentHqMetrics extends StatelessWidget {
  const AgentHqMetrics({super.key, required this.metrics});

  final List<AgentHqMetric> metrics;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        final columns = constraints.maxWidth >= 430 ? 2 : 2;
        final width = (constraints.maxWidth - (8 * (columns - 1))) / columns;
        return Wrap(
          spacing: 8,
          runSpacing: 8,
          children: metrics
              .map(
                (metric) => SizedBox(
                  width: width,
                  child: _AgentMetricCard(metric: metric),
                ),
              )
              .toList(),
        );
      },
    );
  }
}

class _AgentMetricCard extends StatelessWidget {
  const _AgentMetricCard({required this.metric});

  final AgentHqMetric metric;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.fromLTRB(12, 12, 12, 10),
      decoration: BoxDecoration(
        color: colors.surface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: metric.color.withValues(alpha: 0.24)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            metric.label,
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
              metric.suffix.trim().isEmpty
                  ? metric.value
                  : '${metric.value} ${metric.suffix}',
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

class AgentAttentionBanner extends StatelessWidget {
  const AgentAttentionBanner({super.key, required this.message});

  final String message;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AhramColors.emerald.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: AhramColors.emerald.withValues(alpha: 0.28)),
      ),
      child: Text(
        message,
        style: TextStyle(
          height: 1.5,
          color: Theme.of(context).colorScheme.onSurface,
        ),
      ),
    );
  }
}
