import 'dart:async';
import 'dart:convert';
import 'dart:ui' as ui;

import 'package:flutter/services.dart';
import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:intl/intl.dart';

import 'appearance_controller.dart';
import 'mobile_api.dart';

const _navy = Color(0xFF10233F);
const _green = Color(0xFF009B68);
const _gold = Color(0xFFF1B931);
const _danger = Color(0xFFD84A57);

String formatAmount(num? value, {int fractionDigits = 2}) {
  return NumberFormat.currency(
    locale: 'en',
    symbol: '',
    decimalDigits: fractionDigits,
  ).format(value ?? 0).trim();
}

String formatDate(dynamic value) {
  if (value == null) return '-';
  final parsed = DateTime.tryParse('$value');
  if (parsed == null) return '$value';
  return DateFormat('yyyy/MM/dd - hh:mm a', 'ar').format(parsed.toLocal());
}

double numberValue(dynamic value, [double fallback = 0]) {
  if (value is num) return value.toDouble();
  return double.tryParse('$value') ?? fallback;
}

String serviceLabel(String? key) {
  const labels = <String, String>{
    'vodafone': 'محافظ كاش',
    'post_account': 'بريد حساب',
    'post_card': 'بريد بطاقة',
    'bank_transfer': 'حساب بنكي',
    'sefa_niger': 'سيفا النيجر',
    'nita': 'NITA',
    'nita_account': 'NITA ACCOUNT',
  };
  return labels[key] ?? key ?? 'تحويل';
}

String statusLabel(String? status) {
  const labels = <String, String>{
    'pending': 'قيد المراجعة',
    'processing': 'بانتظار التنفيذ',
    'accepted': 'قيد التنفيذ',
    'completed': 'ناجحة',
    'cancelled': 'ملغية',
    'rejected': 'مرفوضة',
    'deposit': 'إيداع',
    'deduction': 'خصم',
  };
  return labels[status] ?? status ?? 'غير معروفة';
}

Color statusColor(String? status) {
  switch (status) {
    case 'completed':
    case 'deposit':
      return _green;
    case 'cancelled':
    case 'rejected':
    case 'deduction':
      return _danger;
    case 'accepted':
    case 'processing':
      return const Color(0xFF1976D2);
    default:
      return const Color(0xFF8A6200);
  }
}

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key, required this.controller});

  final SessionController controller;

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _formKey = GlobalKey<FormState>();
  final _username = TextEditingController();
  final _password = TextEditingController();
  bool _busy = false;
  bool _obscure = true;
  String? _error;

  @override
  void dispose() {
    _username.dispose();
    _password.dispose();
    super.dispose();
  }

  Future<void> _signIn() async {
    if (!_formKey.currentState!.validate()) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await widget.controller.signIn(
        username: _username.text.trim(),
        password: _password.text,
      );
    } on ApiFailure catch (error) {
      if (mounted) setState(() => _error = error.message);
    } catch (_) {
      if (mounted) {
        setState(
          () => _error = 'تعذر تسجيل الدخول حالياً، يرجى المحاولة مرة أخرى.',
        );
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: LayoutBuilder(
          builder: (context, constraints) {
            return Center(
              child: SingleChildScrollView(
                padding: const EdgeInsets.all(24),
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 430),
                  child: Container(
                    padding: const EdgeInsets.all(28),
                    decoration: BoxDecoration(
                      color: Colors.white,
                      borderRadius: BorderRadius.circular(12),
                      boxShadow: const [
                        BoxShadow(
                          color: Color(0x120B1D35),
                          blurRadius: 32,
                          offset: Offset(0, 12),
                        ),
                      ],
                    ),
                    child: Form(
                      key: _formKey,
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          const Center(child: BrandMark(large: true)),
                          const SizedBox(height: 28),
                          Text(
                            'تسجيل الدخول',
                            style: Theme.of(context).textTheme.headlineSmall
                                ?.copyWith(
                                  color: _navy,
                                  fontWeight: FontWeight.w800,
                                ),
                          ),
                          const SizedBox(height: 6),
                          Text(
                            'استخدم بيانات حسابك للدخول إلى المنظومة.',
                            style: Theme.of(context).textTheme.bodyMedium
                                ?.copyWith(color: const Color(0xFF60708A)),
                          ),
                          const SizedBox(height: 24),
                          TextFormField(
                            controller: _username,
                            keyboardType: TextInputType.text,
                            textDirection: ui.TextDirection.ltr,
                            decoration: const InputDecoration(
                              labelText: 'اسم المستخدم',
                              prefixIcon: Icon(Icons.person_outline),
                            ),
                            validator: (value) {
                              if ((value ?? '').trim().length < 3) {
                                return 'أدخل اسم مستخدم صحيحاً.';
                              }
                              return null;
                            },
                            onFieldSubmitted: (_) => _signIn(),
                          ),
                          const SizedBox(height: 14),
                          TextFormField(
                            controller: _password,
                            obscureText: _obscure,
                            textDirection: ui.TextDirection.ltr,
                            decoration: InputDecoration(
                              labelText: 'كلمة المرور',
                              prefixIcon: const Icon(Icons.lock_outline),
                              suffixIcon: IconButton(
                                tooltip: _obscure
                                    ? 'إظهار كلمة المرور'
                                    : 'إخفاء كلمة المرور',
                                onPressed: () =>
                                    setState(() => _obscure = !_obscure),
                                icon: Icon(
                                  _obscure
                                      ? Icons.visibility_outlined
                                      : Icons.visibility_off_outlined,
                                ),
                              ),
                            ),
                            validator: (value) {
                              if ((value ?? '').length < 4) {
                                return 'كلمة المرور يجب أن تحتوي على 4 أحرف على الأقل.';
                              }
                              return null;
                            },
                            onFieldSubmitted: (_) => _signIn(),
                          ),
                          if (_error != null) ...[
                            const SizedBox(height: 14),
                            InlineMessage(message: _error!, color: _danger),
                          ],
                          const SizedBox(height: 22),
                          FilledButton.icon(
                            onPressed: _busy ? null : _signIn,
                            icon: _busy
                                ? const SizedBox(
                                    width: 18,
                                    height: 18,
                                    child: CircularProgressIndicator(
                                      strokeWidth: 2,
                                      color: Colors.white,
                                    ),
                                  )
                                : const Icon(Icons.login),
                            label: Text(_busy ? 'جارٍ التحقق...' : 'دخول آمن'),
                            style: FilledButton.styleFrom(
                              minimumSize: const Size.fromHeight(54),
                              backgroundColor: _green,
                            ),
                          ),
                          const SizedBox(height: 18),
                          Text(
                            'Power Pay AL-Ahram',
                            textAlign: TextAlign.center,
                            style: Theme.of(context).textTheme.labelLarge
                                ?.copyWith(
                                  color: const Color(0xFF60708A),
                                  letterSpacing: 0,
                                ),
                          ),
                        ],
                      ),
                    ),
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

class RoleShell extends StatefulWidget {
  const RoleShell({
    super.key,
    required this.controller,
    required this.appearance,
  });

  final SessionController controller;
  final AppearanceController appearance;

  @override
  State<RoleShell> createState() => _RoleShellState();
}

class _RoleShellState extends State<RoleShell> {
  late final List<_NavItem> _items;
  int _index = 0;
  Map<String, dynamic>? _executorOverview;

  @override
  void initState() {
    super.initState();
    _items = _createItems();
    if (widget.controller.isExecutor) {
      unawaited(_loadExecutorOverview());
    }
  }

  Future<void> _loadExecutorOverview() async {
    try {
      final response = await widget.controller.api.executorOverview();
      final data = response['data'];
      if (mounted && data is Map) {
        setState(() => _executorOverview = Map<String, dynamic>.from(data));
      }
    } catch (_) {
      // Individual pages provide a retry state; navigation remains available.
    }
  }

  List<_NavItem> _createItems() {
    if (widget.controller.isExecutor) {
      if (widget.controller.isExecutorManager) {
        return [
          _NavItem(
            'مهام التنفيذ',
            Icons.assignment_turned_in_outlined,
            ExecutorTasksScreen(controller: widget.controller),
          ),
          _NavItem(
            'التقارير',
            Icons.assessment_outlined,
            ExecutorReportsScreen(controller: widget.controller),
          ),
          _NavItem(
            'الموظفون',
            Icons.manage_accounts_outlined,
            ExecutorEmployeesScreen(controller: widget.controller),
          ),
          _NavItem(
            'الإعدادات',
            Icons.settings_outlined,
            ExecutorSettingsScreen(controller: widget.controller),
          ),
        ];
      }
      if (widget.controller.isExecutorAccountant) {
        return [
          _NavItem(
            'التقارير',
            Icons.assessment_outlined,
            ExecutorReportsScreen(controller: widget.controller),
          ),
          _NavItem(
            'الإعدادات',
            Icons.settings_outlined,
            ExecutorSettingsScreen(controller: widget.controller),
          ),
        ];
      }
      if (widget.controller.isExecutorOperator) {
        return [
          _NavItem(
            'مهام التنفيذ',
            Icons.assignment_turned_in_outlined,
            ExecutorTasksScreen(controller: widget.controller),
          ),
          _NavItem(
            'التقارير',
            Icons.assessment_outlined,
            ExecutorReportsScreen(controller: widget.controller),
          ),
          _NavItem(
            'الإعدادات',
            Icons.settings_outlined,
            ExecutorSettingsScreen(controller: widget.controller),
          ),
        ];
      }
      return [
        _NavItem(
          'مهام التنفيذ',
          Icons.assignment_turned_in_outlined,
          ExecutorTasksScreen(controller: widget.controller),
        ),
        _NavItem(
          'الحساب',
          Icons.manage_accounts_outlined,
          AccountScreen(controller: widget.controller),
        ),
      ];
    }
    if (widget.controller.isAgent) {
      return [
        _NavItem(
          'الرئيسية',
          Icons.space_dashboard_outlined,
          AgentOverviewScreen(controller: widget.controller),
        ),
        _NavItem(
          'العملاء',
          Icons.groups_2_outlined,
          SubAccountsScreen(controller: widget.controller),
        ),
        _NavItem(
          'تحويل',
          Icons.send_to_mobile_outlined,
          TransferScreen(controller: widget.controller),
        ),
        _NavItem(
          'الدعم',
          Icons.support_agent_outlined,
          SupportScreen(controller: widget.controller),
        ),
      ];
    }
    return [
      _NavItem(
        'الرئيسية',
        Icons.space_dashboard_outlined,
        ClientHomeScreen(controller: widget.controller),
      ),
      _NavItem(
        'تحويل',
        Icons.send_to_mobile_outlined,
        TransferScreen(controller: widget.controller),
      ),
      _NavItem(
        'العمليات',
        Icons.receipt_long_outlined,
        TransactionsScreen(controller: widget.controller),
      ),
      _NavItem(
        'الدعم',
        Icons.support_agent_outlined,
        SupportScreen(controller: widget.controller),
      ),
    ];
  }

  String get _roleLabel {
    if (widget.controller.isExecutorManager) return 'مدير تنفيذي';
    if (widget.controller.isExecutorAccountant) return 'محاسب تنفيذي';
    if (widget.controller.isExecutor) return 'موظف تنفيذ';
    if (widget.controller.isAgent) return 'وكالة';
    if (widget.controller.isCompany) return 'شركة';
    return 'عميل';
  }

  Future<void> _confirmLogout() async {
    final approved = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('تسجيل الخروج'),
        content: const Text('هل تريد إنهاء جلستك على هذا الجهاز؟'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('إلغاء'),
          ),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: _danger),
            onPressed: () => Navigator.pop(context, true),
            child: const Text('تسجيل الخروج'),
          ),
        ],
      ),
    );
    if (approved == true && mounted) await widget.controller.signOut();
  }

  @override
  Widget build(BuildContext context) {
    final selected = _items[_index];
    final company = _executorOverview?['company'];
    final performance = _executorOverview?['myPerformance'];
    final companyName = company is Map
        ? '${company['name'] ?? widget.controller.session?.context['executorGroupName'] ?? ''}'
        : '${widget.controller.session?.context['executorGroupName'] ?? ''}';
    final companyBalance = company is Map ? numberValue(company['balance']) : 0;
    final ownPerformance = performance is Map
        ? numberValue(performance['totalLYD'])
        : 0;
    final executorSubtitle = widget.controller.isExecutorManager
        ? '$companyName · رصيد الشركة ${formatAmount(companyBalance)} د.ل'
        : (widget.controller.isExecutorAccountant
              ? '$companyName · رصيد الشركة ${formatAmount(companyBalance)} د.ل'
              : '$companyName · تنفيذاتك اليوم ${formatAmount(ownPerformance)} د.ل');
    final appBar = AppBar(
      titleSpacing: 18,
      title: Row(
        children: [
          const BrandMark(compact: true),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  widget.controller.isExecutor ? companyName : selected.label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontWeight: FontWeight.w800,
                    color: Theme.of(context).colorScheme.onSurface,
                  ),
                ),
                Text(
                  widget.controller.isExecutor
                      ? executorSubtitle
                      : '${widget.controller.session?.name ?? ''} · $_roleLabel',
                  style: TextStyle(
                    fontSize: 11,
                    color: Theme.of(context).colorScheme.onSurfaceVariant,
                  ),
                  overflow: TextOverflow.ellipsis,
                ),
              ],
            ),
          ),
        ],
      ),
      actions: [
        if (widget.controller.isExecutor)
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
          onPressed: _confirmLogout,
          icon: const Icon(Icons.logout_outlined),
        ),
        const SizedBox(width: 6),
      ],
    );

    final pages = IndexedStack(
      index: _index,
      children: _items.map((item) => item.page).toList(),
    );
    return LayoutBuilder(
      builder: (context, constraints) {
        final desktop = constraints.maxWidth >= 850;
        return Scaffold(
          appBar: appBar,
          body: desktop
              ? Row(
                  children: [
                    NavigationRail(
                      selectedIndex: _index,
                      onDestinationSelected: (next) =>
                          setState(() => _index = next),
                      labelType: NavigationRailLabelType.all,
                      backgroundColor: Theme.of(context).colorScheme.surface,
                      leading: const SizedBox(height: 12),
                      destinations: _items
                          .map(
                            (item) => NavigationRailDestination(
                              icon: Icon(item.icon),
                              selectedIcon: Icon(item.icon, color: _green),
                              label: Text(item.label),
                            ),
                          )
                          .toList(),
                    ),
                    const VerticalDivider(width: 1, color: Color(0xFFDCE4EF)),
                    Expanded(child: pages),
                  ],
                )
              : pages,
          bottomNavigationBar: desktop
              ? null
              : NavigationBar(
                  selectedIndex: _index,
                  onDestinationSelected: (next) =>
                      setState(() => _index = next),
                  destinations: _items
                      .map(
                        (item) => NavigationDestination(
                          icon: Icon(item.icon),
                          label: item.label,
                        ),
                      )
                      .toList(),
                ),
        );
      },
    );
  }
}

