import 'package:flutter/material.dart';

abstract final class AhramColors {
  static const ink = Color(0xFF081A33);
  static const inkSoft = Color(0xFF667085);
  static const emerald = Color(0xFF0F9F8F);
  static const emeraldDeep = Color(0xFF081A33);
  static const emeraldSoft = Color(0xFFE5F7F4);
  static const gold = Color(0xFFD7A92E);
  static const goldSoft = Color(0xFFFFF5D9);
  static const sky = Color(0xFF1457D9);
  static const cloud = Color(0xFFF3F6FB);
  static const line = Color(0xFFDCE5F1);
  static const danger = Color(0xFFD44C5D);
  static const night = Color(0xFF10202D);
  static const nightSurface = Color(0xFF162B3B);
  static const nightLine = Color(0xFF2B4657);
}

abstract final class AhramTheme {
  static ThemeData light() {
    final scheme =
        ColorScheme.fromSeed(
          seedColor: AhramColors.sky,
          brightness: Brightness.light,
        ).copyWith(
          primary: AhramColors.sky,
          onPrimary: Colors.white,
          secondary: AhramColors.gold,
          onSecondary: AhramColors.ink,
          surface: Colors.white,
          onSurface: AhramColors.ink,
          onSurfaceVariant: AhramColors.inkSoft,
          outline: AhramColors.line,
          outlineVariant: AhramColors.line,
          error: AhramColors.danger,
        );
    return _build(scheme, Brightness.light);
  }

  static ThemeData dark() {
    final scheme =
        ColorScheme.fromSeed(
          seedColor: AhramColors.sky,
          brightness: Brightness.dark,
        ).copyWith(
          primary: const Color(0xFF74A8FF),
          onPrimary: AhramColors.ink,
          secondary: const Color(0xFFF1C767),
          onSecondary: AhramColors.night,
          surface: AhramColors.nightSurface,
          onSurface: const Color(0xFFF2F7F9),
          onSurfaceVariant: const Color(0xFFB7C6D2),
          outline: AhramColors.nightLine,
          outlineVariant: AhramColors.nightLine,
          error: const Color(0xFFFF8391),
        );
    return _build(scheme, Brightness.dark);
  }

  static ThemeData _build(ColorScheme scheme, Brightness brightness) {
    final dark = brightness == Brightness.dark;
    final fieldFill = dark ? const Color(0xFF1A3344) : Colors.white;
    final scaffold = dark ? AhramColors.night : AhramColors.cloud;

    return ThemeData(
      useMaterial3: true,
      brightness: brightness,
      fontFamily: 'NotoSansArabic',
      colorScheme: scheme,
      scaffoldBackgroundColor: scaffold,
      appBarTheme: AppBarTheme(
        backgroundColor: dark ? AhramColors.night : Colors.white,
        foregroundColor: scheme.onSurface,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        scrolledUnderElevation: 0,
        centerTitle: false,
      ),
      dialogTheme: DialogThemeData(
        backgroundColor: dark ? AhramColors.nightSurface : Colors.white,
        surfaceTintColor: Colors.transparent,
        titleTextStyle: TextStyle(
          color: scheme.onSurface,
          fontSize: 20,
          fontWeight: FontWeight.w900,
          fontFamily: 'NotoSansArabic',
        ),
        contentTextStyle: TextStyle(
          color: scheme.onSurfaceVariant,
          fontFamily: 'NotoSansArabic',
        ),
      ),
      dividerTheme: DividerThemeData(
        color: scheme.outlineVariant,
        space: 1,
        thickness: 1,
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: fieldFill,
        contentPadding: const EdgeInsets.symmetric(
          horizontal: 16,
          vertical: 17,
        ),
        labelStyle: TextStyle(color: scheme.onSurfaceVariant),
        floatingLabelStyle: TextStyle(
          color: scheme.primary,
          fontWeight: FontWeight.w700,
        ),
        prefixIconColor: scheme.onSurfaceVariant,
        suffixIconColor: scheme.onSurfaceVariant,
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(8),
          borderSide: BorderSide(color: scheme.outlineVariant),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(8),
          borderSide: BorderSide(color: scheme.outlineVariant),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(8),
          borderSide: BorderSide(color: scheme.primary, width: 1.6),
        ),
        errorBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(8),
          borderSide: BorderSide(color: scheme.error),
        ),
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          minimumSize: const Size(0, 52),
          backgroundColor: scheme.primary,
          foregroundColor: scheme.onPrimary,
          elevation: 3,
          shadowColor: AhramColors.ink.withValues(alpha: 0.22),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
          textStyle: const TextStyle(fontWeight: FontWeight.w800),
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          minimumSize: const Size(0, 50),
          foregroundColor: scheme.primary,
          side: BorderSide(color: scheme.primary.withValues(alpha: 0.42)),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
          textStyle: const TextStyle(fontWeight: FontWeight.w800),
        ),
      ),
      navigationBarTheme: NavigationBarThemeData(
        height: 76,
        backgroundColor: dark ? const Color(0xFF132838) : Colors.white,
        surfaceTintColor: Colors.transparent,
        indicatorColor: dark
            ? const Color(0xFF1F5A47)
            : AhramColors.emeraldSoft,
        labelTextStyle: const WidgetStatePropertyAll(
          TextStyle(fontWeight: FontWeight.w800, fontSize: 11),
        ),
        iconTheme: WidgetStateProperty.resolveWith((states) {
          return IconThemeData(
            color: states.contains(WidgetState.selected)
                ? scheme.primary
                : scheme.onSurfaceVariant,
          );
        }),
      ),
      navigationRailTheme: NavigationRailThemeData(
        backgroundColor: dark ? const Color(0xFF132838) : Colors.white,
        indicatorColor: dark
            ? const Color(0xFF1F5A47)
            : AhramColors.emeraldSoft,
        selectedIconTheme: IconThemeData(color: scheme.primary),
        selectedLabelTextStyle: TextStyle(
          color: scheme.primary,
          fontWeight: FontWeight.w800,
        ),
        unselectedLabelTextStyle: TextStyle(
          color: scheme.onSurfaceVariant,
          fontWeight: FontWeight.w700,
        ),
      ),
      snackBarTheme: SnackBarThemeData(
        behavior: SnackBarBehavior.floating,
        backgroundColor: dark ? const Color(0xFF1D3647) : AhramColors.ink,
        contentTextStyle: const TextStyle(color: Colors.white),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
      ),
    );
  }
}
