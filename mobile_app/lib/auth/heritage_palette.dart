import 'package:flutter/material.dart';

/// Approved Egyptian heritage colors for new mobile screens.
/// Gold decoration is not a substitute for accessible text/status colors.
@immutable
class HeritagePalette {
  const HeritagePalette({
    required this.background,
    required this.surface,
    required this.text,
    required this.muted,
    required this.accent,
    required this.border,
    required this.error,
    required this.errorSurface,
  });
  static const navy = Color(0xFF06182C);
  static const gold = Color(0xFFE9C47A);
  static const ivory = Color(0xFFF4EBDD);
  final Color background,
      surface,
      text,
      muted,
      accent,
      border,
      error,
      errorSurface;
  static const light = HeritagePalette(
    background: Color(0xFFF5EFE3),
    surface: Color(0xFFFFFDFA),
    text: Color(0xFF102A3A),
    muted: Color(0xFF52616D),
    accent: Color(0xFF795519),
    border: Color(0xFF84785F),
    error: Color(0xFF8C2432),
    errorSurface: Color(0xFFFCE3E6),
  );
  static const dark = HeritagePalette(
    background: navy,
    surface: Color(0xFF10253B),
    text: ivory,
    muted: Color(0xFFBBC7D5),
    accent: gold,
    border: Color(0xFFB09A71),
    error: Color(0xFFFFD6D6),
    errorSurface: Color(0xFF402632),
  );
  static HeritagePalette of(BuildContext context) =>
      Theme.of(context).brightness == Brightness.dark ? dark : light;
}