class _NavItem {
  const _NavItem(this.label, this.icon, this.page);

  final String label;
  final IconData icon;
  final Widget page;
}

class ClientHomeScreen extends StatefulWidget {
  const ClientHomeScreen({super.key, required this.controller});

  final SessionController controller;

  @override
  State<ClientHomeScreen> createState() => _ClientHomeScreenState();
}

class _ClientHomeScreenState extends State<ClientHomeScreen> {
  Map<String, dynamic>? _home;
  Object? _error;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    if (mounted) {
      setState(() {
        _loading = true;
        _error = null;
      });
    }
    try {
      _home = await widget.controller.refreshHome();
    } catch (error) {
      _error = error;
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_loading && _home == null) return const PageLoading();
    if (_error != null && _home == null) {
      return ErrorPage(error: _error!, onRetry: _load);
    }
    final session = widget.controller.session!;
    final home = _home ?? <String, dynamic>{};
    final rates = home['serviceRates'] is Map
        ? Map<String, dynamic>.from(home['serviceRates'] as Map)
        : session.serviceRates;
    final catalog = home['serviceCatalog'] is List
        ? (home['serviceCatalog'] as List)
              .whereType<Map>()
              .map((item) => Map<String, dynamic>.from(item))
              .toList()
        : session.serviceCatalog;

    return PageFrame(
      title: widget.controller.isCompany ? 'ملخص الشركة' : 'ملخص الحساب',
      subtitle: widget.controller.isCompany
          ? 'متابعة الرصيد وأسعار الخدمات والعمليات الجارية.'
          : 'آخر حالة لحسابك وأسعار الخدمات المتاحة.',
      onRefresh: _load,
      child: [
        AccountHero(
          name: session.name,
          role: widget.controller.isCompany ? 'حساب شركة' : 'حساب عميل',
          balance: numberValue(home['balance'], session.balance),
          showBalance: !widget.controller.hidesBalance,
          systemOpen: home['isOpen'] != false,
        ),
        const SizedBox(height: 18),
        Wrap(
          spacing: 12,
          runSpacing: 12,
          children: [
            StatTile(
              label: 'سعر محافظ كاش',
              value: formatAmount(
                numberValue(rates['vodafone'], session.exchangeRate),
              ),
              suffix: 'د.ل',
              icon: Icons.currency_exchange_outlined,
              color: _green,
            ),
            StatTile(
              label: 'المستوى',
              value: '${home['tier'] ?? session.tier}',
              suffix: 'حساب',
              icon: Icons.workspace_premium_outlined,
              color: _gold,
            ),
            if (session.availableToSpend != null &&
                !widget.controller.hidesBalance)
              StatTile(
                label: 'المتاح للتحويل',
                value: formatAmount(session.availableToSpend),
                suffix: 'د.ل',
                icon: Icons.account_balance_wallet_outlined,
                color: const Color(0xFF3366CC),
              ),
          ],
        ),
        const SizedBox(height: 28),
        SectionTitle(title: 'أسعار الخدمات', icon: Icons.price_check_outlined),
        const SizedBox(height: 12),
        if (rates.isEmpty)
          const EmptyPanel(
            icon: Icons.currency_exchange_outlined,
            title: 'لا توجد أسعار متاحة حالياً',
            message: 'اسحب الصفحة للتحديث أو تواصل مع الإدارة.',
          )
        else
          GridView.builder(
            shrinkWrap: true,
            physics: const NeverScrollableScrollPhysics(),
            gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
              maxCrossAxisExtent: 250,
              mainAxisExtent: 126,
              mainAxisSpacing: 12,
              crossAxisSpacing: 12,
            ),
            itemCount: rates.length,
            itemBuilder: (context, index) {
              final entry = rates.entries.elementAt(index);
              final label =
                  catalog
                      .cast<Map<String, dynamic>?>()
                      .firstWhere(
                        (item) => item?['key'] == entry.key,
                        orElse: () => null,
                      )?['label']
                      ?.toString() ??
                  serviceLabel(entry.key);
              return RateTile(label: label, rate: numberValue(entry.value));
            },
          ),
      ],
    );
  }
}

class TransferScreen extends StatefulWidget {
  const TransferScreen({super.key, required this.controller});

  final SessionController controller;

  @override
  State<TransferScreen> createState() => _TransferScreenState();
}

class _TransferScreenState extends State<TransferScreen> {
  final _formKey = GlobalKey<FormState>();
  final _amount = TextEditingController();
  final _number = TextEditingController();
  final _name = TextEditingController();
  final _city = TextEditingController();
  final _notes = TextEditingController();
  final _picker = ImagePicker();
  Map<String, dynamic>? _home;
  String _serviceKey = 'vodafone';
  Uint8List? _idCard;
  Uint8List? _oldReceipt;
  bool _busy = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _loadRates();
  }

  @override
  void dispose() {
    _amount.dispose();
    _number.dispose();
    _name.dispose();
    _city.dispose();
    _notes.dispose();
    super.dispose();
  }

  Future<void> _loadRates() async {
    try {
      final home = await widget.controller.refreshHome();
      if (!mounted) return;
      final services = _servicesFrom(home);
      setState(() {
        _home = home;
        if (services.isNotEmpty &&
            !services.any((item) => item['key'] == _serviceKey)) {
          _serviceKey = '${services.first['key']}';
        }
      });
    } catch (_) {
      // The login response retains enough rate data to keep the form usable.
    }
  }

  List<Map<String, dynamic>> _servicesFrom(Map<String, dynamic>? home) {
    final value =
        home?['serviceCatalog'] ?? widget.controller.session?.serviceCatalog;
    final catalog = value is List
        ? value
              .whereType<Map>()
              .map((item) => Map<String, dynamic>.from(item))
              .toList()
        : <Map<String, dynamic>>[];
    final enabled = catalog
        .where(
          (item) =>
              item['enabled'] != false && '${item['key'] ?? ''}'.isNotEmpty,
        )
        .toList();
    if (enabled.isNotEmpty) return enabled;
    return const [
      {'key': 'vodafone', 'label': 'محافظ كاش', 'numberLabel': 'رقم الهاتف'},
      {
        'key': 'post_account',
        'label': 'بريد حساب',
        'numberLabel': 'رقم الحساب',
      },
      {
        'key': 'post_card',
        'label': 'بريد بطاقة',
        'numberLabel': 'الرقم القومي',
      },
      {
        'key': 'sefa_niger',
        'label': 'سيفا النيجر',
        'numberLabel': 'رقم الحساب',
      },
    ];
  }

  Map<String, dynamic> get _service {
    final services = _servicesFrom(_home);
    return services.firstWhere(
      (item) => item['key'] == _serviceKey,
      orElse: () => services.first,
    );
  }

  bool get _requiresName {
    final fields = (_service['requiredFields'] as List? ?? const [])
        .map((item) => '$item')
        .toSet();
    return fields.contains('name') ||
        {
          'post_account',
          'post_card',
          'nita',
          'nita_account',
        }.contains(_serviceKey);
  }

  bool get _requiresCity {
    final fields = (_service['requiredFields'] as List? ?? const [])
        .map((item) => '$item')
        .toSet();
    return fields.contains('city') || _serviceKey == 'nita';
  }

  bool get _requiresIdCard => _serviceKey == 'post_card';

  bool get _showsOldReceipt => _serviceKey == 'post_account';

  double get _rate {
    final rates = _home?['serviceRates'] is Map
        ? Map<String, dynamic>.from(_home!['serviceRates'] as Map)
        : widget.controller.session?.serviceRates ?? const <String, dynamic>{};
    return numberValue(
      rates[_serviceKey],
      widget.controller.session?.exchangeRate ?? 1,
    );
  }

  Future<void> _pickImage({required bool card}) async {
    final source = await showModalBottomSheet<ImageSource>(
      context: context,
      builder: (context) => SafeArea(
        child: Wrap(
          children: [
            ListTile(
              leading: const Icon(Icons.camera_alt_outlined),
              title: const Text('التقاط صورة بالكاميرا'),
              onTap: () => Navigator.pop(context, ImageSource.camera),
            ),
            ListTile(
              leading: const Icon(Icons.photo_library_outlined),
              title: const Text('اختيار صورة من الجهاز'),
              onTap: () => Navigator.pop(context, ImageSource.gallery),
            ),
          ],
        ),
      ),
    );
    if (source == null) return;
    final selected = await _picker.pickImage(
      source: source,
      imageQuality: 72,
      maxWidth: 1600,
    );
    if (selected == null) return;
    final bytes = await selected.readAsBytes();
    if (!mounted) return;
    setState(() {
      if (card) {
        _idCard = bytes;
      } else {
        _oldReceipt = bytes;
      }
    });
  }

  Future<void> _submit() async {
    if (!_formKey.currentState!.validate()) return;
    final amount = double.tryParse(_amount.text.replaceAll(',', '').trim());
    if (amount == null || amount <= 0) {
      setState(() => _error = 'أدخل قيمة تحويل صحيحة.');
      return;
    }
    if (_requiresIdCard && _idCard == null) {
      setState(() => _error = 'صورة البطاقة الشخصية مطلوبة لهذه الخدمة.');
      return;
    }
    final payload = <String, dynamic>{
      'transferType': _serviceKey,
      'amount': amount,
      'number': _number.text.trim(),
      if (_requiresName) 'name': _name.text.trim(),
      if (_requiresCity) 'city': _city.text.trim(),
      if (_notes.text.trim().isNotEmpty) 'notes': _notes.text.trim(),
      if (_idCard != null)
        'idCardImage': 'data:image/jpeg;base64,${base64Encode(_idCard!)}',
      if (_oldReceipt != null)
        'oldReceiptImage':
            'data:image/jpeg;base64,${base64Encode(_oldReceipt!)}',
    };
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final response = await widget.controller.api.createTransfer(payload);
      try {
        await widget.controller.refreshHome();
      } catch (_) {}
      if (!mounted) return;
      await showDialog<void>(
        context: context,
        builder: (context) => AlertDialog(
          icon: const Icon(Icons.check_circle_outline, color: _green, size: 42),
          title: const Text('تم إرسال العملية'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                response['message']?.toString() ??
                    'تم تسجيل طلب التحويل بنجاح.',
              ),
              const SizedBox(height: 12),
              DetailLine(
                label: 'رقم الطلب',
                value: '${response['txId'] ?? '-'}',
              ),
              DetailLine(
                label: 'الحالة',
                value: statusLabel(response['status']?.toString()),
              ),
              if (response['newBalance'] != null)
                DetailLine(
                  label: 'الرصيد بعد العملية',
                  value:
                      '${formatAmount(numberValue(response['newBalance']))} د.ل',
                ),
            ],
          ),
          actions: [
            FilledButton(
              onPressed: () => Navigator.pop(context),
              child: const Text('تم'),
            ),
          ],
        ),
      );
      if (!mounted) return;
      _formKey.currentState?.reset();
      setState(() {
        _amount.clear();
        _number.clear();
        _name.clear();
        _city.clear();
        _notes.clear();
        _idCard = null;
        _oldReceipt = null;
      });
    } on ApiFailure catch (error) {
      if (mounted) setState(() => _error = error.message);
    } catch (_) {
      if (mounted) setState(() => _error = 'تعذر إرسال العملية حالياً.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final services = _servicesFrom(_home);
    final rate = _rate;
    final inputAmount = numberValue(_amount.text.replaceAll(',', ''));
    final sefa = _serviceKey == 'sefa_niger';
    final estimate = sefa
        ? inputAmount * rate
        : (rate == 0 ? 0 : inputAmount / rate);

    return PageFrame(
      title: 'تحويل جديد',
      subtitle: 'أدخل بيانات المستلم بدقة قبل إرسال العملية.',
      onRefresh: _loadRates,
      child: [
        Form(
          key: _formKey,
          child: ResponsivePanel(
            children: [
              DropdownButtonFormField<String>(
                initialValue: services.any((item) => item['key'] == _serviceKey)
                    ? _serviceKey
                    : '${services.first['key']}',
                decoration: const InputDecoration(
                  labelText: 'الخدمة',
                  prefixIcon: Icon(Icons.apps_outlined),
                ),
                items: services
                    .map(
                      (item) => DropdownMenuItem<String>(
                        value: '${item['key']}',
                        child: Text(
                          '${item['label'] ?? serviceLabel(item['key']?.toString())}',
                        ),
                      ),
                    )
                    .toList(),
                onChanged: _busy
                    ? null
                    : (value) => setState(() {
                        _serviceKey = value ?? _serviceKey;
                        _idCard = null;
                        _oldReceipt = null;
                        _error = null;
                      }),
              ),
              TextFormField(
                controller: _amount,
                enabled: !_busy,
                keyboardType: const TextInputType.numberWithOptions(
                  decimal: true,
                ),
                decoration: InputDecoration(
                  labelText: sefa ? 'القيمة بالسيفا' : 'القيمة بالجنيه المصري',
                  prefixIcon: const Icon(Icons.payments_outlined),
                ),
                validator: (value) {
                  final parsed = double.tryParse(
                    (value ?? '').replaceAll(',', '').trim(),
                  );
                  if (parsed == null || parsed <= 0) {
                    return 'أدخل قيمة صحيحة أكبر من صفر.';
                  }
                  return null;
                },
                onChanged: (_) => setState(() {}),
              ),
              TextFormField(
                controller: _number,
                enabled: !_busy,
                keyboardType: TextInputType.number,
                textDirection: ui.TextDirection.ltr,
                decoration: InputDecoration(
                  labelText:
                      '${_service['numberLabel'] ?? 'رقم الهاتف أو الحساب'}',
                  prefixIcon: const Icon(Icons.phone_android_outlined),
                ),
                validator: (value) {
                  final normalized = (value ?? '').replaceAll(
                    RegExp(r'\s+'),
                    '',
                  );
                  if (normalized.length < 5) return 'أدخل الرقم بشكل صحيح.';
                  if ((_serviceKey == 'nita' ||
                          _serviceKey == 'nita_account') &&
                      !RegExp(r'^\d{8,10}$').hasMatch(normalized)) {
                    return 'رقم حساب NITA يجب أن يتكون من 8 إلى 10 أرقام.';
                  }
                  return null;
                },
              ),
              if (_requiresName)
                TextFormField(
                  controller: _name,
                  enabled: !_busy,
                  decoration: const InputDecoration(
                    labelText: 'اسم العميل',
                    prefixIcon: Icon(Icons.badge_outlined),
                  ),
                  validator: (value) =>
                      (value ?? '').trim().isEmpty ? 'اسم العميل مطلوب.' : null,
                ),
              if (_requiresCity)
                TextFormField(
                  controller: _city,
                  enabled: !_busy,
                  decoration: const InputDecoration(
                    labelText: 'المدينة',
                    prefixIcon: Icon(Icons.location_city_outlined),
                  ),
                  validator: (value) => (value ?? '').trim().isEmpty
                      ? 'اسم المدينة مطلوب.'
                      : null,
                ),
              TextFormField(
                controller: _notes,
                enabled: !_busy,
                minLines: 2,
                maxLines: 3,
                maxLength: 500,
                decoration: const InputDecoration(
                  labelText: 'ملاحظة العميل (اختيارية)',
                  prefixIcon: Icon(Icons.notes_outlined),
                ),
              ),
            ],
          ),
        ),
        if (_requiresIdCard || _showsOldReceipt) ...[
          const SizedBox(height: 18),
          SectionTitle(
            title: _requiresIdCard ? 'صورة البطاقة الشخصية' : 'إيصال سابق',
            icon: Icons.image_outlined,
          ),
          const SizedBox(height: 10),
          ProofPicker(
            required: _requiresIdCard,
            image: _requiresIdCard ? _idCard : _oldReceipt,
            onPick: () => _pickImage(card: _requiresIdCard),
            onClear: () => setState(() {
              if (_requiresIdCard) {
                _idCard = null;
              } else {
                _oldReceipt = null;
              }
            }),
          ),
        ],
        const SizedBox(height: 18),
        Container(
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(
            color: const Color(0xFFEFF9F4),
            borderRadius: BorderRadius.circular(10),
            border: Border.all(color: const Color(0xFFCBEBDC)),
          ),
          child: Row(
            children: [
              const Icon(Icons.currency_exchange_outlined, color: _green),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'سعر الصرف: ${formatAmount(rate)} د.ل',
                      style: const TextStyle(fontWeight: FontWeight.w800),
                    ),
                    const SizedBox(height: 3),
                    Text(
                      sefa
                          ? 'القيمة التقديرية: ${formatAmount(estimate)} د.ل'
                          : 'القيمة التقديرية: ${formatAmount(estimate)} د.ل',
                      style: const TextStyle(color: Color(0xFF4B6375)),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
        if (_serviceKey == 'nita' || _serviceKey == 'nita_account') ...[
          const SizedBox(height: 14),
          const InlineMessage(
            message:
                'العميل مسؤول عن صحة البيانات المدخلة، ولا تتحمل الشركة مسؤولية الأخطاء الناتجة عن بيانات المستلم.',
            color: Color(0xFF8A6200),
          ),
        ],
        if (_error != null) ...[
          const SizedBox(height: 14),
          InlineMessage(message: _error!, color: _danger),
        ],
        const SizedBox(height: 22),
        FilledButton.icon(
          onPressed: _busy ? null : _submit,
          style: FilledButton.styleFrom(
            minimumSize: const Size.fromHeight(54),
            backgroundColor: _green,
          ),
          icon: _busy
              ? const SizedBox(
                  width: 18,
                  height: 18,
                  child: CircularProgressIndicator(
                    strokeWidth: 2,
                    color: Colors.white,
                  ),
                )
              : const Icon(Icons.send_outlined),
          label: Text(_busy ? 'جارٍ إرسال العملية...' : 'إرسال العملية'),
        ),
      ],
    );
  }
}

class TransactionsScreen extends StatefulWidget {
  const TransactionsScreen({super.key, required this.controller});

  final SessionController controller;

  @override
  State<TransactionsScreen> createState() => _TransactionsScreenState();
}

class _TransactionsScreenState extends State<TransactionsScreen> {
  List<Map<String, dynamic>> _transactions = <Map<String, dynamic>>[];
  Object? _error;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    if (mounted) {
      setState(() {
        _loading = true;
        _error = null;
      });
    }
    try {
      final transactions = await widget.controller.api.clientTransactions();
      if (!mounted) return;
      setState(() {
        if (widget.controller.hidesBalance) {
          final today = DateTime.now();
          _transactions = transactions.where((tx) {
            final date = DateTime.tryParse(
              '${tx['createdAt'] ?? ''}',
            )?.toLocal();
            return date != null &&
                date.year == today.year &&
                date.month == today.month &&
                date.day == today.day;
          }).toList();
        } else {
          _transactions = transactions;
        }
      });
    } catch (error) {
      _error = error;
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _openDetails(Map<String, dynamic> tx) async {
    final id = '${tx['id'] ?? ''}';
    if (id.isEmpty) return;
    try {
      final response = await widget.controller.api.transactionDetails(id);
      final detail = response['transaction'] is Map
          ? Map<String, dynamic>.from(response['transaction'] as Map)
          : tx;
      if (!mounted) return;
      showDialog<void>(
        context: context,
        builder: (context) => AlertDialog(
          title: const Text('تفاصيل العملية'),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                DetailLine(
                  label: 'رقم العملية',
                  value: '${detail['customId'] ?? detail['txId'] ?? '-'}',
                ),
                DetailLine(
                  label: 'الخدمة',
                  value:
                      '${detail['transferTypeLabel'] ?? serviceLabel(detail['transferType']?.toString())}',
                ),
                DetailLine(
                  label: 'المستلم',
                  value: '${detail['recipientNumber'] ?? '-'}',
                ),
                DetailLine(
                  label: 'القيمة',
                  value: '${formatAmount(numberValue(detail['amount']))} ج.م',
                ),
                DetailLine(
                  label: 'القيمة بالليبي',
                  value: '${formatAmount(numberValue(detail['costLYD']))} د.ل',
                ),
                DetailLine(
                  label: 'الحالة',
                  value: statusLabel(detail['status']?.toString()),
                ),
                DetailLine(
                  label: 'التاريخ',
                  value: formatDate(detail['createdAt']),
                ),
                if ('${detail['notes'] ?? ''}'.trim().isNotEmpty)
                  DetailLine(
                    label: 'ملاحظة العميل',
                    value: '${detail['notes']}',
                  ),
              ],
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context),
              child: const Text('إغلاق'),
            ),
          ],
        ),
      );
    } on ApiFailure catch (error) {
      if (mounted) showSnack(context, error.message, error: true);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_loading && _transactions.isEmpty) return const PageLoading();
    if (_error != null && _transactions.isEmpty) {
      return ErrorPage(error: _error!, onRetry: _load);
    }
    return PageFrame(
      title: widget.controller.hidesBalance ? 'عمليات اليوم' : 'سجل العمليات',
      subtitle: widget.controller.hidesBalance
          ? 'تظهر العمليات المسجلة اليوم فقط وفقاً لصلاحيات الحساب.'
          : 'آخر العمليات المنفذة أو قيد المعالجة في حسابك.',
      onRefresh: _load,
      child: [
        if (_transactions.isEmpty)
          const EmptyPanel(
            icon: Icons.receipt_long_outlined,
            title: 'لا توجد عمليات للعرض',
            message: 'ستظهر هنا العمليات بعد تسجيلها في المنظومة.',
          )
        else
          ..._transactions.map(
            (tx) => Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: TransactionTile(
                transaction: tx,
                onTap: () => _openDetails(tx),
              ),
            ),
          ),
      ],
    );
  }
}

