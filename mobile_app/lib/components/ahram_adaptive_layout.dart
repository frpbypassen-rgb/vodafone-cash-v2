// ============================================================================
// Al-Ahram Pay V3 — Adaptive Layout
// تصميم متكيف للجوال والتابلت وسطح المكتب
// ============================================================================

import 'package:flutter/material.dart';
import 'brand_theme_v3.dart';

// ═════════════════════════════════════════════════════════════════════════════
// Widget أساسي للتخطيط المتكيف
// ═════════════════════════════════════════════════════════════════════════════

class AhramAdaptiveLayout extends StatelessWidget {
  final Widget mobile;
  final Widget? tablet;
  final Widget? desktop;

  const AhramAdaptiveLayout({
    super.key,
    required this.mobile,
    this.tablet,
    this.desktop,
  });

  /// نقاط التوقف (Breakpoints)
  static const double mobileMax = 600;
  static const double tabletMax = 1200;

  static bool isMobile(BuildContext context) =>
      MediaQuery.of(context).size.width < mobileMax;

  static bool isTablet(BuildContext context) {
    final width = MediaQuery.of(context).size.width;
    return width >= mobileMax && width < tabletMax;
  }

  static bool isDesktop(BuildContext context) =>
      MediaQuery.of(context).size.width >= tabletMax;

  static int gridCrossAxisCount(BuildContext context) {
    final width = MediaQuery.of(context).size.width;
    if (width < 400) return 2;
    if (width < 600) return 3;
    if (width < 900) return 4;
    if (width < 1200) return 5;
    return 6;
  }

  static double contentMaxWidth(BuildContext context) {
    final width = MediaQuery.of(context).size.width;
    if (width < 600) return width;
    if (width < 1200) return width * 0.85;
    return 1100;
  }

  static EdgeInsets responsivePadding(BuildContext context) {
    final width = MediaQuery.of(context).size.width;
    if (width < 600) return const EdgeInsets.all(16);
    if (width < 1200) return const EdgeInsets.all(24);
    return const EdgeInsets.symmetric(horizontal: 40, vertical: 24);
  }

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        if (constraints.maxWidth >= tabletMax && desktop != null) {
          return desktop!;
        }
        if (constraints.maxWidth >= mobileMax && tablet != null) {
          return tablet!;
        }
        return mobile;
      },
    );
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// شريط جانبي متكيف (Navigation Rail / Drawer)
// ═════════════════════════════════════════════════════════════════════════════

class AhramAdaptiveSidebar extends StatelessWidget {
  final int selectedIndex;
  final ValueChanged<int> onDestinationSelected;
  final List<AhramNavDestination> destinations;
  final Widget? header;
  final Widget? footer;

  const AhramAdaptiveSidebar({
    super.key,
    required this.selectedIndex,
    required this.onDestinationSelected,
    required this.destinations,
    this.header,
    this.footer,
  });

  @override
  Widget build(BuildContext context) {
    final isExtended = AhramAdaptiveLayout.isDesktop(context) ||
        (AhramAdaptiveLayout.isTablet(context));

    return Container(
      width: isExtended ? 260 : 72,
      decoration: BoxDecoration(
        color: Theme.of(context).brightness == Brightness.dark
            ? const Color(0xFF0D1B2A)
            : Colors.white,
        border: Border(
          left: Directionality.of(context) == TextDirection.rtl
              ? BorderSide.none
              : BorderSide(color: AhramColorsV3.divider.withOpacity(0.5)),
          right: Directionality.of(context) == TextDirection.rtl
              ? BorderSide(color: AhramColorsV3.divider.withOpacity(0.5))
              : BorderSide.none,
        ),
      ),
      child: Column(
        children: [
          if (header != null) header!,
          Expanded(
            child: ListView.builder(
              itemCount: destinations.length,
              padding: const EdgeInsets.symmetric(vertical: 8, horizontal: 8),
              itemBuilder: (context, index) {
                final dest = destinations[index];
                final isSelected = selectedIndex == index;

                return Padding(
                  padding: const EdgeInsets.symmetric(vertical: 4),
                  child: _SidebarItem(
                    icon: dest.icon,
                    selectedIcon: dest.selectedIcon,
                    label: dest.label,
                    isSelected: isSelected,
                    isExtended: isExtended,
                    badge: dest.badge,
                    onTap: () => onDestinationSelected(index),
                  ),
                );
              },
            ),
          ),
          if (footer != null) footer!,
        ],
      ),
    );
  }
}

