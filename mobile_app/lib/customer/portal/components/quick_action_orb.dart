import 'package:flutter/material.dart';

import '../customer_theme.dart';

class CustomerQuickAction {
  const CustomerQuickAction({
    required this.label,
    required this.icon,
    required this.onTap,
    this.color,
  });

  final String label;
  final IconData icon;
  final VoidCallback onTap;
  final Color? color;
}

class CustomerQuickActionRow extends StatelessWidget {
  const CustomerQuickActionRow({super.key, required this.actions});

  final List<CustomerQuickAction> actions;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        for (var i = 0; i < actions.length; i++) ...[
          if (i > 0) const SizedBox(width: 10),
          Expanded(child: _QuickActionOrb(action: actions[i])),
        ],
      ],
    );
  }
}

class _QuickActionOrb extends StatelessWidget {
  const _QuickActionOrb({required this.action});

  final CustomerQuickAction action;

  @override
  Widget build(BuildContext context) {
    final accent = action.color ?? CustomerTheme.action;
    final colors = Theme.of(context).colorScheme;
    return Material(
      color: colors.surface,
      borderRadius: BorderRadius.circular(CustomerTheme.radiusMd),
      child: InkWell(
        onTap: action.onTap,
        borderRadius: BorderRadius.circular(CustomerTheme.radiusMd),
        child: Container(
          padding: const EdgeInsets.symmetric(vertical: 14, horizontal: 8),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(CustomerTheme.radiusMd),
            border: Border.all(color: accent.withValues(alpha: 0.28)),
          ),
          child: Column(
            children: [
              Container(
                width: 44,
                height: 44,
                decoration: BoxDecoration(
                  color: accent.withValues(alpha: 0.12),
                  shape: BoxShape.circle,
                ),
                child: Icon(action.icon, color: accent, size: 22),
              ),
              const SizedBox(height: 8),
              Text(
                action.label,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                textAlign: TextAlign.center,
                style: TextStyle(
                  fontSize: 11,
                  fontWeight: FontWeight.w800,
                  color: colors.onSurface,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
