import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../appearance_controller.dart';
import '../../ahram_2030.dart';
import '../../app_screens.dart';
import '../../brand_theme.dart';
import '../../language_controller.dart';
import '../../mobile_api.dart';
import '../../rate_alerts/rate_alert_overlay.dart';
import '../../workspace/workspace_nav.dart';
import 'components/customer_command_palette.dart';
import 'components/inspector_panel.dart';
import 'customer_breakpoints.dart';
import 'customer_portal_scope.dart';
import 'customer_theme.dart';
import 'pages/customer_home_page.dart';

/// Adaptive customer workspace — mobile bottom nav + desktop sidebar + inspector.
class CustomerPortalShell extends StatefulWidget {
  const CustomerPortalShell({
    super.key,
    required this.controller,
    required this.appearance,
    required this.language,
    this.pendingRateAlert,
    this.activatedRateAlert,
    this.onRateAlertExpired,
    required this.onLogout,
  });

  final SessionController controller;
  final AppearanceController appearance;
  final LanguageController language;
  final Map<String, dynamic>? pendingRateAlert;
  final Map<String, dynamic>? activatedRateAlert;
  final VoidCallback? onRateAlertExpired;
  final Future<void> Function() onLogout;

  @override
  State<CustomerPortalShell> createState() => _CustomerPortalShellState();
}

class _CustomerPortalShellState extends State<CustomerPortalShell> {
  int _index = 0;
  Widget? _inspector;
  String _inspectorTitle = 'التفاصيل';

  void _setInspector(Widget? panel, {String? title}) {
    setState(() {
      _inspector = panel;
      if (title != null) _inspectorTitle = title;
    });
  }

  void _selectTab(int index) => setState(() => _index = index);

  Future<void> _openCommandPalette() async {
    await showCustomerCommandPalette(
      context,
      actions: [
        CustomerCommandAction(
          label: 'تحويل جديد',
          subtitle: 'فتح منضدة التحويل',
          icon: Icons.send_to_mobile_outlined,
          onSelected: () => _selectTab(1),
        ),
        CustomerCommandAction(
          label: 'أسعار الصرف',
          subtitle: 'لوحة الأسعار الحية',
          icon: Icons.currency_exchange_outlined,
          onSelected: () => _selectTab(2),
        ),
        CustomerCommandAction(
          label: 'تقارير اليوم',
          subtitle: 'سجل العمليات والإحصائيات',
          icon: Icons.assessment_outlined,
          onSelected: () => _selectTab(3),
        ),
        CustomerCommandAction(
          label: 'بحث عن عملية',
          subtitle: 'برقم الهاتف أو رقم العملية',
          icon: Icons.manage_search_outlined,
          onSelected: () {
            _selectTab(3);
            unawaited(
              Navigator.of(context).push<void>(
                MaterialPageRoute<void>(
                  builder: (_) => CustomerReportsScreen(
                    controller: widget.controller,
                    embeddedInPortal: true,
                    initialSection: 2,
                  ),
                ),
              ),
            );
          },
        ),
        CustomerCommandAction(
          label: 'الحساب والإعدادات',
          subtitle: 'الملف · الأمان · التفضيلات',
          icon: Icons.account_circle_outlined,
          onSelected: _openAccountSettings,
        ),
        CustomerCommandAction(
          label: 'الدعم الفني',
          subtitle: 'تذاكر الدعم والمحادثات',
          icon: Icons.support_agent_outlined,
          onSelected: () => _selectTab(4),
        ),
      ],
    );
  }

  Future<void> _openAccountSettings() async {
    await Navigator.of(context).push<void>(
      MaterialPageRoute<void>(
        builder: (_) => Scaffold(
          appBar: AppBar(title: const Text('الحساب والإعدادات')),
          body: CustomerAccountScreen(
            controller: widget.controller,
            appearance: widget.appearance,
            language: widget.language,
            embeddedInPortal: true,
            showWalletHero: true,
          ),
        ),
      ),
    );
  }

  List<WorkspaceNavSpec> get _nav =>
      workspaceNavFor(widget.controller.workspaceKind);