class _SidebarItem extends StatelessWidget {
  final IconData icon;
  final IconData? selectedIcon;
  final String label;
  final bool isSelected;
  final bool isExtended;
  final int? badge;
  final VoidCallback onTap;

  const _SidebarItem({
    required this.icon,
    this.selectedIcon,
    required this.label,
    required this.isSelected,
    required this.isExtended,
    this.badge,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final selectedColor = isSelected
        ? AhramColorsV3.primarySky
        : AhramColorsV3.textMuted;

    return GestureDetector(
      onTap: onTap,
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 200),
        padding: isExtended
            ? const EdgeInsets.symmetric(horizontal: 16, vertical: 12)
            : const EdgeInsets.symmetric(vertical: 12),
        decoration: BoxDecoration(
          color: isSelected
              ? AhramColorsV3.primarySky.withOpacity(0.1)
              : Colors.transparent,
          borderRadius: BorderRadius.circular(12),
        ),
        child: isExtended
            ? Row(
                children: [
                  Stack(
                    children: [
                      Icon(
                        isSelected ? (selectedIcon ?? icon) : icon,
                        color: selectedColor,
                        size: 22,
                      ),
                      if (badge != null && badge! > 0)
                        Positioned(
                          top: -2,
                          right: -2,
                          child: Container(
                            padding: const EdgeInsets.all(2),
                            decoration: const BoxDecoration(
                              color: AhramColorsV3.danger,
                              shape: BoxShape.circle,
                            ),
                            constraints: const BoxConstraints(
                              minWidth: 14,
                              minHeight: 14,
                            ),
                            child: Text(
                              badge! > 99 ? '99+' : '$badge',
                              style: const TextStyle(
                                color: Colors.white,
                                fontSize: 8,
                                fontWeight: FontWeight.w800,
                              ),
                              textAlign: TextAlign.center,
                            ),
                          ),
                        ),
                    ],
                  ),
                  const SizedBox(width: 12),
                  Text(
                    label,
                    style: TextStyle(
                      color: selectedColor,
                      fontWeight: FontWeight.w700,
                      fontSize: 14,
                    ),
                  ),
                  const Spacer(),
                  if (badge != null && badge! > 0)
                    Container(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 8,
                        vertical: 2,
                      ),
                      decoration: BoxDecoration(
                        color: AhramColorsV3.danger.withOpacity(0.15),
                        borderRadius: BorderRadius.circular(10),
                      ),
                      child: Text(
                        '$badge',
                        style: const TextStyle(
                          color: AhramColorsV3.danger,
                          fontSize: 11,
                          fontWeight: FontWeight.w800,
                        ),
                      ),
                    ),
                ],
              )
            : Center(
                child: Stack(
                  children: [
                    Icon(
                      isSelected ? (selectedIcon ?? icon) : icon,
                      color: selectedColor,
                      size: 24,
                    ),
                    if (badge != null && badge! > 0)
                      Positioned(
                        top: -2,
                        right: -2,
                        child: Container(
                          width: 8,
                          height: 8,
                          decoration: const BoxDecoration(
                            color: AhramColorsV3.danger,
                            shape: BoxShape.circle,
                          ),
                        ),
                      ),
                  ],
                ),
              ),
      ),
    );
  }
}

class AhramNavDestination {
  final IconData icon;
  final IconData? selectedIcon;
  final String label;
  final int? badge;

