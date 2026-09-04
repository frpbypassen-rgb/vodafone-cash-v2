import 'package:flutter/material.dart';

import '../brand_theme.dart';

int transferCatalogColumns(double width) {
  if (width >= 600) return 3;
  if (width >= 390) return 2;
  return 1;
}

class TransferStepBar extends StatelessWidget {
  const TransferStepBar({super.key, required this.currentStep});

  /// 1 service, 2 details, 3 review, 4 seal.
  final int currentStep;

  static const steps = <String>['خدمة', 'بيانات', 'مراجعة', 'ختم'];

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 10, 16, 6),
      child: Row(
        children: [
          for (var index = 0; index < steps.length; index++) ...[
            if (index > 0)
              Expanded(
                child: Container(
                  height: 2,
                  margin: const EdgeInsets.symmetric(horizontal: 6),
                  color: currentStep > index
                      ? AhramColors.gold
                      : colors.outlineVariant,
                ),
              ),
            _StepDot(
              label: steps[index],
              number: index + 1,
              active: currentStep >= index + 1,
              current: currentStep == index + 1,
            ),
          ],
        ],
      ),
    );
  }
}

class _StepDot extends StatelessWidget {
  const _StepDot({
    required this.label,
    required this.number,
    required this.active,
    required this.current,
  });

  final String label;
  final int number;
  final bool active;
  final bool current;

  @override
  Widget build(BuildContext context) {
    final fill = active
        ? AhramColors.gold
        : Theme.of(context).colorScheme.surface;
    final ink = active
        ? AhramColors.onGold
        : Theme.of(context).colorScheme.onSurfaceVariant;
    return Column(
      children: [
        Container(
          width: 26,
          height: 26,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: fill,
            shape: BoxShape.circle,
            border: Border.all(
              color: current ? AhramColors.ink : fill,
              width: current ? 2 : 1,
            ),
          ),
          child: Text(
            '$number',
            style: TextStyle(
              color: ink,
              fontSize: 12,
              fontWeight: FontWeight.w900,
            ),
          ),
        ),
        const SizedBox(height: 4),
        Text(
          label,
          style: TextStyle(
            fontSize: 10,
            fontWeight: current ? FontWeight.w900 : FontWeight.w700,
            color: active
                ? Theme.of(context).colorScheme.onSurface
                : Theme.of(context).colorScheme.onSurfaceVariant,
          ),
        ),
      ],
    );
  }
}
