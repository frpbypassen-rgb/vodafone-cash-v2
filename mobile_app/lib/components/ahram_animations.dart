// ============================================================================
// Al-Ahram Pay V3 — Animations & Utilities
// تأثيرات حركة وأدوات مساعدة
// ============================================================================

import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'brand_theme_v3.dart';

// ═════════════════════════════════════════════════════════════════════════════
// دخول متتابع (Staggered Animation)
// ═════════════════════════════════════════════════════════════════════════════

class AhramStaggeredList extends StatelessWidget {
  final List<Widget> children;
  final Duration delay;
  final Duration duration;
  final Axis direction;

  const AhramStaggeredList({
    super.key,
    required this.children,
    this.delay = const Duration(milliseconds: 80),
    this.duration = const Duration(milliseconds: 500),
    this.direction = Axis.vertical,
  });

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: List.generate(children.length, (index) {
        return _StaggeredItem(
          index: index,
          delay: delay,
          duration: duration,
          direction: direction,
          child: children[index],
        );
      }),
    );
  }
}

class _StaggeredItem extends StatefulWidget {
  final int index;
  final Duration delay;
  final Duration duration;
  final Axis direction;
  final Widget child;

  const _StaggeredItem({
    required this.index,
    required this.delay,
    required this.duration,
    required this.direction,
    required this.child,
  });

  @override
  State<_StaggeredItem> createState() => _StaggeredItemState();
}

class _StaggeredItemState extends State<_StaggeredItem>
    with SingleTickerProviderStateMixin {
  late AnimationController _controller;
  late Animation<double> _opacityAnim;
  late Animation<Offset> _slideAnim;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      duration: widget.duration,
      vsync: this,
    );

    _opacityAnim = Tween<double>(begin: 0, end: 1).animate(
      CurvedAnimation(parent: _controller, curve: Curves.easeOutCubic),
    );

    final offset = widget.direction == Axis.vertical
        ? const Offset(0, 30)
        : const Offset(30, 0);

    _slideAnim = Tween<Offset>(begin: offset, end: Offset.zero).animate(
      CurvedAnimation(parent: _controller, curve: Curves.easeOutCubic),
    );

    Future.delayed(widget.delay * widget.index, () {
      if (mounted) _controller.forward();
    });
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _controller,
      builder: (context, child) {
        return Opacity(
          opacity: _opacityAnim.value,
          child: Transform.translate(
            offset: _slideAnim.value,
            child: child,
          ),
        );
      },
      child: widget.child,
    );
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// عداد رصيد متحرك
// ═════════════════════════════════════════════════════════════════════════════

class AhramAnimatedCounter extends StatefulWidget {
  final double targetValue;
  final String? suffix;
  final TextStyle? style;
  final Duration duration;

  const AhramAnimatedCounter({
    super.key,
    required this.targetValue,
    this.suffix,
    this.style,
    this.duration = const Duration(milliseconds: 1500),
  });

  @override
  State<AhramAnimatedCounter> createState() => _AhramAnimatedCounterState();
}

class _AhramAnimatedCounterState extends State<AhramAnimatedCounter>
    with TickerProviderStateMixin {
  late AnimationController _controller;
  late Animation<double> _animation;
  double _previousValue = 0;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(duration: widget.duration, vsync: this);
    _animateTo(widget.targetValue);
  }

  @override
  void didUpdateWidget(AhramAnimatedCounter oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.targetValue != widget.targetValue) {
      _previousValue = oldWidget.targetValue;
      _animateTo(widget.targetValue);
    }
  }

  void _animateTo(double target) {
    _animation = Tween<double>(begin: _previousValue, end: target).animate(
      CurvedAnimation(parent: _controller, curve: Curves.easeOutExpo),
    );
    _controller.forward(from: 0);
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _animation,
      builder: (context, child) {
        return Text(
          '${_formatNumber(_animation.value)}${widget.suffix ?? ''}',
          style: widget.style ??
              const TextStyle(
                fontSize: 32,
                fontWeight: FontWeight.w900,
                color: Colors.white,
                shadows: [
                  Shadow(
                    color: AhramColorsV3.gold,
                    blurRadius: 20,
                  ),
                ],
              ),
        );
      },
    );
  }

  String _formatNumber(double value) {
    return value.toStringAsFixed(2).replaceAllMapped(
      RegExp(r'(?<=\d)(?=(\d{3})+(?:\.|$))'),
      (match) => ',',
    );
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// تأثير النبض (Pulse)
// ═════════════════════════════════════════════════════════════════════════════

class AhramPulseEffect extends StatefulWidget {
  final Widget child;
  final Duration duration;

  const AhramPulseEffect({
    super.key,
    required this.child,
    this.duration = const Duration(milliseconds: 2000),
  });

  @override
  State<AhramPulseEffect> createState() => _AhramPulseEffectState();
}

class _AhramPulseEffectState extends State<AhramPulseEffect>
    with SingleTickerProviderStateMixin {
  late AnimationController _controller;
  late Animation<double> _scaleAnim;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      duration: widget.duration,
      vsync: this,
    )..repeat(reverse: true);

    _scaleAnim = Tween<double>(begin: 1.0, end: 1.08).animate(
      CurvedAnimation(parent: _controller, curve: Curves.easeInOutSine),
    );
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _controller,
      builder: (context, child) {
        return Transform.scale(
          scale: _scaleAnim.value,
          child: child,
        );
      },
      child: widget.child,
    );
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// صفحة نجاح العملية
// ═════════════════════════════════════════════════════════════════════════════

