// ============================================================================
// Al-Ahram Pay V3 — 3D Components
// مكونات ثلاثية الأبعاد للتطبيق
// ============================================================================

import 'package:flutter/material.dart';
import 'brand_theme_v3.dart';

// ═════════════════════════════════════════════════════════════════════════════
// بطاقة الرصيد ثلاثية الأبعاد
// ═════════════════════════════════════════════════════════════════════════════

class AhramBalanceCard3D extends StatelessWidget {
  final double balance;
  final String currency;
  final String label;
  final String? subLabel;
  final VoidCallback? onTransferTap;

  const AhramBalanceCard3D({
    super.key,
    required this.balance,
    required this.currency,
    this.label = 'الرصيد المتاح',
    this.subLabel,
    this.onTransferTap,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
      decoration: BoxDecoration(
        gradient: AhramColorsV3.goldCardGradient,
        borderRadius: BorderRadius.circular(24),
        boxShadow: AhramShadows.elevated,
        border: Border.all(
          color: AhramColorsV3.gold.withOpacity(0.25),
          width: 1,
        ),
      ),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(24),
        child: Stack(
          children: [
            // تأثير الضوء العلوي
            Positioned(
              top: -60,
              left: -40,
              child: Container(
                width: 180,
                height: 180,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  gradient: RadialGradient(
                    colors: [
                      AhramColorsV3.primarySky.withOpacity(0.35),
                      Colors.transparent,
                    ],
                  ),
                ),
              ),
            ),
            // تأثير الضوء السفلي
            Positioned(
              bottom: -40,
              right: -20,
              child: Container(
                width: 140,
                height: 140,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  gradient: RadialGradient(
                    colors: [
                      AhramColorsV3.gold.withOpacity(0.15),
                      Colors.transparent,
                    ],
                  ),
                ),
              ),
            ),
            // المحتوى
            Padding(
              padding: const EdgeInsets.all(24),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            label,
                            style: const TextStyle(
                              color: Color(0xFFB8C5D6),
                              fontSize: 14,
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                          if (subLabel != null)
                            Padding(
                              padding: const EdgeInsets.only(top: 4),
                              child: Text(
                                subLabel!,
                                style: TextStyle(
                                  color: AhramColorsV3.goldLight.withOpacity(0.7),
                                  fontSize: 12,
                                  fontWeight: FontWeight.w600,
                                ),
                              ),
                            ),
                        ],
                      ),
                      // أيقونة المحفظة
                      Container(
                        padding: const EdgeInsets.all(10),
                        decoration: BoxDecoration(
                          color: AhramColorsV3.gold.withOpacity(0.15),
                          borderRadius: BorderRadius.circular(14),
                          border: Border.all(
                            color: AhramColorsV3.gold.withOpacity(0.2),
                            width: 1,
                          ),
                        ),
                        child: const Icon(
                          Icons.account_balance_wallet_rounded,
                          color: AhramColorsV3.gold,
                          size: 22,
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 24),
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.baseline,
                    textBaseline: TextBaseline.alphabetic,
                    children: [
                      Text(
                        _formatBalance(balance),
                        style: const TextStyle(
                          color: Colors.white,
                          fontSize: 34,
                          fontWeight: FontWeight.w900,
                          letterSpacing: -0.5,
                          shadows: [
                            Shadow(
                              color: AhramColorsV3.gold,
                              blurRadius: 25,
                              offset: Offset(0, 0),
                            ),
                          ],
                        ),
                      ),
                      const SizedBox(width: 8),
                      Text(
                        currency,
                        style: const TextStyle(
                          color: AhramColorsV3.gold,
                          fontSize: 18,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 20),
                  if (onTransferTap != null)
                    Row(
                      children: [
                        Expanded(
                          child: _QuickActionButton(
                            icon: Icons.add_rounded,
                            label: 'تحويل جديد',
                            onTap: onTransferTap!,
                          ),
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: _QuickActionButton(
                            icon: Icons.receipt_long_rounded,
                            label: 'التقارير',
                            onTap: () {},
                            isSecondary: true,
                          ),
                        ),
                      ],
                    ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  String _formatBalance(double value) {
    return value.toStringAsFixed(2).replaceAllMapped(
      RegExp(r'(?<=\d)(?=(\d{3})+(?:\.|$))'),
      (match) => ',',
    );
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// زر الإجراء السريع
// ═════════════════════════════════════════════════════════════════════════════

class _QuickActionButton extends StatelessWidget {
  final IconData icon;
  final String label;
  final VoidCallback onTap;
  final bool isSecondary;

  const _QuickActionButton({
    required this.icon,
    required this.label,
    required this.onTap,
    this.isSecondary = false,
  });

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(vertical: 12, horizontal: 16),
        decoration: BoxDecoration(
          color: isSecondary
              ? Colors.white.withOpacity(0.08)
              : AhramColorsV3.gold.withOpacity(0.18),
          borderRadius: BorderRadius.circular(12),
          border: Border.all(
            color: isSecondary
                ? Colors.white.withOpacity(0.15)
                : AhramColorsV3.gold.withOpacity(0.3),
            width: 1,
          ),
        ),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(
              icon,
              color: isSecondary ? Colors.white70 : AhramColorsV3.gold,
              size: 18,
            ),
            const SizedBox(width: 8),
            Text(
              label,
              style: TextStyle(
                color: isSecondary ? Colors.white70 : AhramColorsV3.gold,
                fontWeight: FontWeight.w700,
                fontSize: 13,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// زر ثلاثي الأبعاد مع تأثير الضغط
// ═════════════════════════════════════════════════════════════════════════════

class Ahram3DButton extends StatefulWidget {
  final String label;
  final IconData? icon;
  final VoidCallback onPressed;
  final AhramButtonVariant variant;
  final bool isFullWidth;
  final double? height;

  const Ahram3DButton({
    super.key,
    required this.label,
    this.icon,
    required this.onPressed,
    this.variant = AhramButtonVariant.primary,
    this.isFullWidth = true,
    this.height,
  });

  @override
  State<Ahram3DButton> createState() => _Ahram3DButtonState();
}

enum AhramButtonVariant { primary, secondary, success, danger, gold }

class _Ahram3DButtonState extends State<Ahram3DButton>
    with SingleTickerProviderStateMixin {
  late AnimationController _controller;
  late Animation<double> _scaleAnim;
  late Animation<double> _shadowAnim;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      duration: const Duration(milliseconds: 150),
      vsync: this,
    );
    _scaleAnim = Tween<double>(begin: 1.0, end: 0.97).animate(
      CurvedAnimation(parent: _controller, curve: Curves.easeOutCubic),
    );
    _shadowAnim = Tween<double>(begin: 1.0, end: 0.3).animate(
      CurvedAnimation(parent: _controller, curve: Curves.easeOutCubic),
    );
  }

  Color get _baseColor => switch (widget.variant) {
    AhramButtonVariant.primary => AhramColorsV3.primarySky,
    AhramButtonVariant.secondary => AhramColorsV3.primaryDeep,
    AhramButtonVariant.success => AhramColorsV3.emerald,
    AhramButtonVariant.danger => AhramColorsV3.danger,
    AhramButtonVariant.gold => AhramColorsV3.gold,
  };

  void _onTapDown(TapDownDetails details) => _controller.forward();
  void _onTapUp(TapUpDetails details) => _controller.reverse();
  void _onTapCancel() => _controller.reverse();

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTapDown: _onTapDown,
      onTapUp: _onTapUp,
      onTapCancel: _onTapCancel,
      onTap: widget.onPressed,
      child: AnimatedBuilder(
        animation: _controller,
        builder: (context, child) {
          return Transform.scale(
            scale: _scaleAnim.value,
            child: Container(
              width: widget.isFullWidth ? double.infinity : null,
              height: widget.height ?? 56,
              decoration: BoxDecoration(
                gradient: LinearGradient(
                  begin: Alignment.topCenter,
                  end: Alignment.bottomCenter,
                  colors: [
                    _baseColor,
                    _baseColor.withOpacity(0.85),
                  ],
                ),
                borderRadius: BorderRadius.circular(16),
                boxShadow: [
                  BoxShadow(
                    color: _baseColor.withOpacity(0.4 * _shadowAnim.value),
                    blurRadius: 14 * _shadowAnim.value,
                    offset: Offset(0, 8 * _shadowAnim.value),
                  ),
                  BoxShadow(
                    color: _baseColor.withOpacity(0.2 * _shadowAnim.value),
                    blurRadius: 24 * _shadowAnim.value,
                    offset: Offset(0, 14 * _shadowAnim.value),
                  ),
                  BoxShadow(
                    color: Colors.white.withOpacity(0.15),
                    blurRadius: 4,
                    offset: const Offset(0, -2),
                  ),
                ],
              ),
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 24),
                child: Row(
                  mainAxisSize: widget.isFullWidth
                      ? MainAxisSize.max
                      : MainAxisSize.min,
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    if (widget.icon != null) ...[
                      Icon(widget.icon, color: Colors.white, size: 20),
                      const SizedBox(width: 10),
                    ],
                    Text(
                      widget.label,
                      style: const TextStyle(
                        color: Colors.white,
                        fontWeight: FontWeight.w800,
                        fontSize: 15,
                      ),
                    ),
                  ],
                ),
              ),
            ),
          );
        },
      ),
    );
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// بطاقة خدمة ثلاثية الأبعاد
// ═════════════════════════════════════════════════════════════════════════════

class AhramServiceCard3D extends StatelessWidget {
  final String title;
  final IconData icon;
  final Color color;
  final VoidCallback onTap;
  final bool isNew;
  final String? subtitle;

  const AhramServiceCard3D({
    super.key,
    required this.title,
    required this.icon,
    required this.color,
    required this.onTap,
    this.isNew = false,
    this.subtitle,
  });

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        decoration: BoxDecoration(
          color: Theme.of(context).brightness == Brightness.dark
              ? AhramColorsV3.surfaceDark
              : Colors.white,
          borderRadius: BorderRadius.circular(20),
          boxShadow: [
            BoxShadow(
              color: color.withOpacity(0.18),
              blurRadius: 16,
              offset: const Offset(0, 8),
            ),
            BoxShadow(
              color: Colors.black.withOpacity(0.04),
              blurRadius: 8,
              offset: const Offset(0, 3),
            ),
          ],
        ),
        child: ClipRRect(
          borderRadius: BorderRadius.circular(20),
          child: Stack(
            children: [
              // دائرة خلفية ملونة
              Positioned(
                top: -25,
                right: -25,
                child: Container(
                  width: 90,
                  height: 90,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    color: color.withOpacity(0.10),
                  ),
                ),
              ),
              // محتوى البطاقة
              Padding(
                padding: const EdgeInsets.all(20),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Container(
                      padding: const EdgeInsets.all(12),
                      decoration: BoxDecoration(
                        color: color.withOpacity(0.12),
                        borderRadius: BorderRadius.circular(14),
                      ),
                      child: Icon(icon, color: color, size: 26),
                    ),
                    const Spacer(),
                    Text(
                      title,
                      style: TextStyle(
                        fontSize: 15,
                        fontWeight: FontWeight.w800,
                        color: Theme.of(context).brightness == Brightness.dark
                            ? Colors.white
                            : AhramColorsV3.textPrimary,
                      ),
                    ),
                    if (subtitle != null)
                      Padding(
                        padding: const EdgeInsets.only(top: 4),
                        child: Text(
                          subtitle!,
                          style: TextStyle(
                            fontSize: 12,
                            fontWeight: FontWeight.w600,
                            color: AhramColorsV3.textMuted,
                          ),
                        ),
                      ),
                    if (isNew)
                      Container(
                        margin: const EdgeInsets.only(top: 8),
                        padding: const EdgeInsets.symmetric(
                          horizontal: 10,
                          vertical: 4,
                        ),
                        decoration: BoxDecoration(
                          color: AhramColorsV3.gold.withOpacity(0.15),
                          borderRadius: BorderRadius.circular(8),
                        ),
                        child: const Text(
                          'جديد',
                          style: TextStyle(
                            fontSize: 11,
                            fontWeight: FontWeight.w800,
                            color: AhramColorsV3.gold,
                          ),
                        ),
                      ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// مؤشر التحميل المخصص
// ═════════════════════════════════════════════════════════════════════════════

class AhramLoadingIndicator extends StatefulWidget {
  final double size;
  final Color? color;
  final double strokeWidth;

  const AhramLoadingIndicator({
    super.key,
    this.size = 48,
    this.color,
    this.strokeWidth = 3,
  });

  @override
  State<AhramLoadingIndicator> createState() => _AhramLoadingIndicatorState();
}

class _AhramLoadingIndicatorState extends State<AhramLoadingIndicator>
    with TickerProviderStateMixin {
  late AnimationController _outerController;
  late AnimationController _innerController;

  @override
  void initState() {
    super.initState();
    _outerController = AnimationController(
      duration: const Duration(milliseconds: 2000),
      vsync: this,
    )..repeat();
    _innerController = AnimationController(
      duration: const Duration(milliseconds: 1500),
      vsync: this,
    )..repeat();
  }

  @override
  Widget build(BuildContext context) {
    final mainColor = widget.color ?? AhramColorsV3.primarySky;

    return SizedBox(
      width: widget.size,
      height: widget.size,
      child: Stack(
        alignment: Alignment.center,
        children: [
          // الحلقة الخارجية
          RotationTransition(
            turns: _outerController,
            child: SizedBox(
              width: widget.size,
              height: widget.size,
              child: CircularProgressIndicator(
                strokeWidth: widget.strokeWidth,
                valueColor: AlwaysStoppedAnimation(mainColor.withOpacity(0.25)),
              ),
            ),
          ),
          // الحلقة الداخلية
          RotationTransition(
            turns: ReverseAnimation(_innerController),
            child: SizedBox(
              width: widget.size * 0.7,
              height: widget.size * 0.7,
              child: CircularProgressIndicator(
                strokeWidth: widget.strokeWidth,
                valueColor: AlwaysStoppedAnimation(mainColor),
              ),
            ),
          ),
          // النقطة الذهبية المركزية
          Container(
            width: widget.size * 0.15,
            height: widget.size * 0.15,
            decoration: const BoxDecoration(
              color: AhramColorsV3.gold,
              shape: BoxShape.circle,
              boxShadow: [
                BoxShadow(
                  color: AhramColorsV3.gold,
                  blurRadius: 8,
                  spreadRadius: 1,
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  @override
  void dispose() {
    _outerController.dispose();
    _innerController.dispose();
    super.dispose();
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// شريط التنقل السفلي العائم
// ═════════════════════════════════════════════════════════════════════════════

class AhramFloatingNavBar extends StatelessWidget {
  final int currentIndex;
  final ValueChanged<int> onTap;
  final VoidCallback? onCenterTap;

  const AhramFloatingNavBar({
    super.key,
    required this.currentIndex,
    required this.onTap,
    this.onCenterTap,
  });

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;

    return Container(
      margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 8),
      decoration: BoxDecoration(
        color: isDark ? const Color(0xFF162B3B) : Colors.white,
        borderRadius: BorderRadius.circular(24),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withOpacity(0.1),
            blurRadius: 24,
            offset: const Offset(0, -4),
          ),
          BoxShadow(
            color: Colors.black.withOpacity(0.04),
            blurRadius: 8,
            offset: const Offset(0, -1),
          ),
        ],
      ),
      child: SafeArea(
        child: Row(
          mainAxisAlignment: MainAxisAlignment.spaceAround,
          children: [
            _NavItem(
              icon: Icons.home_rounded,
              label: 'الرئيسية',
              isActive: currentIndex == 0,
              onTap: () => onTap(0),
            ),
            _NavItem(
              icon: Icons.swap_horiz_rounded,
              label: 'تحويل',
              isActive: currentIndex == 1,
              onTap: () => onTap(1),
            ),
            // زر العائم المركزي
            GestureDetector(
              onTap: onCenterTap,
              child: Container(
                width: 56,
                height: 56,
                margin: const EdgeInsets.symmetric(horizontal: 8),
                decoration: BoxDecoration(
                  gradient: AhramColorsV3.primaryButtonGradient,
                  shape: BoxShape.circle,
                  boxShadow: [
                    BoxShadow(
                      color: AhramColorsV3.primarySky.withOpacity(0.4),
                      blurRadius: 16,
                      offset: const Offset(0, 6),
                    ),
                    BoxShadow(
                      color: AhramColorsV3.primarySky.withOpacity(0.2),
                      blurRadius: 8,
                      offset: const Offset(0, 3),
                    ),
                  ],
                ),
                child: const Icon(
                  Icons.add,
                  color: Colors.white,
                  size: 28,
                ),
              ),
            ),
            _NavItem(
              icon: Icons.bar_chart_rounded,
              label: 'تقارير',
              isActive: currentIndex == 2,
              onTap: () => onTap(2),
            ),
            _NavItem(
              icon: Icons.person_outline_rounded,
              label: 'حسابي',
              isActive: currentIndex == 3,
              onTap: () => onTap(3),
            ),
          ],
        ),
      ),
    );
  }
}

class _NavItem extends StatelessWidget {
  final IconData icon;
  final String label;
  final bool isActive;
  final VoidCallback onTap;

  const _NavItem({
    required this.icon,
    required this.label,
    required this.isActive,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 200),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        decoration: isActive
            ? BoxDecoration(
                color: AhramColorsV3.primarySky.withOpacity(0.1),
                borderRadius: BorderRadius.circular(12),
              )
            : null,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              icon,
              color: isActive
                  ? AhramColorsV3.primarySky
                  : AhramColorsV3.textMuted,
              size: 24,
            ),
            const SizedBox(height: 4),
            Text(
              label,
              style: TextStyle(
                fontSize: 11,
                fontWeight: FontWeight.w700,
                color: isActive
                    ? AhramColorsV3.primarySky
                    : AhramColorsV3.textMuted,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// حاوية قسم ثلاثية الأبعاد
// ═════════════════════════════════════════════════════════════════════════════

class AhramSectionCard extends StatelessWidget {
  final Widget child;
  final EdgeInsets? padding;
  final Color? color;

  const AhramSectionCard({
    super.key,
    required this.child,
    this.padding,
    this.color,
  });

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;

    return Container(
      margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      padding: padding ?? const EdgeInsets.all(20),
      decoration: BoxDecoration(
        color: color ??
            (isDark ? AhramColorsV3.surfaceDark : Colors.white),
        borderRadius: BorderRadius.circular(20),
        boxShadow: AhramShadows.card,
        border: Border.all(
          color: isDark
              ? AhramColorsV3.dividerDark.withOpacity(0.3)
              : AhramColorsV3.divider,
          width: 1,
        ),
      ),
      child: child,
    );
  }
}