class SupportScreen extends StatefulWidget {
  const SupportScreen({super.key, required this.controller});

  final SessionController controller;

  @override
  State<SupportScreen> createState() => _SupportScreenState();
}

class _SupportScreenState extends State<SupportScreen> {
  List<Map<String, dynamic>> _tickets = <Map<String, dynamic>>[];
  Object? _error;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    if (mounted) {
      setState(() {
        _loading = true;
        _error = null;
      });
    }
    try {
      final tickets = await widget.controller.api.tickets();
      if (mounted) setState(() => _tickets = tickets);
    } catch (error) {
      _error = error;
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _createTicket() async {
    final created = await showDialog<bool>(
      context: context,
      builder: (context) => TicketDialog(api: widget.controller.api),
    );
    if (created == true) await _load();
  }

  @override
  Widget build(BuildContext context) {
    if (_loading && _tickets.isEmpty) return const PageLoading();
    if (_error != null && _tickets.isEmpty) {
      return ErrorPage(error: _error!, onRetry: _load);
    }
    return PageFrame(
      title: 'الدعم والشكاوى',
      subtitle: 'تابع رسائلك مع فريق الدعم من خلال التذاكر المفتوحة.',
      onRefresh: _load,
      action: FilledButton.icon(
        onPressed: _createTicket,
        icon: const Icon(Icons.add_comment_outlined),
        label: const Text('تذكرة جديدة'),
      ),
      child: [
        if (_tickets.isEmpty)
          const EmptyPanel(
            icon: Icons.support_agent_outlined,
            title: 'لا توجد تذاكر مفتوحة',
            message: 'أنشئ تذكرة عندما تحتاج إلى مساعدة من فريق الدعم.',
          )
        else
          ..._tickets.map(
            (ticket) => Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: SupportTicketTile(ticket: ticket),
            ),
          ),
      ],
    );
  }
}

class AgentOverviewScreen extends StatefulWidget {
  const AgentOverviewScreen({super.key, required this.controller});

  final SessionController controller;

  @override
  State<AgentOverviewScreen> createState() => _AgentOverviewScreenState();
}

class _AgentOverviewScreenState extends State<AgentOverviewScreen> {
  Map<String, dynamic>? _data;
  Object? _error;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    if (mounted) {
      setState(() {
        _loading = true;
        _error = null;
      });
    }
    try {
      final data = await widget.controller.api.agentOverview();
      if (mounted) setState(() => _data = data);
    } catch (error) {
      _error = error;
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_loading && _data == null) return const PageLoading();
    if (_error != null && _data == null) {
      return ErrorPage(error: _error!, onRetry: _load);
    }
    final data = _data ?? <String, dynamic>{};
    final agent = data['agent'] is Map
        ? Map<String, dynamic>.from(data['agent'] as Map)
        : <String, dynamic>{};
    final summary = data['summary'] is Map
        ? Map<String, dynamic>.from(data['summary'] as Map)
        : <String, dynamic>{};
    return PageFrame(
      title: 'لوحة الوكالة',
      subtitle: 'الرصيد وإدارة حسابات العملاء التابعة للوكالة.',
      onRefresh: _load,
      child: [
        AccountHero(
          name: '${agent['name'] ?? widget.controller.session?.name ?? ''}',
          role: 'حساب وكالة',
          balance: numberValue(
            agent['balance'],
            widget.controller.session?.balance ?? 0,
          ),
          showBalance: !widget.controller.hidesBalance,
          systemOpen: true,
        ),
        const SizedBox(height: 22),
        SectionTitle(title: 'ملخص العملاء', icon: Icons.groups_2_outlined),
        const SizedBox(height: 12),
        Wrap(
          spacing: 12,
          runSpacing: 12,
          children: [
            StatTile(
              label: 'إجمالي الحسابات',
              value: '${summary['subAccountsCount'] ?? 0}',
              suffix: 'عميل',
              icon: Icons.people_outline,
              color: const Color(0xFF3366CC),
            ),
            StatTile(
              label: 'الحسابات النشطة',
              value: '${summary['activeSubAccountsCount'] ?? 0}',
              suffix: 'نشط',
              icon: Icons.verified_user_outlined,
              color: _green,
            ),
            StatTile(
              label: 'إجمالي الديون',
              value: formatAmount(numberValue(summary['totalDebt'])),
              suffix: 'د.ل',
              icon: Icons.account_balance_outlined,
              color: _danger,
            ),
            StatTile(
              label: 'المتاح للعملاء',
              value: formatAmount(
                numberValue(summary['totalAvailableToSpend']),
              ),
              suffix: 'د.ل',
              icon: Icons.savings_outlined,
              color: _gold,
            ),
          ],
        ),
        const SizedBox(height: 26),
        const InlineMessage(
          message:
              'تسويات العملاء وتعديل حدهم الائتماني تسجل مباشرة في دفتر الحركات المالية للوكالة.',
          color: Color(0xFF3366CC),
        ),
      ],
    );
  }
}

class SubAccountsScreen extends StatefulWidget {
  const SubAccountsScreen({super.key, required this.controller});

  final SessionController controller;

  @override
  State<SubAccountsScreen> createState() => _SubAccountsScreenState();
}

