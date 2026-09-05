import 'package:flutter/material.dart';

import '../customer_theme.dart';

class CustomerInspectorPanel extends StatelessWidget {
  const CustomerInspectorPanel({
    super.key,
    this.title = 'التفاصيل',
    this.child,
  });

  final String title;
  final Widget? child;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Container(
      width: CustomerTheme.inspectorWidth,
      decoration: BoxDecoration(
        color: colors.surface,
        border: Border(
          right: BorderSide(color: colors.outlineVariant),
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 18, 16, 12),
            child: Text(
              title,
              style: TextStyle(
                fontWeight: FontWeight.w900,
                fontSize: CustomerTheme.titleFs,
                color: colors.onSurface,
              ),
            ),
          ),
          Divider(height: 1, color: colors.outlineVariant),
          Expanded(
            child: child == null
                ? Center(
                    child: Text(
                      'اختر عملية أو أكمل التحويل لعرض المعاينة.',
                      textAlign: TextAlign.center,
                      style: TextStyle(
                        color: colors.onSurfaceVariant,
                        fontSize: 13,
                      ),
                    ),
                  )
                : SingleChildScrollView(
                    padding: const EdgeInsets.all(16),
                    child: child!,
                  ),
          ),
        ],
      ),
    );
  }
}
