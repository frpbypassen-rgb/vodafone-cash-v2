import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../customer_theme.dart';

class CustomerCommandAction {
  const CustomerCommandAction({
    required this.label,
    required this.subtitle,
    required this.icon,
    required this.onSelected,
  });

  final String label;
  final String subtitle;
  final IconData icon;
  final VoidCallback onSelected;
}

Future<void> showCustomerCommandPalette(
  BuildContext context, {
  required List<CustomerCommandAction> actions,
}) async {
  await showDialog<void>(
    context: context,
    builder: (dialogContext) {
      return Shortcuts(
        shortcuts: {
          LogicalKeySet(LogicalKeyboardKey.escape): const DismissIntent(),
        },
        child: Actions(
          actions: {
            DismissIntent: CallbackAction<DismissIntent>(
              onInvoke: (_) {
                Navigator.pop(dialogContext);
                return null;
              },
            ),
          },
          child: Dialog(
            insetPadding: const EdgeInsets.symmetric(horizontal: 24, vertical: 48),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 520),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Padding(
                    padding: const EdgeInsets.fromLTRB(18, 16, 18, 8),
                    child: Row(
                      children: [
                        Icon(Icons.search, color: CustomerTheme.action),
                        const SizedBox(width: 10),
                        const Expanded(
                          child: Text(
                            'بحث سريع',
                            style: TextStyle(
                              fontWeight: FontWeight.w900,
                              fontSize: 18,
                            ),
                          ),
                        ),
                        Container(
                          padding: const EdgeInsets.symmetric(
                            horizontal: 8,
                            vertical: 4,
                          ),
                          decoration: BoxDecoration(
                            color: CustomerTheme.canvas.withValues(alpha: 0.08),
                            borderRadius: BorderRadius.circular(6),
                          ),
                          child: const Text(
                            'Ctrl+K',
                            style: TextStyle(
                              fontSize: 11,
                              fontWeight: FontWeight.w800,
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                  const Divider(height: 1),
                  Flexible(
                    child: ListView.separated(
                      shrinkWrap: true,
                      padding: const EdgeInsets.symmetric(vertical: 8),
                      itemCount: actions.length,
                      separatorBuilder: (_, _) => const Divider(height: 1, indent: 56),
                      itemBuilder: (context, index) {
                        final action = actions[index];
                        return ListTile(
                          leading: Container(
                            width: 40,
                            height: 40,
                            decoration: BoxDecoration(
                              color: CustomerTheme.action.withValues(alpha: 0.12),
                              borderRadius: BorderRadius.circular(8),
                            ),
                            child: Icon(action.icon, color: CustomerTheme.action),
                          ),
                          title: Text(
                            action.label,
                            style: const TextStyle(fontWeight: FontWeight.w800),
                          ),
                          subtitle: Text(action.subtitle),
                          onTap: () {
                            Navigator.pop(dialogContext);
                            action.onSelected();
                          },
                        );
                      },
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      );
    },
  );
}

class CustomerCommandPaletteIntent extends Intent {
  const CustomerCommandPaletteIntent();
}