class _SubAccountsScreenState extends State<SubAccountsScreen> {
  List<Map<String, dynamic>> _accounts = <Map<String, dynamic>>[];
  Object? _error;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    if (mounted) {
      setState(() {
        _loading = true;
        _error = null;
      });
    }
    try {
      final accounts = await widget.controller.api.agentSubAccounts();
      if (mounted) setState(() => _accounts = accounts);
    } catch (error) {
      _error = error;
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _create() async {
    final saved = await showDialog<bool>(
      context: context,
      builder: (context) => SubAccountDialog(api: widget.controller.api),
    );
    if (saved == true) await _load();
  }

  Future<void> _setLimit(Map<String, dynamic> account) async {
    final result = await showDialog<double>(
      context: context,
      builder: (context) => AmountDialog(
        title: 'تعديل الحد الائتماني',
        label: 'الحد الائتماني بالدينار الليبي',
        initial: numberValue(account['creditLimit']),
        actionLabel: 'حفظ الحد',
      ),
    );
    if (result == null) return;
    try {
      await widget.controller.api.setSubAccountCreditLimit(
        '${account['id']}',
        result,
      );
      if (mounted) showSnack(context, 'تم تحديث الحد الائتماني بنجاح.');
      await _load();
    } on ApiFailure catch (error) {
      if (mounted) showSnack(context, error.message, error: true);
    }
  }

  Future<void> _settle(Map<String, dynamic> account) async {
    final result = await showDialog<SettlementInput>(
      context: context,
      builder: (context) => const SettlementDialog(),
    );
    if (result == null) return;
    try {
      await widget.controller.api.settleSubAccount(
        id: '${account['id']}',
        type: result.type,
        amount: result.amount,
        notes: result.notes,
      );
      if (mounted) {
        showSnack(context, 'تم تسجيل التسوية والحركة المالية بنجاح.');
      }
      await _load();
    } on ApiFailure catch (error) {
      if (mounted) showSnack(context, error.message, error: true);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_loading && _accounts.isEmpty) return const PageLoading();
    if (_error != null && _accounts.isEmpty) {
      return ErrorPage(error: _error!, onRetry: _load);
    }
    return PageFrame(
      title: 'عملاء الوكالة',
      subtitle: 'إدارة عملاء الوكالة والحدود الائتمانية وتسويات الرصيد.',
      onRefresh: _load,
      action: FilledButton.icon(
        onPressed: _create,
        icon: const Icon(Icons.person_add_alt_1_outlined),
        label: const Text('إضافة عميل'),
      ),
      child: [
        if (_accounts.isEmpty)
          const EmptyPanel(
            icon: Icons.groups_2_outlined,
            title: 'لا توجد حسابات تابعة',
            message: 'أضف أول عميل تابع للوكالة من زر إضافة عميل.',
          )
        else
          ..._accounts.map(
            (account) => Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: SubAccountTile(
                account: account,
                onSetLimit: () => _setLimit(account),
                onSettlement: () => _settle(account),
              ),
            ),
          ),
      ],
    );
  }
}

class ExecutorTasksScreen extends StatefulWidget {
  const ExecutorTasksScreen({super.key, required this.controller});

  final SessionController controller;

  @override
  State<ExecutorTasksScreen> createState() => _ExecutorTasksScreenState();
}

class _ExecutorTasksScreenState extends State<ExecutorTasksScreen> {
  Timer? _timer;
  List<Map<String, dynamic>> _tasks = <Map<String, dynamic>>[];
  final Set<String> _seenTaskIds = <String>{};
  bool _receivedInitialSnapshot = false;
  bool _loading = true;
  Object? _error;
  bool _actionBusy = false;

  @override
  void initState() {
    super.initState();
    _load();
    _timer = Timer.periodic(
      const Duration(seconds: 5),
      (_) => _load(silent: true),
    );
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  Future<void> _load({bool silent = false}) async {
    if (!silent && mounted) {
      setState(() {
        _loading = true;
        _error = null;
      });
    }
    try {
      final response = await widget.controller.api.executorLiveTasks();
      final raw = response['data'];
      final tasks = raw is List
          ? raw
                .whereType<Map>()
                .map((item) => Map<String, dynamic>.from(item))
                .toList()
          : <Map<String, dynamic>>[];
      final taskIds = tasks
          .map((task) => '${task['id'] ?? ''}')
          .where((id) => id.isNotEmpty)
          .toSet();
      final newTaskCount = _receivedInitialSnapshot
          ? taskIds.where((id) => !_seenTaskIds.contains(id)).length
          : 0;
      _seenTaskIds.addAll(taskIds);
      _receivedInitialSnapshot = true;
      if (newTaskCount > 0) {
        unawaited(SystemSound.play(SystemSoundType.alert));
        unawaited(HapticFeedback.mediumImpact());
        if (mounted) {
          showSnack(context, 'وصلت مهمة تنفيذ جديدة إلى قائمتك.');
        }
      }
      if (mounted) setState(() => _tasks = tasks);
    } catch (error) {
      if (!silent) _error = error;
    } finally {
      if (!silent && mounted) setState(() => _loading = false);
    }
  }

  Future<void> _accept(Map<String, dynamic> task) async {
    setState(() => _actionBusy = true);
    try {
      await widget.controller.api.acceptTask('${task['id']}');
      if (mounted) {
        showSnack(context, 'تم قبول العملية وأصبحت في قائمة تنفيذك.');
      }
      await _load();
    } on ApiFailure catch (error) {
      if (mounted) showSnack(context, error.message, error: true);
    } finally {
      if (mounted) setState(() => _actionBusy = false);
    }
  }

  Future<void> _cancel(Map<String, dynamic> task) async {
    final reason = await showDialog<String>(
      context: context,
      builder: (context) => const CancelTaskDialog(),
    );
    if (reason == null) return;
    setState(() => _actionBusy = true);
    try {
      await widget.controller.api.cancelTask('${task['id']}', reason);
      if (mounted) showSnack(context, 'تم إلغاء العملية وإرجاع الرصيد.');
      await _load();
    } on ApiFailure catch (error) {
      if (mounted) showSnack(context, error.message, error: true);
    } finally {
      if (mounted) setState(() => _actionBusy = false);
    }
  }

  Future<void> _complete(Map<String, dynamic> task) async {
    final success = await showDialog<bool>(
      context: context,
      builder: (context) =>
          CompleteTaskDialog(api: widget.controller.api, task: task),
    );
    if (success == true) await _load();
  }

  @override
  Widget build(BuildContext context) {
    if (_loading && _tasks.isEmpty) return const PageLoading();
    if (_error != null && _tasks.isEmpty) {
      return ErrorPage(error: _error!, onRetry: _load);
    }
    return PageFrame(
      title: 'مهام التنفيذ',
      subtitle: 'يتم تحديث المهام الجديدة تلقائياً كل خمس ثوانٍ.',
      onRefresh: _load,
      action: IconButton.filledTonal(
        tooltip: 'تحديث الآن',
        onPressed: _actionBusy ? null : _load,
        icon: const Icon(Icons.refresh),
      ),
      child: [
        Container(
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(
            color: const Color(0xFFEFF9F4),
            borderRadius: BorderRadius.circular(10),
            border: Border.all(color: const Color(0xFFCBEBDC)),
          ),
          child: const Row(
            children: [
              Icon(Icons.sensors, color: _green),
              SizedBox(width: 10),
              Text(
                'المراقبة المباشرة نشطة',
                style: TextStyle(fontWeight: FontWeight.w800),
              ),
            ],
          ),
        ),
        const SizedBox(height: 16),
        if (_tasks.isEmpty)
          const EmptyPanel(
            icon: Icons.assignment_turned_in_outlined,
            title: 'لا توجد مهام تنفيذ حالياً',
            message: 'ستظهر العمليات المحولة إلى مجموعتك تلقائياً هنا.',
          )
        else
          ..._tasks.map(
            (task) => Padding(
              padding: const EdgeInsets.only(bottom: 12),
              child: ExecutorTaskTile(
                task: task,
                busy: _actionBusy,
                onAccept: () => _accept(task),
                onCancel: () => _cancel(task),
                onComplete: () => _complete(task),
              ),
            ),
          ),
      ],
    );
  }
}

class ExecutorReportsScreen extends StatefulWidget {
  const ExecutorReportsScreen({
    super.key,
    required this.controller,
    this.employeeId,
    this.employeeName,
  });

  final SessionController controller;
  final String? employeeId;
  final String? employeeName;

  @override
  State<ExecutorReportsScreen> createState() => _ExecutorReportsScreenState();
}

class _ExecutorReportsScreenState extends State<ExecutorReportsScreen> {
  Map<String, dynamic>? _report;
  Object? _error;
  bool _loading = true;
  bool _month = false;
  DateTime _selectedDate = DateTime.now();

  bool get _todayOnly => widget.controller.isExecutorOperator;

  String get _dateValue => _month
      ? DateFormat('yyyy-MM').format(_selectedDate)
      : DateFormat('yyyy-MM-dd').format(_selectedDate);

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    if (mounted) {
      setState(() {
        _loading = true;
        _error = null;
      });
    }
    try {
      final response = await widget.controller.api.executorReports(
        dateType: _todayOnly ? 'day' : (_month ? 'month' : 'day'),
        dateValue: _todayOnly
            ? DateFormat('yyyy-MM-dd').format(DateTime.now())
            : _dateValue,
        employeeId: widget.employeeId,
      );
      final data = response['data'];
      if (mounted && data is Map) {
        setState(() => _report = Map<String, dynamic>.from(data));
      }
    } catch (error) {
      if (mounted) setState(() => _error = error);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _pickPeriod() async {
    final result = await showDatePicker(
      context: context,
      initialDate: _selectedDate,
      firstDate: DateTime(2024),
      lastDate: DateTime.now(),
      helpText: _month ? 'اختر أي يوم من الشهر' : 'اختر اليوم',
    );
    if (result != null && mounted) {
      setState(() => _selectedDate = result);
      await _load();
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_loading && _report == null) return const PageLoading();
    if (_error != null && _report == null) {
      return ErrorPage(error: _error!, onRetry: _load);
    }

    final report = _report ?? <String, dynamic>{};
    final operations = report['operations'] is List
        ? (report['operations'] as List)
              .whereType<Map>()
              .map((item) => Map<String, dynamic>.from(item))
              .toList()
        : <Map<String, dynamic>>[];
    final period = report['reportPeriod'];
    final periodValue = period is Map
        ? '${period['value'] ?? _dateValue}'
        : _dateValue;
    final title = widget.employeeName == null
        ? 'تقارير التنفيذ'
        : 'تقرير ${widget.employeeName}';
    final subtitle = _todayOnly
        ? 'عرض عمليات الشركة لليوم الحالي مع ملخص تنفيذاتك الشخصية.'
        : 'مطابقة الحركات اليومية والشهرية مع حساب شركة التنفيذ.';

    return PageFrame(
      title: title,
      subtitle: subtitle,
      onRefresh: _load,
      action: IconButton.filledTonal(
        tooltip: 'تحديث التقرير',
        onPressed: _loading ? null : _load,
        icon: const Icon(Icons.refresh),
      ),
      child: [
        if (!_todayOnly) ...[
          SurfacePanel(
            child: Wrap(
              spacing: 12,
              runSpacing: 12,
              crossAxisAlignment: WrapCrossAlignment.center,
              children: [
                SegmentedButton<bool>(
                  segments: const [
                    ButtonSegment<bool>(
                      value: false,
                      label: Text('يومي'),
                      icon: Icon(Icons.today_outlined),
                    ),
                    ButtonSegment<bool>(
                      value: true,
                      label: Text('شهري'),
                      icon: Icon(Icons.calendar_month_outlined),
                    ),
                  ],
                  selected: <bool>{_month},
                  onSelectionChanged: (value) {
                    setState(() => _month = value.first);
                    _load();
                  },
                ),
                OutlinedButton.icon(
                  onPressed: _pickPeriod,
                  icon: const Icon(Icons.date_range_outlined),
                  label: Text(periodValue),
                ),
              ],
            ),
          ),
          const SizedBox(height: 16),
        ],
        ExecutorReportSummary(report: report, operatorView: _todayOnly),
        const SizedBox(height: 20),
        SectionTitle(
          title: 'العمليات المسجلة',
          icon: Icons.receipt_long_outlined,
        ),
        const SizedBox(height: 10),
        if (operations.isEmpty)
          const EmptyPanel(
            icon: Icons.receipt_long_outlined,
            title: 'لا توجد عمليات في هذه الفترة',
            message: 'ستظهر حركات التنفيذ فور تسجيلها على حساب الشركة.',
          )
        else
          ...operations.map(
            (operation) => Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: ExecutorReportOperationTile(operation: operation),
            ),
          ),
      ],
    );
  }
}

class ExecutorReportSummary extends StatelessWidget {
  const ExecutorReportSummary({
    super.key,
    required this.report,
    required this.operatorView,
  });

  final Map<String, dynamic> report;
  final bool operatorView;

  @override
  Widget build(BuildContext context) {
    final performance = report['myPerformance'];
    final companyBalance = report['companyBalance'];
    final tiles = <Widget>[
      if (companyBalance != null)
        ExecutorMetricCard(
          label: 'رصيد الشركة',
          value: '${formatAmount(numberValue(companyBalance))} د.ل',
          icon: Icons.account_balance_wallet_outlined,
          color: _green,
        ),
      ExecutorMetricCard(
        label: 'إجمالي ليبيا',
        value: '${formatAmount(numberValue(report['totalLYD']))} د.ل',
        icon: Icons.payments_outlined,
        color: const Color(0xFF1976D2),
      ),
      ExecutorMetricCard(
        label: 'إجمالي مصر',
        value: '${formatAmount(numberValue(report['totalEGP']))} ج.م',
        icon: Icons.currency_exchange_outlined,
        color: _gold,
      ),
      ExecutorMetricCard(
        label: 'عمليات ناجحة',
        value: '${numberValue(report['completedCount']).toInt()}',
        icon: Icons.task_alt_outlined,
        color: _green,
      ),
      ExecutorMetricCard(
        label: 'عمليات ملغاة',
        value: '${numberValue(report['rejectedCount']).toInt()}',
        icon: Icons.cancel_outlined,
        color: _danger,
      ),
      if (operatorView && performance is Map)
        ExecutorMetricCard(
          label: 'تنفيذاتك اليوم',
          value: '${formatAmount(numberValue(performance['totalLYD']))} د.ل',
          icon: Icons.person_outline,
          color: const Color(0xFF7A57D1),
        ),
    ];

    return Wrap(spacing: 12, runSpacing: 12, children: tiles);
  }
}

class ExecutorMetricCard extends StatelessWidget {
  const ExecutorMetricCard({
    super.key,
    required this.label,
    required this.value,
    required this.icon,
    required this.color,
  });

