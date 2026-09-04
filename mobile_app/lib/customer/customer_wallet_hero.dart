import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../brand_theme.dart';

class CustomerWalletHero extends StatelessWidget {
  const CustomerWalletHero({
    super.key,
    required this.balance,
    required this.available,
    this.currency = 'د.ل',
  });

  final double balance;
  final double available;
  final String currency;

  static String formatMoney(double value) {
    return NumberFormat.currency(
      locale: 'en',
      symbol: '',
      decimalDigits: 2,
    ).format(value).trim();
  }

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final width = MediaQuery.sizeOf(context).width;
    final stacked = width < 390;
    final balanceColor = balance < 0
        ? AhramColors.danger
        : (balance > 0 ? AhramColors.emerald : colors.onSurface);
    final availableColor = available < 0
        ? AhramColors.danger
        : AhramColors.gold;

    final cards = [
      _WalletMetric(
        label: 'الرصيد',
        value: formatMoney(balance),
        currency: currency,
        color: balanceColor,
      ),
      _WalletMetric(
        label: 'المتاح للتحويل',
        value: formatMoney(available),
        currency: currency,
        color: availableColor,
      ),
    ];

    return Container(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 14),
      decoration: BoxDecoration(
        color: AhramColors.ink,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: AhramColors.gold.withValues(alpha: 0.38)),
      ),
      child: stacked
          ? Column(
              children: [
                cards[0],
                const SizedBox(height: 12),
                Divider(color: Colors.white.withValues(alpha: 0.12)),
                const SizedBox(height: 12),
                cards[1],
              ],
            )
          : Row(
              children: [
                Expanded(child: cards[0]),
                Container(
                  width: 1,
                  height: 56,
                  margin: const EdgeInsets.symmetric(horizontal: 12),
                  color: Colors.white.withValues(alpha: 0.12),
                ),
                Expanded(child: cards[1]),
              ],
            ),
    );
  }
}

class _WalletMetric extends StatelessWidget {
  const _WalletMetric({
    required this.label,
    required this.value,
    required this.currency,
    required this.color,
  });

  final String label;
  final String value;
  final String currency;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          label,
          style: TextStyle(
            color: Colors.white.withValues(alpha: 0.72),
            fontWeight: FontWeight.w700,
            fontSize: 13,
          ),
        ),
        const SizedBox(height: 6),
        FittedBox(
          fit: BoxFit.scaleDown,
          alignment: AlignmentDirectional.centerStart,
          child: Text(
            '$value $currency',
            maxLines: 1,
            style: TextStyle(
              color: color,
              fontWeight: FontWeight.w900,
              fontSize: 22,
              height: 1.1,
            ),
          ),
        ),
      ],
    );
  }
}