  const AhramNavDestination({
    required this.icon,
    this.selectedIcon,
    required this.label,
    this.badge,
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// Scaffold متكيف
// ═════════════════════════════════════════════════════════════════════════════

class AhramAdaptiveScaffold extends StatelessWidget {
  final Widget body;
  final int currentIndex;
  final ValueChanged<int> onNavigationChanged;
  final List<AhramNavDestination> destinations;
  final PreferredSizeWidget? appBar;
  final Widget? floatingActionButton;
  final Widget? drawer;
  final Widget? sidebarHeader;
  final Widget? sidebarFooter;

  const AhramAdaptiveScaffold({
    super.key,
    required this.body,
    required this.currentIndex,
    required this.onNavigationChanged,
    required this.destinations,
    this.appBar,
    this.floatingActionButton,
    this.drawer,
    this.sidebarHeader,
    this.sidebarFooter,
  });

  @override
  Widget build(BuildContext context) {
    return AhramAdaptiveLayout(
      mobile: Scaffold(
        appBar: appBar,
        body: body,
        drawer: drawer,
        floatingActionButton: floatingActionButton,
        bottomNavigationBar: _buildMobileNav(),
      ),
      tablet: Scaffold(
        appBar: appBar,
        body: Row(
          children: [
            AhramAdaptiveSidebar(
              selectedIndex: currentIndex,
              onDestinationSelected: onNavigationChanged,
              destinations: destinations,
              header: sidebarHeader,
              footer: sidebarFooter,
            ),
            const VerticalDivider(width: 1),
            Expanded(child: body),
          ],
        ),
        floatingActionButton: floatingActionButton,
      ),
      desktop: Scaffold(
        appBar: appBar,
        body: Row(
          children: [
            AhramAdaptiveSidebar(
              selectedIndex: currentIndex,
              onDestinationSelected: onNavigationChanged,
              destinations: destinations,
              header: sidebarHeader,
              footer: sidebarFooter,
            ),
            const VerticalDivider(width: 1),
            Expanded(
              child: Center(
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 1200),
                  child: body,
                ),
              ),
            ),
          ],
        ),
        floatingActionButton: floatingActionButton,
      ),
    );
  }

  Widget _buildMobileNav() {
    return Container(
      margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 8),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(24),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withOpacity(0.1),
            blurRadius: 24,
            offset: const Offset(0, -4),
          ),
        ],
      ),
      child: SafeArea(
        child: Row(
          mainAxisAlignment: MainAxisAlignment.spaceAround,
          children: List.generate(destinations.length, (index) {
            final dest = destinations[index];
            final isActive = currentIndex == index;

            return GestureDetector(
              onTap: () => onNavigationChanged(index),
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
                    Stack(
                      children: [
                        Icon(
                          isActive ? (dest.selectedIcon ?? dest.icon) : dest.icon,
                          color: isActive
                              ? AhramColorsV3.primarySky
                              : AhramColorsV3.textMuted,
                          size: 24,
                        ),
                        if (dest.badge != null && dest.badge! > 0)
                          Positioned(
                            top: -2,
                            right: -2,
                            child: Container(
                              width: 8,
                              height: 8,
                              decoration: const BoxDecoration(
                                color: AhramColorsV3.danger,
                                shape: BoxShape.circle,
                              ),
                            ),
                          ),
                      ],
                    ),
                    const SizedBox(height: 4),
                    Text(
                      dest.label,
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
          }),
        ),
      ),
    );
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// شبكة خدمات متكيفة
// ═════════════════════════════════════════════════════════════════════════════

class AhramAdaptiveGrid extends StatelessWidget {
  final List<Widget> children;
  final double childAspectRatio;
  final double crossAxisSpacing;
  final double mainAxisSpacing;
  final EdgeInsets? padding;

  const AhramAdaptiveGrid({
    super.key,
    required this.children,
    this.childAspectRatio = 1.15,
    this.crossAxisSpacing = 14,
    this.mainAxisSpacing = 14,
    this.padding,
  });

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        final crossCount = _calculateCrossAxisCount(constraints.maxWidth);

        return GridView.count(
          shrinkWrap: true,
          physics: const NeverScrollableScrollPhysics(),
          crossAxisCount: crossCount,
          childAspectRatio: childAspectRatio,
          crossAxisSpacing: crossAxisSpacing,
          mainAxisSpacing: mainAxisSpacing,
          padding: padding ?? AhramAdaptiveLayout.responsivePadding(context),
          children: children,
        );
      },
    );
  }

  int _calculateCrossAxisCount(double width) {
    if (width < 400) return 2;
    if (width < 600) return 3;
    if (width < 900) return 4;
    if (width < 1200) return 5;
    return 6;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// حاوية محتوى متمركزة (للشاشات الكبيرة)
// ═════════════════════════════════════════════════════════════════════════════

class AhramCenteredContent extends StatelessWidget {
  final Widget child;
  final double? maxWidth;
  final EdgeInsets? padding;

  const AhramCenteredContent({
    super.key,
    required this.child,
    this.maxWidth,
    this.padding,
  });

  @override
  Widget build(BuildContext context) {
    return Center(
      child: ConstrainedBox(
        constraints: BoxConstraints(
          maxWidth: maxWidth ?? AhramAdaptiveLayout.contentMaxWidth(context),
        ),
        child: Padding(
          padding: padding ?? AhramAdaptiveLayout.responsivePadding(context),
          child: child,
        ),
      ),
    );
  }
}