  final String label;
  final String value;
  final IconData icon;
  final Color color;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return SizedBox(
      width: 205,
      child: Container(
        padding: const EdgeInsets.all(15),
        decoration: BoxDecoration(
          color: colors.surface,
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: color.withValues(alpha: 0.28)),
        ),
        child: Row(
          children: [
            Container(
              width: 42,
              height: 42,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: color.withValues(alpha: 0.12),
                shape: BoxShape.circle,
              ),
              child: Icon(icon, color: color),
            ),
            const SizedBox(width: 11),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    label,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 12,
                      color: colors.onSurfaceVariant,
                    ),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    value,
                    overflow: TextOverflow.ellipsis,
                    textDirection: ui.TextDirection.ltr,
                    style: TextStyle(
                      fontWeight: FontWeight.w900,
                      color: colors.onSurface,
                    ),
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

class ExecutorReportOperationTile extends StatelessWidget {
  const ExecutorReportOperationTile({super.key, required this.operation});

  final Map<String, dynamic> operation;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final executorName = '${operation['executorName'] ?? ''}'.trim();
    return SurfacePanel(
      child: Column(
        children: [
          Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      '${operation['customId'] ?? '-'}',
                      style: TextStyle(
                        fontWeight: FontWeight.w900,
                        color: colors.onSurface,
                      ),
                    ),
                    const SizedBox(height: 3),
                    Text(
                      '${operation['transferTypeLabel'] ?? serviceLabel(operation['transferType']?.toString())}',
                      style: TextStyle(color: colors.onSurfaceVariant),
                    ),
                  ],
                ),
              ),
              StatusPill(
                label: statusLabel(operation['status']?.toString()),
                color: statusColor(operation['status']?.toString()),
              ),
            ],
          ),
          const Divider(height: 24),
          Wrap(
            spacing: 18,
            runSpacing: 10,
            children: [
              _Metric(
                label: 'المستلم',
                value: '${operation['recipientNumber'] ?? '-'}',
                color: colors.onSurface,
              ),
              _Metric(
                label: 'القيمة',
                value: '${formatAmount(numberValue(operation['amount']))} ج.م',
                color: _green,
              ),
              _Metric(
                label: 'التكلفة',
                value: '${formatAmount(numberValue(operation['costLYD']))} د.ل',
                color: const Color(0xFF1976D2),
              ),
              _Metric(
                label: 'وقت العملية',
                value: formatDate(operation['createdAt']),
                color: colors.onSurface,
              ),
              if (executorName.isNotEmpty)
                _Metric(
                  label: 'المنفذ',
                  value: executorName,
                  color: const Color(0xFF7A57D1),
                ),
            ],
          ),
        ],
      ),
    );
  }
}

class ExecutorSettingsScreen extends StatefulWidget {
  const ExecutorSettingsScreen({super.key, required this.controller});

  final SessionController controller;

  @override
  State<ExecutorSettingsScreen> createState() => _ExecutorSettingsScreenState();
}

class _ExecutorSettingsScreenState extends State<ExecutorSettingsScreen> {
  Map<String, dynamic>? _overview;
  Object? _error;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    if (mounted) {
      setState(() {
        _loading = true;
        _error = null;
      });
    }
    try {
      final response = await widget.controller.api.executorOverview();
      final raw = response['data'];
      if (mounted && raw is Map) {
        setState(() => _overview = Map<String, dynamic>.from(raw));
      }
    } catch (error) {
      if (mounted) setState(() => _error = error);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  String _roleLabel(String role) {
    switch (role) {
      case 'manager':
        return 'مدير تنفيذي';
      case 'accountant':
        return 'محاسب';
      default:
        return 'موظف تنفيذ';
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_loading && _overview == null) return const PageLoading();
    if (_error != null && _overview == null) {
      return ErrorPage(error: _error!, onRetry: _load);
    }
    final overview = _overview ?? <String, dynamic>{};
    final company = overview['company'] is Map
        ? Map<String, dynamic>.from(overview['company'] as Map)
        : <String, dynamic>{};
    final executor = overview['executor'] is Map
        ? Map<String, dynamic>.from(overview['executor'] as Map)
        : <String, dynamic>{};
    final metrics = overview['metrics'];
    final performance = overview['myPerformance'];
    final role = '${executor['role'] ?? widget.controller.executorRole}';

    return PageFrame(
      title: 'إعدادات المنفذ',
      subtitle: 'بيانات الحساب التشغيلي الحالية.',
      onRefresh: _load,
      action: IconButton.filledTonal(
        tooltip: 'تحديث',
        onPressed: _loading ? null : _load,
        icon: const Icon(Icons.refresh),
      ),
      child: [
        SurfacePanel(
          child: Column(
            children: [
              Row(
                children: [
                  const BrandMark(compact: true),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Text(
                      '${company['name'] ?? widget.controller.session?.context['executorGroupName'] ?? 'شركة التنفيذ'}',
                      style: Theme.of(context).textTheme.titleMedium?.copyWith(
                        fontWeight: FontWeight.w900,
                      ),
                    ),
                  ),
                  StatusPill(label: _roleLabel(role), color: _green),
                ],
              ),
              const Divider(height: 28),
              DetailLine(
                label: 'اسم المنفذ',
                value:
                    '${executor['name'] ?? widget.controller.session?.name ?? '-'}',
              ),
              DetailLine(
                label: 'رقم الهاتف',
                value: '${executor['phone'] ?? '-'}',
              ),
              DetailLine(label: 'نوع المنفذ', value: _roleLabel(role)),
              DetailLine(
                label: 'الخدمة',
                value: serviceLabel(company['serviceKey']?.toString()),
              ),
              if (company['balance'] != null)
                DetailLine(
                  label: 'رصيد الشركة',
                  value: '${formatAmount(numberValue(company['balance']))} د.ل',
                ),
            ],
          ),
        ),
        if (metrics is Map) ...[
          const SizedBox(height: 18),
          Wrap(
            spacing: 12,
            runSpacing: 12,
            children: [
              ExecutorMetricCard(
                label: 'عمليات اليوم',
                value: '${numberValue(metrics['todayOperations']).toInt()}',
                icon: Icons.today_outlined,
                color: _green,
              ),
              ExecutorMetricCard(
                label: 'عمليات الشهر',
                value: '${numberValue(metrics['monthOperations']).toInt()}',
                icon: Icons.calendar_month_outlined,
                color: const Color(0xFF1976D2),
              ),
            ],
          ),
        ],
        if (widget.controller.isExecutorOperator && performance is Map) ...[
          const SizedBox(height: 18),
          ExecutorMetricCard(
            label: 'قيمة تنفيذاتك اليوم',
            value: '${formatAmount(numberValue(performance['totalLYD']))} د.ل',
            icon: Icons.person_outline,
            color: const Color(0xFF7A57D1),
          ),
        ],
      ],
    );
  }
}

class ExecutorEmployeesScreen extends StatefulWidget {
  const ExecutorEmployeesScreen({super.key, required this.controller});

  final SessionController controller;

  @override
  State<ExecutorEmployeesScreen> createState() =>
      _ExecutorEmployeesScreenState();
}

class _ExecutorEmployeesScreenState extends State<ExecutorEmployeesScreen> {
  List<Map<String, dynamic>> _employees = <Map<String, dynamic>>[];
  Object? _error;
  bool _loading = true;
  String? _busyId;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    if (mounted) {
      setState(() {
        _loading = true;
        _error = null;
      });
    }
    try {
      final employees = await widget.controller.api.executorEmployees();
      if (mounted) setState(() => _employees = employees);
    } catch (error) {
      if (mounted) setState(() => _error = error);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _editEmployee([Map<String, dynamic>? employee]) async {
    final values = await showDialog<_EmployeeFormData>(
      context: context,
      builder: (context) => ExecutorEmployeeEditorDialog(employee: employee),
    );
    if (values == null) return;

    final id = employee?['id']?.toString();
    setState(() => _busyId = id ?? 'create');
    try {
      if (employee == null) {
        await widget.controller.api.createExecutorEmployee(
          name: values.name,
          phone: values.phone,
          role: values.role,
          username: values.username,
          password: values.password,
        );
        if (mounted) showSnack(context, 'تم إنشاء حساب الموظف بنجاح.');
      } else {
        await widget.controller.api.updateExecutorEmployee(
          id: id!,
          name: values.name,
          phone: values.phone,
        );
        if (mounted) showSnack(context, 'تم تعديل بيانات الموظف.');
      }
      await _load();
    } on ApiFailure catch (error) {
      if (mounted) showSnack(context, error.message, error: true);
    } finally {
      if (mounted) setState(() => _busyId = null);
    }
  }

  Future<void> _resetPassword(Map<String, dynamic> employee) async {
    final password = await showDialog<String>(
      context: context,
      builder: (context) => const ExecutorResetPasswordDialog(),
    );
    if (password == null) return;
    final id = '${employee['id']}';
    setState(() => _busyId = id);
    try {
      await widget.controller.api.resetExecutorEmployeePassword(
        id: id,
        password: password,
      );
      if (mounted) showSnack(context, 'تم تغيير كلمة مرور الموظف.');
    } on ApiFailure catch (error) {
      if (mounted) showSnack(context, error.message, error: true);
    } finally {
      if (mounted) setState(() => _busyId = null);
    }
  }

  Future<void> _toggleStatus(Map<String, dynamic> employee) async {
    final id = '${employee['id']}';
    setState(() => _busyId = id);
    try {
      await widget.controller.api.toggleExecutorEmployeeStatus(id);
      await _load();
    } on ApiFailure catch (error) {
      if (mounted) showSnack(context, error.message, error: true);
    } finally {
      if (mounted) setState(() => _busyId = null);
    }
  }

  Future<void> _delete(Map<String, dynamic> employee) async {
    final approved = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('حذف الموظف'),
        content: Text(
          'سيتم إلغاء حساب ${employee['name'] ?? 'الموظف'} مع بقاء العمليات في السجل.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('إلغاء'),
          ),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: _danger),
            onPressed: () => Navigator.pop(context, true),
            child: const Text('حذف'),
          ),
        ],
      ),
    );
    if (approved != true) return;
    final id = '${employee['id']}';
    setState(() => _busyId = id);
    try {
      await widget.controller.api.deleteExecutorEmployee(id);
      if (mounted) showSnack(context, 'تم حذف حساب الموظف.');
      await _load();
    } on ApiFailure catch (error) {
      if (mounted) showSnack(context, error.message, error: true);
    } finally {
      if (mounted) setState(() => _busyId = null);
    }
  }

  void _openReport(Map<String, dynamic> employee) {
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => Scaffold(
          appBar: AppBar(title: Text('تقرير ${employee['name'] ?? 'الموظف'}')),
          body: ExecutorReportsScreen(
            controller: widget.controller,
            employeeId: '${employee['id']}',
            employeeName: '${employee['name'] ?? 'الموظف'}',
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    if (_loading && _employees.isEmpty) return const PageLoading();
    if (_error != null && _employees.isEmpty) {
      return ErrorPage(error: _error!, onRetry: _load);
    }
    return PageFrame(
      title: 'موظفو التنفيذ',
      subtitle: 'إدارة حسابات التشغيل والتقارير الفردية.',
      onRefresh: _load,
      action: FilledButton.icon(
        onPressed: _loading ? null : () => _editEmployee(),
        icon: const Icon(Icons.person_add_alt_1_outlined),
        label: const Text('موظف جديد'),
      ),
      child: [
        if (_employees.isEmpty)
          const EmptyPanel(
            icon: Icons.groups_outlined,
            title: 'لا توجد حسابات موظفين',
            message: 'أضف موظف تنفيذ أو محاسباً لشركة التنفيذ.',
          )
        else
          ..._employees.map(
            (employee) => Padding(
              padding: const EdgeInsets.only(bottom: 12),
              child: ExecutorEmployeeTile(
                employee: employee,
                busy: _busyId == '${employee['id']}',
                onEdit: () => _editEmployee(employee),
                onResetPassword: () => _resetPassword(employee),
                onToggleStatus: () => _toggleStatus(employee),
                onReport: () => _openReport(employee),
                onDelete: () => _delete(employee),
              ),
            ),
          ),
      ],
    );
  }
}

class ExecutorEmployeeTile extends StatelessWidget {
  const ExecutorEmployeeTile({
    super.key,
    required this.employee,
    required this.busy,
    required this.onEdit,
    required this.onResetPassword,
    required this.onToggleStatus,
    required this.onReport,
    required this.onDelete,
  });

  final Map<String, dynamic> employee;
  final bool busy;
  final VoidCallback onEdit;
  final VoidCallback onResetPassword;
  final VoidCallback onToggleStatus;
  final VoidCallback onReport;
  final VoidCallback onDelete;

  String get _role {
    switch ('${employee['role']}') {
      case 'manager':
        return 'مدير';
      case 'accountant':
        return 'محاسب';
      default:
        return 'موظف تنفيذ';
    }
  }

  @override
  Widget build(BuildContext context) {
    final isManager = employee['role'] == 'manager';
    final active = employee['status'] == 'active';
    final colors = Theme.of(context).colorScheme;
    return SurfacePanel(
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          CircleAvatar(
            backgroundColor: (active ? _green : _danger).withValues(
              alpha: 0.12,
            ),
            child: Icon(
              employee['role'] == 'accountant'
                  ? Icons.calculate_outlined
                  : Icons.person_outline,
              color: active ? _green : _danger,
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Expanded(
                      child: Text(
                        '${employee['name'] ?? '-'}',
                        style: TextStyle(
                          fontWeight: FontWeight.w900,
                          color: colors.onSurface,
                        ),
                      ),
                    ),
                    StatusPill(
                      label: active ? 'نشط' : 'موقوف',
                      color: active ? _green : _danger,
                    ),
                  ],
                ),
                const SizedBox(height: 5),
                Text(
                  '$_role · ${employee['phone'] ?? '-'}',
                  style: TextStyle(color: colors.onSurfaceVariant),
                ),
                const SizedBox(height: 3),
                Text(
                  '${employee['webUsername'] ?? '-'}',
                  textDirection: ui.TextDirection.ltr,
                  style: TextStyle(
                    color: colors.onSurfaceVariant,
                    fontSize: 12,
                  ),
                ),
                if (!isManager) ...[
                  const SizedBox(height: 12),
                  Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    children: [
                      OutlinedButton.icon(
                        onPressed: busy ? null : onEdit,
                        icon: const Icon(Icons.edit_outlined, size: 18),
                        label: const Text('تعديل'),
                      ),
                      OutlinedButton.icon(
                        onPressed: busy ? null : onResetPassword,
                        icon: const Icon(Icons.key_outlined, size: 18),
                        label: const Text('كلمة المرور'),
                      ),
                      OutlinedButton.icon(
                        onPressed: busy ? null : onReport,
                        icon: const Icon(Icons.assessment_outlined, size: 18),
                        label: const Text('التقرير'),
                      ),
                    ],
                  ),
                ],
              ],
            ),
          ),
          if (!isManager)
            PopupMenuButton<String>(
              enabled: !busy,
              tooltip: 'إجراءات الموظف',
              onSelected: (value) {
                if (value == 'status') onToggleStatus();
                if (value == 'delete') onDelete();
              },
              itemBuilder: (context) => [
                PopupMenuItem<String>(
                  value: 'status',
                  child: Text(active ? 'إيقاف الحساب' : 'تفعيل الحساب'),
                ),
                const PopupMenuItem<String>(
                  value: 'delete',
                  child: Text('حذف الحساب'),
                ),
              ],
            ),
        ],
      ),
    );
  }
}

