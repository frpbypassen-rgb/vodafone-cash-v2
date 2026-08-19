import 'dart:math' as math;

import 'package:flutter/material.dart';

import 'brand_theme.dart';

abstract final class ExecutorUiColors {
  static const graphite = Color(0xFF0D1117);
  static const graphiteSurface = Color(0xFF151A20);
  static const graphiteRaised = Color(0xFF1B222B);
  static const graphiteLine = Color(0xFF303844);
  static const pearl = Color(0xFFF3F6FA);
  static const silver = Color(0xFFE6ECF3);
  static const cobalt = Color(0xFF1457D9);
  static const jade = Color(0xFF0F9F8F);
  static const amber = Color(0xFFD7A92E);
  static const coral = Color(0xFFD44C5D);

  static bool isDark(BuildContext context) =>
      Theme.of(context).brightness == Brightness.dark;

  static Color canvas(BuildContext context) =>
      isDark(context) ? graphite : pearl;

  static Color surface(BuildContext context) =>
      isDark(context) ? graphiteSurface : Colors.white;

  static Color raised(BuildContext context) =>
      isDark(context) ? graphiteRaised : const Color(0xFFF9FBFD);

  static Color line(BuildContext context) =>
      isDark(context) ? graphiteLine : const Color(0xFFD9E1EB);
}

class ExecutorWorkspaceBackground extends StatelessWidget {
  const ExecutorWorkspaceBackground({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    final base = Theme.of(context);
    final dark = ExecutorUiColors.isDark(context);
    final executorTheme = base.copyWith(
      scaffoldBackgroundColor: ExecutorUiColors.canvas(context),
      dividerTheme: base.dividerTheme.copyWith(
        color: ExecutorUiColors.line(context),
      ),
      inputDecorationTheme: base.inputDecorationTheme.copyWith(
        fillColor: ExecutorUiColors.raised(context),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(8),
          borderSide: BorderSide(color: ExecutorUiColors.line(context)),
        ),
      ),
    );
    return Theme(
      data: executorTheme,
      child: ColoredBox(
        color: ExecutorUiColors.canvas(context),
        child: CustomPaint(
          painter: _ExecutorWorkspacePainter(dark: dark),
          child: child,
        ),
      ),
    );
  }
}

class _ExecutorWorkspacePainter extends CustomPainter {
  const _ExecutorWorkspacePainter({required this.dark});

  final bool dark;

  @override
  void paint(Canvas canvas, Size size) {
    final line = Paint()
      ..color = (dark ? Colors.white : AhramColors.ink).withValues(
        alpha: dark ? 0.025 : 0.035,
      )
      ..strokeWidth = 1;
    const step = 72.0;
    for (double x = 0; x <= size.width; x += step) {
      canvas.drawLine(Offset(x, 0), Offset(x, size.height), line);
    }
    for (double y = 0; y <= size.height; y += step) {
      canvas.drawLine(Offset(0, y), Offset(size.width, y), line);
    }

    final accent = Paint()
      ..color = ExecutorUiColors.amber.withValues(alpha: dark ? 0.045 : 0.055)
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.2;
    final radius = math.min(size.width * 0.42, 240.0);
    canvas.drawArc(
      Rect.fromCircle(center: Offset(size.width, size.height), radius: radius),
      math.pi,
      math.pi / 2,
      false,
      accent,
    );
    canvas.drawArc(
      Rect.fromCircle(
        center: Offset(size.width, size.height),
        radius: radius * 0.72,
      ),
      math.pi,
      math.pi / 2,
      false,
      accent,
    );
  }

  @override
  bool shouldRepaint(covariant _ExecutorWorkspacePainter oldDelegate) =>
      oldDelegate.dark != dark;
}

class ExecutorSurface extends StatelessWidget {
  const ExecutorSurface({
    super.key,
    required this.child,
    this.padding = const EdgeInsets.all(16),
    this.accent,
    this.elevated = true,
    this.onTap,
  });

  final Widget child;
  final EdgeInsetsGeometry padding;
  final Color? accent;
  final bool elevated;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final dark = ExecutorUiColors.isDark(context);
    final decoration = BoxDecoration(
      color: ExecutorUiColors.surface(context),
      borderRadius: BorderRadius.circular(8),
      border: Border.all(color: ExecutorUiColors.line(context)),
      boxShadow: elevated
          ? [
              BoxShadow(
                color: Colors.black.withValues(alpha: dark ? 0.34 : 0.10),
                blurRadius: dark ? 18 : 22,
                offset: const Offset(0, 10),
              ),
              BoxShadow(
                color: Colors.white.withValues(alpha: dark ? 0.025 : 0.88),
                blurRadius: 0,
                offset: const Offset(0, -1),
              ),
            ]
          : const [],
    );

