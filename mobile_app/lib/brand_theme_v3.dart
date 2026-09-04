// ============================================================================
// Al-Ahram Pay V3 — Brand Theme
// هوية بصرية فاخرة مع تصميم ثلاثي الأبعاد
// ============================================================================

import 'package:flutter/material.dart';

// ═════════════════════════════════════════════════════════════════════════════
// نظام الألوان الرئيسي
// ═════════════════════════════════════════════════════════════════════════════

abstract final class AhramColorsV3 {
  // الأساسي
  static const Color primaryDeep = Color(0xFF0A1628);
  static const Color primarySky = Color(0xFF1E5BB5);
  static const Color primaryLight = Color(0xFF74A8FF);

  // الذهبي
  static const Color gold = Color(0xFFC9A227);
  static const Color goldLight = Color(0xFFF5E6A3);
  static const Color goldDark = Color(0xFF8B6914);

  // الزمردي (النجاح)
  static const Color emerald = Color(0xFF0D9F6E);
  static const Color emeraldLight = Color(0xFFE5F7F4);
  static const Color emeraldDark = Color(0xFF0A7A54);

  // الأخطاء والتحذيرات
  static const Color danger = Color(0xFFE8453C);
  static const Color dangerLight = Color(0xFFFEE2E2);
  static const Color warning = Color(0xFFF5A623);
  static const Color warningLight = Color(0xFFFEF3C7);

  // الخلفيات
  static const Color backgroundLight = Color(0xFFF8F9FB);
  static const Color backgroundDark = Color(0xFF0D1B2A);
  static const Color surface = Color(0xFFFFFFFF);
  static const Color surfaceDark = Color(0xFF162B3B);

  // النصوص
  static const Color textPrimary = Color(0xFF1A1A2E);
  static const Color textSecondary = Color(0xFF6B7280);
  static const Color textMuted = Color(0xFF9CA3AF);
  static const Color textOnDark = Color(0xFFF2F7F9);

  // الحدود والخطوط
  static const Color divider = Color(0xFFE5E7EB);
  static const Color dividerDark = Color(0xFF2B4657);

  // تدرجات جاهزة
  static const LinearGradient goldCardGradient = LinearGradient(
    begin: Alignment.topLeft,
    end: Alignment.bottomRight,
    colors: [Color(0xFF1E3A5F), Color(0xFF0A1628)],
    stops: [0.0, 1.0],
  );

  static const LinearGradient successGradient = LinearGradient(
    begin: Alignment.topLeft,
    end: Alignment.bottomRight,
    colors: [Color(0xFF0D9F6E), Color(0xFF0A7A54)],
  );

  static const LinearGradient warningGradient = LinearGradient(
    begin: Alignment.topLeft,
    end: Alignment.bottomRight,
    colors: [Color(0xFFF5A623), Color(0xFFD4891A)],
  );

  static const LinearGradient heroGradient = LinearGradient(
    begin: Alignment.topCenter,
    end: Alignment.bottomCenter,
    colors: [Color(0xFF0A1628), Color(0xFF1A3A5C), Color(0xFF0D1B2A)],
  );