class _EmployeeFormData {
  const _EmployeeFormData({
    required this.name,
    required this.phone,
    required this.role,
    required this.username,
    required this.password,
  });

  final String name;
  final String phone;
  final String role;
  final String username;
  final String password;
}

class ExecutorEmployeeEditorDialog extends StatefulWidget {
  const ExecutorEmployeeEditorDialog({super.key, this.employee});

  final Map<String, dynamic>? employee;

  @override
  State<ExecutorEmployeeEditorDialog> createState() =>
      _ExecutorEmployeeEditorDialogState();
}

class _ExecutorEmployeeEditorDialogState
    extends State<ExecutorEmployeeEditorDialog> {
  final _formKey = GlobalKey<FormState>();
  late final TextEditingController _name;
  late final TextEditingController _phone;
  late final TextEditingController _username;
  late final TextEditingController _password;
  late String _role;

  bool get _editing => widget.employee != null;

  @override
  void initState() {
    super.initState();
    _name = TextEditingController(text: '${widget.employee?['name'] ?? ''}');
    _phone = TextEditingController(text: '${widget.employee?['phone'] ?? ''}');
    _username = TextEditingController(
      text: '${widget.employee?['webUsername'] ?? ''}'.replaceAll(
        '@ahram.com',
        '',
      ),
    );
    _password = TextEditingController();
    _role = '${widget.employee?['role'] ?? 'operator'}';
  }

  @override
  void dispose() {
    _name.dispose();
    _phone.dispose();
    _username.dispose();
    _password.dispose();
    super.dispose();
  }

  void _save() {
    if (!_formKey.currentState!.validate()) return;
    Navigator.pop(
      context,
      _EmployeeFormData(
        name: _name.text.trim(),
        phone: _phone.text.trim(),
        role: _role,
        username: _username.text.trim(),
        password: _password.text,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text(_editing ? 'تعديل بيانات الموظف' : 'موظف تنفيذ جديد'),
      content: SizedBox(
        width: 420,
        child: Form(
          key: _formKey,
          child: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                TextFormField(
                  controller: _name,
                  decoration: const InputDecoration(labelText: 'الاسم'),
                  validator: (value) => (value ?? '').trim().length < 3
                      ? 'أدخل الاسم كاملاً.'
                      : null,
                ),
                const SizedBox(height: 12),
                TextFormField(
                  controller: _phone,
                  keyboardType: TextInputType.phone,
                  decoration: const InputDecoration(labelText: 'رقم الهاتف'),
                ),
                if (!_editing) ...[
                  const SizedBox(height: 12),
                  DropdownButtonFormField<String>(
                    initialValue: _role,
                    decoration: const InputDecoration(labelText: 'الصفة'),
                    items: const [
                      DropdownMenuItem(
                        value: 'operator',
                        child: Text('موظف تنفيذ'),
                      ),
                      DropdownMenuItem(
                        value: 'accountant',
                        child: Text('محاسب'),
                      ),
                    ],
                    onChanged: (value) =>
                        setState(() => _role = value ?? 'operator'),
                  ),
                  const SizedBox(height: 12),
                  TextFormField(
                    controller: _username,
                    textDirection: ui.TextDirection.ltr,
                    decoration: const InputDecoration(
                      labelText: 'اسم المستخدم',
                      helperText: '@ahram.com يضاف تلقائياً',
                    ),
                    validator: (value) =>
                        RegExp(
                          r'^[A-Za-z0-9_]{3,100}$',
                        ).hasMatch((value ?? '').trim())
                        ? null
                        : 'استخدم أحرفاً إنجليزية أو أرقاماً أو _.',
                  ),
                  const SizedBox(height: 12),
                  TextFormField(
                    controller: _password,
                    obscureText: true,
                    textDirection: ui.TextDirection.ltr,
                    decoration: const InputDecoration(labelText: 'كلمة المرور'),
                    validator: (value) {
                      final password = value ?? '';
                      if (password.length < 8) {
                        return 'كلمة المرور 8 أحرف على الأقل.';
                      }
                      if (!RegExp(
                        r'(?=.*[A-Za-z])(?=.*\d)',
                      ).hasMatch(password)) {
                        return 'يجب أن تحتوي على حرف ورقم.';
                      }
                      return null;
                    },
                  ),
                ],
              ],
            ),
          ),
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('إلغاء'),
        ),
        FilledButton(
          onPressed: _save,
          child: Text(_editing ? 'حفظ التعديل' : 'إنشاء الحساب'),
        ),
      ],
    );
  }
}

class ExecutorResetPasswordDialog extends StatefulWidget {
  const ExecutorResetPasswordDialog({super.key});

  @override
  State<ExecutorResetPasswordDialog> createState() =>
      _ExecutorResetPasswordDialogState();
}

class _ExecutorResetPasswordDialogState
    extends State<ExecutorResetPasswordDialog> {
  final _formKey = GlobalKey<FormState>();
  final _password = TextEditingController();

  @override
  void dispose() {
    _password.dispose();
    super.dispose();
  }

  void _save() {
    if (_formKey.currentState!.validate()) {
      Navigator.pop(context, _password.text);
    }
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('تغيير كلمة المرور'),
      content: Form(
        key: _formKey,
        child: TextFormField(
          controller: _password,
          obscureText: true,
          textDirection: ui.TextDirection.ltr,
          decoration: const InputDecoration(labelText: 'كلمة المرور الجديدة'),
          validator: (value) {
            final password = value ?? '';
            if (password.length < 8) {
              return 'كلمة المرور 8 أحرف على الأقل.';
            }
            if (!RegExp(r'(?=.*[A-Za-z])(?=.*\d)').hasMatch(password)) {
              return 'يجب أن تحتوي على حرف ورقم.';
            }
            return null;
          },
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('إلغاء'),
        ),
        FilledButton(onPressed: _save, child: const Text('تغيير')),
      ],
    );
  }
}

class AccountScreen extends StatelessWidget {
  const AccountScreen({super.key, required this.controller});

  final SessionController controller;

  @override
  Widget build(BuildContext context) {
    final session = controller.session!;
    final contextData = session.context;
    return PageFrame(
      title: 'بيانات الحساب',
      subtitle: 'بيانات الجلسة الحالية وإعدادات الربط الآمن.',
      child: [
        SurfacePanel(
          child: Column(
            children: [
              ListTile(
                contentPadding: EdgeInsets.zero,
                leading: const CircleAvatar(
                  backgroundColor: Color(0xFFDFF5EA),
                  child: Icon(Icons.person_outline, color: _green),
                ),
                title: Text(
                  session.name,
                  style: const TextStyle(fontWeight: FontWeight.w800),
                ),
                subtitle: Text(session.persona),
              ),
              const Divider(),
              DetailLine(label: 'نوع الحساب', value: session.accountType),
              DetailLine(label: 'المستوى', value: '${session.tier}'),
              if (contextData['accountCode'] != null &&
                  '${contextData['accountCode']}'.isNotEmpty)
                DetailLine(
                  label: 'رقم الحساب',
                  value: '${contextData['accountCode']}',
                ),
              if (contextData['agentName'] != null &&
                  '${contextData['agentName']}'.isNotEmpty)
                DetailLine(
                  label: 'الوكالة',
                  value: '${contextData['agentName']}',
                ),
              if (contextData['clientCompanyName'] != null &&
                  '${contextData['clientCompanyName']}'.isNotEmpty)
                DetailLine(
                  label: 'الشركة',
                  value: '${contextData['clientCompanyName']}',
                ),
            ],
          ),
        ),
        const SizedBox(height: 18),
        SurfacePanel(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const SectionTitle(
                title: 'الاتصال بالخدمة',
                icon: Icons.shield_outlined,
              ),
              const SizedBox(height: 12),
              SelectableText(
                controller.api.baseUrl,
                textDirection: ui.TextDirection.ltr,
                style: const TextStyle(color: Color(0xFF60708A)),
              ),
              const SizedBox(height: 8),
              const Text(
                'يتم حفظ رموز الجلسة في مساحة مشفرة داخل الجهاز.',
                style: TextStyle(color: Color(0xFF60708A)),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

class TicketDialog extends StatefulWidget {
  const TicketDialog({super.key, required this.api});

  final MobileApi api;

  @override
  State<TicketDialog> createState() => _TicketDialogState();
}

class _TicketDialogState extends State<TicketDialog> {
  final _formKey = GlobalKey<FormState>();
  final _subject = TextEditingController();
  final _message = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _subject.dispose();
    _message.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    if (!_formKey.currentState!.validate()) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await widget.api.createTicket(
        subject: _subject.text.trim(),
        message: _message.text.trim(),
      );
      if (mounted) Navigator.pop(context, true);
    } on ApiFailure catch (error) {
      if (mounted) setState(() => _error = error.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('تذكرة دعم جديدة'),
      content: Form(
        key: _formKey,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              TextFormField(
                controller: _subject,
                decoration: const InputDecoration(labelText: 'عنوان الطلب'),
                validator: (value) =>
                    (value ?? '').trim().isEmpty ? 'العنوان مطلوب.' : null,
              ),
              const SizedBox(height: 12),
              TextFormField(
                controller: _message,
                minLines: 4,
                maxLines: 6,
                decoration: const InputDecoration(labelText: 'الرسالة'),
                validator: (value) => (value ?? '').trim().length < 5
                    ? 'اكتب تفاصيل الطلب.'
                    : null,
              ),
              if (_error != null) ...[
                const SizedBox(height: 12),
                InlineMessage(message: _error!, color: _danger),
              ],
            ],
          ),
        ),
      ),
      actions: [
        TextButton(
          onPressed: _busy ? null : () => Navigator.pop(context),
          child: const Text('إلغاء'),
        ),
        FilledButton(
          onPressed: _busy ? null : _save,
          child: Text(_busy ? 'جارٍ الإرسال...' : 'إرسال'),
        ),
      ],
    );
  }
}

class SubAccountDialog extends StatefulWidget {
  const SubAccountDialog({super.key, required this.api});

  final MobileApi api;

  @override
  State<SubAccountDialog> createState() => _SubAccountDialogState();
}

class _SubAccountDialogState extends State<SubAccountDialog> {
  final _formKey = GlobalKey<FormState>();
  final _name = TextEditingController();
  final _phone = TextEditingController();
  final _username = TextEditingController();
  final _password = TextEditingController();
  final _limit = TextEditingController(text: '0');
  final _margin = TextEditingController(text: '0');
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _name.dispose();
    _phone.dispose();
    _username.dispose();
    _password.dispose();
    _limit.dispose();
    _margin.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    if (!_formKey.currentState!.validate()) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await widget.api.createSubAccount(<String, dynamic>{
        'name': _name.text.trim(),
        'phone': _phone.text.trim(),
        'username': _username.text.trim(),
        'password': _password.text,
        'creditLimit': numberValue(_limit.text),
        'customMargin': numberValue(_margin.text),
      });
      if (mounted) Navigator.pop(context, true);
    } on ApiFailure catch (error) {
      if (mounted) setState(() => _error = error.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('إضافة عميل للوكالة'),
      content: SizedBox(
        width: 440,
        child: Form(
          key: _formKey,
          child: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                TextFormField(
                  controller: _name,
                  decoration: const InputDecoration(labelText: 'اسم العميل'),
                  validator: _required,
                ),
                const SizedBox(height: 10),
                TextFormField(
                  controller: _phone,
                  keyboardType: TextInputType.phone,
                  decoration: const InputDecoration(labelText: 'رقم الهاتف'),
                  validator: _required,
                ),
                const SizedBox(height: 10),
                TextFormField(
                  controller: _username,
                  textDirection: ui.TextDirection.ltr,
                  decoration: const InputDecoration(labelText: 'اسم المستخدم'),
                  validator: _required,
                ),
                const SizedBox(height: 10),
                TextFormField(
                  controller: _password,
                  obscureText: true,
                  textDirection: ui.TextDirection.ltr,
                  decoration: const InputDecoration(labelText: 'كلمة المرور'),
                  validator: (value) => (value ?? '').length < 8
                      ? 'كلمة المرور 8 أحرف على الأقل.'
                      : null,
                ),
                const SizedBox(height: 10),
                TextFormField(
                  controller: _limit,
                  keyboardType: const TextInputType.numberWithOptions(
                    decimal: true,
                  ),
                  decoration: const InputDecoration(
                    labelText: 'الحد الائتماني د.ل',
                  ),
                ),
                const SizedBox(height: 10),
                TextFormField(
                  controller: _margin,
                  keyboardType: const TextInputType.numberWithOptions(
                    decimal: true,
                  ),
                  decoration: const InputDecoration(
                    labelText: 'هامش الربح للعميل',
                  ),
                ),
                if (_error != null) ...[
                  const SizedBox(height: 12),
                  InlineMessage(message: _error!, color: _danger),
                ],
              ],
            ),
          ),
        ),
      ),
      actions: [
        TextButton(
          onPressed: _busy ? null : () => Navigator.pop(context),
          child: const Text('إلغاء'),
        ),
        FilledButton(
          onPressed: _busy ? null : _save,
          child: Text(_busy ? 'جارٍ الحفظ...' : 'إنشاء الحساب'),
        ),
      ],
    );
  }

  String? _required(String? value) =>
      (value ?? '').trim().isEmpty ? 'هذا الحقل مطلوب.' : null;
}

class AmountDialog extends StatefulWidget {
  const AmountDialog({
    super.key,
    required this.title,
    required this.label,
    required this.initial,
    required this.actionLabel,
  });

  final String title;
  final String label;
  final double initial;
  final String actionLabel;

  @override
  State<AmountDialog> createState() => _AmountDialogState();
}

class _AmountDialogState extends State<AmountDialog> {
  late final TextEditingController _amount = TextEditingController(
    text: formatAmount(widget.initial),
  );

