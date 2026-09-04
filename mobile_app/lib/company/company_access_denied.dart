import 'package:flutter/material.dart';

import '../brand_theme.dart';

class CompanyAccessDenied extends StatelessWidget {
  const CompanyAccessDenied({
    super.key,
    required this.title,
    required this.message,
    this.accent,
  });

  final String title;
  final String message;
  final Color? accent;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final tone = accent ?? AhramColors.gold;
    return ListView(
      padding: const EdgeInsets.fromLTRB(20, 28, 20, 36),
      children: [
        Container(
          padding: const EdgeInsets.all(22),
          decoration: BoxDecoration(
            color: colors.surface,
            borderRadius: BorderRadius.circular(16),
            border: Border.all(color: tone.withValues(alpha: 0.34)),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Icon(Icons.lock_outline, color: tone, size: 34),
              const SizedBox(height: 14),
              Text(
                title,
                style: TextStyle(
                  fontSize: 20,
                  fontWeight: FontWeight.w900,
                  color: colors.onSurface,
                ),
              ),
              const SizedBox(height: 8),
              Text(
                message,
                style: TextStyle(
                  height: 1.55,
                  fontSize: 15,
                  color: colors.onSurfaceVariant,
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}
