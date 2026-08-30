import 'dart:math' as math;

import 'package:flutter/material.dart';

import 'brand_theme.dart';
import 'executor_ui.dart';

/// Shared visual language for the rebuilt mobile workspace.
///
/// This deliberately contains no business logic. Existing role pages remain
/// responsible for their API calls while this layer gives every account type a
/// consistent, responsive application shell.
abstract final class Ahram2030 {
  static const navy = Color(0xFF071A33);
  static const blue = Color(0xFF1769E0);
  static const jade = Color(0xFF0E9B83);
  static const gold = Color(0xFFF0BE45);
  static const cloud = Color(0xFFF4F7FC);

  static Color canvas(BuildContext context) =>
      Theme.of(context).brightness == Brightness.dark
      ? const Color(0xFF0D1725)
      : cloud;

  static Color surface(BuildContext context) =>
      Theme.of(context).brightness == Brightness.dark
      ? const Color(0xFF142235)
      : Colors.white;
}

class Ahram2030Workspace extends StatelessWidget {
  const Ahram2030Workspace({
    super.key,
    required this.child,
    this.executor = false,
  });

  final Widget child;
  final bool executor;

  @override
  Widget build(BuildContext context) {
    if (executor) return ExecutorWorkspaceBackground(child: child);
    return ColoredBox(
      color: Ahram2030.canvas(context),
      child: CustomPaint(painter: const _Ahram2030Grid(), child: child),
    );
  }
}

class Ahram2030TopBar extends StatelessWidget implements PreferredSizeWidget {
  const Ahram2030TopBar({
    super.key,
    required this.title,
    required this.subtitle,
    required this.accountLabel,
    required this.actions,
    this.balance,
    this.executor = false,
  });

  final String title;
  final String subtitle;
  final String accountLabel;
  final List<Widget> actions;
  final double? balance;
  final bool executor;

  @override
  Size get preferredSize => const Size.fromHeight(82);

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final isCompact = MediaQuery.sizeOf(context).width < 390;
    return AppBar(
      toolbarHeight: 78,
      titleSpacing: 16,
      backgroundColor: executor
          ? ExecutorUiColors.surface(context)
          : Ahram2030.surface(context),
      bottom: const PreferredSize(
        preferredSize: Size.fromHeight(4),
        child: _Ahram2030Spectrum(),
      ),
      title: Row(
        children: [
          _BrandTile(executor: executor),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: colors.onSurface,
                    fontSize: isCompact ? 14 : 16,
                    fontWeight: FontWeight.w900,
                  ),
                ),
                const SizedBox(height: 1),
                Text(
                  subtitle.isEmpty ? accountLabel : subtitle,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: colors.onSurfaceVariant,
                    fontSize: 10,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ],
            ),
          ),
          if (balance != null && !isCompact) ...[
            const SizedBox(width: 8),
            _BalanceChip(amount: balance!),
          ],
        ],
      ),
      actions: actions,
    );
  }
}

class Ahram2030Navigation extends StatelessWidget {
  const Ahram2030Navigation({
    super.key,
    required this.items,
    required this.index,
    required this.onSelected,
    this.executor = false,
  });

  final List<Ahram2030NavItem> items;
  final int index;
  final ValueChanged<int> onSelected;
  final bool executor;