  @override
  void dispose() {
    _amount.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text(widget.title),
      content: TextField(
        controller: _amount,
        keyboardType: const TextInputType.numberWithOptions(decimal: true),
        decoration: InputDecoration(labelText: widget.label),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('إلغاء'),
        ),
        FilledButton(
          onPressed: () {
            final value = double.tryParse(
              _amount.text.replaceAll(',', '').trim(),
            );
            if (value == null || value < 0) {
              showSnack(context, 'أدخل قيمة صحيحة.', error: true);
              return;
            }
            Navigator.pop(context, value);
          },
          child: Text(widget.actionLabel),
        ),
      ],
    );
  }
}

class SettlementInput {
  const SettlementInput({
    required this.type,
    required this.amount,
    required this.notes,
  });

  final String type;
  final double amount;
  final String notes;
}

class SettlementDialog extends StatefulWidget {
  const SettlementDialog({super.key});

  @override
  State<SettlementDialog> createState() => _SettlementDialogState();
}

class _SettlementDialogState extends State<SettlementDialog> {
  final _formKey = GlobalKey<FormState>();
  final _amount = TextEditingController();
  final _notes = TextEditingController();
  String _type = 'deposit';

  @override
  void dispose() {
    _amount.dispose();
    _notes.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('تسوية العميل'),
      content: Form(
        key: _formKey,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            DropdownButtonFormField<String>(
              initialValue: _type,
              decoration: const InputDecoration(labelText: 'نوع الحركة'),
              items: const [
                DropdownMenuItem(value: 'deposit', child: Text('إيداع للعميل')),
                DropdownMenuItem(
                  value: 'withdraw',
                  child: Text('خصم من العميل'),
                ),
              ],
              onChanged: (value) => setState(() => _type = value ?? 'deposit'),
            ),
            const SizedBox(height: 12),
            TextFormField(
              controller: _amount,
              keyboardType: const TextInputType.numberWithOptions(
                decimal: true,
              ),
              decoration: const InputDecoration(
                labelText: 'القيمة بالدينار الليبي',
              ),
              validator: (value) =>
                  numberValue(value) <= 0 ? 'أدخل قيمة أكبر من صفر.' : null,
            ),
            const SizedBox(height: 12),
            TextFormField(
              controller: _notes,
              decoration: const InputDecoration(labelText: 'ملاحظة (اختيارية)'),
            ),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('إلغاء'),
        ),
        FilledButton(
          onPressed: () {
            if (!_formKey.currentState!.validate()) return;
            Navigator.pop(
              context,
              SettlementInput(
                type: _type,
                amount: numberValue(_amount.text),
                notes: _notes.text.trim(),
              ),
            );
          },
          child: const Text('تسجيل التسوية'),
        ),
      ],
    );
  }
}

class CancelTaskDialog extends StatefulWidget {
  const CancelTaskDialog({super.key});

  @override
  State<CancelTaskDialog> createState() => _CancelTaskDialogState();
}

class _CancelTaskDialogState extends State<CancelTaskDialog> {
  static const _reasons = [
    'لا يوجد محفظة',
    'محفظة ليميت',
    'الخدمة متوقفة حالياً',
    'الرقم غير صحيح',
    'سبب آخر',
  ];
  String _selected = _reasons.first;
  final _other = TextEditingController();

  @override
  void dispose() {
    _other.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('إلغاء العملية'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          DropdownButtonFormField<String>(
            initialValue: _selected,
            decoration: const InputDecoration(labelText: 'سبب الإلغاء'),
            items: _reasons
                .map(
                  (reason) =>
                      DropdownMenuItem(value: reason, child: Text(reason)),
                )
                .toList(),
            onChanged: (value) =>
                setState(() => _selected = value ?? _selected),
          ),
          if (_selected == 'سبب آخر') ...[
            const SizedBox(height: 12),
            TextField(
              controller: _other,
              minLines: 2,
              maxLines: 4,
              decoration: const InputDecoration(labelText: 'اكتب السبب'),
            ),
          ],
        ],
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('عودة'),
        ),
        FilledButton(
          style: FilledButton.styleFrom(backgroundColor: _danger),
          onPressed: () {
            final reason = _selected == 'سبب آخر'
                ? _other.text.trim()
                : _selected;
            if (reason.length < 3) {
              showSnack(context, 'اكتب سبب الإلغاء.', error: true);
              return;
            }
            Navigator.pop(context, reason);
          },
          child: const Text('تأكيد الإلغاء'),
        ),
      ],
    );
  }
}

class CompleteTaskDialog extends StatefulWidget {
  const CompleteTaskDialog({super.key, required this.api, required this.task});

  final MobileApi api;
  final Map<String, dynamic> task;

  @override
  State<CompleteTaskDialog> createState() => _CompleteTaskDialogState();
}

class _CompleteTaskDialogState extends State<CompleteTaskDialog> {
  final _execution = TextEditingController();
  final _picker = ImagePicker();
  Uint8List? _image;
  bool _busy = false;
  String? _error;

  bool get _proofRequired => widget.task['transferType'] == 'sefa_niger';

  @override
  void dispose() {
    _execution.dispose();
    super.dispose();
  }

  Future<void> _pick() async {
    final source = await showModalBottomSheet<ImageSource>(
      context: context,
      builder: (context) => SafeArea(
        child: Wrap(
          children: [
            ListTile(
              leading: const Icon(Icons.camera_alt_outlined),
              title: const Text('الكاميرا'),
              onTap: () => Navigator.pop(context, ImageSource.camera),
            ),
            ListTile(
              leading: const Icon(Icons.photo_library_outlined),
              title: const Text('المعرض'),
              onTap: () => Navigator.pop(context, ImageSource.gallery),
            ),
          ],
        ),
      ),
    );
    if (source == null) return;
    final file = await _picker.pickImage(
      source: source,
      imageQuality: 72,
      maxWidth: 1600,
    );
    if (file == null) return;
    final image = await file.readAsBytes();
    if (mounted) setState(() => _image = image);
  }

  Future<void> _complete() async {
    if (_execution.text.trim().length < 3) {
      setState(() => _error = 'أدخل رقم التنفيذ الذي ظهر لك بعد التحويل.');
      return;
    }
    if (_proofRequired && _image == null) {
      setState(() => _error = 'صورة الإثبات إلزامية لخدمة سيفا النيجر.');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await widget.api.completeTask(
        id: '${widget.task['id']}',
        executionNumber: _execution.text.trim(),
        imageBase64: _image == null
            ? null
            : 'data:image/jpeg;base64,${base64Encode(_image!)}',
      );
      if (mounted) {
        showSnack(context, 'تم إنهاء العملية وتوليد الإيصال بنجاح.');
        Navigator.pop(context, true);
      }
    } on ApiFailure catch (error) {
      if (mounted) setState(() => _error = error.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('إتمام عملية التنفيذ'),
      content: SizedBox(
        width: 420,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              DetailLine(
                label: 'رقم العملية',
                value: '${widget.task['txId'] ?? '-'}',
              ),
              DetailLine(
                label: 'المستلم',
                value: '${widget.task['recipientNumber'] ?? '-'}',
              ),
              const SizedBox(height: 14),
              TextField(
                controller: _execution,
                textDirection: ui.TextDirection.ltr,
                decoration: const InputDecoration(
                  labelText: 'رقم التنفيذ',
                  prefixIcon: Icon(Icons.tag_outlined),
                ),
              ),
              const SizedBox(height: 12),
              ProofPicker(
                required: _proofRequired,
                image: _image,
                onPick: _pick,
                onClear: () => setState(() => _image = null),
                label: 'صورة إثبات التنفيذ',
              ),
              if (_error != null) ...[
                const SizedBox(height: 12),
                InlineMessage(message: _error!, color: _danger),
              ],
            ],
          ),
        ),
      ),
      actions: [
        TextButton(
          onPressed: _busy ? null : () => Navigator.pop(context),
          child: const Text('إلغاء'),
        ),
        FilledButton(
          onPressed: _busy ? null : _complete,
          child: Text(_busy ? 'جارٍ الحفظ...' : 'تأكيد النجاح'),
        ),
      ],
    );
  }
}

class PageFrame extends StatelessWidget {
  const PageFrame({
    super.key,
    required this.title,
    required this.child,
    this.subtitle,
    this.action,
    this.onRefresh,
  });

  final String title;
  final String? subtitle;
  final List<Widget> child;
  final Widget? action;
  final Future<void> Function()? onRefresh;

  @override
  Widget build(BuildContext context) {
    final content = ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(18, 20, 18, 32),
      children: [
        Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 1120),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            title,
                            style: Theme.of(context).textTheme.headlineSmall
                                ?.copyWith(
                                  fontWeight: FontWeight.w800,
                                  color: Theme.of(
                                    context,
                                  ).colorScheme.onSurface,
                                ),
                          ),
                          if (subtitle != null) ...[
                            const SizedBox(height: 5),
                            Text(
                              subtitle!,
                              style: TextStyle(
                                color: Theme.of(
                                  context,
                                ).colorScheme.onSurfaceVariant,
                              ),
                            ),
                          ],
                        ],
                      ),
                    ),
                    ?action,
                  ],
                ),
                const SizedBox(height: 22),
                ...child,
              ],
            ),
          ),
        ),
      ],
    );
    if (onRefresh == null) return content;
    return RefreshIndicator(
      onRefresh: onRefresh!,
      color: _green,
      child: content,
    );
  }
}

class BrandMark extends StatelessWidget {
  const BrandMark({super.key, this.large = false, this.compact = false});

  final bool large;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    final size = large ? 58.0 : 34.0;
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          width: size,
          height: size,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: _navy,
            borderRadius: BorderRadius.circular(large ? 16 : 10),
            border: Border.all(color: _gold, width: 1.4),
          ),
          child: Text(
            'PP',
            style: TextStyle(
              color: Colors.white,
              fontWeight: FontWeight.w900,
              fontSize: large ? 20 : 12,
            ),
          ),
        ),
        if (!compact) ...[
          const SizedBox(width: 10),
          Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                'Power Pay',
                style: TextStyle(
                  fontWeight: FontWeight.w900,
                  color: _navy,
                  fontSize: large ? 20 : 15,
                ),
              ),
              Text(
                'AL-Ahram',
                style: TextStyle(
                  color: _green,
                  fontSize: large ? 13 : 10,
                  fontWeight: FontWeight.w700,
                ),
              ),
            ],
          ),
        ],
      ],
    );
  }
}

class AccountHero extends StatelessWidget {
  const AccountHero({
    super.key,
    required this.name,
    required this.role,
    required this.balance,
    required this.showBalance,
    required this.systemOpen,
  });

  final String name;
  final String role;
  final double balance;
  final bool showBalance;
  final bool systemOpen;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(22),
      decoration: BoxDecoration(
        color: _navy,
        borderRadius: BorderRadius.circular(12),
        boxShadow: const [
          BoxShadow(
            color: Color(0x25081731),
            blurRadius: 20,
            offset: Offset(0, 8),
          ),
        ],
      ),
      child: Wrap(
        alignment: WrapAlignment.spaceBetween,
        runSpacing: 18,
        children: [
          Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                role,
                style: const TextStyle(
                  color: Color(0xFFBBD0E9),
                  fontWeight: FontWeight.w700,
                ),
              ),
              const SizedBox(height: 6),
              Text(
                name,
                style: Theme.of(context).textTheme.titleLarge?.copyWith(
                  color: Colors.white,
                  fontWeight: FontWeight.w800,
                ),
              ),
            ],
          ),
          Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Text(
                showBalance ? 'الرصيد المتاح' : 'صلاحيات موظف',
                style: const TextStyle(color: Color(0xFFBBD0E9)),
              ),
              const SizedBox(height: 6),
              Text(
                showBalance ? '${formatAmount(balance)} د.ل' : 'غير معروض',
                textDirection: ui.TextDirection.ltr,
                style: Theme.of(context).textTheme.headlineSmall?.copyWith(
                  color: Colors.white,
                  fontWeight: FontWeight.w900,
                ),
              ),
              const SizedBox(height: 10),
              StatusPill(
                label: systemOpen ? 'الخدمة متاحة' : 'الخدمة متوقفة',
                color: systemOpen ? _green : _danger,
                dark: true,
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class ResponsivePanel extends StatelessWidget {
  const ResponsivePanel({super.key, required this.children});

  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    return SurfacePanel(
      child: LayoutBuilder(
        builder: (context, constraints) {
          final twoColumns = constraints.maxWidth >= 640;
          if (!twoColumns) {
            return Column(
              children:
                  children
                      .expand((item) => [item, const SizedBox(height: 14)])
                      .toList()
                    ..removeLast(),
            );
          }
          final rows = <Widget>[];
          for (var index = 0; index < children.length; index += 2) {
            rows.add(
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(child: children[index]),
                  const SizedBox(width: 14),
                  Expanded(
                    child: index + 1 < children.length
                        ? children[index + 1]
                        : const SizedBox(),
                  ),
                ],
              ),
            );
            if (index + 2 < children.length) {
              rows.add(const SizedBox(height: 14));
            }
          }
          return Column(children: rows);
        },
      ),
    );
  }
}

class SurfacePanel extends StatelessWidget {
  const SurfacePanel({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.all(18),
      decoration: BoxDecoration(
        color: colors.surface,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: colors.outlineVariant),
      ),
      child: child,
    );
  }
}

class StatTile extends StatelessWidget {
  const StatTile({
    super.key,
    required this.label,
    required this.value,
    required this.suffix,
    required this.icon,
    required this.color,
  });

  final String label;
  final String value;
  final String suffix;
  final IconData icon;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: 210,
      child: SurfacePanel(
        child: Row(
          children: [
            Container(
              width: 42,
              height: 42,
              decoration: BoxDecoration(
                color: color.withValues(alpha: 0.12),
                borderRadius: BorderRadius.circular(10),
              ),
              child: Icon(icon, color: color),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    label,
                    style: const TextStyle(
                      fontSize: 12,
                      color: Color(0xFF60708A),
                    ),
                  ),
                  const SizedBox(height: 4),
                  FittedBox(
                    fit: BoxFit.scaleDown,
                    alignment: Alignment.centerRight,
                    child: Text(
                      '$value $suffix',
                      style: const TextStyle(
                        fontWeight: FontWeight.w900,
                        color: _navy,
                      ),
                    ),
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

class RateTile extends StatelessWidget {
  const RateTile({super.key, required this.label, required this.rate});

  final String label;
  final double rate;

  @override
  Widget build(BuildContext context) {
    return SurfacePanel(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Row(
            children: [
              const Icon(Icons.currency_exchange_outlined, color: _green),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  label,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontWeight: FontWeight.w800),
                ),
              ),
            ],
          ),
          Text(
            '${formatAmount(rate)} د.ل',
            style: Theme.of(context).textTheme.titleLarge?.copyWith(
              fontWeight: FontWeight.w900,
              color: _navy,
            ),
          ),
          const Text(
            'سعر الخدمة الحالي',
            style: TextStyle(fontSize: 12, color: Color(0xFF60708A)),
          ),
        ],
      ),
    );
  }
}