    final content = Stack(
      children: [
        Padding(padding: padding, child: child),
        if (accent != null)
          PositionedDirectional(
            top: 8,
            bottom: 8,
            start: 0,
            child: Container(
              width: 3,
              decoration: BoxDecoration(
                color: accent,
                borderRadius: BorderRadius.circular(3),
              ),
            ),
          ),
      ],
    );

    if (onTap == null) {
      return DecoratedBox(decoration: decoration, child: content);
    }
    return Material(
      color: Colors.transparent,
      child: Ink(
        decoration: decoration,
        child: InkWell(
          borderRadius: BorderRadius.circular(8),
          onTap: onTap,
          child: content,
        ),
      ),
    );
  }
}

class ExecutorMetalIcon extends StatelessWidget {
  const ExecutorMetalIcon({
    super.key,
    required this.icon,
    this.color = ExecutorUiColors.cobalt,
    this.size = 44,
    this.selected = false,
  });

  final IconData icon;
  final Color color;
  final double size;
  final bool selected;

  @override
  Widget build(BuildContext context) {
    final dark = ExecutorUiColors.isDark(context);
    final base = selected
        ? color.withValues(alpha: dark ? 0.24 : 0.13)
        : ExecutorUiColors.raised(context);
    return Container(
      width: size,
      height: size,
      padding: EdgeInsets.all(size * 0.11),
      decoration: BoxDecoration(
        color: base,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(
          color: selected
              ? color.withValues(alpha: 0.42)
              : ExecutorUiColors.line(context),
        ),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withValues(alpha: dark ? 0.40 : 0.16),
            blurRadius: 8,
            offset: const Offset(0, 5),
          ),
          BoxShadow(
            color: Colors.white.withValues(alpha: dark ? 0.04 : 0.94),
            blurRadius: 0,
            offset: const Offset(0, -2),
          ),
        ],
      ),
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: color.withValues(alpha: dark ? 0.13 : 0.08),
          borderRadius: BorderRadius.circular(6),
        ),
        child: Icon(icon, color: color, size: size * 0.50),
      ),
    );
  }
}

class ExecutorTopActionButton extends StatelessWidget {
  const ExecutorTopActionButton({
    super.key,
    required this.tooltip,
    required this.icon,
    required this.onPressed,
    this.badge = 0,
  });

  final String tooltip;
  final IconData icon;
  final VoidCallback? onPressed;
  final int badge;

  @override
  Widget build(BuildContext context) {
    return Stack(
      clipBehavior: Clip.none,
      children: [
        Tooltip(
          message: tooltip,
          child: IconButton(
            onPressed: onPressed,
            style: IconButton.styleFrom(
              fixedSize: const Size(42, 42),
              backgroundColor: ExecutorUiColors.raised(context),
              foregroundColor: Theme.of(context).colorScheme.onSurface,
              side: BorderSide(color: ExecutorUiColors.line(context)),
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(8),
              ),
              elevation: 3,
              shadowColor: Colors.black.withValues(alpha: 0.22),
            ),
            icon: Icon(icon, size: 21),
          ),
        ),
        if (badge > 0)
          PositionedDirectional(
            top: -2,
            end: -2,
            child: Container(
              constraints: const BoxConstraints(minWidth: 18),
              height: 18,
              padding: const EdgeInsets.symmetric(horizontal: 4),
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: ExecutorUiColors.coral,
                borderRadius: BorderRadius.circular(8),
                border: Border.all(
                  color: ExecutorUiColors.surface(context),
                  width: 1.5,
                ),
              ),
              child: Text(
                badge > 99 ? '99+' : '$badge',
                style: const TextStyle(
                  color: Colors.white,
                  fontSize: 9,
                  fontWeight: FontWeight.w900,
                ),
              ),
            ),
          ),
      ],
    );
  }
}

class ExecutorWordmark extends StatelessWidget {
  const ExecutorWordmark({super.key, this.compact = false});

