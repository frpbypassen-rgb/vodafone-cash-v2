import 'package:flutter/material.dart';

import '../../brand_theme.dart';

/// Design tokens for the customer financial portal.
abstract final class CustomerTheme {
  static const canvas = AhramColors.ink;
  static const action = AhramColors.gold;
  static const success = AhramColors.emerald;
  static const radiusLg = 16.0;
  static const radiusMd = 12.0;
  static const metricFs = 22.0;
  static const titleFs = 18.0;
  static const gridGap = 12.0;
  static const buttonHeightMobile = 48.0;
  static const buttonHeightDesktop = 44.0;
  static const sidebarWidth = 240.0;
  static const inspectorWidth = 320.0;
  static const compactRailWidth = 72.0;

  static BoxDecoration surfaceCard(BuildContext context, {Color? accent}) {
    final colors = Theme.of(context).colorScheme;
    final border = accent ?? colors.outlineVariant;
    return BoxDecoration(
      color: colors.surface,
      borderRadius: BorderRadius.circular(radiusMd),
      border: Border.all(color: border.withValues(alpha: 0.35)),
    );
  }

  static BoxDecoration heroPanel({bool dark = false}) {
    return BoxDecoration(
      color: canvas,
      borderRadius: BorderRadius.circular(radiusLg),
      border: Border.all(color: action.withValues(alpha: 0.38)),
    );
  }
}