class SectionTitle extends StatelessWidget {
  const SectionTitle({super.key, required this.title, required this.icon});

  final String title;
  final IconData icon;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Icon(icon, color: _green, size: 21),
        const SizedBox(width: 8),
        Text(
          title,
          style: Theme.of(context).textTheme.titleMedium?.copyWith(
            fontWeight: FontWeight.w800,
            color: Theme.of(context).colorScheme.onSurface,
          ),
        ),
      ],
    );
  }
}

class StatusPill extends StatelessWidget {
  const StatusPill({
    super.key,
    required this.label,
    required this.color,
    this.dark = false,
  });

  final String label;
  final Color color;
  final bool dark;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 5),
      decoration: BoxDecoration(
        color: dark
            ? color.withValues(alpha: 0.22)
            : color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(20),
      ),
      child: Text(
        label,
        style: TextStyle(
          color: dark ? Colors.white : color,
          fontWeight: FontWeight.w800,
          fontSize: 11,
        ),
      ),
    );
  }
}

class InlineMessage extends StatelessWidget {
  const InlineMessage({super.key, required this.message, required this.color});

  final String message;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.09),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: color.withValues(alpha: 0.32)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(
            color == _danger ? Icons.error_outline : Icons.info_outline,
            color: color,
            size: 20,
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Text(message, style: TextStyle(color: color, height: 1.45)),
          ),
        ],
      ),
    );
  }
}

class DetailLine extends StatelessWidget {
  const DetailLine({super.key, required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 7),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 122,
            child: Text(
              label,
              style: TextStyle(color: colors.onSurfaceVariant),
            ),
          ),
          Expanded(
            child: Text(
              value,
              textDirection: ui.TextDirection.rtl,
              style: TextStyle(
                fontWeight: FontWeight.w700,
                color: colors.onSurface,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class ProofPicker extends StatelessWidget {
  const ProofPicker({
    super.key,
    required this.required,
    required this.image,
    required this.onPick,
    required this.onClear,
    this.label,
  });

  final bool required;
  final Uint8List? image;
  final VoidCallback onPick;
  final VoidCallback onClear;
  final String? label;

  @override
  Widget build(BuildContext context) {
    if (image != null) {
      return SurfacePanel(
        child: Row(
          children: [
            ClipRRect(
              borderRadius: BorderRadius.circular(8),
              child: Image.memory(
                image!,
                width: 72,
                height: 72,
                fit: BoxFit.cover,
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Text(
                '${label ?? 'الصورة'} جاهزة للإرسال',
                style: const TextStyle(fontWeight: FontWeight.w800),
              ),
            ),
            IconButton(
              tooltip: 'حذف الصورة',
              onPressed: onClear,
              icon: const Icon(Icons.delete_outline, color: _danger),
            ),
          ],
        ),
      );
    }
    return OutlinedButton.icon(
      onPressed: onPick,
      style: OutlinedButton.styleFrom(
        minimumSize: const Size.fromHeight(50),
        alignment: Alignment.centerRight,
      ),
      icon: const Icon(Icons.add_a_photo_outlined),
      label: Text(
        '${label ?? 'إرفاق صورة'}${required ? ' (مطلوبة)' : ' (اختيارية)'}',
      ),
    );
  }
}

class TransactionTile extends StatelessWidget {
  const TransactionTile({
    super.key,
    required this.transaction,
    required this.onTap,
  });

  final Map<String, dynamic> transaction;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final status = transaction['status']?.toString();
    return Material(
      color: Colors.white,
      borderRadius: BorderRadius.circular(10),
      child: InkWell(
        borderRadius: BorderRadius.circular(10),
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.all(15),
          decoration: BoxDecoration(
            border: Border.all(color: const Color(0xFFDCE4EF)),
            borderRadius: BorderRadius.circular(10),
          ),
          child: Row(
            children: [
              Container(
                width: 44,
                height: 44,
                decoration: BoxDecoration(
                  color: statusColor(status).withValues(alpha: 0.11),
                  borderRadius: BorderRadius.circular(10),
                ),
                child: Icon(
                  Icons.receipt_long_outlined,
                  color: statusColor(status),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      '${transaction['transferTypeLabel'] ?? serviceLabel(transaction['transferType']?.toString())}',
                      style: const TextStyle(
                        fontWeight: FontWeight.w800,
                        color: _navy,
                      ),
                    ),
                    const SizedBox(height: 3),
                    Text(
                      '${transaction['customId'] ?? transaction['txId'] ?? '-'} · ${formatDate(transaction['createdAt'])}',
                      style: const TextStyle(
                        fontSize: 12,
                        color: Color(0xFF60708A),
                      ),
                    ),
                  ],
                ),
              ),
              Column(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  Text(
                    '${formatAmount(numberValue(transaction['amount']))} ج.م',
                    style: const TextStyle(
                      fontWeight: FontWeight.w900,
                      color: _navy,
                    ),
                  ),
                  const SizedBox(height: 5),
                  StatusPill(
                    label: statusLabel(status),
                    color: statusColor(status),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class SupportTicketTile extends StatelessWidget {
  const SupportTicketTile({super.key, required this.ticket});

  final Map<String, dynamic> ticket;

  @override
  Widget build(BuildContext context) {
    final status = '${ticket['status'] ?? 'open'}';
    final closed = ['closed', 'resolved'].contains(status);
    return SurfacePanel(
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 42,
            height: 42,
            decoration: BoxDecoration(
              color: (closed ? _green : _gold).withValues(alpha: 0.14),
              borderRadius: BorderRadius.circular(10),
            ),
            child: Icon(
              closed ? Icons.check_circle_outline : Icons.forum_outlined,
              color: closed ? _green : const Color(0xFF8A6200),
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  '${ticket['subject'] ?? ticket['title'] ?? 'تذكرة دعم'}',
                  style: const TextStyle(
                    fontWeight: FontWeight.w800,
                    color: _navy,
                  ),
                ),
                const SizedBox(height: 4),
                Text(
                  '${ticket['lastMessage'] ?? ticket['message'] ?? ''}',
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(color: Color(0xFF60708A)),
                ),
                const SizedBox(height: 8),
                StatusPill(
                  label: closed ? 'مغلقة' : 'مفتوحة',
                  color: closed ? _green : const Color(0xFF8A6200),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class SubAccountTile extends StatelessWidget {
  const SubAccountTile({
    super.key,
    required this.account,
    required this.onSetLimit,
    required this.onSettlement,
  });

  final Map<String, dynamic> account;
  final VoidCallback onSetLimit;
  final VoidCallback onSettlement;

  @override
  Widget build(BuildContext context) {
    final balance = numberValue(account['balance']);
    final debt = numberValue(account['debt']);
    return SurfacePanel(
      child: Column(
        children: [
          Row(
            children: [
              const CircleAvatar(
                backgroundColor: Color(0xFFDFF5EA),
                child: Icon(Icons.person_outline, color: _green),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      '${account['name'] ?? '-'}',
                      style: const TextStyle(
                        fontWeight: FontWeight.w800,
                        color: _navy,
                      ),
                    ),
                    Text(
                      '${account['accountCode'] ?? account['phone'] ?? ''}',
                      style: const TextStyle(
                        fontSize: 12,
                        color: Color(0xFF60708A),
                      ),
                    ),
                  ],
                ),
              ),
              StatusPill(
                label: account['status'] == 'active' ? 'نشط' : 'موقوف',
                color: account['status'] == 'active' ? _green : _danger,
              ),
            ],
          ),
          const SizedBox(height: 14),
          Wrap(
            spacing: 18,
            runSpacing: 8,
            children: [
              _Metric(
                label: 'الرصيد',
                value: '${formatAmount(balance)} د.ل',
                color: balance < 0 ? _danger : _navy,
              ),
              _Metric(
                label: 'الحد الائتماني',
                value:
                    '${formatAmount(numberValue(account['creditLimit']))} د.ل',
                color: _navy,
              ),
              _Metric(
                label: 'الدين',
                value: '${formatAmount(debt)} د.ل',
                color: debt > 0 ? _danger : _navy,
              ),
              _Metric(
                label: 'المتاح',
                value:
                    '${formatAmount(numberValue(account['availableToSpend']))} د.ل',
                color: _green,
              ),
            ],
          ),
          const Divider(height: 24),
          Row(
            children: [
              Expanded(
                child: OutlinedButton.icon(
                  onPressed: onSetLimit,
                  icon: const Icon(Icons.tune_outlined),
                  label: const Text('الحد الائتماني'),
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: FilledButton.icon(
                  onPressed: onSettlement,
                  icon: const Icon(Icons.account_balance_wallet_outlined),
                  label: const Text('تسوية'),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _Metric extends StatelessWidget {
  const _Metric({
    required this.label,
    required this.value,
    required this.color,
  });

  final String label;
  final String value;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          label,
          style: const TextStyle(fontSize: 11, color: Color(0xFF60708A)),
        ),
        const SizedBox(height: 3),
        Text(
          value,
          style: TextStyle(fontWeight: FontWeight.w800, color: color),
        ),
      ],
    );
  }
}

class ExecutorTaskTile extends StatelessWidget {
  const ExecutorTaskTile({
    super.key,
    required this.task,
    required this.busy,
    required this.onAccept,
    required this.onCancel,
    required this.onComplete,
  });

  final Map<String, dynamic> task;
  final bool busy;
  final VoidCallback onAccept;
  final VoidCallback onCancel;
  final VoidCallback onComplete;

  @override
  Widget build(BuildContext context) {
    final accepted = task['status'] == 'accepted';
    return SurfacePanel(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                width: 46,
                height: 46,
                decoration: BoxDecoration(
                  color: const Color(0xFFE7F1FF),
                  borderRadius: BorderRadius.circular(10),
                ),
                child: const Icon(
                  Icons.bolt_outlined,
                  color: Color(0xFF1976D2),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      '${task['txId'] ?? '-'}',
                      style: const TextStyle(
                        fontWeight: FontWeight.w900,
                        color: _navy,
                      ),
                    ),
                    Text(
                      '${task['transferTypeLabel'] ?? serviceLabel(task['transferType']?.toString())}',
                      style: const TextStyle(color: Color(0xFF60708A)),
                    ),
                  ],
                ),
              ),
              StatusPill(
                label: statusLabel(task['status']?.toString()),
                color: statusColor(task['status']?.toString()),
              ),
            ],
          ),
          const SizedBox(height: 14),
          Wrap(
            spacing: 20,
            runSpacing: 8,
            children: [
              _Metric(
                label: 'رقم المستلم',
                value: '${task['recipientNumber'] ?? '-'}',
                color: _navy,
              ),
              _Metric(
                label: 'القيمة',
                value: '${formatAmount(numberValue(task['amount']))} ج.م',
                color: _green,
              ),
              _Metric(
                label: 'وقت الوصول',
                value: formatDate(task['createdAt']),
                color: _navy,
              ),
            ],
          ),
          const Divider(height: 26),
          if (!accepted)
            SizedBox(
              width: double.infinity,
              child: FilledButton.icon(
                onPressed: busy ? null : onAccept,
                icon: const Icon(Icons.task_alt_outlined),
                label: const Text('قبول العملية'),
              ),
            )
          else
            Row(
              children: [
                Expanded(
                  child: OutlinedButton.icon(
                    onPressed: busy ? null : onCancel,
                    icon: const Icon(Icons.cancel_outlined),
                    label: const Text('إلغاء'),
                    style: OutlinedButton.styleFrom(foregroundColor: _danger),
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: FilledButton.icon(
                    onPressed: busy ? null : onComplete,
                    icon: const Icon(Icons.check_circle_outline),
                    label: const Text('إتمام العملية'),
                  ),
                ),
              ],
            ),
        ],
      ),
    );
  }
}

class EmptyPanel extends StatelessWidget {
  const EmptyPanel({
    super.key,
    required this.icon,
    required this.title,
    required this.message,
  });

  final IconData icon;
  final String title;
  final String message;

  @override
  Widget build(BuildContext context) {
    return SurfacePanel(
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 28),
        child: Column(
          children: [
            Icon(icon, color: const Color(0xFF8FA0B5), size: 42),
            const SizedBox(height: 12),
            Text(
              title,
              style: const TextStyle(fontWeight: FontWeight.w800, color: _navy),
            ),
            const SizedBox(height: 5),
            Text(
              message,
              textAlign: TextAlign.center,
              style: const TextStyle(color: Color(0xFF60708A)),
            ),
          ],
        ),
      ),
    );
  }
}

class PageLoading extends StatelessWidget {
  const PageLoading({super.key});

  @override
  Widget build(BuildContext context) {
    return const Center(child: CircularProgressIndicator(color: _green));
  }
}

class ErrorPage extends StatelessWidget {
  const ErrorPage({super.key, required this.error, required this.onRetry});

  final Object error;
  final Future<void> Function() onRetry;

  @override
  Widget build(BuildContext context) {
    final message = error is ApiFailure
        ? (error as ApiFailure).message
        : 'تعذر تحميل البيانات حالياً.';
    return Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 420),
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              EmptyPanel(
                icon: Icons.cloud_off_outlined,
                title: 'تعذر تحميل البيانات',
                message: message,
              ),
              const SizedBox(height: 14),
              FilledButton.icon(
                onPressed: onRetry,
                icon: const Icon(Icons.refresh),
                label: const Text('إعادة المحاولة'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

void showSnack(BuildContext context, String message, {bool error = false}) {
  ScaffoldMessenger.of(context).showSnackBar(
    SnackBar(
      content: Text(message),
      backgroundColor: error ? _danger : _green,
      behavior: SnackBarBehavior.floating,
    ),
  );
}