  static const LinearGradient primaryButtonGradient = LinearGradient(
    begin: Alignment.topCenter,
    end: Alignment.bottomCenter,
    colors: [Color(0xFF1E5BB5), Color(0xFF164A94)],
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// أنماط الظلال ثلاثية الأبعاد
// ═════════════════════════════════════════════════════════════════════════════

abstract final class AhramShadows {
  // ظل بطاقة عادي
  static List<BoxShadow> get card => [
    BoxShadow(
      color: Colors.black.withOpacity(0.06),
      blurRadius: 12,
      offset: const Offset(0, 4),
    ),
    BoxShadow(
      color: Colors.black.withOpacity(0.04),
      blurRadius: 4,
      offset: const Offset(0, 1),
    ),
  ];

  // ظل بطاقة مرتفعة (3D)
  static List<BoxShadow> get elevated => [
    BoxShadow(
      color: AhramColorsV3.primarySky.withOpacity(0.20),
      blurRadius: 20,
      offset: const Offset(-4, -4),
    ),
    BoxShadow(
      color: Colors.black.withOpacity(0.25),
      blurRadius: 25,
      offset: const Offset(8, 14),
    ),
    BoxShadow(
      color: AhramColorsV3.gold.withOpacity(0.10),
      blurRadius: 60,
      spreadRadius: -8,
    ),
  ];

  // ظل زر ثلاثي الأبعاد
  static List<BoxShadow> button(Color color) => [
    BoxShadow(
      color: color.withOpacity(0.45),
      blurRadius: 14,
      offset: const Offset(0, 8),
    ),
    BoxShadow(
      color: color.withOpacity(0.25),
      blurRadius: 24,
      offset: const Offset(0, 14),
    ),
    BoxShadow(
      color: Colors.white.withOpacity(0.18),
      blurRadius: 4,
      offset: const Offset(0, -2),
    ),
  ];

  // ظل زر مضغوط
  static List<BoxShadow> get buttonPressed => [
    BoxShadow(
      color: Colors.black.withOpacity(0.15),
      blurRadius: 6,
      offset: const Offset(0, 2),
    ),
  ];

  // ظل للعناصر العائمة
  static List<BoxShadow> get floating => [
    BoxShadow(
      color: Colors.black.withOpacity(0.12),
      blurRadius: 24,
      offset: const Offset(0, 10),
    ),
  ];
}

// ═════════════════════════════════════════════════════════════════════════════
// ThemeData الرئيسي
// ═════════════════════════════════════════════════════════════════════════════

abstract final class AhramThemeV3 {
  static ThemeData light() {
    final scheme = ColorScheme.fromSeed(
      seedColor: AhramColorsV3.primarySky,
      brightness: Brightness.light,
    ).copyWith(
      primary: AhramColorsV3.primarySky,
      onPrimary: Colors.white,
      secondary: AhramColorsV3.gold,
      onSecondary: AhramColorsV3.primaryDeep,
      surface: AhramColorsV3.surface,
      onSurface: AhramColorsV3.textPrimary,
      onSurfaceVariant: AhramColorsV3.textSecondary,
      outline: AhramColorsV3.divider,
      outlineVariant: AhramColorsV3.divider,
      error: AhramColorsV3.danger,
      errorContainer: AhramColorsV3.dangerLight,
      surfaceContainerHighest: AhramColorsV3.backgroundLight,
    );

    return _build(scheme, Brightness.light);
  }

  static ThemeData dark() {
    final scheme = ColorScheme.fromSeed(
      seedColor: AhramColorsV3.primarySky,
      brightness: Brightness.dark,
    ).copyWith(
      primary: AhramColorsV3.primaryLight,
      onPrimary: AhramColorsV3.primaryDeep,
      secondary: const Color(0xFFF1C767),
      onSecondary: AhramColorsV3.backgroundDark,
      surface: AhramColorsV3.surfaceDark,
      onSurface: AhramColorsV3.textOnDark,
      onSurfaceVariant: const Color(0xFFB7C6D2),
      outline: AhramColorsV3.dividerDark,
      outlineVariant: AhramColorsV3.dividerDark,
      error: const Color(0xFFFF8391),
      errorContainer: const Color(0xFF5C1F1F),
      surfaceContainerHighest: const Color(0xFF1A3344),
    );

    return _build(scheme, Brightness.dark);
  }

  static ThemeData _build(ColorScheme scheme, Brightness brightness) {
    final isDark = brightness == Brightness.dark;
    final fieldFill = isDark ? const Color(0xFF1A3344) : Colors.white;
    final scaffoldBg = isDark ? AhramColorsV3.backgroundDark : AhramColorsV3.backgroundLight;

    return ThemeData(
      useMaterial3: true,
      brightness: brightness,
      fontFamily: 'NotoSansArabic',
      colorScheme: scheme,
      scaffoldBackgroundColor: scaffoldBg,

      // ═══════════════════════════════════════════════════════════════════════
      // AppBar
      // ═══════════════════════════════════════════════════════════════════════
      appBarTheme: AppBarTheme(
        backgroundColor: isDark ? AhramColorsV3.backgroundDark : Colors.white,
        foregroundColor: scheme.onSurface,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        scrolledUnderElevation: 0,
        centerTitle: false,
        titleTextStyle: TextStyle(
          color: scheme.onSurface,
          fontSize: 20,
          fontWeight: FontWeight.w900,
          fontFamily: 'NotoSansArabic',
        ),
      ),

      // ═══════════════════════════════════════════════════════════════════════
      // Dialog
      // ═══════════════════════════════════════════════════════════════════════
      dialogTheme: DialogThemeData(
        backgroundColor: isDark ? AhramColorsV3.surfaceDark : Colors.white,
        surfaceTintColor: Colors.transparent,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
        titleTextStyle: TextStyle(
          color: scheme.onSurface,
          fontSize: 20,
          fontWeight: FontWeight.w900,
          fontFamily: 'NotoSansArabic',
        ),
        contentTextStyle: TextStyle(
          color: scheme.onSurfaceVariant,
          fontFamily: 'NotoSansArabic',
          fontSize: 15,
        ),
      ),

      // ═══════════════════════════════════════════════════════════════════════
      // Divider
      // ═══════════════════════════════════════════════════════════════════════
      dividerTheme: DividerThemeData(
        color: scheme.outlineVariant,
        space: 1,
        thickness: 1,
      ),

      // ═══════════════════════════════════════════════════════════════════════
      // Input Decoration
      // ═══════════════════════════════════════════════════════════════════════
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: fieldFill,
        contentPadding: const EdgeInsets.symmetric(horizontal: 18, vertical: 18),
        labelStyle: TextStyle(
          color: scheme.onSurfaceVariant,
          fontWeight: FontWeight.w600,
        ),
        floatingLabelStyle: TextStyle(
          color: scheme.primary,
          fontWeight: FontWeight.w700,
        ),
        prefixIconColor: scheme.onSurfaceVariant,
        suffixIconColor: scheme.onSurfaceVariant,
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(14),
          borderSide: BorderSide(color: scheme.outlineVariant, width: 1.2),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(14),
          borderSide: BorderSide(color: scheme.outlineVariant, width: 1.2),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(14),
          borderSide: BorderSide(color: scheme.primary, width: 2),
        ),
        errorBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(14),
          borderSide: BorderSide(color: scheme.error, width: 1.5),
        ),
      ),

      // ═══════════════════════════════════════════════════════════════════════
      // Buttons
      // ═══════════════════════════════════════════════════════════════════════
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          minimumSize: const Size(0, 54),
          backgroundColor: scheme.primary,
          foregroundColor: scheme.onPrimary,
          elevation: 4,
          shadowColor: scheme.primary.withOpacity(0.35),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
          textStyle: const TextStyle(
            fontWeight: FontWeight.w800,
            fontSize: 15,
            fontFamily: 'NotoSansArabic',
          ),
        ),
      ),

      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          minimumSize: const Size(0, 52),
          foregroundColor: scheme.primary,
          side: BorderSide(color: scheme.primary.withOpacity(0.45), width: 1.5),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
          textStyle: const TextStyle(
            fontWeight: FontWeight.w800,
            fontSize: 15,
            fontFamily: 'NotoSansArabic',
          ),
        ),
      ),

      textButtonTheme: TextButtonThemeData(
        style: TextButton.styleFrom(
          foregroundColor: scheme.primary,
          textStyle: const TextStyle(
            fontWeight: FontWeight.w700,
            fontSize: 14,
            fontFamily: 'NotoSansArabic',
          ),
        ),
      ),

      // ═══════════════════════════════════════════════════════════════════════
      // Navigation
      // ═══════════════════════════════════════════════════════════════════════
      navigationBarTheme: NavigationBarThemeData(
        height: 76,
        backgroundColor: isDark ? const Color(0xFF132838) : Colors.white,
        surfaceTintColor: Colors.transparent,
        elevation: 8,
        shadowColor: Colors.black.withOpacity(0.08),
        indicatorColor: isDark
            ? const Color(0xFF1F5A47)
            : AhramColorsV3.emeraldLight,
        labelTextStyle: const WidgetStatePropertyAll(
          TextStyle(fontWeight: FontWeight.w800, fontSize: 11),
        ),
        iconTheme: WidgetStateProperty.resolveWith((states) {
          return IconThemeData(
            color: states.contains(WidgetState.selected)
                ? scheme.primary
                : scheme.onSurfaceVariant,
            size: 24,
          );
        }),
      ),

      navigationRailTheme: NavigationRailThemeData(
        backgroundColor: isDark ? const Color(0xFF132838) : Colors.white,
        indicatorColor: isDark
            ? const Color(0xFF1F5A47)
            : AhramColorsV3.emeraldLight,
        selectedIconTheme: IconThemeData(color: scheme.primary, size: 24),
        unselectedIconTheme: IconThemeData(
          color: scheme.onSurfaceVariant,
          size: 22,
        ),
        selectedLabelTextStyle: TextStyle(
          color: scheme.primary,
          fontWeight: FontWeight.w800,
          fontSize: 13,
        ),
        unselectedLabelTextStyle: TextStyle(
          color: scheme.onSurfaceVariant,
          fontWeight: FontWeight.w700,
          fontSize: 12,
        ),
      ),

      // ═══════════════════════════════════════════════════════════════════════
      // Card
      // ═══════════════════════════════════════════════════════════════════════
      cardTheme: CardTheme(
        color: isDark ? AhramColorsV3.surfaceDark : Colors.white,
        elevation: 0,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
        margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      ),

      // ═══════════════════════════════════════════════════════════════════════
      // SnackBar
      // ═══════════════════════════════════════════════════════════════════════
      snackBarTheme: SnackBarThemeData(
        behavior: SnackBarBehavior.floating,
        backgroundColor: isDark ? const Color(0xFF1D3647) : AhramColorsV3.textPrimary,
        contentTextStyle: const TextStyle(color: Colors.white),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
        elevation: 6,
      ),

      // ═══════════════════════════════════════════════════════════════════════
      // BottomSheet
      // ═══════════════════════════════════════════════════════════════════════
      bottomSheetTheme: BottomSheetThemeData(
        backgroundColor: isDark ? AhramColorsV3.surfaceDark : Colors.white,
        surfaceTintColor: Colors.transparent,
        shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
        ),
      ),

      // ═══════════════════════════════════════════════════════════════════════
      // ListTile
      // ═══════════════════════════════════════════════════════════════════════
      listTileTheme: ListTileThemeData(
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
        contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
      ),
    );
  }
}