  List<Widget> _pages() {
    return [
      CustomerHomePage(
        controller: widget.controller,
        onNavigateTab: _selectTab,
        onOpenAccountSettings: _openAccountSettings,
      ),
      TransferScreen(
        controller: widget.controller,
        customerPortal: true,
        embeddedInPortal: true,
      ),
      CustomerRatesPortalPage(controller: widget.controller),
      CustomerReportsPortalPage(controller: widget.controller),
      CustomerSupportPortalPage(controller: widget.controller),
    ];
  }

  @override
  Widget build(BuildContext context) {
    final nav = _nav;
    final pages = _pages();
    final width = MediaQuery.sizeOf(context).width;
    final useBottom = customerUseBottomNav(width);
    final showInspector = customerShowInspector(width);
    final session = widget.controller.session;

    final body = CustomerPortalScope(
      setInspector: _setInspector,
      child: IndexedStack(index: _index, children: pages),
    );

    final workspace = showInspector
        ? Row(
            children: [
              Expanded(child: body),
              CustomerInspectorPanel(
                title: _inspectorTitle,
                child: _inspector,
              ),
            ],
          )
        : body;

    final sidebar = _CustomerSidebar(
      nav: nav,
      index: _index,
      balance: session?.balance ?? 0,
      name: session?.name ?? '',
      onSelected: _selectTab,
      onLogout: widget.onLogout,
      onToggleTheme: widget.appearance.toggle,
      isDark: widget.appearance.isDark,
      extended: width >= CustomerTheme.sidebarWidth + 200,
    );

    final shellBody = customerUseSidebar(width)
        ? Column(
            children: [
              if (!useBottom)
                Material(
                  color: Theme.of(context).colorScheme.surface,
                  child: Padding(
                    padding: const EdgeInsets.fromLTRB(16, 10, 16, 10),
                    child: Row(
                      children: [
                        Text(
                          nav[_index].label,
                          style: Theme.of(context).textTheme.titleLarge?.copyWith(
                            fontWeight: FontWeight.w900,
                          ),
                        ),
                        const Spacer(),
                        OutlinedButton.icon(
                          onPressed: _openCommandPalette,
                          icon: const Icon(Icons.search, size: 18),
                          label: const Text('بحث سريع'),
                        ),
                      ],
                    ),
                  ),
                ),
              Expanded(
                child: Row(
                  children: [
                    sidebar,
                    Expanded(child: workspace),
                  ],
                ),
              ),
            ],
          )
        : workspace;

    final scaffold = Scaffold(
        appBar: useBottom
            ? AppBar(
                title: Text(nav[_index].label),
                actions: [
                  IconButton(
                    tooltip: widget.appearance.isDark
                        ? 'الوضع النهاري'
                        : 'الوضع الليلي',
                    onPressed: widget.appearance.toggle,
                    icon: Icon(
                      widget.appearance.isDark
                          ? Icons.light_mode_outlined
                          : Icons.dark_mode_outlined,
                    ),
                  ),
                  IconButton(
                    tooltip: 'تسجيل الخروج',
                    onPressed: widget.onLogout,
                    icon: const Icon(Icons.logout_outlined),
                  ),
                ],
              )
            : null,
        body: Stack(
          children: [
            shellBody,
            if (widget.pendingRateAlert != null)
              Align(
                alignment: AlignmentDirectional.topCenter,
                child: RateAlertOverlay(
                  alert: widget.pendingRateAlert!,
                  onExpired: widget.onRateAlertExpired,
                ),
              ),
            if (widget.activatedRateAlert != null)
              Align(
                alignment: AlignmentDirectional.topCenter,
                child: RateAlertOverlay(
                  alert: widget.activatedRateAlert!,
                  activated: true,
                ),
              ),
          ],
        ),
        floatingActionButton: useBottom && _index != 1
            ? FloatingActionButton.extended(
                onPressed: () => _selectTab(1),
                backgroundColor: CustomerTheme.action,
                foregroundColor: CustomerTheme.canvas,
                icon: const Icon(Icons.send_to_mobile_outlined),
                label: const Text('تحويل'),
              )
            : null,
        bottomNavigationBar: useBottom
            ? Padding(
                padding: const EdgeInsets.fromLTRB(10, 0, 10, 10),
                child: DecoratedBox(
                  decoration: BoxDecoration(
                    color: Theme.of(context).colorScheme.surface,
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(
                      color: CustomerTheme.action.withValues(alpha: 0.28),
                    ),
                  ),
                  child: Ahram2030Navigation(
                    index: _index,
                    onSelected: _selectTab,
                    items: nav
                        .map(
                          (item) => Ahram2030NavItem(
                            label: item.label,
                            icon: item.icon,
                          ),
                        )
                        .toList(),
                  ),
                ),
              )
            : null,
      );

    return Theme(
      data: AhramTheme.customer(Theme.of(context).brightness),
      child: Shortcuts(
        shortcuts: {
          LogicalKeySet(LogicalKeyboardKey.control, LogicalKeyboardKey.keyK):
              const CustomerCommandPaletteIntent(),
        },
        child: Actions(
          actions: {
            CustomerCommandPaletteIntent: CallbackAction<CustomerCommandPaletteIntent>(
              onInvoke: (_) {
                unawaited(_openCommandPalette());
                return null;
              },
            ),
          },
          child: Focus(
            autofocus: true,
            child: scaffold,
          ),
        ),
      ),
    );
  }
}