class AhramSuccessScreen extends StatefulWidget {
  final String title;
  final String amount;
  final String? subtitle;
  final String primaryActionLabel;
  final VoidCallback onPrimaryAction;
  final String? secondaryActionLabel;
  final VoidCallback? onSecondaryAction;

  const AhramSuccessScreen({
    super.key,
    required this.title,
    required this.amount,
    this.subtitle,
    required this.primaryActionLabel,
    required this.onPrimaryAction,
    this.secondaryActionLabel,
    this.onSecondaryAction,
  });

  @override
  State<AhramSuccessScreen> createState() => _AhramSuccessScreenState();
}

class _AhramSuccessScreenState extends State<AhramSuccessScreen>
    with TickerProviderStateMixin {
  late AnimationController _circleController;
  late AnimationController _contentController;
  late Animation<double> _circleScale;
  late Animation<double> _circleOpacity;
  late Animation<double> _contentOpacity;
  late Animation<Offset> _contentSlide;

  @override
  void initState() {
    super.initState();
    _circleController = AnimationController(
      duration: const Duration(milliseconds: 800),
      vsync: this,
    );
    _contentController = AnimationController(
      duration: const Duration(milliseconds: 600),
      vsync: this,
    );

    _circleScale = Tween<double>(begin: 0, end: 1).animate(
      CurvedAnimation(parent: _circleController, curve: Curves.elasticOut),
    );
    _circleOpacity = Tween<double>(begin: 0, end: 1).animate(
      CurvedAnimation(parent: _circleController, curve: Curves.easeOut),
    );
    _contentOpacity = Tween<double>(begin: 0, end: 1).animate(
      CurvedAnimation(parent: _contentController, curve: Curves.easeOut),
    );
    _contentSlide = Tween<Offset>(
      begin: const Offset(0, 30),
      end: Offset.zero,
    ).animate(
      CurvedAnimation(parent: _contentController, curve: Curves.easeOutCubic),
    );

    _circleController.forward().then((_) {
      _contentController.forward();
    });
  }

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;

    return Scaffold(
      backgroundColor: isDark ? AhramColorsV3.backgroundDark : Colors.white,
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(32),
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                // دائرة النجاح
                AnimatedBuilder(
                  animation: _circleController,
                  builder: (context, child) {
                    return Opacity(
                      opacity: _circleOpacity.value,
                      child: Transform.scale(
                        scale: _circleScale.value,
                        child: Container(
                          width: 120,
                          height: 120,
                          decoration: BoxDecoration(
                            gradient: AhramColorsV3.successGradient,
                            shape: BoxShape.circle,
                            boxShadow: [
                              BoxShadow(
                                color: AhramColorsV3.emerald.withOpacity(0.4),
                                blurRadius: 30,
                                spreadRadius: 8,
                              ),
                            ],
                          ),
                          child: const Icon(
                            Icons.check_rounded,
                            color: Colors.white,
                            size: 56,
                          ),
                        ),
                      ),
                    );
                  },
                ),
                const SizedBox(height: 40),
                // المحتوى
                AnimatedBuilder(
                  animation: _contentController,
                  builder: (context, child) {
                    return Opacity(
                      opacity: _contentOpacity.value,
                      child: Transform.translate(
                        offset: _contentSlide.value,
                        child: child,
                      ),
                    );
                  },
                  child: Column(
                    children: [
                      Text(
                        widget.title,
                        style: TextStyle(
                          color: isDark ? Colors.white : AhramColorsV3.textPrimary,
                          fontSize: 24,
                          fontWeight: FontWeight.w900,
                        ),
                        textAlign: TextAlign.center,
                      ),
                      const SizedBox(height: 16),
                      Text(
                        widget.amount,
                        style: const TextStyle(
                          color: AhramColorsV3.gold,
                          fontSize: 38,
                          fontWeight: FontWeight.w900,
                          shadows: [
                            Shadow(
                              color: AhramColorsV3.gold,
                              blurRadius: 25,
                            ),
                          ],
                        ),
                      ),
                      if (widget.subtitle != null) ...[
                        const SizedBox(height: 8),
                        Text(
                          widget.subtitle!,
                          style: TextStyle(
                            color: AhramColorsV3.textMuted,
                            fontSize: 14,
                          ),
                          textAlign: TextAlign.center,
                        ),
                      ],
                      const SizedBox(height: 48),
                      SizedBox(
                        width: double.infinity,
                        child: Ahram3DButton(
                          label: widget.primaryActionLabel,
                          icon: Icons.share_rounded,
                          onPressed: widget.onPrimaryAction,
                        ),
                      ),
                      if (widget.secondaryActionLabel != null) ...[
                        const SizedBox(height: 16),
                        TextButton(
                          onPressed: widget.onSecondaryAction,
                          child: Text(
                            widget.secondaryActionLabel!,
                            style: const TextStyle(
                              color: AhramColorsV3.textMuted,
                              fontWeight: FontWeight.w700,
                            ),
                          ),
                        ),
                      ],
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  @override
  void dispose() {
    _circleController.dispose();
    _contentController.dispose();
    super.dispose();
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// أدوات مساعدة
// ═════════════════════════════════════════════════════════════════════════════

class AhramUtils {
  static String formatCurrency(num value, {String? symbol, int decimals = 2}) {
    final formatter = NumberFormat.currency(
      locale: 'en',
      symbol: symbol ?? '',
      decimalDigits: decimals,
    );
    return formatter.format(value).trim();
  }

  static String formatDate(DateTime? date, {String? locale}) {
    if (date == null) return '-';
    return DateFormat('yyyy/MM/dd - hh:mm a', locale ?? 'ar').format(date);
  }

  static String formatShortDate(DateTime? date) {
    if (date == null) return '-';
    return DateFormat('yyyy/MM/dd').format(date);
  }

  static String formatTime(DateTime? date) {
    if (date == null) return '-';
    return DateFormat('hh:mm a', 'ar').format(date);
  }

  static String formatDuration(Duration duration) {
    if (duration.inSeconds <= 0) return 'غير مكتملة';
    final minutes = duration.inMinutes;
    final seconds = duration.inSeconds % 60;
    if (minutes == 0) return '$seconds ث';
    if (minutes < 60) return '$minutes د $seconds ث';
    final hours = minutes ~/ 60;
    return '$hours س ${minutes % 60} د';
  }

  static String getInitials(String name) {
    final parts = name.trim().split(RegExp(r'\s+'));
    if (parts.isEmpty) return '';
    if (parts.length == 1) return parts[0][0].toUpperCase();
    return '${parts[0][0]}${parts[1][0]}'.toUpperCase();
  }

  static Color getStatusColor(String? status) => switch (status) {
    'completed' || 'deposit' => AhramColorsV3.emerald,
    'cancelled' || 'rejected' || 'deduction' => AhramColorsV3.danger,
    'accepted' || 'processing' => AhramColorsV3.primarySky,
    _ => AhramColorsV3.warning,
  };

  static String getStatusLabel(String? status) => switch (status) {
    'pending' => 'قيد المراجعة',
    'processing' => 'بانتظار التنفيذ',
    'accepted' => 'قيد التنفيذ',
    'completed' => 'ناجحة',
    'cancelled' => 'ملغية',
    'rejected' => 'مرفوضة',
    'deposit' => 'إيداع',
    'deduction' => 'خصم',
    _ => 'غير معروفة',
  };
}