  final bool compact;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          width: compact ? 34 : 40,
          height: compact ? 34 : 40,
          padding: const EdgeInsets.all(2),
          decoration: BoxDecoration(
            color: ExecutorUiColors.raised(context),
            borderRadius: BorderRadius.circular(8),
            border: Border.all(color: ExecutorUiColors.line(context)),
            boxShadow: [
              BoxShadow(
                color: Colors.black.withValues(alpha: 0.14),
                blurRadius: 8,
                offset: const Offset(0, 4),
              ),
            ],
          ),
          child: ClipRRect(
            borderRadius: BorderRadius.circular(6),
            child: Image.asset(
              'assets/images/alahrampay-logo.jpg',
              fit: BoxFit.cover,
            ),
          ),
        ),
        if (!compact) ...[
          const SizedBox(width: 9),
          Text.rich(
            TextSpan(
              children: [
                TextSpan(
                  text: 'AHRAM ',
                  style: TextStyle(color: colors.onSurface),
                ),
                const TextSpan(
                  text: 'PAY',
                  style: TextStyle(color: ExecutorUiColors.cobalt),
                ),
              ],
            ),
            textDirection: TextDirection.ltr,
            style: const TextStyle(
              fontSize: 15,
              fontWeight: FontWeight.w900,
              letterSpacing: 0,
            ),
          ),
        ],
      ],
    );
  }
}

class ExecutorLiveHalo extends StatefulWidget {
  const ExecutorLiveHalo({
    super.key,
    required this.child,
    this.color = ExecutorUiColors.cobalt,
    this.size = 250,
  });

  final Widget child;
  final Color color;
  final double size;

  @override
  State<ExecutorLiveHalo> createState() => _ExecutorLiveHaloState();
}

class _ExecutorLiveHaloState extends State<ExecutorLiveHalo>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: const Duration(seconds: 6),
    )..repeat();
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final reduceMotion =
        MediaQuery.maybeOf(context)?.disableAnimations ?? false;
    if (reduceMotion) {
      return SizedBox.square(
        dimension: widget.size,
        child: Center(child: widget.child),
      );
    }
    return SizedBox.square(
      dimension: widget.size,
      child: AnimatedBuilder(
        animation: _controller,
        builder: (context, child) => CustomPaint(
          painter: _ExecutorHaloPainter(
            progress: _controller.value,
            color: widget.color,
          ),
          child: Transform.translate(
            offset: Offset(0, -3 * math.sin(_controller.value * math.pi * 2)),
            child: child,
          ),
        ),
        child: Center(child: widget.child),
      ),
    );
  }
}

class _ExecutorHaloPainter extends CustomPainter {
  const _ExecutorHaloPainter({required this.progress, required this.color});

  final double progress;
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final center = size.center(Offset.zero);
    final maxRadius = math.min(size.width, size.height) * 0.46;
    final line = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.2;
    for (var index = 0; index < 3; index++) {
      final phase = (progress + (index / 3)) % 1.0;
      line.color = color.withValues(alpha: (1 - phase) * 0.25);
      canvas.drawCircle(center, maxRadius * (0.42 + (phase * 0.58)), line);
    }
    final marker = Paint()..color = color;
    final angle = progress * math.pi * 2;
    final markerPosition =
        center + Offset(math.cos(angle), math.sin(angle)) * (maxRadius * 0.82);
    canvas.drawCircle(markerPosition, 4, marker);
  }

  @override
  bool shouldRepaint(covariant _ExecutorHaloPainter oldDelegate) =>
      oldDelegate.progress != progress || oldDelegate.color != color;
}

class ExecutorSectionHeading extends StatelessWidget {
  const ExecutorSectionHeading({
    super.key,
    required this.title,
    this.subtitle,
    this.icon,
    this.trailing,
  });

  final String title;
  final String? subtitle;
  final IconData? icon;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Row(
      crossAxisAlignment: CrossAxisAlignment.center,
      children: [
        if (icon != null) ...[
          ExecutorMetalIcon(icon: icon!, size: 42),
          const SizedBox(width: 12),
        ],
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                title,
                style: TextStyle(
                  color: colors.onSurface,
                  fontSize: 17,
                  fontWeight: FontWeight.w900,
                ),
              ),
              if (subtitle != null) ...[
                const SizedBox(height: 3),
                Text(
                  subtitle!,
                  style: TextStyle(
                    color: colors.onSurfaceVariant,
                    fontSize: 12,
                  ),
                ),
              ],
            ],
          ),
        ),
        ?trailing,
      ],
    );
  }
}