class _CustomerSidebar extends StatelessWidget {
  const _CustomerSidebar({
    required this.nav,
    required this.index,
    required this.balance,
    required this.name,
    required this.onSelected,
    required this.onLogout,
    required this.onToggleTheme,
    required this.isDark,
    required this.extended,
  });

  final List<WorkspaceNavSpec> nav;
  final int index;
  final double balance;
  final String name;
  final ValueChanged<int> onSelected;
  final Future<void> Function() onLogout;
  final VoidCallback onToggleTheme;
  final bool isDark;
  final bool extended;

  @override
  Widget build(BuildContext context) {
    final width = extended
        ? CustomerTheme.sidebarWidth
        : CustomerTheme.compactRailWidth;
    final sidebarBg =
        isDark ? AhramColors.nightSurface : CustomerTheme.canvas;
    final borderColor = isDark
        ? AhramColors.nightLine.withValues(alpha: 0.55)
        : Colors.white.withValues(alpha: 0.12);
    final labelMuted =
        isDark ? const Color(0xFFB7C6D2) : Colors.white.withValues(alpha: 0.72);
    final labelActive = isDark ? Colors.white : Colors.white;

    return Container(
      width: width,
      decoration: BoxDecoration(
        color: sidebarBg,
        border: Border(
          left: BorderSide(color: borderColor),
          boxShadow: isDark
              ? [
                  BoxShadow(
                    color: Colors.black.withValues(alpha: 0.28),
                    blurRadius: 18,
                    offset: const Offset(4, 0),
                  ),
                ]
              : null,
        ),
      ),
      child: SafeArea(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 18, 16, 12),
              child: extended
                  ? Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const BrandMark(compact: true),
                        const SizedBox(height: 14),
                        Text(
                          'محفظة الأهرام',
                          style: TextStyle(
                            color: labelMuted,
                            fontSize: 12,
                            fontWeight: FontWeight.w700,
                          ),
                        ),
                        const SizedBox(height: 4),
                        Text(
                          name,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            color: labelActive,
                            fontWeight: FontWeight.w900,
                            fontSize: 16,
                          ),
                        ),
                        const SizedBox(height: 10),
                        Container(
                          padding: const EdgeInsets.all(10),
                          decoration: BoxDecoration(
                            color: isDark
                                ? AhramColors.night.withValues(alpha: 0.55)
                                : Colors.white.withValues(alpha: 0.08),
                            borderRadius: BorderRadius.circular(10),
                            border: Border.all(
                              color: CustomerTheme.action.withValues(alpha: 0.35),
                            ),
                          ),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                'الرصيد',
                                style: TextStyle(
                                  color: labelMuted,
                                  fontSize: 11,
                                ),
                              ),
                              Text(
                                '${formatAmount(balance)} د.ل',
                                style: const TextStyle(
                                  color: CustomerTheme.action,
                                  fontWeight: FontWeight.w900,
                                  fontSize: 18,
                                ),
                              ),
                            ],
                          ),
                        ),
                      ],
                    )
                  : const Center(child: BrandMark(iconOnly: true)),
            ),
            const Divider(height: 1, color: Color(0x33FFFFFF)),
            Expanded(
              child: ListView.builder(
                padding: const EdgeInsets.symmetric(vertical: 8),
                itemCount: nav.length,
                itemBuilder: (context, i) {
                  final item = nav[i];
                  final selected = i == index;
                  return Padding(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 10,
                      vertical: 3,
                    ),
                    child: Material(
                      color: selected
                          ? CustomerTheme.action.withValues(alpha: 0.18)
                          : Colors.transparent,
                      borderRadius: BorderRadius.circular(10),
                      child: InkWell(
                        onTap: () => onSelected(i),
                        borderRadius: BorderRadius.circular(10),
                        child: Padding(
                          padding: EdgeInsets.symmetric(
                            horizontal: extended ? 14 : 8,
                            vertical: 12,
                          ),
                          child: Row(
                            children: [
                              Icon(
                                item.icon,
                                color: selected
                                    ? CustomerTheme.action
                                    : labelMuted,
                              ),
                              if (extended) ...[
                                const SizedBox(width: 12),
                                Expanded(
                                  child: Text(
                                    item.label,
                                    style: TextStyle(
                                      color: selected ? labelActive : labelMuted,
                                      fontWeight: selected
                                          ? FontWeight.w900
                                          : FontWeight.w700,
                                    ),
                                  ),
                                ),
                              ],
                            ],
                          ),
                        ),
                      ),
                    ),
                  );
                },
              ),
            ),
            Padding(
              padding: const EdgeInsets.all(12),
              child: Column(
                children: [
                  IconButton(
                    tooltip: isDark ? 'الوضع النهاري' : 'الوضع الليلي',
                    onPressed: onToggleTheme,
                    icon: Icon(
                      isDark
                          ? Icons.light_mode_outlined
                          : Icons.dark_mode_outlined,
                      color: labelMuted,
                    ),
                  ),
                  IconButton(
                    tooltip: 'تسجيل الخروج',
                    onPressed: onLogout,
                    icon: Icon(Icons.logout_outlined, color: labelMuted),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Market board wrapper for exchange rates.
class CustomerRatesPortalPage extends StatelessWidget {
  const CustomerRatesPortalPage({super.key, required this.controller});

  final SessionController controller;

  @override
  Widget build(BuildContext context) {
    final desktop = customerLayoutMode(MediaQuery.sizeOf(context).width) !=
        CustomerLayoutMode.compact &&
        MediaQuery.sizeOf(context).width >= 850;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (desktop)
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 16, 20, 0),
            child: Text(
              'لوحة الأسعار',
              style: Theme.of(context).textTheme.titleLarge?.copyWith(
                fontWeight: FontWeight.w900,
              ),
            ),
          ),
        Expanded(
          child: ExchangeRatesScreen(
            controller: controller,
            embeddedInPortal: true,
          ),
        ),
      ],
    );
  }
}

/// Timeline reports wrapper.
class CustomerReportsPortalPage extends StatelessWidget {
  const CustomerReportsPortalPage({super.key, required this.controller});

  final SessionController controller;

  @override
  Widget build(BuildContext context) {
    return CustomerReportsScreen(
      controller: controller,
      embeddedInPortal: true,
    );
  }
}

/// Support inbox wrapper.
class CustomerSupportPortalPage extends StatelessWidget {
  const CustomerSupportPortalPage({super.key, required this.controller});

  final SessionController controller;

  @override
  Widget build(BuildContext context) {
    final wide = MediaQuery.sizeOf(context).width >= 850;
    return SupportScreen(
      controller: controller,
      embeddedInPortal: wide,
    );
  }
}