  @override
  Widget build(BuildContext context) {
    final dark = Theme.of(context).brightness == Brightness.dark;
    final width = MediaQuery.sizeOf(context).width;
    final itemWidth = math.max(70.0, width / math.min(items.length, 5));
    return SafeArea(
      top: false,
      minimum: const EdgeInsets.fromLTRB(10, 4, 10, 9),
      child: Container(
        height: 74,
        decoration: BoxDecoration(
          color: executor
              ? ExecutorUiColors.surface(context)
              : Ahram2030.surface(context),
          borderRadius: BorderRadius.circular(18),
          border: Border.all(
            color: executor ? ExecutorUiColors.line(context) : AhramColors.line,
          ),
          boxShadow: [
            BoxShadow(
              color: Colors.black.withValues(alpha: dark ? .25 : .12),
              blurRadius: 22,
              offset: const Offset(0, 9),
            ),
          ],
        ),
        child: ListView.builder(
          reverse: Directionality.of(context) == TextDirection.rtl,
          scrollDirection: Axis.horizontal,
          itemCount: items.length,
          itemBuilder: (context, itemIndex) {
            final item = items[itemIndex];
            final selected = index == itemIndex;
            return SizedBox(
              width: itemWidth,
              child: InkWell(
                borderRadius: BorderRadius.circular(16),
                onTap: () => onSelected(itemIndex),
                child: AnimatedContainer(
                  duration: const Duration(milliseconds: 180),
                  margin: const EdgeInsets.all(5),
                  padding: const EdgeInsets.symmetric(horizontal: 4),
                  decoration: BoxDecoration(
                    color: selected
                        ? (executor ? Ahram2030.blue : Ahram2030.jade)
                              .withValues(alpha: dark ? .25 : .12)
                        : Colors.transparent,
                    borderRadius: BorderRadius.circular(14),
                    border: Border.all(
                      color: selected
                          ? (executor ? Ahram2030.blue : Ahram2030.jade)
                                .withValues(alpha: .38)
                          : Colors.transparent,
                    ),
                  ),
                  child: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      Icon(
                        item.icon,
                        size: 23,
                        color: selected
                            ? (executor ? Ahram2030.blue : Ahram2030.jade)
                            : Theme.of(context).colorScheme.onSurfaceVariant,
                      ),
                      const SizedBox(height: 3),
                      Text(
                        item.label,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          fontSize: 10,
                          fontWeight: selected
                              ? FontWeight.w900
                              : FontWeight.w700,
                          color: selected
                              ? Theme.of(context).colorScheme.onSurface
                              : Theme.of(context).colorScheme.onSurfaceVariant,
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            );
          },
        ),
      ),
    );
  }
}

class Ahram2030NavItem {
  const Ahram2030NavItem({required this.label, required this.icon});

  final String label;
  final IconData icon;
}

class _BrandTile extends StatelessWidget {
  const _BrandTile({required this.executor});

  final bool executor;

  @override
  Widget build(BuildContext context) => Container(
    width: 43,
    height: 43,
    decoration: BoxDecoration(
      borderRadius: BorderRadius.circular(14),
      gradient: LinearGradient(
        begin: Alignment.topRight,
        end: Alignment.bottomLeft,
        colors: executor
            ? const [Ahram2030.blue, Ahram2030.jade]
            : const [Ahram2030.jade, Ahram2030.blue],
      ),
      boxShadow: [
        BoxShadow(
          color: Ahram2030.blue.withValues(alpha: .24),
          blurRadius: 12,
          offset: const Offset(0, 5),
        ),
      ],
    ),
    child: const Icon(
      Icons.account_balance_wallet_rounded,
      color: Colors.white,
    ),
  );
}

class _BalanceChip extends StatelessWidget {
  const _BalanceChip({required this.amount});
  final double amount;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsetsDirectional.fromSTEB(10, 7, 10, 7),
    decoration: BoxDecoration(
      color: Ahram2030.jade.withValues(alpha: .09),
      borderRadius: BorderRadius.circular(13),
      border: Border.all(color: Ahram2030.jade.withValues(alpha: .28)),
    ),
    child: Text(
      '${amount.toStringAsFixed(0)} ج.م',
      textDirection: TextDirection.ltr,
      style: const TextStyle(
        color: Ahram2030.navy,
        fontWeight: FontWeight.w900,
        fontSize: 12,
      ),
    ),
  );
}

class _Ahram2030Spectrum extends StatelessWidget {
  const _Ahram2030Spectrum();

  @override
  Widget build(BuildContext context) => const Row(
    children: [
      Expanded(child: ColoredBox(color: Ahram2030.jade)),
      Expanded(child: ColoredBox(color: Ahram2030.gold)),
      Expanded(child: ColoredBox(color: Ahram2030.blue)),
    ],
  );
}

class _Ahram2030Grid extends CustomPainter {
  const _Ahram2030Grid();

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = Ahram2030.navy.withValues(alpha: .035)
      ..strokeWidth = 1;
    const step = 64.0;
    for (double x = 0; x < size.width; x += step) {
      canvas.drawLine(Offset(x, 0), Offset(x, size.height), paint);
    }
    for (double y = 0; y < size.height; y += step) {
      canvas.drawLine(Offset(0, y), Offset(size.width, y), paint);
    }
  }

  @override
  bool shouldRepaint(covariant _Ahram2030Grid oldDelegate) => false;
}
