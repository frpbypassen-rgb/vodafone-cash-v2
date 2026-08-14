import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/services.dart';
import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:intl/intl.dart';

import 'appearance_controller.dart';
import 'brand_theme.dart';
import 'executor_alert_service.dart';
import 'external_link.dart';
import 'mobile_api.dart';
import 'report_download.dart';

const _navy = AhramColors.ink;
const _green = AhramColors.emerald;
const _gold = AhramColors.gold;
const _danger = AhramColors.danger;

String formatAmount(num? value, {int fractionDigits = 2}) {
  return NumberFormat.currency(
    locale: 'en',
    symbol: '',
    decimalDigits: fractionDigits,
  ).format(value ?? 0).trim();
}

String formatEgpAmount(num? value) => formatAmount(value, fractionDigits: 0);

String formatDate(dynamic value) {
  if (value == null) return '-';
  final parsed = DateTime.tryParse('$value');
  if (parsed == null) return '$value';
  return DateFormat('yyyy/MM/dd - hh:mm a', 'ar').format(parsed.toLocal());
}

String formatTaskArrival(dynamic value) {
  if (value == null) return '-';
  final parsed = DateTime.tryParse('$value');
  if (parsed == null) return '$value';
  return DateFormat('yyyy/MM/dd HH:mm:ss', 'en').format(parsed.toLocal());
}

String formatExecutionDuration(dynamic value) {
  final seconds = numberValue(value).round();
  if (seconds <= 0) return 'غير مكتملة';
  final minutes = seconds ~/ 60;
  final remainingSeconds = seconds % 60;
  if (minutes == 0) return '$remainingSeconds ث';
  if (minutes < 60) return '$minutes د $remainingSeconds ث';
  return '${minutes ~/ 60} س ${minutes % 60} د';
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
  bool _rememberLogin = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    unawaited(_loadSavedLogin());
  }

  Future<void> _loadSavedLogin() async {
    final saved = await widget.controller.savedLogin();
    if (!mounted || saved == null) return;
    setState(() {
      _username.text = saved.username;
      _password.text = saved.password;
      _rememberLogin = true;
    });
  }

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
      if (_rememberLogin) {
        await widget.controller.saveLogin(
          username: _username.text.trim(),
          password: _password.text,
        );
      } else {
        await widget.controller.clearSavedLogin();
      }
      if (widget.controller.isExecutor || widget.controller.isCustomerAccount) {
        await ExecutorAlertService.instance.requestPermissionsAndStart();
      }
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
      body: DecoratedBox(
        decoration: const BoxDecoration(
          gradient: LinearGradient(
            begin: Alignment.topRight,
            end: Alignment.bottomLeft,
            colors: <Color>[Color(0xFF001A4D), Color(0xFF000C24)],
          ),
        ),
        child: SafeArea(
          child: LayoutBuilder(
            builder: (context, constraints) => Center(
              child: SingleChildScrollView(
                padding: const EdgeInsets.all(22),
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 420),
                  child: Container(
                    padding: const EdgeInsets.fromLTRB(28, 34, 28, 28),
                    decoration: BoxDecoration(
                      color: Colors.white.withValues(alpha: 0.97),
                      borderRadius: BorderRadius.circular(24),
                      border: Border(
                        bottom: BorderSide(color: _gold, width: 6),
                      ),
                      boxShadow: [
                        BoxShadow(
                          color: Colors.black.withValues(alpha: 0.38),
                          blurRadius: 42,
                          offset: const Offset(0, 20),
                        ),
                      ],
                    ),
                    child: Form(
                      key: _formKey,
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          const _AhramLoginWordmark(),
                          const SizedBox(height: 12),
                          Container(
                            width: 118,
                            height: 3,
                            margin: const EdgeInsets.symmetric(horizontal: 92),
                            color: _gold,
                          ),
                          const SizedBox(height: 16),
                          const Text(
                            'البوابة الموحدة',
                            textAlign: TextAlign.center,
                            style: TextStyle(
                              color: Color(0xFF667085),
                              fontWeight: FontWeight.w800,
                              fontSize: 14,
                            ),
                          ),
                          const SizedBox(height: 28),
                          TextFormField(
                            controller: _username,
                            keyboardType: TextInputType.text,
                            textDirection: ui.TextDirection.ltr,
                            decoration: const InputDecoration(
                              labelText: 'اسم المستخدم',
                              hintText: 'Username',
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
                          const SizedBox(height: 16),
                          TextFormField(
                            controller: _password,
                            obscureText: _obscure,
                            textDirection: ui.TextDirection.ltr,
                            decoration: InputDecoration(
                              labelText: 'كلمة المرور',
                              hintText: 'Password',
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
                          const SizedBox(height: 6),
                          CheckboxListTile.adaptive(
                            contentPadding: EdgeInsets.zero,
                            value: _rememberLogin,
                            onChanged: _busy
                                ? null
                                : (value) => setState(
                                    () => _rememberLogin = value ?? false,
                                  ),
                            controlAffinity: ListTileControlAffinity.leading,
                            title: const Text(
                              'حفظ بيانات الدخول على هذا الجهاز',
                              style: TextStyle(fontWeight: FontWeight.w800),
                            ),
                            subtitle: const Text(
                              'تُحفظ بشكل مشفر لتعبئة الدخول لاحقاً.',
                            ),
                          ),
                          if (_error != null) ...[
                            const SizedBox(height: 14),
                            InlineMessage(message: _error!, color: _danger),
                          ],
                          const SizedBox(height: 24),
                          SizedBox(
                            height: 56,
                            child: FilledButton.icon(
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
                                  : const Icon(Icons.arrow_back_rounded),
                              label: Text(
                                _busy ? 'جارٍ التحقق...' : 'تسجيل الدخول',
                              ),
                              style: FilledButton.styleFrom(
                                backgroundColor: _gold,
                                foregroundColor: Colors.white,
                                elevation: 6,
                                shadowColor: _gold.withValues(alpha: 0.34),
                                shape: RoundedRectangleBorder(
                                  borderRadius: BorderRadius.circular(16),
                                ),
                              ),
                            ),
                          ),
                          const SizedBox(height: 12),
                          SizedBox(
                            height: 52,
                            child: OutlinedButton.icon(
                              onPressed: _busy
                                  ? null
                                  : () => Navigator.of(context).push(
                                      MaterialPageRoute<void>(
                                        builder: (_) => RegistrationScreen(
                                          api: widget.controller.api,
                                        ),
                                      ),
                                    ),
                              icon: const Icon(Icons.person_add_alt_1_outlined),
                              label: const Text('إنشاء حساب جديد'),
                              style: OutlinedButton.styleFrom(
                                foregroundColor: const Color(0xFF001A4D),
                                side: const BorderSide(
                                  color: Color(0xFF001A4D),
                                ),
                                shape: RoundedRectangleBorder(
                                  borderRadius: BorderRadius.circular(16),
                                ),
                              ),
                            ),
                          ),
                          const SizedBox(height: 22),
                          const Text(
                            'Power Pay AL-Ahram',
                            textDirection: ui.TextDirection.ltr,
                            textAlign: TextAlign.center,
                            style: TextStyle(
                              color: Color(0xFF667085),
                              fontSize: 12,
                              fontWeight: FontWeight.w800,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _AhramLoginWordmark extends StatelessWidget {
  const _AhramLoginWordmark();

  @override
  Widget build(BuildContext context) {
    return RichText(
      textAlign: TextAlign.center,
      textDirection: ui.TextDirection.ltr,
      text: const TextSpan(
        style: TextStyle(
          fontSize: 38,
          fontWeight: FontWeight.w900,
          fontFamily: 'NotoSansArabic',
          letterSpacing: 0,
        ),
        children: [
          TextSpan(
            text: 'Ahram',
            style: TextStyle(color: Color(0xFF001A4D)),
          ),
          TextSpan(
            text: ' Pay',
            style: TextStyle(color: _gold),
          ),
        ],
      ),
    );
  }
}

enum RegistrationAccountType { direct, company, agent, newClient }

extension RegistrationAccountTypeDetails on RegistrationAccountType {
  String get title => switch (this) {
    RegistrationAccountType.direct => 'عميل مباشر',
    RegistrationAccountType.company => 'حساب شركة',
    RegistrationAccountType.agent => 'وكيل منطقة',
    RegistrationAccountType.newClient => 'عميل جديد',
  };

  String get subtitle => switch (this) {
    RegistrationAccountType.direct => 'حساب مستقل للعميل',
    RegistrationAccountType.company => 'إدارة حسابات الشركة',
    RegistrationAccountType.agent => 'إدارة عملاء المنطقة',
    RegistrationAccountType.newClient => 'عميل تابع لوكيل',
  };

  IconData get icon => switch (this) {
    RegistrationAccountType.direct => Icons.person_outline_rounded,
    RegistrationAccountType.company => Icons.business_outlined,
    RegistrationAccountType.agent => Icons.map_outlined,
    RegistrationAccountType.newClient => Icons.person_add_alt_1_outlined,
  };
}

class RegistrationScreen extends StatefulWidget {
  const RegistrationScreen({super.key, required this.api});

  final MobileApi api;

  @override
  State<RegistrationScreen> createState() => _RegistrationScreenState();
}

class _RegistrationScreenState extends State<RegistrationScreen> {
  static const _cities = <String>[
    'طرابلس',
    'بنغازي',
    'مصراتة',
    'الزاوية',
    'زليتن',
    'الخمس',
    'سبها',
    'سرت',
    'درنة',
    'طبرق',
    'البيضاء',
    'اجدابيا',
    'غريان',
    'المرج',
    'نالوت',
    'زوارة',
    'صبراتة',
    'صرمان',
    'يفرن',
    'ترهونة',
    'بني وليد',
    'غات',
    'غدامس',
    'أوباري',
    'مرزق',
    'هون',
    'ودان',
    'الجفرة',
    'الكفرة',
    'تاجوراء',
    'جنزور',
    'قصر بن غشير',
    'العجيلات',
    'رقدالين',
    'الجميل',
    'زلطن',
    'الأصابعة',
    'مزدة',
    'الشويرف',
    'القبة',
  ];

  final _formKey = GlobalKey<FormState>();
  final _fullName = TextEditingController();
  final _phone = TextEditingController();
  final _storeName = TextEditingController();
  final _address = TextEditingController();
  final _companyName = TextEditingController();
  final _companyEmail = TextEditingController();
  final _username = TextEditingController();
  final _password = TextEditingController();
  final _confirmation = TextEditingController();
  final _agentCode = TextEditingController();

  RegistrationAccountType? _type;
  String? _city;
  String _nationality = 'libyan';
  String? _agentName;
  bool _checkingAgent = false;
  bool _submitting = false;
  String? _error;
  Map<String, dynamic>? _completedRequest;

  @override
  void dispose() {
    _fullName.dispose();
    _phone.dispose();
    _storeName.dispose();
    _address.dispose();
    _companyName.dispose();
    _companyEmail.dispose();
    _username.dispose();
    _password.dispose();
    _confirmation.dispose();
    _agentCode.dispose();
    super.dispose();
  }

  void _selectType(RegistrationAccountType type) {
    setState(() {
      _type = type;
      _error = null;
      _completedRequest = null;
    });
  }

  void _changeType() {
    setState(() {
      _type = null;
      _error = null;
      _completedRequest = null;
      _agentName = null;
    });
  }

  Future<void> _lookupAgent() async {
    final code = _agentCode.text.trim();
    if (!RegExp(r'^\d{4}$').hasMatch(code)) {
      setState(() => _error = 'أدخل رقم وكيل مكوناً من 4 أرقام.');
      return;
    }
    setState(() {
      _checkingAgent = true;
      _error = null;
      _agentName = null;
    });
    try {
      final response = await widget.api.lookupRegistrationAgent(code);
      final data = response['data'];
      final name = data is Map ? '${data['name'] ?? ''}'.trim() : '';
      if (!mounted) return;
      setState(() {
        _agentName = name.isEmpty ? 'وكيل معتمد' : name;
      });
    } on ApiFailure catch (error) {
      if (mounted) setState(() => _error = error.message);
    } catch (_) {
      if (mounted) {
        setState(() => _error = 'تعذر التحقق من رقم الوكيل حالياً.');
      }
    } finally {
      if (mounted) setState(() => _checkingAgent = false);
    }
  }

  Future<void> _submit() async {
    if (_type == null || !_formKey.currentState!.validate()) return;
    if (_type == RegistrationAccountType.newClient && _agentName == null) {
      setState(() => _error = 'تحقق من رقم الوكيل قبل إرسال الطلب.');
      return;
    }

    setState(() {
      _submitting = true;
      _error = null;
    });
    try {
      final response = await switch (_type!) {
        RegistrationAccountType.direct => widget.api.registerDirectAccount(
          fullName: _fullName.text.trim(),
          phone: _phone.text.trim(),
          storeName: _storeName.text.trim(),
          address: _address.text.trim(),
          username: _username.text.trim(),
          password: _password.text,
        ),
        RegistrationAccountType.company => widget.api.registerCompanyAccount(
          companyName: _companyName.text.trim(),
          companyContact: _fullName.text.trim(),
          companyPhone: _phone.text.trim(),
          companyEmail: _companyEmail.text.trim(),
          username: _username.text.trim(),
          password: _password.text,
        ),
        RegistrationAccountType.agent => widget.api.registerAgentAccount(
          companyName: _companyName.text.trim(),
          fullName: _fullName.text.trim(),
          phone: _phone.text.trim(),
          address: _address.text.trim(),
          city: _city ?? '',
          companyEmail: _companyEmail.text.trim(),
          username: _username.text.trim(),
          password: _password.text,
        ),
        RegistrationAccountType.newClient =>
          widget.api.registerNewClientAccount(
            fullName: _fullName.text.trim(),
            phone: _phone.text.trim(),
            city: _city ?? '',
            nationality: _nationality,
            username: _username.text.trim(),
            password: _password.text,
            agentCode: _agentCode.text.trim(),
          ),
      };
      if (!mounted) return;
      final data = response['data'];
      setState(() {
        _completedRequest = data is Map<String, dynamic>
            ? data
            : Map<String, dynamic>.from(data as Map? ?? const {});
      });
    } on ApiFailure catch (error) {
      if (mounted) setState(() => _error = error.message);
    } catch (_) {
      if (mounted) {
        setState(() => _error = 'تعذر إرسال طلب التسجيل حالياً.');
      }
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  String? _required(String? value, String label) {
    if ((value ?? '').trim().isEmpty) return '$label مطلوب.';
    return null;
  }

  String? _fullNameValidator(String? value) {
    if (_required(value, 'الاسم') != null) return 'الاسم مطلوب.';
    if ((value ?? '').trim().split(RegExp(r'\s+')).length < 3) {
      return 'أدخل الاسم الثلاثي كاملاً.';
    }
    return null;
  }

  String? _phoneValidator(String? value) {
    final phone = (value ?? '').trim();
    if (!RegExp(r'^\d{10,20}$').hasMatch(phone)) {
      return 'رقم الهاتف من 10 إلى 20 رقماً.';
    }
    return null;
  }

  String? _usernameValidator(String? value) {
    if (!RegExp(r'^[A-Za-z0-9_]{3,20}$').hasMatch((value ?? '').trim())) {
      return 'اسم المستخدم 3 إلى 20 حرفاً إنجليزياً أو رقماً.';
    }
    return null;
  }

  String? _passwordValidator(String? value) {
    if ((value ?? '').length < 6) return 'كلمة المرور 6 أحرف على الأقل.';
    return null;
  }

  Widget _textField({
    required TextEditingController controller,
    required String label,
    required IconData icon,
    required String? Function(String?) validator,
    TextInputType keyboardType = TextInputType.text,
    bool obscure = false,
    bool ltr = false,
    List<TextInputFormatter>? inputFormatters,
    VoidCallback? onChanged,
  }) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 4),
      child: TextFormField(
        controller: controller,
        keyboardType: keyboardType,
        obscureText: obscure,
        textDirection: ltr ? ui.TextDirection.ltr : ui.TextDirection.rtl,
        inputFormatters: inputFormatters,
        validator: validator,
        onChanged: (_) => onChanged?.call(),
        decoration: InputDecoration(labelText: label, prefixIcon: Icon(icon)),
      ),
    );
  }

  Widget _cityField() {
    return Padding(
      padding: const EdgeInsets.only(bottom: 4),
      child: DropdownButtonFormField<String>(
        value: _city,
        isExpanded: true,
        decoration: const InputDecoration(
          labelText: 'المدينة',
          prefixIcon: Icon(Icons.location_city_outlined),
        ),
        items: _cities
            .map(
              (city) =>
                  DropdownMenuItem<String>(value: city, child: Text(city)),
            )
            .toList(),
        onChanged: (value) => setState(() => _city = value),
        validator: (value) => value == null ? 'اختر المدينة.' : null,
      ),
    );
  }

  Widget _accountCredentials() {
    return _formSection(
      icon: Icons.lock_outline_rounded,
      title: 'بيانات الدخول',
      child: _responsiveFields([
        _textField(
          controller: _username,
          label: 'اسم المستخدم',
          icon: Icons.alternate_email_outlined,
          ltr: true,
          validator: _usernameValidator,
        ),
        _textField(
          controller: _password,
          label: 'كلمة المرور',
          icon: Icons.lock_outline,
          obscure: true,
          ltr: true,
          validator: _passwordValidator,
        ),
        _textField(
          controller: _confirmation,
          label: 'تأكيد كلمة المرور',
          icon: Icons.lock_reset_outlined,
          obscure: true,
          ltr: true,
          validator: (value) {
            if (value != _password.text) return 'كلمتا المرور غير متطابقتين.';
            return null;
          },
        ),
      ]),
    );
  }

  Widget _responsiveFields(List<Widget> fields) {
    return LayoutBuilder(
      builder: (context, constraints) {
        final compact = constraints.maxWidth < 560;
        final width = compact
            ? constraints.maxWidth
            : (constraints.maxWidth - 14) / 2;
        return Wrap(
          spacing: 14,
          runSpacing: 10,
          children: fields
              .map((field) => SizedBox(width: width, child: field))
              .toList(),
        );
      },
    );
  }

  Widget _formSection({
    required IconData icon,
    required String title,
    required Widget child,
  }) {
    final colors = Theme.of(context).colorScheme;
    final dark = Theme.of(context).brightness == Brightness.dark;
    return Container(
      margin: const EdgeInsets.only(bottom: 16),
      padding: const EdgeInsets.fromLTRB(16, 15, 16, 16),
      decoration: BoxDecoration(
        color: dark
            ? colors.surfaceContainerHighest.withValues(alpha: 0.32)
            : colors.surface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: colors.outlineVariant),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Container(
                width: 34,
                height: 34,
                decoration: BoxDecoration(
                  color: colors.primary.withValues(alpha: dark ? 0.20 : 0.10),
                  borderRadius: BorderRadius.circular(9),
                ),
                child: Icon(icon, size: 19, color: colors.primary),
              ),
              const SizedBox(width: 10),
              Text(
                title,
                style: TextStyle(
                  fontSize: 15,
                  fontWeight: FontWeight.w900,
                  color: colors.onSurface,
                ),
              ),
            ],
          ),
          const SizedBox(height: 16),
          child,
        ],
      ),
    );
  }

  Widget _formFields() {
    final type = _type!;
    final isCompany = type == RegistrationAccountType.company;

    return Form(
      key: _formKey,
      autovalidateMode: AutovalidateMode.onUserInteraction,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (type == RegistrationAccountType.newClient) ...[
            _formSection(
              icon: Icons.verified_user_outlined,
              title: 'بيانات الوكيل',
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  _responsiveFields([
                    _textField(
                      controller: _agentCode,
                      label: 'رقم الوكيل',
                      icon: Icons.badge_outlined,
                      ltr: true,
                      keyboardType: TextInputType.number,
                      inputFormatters: <TextInputFormatter>[
                        FilteringTextInputFormatter.digitsOnly,
                        LengthLimitingTextInputFormatter(4),
                      ],
                      validator: (value) =>
                          RegExp(r'^\d{4}$').hasMatch(value ?? '')
                          ? null
                          : 'رقم الوكيل مكون من 4 أرقام.',
                      onChanged: () {
                        if (_agentName != null) {
                          setState(() => _agentName = null);
                        }
                      },
                    ),
                  ]),
                  const SizedBox(height: 8),
                  OutlinedButton.icon(
                    onPressed: _checkingAgent ? null : _lookupAgent,
                    icon: _checkingAgent
                        ? const SizedBox(
                            width: 18,
                            height: 18,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Icon(Icons.verified_user_outlined),
                    label: Text(
                      _checkingAgent ? 'جارٍ التحقق...' : 'تحقق من الوكيل',
                    ),
                  ),
                ],
              ),
            ),
            if (_agentName != null)
              Padding(
                padding: const EdgeInsets.only(bottom: 20),
                child: _RegistrationVerifiedAgent(name: _agentName!),
              ),
          ],
          if (type == RegistrationAccountType.direct) ...[
            _formSection(
              icon: Icons.storefront_outlined,
              title: 'بيانات النشاط',
              child: _responsiveFields([
                _textField(
                  controller: _storeName,
                  label: 'اسم المحل',
                  icon: Icons.storefront_outlined,
                  validator: (value) => _required(value, 'اسم المحل'),
                ),
                _textField(
                  controller: _address,
                  label: 'العنوان',
                  icon: Icons.location_on_outlined,
                  validator: (value) => _required(value, 'العنوان'),
                ),
              ]),
            ),
          ],
          if (isCompany || type == RegistrationAccountType.agent)
            _formSection(
              icon: Icons.business_outlined,
              title: isCompany ? 'بيانات الشركة' : 'بيانات الوكالة',
              child: _responsiveFields([
                _textField(
                  controller: _companyName,
                  label: isCompany ? 'اسم الشركة القانوني' : 'اسم الوكالة',
                  icon: Icons.business_outlined,
                  validator: (value) => _required(value, 'اسم المنشأة'),
                ),
                _textField(
                  controller: _companyEmail,
                  label: 'البريد الإلكتروني الرسمي',
                  icon: Icons.email_outlined,
                  ltr: true,
                  keyboardType: TextInputType.emailAddress,
                  validator: (value) {
                    if (!RegExp(
                      r'^[^\s@]+@[^\s@]+\.[^\s@]+$',
                    ).hasMatch((value ?? '').trim())) {
                      return 'أدخل بريداً إلكترونياً صحيحاً.';
                    }
                    return null;
                  },
                ),
              ]),
            ),
          _formSection(
            icon: Icons.person_outline,
            title: isCompany ? 'بيانات المدير' : 'بيانات مقدم الطلب',
            child: _responsiveFields([
              _textField(
                controller: _fullName,
                label: isCompany ? 'اسم مدير الشركة' : 'الاسم الثلاثي',
                icon: Icons.person_outline,
                validator: isCompany
                    ? (value) => _required(value, 'اسم مدير الشركة')
                    : _fullNameValidator,
              ),
              _textField(
                controller: _phone,
                label: isCompany ? 'رقم هاتف الشركة' : 'رقم الهاتف',
                icon: Icons.phone_outlined,
                ltr: true,
                keyboardType: TextInputType.phone,
                inputFormatters: <TextInputFormatter>[
                  FilteringTextInputFormatter.digitsOnly,
                  LengthLimitingTextInputFormatter(20),
                ],
                validator: _phoneValidator,
              ),
              if (type == RegistrationAccountType.agent)
                _textField(
                  controller: _address,
                  label: 'العنوان',
                  icon: Icons.location_on_outlined,
                  validator: (value) => _required(value, 'العنوان'),
                ),
              if (type == RegistrationAccountType.agent ||
                  type == RegistrationAccountType.newClient)
                _cityField(),
              if (type == RegistrationAccountType.newClient)
                Padding(
                  padding: const EdgeInsets.only(bottom: 4),
                  child: DropdownButtonFormField<String>(
                    value: _nationality,
                    decoration: const InputDecoration(
                      labelText: 'الجنسية',
                      prefixIcon: Icon(Icons.public_outlined),
                    ),
                    items: const [
                      DropdownMenuItem(value: 'libyan', child: Text('ليبي')),
                      DropdownMenuItem(value: 'egyptian', child: Text('مصري')),
                    ],
                    onChanged: (value) {
                      if (value != null) setState(() => _nationality = value);
                    },
                  ),
                ),
            ]),
          ),
          _accountCredentials(),
          if (_error != null) ...[
            const SizedBox(height: 6),
            InlineMessage(message: _error!, color: _danger),
          ],
          const SizedBox(height: 18),
          SizedBox(
            height: 56,
            child: FilledButton.icon(
              onPressed: _submitting ? null : _submit,
              icon: _submitting
                  ? const SizedBox(
                      width: 18,
                      height: 18,
                      child: CircularProgressIndicator(
                        strokeWidth: 2,
                        color: Colors.white,
                      ),
                    )
                  : const Icon(Icons.arrow_back_rounded),
              label: Text(
                _submitting ? 'جارٍ إرسال الطلب...' : 'إرسال طلب التسجيل',
              ),
              style: FilledButton.styleFrom(
                backgroundColor: _gold,
                foregroundColor: Colors.white,
                elevation: 2,
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _typeSelection() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const _RegistrationPageHeader(
          overline: 'فتح حساب جديد',
          title: 'اختر نوع الحساب',
          subtitle: 'حدد الحساب المناسب لبدء طلب التسجيل.',
        ),
        const SizedBox(height: 24),
        LayoutBuilder(
          builder: (context, constraints) {
            final width = constraints.maxWidth >= 560
                ? (constraints.maxWidth - 14) / 2
                : constraints.maxWidth;
            return Wrap(
              spacing: 14,
              runSpacing: 14,
              children: RegistrationAccountType.values
                  .map(
                    (type) => SizedBox(
                      width: width,
                      child: _RegistrationTypeCard(
                        type: type,
                        onTap: () => _selectType(type),
                      ),
                    ),
                  )
                  .toList(),
            );
          },
        ),
      ],
    );
  }

  Widget _successView() {
    final request = _completedRequest!;
    final isAgentApproval = _type == RegistrationAccountType.newClient;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Container(
          padding: const EdgeInsets.all(28),
          decoration: BoxDecoration(
            color: const Color(0xFF00875A),
            borderRadius: BorderRadius.circular(16),
          ),
          child: const Column(
            children: [
              Icon(Icons.check_circle_rounded, color: Colors.white, size: 68),
              SizedBox(height: 14),
              Text(
                'تم إرسال طلب التسجيل',
                textAlign: TextAlign.center,
                style: TextStyle(
                  fontSize: 23,
                  fontWeight: FontWeight.w900,
                  color: Colors.white,
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 18),
        Text(
          isAgentApproval
              ? 'بانتظار موافقة الوكيل.'
              : 'بانتظار مراجعة الإدارة.',
          textAlign: TextAlign.center,
          style: TextStyle(
            color: Theme.of(context).colorScheme.onSurfaceVariant,
          ),
        ),
        const SizedBox(height: 22),
        Container(
          padding: const EdgeInsets.all(18),
          decoration: BoxDecoration(
            color: Theme.of(context).colorScheme.surface,
            borderRadius: BorderRadius.circular(12),
            border: Border.all(
              color: Theme.of(context).colorScheme.outlineVariant,
            ),
          ),
          child: Column(
            children: [
              const Text('رقم طلب التسجيل'),
              const SizedBox(height: 6),
              SelectableText(
                '${request['refCode'] ?? '-'}',
                textDirection: ui.TextDirection.ltr,
                style: const TextStyle(
                  fontSize: 22,
                  fontWeight: FontWeight.w900,
                  color: Color(0xFF001A4D),
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 22),
        SizedBox(
          height: 52,
          child: FilledButton.icon(
            onPressed: () => Navigator.of(context).pop(),
            icon: const Icon(Icons.login_rounded),
            label: const Text('العودة لتسجيل الدخول'),
          ),
        ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    final type = _type;
    return Scaffold(
      appBar: AppBar(
        title: Text(type == null ? 'إنشاء حساب' : type.title),
        leading: IconButton(
          tooltip: type == null ? 'العودة' : 'اختيار نوع الحساب',
          icon: Icon(
            type == null
                ? Icons.arrow_back_rounded
                : Icons.arrow_forward_rounded,
          ),
          onPressed: type == null
              ? () => Navigator.of(context).pop()
              : _changeType,
        ),
        actions: [
          Padding(
            padding: EdgeInsets.only(left: 16),
            child: BrandMark(compact: true),
          ),
        ],
      ),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(18, 22, 18, 36),
          child: Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 760),
              child: _completedRequest != null
                  ? _successView()
                  : type == null
                  ? _typeSelection()
                  : Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        _RegistrationFormHero(
                          type: type,
                          onChange: _changeType,
                        ),
                        const SizedBox(height: 18),
                        const _RegistrationProgress(currentStep: 2),
                        const SizedBox(height: 22),
                        _formFields(),
                      ],
                    ),
            ),
          ),
        ),
      ),
    );
  }
}

class _RegistrationTypeCard extends StatelessWidget {
  const _RegistrationTypeCard({required this.type, required this.onTap});

  final RegistrationAccountType type;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final dark = Theme.of(context).brightness == Brightness.dark;
    return Material(
      color: colors.surface,
      borderRadius: BorderRadius.circular(14),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(14),
        child: Container(
          height: 156,
          padding: const EdgeInsets.all(17),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(14),
            border: Border.all(color: colors.outlineVariant),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Container(
                    width: 42,
                    height: 42,
                    decoration: BoxDecoration(
                      color: colors.primary.withValues(
                        alpha: dark ? 0.22 : 0.10,
                      ),
                      borderRadius: BorderRadius.circular(11),
                    ),
                    child: Icon(type.icon, color: colors.primary, size: 23),
                  ),
                  const Spacer(),
                  Icon(
                    Icons.arrow_back_rounded,
                    color: colors.onSurfaceVariant,
                  ),
                ],
              ),
              const Spacer(),
              Text(
                type.title,
                style: TextStyle(
                  fontSize: 16,
                  fontWeight: FontWeight.w900,
                  color: colors.onSurface,
                ),
              ),
              const SizedBox(height: 4),
              Text(
                type.subtitle,
                style: TextStyle(fontSize: 12, color: colors.onSurfaceVariant),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _RegistrationPageHeader extends StatelessWidget {
  const _RegistrationPageHeader({
    required this.overline,
    required this.title,
    required this.subtitle,
  });

  final String overline;
  final String title;
  final String subtitle;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            const BrandMark(compact: true),
            const Spacer(),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
              decoration: BoxDecoration(
                color: colors.primary.withValues(alpha: 0.10),
                borderRadius: BorderRadius.circular(20),
              ),
              child: Text(
                overline,
                style: TextStyle(
                  color: colors.primary,
                  fontSize: 12,
                  fontWeight: FontWeight.w900,
                ),
              ),
            ),
          ],
        ),
        const SizedBox(height: 30),
        Text(
          title,
          style: TextStyle(
            color: colors.onSurface,
            fontSize: 28,
            fontWeight: FontWeight.w900,
          ),
        ),
        const SizedBox(height: 7),
        Text(
          subtitle,
          style: TextStyle(color: colors.onSurfaceVariant, height: 1.5),
        ),
      ],
    );
  }
}

class _RegistrationFormHero extends StatelessWidget {
  const _RegistrationFormHero({required this.type, required this.onChange});

  final RegistrationAccountType type;
  final VoidCallback onChange;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final dark = Theme.of(context).brightness == Brightness.dark;
    return Container(
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        color: dark ? colors.surfaceContainerHighest : const Color(0xFF0B2345),
        borderRadius: BorderRadius.circular(16),
      ),
      child: Row(
        children: [
          Container(
            width: 52,
            height: 52,
            decoration: BoxDecoration(
              color: Colors.white.withValues(alpha: dark ? 0.10 : 0.14),
              borderRadius: BorderRadius.circular(14),
            ),
            child: Icon(type.icon, color: dark ? colors.primary : Colors.white),
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  type.title,
                  style: TextStyle(
                    color: dark ? colors.onSurface : Colors.white,
                    fontSize: 20,
                    fontWeight: FontWeight.w900,
                  ),
                ),
                const SizedBox(height: 3),
                Text(
                  type.subtitle,
                  style: TextStyle(
                    color: dark
                        ? colors.onSurfaceVariant
                        : Colors.white.withValues(alpha: 0.72),
                    fontSize: 12,
                  ),
                ),
              ],
            ),
          ),
          TextButton(
            onPressed: onChange,
            style: TextButton.styleFrom(
              foregroundColor: dark ? colors.primary : Colors.white,
            ),
            child: const Text('تغيير'),
          ),
        ],
      ),
    );
  }
}

class _RegistrationProgress extends StatelessWidget {
  const _RegistrationProgress({required this.currentStep});

  final int currentStep;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Row(
      children: [
        _RegistrationStep(
          number: 1,
          label: 'نوع الحساب',
          completed: currentStep > 1,
          active: currentStep == 1,
        ),
        Expanded(
          child: Container(
            height: 1,
            color: colors.primary.withValues(alpha: 0.35),
          ),
        ),
        _RegistrationStep(
          number: 2,
          label: 'البيانات',
          completed: false,
          active: currentStep == 2,
        ),
        Expanded(child: Container(height: 1, color: colors.outlineVariant)),
        _RegistrationStep(
          number: 3,
          label: 'المراجعة',
          completed: false,
          active: currentStep == 3,
        ),
      ],
    );
  }
}

class _RegistrationStep extends StatelessWidget {
  const _RegistrationStep({
    required this.number,
    required this.label,
    required this.completed,
    required this.active,
  });

  final int number;
  final String label;
  final bool completed;
  final bool active;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final highlighted = completed || active;
    return Column(
      children: [
        Container(
          width: 28,
          height: 28,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: highlighted ? colors.primary : colors.surface,
            shape: BoxShape.circle,
            border: Border.all(
              color: highlighted ? colors.primary : colors.outlineVariant,
            ),
          ),
          child: completed
              ? Icon(Icons.check_rounded, color: colors.onPrimary, size: 17)
              : Text(
                  '$number',
                  style: TextStyle(
                    color: highlighted
                        ? colors.onPrimary
                        : colors.onSurfaceVariant,
                    fontSize: 12,
                    fontWeight: FontWeight.w900,
                  ),
                ),
        ),
        const SizedBox(height: 5),
        Text(
          label,
          style: TextStyle(
            color: highlighted ? colors.onSurface : colors.onSurfaceVariant,
            fontSize: 10,
            fontWeight: FontWeight.w800,
          ),
        ),
      ],
    );
  }
}

class _RegistrationVerifiedAgent extends StatelessWidget {
  const _RegistrationVerifiedAgent({required this.name});

  final String name;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: const Color(0xFF00875A).withValues(alpha: 0.10),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(
          color: const Color(0xFF00875A).withValues(alpha: 0.35),
        ),
      ),
      child: Row(
        children: [
          const Icon(Icons.verified_rounded, color: Color(0xFF00875A)),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              'تم التحقق من الوكيل: $name',
              style: TextStyle(
                color: colors.onSurface,
                fontWeight: FontWeight.w800,
              ),
            ),
          ),
        ],
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

class _RoleShellState extends State<RoleShell> with WidgetsBindingObserver {
  late final List<_NavItem> _items;
  int _index = 0;
  Map<String, dynamic>? _executorOverview;

  @override
  void initState() {
    super.initState();
    _items = _createItems();
    if (widget.controller.isExecutor || widget.controller.isCustomerAccount) {
      WidgetsBinding.instance.addObserver(this);
      if (widget.controller.isExecutor) unawaited(_loadExecutorOverview());
      unawaited(ExecutorAlertService.instance.startForStoredAccount());
      unawaited(ExecutorAlertService.instance.setAppVisible(true));
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (!widget.controller.isExecutor && !widget.controller.isCustomerAccount) return;
    final visible = state == AppLifecycleState.resumed;
    unawaited(ExecutorAlertService.instance.setAppVisible(visible));
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
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
    if (widget.controller.isCustomerAccount) {
      return [
        _NavItem(
          'الحساب',
          Icons.account_balance_wallet_outlined,
          CustomerAccountScreen(
            controller: widget.controller,
            appearance: widget.appearance,
          ),
        ),
        _NavItem(
          'التحويلات',
          Icons.send_to_mobile_outlined,
          TransferScreen(controller: widget.controller),
        ),
        _NavItem(
          'أسعار الصرف',
          Icons.currency_exchange_outlined,
          ExchangeRatesScreen(controller: widget.controller),
        ),
        _NavItem(
          'التقارير',
          Icons.assessment_outlined,
          TransactionsScreen(controller: widget.controller),
        ),
        _NavItem(
          'الدعم الفني',
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
    if (approved == true && mounted) {
      await ExecutorAlertService.instance.stop();
      await widget.controller.signOut();
    }
  }

  @override
  Widget build(BuildContext context) {
    final selected = _items[_index];
    final isCustomerShell = widget.controller.isCustomerAccount;
    final session = widget.controller.session;
    final company = _executorOverview?['company'];
    final performance = _executorOverview?['myPerformance'];
    final companyName = company is Map
        ? '${company['name'] ?? widget.controller.session?.context['executorGroupName'] ?? ''}'
        : '${widget.controller.session?.context['executorGroupName'] ?? ''}';
    // The login response already carries the executor-group balance. Keep it
    // as a fallback while the live overview is loading or being retried.
    final canViewCompanyBalance =
        widget.controller.isExecutorManager ||
        widget.controller.isExecutorAccountant;
    final companyBalance = canViewCompanyBalance
        ? (company is Map
              ? numberValue(
                  company['balance'],
                  widget.controller.session?.balance ?? 0,
                )
              : widget.controller.session?.balance ?? 0)
        : 0.0;
    final ownPerformance = performance is Map
        ? numberValue(performance['totalEGP'])
        : 0;
    final executorSubtitle = widget.controller.isExecutorManager
        ? '$companyName · مدير تنفيذي'
        : (widget.controller.isExecutorAccountant
              ? '$companyName · محاسب تنفيذي'
              : '$companyName · تنفيذاتك اليوم ${formatEgpAmount(ownPerformance)} ج.م');
    final appBar = AppBar(
      toolbarHeight: 76,
      titleSpacing: isCustomerShell ? 12 : 18,
      bottom: PreferredSize(
        preferredSize: const Size.fromHeight(3),
        child: Row(
          children: const [
            Expanded(child: ColoredBox(color: AhramColors.sky)),
            Expanded(child: ColoredBox(color: AhramColors.gold)),
            Expanded(child: ColoredBox(color: AhramColors.emerald)),
          ],
        ),
      ),
      title: isCustomerShell
          ? CustomerShellHeader(balance: session?.balance ?? 0)
          : Row(
              children: [
                const BrandMark(compact: true),
                const SizedBox(width: 10),
                Expanded(
                  child: LayoutBuilder(
                    builder: (context, constraints) {
                      final compactHeader = constraints.maxWidth < 320;
                      if (widget.controller.isExecutor && compactHeader) {
                        return const SizedBox.shrink();
                      }
                      final title =
                          widget.controller.isExecutor && compactHeader
                          ? 'بوابة التنفيذ'
                          : (widget.controller.isExecutor
                                ? companyName
                                : selected.label);
                      final subtitle =
                          widget.controller.isExecutor && compactHeader
                          ? 'بوابة التنفيذ'
                          : (widget.controller.isExecutor
                                ? executorSubtitle
                                : '${widget.controller.session?.name ?? ''} · $_roleLabel');

                      return Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Text(
                            title,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(
                              fontWeight: FontWeight.w800,
                              color: Theme.of(context).colorScheme.onSurface,
                            ),
                          ),
                          Text(
                            subtitle,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(
                              fontSize: 11,
                              color: Theme.of(
                                context,
                              ).colorScheme.onSurfaceVariant,
                            ),
                          ),
                        ],
                      );
                    },
                  ),
                ),
              ],
            ),
      actions: [
        if (isCustomerShell)
          GlassIconButton(
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
        if (canViewCompanyBalance)
          ExecutorBalanceBadge(
            amount: companyBalance,
            label: widget.controller.isExecutorOperator
                ? 'رصيد التنفيذ'
                : 'رصيد المنفذ',
          ),
        if (widget.controller.isExecutor)
          GlassIconButton(
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
        GlassIconButton(
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
                    Container(
                      width: 232,
                      decoration: BoxDecoration(
                        color: Theme.of(context).colorScheme.surface,
                        border: Border(
                          left: BorderSide(
                            color: Theme.of(context).colorScheme.outlineVariant,
                          ),
                        ),
                      ),
                      child: NavigationRail(
                        extended: true,
                        minExtendedWidth: 232,
                        selectedIndex: _index,
                        onDestinationSelected: (next) =>
                            setState(() => _index = next),
                        labelType: NavigationRailLabelType.none,
                        backgroundColor: Colors.transparent,
                        leading: const Padding(
                          padding: EdgeInsets.fromLTRB(16, 18, 16, 22),
                          child: Align(
                            alignment: AlignmentDirectional.centerStart,
                            child: BrandMark(),
                          ),
                        ),
                        destinations: _items
                            .map(
                              (item) => NavigationRailDestination(
                                icon: GlassIconBadge(icon: item.icon),
                                selectedIcon: GlassIconBadge(
                                  icon: item.icon,
                                  selected: true,
                                ),
                                label: Text(item.label),
                              ),
                            )
                            .toList(),
                      ),
                    ),
                    Expanded(child: pages),
                  ],
                )
              : pages,
          bottomNavigationBar: desktop
              ? null
              : DecoratedBox(
                  decoration: BoxDecoration(
                    border: Border(
                      top: BorderSide(
                        color: Theme.of(context).colorScheme.outlineVariant,
                      ),
                    ),
                    boxShadow: [
                      BoxShadow(
                        color: _navy.withValues(alpha: 0.08),
                        blurRadius: 16,
                        offset: const Offset(0, -4),
                      ),
                    ],
                  ),
                  child: NavigationBar(
                    selectedIndex: _index,
                    onDestinationSelected: (next) =>
                        setState(() => _index = next),
                    destinations: _items
                        .map(
                          (item) => NavigationDestination(
                            icon: GlassIconBadge(icon: item.icon),
                            selectedIcon: GlassIconBadge(
                              icon: item.icon,
                              selected: true,
                            ),
                            label: item.label,
                          ),
                        )
                        .toList(),
                  ),
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

class CustomerShellHeader extends StatelessWidget {
  const CustomerShellHeader({super.key, required this.balance});

  final double balance;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final balanceColor = balance < 0
        ? _danger
        : balance > 0
        ? _green
        : colors.onSurfaceVariant;
    final dark = Theme.of(context).brightness == Brightness.dark;

    return SizedBox(
      height: 48,
      child: Row(
        children: [
          const BrandMark(compact: true),
          const Spacer(),
          Container(
            constraints: const BoxConstraints(minWidth: 86, maxWidth: 116),
            padding: const EdgeInsetsDirectional.fromSTEB(9, 6, 9, 6),
            decoration: BoxDecoration(
              color: balanceColor.withValues(alpha: dark ? 0.16 : 0.09),
              borderRadius: BorderRadius.circular(9),
              border: Border.all(color: balanceColor.withValues(alpha: 0.28)),
              boxShadow: [
                BoxShadow(
                  color: _navy.withValues(alpha: dark ? 0.18 : 0.08),
                  blurRadius: 9,
                  offset: const Offset(0, 4),
                ),
              ],
            ),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'الرصيد الحالي',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: colors.onSurfaceVariant,
                    fontSize: 9,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                const SizedBox(height: 1),
                Text(
                  '${formatAmount(balance)} د.ل',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  textDirection: ui.TextDirection.ltr,
                  style: TextStyle(
                    color: balanceColor,
                    fontSize: 13,
                    fontWeight: FontWeight.w900,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class CustomerAccountScreen extends StatefulWidget {
  const CustomerAccountScreen({
    super.key,
    required this.controller,
    required this.appearance,
  });

  final SessionController controller;
  final AppearanceController appearance;

  @override
  State<CustomerAccountScreen> createState() => _CustomerAccountScreenState();
}

class _CustomerAccountScreenState extends State<CustomerAccountScreen> {
  final ImagePicker _picker = ImagePicker();
  bool _uploadingPhoto = false;

  @override
  void initState() {
    super.initState();
    // Existing sessions may predate profile fields. Refresh the canonical
    // profile once when opening this screen instead of showing stale blanks.
    unawaited(_refresh());
  }

  Future<void> _refresh() => widget.controller.refreshHome();

  Future<void> _editProfile(Map<String, dynamic> profile) async {
    final saved = await showDialog<bool>(
      context: context,
      builder: (context) => _CustomerProfileEditDialog(
        controller: widget.controller,
        initialName: widget.controller.session?.name ?? '',
        initialAddress: '${profile['address'] ?? ''}',
        username: '${profile['username'] ?? ''}',
        phone: '${profile['phone'] ?? ''}',
      ),
    );
    if (saved == true && mounted) showSnack(context, 'تم تحديث بيانات الحساب.');
  }

  Future<void> _showDevices() async {
    await showDialog<void>(
      context: context,
      builder: (context) => _CustomerDevicesDialog(controller: widget.controller),
    );
  }

  Future<void> _changePassword() async {
    final changed = await showDialog<bool>(
      context: context,
      builder: (context) => _CustomerPasswordDialog(controller: widget.controller),
    );
    if (changed == true && mounted) {
      showSnack(context, 'تم تغيير كلمة المرور. سجّل الدخول بكلمة المرور الجديدة.');
    }
  }

  Future<void> _openSupport() async {
    final created = await showDialog<bool>(
      context: context,
      builder: (context) => TicketDialog(api: widget.controller.api),
    );
    if (created == true && mounted) showSnack(context, 'تم فتح تذكرة الدعم بنجاح.');
  }

  Future<void> _openWhatsAppSupport() async {
    final opened = await openExternalLink(
      Uri.parse('https://wa.me/201108172258'),
    );
    if (opened) return;
    await Clipboard.setData(const ClipboardData(text: '01108172258'));
    if (mounted) showSnack(context, 'تم نسخ رقم واتساب الدعم.', error: true);
  }

  Future<void> _showPolicy() async {
    await showDialog<void>(
      context: context,
      builder: (context) => const _CustomerUsagePolicyDialog(),
    );
  }

  Future<void> _setCustomerNotifications(bool enabled) async {
    await widget.controller.setCustomerNotificationsEnabled(enabled);
    if (enabled) {
      await ExecutorAlertService.instance.requestPermissionsAndStart();
    } else {
      await ExecutorAlertService.instance.stop();
    }
  }

  Future<void> _changePhoto() async {
    final image = await _picker.pickImage(
      source: ImageSource.gallery,
      imageQuality: 82,
      maxWidth: 900,
      maxHeight: 900,
    );
    if (image == null) return;

    final bytes = await image.readAsBytes();
    if (bytes.length > 2 * 1024 * 1024) {
      if (mounted) showSnack(context, 'اختر صورة أصغر من 2 ميجابايت.', error: true);
      return;
    }
    final extension = image.name.split('.').last.toLowerCase();
    final mime = switch (extension) {
      'png' => 'image/png',
      'webp' => 'image/webp',
      _ => 'image/jpeg',
    };

    setState(() => _uploadingPhoto = true);
    try {
      await widget.controller.updateCustomerProfilePhoto(
        'data:$mime;base64,${base64Encode(bytes)}',
      );
      if (mounted) showSnack(context, 'تم تحديث الصورة الشخصية.');
    } on ApiFailure catch (error) {
      if (mounted) showSnack(context, error.message, error: true);
    } finally {
      if (mounted) setState(() => _uploadingPhoto = false);
    }
  }

  String _value(Object? value, {String fallback = 'غير مسجل'}) {
    final text = '${value ?? ''}'.trim();
    return text.isEmpty ? fallback : text;
  }

  String _joinedAt(Object? value) {
    final parsed = DateTime.tryParse('${value ?? ''}');
    if (parsed == null) return 'غير مسجل';
    return 'انضم في ${DateFormat('d MMMM yyyy', 'ar').format(parsed.toLocal())}';
  }

  @override
  Widget build(BuildContext context) {
    final session = widget.controller.session!;
    final contextData = session.context;
    final profileRaw = contextData['profile'];
    final profile = profileRaw is Map
        ? Map<String, dynamic>.from(profileRaw)
        : <String, dynamic>{};
    final isAgentCustomer = session.accountType == 'sub_client' ||
        session.persona.toLowerCase() == 'agentclient';
    final agentName = _value(
      contextData['agentName'] ?? contextData['masterName'],
      fallback: 'غير مسجل',
    );
    final photoVersion = '${profile['photoUpdatedAt'] ?? ''}'.trim();
    final photoUrl = photoVersion.isEmpty
        ? null
        : '${widget.controller.api.baseUrl}/client/profile-photo?v=${Uri.encodeComponent(photoVersion)}';
    final accountCode = _value(contextData['accountCode'], fallback: '');
    final hasAccountCode = accountCode.isNotEmpty;
    final agencyCode = _value(contextData['agentCode'], fallback: '');
    final status = '${profile['status'] ?? 'active'}'.toLowerCase();
    final isActive = status == 'active';
    final statusColor = isActive ? _green : _danger;

    return PageFrame(
      title: 'الحساب',
      subtitle: 'ملفك الشخصي وبيانات حسابك في الأهرام.',
      onRefresh: _refresh,
      child: [
        SurfacePanel(
          child: Column(
            children: [
              Stack(
                clipBehavior: Clip.none,
                children: [
                  Container(
                    width: 112,
                    height: 112,
                    padding: const EdgeInsets.all(3),
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      border: Border.all(
                        color: _green.withValues(alpha: 0.42),
                        width: 2,
                      ),
                      boxShadow: [
                        BoxShadow(
                          color: _navy.withValues(alpha: 0.14),
                          blurRadius: 18,
                          offset: const Offset(0, 9),
                        ),
                      ],
                    ),
                    child: ClipOval(
                      child: photoUrl == null
                          ? Container(
                              color: _green.withValues(alpha: 0.10),
                              child: const Icon(
                                Icons.person_outline,
                                color: _green,
                                size: 55,
                              ),
                            )
                          : Image.network(
                              photoUrl,
                              fit: BoxFit.cover,
                              headers: <String, String>{
                                'Authorization': 'Bearer ${session.token}',
                              },
                              errorBuilder: (_, _, _) => Container(
                                color: _green.withValues(alpha: 0.10),
                                child: const Icon(
                                  Icons.person_outline,
                                  color: _green,
                                  size: 55,
                                ),
                              ),
                            ),
                    ),
                  ),
                  PositionedDirectional(
                    bottom: -5,
                    end: -5,
                    child: Material(
                      color: Colors.transparent,
                      child: InkWell(
                        onTap: _uploadingPhoto ? null : _changePhoto,
                        customBorder: const CircleBorder(),
                        child: Ink(
                          width: 42,
                          height: 42,
                          decoration: BoxDecoration(
                            color: _green,
                            shape: BoxShape.circle,
                            border: Border.all(
                              color: Theme.of(context).colorScheme.surface,
                              width: 3,
                            ),
                          ),
                          child: _uploadingPhoto
                              ? const Padding(
                                  padding: EdgeInsets.all(11),
                                  child: CircularProgressIndicator(
                                    strokeWidth: 2,
                                    color: Colors.white,
                                  ),
                                )
                              : const Icon(
                                  Icons.camera_alt_outlined,
                                  color: Colors.white,
                                  size: 20,
                                ),
                        ),
                      ),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 18),
              Text(
                session.name,
                textAlign: TextAlign.center,
                style: Theme.of(context).textTheme.titleLarge?.copyWith(
                  fontWeight: FontWeight.w900,
                ),
              ),
              const SizedBox(height: 8),
              Container(
                padding: const EdgeInsetsDirectional.fromSTEB(10, 6, 10, 6),
                decoration: BoxDecoration(
                  color: statusColor.withValues(alpha: 0.10),
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(color: statusColor.withValues(alpha: 0.25)),
                ),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Icon(
                      isActive
                          ? Icons.check_circle_outline
                          : Icons.pause_circle_outline,
                      color: statusColor,
                      size: 18,
                    ),
                    const SizedBox(width: 6),
                    Text(
                      isActive ? 'حساب نشط' : 'حساب معلق',
                      style: TextStyle(color: statusColor, fontWeight: FontWeight.w800),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 14),
              OutlinedButton.icon(
                onPressed: () => _editProfile(profile),
                icon: const Icon(Icons.edit_outlined),
                label: const Text('تعديل البيانات'),
              ),
            ],
          ),
        ),
        const SizedBox(height: 14),
        _CustomerProfileSection(
          title: 'بيانات العميل',
          icon: Icons.badge_outlined,
          children: [
            _CustomerProfileRow(
              icon: Icons.person_outline,
              label: 'اسم العميل',
              value: session.name,
            ),
            _CustomerProfileRow(
              icon: Icons.phone_outlined,
              label: 'رقم الهاتف',
              value: _value(profile['phone']),
              ltr: true,
            ),
            _CustomerProfileRow(
              icon: Icons.location_on_outlined,
              label: 'العنوان',
              value: _value(profile['address']),
              last: true,
            ),
          ],
        ),
        const SizedBox(height: 14),
        _CustomerProfileSection(
          title: 'بيانات الحساب',
          icon: Icons.account_balance_wallet_outlined,
          children: [
            _CustomerProfileRow(
              icon: Icons.alternate_email_outlined,
              label: 'اسم المستخدم',
              value: _value(profile['username']),
              ltr: true,
            ),
            _CustomerProfileRow(
              icon: Icons.groups_2_outlined,
              label: 'نوع الحساب',
              value: isAgentCustomer ? 'عميل وكيل' : 'عميل مباشر',
            ),
            _CustomerProfileRow(
              icon: Icons.account_balance_outlined,
              label: isAgentCustomer ? 'الوكيل' : 'الجهة المسؤولة',
              value: isAgentCustomer ? agentName : 'شركة الأهرام',
            ),
            if (isAgentCustomer && agencyCode.isNotEmpty)
              _CustomerProfileRow(
                icon: Icons.numbers_outlined,
                label: 'رقم حساب الوكالة',
                value: agencyCode,
                copyable: true,
                ltr: true,
              ),
            _CustomerProfileRow(
              icon: Icons.calendar_month_outlined,
              label: 'تاريخ الانضمام',
              value: _joinedAt(profile['joinedAt']),
              ltr: true,
              last: !hasAccountCode,
            ),
            if (hasAccountCode)
              _CustomerProfileRow(
                icon: Icons.content_copy_outlined,
                label: 'رمز الحساب',
                value: accountCode,
                copyable: true,
                ltr: true,
                last: true,
              ),
          ],
        ),
        const SizedBox(height: 14),
        if (isAgentCustomer) ...[
          _CustomerCreditSummary(session: session),
          const SizedBox(height: 14),
        ],
        _CustomerProfileSection(
          title: 'الأمان',
          icon: Icons.shield_outlined,
          children: [
            _CustomerActionRow(
              icon: Icons.lock_reset_outlined,
              title: 'تغيير كلمة المرور',
              subtitle: 'سيتم تسجيل خروجك من كل الأجهزة بعد التغيير.',
              onTap: _changePassword,
            ),
            _CustomerActionRow(
              icon: Icons.devices_outlined,
              title: 'الأجهزة المسجل منها الدخول',
              subtitle: 'عرض آخر الأجهزة التي سجلت الدخول إلى الحساب.',
              onTap: _showDevices,
            ),
            _CustomerActionRow(
              icon: Icons.logout_outlined,
              title: 'تسجيل الخروج من كل الأجهزة',
              subtitle: 'إبطال الأجهزة الأخرى مع بقاء الجهاز الحالي نشطاً.',
              color: _danger,
              last: true,
              onTap: _showDevices,
            ),
          ],
        ),
        const SizedBox(height: 14),
        _CustomerProfileSection(
          title: 'التفضيلات',
          icon: Icons.tune_outlined,
          children: [
            _CustomerPreferenceRow(
              icon: widget.appearance.isDark
                  ? Icons.dark_mode_outlined
                  : Icons.light_mode_outlined,
              title: 'الوضع الليلي',
              subtitle: 'ألوان مريحة للقراءة في الإضاءة المنخفضة.',
              value: widget.appearance.isDark,
              onChanged: (_) => widget.appearance.toggle(),
            ),
            _CustomerPreferenceRow(
              icon: Icons.notifications_active_outlined,
              title: 'إشعارات التطبيق',
              subtitle: 'تنبيهات العمليات وردود الدعم على هذا الجهاز.',
              value: widget.controller.customerNotificationsEnabled,
              onChanged: (value) => unawaited(_setCustomerNotifications(value)),
            ),
            const _CustomerActionRow(
              icon: Icons.language_outlined,
              title: 'لغة التطبيق',
              subtitle: 'العربية',
              trailing: Icon(Icons.lock_outline, size: 19),
              last: true,
            ),
          ],
        ),
        const SizedBox(height: 14),
        _CustomerProfileSection(
          title: 'الدعم',
          icon: Icons.support_agent_outlined,
          children: [
            _CustomerActionRow(
              icon: Icons.chat_outlined,
              title: 'فتح محادثة دعم',
              subtitle: 'أرسل طلبك مباشرة إلى فريق الدعم.',
              onTap: _openSupport,
            ),
            _CustomerActionRow(
              icon: Icons.chat_bubble_outline,
              title: 'واتساب الدعم',
              subtitle: '01108172258 - واتساب فقط',
              onTap: _openWhatsAppSupport,
            ),
            _CustomerActionRow(
              icon: Icons.policy_outlined,
              title: 'سياسة الاستخدام',
              subtitle: 'خصوصية الحساب ومسؤولية إدخال البيانات.',
              last: true,
              onTap: _showPolicy,
            ),
          ],
        ),
      ],
    );
  }
}

class _CustomerProfileSection extends StatelessWidget {
  const _CustomerProfileSection({
    required this.title,
    required this.icon,
    required this.children,
  });

  final String title;
  final IconData icon;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    return SurfacePanel(
      child: Column(
        children: [
          Row(
            children: [
              Container(
                width: 38,
                height: 38,
                decoration: BoxDecoration(
                  color: _green.withValues(alpha: 0.10),
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Icon(icon, color: _green, size: 21),
              ),
              const SizedBox(width: 10),
              Text(
                title,
                style: Theme.of(context).textTheme.titleMedium?.copyWith(
                  fontWeight: FontWeight.w900,
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          ...children,
        ],
      ),
    );
  }
}

class _CustomerProfileRow extends StatelessWidget {
  const _CustomerProfileRow({
    required this.icon,
    required this.label,
    required this.value,
    this.copyable = false,
    this.ltr = false,
    this.last = false,
  });

  final IconData icon;
  final String label;
  final String value;
  final bool copyable;
  final bool ltr;
  final bool last;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Column(
      children: [
        ListTile(
          dense: true,
          contentPadding: EdgeInsets.zero,
          minVerticalPadding: 8,
          leading: Icon(icon, color: colors.primary, size: 22),
          title: Text(
            label,
            style: TextStyle(
              color: colors.onSurfaceVariant,
              fontSize: 12,
              fontWeight: FontWeight.w700,
            ),
          ),
          subtitle: Text(
            value,
            textDirection: ltr ? ui.TextDirection.ltr : ui.TextDirection.rtl,
            style: TextStyle(
              color: colors.onSurface,
              fontSize: 15,
              fontWeight: FontWeight.w800,
            ),
          ),
          trailing: copyable
              ? IconButton(
                  tooltip: 'نسخ رمز الحساب',
                  onPressed: () {
                    Clipboard.setData(ClipboardData(text: value));
                    showSnack(context, 'تم نسخ رمز الحساب.');
                  },
                  icon: const Icon(Icons.copy_outlined),
                )
              : null,
        ),
        if (!last) const Divider(height: 1),
      ],
    );
  }
}

class _CustomerCreditSummary extends StatelessWidget {
  const _CustomerCreditSummary({required this.session});

  final MobileSession session;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final available = session.availableToSpend ?? session.balance;
    final limit = session.creditLimit ?? 0;
    return SurfacePanel(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const SectionTitle(
            title: 'الرصيد والحد الائتماني',
            icon: Icons.account_balance_wallet_outlined,
          ),
          const SizedBox(height: 12),
          Row(
            children: [
              Expanded(
                child: _CustomerMoneyMetric(
                  label: 'الرصيد المتاح',
                  value: available,
                  color: available < 0 ? _danger : _green,
                ),
              ),
              Container(width: 1, height: 48, color: colors.outlineVariant),
              Expanded(
                child: _CustomerMoneyMetric(
                  label: 'الحد الائتماني',
                  value: limit,
                  color: _gold,
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _CustomerMoneyMetric extends StatelessWidget {
  const _CustomerMoneyMetric({
    required this.label,
    required this.value,
    required this.color,
  });

  final String label;
  final double value;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Text(
          label,
          style: Theme.of(context).textTheme.labelMedium?.copyWith(
            color: Theme.of(context).colorScheme.onSurfaceVariant,
          ),
        ),
        const SizedBox(height: 5),
        Text(
          '${formatAmount(value)} د.ل',
          textDirection: ui.TextDirection.ltr,
          style: TextStyle(color: color, fontWeight: FontWeight.w900),
        ),
      ],
    );
  }
}

class _CustomerActionRow extends StatelessWidget {
  const _CustomerActionRow({
    required this.icon,
    required this.title,
    required this.subtitle,
    this.color,
    this.trailing,
    this.last = false,
    this.onTap,
  });

  final IconData icon;
  final String title;
  final String subtitle;
  final Color? color;
  final Widget? trailing;
  final bool last;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final rowColor = color ?? Theme.of(context).colorScheme.primary;
    return Column(
      children: [
        ListTile(
          contentPadding: EdgeInsets.zero,
          leading: Icon(icon, color: rowColor),
          title: Text(title, style: const TextStyle(fontWeight: FontWeight.w800)),
          subtitle: Text(subtitle),
          trailing: trailing ?? (onTap == null ? null : const Icon(Icons.chevron_left)),
          onTap: onTap,
        ),
        if (!last) const Divider(height: 1),
      ],
    );
  }
}

class _CustomerPreferenceRow extends StatelessWidget {
  const _CustomerPreferenceRow({
    required this.icon,
    required this.title,
    required this.subtitle,
    required this.value,
    required this.onChanged,
  });

  final IconData icon;
  final String title;
  final String subtitle;
  final bool value;
  final ValueChanged<bool> onChanged;

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        SwitchListTile.adaptive(
          contentPadding: EdgeInsets.zero,
          secondary: Icon(icon, color: Theme.of(context).colorScheme.primary),
          title: Text(title, style: const TextStyle(fontWeight: FontWeight.w800)),
          subtitle: Text(subtitle),
          value: value,
          onChanged: onChanged,
        ),
        const Divider(height: 1),
      ],
    );
  }
}

class _CustomerProfileEditDialog extends StatefulWidget {
  const _CustomerProfileEditDialog({
    required this.controller,
    required this.initialName,
    required this.initialAddress,
    required this.username,
    required this.phone,
  });

  final SessionController controller;
  final String initialName;
  final String initialAddress;
  final String username;
  final String phone;

  @override
  State<_CustomerProfileEditDialog> createState() => _CustomerProfileEditDialogState();
}

class _CustomerProfileEditDialogState extends State<_CustomerProfileEditDialog> {
  late final TextEditingController _name = TextEditingController(text: widget.initialName);
  late final TextEditingController _address = TextEditingController(text: widget.initialAddress);
  final _formKey = GlobalKey<FormState>();
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _name.dispose();
    _address.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    if (!_formKey.currentState!.validate()) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await widget.controller.updateCustomerProfile(
        name: _name.text.trim(),
        address: _address.text.trim(),
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
      title: const Text('تعديل بيانات الحساب'),
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
                  decoration: const InputDecoration(labelText: 'الاسم الثلاثي'),
                  validator: (value) => (value ?? '').trim().length < 3
                      ? 'اكتب الاسم الثلاثي.'
                      : null,
                ),
                const SizedBox(height: 12),
                TextFormField(
                  controller: _address,
                  maxLength: 200,
                  decoration: const InputDecoration(labelText: 'العنوان'),
                ),
                const SizedBox(height: 6),
                TextFormField(
                  initialValue: widget.phone,
                  enabled: false,
                  textDirection: ui.TextDirection.ltr,
                  decoration: const InputDecoration(
                    labelText: 'رقم الهاتف',
                    helperText: 'لتعديل الرقم يرجى تقديم طلب رسمي للدعم.',
                  ),
                ),
                const SizedBox(height: 12),
                TextFormField(
                  initialValue: widget.username,
                  enabled: false,
                  textDirection: ui.TextDirection.ltr,
                  decoration: const InputDecoration(labelText: 'اسم المستخدم'),
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
          child: Text(_busy ? 'جارٍ الحفظ...' : 'حفظ التعديل'),
        ),
      ],
    );
  }
}

class _CustomerPasswordDialog extends StatefulWidget {
  const _CustomerPasswordDialog({required this.controller});

  final SessionController controller;

  @override
  State<_CustomerPasswordDialog> createState() => _CustomerPasswordDialogState();
}

class _CustomerPasswordDialogState extends State<_CustomerPasswordDialog> {
  final _formKey = GlobalKey<FormState>();
  final _current = TextEditingController();
  final _next = TextEditingController();
  final _confirm = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _current.dispose();
    _next.dispose();
    _confirm.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    if (!_formKey.currentState!.validate()) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await widget.controller.changeCustomerPassword(
        currentPassword: _current.text,
        newPassword: _next.text,
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
      title: const Text('تغيير كلمة المرور'),
      content: SizedBox(
        width: 420,
        child: Form(
          key: _formKey,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              TextFormField(
                controller: _current,
                obscureText: true,
                decoration: const InputDecoration(labelText: 'كلمة المرور الحالية'),
                validator: (value) => (value ?? '').isEmpty ? 'هذا الحقل مطلوب.' : null,
              ),
              const SizedBox(height: 12),
              TextFormField(
                controller: _next,
                obscureText: true,
                decoration: const InputDecoration(labelText: 'كلمة المرور الجديدة'),
                validator: (value) => (value ?? '').length < 8
                    ? 'يجب أن تتكون كلمة المرور من 8 أحرف على الأقل.'
                    : null,
              ),
              const SizedBox(height: 12),
              TextFormField(
                controller: _confirm,
                obscureText: true,
                decoration: const InputDecoration(labelText: 'تأكيد كلمة المرور الجديدة'),
                validator: (value) => value != _next.text ? 'كلمتا المرور غير متطابقتين.' : null,
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
          child: Text(_busy ? 'جارٍ الحفظ...' : 'تغيير كلمة المرور'),
        ),
      ],
    );
  }
}

class _CustomerDevicesDialog extends StatefulWidget {
  const _CustomerDevicesDialog({required this.controller});

  final SessionController controller;

  @override
  State<_CustomerDevicesDialog> createState() => _CustomerDevicesDialogState();
}

class _CustomerDevicesDialogState extends State<_CustomerDevicesDialog> {
  late final Future<List<Map<String, dynamic>>> _devices =
      widget.controller.customerSecurityDevices();
  bool _endingOtherDevices = false;

  Future<void> _endOtherDevices() async {
    setState(() => _endingOtherDevices = true);
    try {
      await widget.controller.logoutCustomerDevices();
      if (mounted) Navigator.pop(context, true);
    } on ApiFailure catch (error) {
      if (mounted) showSnack(context, error.message, error: true);
    } finally {
      if (mounted) setState(() => _endingOtherDevices = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('الأجهزة المسجل منها الدخول'),
      content: SizedBox(
        width: 460,
        child: FutureBuilder<List<Map<String, dynamic>>>(
          future: _devices,
          builder: (context, snapshot) {
            if (snapshot.connectionState != ConnectionState.done) {
              return const SizedBox(height: 120, child: Center(child: CircularProgressIndicator()));
            }
            if (snapshot.hasError) {
              return const Text('تعذر تحميل قائمة الأجهزة حالياً.');
            }
            final devices = snapshot.data ?? const <Map<String, dynamic>>[];
            if (devices.isEmpty) {
              return const Text('لا توجد عمليات دخول مسجلة بعد.');
            }
            return ConstrainedBox(
              constraints: const BoxConstraints(maxHeight: 360),
              child: ListView.separated(
                shrinkWrap: true,
                itemCount: devices.length,
                separatorBuilder: (_, _) => const Divider(height: 1),
                itemBuilder: (context, index) {
                  final device = devices[index];
                  return ListTile(
                    contentPadding: EdgeInsets.zero,
                    leading: const Icon(Icons.devices_other_outlined),
                    title: Text(
                      device['current'] == true
                          ? '${device['deviceType'] ?? 'هاتف'} - الجهاز الحالي'
                          : '${device['deviceType'] ?? 'هاتف'}',
                    ),
                    subtitle: Text(
                      'آخر دخول: ${formatDate(device['lastSeenAt'])}',
                    ),
                  );
                },
              ),
            );
          },
        ),
      ),
      actions: [
        OutlinedButton.icon(
          style: OutlinedButton.styleFrom(foregroundColor: _danger),
          onPressed: _endingOtherDevices ? null : _endOtherDevices,
          icon: const Icon(Icons.devices_other_outlined),
          label: Text(_endingOtherDevices ? 'جارٍ الإنهاء...' : 'إنهاء الأجهزة الأخرى'),
        ),
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('إغلاق'),
        ),
      ],
    );
  }
}

class _CustomerUsagePolicyDialog extends StatelessWidget {
  const _CustomerUsagePolicyDialog();

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Row(
        children: [
          Icon(Icons.policy_outlined, color: _green),
          SizedBox(width: 10),
          Text('سياسة استخدام Ahram Pay'),
        ],
      ),
      content: const SizedBox(
        width: 480,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'آخر تحديث: 14 أغسطس 2026',
                style: TextStyle(color: Colors.grey, fontSize: 12),
              ),
              SizedBox(height: 14),
              _UsagePolicySection(
                title: 'استخدام الحساب',
                body: 'الحساب شخصي ومخصص لصاحبه المسجل فقط. يجب الحفاظ على صحة الاسم ورقم الهاتف والعنوان وإبلاغ الدعم عند أي تغيير رسمي.',
              ),
              _UsagePolicySection(
                title: 'حماية البيانات',
                body: 'لا تشارك اسم المستخدم أو كلمة المرور أو رمز التحقق مع أي شخص. يحق للنظام إنهاء الجلسات أو تعليق الحساب عند الاشتباه في استخدام غير مصرح به.',
              ),
              _UsagePolicySection(
                title: 'التحويلات المالية',
                body: 'يتحمل العميل مسؤولية مراجعة رقم المستلم والقيمة والخدمة قبل الإرسال. تظهر العملية في السجل بعد استلامها، وأي إلغاء أو استرجاع يخضع لحالة التنفيذ وقواعد الخدمة.',
              ),
              _UsagePolicySection(
                title: 'الإشعارات والدعم',
                body: 'يستخدم التطبيق الإشعارات لإبلاغك بالإيداعات والعمليات وردود الدعم. يمكن إيقافها من التفضيلات، بينما تظل التفاصيل الكاملة متاحة داخل الحساب.',
              ),
              _UsagePolicySection(
                title: 'التواصل الرسمي',
                body: 'للدعم استخدم تذاكر التطبيق أو رقم واتساب الدعم الظاهر في الحساب. لا يعتمد أي طلب لتعديل رقم الهاتف أو اسم المستخدم إلا بعد مراجعة رسمية من الإدارة.',
              ),
            ],
          ),
        ),
      ),
      actions: [
        FilledButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('فهمت'),
        ),
      ],
    );
  }
}

class _UsagePolicySection extends StatelessWidget {
  const _UsagePolicySection({required this.title, required this.body});

  final String title;
  final String body;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 13),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(title, style: const TextStyle(fontWeight: FontWeight.w900)),
          const SizedBox(height: 4),
          Text(body, style: const TextStyle(height: 1.55)),
        ],
      ),
    );
  }
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
    return PageFrame(
      title: widget.controller.isCustomerAccount
          ? 'الحساب'
          : (widget.controller.isCompany ? 'ملخص الشركة' : 'ملخص الحساب'),
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
      ],
    );
  }
}

class ExchangeRatesScreen extends StatefulWidget {
  const ExchangeRatesScreen({super.key, required this.controller});

  final SessionController controller;

  @override
  State<ExchangeRatesScreen> createState() => _ExchangeRatesScreenState();
}

class _ExchangeRatesScreenState extends State<ExchangeRatesScreen> {
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
      final home = await widget.controller.refreshHome();
      if (mounted) setState(() => _home = home);
    } catch (error) {
      if (mounted) setState(() => _error = error);
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
      title: 'أسعار الصرف',
      subtitle: 'الأسعار المطبقة على حسابك عند إرسال التحويل.',
      onRefresh: _load,
      child: [
        if (rates.isEmpty)
          const EmptyPanel(
            icon: Icons.currency_exchange_outlined,
            title: 'لا توجد أسعار متاحة حالياً',
            message: 'اسحب الصفحة للتحديث أو تواصل مع الدعم الفني.',
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
  final _clientPhone = TextEditingController();
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
    _clientPhone.dispose();
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
      if (_clientPhone.text.trim().isNotEmpty)
        'clientPhone': _clientPhone.text.trim(),
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
        _clientPhone.clear();
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
              TextFormField(
                controller: _clientPhone,
                enabled: !_busy,
                keyboardType: TextInputType.phone,
                textDirection: ui.TextDirection.ltr,
                decoration: const InputDecoration(
                  labelText: 'رقم واتساب العميل (اختياري)',
                  hintText: '09xxxxxxxx أو 01xxxxxxxxx',
                  helperText: 'يرسل الإيصال إلى هذا الرقم بعد نجاح العملية.',
                  prefixIcon: Icon(Icons.chat_outlined),
                ),
                validator: (value) {
                  final phone = (value ?? '').trim();
                  if (phone.isEmpty) return null;
                  final digits = phone.replaceAll(RegExp(r'\D'), '');
                  final isLibyan = RegExp(r'^09\d{8}$').hasMatch(digits);
                  final isEgyptian = RegExp(r'^01\d{9}$').hasMatch(digits);
                  if (!isLibyan && !isEgyptian && digits.length < 8) {
                    return 'أدخل رقمًا ليبيًا يبدأ بـ 09 أو مصريًا يبدأ بـ 01.';
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
                  value:
                      '${formatEgpAmount(numberValue(detail['amount']))} ج.م',
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
      title: widget.controller.isCustomerAccount
          ? 'تقارير التحويلات'
          : (widget.controller.hidesBalance ? 'عمليات اليوم' : 'سجل العمليات'),
      subtitle: widget.controller.hidesBalance
          ? 'تظهر العمليات المسجلة اليوم فقط وفقاً لصلاحيات الحساب.'
          : (widget.controller.isCustomerAccount
                ? 'سجل عمليات حسابك وتحويلاتك المسجلة.'
                : 'آخر العمليات المنفذة أو قيد المعالجة في حسابك.'),
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
  Timer? _urgentToneTimer;
  List<Map<String, dynamic>> _tasks = <Map<String, dynamic>>[];
  List<Map<String, dynamic>> _urgentAlerts = <Map<String, dynamic>>[];
  final Set<String> _seenTaskIds = <String>{};
  final Set<String> _silencedUrgentAlertIds = <String>{};
  final Set<String> _presentedUrgentAlertIds = <String>{};
  bool _receivedInitialSnapshot = false;
  bool _loading = true;
  Object? _error;
  bool _actionBusy = false;
  bool _urgentAlarmPlaying = false;
  bool _manualTaskRoutingEnabled = false;
  Map<String, dynamic>? _overview;
  DateTime? _lastUpdated;

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
    _urgentToneTimer?.cancel();
    super.dispose();
  }

  Future<void> _playUrgentTone() async {
    await SystemSound.play(SystemSoundType.alert);
    await HapticFeedback.heavyImpact();
  }

  void _startUrgentAlarm() {
    if (_urgentAlarmPlaying) return;
    _urgentAlarmPlaying = true;
    unawaited(_playUrgentTone());
    _urgentToneTimer = Timer.periodic(const Duration(seconds: 2), (_) {
      unawaited(_playUrgentTone());
    });
  }

  void _stopUrgentAlarm() {
    _urgentToneTimer?.cancel();
    _urgentToneTimer = null;
    _urgentAlarmPlaying = false;
  }

  void _syncUrgentAlerts(List<Map<String, dynamic>> alerts) {
    final wasPlaying = _urgentAlarmPlaying;
    final activeIds = alerts
        .map((alert) => '${alert['id'] ?? ''}')
        .where((id) => id.isNotEmpty)
        .toSet();
    _silencedUrgentAlertIds.retainAll(activeIds);
    _presentedUrgentAlertIds.retainAll(activeIds);
    final hasAudibleAlert = activeIds.any(
      (id) => !_silencedUrgentAlertIds.contains(id),
    );
    if (hasAudibleAlert) {
      _startUrgentAlarm();
    } else {
      _stopUrgentAlarm();
    }
    if (mounted && wasPlaying != _urgentAlarmPlaying) {
      setState(() {});
    }
  }

  void _showNewUrgentAlertDialog(List<Map<String, dynamic>> alerts) {
    if (!mounted) return;
    Map<String, dynamic>? nextAlert;
    for (final alert in alerts) {
      final id = '${alert['id'] ?? ''}'.trim();
      if (id.isNotEmpty && !_presentedUrgentAlertIds.contains(id)) {
        nextAlert = alert;
        _presentedUrgentAlertIds.add(id);
        break;
      }
    }
    if (nextAlert == null) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      unawaited(
        showDialog<void>(
          context: context,
          barrierDismissible: false,
          builder: (dialogContext) => ExecutorUrgentAlertDialog(
            alert: nextAlert!,
            onStop: _silenceUrgentAlerts,
            onReview: () async {
              Navigator.of(dialogContext).pop();
              await _clearUrgentAlert(nextAlert!);
            },
            onClose: () => Navigator.of(dialogContext).pop(),
          ),
        ),
      );
    });
  }

  void _silenceUrgentAlerts() {
    setState(() {
      _silencedUrgentAlertIds.addAll(
        _urgentAlerts
            .map((alert) => '${alert['id'] ?? ''}')
            .where((id) => id.isNotEmpty),
      );
      _stopUrgentAlarm();
    });
  }

  Future<void> _clearUrgentAlert(Map<String, dynamic> alert) async {
    final id = '${alert['id'] ?? ''}'.trim();
    if (id.isEmpty) return;
    setState(() => _actionBusy = true);
    try {
      await widget.controller.api.clearExecutorEmergencyAlert(id);
      if (mounted) showSnack(context, 'تمت مراجعة إنذار الاستعجال.');
      await _load(silent: true);
    } on ApiFailure catch (error) {
      if (mounted) showSnack(context, error.message, error: true);
    } finally {
      if (mounted) setState(() => _actionBusy = false);
    }
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
      if (!silent || _overview == null) {
        final overviewResponse = await widget.controller.api.executorOverview();
        final overviewData = overviewResponse['data'];
        if (overviewData is Map) {
          _overview = Map<String, dynamic>.from(overviewData);
        }
      }
      final raw = response['data'];
      final tasks = raw is List
          ? raw
                .whereType<Map>()
                .map((item) => Map<String, dynamic>.from(item))
                .toList()
          : <Map<String, dynamic>>[];
      final rawAlerts = response['alerts'];
      final manualTaskRoutingEnabled =
          response['manualTaskRoutingEnabled'] == true;
      final urgentAlerts = rawAlerts is List
          ? rawAlerts
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
      if (mounted) {
        setState(() {
          _tasks = tasks;
          _urgentAlerts = urgentAlerts;
          _manualTaskRoutingEnabled = manualTaskRoutingEnabled;
          _lastUpdated = DateTime.now();
        });
        _syncUrgentAlerts(urgentAlerts);
        _showNewUrgentAlertDialog(urgentAlerts);
      }
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
      await _load(silent: true);
    } finally {
      if (mounted) setState(() => _actionBusy = false);
    }
  }

  Future<void> _routeTask(Map<String, dynamic> task) async {
    setState(() => _actionBusy = true);
    try {
      final candidates = await widget.controller.api.executorRouteCandidates();
      if (!mounted) return;
      if (candidates.isEmpty) {
        showSnack(
          context,
          'لا يوجد موظف تنفيذ نشط يمكن توجيه العملية إليه.',
          error: true,
        );
        return;
      }
      final employee = await showModalBottomSheet<Map<String, dynamic>>(
        context: context,
        showDragHandle: true,
        builder: (sheetContext) => SafeArea(
          child: ListView(
            shrinkWrap: true,
            children: [
              const ListTile(
                title: Text(
                  'توجيه العملية',
                  style: TextStyle(fontWeight: FontWeight.w900),
                ),
                subtitle: Text('اختر المنفذ الذي ستظهر له العملية.'),
              ),
              ...candidates.map(
                (candidate) => ListTile(
                  leading: const Icon(Icons.person_outline),
                  title: Text('${candidate['name'] ?? 'منفذ'}'),
                  subtitle: Text(
                    '${candidate['webUsername'] ?? candidate['phone'] ?? ''}',
                  ),
                  onTap: () => Navigator.of(sheetContext).pop(candidate),
                ),
              ),
            ],
          ),
        ),
      );
      if (employee == null) return;
      await widget.controller.api.routeExecutorTask(
        taskId: '${task['id']}',
        employeeId: '${employee['_id']}',
      );
      if (mounted) {
        showSnack(
          context,
          'تم توجيه العملية إلى ${employee['name'] ?? 'المنفذ'}',
        );
      }
      await _load(silent: true);
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

  Future<void> _shareToWhatsApp(Map<String, dynamic> task) async {
    final phone = '${task['recipientNumber'] ?? '-'}';
    final amount = formatEgpAmount(numberValue(task['amount']));
    final service =
        '${task['transferTypeLabel'] ?? serviceLabel(task['transferType']?.toString())}';
    final note = '${task['notes'] ?? ''}'.trim();
    final message = StringBuffer('شركة الأهرام\n')
      ..writeln('طلب تنفيذ: ${task['txId'] ?? '-'}')
      ..writeln('الخدمة: $service')
      ..writeln('رقم الهاتف: $phone')
      ..writeln('القيمة: $amount ج.م');
    if (note.isNotEmpty) message.writeln('ملاحظة العميل: $note');

    final shareUri = Uri.https('wa.me', '/', <String, String>{
      'text': message.toString().trim(),
    });
    try {
      final launched = await openExternalLink(shareUri);
      if (!launched) throw StateError('WhatsApp is unavailable');
    } catch (_) {
      await Clipboard.setData(ClipboardData(text: message.toString().trim()));
      if (mounted) {
        showSnack(context, 'تعذر فتح واتساب؛ تم نسخ رسالة التنفيذ الجاهزة.');
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_loading && _tasks.isEmpty) return const PageLoading();
    if (_error != null && _tasks.isEmpty) {
      return ErrorPage(error: _error!, onRetry: _load);
    }
    final canViewCompanyBalance = widget.controller.isExecutorManager;
    final currentExecutorId = widget.controller.session?.id ?? '';
    final hasAcceptedTask = _tasks.any(
      (task) =>
          task['status'] == 'accepted' &&
          (task['isOwnedByCurrentExecutor'] == true ||
              task['operatorId']?.toString() == currentExecutorId),
    );
    return PageFrame(
      title: 'مهام التنفيذ',
      subtitle: 'يتم تحديث المهام الجديدة تلقائياً كل خمس ثوانٍ.',
      showHeading: false,
      onRefresh: _load,
      child: [
        if (_urgentAlerts.isNotEmpty) ...[
          ..._urgentAlerts.map(
            (alert) => Padding(
              padding: const EdgeInsets.only(bottom: 12),
              child: ExecutorUrgentAlertCard(
                alert: alert,
                alarmPlaying: _urgentAlarmPlaying,
                busy: _actionBusy,
                onStop: _silenceUrgentAlerts,
                onReview: () => _clearUrgentAlert(alert),
              ),
            ),
          ),
        ],
        if (_tasks.isEmpty)
          const ExecutorLiveQueueCard(
            title: 'لا توجد مهام حالياً',
            message:
                'ستظهر العمليات الجديدة أو الموجهة إلى حسابك هنا فور وصولها.',
          )
        else
          ..._tasks.map(
            (task) => Padding(
              padding: const EdgeInsets.only(bottom: 12),
              child: ExecutorTaskTile(
                task: task,
                busy: _actionBusy,
                currentExecutorId: currentExecutorId,
                acceptBlocked: hasAcceptedTask,
                canRoute: canViewCompanyBalance && _manualTaskRoutingEnabled,
                isManager: canViewCompanyBalance,
                onAccept: () => _accept(task),
                onRoute: () => _routeTask(task),
                onCancel: () => _cancel(task),
                onComplete: () => _complete(task),
                onShare: () => _shareToWhatsApp(task),
              ),
            ),
          ),
        if (_tasks.isNotEmpty) ...[
          const SizedBox(height: 16),
          ExecutorConnectionCard(lastUpdated: _lastUpdated),
        ],
      ],
    );
  }
}

class ExecutorBalanceHeroCard extends StatelessWidget {
  const ExecutorBalanceHeroCard({super.key, required this.balance});

  final double balance;

  @override
  Widget build(BuildContext context) {
    final dark = Theme.of(context).brightness == Brightness.dark;
    final colors = Theme.of(context).colorScheme;
    final safeBalance = balance.isFinite ? balance : 0.0;
    return LayoutBuilder(
      builder: (context, constraints) {
        final compact = constraints.maxWidth < 390;
        return Container(
          height: compact ? 132 : 156,
          padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 16),
          decoration: BoxDecoration(
            color: dark ? const Color(0xFF15243D) : colors.surface,
            borderRadius: BorderRadius.circular(20),
            border: Border.all(
              color: dark
                  ? Colors.white.withValues(alpha: 0.10)
                  : Colors.white.withValues(alpha: 0.92),
            ),
            boxShadow: [
              BoxShadow(
                color: _navy.withValues(alpha: dark ? 0.30 : 0.12),
                blurRadius: 24,
                offset: const Offset(0, 12),
              ),
            ],
          ),
          child: Row(
            children: [
              GlassIconBadge(
                icon: Icons.visibility_outlined,
                color: AhramColors.sky,
                size: 52,
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Text(
                      'رصيد المنفذ',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        color: colors.onSurfaceVariant,
                        fontSize: 15,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                    const SizedBox(height: 6),
                    Text(
                      '${formatAmount(safeBalance, fractionDigits: 0)} ج.م',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      textDirection: ui.TextDirection.ltr,
                      style: TextStyle(
                        color: colors.onSurface,
                        fontSize: compact ? 27 : 33,
                        fontWeight: FontWeight.w900,
                      ),
                    ),
                  ],
                ),
              ),
              if (!compact) const _ExecutorWalletVisual(),
            ],
          ),
        );
      },
    );
  }
}

class _ExecutorWalletVisual extends StatelessWidget {
  const _ExecutorWalletVisual();

  @override
  Widget build(BuildContext context) {
    final dark = Theme.of(context).brightness == Brightness.dark;
    return SizedBox(
      width: 104,
      height: 94,
      child: Stack(
        alignment: Alignment.center,
        children: [
          Positioned(
            bottom: 5,
            child: Container(
              width: 84,
              height: 14,
              decoration: BoxDecoration(
                color: _navy.withValues(alpha: 0.10),
                borderRadius: BorderRadius.circular(99),
              ),
            ),
          ),
          Transform.rotate(
            angle: -0.10,
            child: Container(
              width: 78,
              height: 65,
              decoration: BoxDecoration(
                color: dark ? const Color(0xFF1B3A53) : const Color(0xFFEFF6FF),
                borderRadius: BorderRadius.circular(13),
                border: Border.all(
                  color: dark
                      ? const Color(0xFF3C6380)
                      : const Color(0xFFD4E2F4),
                ),
                boxShadow: [
                  BoxShadow(
                    color: _navy.withValues(alpha: dark ? 0.34 : 0.15),
                    blurRadius: 12,
                    offset: Offset(0, 7),
                  ),
                ],
              ),
              child: Stack(
                children: [
                  Positioned(
                    top: 8,
                    left: 8,
                    right: 8,
                    child: Container(
                      height: 17,
                      decoration: BoxDecoration(
                        color: const Color(0xFF55D8CF),
                        borderRadius: BorderRadius.circular(6),
                      ),
                    ),
                  ),
                  const Center(
                    child: Icon(
                      Icons.account_balance_wallet_rounded,
                      color: AhramColors.sky,
                      size: 31,
                    ),
                  ),
                ],
              ),
            ),
          ),
          Positioned(
            right: 2,
            bottom: 14,
            child: Row(
              children: List<Widget>.generate(
                3,
                (index) => Container(
                  width: 15,
                  height: 15,
                  margin: EdgeInsetsDirectional.only(
                    start: index == 0 ? 0 : -5,
                  ),
                  decoration: BoxDecoration(
                    color: _gold,
                    shape: BoxShape.circle,
                    border: Border.all(color: const Color(0xFFE0A418)),
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class ExecutorLiveMonitoringCard extends StatelessWidget {
  const ExecutorLiveMonitoringCard({super.key});

  @override
  Widget build(BuildContext context) {
    final dark = Theme.of(context).brightness == Brightness.dark;
    final colors = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsetsDirectional.fromSTEB(20, 17, 16, 17),
      decoration: BoxDecoration(
        color: dark ? const Color(0xFF153A38) : const Color(0xFFEAF9F7),
        borderRadius: BorderRadius.circular(18),
        border: Border.all(
          color: dark ? const Color(0xFF2A675F) : const Color(0xFFBCEBE3),
        ),
      ),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'المراقبة المباشرة نشطة',
                  style: TextStyle(
                    color: colors.onSurface,
                    fontSize: 18,
                    fontWeight: FontWeight.w900,
                  ),
                ),
                const SizedBox(height: 5),
                Text(
                  'جميع العمليات تتم مراقبتها في الوقت الحقيقي',
                  style: TextStyle(
                    color: colors.onSurfaceVariant,
                    fontSize: 13,
                  ),
                ),
              ],
            ),
          ),
          GlassIconBadge(icon: Icons.wifi_rounded, color: _green, size: 60),
        ],
      ),
    );
  }
}

class ExecutorLiveQueueCard extends StatefulWidget {
  const ExecutorLiveQueueCard({
    super.key,
    required this.title,
    required this.message,
  });

  final String title;
  final String message;

  @override
  State<ExecutorLiveQueueCard> createState() => _ExecutorLiveQueueCardState();
}

class _ExecutorLiveQueueCardState extends State<ExecutorLiveQueueCard>
    with SingleTickerProviderStateMixin {
  late final AnimationController _animation;

  @override
  void initState() {
    super.initState();
    _animation = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 2400),
    )..repeat(reverse: true);
  }

  @override
  void dispose() {
    _animation.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final dark = Theme.of(context).brightness == Brightness.dark;
    return Container(
      constraints: const BoxConstraints(minHeight: 470, maxWidth: 620),
      padding: const EdgeInsetsDirectional.fromSTEB(22, 20, 22, 24),
      decoration: BoxDecoration(
        color: dark ? const Color(0xFF132838) : colors.surface,
        borderRadius: BorderRadius.circular(20),
        border: Border.all(
          color: dark ? const Color(0xFF284B5A) : colors.outlineVariant,
        ),
        boxShadow: [
          BoxShadow(
            color: _navy.withValues(alpha: dark ? 0.24 : 0.09),
            blurRadius: 24,
            offset: const Offset(0, 12),
          ),
        ],
      ),
      child: Column(
        children: [
          Row(
            children: [
              Container(
                width: 42,
                height: 42,
                decoration: BoxDecoration(
                  color: dark
                      ? const Color(0xFF1A433E)
                      : AhramColors.emeraldSoft,
                  borderRadius: BorderRadius.circular(12),
                ),
                child: const Icon(
                  Icons.sensors_rounded,
                  color: AhramColors.emerald,
                ),
              ),
              const SizedBox(width: 11),
              Expanded(
                child: Text(
                  'المراقبة المباشرة نشطة',
                  style: TextStyle(
                    color: colors.onSurface,
                    fontWeight: FontWeight.w900,
                    fontSize: 15,
                  ),
                ),
              ),
              Container(
                width: 9,
                height: 9,
                decoration: const BoxDecoration(
                  color: AhramColors.emerald,
                  shape: BoxShape.circle,
                ),
              ),
              const SizedBox(width: 6),
              Text(
                'متصل',
                style: TextStyle(
                  color: colors.onSurfaceVariant,
                  fontSize: 12,
                  fontWeight: FontWeight.w700,
                ),
              ),
            ],
          ),
          const SizedBox(height: 22),
          SizedBox(
            height: 238,
            child: AnimatedBuilder(
              animation: _animation,
              builder: (context, child) {
                final lift = -7 * _animation.value;
                final scale = 0.96 + (0.04 * _animation.value);
                return Stack(
                  alignment: Alignment.center,
                  children: [
                    Positioned(
                      top: 26,
                      left: 12,
                      right: 12,
                      child: Container(
                        height: 1,
                        color: colors.outlineVariant.withValues(alpha: 0.70),
                      ),
                    ),
                    Positioned(
                      bottom: 30,
                      left: 12,
                      right: 12,
                      child: Container(
                        height: 1,
                        color: colors.outlineVariant.withValues(alpha: 0.70),
                      ),
                    ),
                    Positioned(
                      top: 24,
                      left: 12 + (28 * _animation.value),
                      child: Container(
                        width: 56,
                        height: 5,
                        decoration: BoxDecoration(
                          color: AhramColors.sky,
                          borderRadius: BorderRadius.circular(99),
                        ),
                      ),
                    ),
                    Transform.translate(
                      offset: Offset(0, lift),
                      child: Transform.scale(scale: scale, child: child),
                    ),
                  ],
                );
              },
              child: Image.asset(
                'assets/images/executor-live-bell.png',
                height: 226,
                fit: BoxFit.contain,
                filterQuality: FilterQuality.high,
              ),
            ),
          ),
          Text(
            widget.title,
            textAlign: TextAlign.center,
            style: TextStyle(
              color: colors.onSurface,
              fontSize: 23,
              fontWeight: FontWeight.w900,
            ),
          ),
          const SizedBox(height: 8),
          Text(
            widget.message,
            textAlign: TextAlign.center,
            style: TextStyle(
              color: colors.onSurfaceVariant,
              height: 1.45,
              fontSize: 14,
            ),
          ),
          const SizedBox(height: 18),
          Container(
            width: double.infinity,
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
            decoration: BoxDecoration(
              color: dark ? const Color(0xFF173248) : const Color(0xFFF1F7FF),
              borderRadius: BorderRadius.circular(12),
            ),
            child: Row(
              children: [
                const Icon(Icons.notifications_active_outlined, size: 20),
                const SizedBox(width: 9),
                Expanded(
                  child: Text(
                    'سيصلك تنبيه صوتي فور وصول مهمة جديدة',
                    style: TextStyle(
                      color: colors.onSurface,
                      fontWeight: FontWeight.w800,
                      fontSize: 12,
                    ),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class ExecutorConnectionCard extends StatelessWidget {
  const ExecutorConnectionCard({super.key, required this.lastUpdated});

  final DateTime? lastUpdated;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final time = lastUpdated == null
        ? '--:--'
        : DateFormat('h:mm a', 'ar').format(lastUpdated!);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 15),
      decoration: BoxDecoration(
        color: colors.surface,
        borderRadius: BorderRadius.circular(17),
        border: Border.all(color: colors.outlineVariant),
        boxShadow: [
          BoxShadow(
            color: _navy.withValues(
              alpha: Theme.of(context).brightness == Brightness.dark
                  ? 0.26
                  : 0.08,
            ),
            blurRadius: 18,
            offset: const Offset(0, 8),
          ),
        ],
      ),
      child: Row(
        children: [
          GlassIconBadge(
            icon: Icons.support_agent_outlined,
            color: _green,
            size: 48,
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'حالة الاتصال',
                  style: TextStyle(
                    color: colors.onSurfaceVariant,
                    fontSize: 12,
                  ),
                ),
                const SizedBox(height: 3),
                const Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Icon(Icons.circle, color: _green, size: 9),
                    SizedBox(width: 5),
                    Text(
                      'متصل',
                      style: TextStyle(
                        color: AhramColors.emeraldDeep,
                        fontWeight: FontWeight.w900,
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
          Container(width: 1, height: 42, color: colors.outlineVariant),
          const SizedBox(width: 14),
          GlassIconBadge(
            icon: Icons.schedule_outlined,
            color: AhramColors.sky,
            size: 45,
          ),
          const SizedBox(width: 9),
          Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'آخر تحديث',
                style: TextStyle(color: colors.onSurfaceVariant, fontSize: 12),
              ),
              const SizedBox(height: 3),
              Text(
                time,
                style: TextStyle(
                  color: colors.onSurface,
                  fontWeight: FontWeight.w900,
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class ExecutorUrgentAlertCard extends StatelessWidget {
  const ExecutorUrgentAlertCard({
    super.key,
    required this.alert,
    required this.alarmPlaying,
    required this.busy,
    required this.onStop,
    required this.onReview,
  });

  final Map<String, dynamic> alert;
  final bool alarmPlaying;
  final bool busy;
  final VoidCallback onStop;
  final VoidCallback onReview;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final message = '${alert['emergencyAlert'] ?? 'طلب يحتاج إلى تدخل عاجل'}'
        .trim();
    final taskId = '${alert['txId'] ?? alert['customId'] ?? '-'}';
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: _danger.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: _danger.withValues(alpha: 0.42)),
        boxShadow: [
          BoxShadow(
            color: _danger.withValues(alpha: 0.10),
            blurRadius: 18,
            offset: const Offset(0, 8),
          ),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              GlassIconBadge(
                icon: alarmPlaying
                    ? Icons.notifications_active_outlined
                    : Icons.notifications_paused_outlined,
                color: _danger,
                size: 46,
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'إنذار استعجال',
                      style: TextStyle(
                        color: colors.onSurface,
                        fontWeight: FontWeight.w900,
                      ),
                    ),
                    const SizedBox(height: 3),
                    Text(
                      'الطلب $taskId يحتاج إلى متابعة فورية.',
                      style: TextStyle(color: colors.onSurfaceVariant),
                    ),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          Text(
            message.isEmpty ? 'طلب يحتاج إلى تدخل عاجل' : message,
            style: TextStyle(
              color: colors.onSurface,
              fontWeight: FontWeight.w700,
            ),
          ),
          const SizedBox(height: 14),
          Wrap(
            spacing: 10,
            runSpacing: 10,
            children: [
              FilledButton.icon(
                onPressed: alarmPlaying ? onStop : null,
                icon: const Icon(Icons.volume_off_outlined),
                label: const Text('إيقاف الصوت'),
                style: FilledButton.styleFrom(backgroundColor: _danger),
              ),
              OutlinedButton.icon(
                onPressed: busy ? null : onReview,
                icon: const Icon(Icons.check_circle_outline),
                label: const Text('تمت المراجعة'),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class ExecutorUrgentAlertDialog extends StatelessWidget {
  const ExecutorUrgentAlertDialog({
    super.key,
    required this.alert,
    required this.onStop,
    required this.onReview,
    required this.onClose,
  });

  final Map<String, dynamic> alert;
  final VoidCallback onStop;
  final Future<void> Function() onReview;
  final VoidCallback onClose;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final taskId = '${alert['txId'] ?? alert['customId'] ?? '-'}';
    final service =
        '${alert['transferTypeLabel'] ?? serviceLabel(alert['transferType']?.toString())}';
    final number = '${alert['recipientNumber'] ?? '-'}';
    final amount = formatEgpAmount(numberValue(alert['amount']));
    final note = '${alert['notes'] ?? ''}'.trim();
    final message = '${alert['emergencyAlert'] ?? 'طلب يحتاج إلى تدخل عاجل'}'
        .trim();
    return AlertDialog(
      icon: const Icon(
        Icons.notification_important_outlined,
        color: _danger,
        size: 34,
      ),
      title: const Text('إنذار استعجال من الإدارة'),
      content: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 420),
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Container(
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: _danger.withValues(alpha: 0.10),
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(color: _danger.withValues(alpha: 0.32)),
                ),
                child: Text(
                  message.isEmpty ? 'طلب يحتاج إلى تدخل عاجل' : message,
                  style: TextStyle(
                    color: colors.onSurface,
                    fontWeight: FontWeight.w800,
                  ),
                ),
              ),
              const SizedBox(height: 14),
              _UrgentAlertDetail(label: 'رقم الطلب', value: taskId),
              _UrgentAlertDetail(label: 'الخدمة', value: service),
              _UrgentAlertDetail(label: 'رقم العميل', value: number, ltr: true),
              _UrgentAlertDetail(
                label: 'القيمة',
                value: '$amount ج.م',
                ltr: true,
              ),
              if (note.isNotEmpty)
                _UrgentAlertDetail(label: 'ملاحظة العميل', value: note),
            ],
          ),
        ),
      ),
      actions: [
        TextButton(onPressed: onClose, child: const Text('إغلاق النافذة')),
        OutlinedButton.icon(
          onPressed: onStop,
          icon: const Icon(Icons.volume_off_outlined),
          label: const Text('إيقاف الصوت'),
        ),
        FilledButton.icon(
          onPressed: () => unawaited(onReview()),
          icon: const Icon(Icons.check_circle_outline),
          label: const Text('تمت المراجعة'),
          style: FilledButton.styleFrom(backgroundColor: _danger),
        ),
      ],
    );
  }
}

class _UrgentAlertDetail extends StatelessWidget {
  const _UrgentAlertDetail({
    required this.label,
    required this.value,
    this.ltr = false,
  });

  final String label;
  final String value;
  final bool ltr;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.only(bottom: 9),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 92,
            child: Text(
              label,
              style: TextStyle(color: colors.onSurfaceVariant),
            ),
          ),
          Expanded(
            child: Text(
              value,
              textDirection: ltr ? ui.TextDirection.ltr : null,
              style: TextStyle(
                color: colors.onSurface,
                fontWeight: FontWeight.w800,
              ),
            ),
          ),
        ],
      ),
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
  bool _downloading = false;
  bool _month = false;
  DateTime _selectedDate = DateTime.now();

  bool get _operatorOnly => widget.controller.isExecutorOperator;

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
        dateType: _month ? 'month' : 'day',
        dateValue: _dateValue,
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

  Future<void> _downloadPdf() async {
    if (_downloading) return;
    final downloadTarget = prepareReportDownload();
    setState(() => _downloading = true);
    try {
      final url = await widget.controller.api.executorReportDownloadUrl(
        dateType: _month ? 'month' : 'day',
        dateValue: _dateValue,
        employeeId: widget.employeeId,
      );
      final opened = await openPreparedReportDownload(downloadTarget, url);
      if (!opened) throw const ApiFailure('تعذر فتح ملف التقرير للتنزيل.');
      if (mounted) showSnack(context, 'تم فتح تقرير PDF للتنزيل.');
    } catch (error) {
      cancelPreparedReportDownload(downloadTarget);
      if (mounted) {
        showSnack(
          context,
          error is ApiFailure ? error.message : 'تعذر تنزيل التقرير حاليًا.',
          error: true,
        );
      }
    } finally {
      if (mounted) setState(() => _downloading = false);
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
    final cancelledOperations = report['cancelledOperations'] is List
        ? (report['cancelledOperations'] as List)
              .whereType<Map>()
              .map((item) => Map<String, dynamic>.from(item))
              .toList()
        : <Map<String, dynamic>>[];
    final period = report['reportPeriod'];
    final periodValue = period is Map
        ? '${period['value'] ?? _dateValue}'
        : _dateValue;
    final title = widget.employeeName == null
        ? (_operatorOnly ? 'تقاريري' : 'تقارير التنفيذ')
        : 'تقرير ${widget.employeeName}';
    final subtitle = _operatorOnly
        ? 'عرض عملياتك المنفذة فقط في الفترة التي تختارها.'
        : 'مطابقة الحركات اليومية والشهرية مع حساب شركة التنفيذ.';

    return PageFrame(
      title: title,
      subtitle: subtitle,
      onRefresh: _load,
      action: GlassIconButton(
        tooltip: 'تحميل تقرير PDF',
        onPressed: _loading || _downloading ? null : _downloadPdf,
        icon: _downloading
            ? const SizedBox(
                width: 18,
                height: 18,
                child: CircularProgressIndicator(strokeWidth: 2),
              )
            : const Icon(Icons.download_outlined),
      ),
      child: [
        SurfacePanel(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'البحث في التقارير',
                style: Theme.of(
                  context,
                ).textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w900),
              ),
              const SizedBox(height: 10),
              Wrap(
                spacing: 12,
                runSpacing: 12,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: [
                  SegmentedButton<bool>(
                    segments: const [
                      ButtonSegment<bool>(
                        value: false,
                        label: Text('يوم محدد'),
                        icon: Icon(Icons.today_outlined),
                      ),
                      ButtonSegment<bool>(
                        value: true,
                        label: Text('شهر محدد'),
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
            ],
          ),
        ),
        const SizedBox(height: 16),
        ExecutorReportSummary(report: report, operatorView: _operatorOnly),
        const SizedBox(height: 20),
        SectionTitle(
          title: 'العمليات المسجلة',
          icon: Icons.receipt_long_outlined,
        ),
        const SizedBox(height: 10),
        if (operations.isEmpty)
          EmptyPanel(
            icon: Icons.receipt_long_outlined,
            title: 'لا توجد عمليات في هذه الفترة',
            message: _operatorOnly
                ? 'ستظهر عملياتك المنفذة في اليوم الذي اخترته.'
                : 'ستظهر حركات التنفيذ فور تسجيلها على حساب الشركة.',
          )
        else
          ...operations.map(
            (operation) => Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: ExecutorReportOperationTile(operation: operation),
            ),
          ),
        if (cancelledOperations.isNotEmpty) ...[
          const SizedBox(height: 22),
          SectionTitle(
            title: 'العمليات الملغاة',
            icon: Icons.cancel_outlined,
            color: _danger,
          ),
          const SizedBox(height: 6),
          Text(
            'للمراجعة فقط ولا تدخل ضمن إجمالي مبالغ التقرير.',
            style: TextStyle(
              color: Theme.of(context).colorScheme.onSurfaceVariant,
              fontSize: 12,
            ),
          ),
          const SizedBox(height: 10),
          ...cancelledOperations.map(
            (operation) => Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: ExecutorReportOperationTile(
                operation: operation,
                cancelled: true,
              ),
            ),
          ),
        ],
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
    final colors = Theme.of(context).colorScheme;
    final tiles = <Widget>[];

    final period = report['reportPeriod'];
    final isMonthly = period is Map && period['type'] == 'month';
    if (operatorView) {
      final totalAmount = numberValue(report['totalEGP']);
      final periodLabel = isMonthly ? 'الشهر' : 'اليوم';
      return Wrap(
        spacing: 12,
        runSpacing: 12,
        children: [
          ExecutorMetricCard(
            label: 'عمليات $periodLabel',
            value: '${numberValue(report['operationCount']).toInt()}',
            icon: Icons.receipt_long_outlined,
            color: AhramColors.sky,
          ),
          ExecutorMetricCard(
            label: 'إجمالي مبلغ $periodLabel',
            value: '${formatEgpAmount(totalAmount)} ج.م',
            icon: Icons.payments_outlined,
            color: _green,
            valueColor: _green,
          ),
        ],
      );
    }

    final previousBalance = numberValue(report['previousBalance']);
    final periodBalance = numberValue(report['periodBalance']);
    final currentBalance = numberValue(report['currentBalance']);
    Color balanceColor(double value) => value < 0
        ? _green
        : value > 0
        ? _danger
        : colors.onSurfaceVariant;

    tiles.addAll([
      ExecutorMetricCard(
        label: 'عدد العمليات',
        value: '${numberValue(report['operationCount']).toInt()}',
        icon: Icons.receipt_long_outlined,
        color: AhramColors.sky,
      ),
      ExecutorMetricCard(
        label: 'الرصيد السابق',
        value: '${formatEgpAmount(previousBalance)} ج.م',
        icon: Icons.history_outlined,
        color: balanceColor(previousBalance),
        valueColor: balanceColor(previousBalance),
      ),
      ExecutorMetricCard(
        label: isMonthly ? 'صافي الشهر' : 'رصيد اليوم',
        value: '${formatEgpAmount(periodBalance)} ج.م',
        icon: Icons.swap_vert_circle_outlined,
        color: balanceColor(periodBalance),
        valueColor: balanceColor(periodBalance),
      ),
      ExecutorMetricCard(
        label: 'الرصيد الحالي',
        value: '${formatEgpAmount(currentBalance)} ج.م',
        icon: Icons.account_balance_wallet_outlined,
        color: balanceColor(currentBalance),
        valueColor: balanceColor(currentBalance),
      ),
    ]);

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
    this.valueColor,
  });

  final String label;
  final String value;
  final IconData icon;
  final Color color;
  final Color? valueColor;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return SizedBox(
      width: 205,
      child: Container(
        padding: const EdgeInsets.all(15),
        decoration: BoxDecoration(
          color: colors.surface,
          borderRadius: BorderRadius.circular(8),
          border: Border.all(color: color.withValues(alpha: 0.22)),
          boxShadow: [
            BoxShadow(
              color: _navy.withValues(alpha: 0.06),
              blurRadius: 14,
              offset: const Offset(0, 6),
            ),
          ],
        ),
        child: Row(
          children: [
            GlassIconBadge(icon: icon, color: color, size: 42),
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
                      color: valueColor ?? colors.onSurface,
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
  const ExecutorReportOperationTile({
    super.key,
    required this.operation,
    this.cancelled = false,
  });

  final Map<String, dynamic> operation;
  final bool cancelled;

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
                      '#${operation['serialNumber'] ?? '-'} · ${operation['customId'] ?? '-'}',
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
                label: 'رقم الهاتف',
                value: '${operation['recipientNumber'] ?? '-'}',
                color: colors.onSurface,
              ),
              _Metric(
                label: 'القيمة',
                value:
                    '${formatEgpAmount(numberValue(operation['amount']))} ج.م',
                color: _green,
              ),
              _Metric(
                label: 'مدة التنفيذ',
                value: formatExecutionDuration(
                  operation['executionDurationSeconds'],
                ),
                color: const Color(0xFF1976D2),
              ),
              _Metric(
                label: 'الوقت والتاريخ',
                value: formatDate(
                  operation['completedAt'] ?? operation['createdAt'],
                ),
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
          if (cancelled && '${operation['notes'] ?? ''}'.trim().isNotEmpty) ...[
            const SizedBox(height: 12),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
              decoration: BoxDecoration(
                color: _danger.withValues(alpha: 0.08),
                borderRadius: BorderRadius.circular(7),
              ),
              child: Text(
                '${operation['notes']}',
                style: const TextStyle(fontSize: 12),
              ),
            ),
          ],
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
  bool _manualTaskRoutingEnabled = false;
  bool _routingBusy = false;

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
      var manualTaskRoutingEnabled = _manualTaskRoutingEnabled;
      if (widget.controller.isExecutorManager) {
        final liveTasks = await widget.controller.api.executorLiveTasks();
        manualTaskRoutingEnabled =
            liveTasks['manualTaskRoutingEnabled'] == true;
      }
      if (mounted && raw is Map) {
        setState(() {
          _overview = Map<String, dynamic>.from(raw);
          _manualTaskRoutingEnabled = manualTaskRoutingEnabled;
        });
      }
    } catch (error) {
      if (mounted) setState(() => _error = error);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _toggleManualTaskRouting(bool enabled) async {
    setState(() => _routingBusy = true);
    try {
      final response = await widget.controller.api.setExecutorTaskRoutingMode(
        enabled,
      );
      if (!mounted) return;
      setState(() {
        _manualTaskRoutingEnabled =
            response['manualTaskRoutingEnabled'] == true;
      });
      showSnack(
        context,
        _manualTaskRoutingEnabled
            ? 'تم تفعيل التوجيه اليدوي للمهام.'
            : 'تم إيقاف التوجيه اليدوي للمهام.',
      );
    } on ApiFailure catch (error) {
      if (mounted) showSnack(context, error.message, error: true);
    } finally {
      if (mounted) setState(() => _routingBusy = false);
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
                  value:
                      '${formatEgpAmount(numberValue(company['balance']))} ج.م',
                ),
            ],
          ),
        ),
        if (widget.controller.isExecutorManager) ...[
          const SizedBox(height: 18),
          SurfacePanel(
            child: SwitchListTile.adaptive(
              contentPadding: EdgeInsets.zero,
              value: _manualTaskRoutingEnabled,
              onChanged: _routingBusy ? null : _toggleManualTaskRouting,
              secondary: const Icon(Icons.route_outlined),
              title: const Text(
                'التوجيه اليدوي للمهام',
                style: TextStyle(fontWeight: FontWeight.w900),
              ),
              subtitle: Text(
                _manualTaskRoutingEnabled
                    ? 'تُوجه كل عملية إلى موظف محدد قبل أن تظهر في حسابه.'
                    : 'تظهر العمليات لجميع المنفذين ويمكنهم قبولها مباشرة.',
              ),
            ),
          ),
        ],
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
            value:
                '${formatEgpAmount(numberValue(performance['totalEGP']))} ج.م',
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
    final roleColor = employee['role'] == 'accountant'
        ? _gold
        : isManager
        ? AhramColors.sky
        : _green;
    final roleIcon = employee['role'] == 'accountant'
        ? Icons.calculate_outlined
        : isManager
        ? Icons.admin_panel_settings_outlined
        : Icons.support_agent_outlined;
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: colors.surface,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: roleColor.withValues(alpha: 0.24)),
        boxShadow: [
          BoxShadow(
            color: _navy.withValues(alpha: 0.08),
            blurRadius: 16,
            offset: const Offset(0, 7),
          ),
          BoxShadow(
            color: Colors.white.withValues(alpha: 0.78),
            blurRadius: 0,
            offset: const Offset(0, -1),
          ),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              GlassIconBadge(icon: roleIcon, color: roleColor, size: 52),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      '${employee['name'] ?? '-'}',
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontWeight: FontWeight.w900,
                        color: colors.onSurface,
                        fontSize: 16,
                      ),
                    ),
                    const SizedBox(height: 4),
                    StatusPill(label: _role, color: roleColor),
                  ],
                ),
              ),
              Column(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  StatusPill(
                    label: active ? 'نشط' : 'موقوف',
                    color: active ? _green : _danger,
                  ),
                  if (!isManager) ...[
                    const SizedBox(height: 6),
                    PopupMenuButton<String>(
                      enabled: !busy,
                      tooltip: 'إجراءات الموظف',
                      icon: GlassIconBadge(
                        icon: Icons.more_horiz_outlined,
                        color: colors.onSurfaceVariant,
                        size: 34,
                      ),
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
                ],
              ),
            ],
          ),
          const Divider(height: 28),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              EmployeeInfoChip(
                icon: Icons.phone_outlined,
                value: '${employee['phone'] ?? '-'}',
              ),
              EmployeeInfoChip(
                icon: Icons.alternate_email_outlined,
                value: '${employee['webUsername'] ?? '-'}',
                ltr: true,
              ),
            ],
          ),
          if (!isManager) ...[
            const SizedBox(height: 14),
            Row(
              children: [
                GlassIconButton(
                  tooltip: 'تعديل البيانات',
                  onPressed: busy ? null : onEdit,
                  icon: const Icon(Icons.edit_outlined),
                ),
                const SizedBox(width: 8),
                GlassIconButton(
                  tooltip: 'تغيير كلمة المرور',
                  onPressed: busy ? null : onResetPassword,
                  icon: const Icon(Icons.key_outlined),
                ),
                const SizedBox(width: 8),
                GlassIconButton(
                  tooltip: 'فتح تقرير الموظف',
                  onPressed: busy ? null : onReport,
                  icon: const Icon(Icons.assessment_outlined),
                ),
                if (busy) ...[
                  const SizedBox(width: 12),
                  const SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  ),
                ],
              ],
            ),
          ],
        ],
      ),
    );
  }
}

class EmployeeInfoChip extends StatelessWidget {
  const EmployeeInfoChip({
    super.key,
    required this.icon,
    required this.value,
    this.ltr = false,
  });

  final IconData icon;
  final String value;
  final bool ltr;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Container(
      constraints: const BoxConstraints(maxWidth: 250),
      padding: const EdgeInsetsDirectional.fromSTEB(9, 7, 11, 7),
      decoration: BoxDecoration(
        color: colors.primary.withValues(alpha: 0.06),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: colors.primary.withValues(alpha: 0.12)),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 16, color: colors.primary),
          const SizedBox(width: 6),
          Flexible(
            child: Text(
              value,
              overflow: TextOverflow.ellipsis,
              textDirection: ltr ? ui.TextDirection.ltr : null,
              style: TextStyle(color: colors.onSurfaceVariant, fontSize: 12),
            ),
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
      title: const Text('إرسال إثبات التنفيذ'),
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
          child: Text(_busy ? 'جارٍ الإرسال...' : 'إرسال التنفيذ'),
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
    this.showHeading = true,
  });

  final String title;
  final String? subtitle;
  final List<Widget> child;
  final Widget? action;
  final Future<void> Function()? onRefresh;
  final bool showHeading;

  @override
  Widget build(BuildContext context) {
    final content = ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(20, 24, 20, 36),
      children: [
        Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 1120),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                if (showHeading) ...[
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Container(
                        width: 4,
                        height: subtitle == null ? 34 : 48,
                        margin: const EdgeInsetsDirectional.only(end: 12),
                        decoration: BoxDecoration(
                          color: _green,
                          borderRadius: BorderRadius.circular(8),
                        ),
                      ),
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
                  const SizedBox(height: 24),
                ],
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
    final colors = Theme.of(context).colorScheme;
    final dark = Theme.of(context).brightness == Brightness.dark;
    final size = large ? 76.0 : 42.0;
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          width: size,
          height: size,
          decoration: BoxDecoration(
            color: dark ? colors.surface : Colors.white,
            borderRadius: BorderRadius.circular(8),
            border: Border.all(
              color: Theme.of(context).colorScheme.outlineVariant,
            ),
          ),
          child: ClipRRect(
            borderRadius: BorderRadius.circular(7),
            child: Image.asset(
              'assets/images/alahrampay-logo.jpg',
              fit: BoxFit.cover,
              filterQuality: FilterQuality.high,
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
                'شركة الأهرام',
                style: TextStyle(
                  fontWeight: FontWeight.w900,
                  color: colors.onSurface,
                  fontSize: large ? 20 : 14,
                ),
              ),
              Text(
                'للاتصالات والتقنية',
                style: TextStyle(
                  color: _gold,
                  fontSize: large ? 12 : 10,
                  fontWeight: FontWeight.w700,
                ),
              ),
            ],
          ),
        ],
        if (compact) ...[
          const SizedBox(width: 8),
          Text(
            'AL-AHRAM',
            textDirection: ui.TextDirection.ltr,
            style: TextStyle(
              color: colors.onSurface,
              fontSize: 11,
              fontWeight: FontWeight.w900,
              letterSpacing: 0,
            ),
          ),
        ],
      ],
    );
  }
}

class GlassIconBadge extends StatelessWidget {
  const GlassIconBadge({
    super.key,
    required this.icon,
    this.color,
    this.size = 34,
    this.selected = false,
  });

  final IconData icon;
  final Color? color;
  final double size;
  final bool selected;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final dark = Theme.of(context).brightness == Brightness.dark;
    final accent =
        color ?? (selected ? colors.primary : colors.onSurfaceVariant);
    return Container(
      width: size,
      height: size,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: dark
            ? accent.withValues(alpha: selected ? 0.22 : 0.11)
            : accent.withValues(alpha: selected ? 0.16 : 0.08),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(
          color: dark
              ? Colors.white.withValues(alpha: 0.12)
              : Colors.white.withValues(alpha: 0.86),
        ),
        boxShadow: [
          BoxShadow(
            color: _navy.withValues(alpha: dark ? 0.24 : 0.12),
            blurRadius: 7,
            offset: const Offset(0, 4),
          ),
          BoxShadow(
            color: Colors.white.withValues(alpha: dark ? 0.05 : 0.82),
            blurRadius: 0,
            offset: const Offset(0, -1),
          ),
        ],
      ),
      child: Icon(icon, color: accent, size: size * 0.53),
    );
  }
}

class GlassIconButton extends StatelessWidget {
  const GlassIconButton({
    super.key,
    required this.tooltip,
    required this.onPressed,
    required this.icon,
  });

  final String tooltip;
  final VoidCallback? onPressed;
  final Widget icon;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final dark = Theme.of(context).brightness == Brightness.dark;
    return Tooltip(
      message: tooltip,
      child: Container(
        width: 42,
        height: 42,
        margin: const EdgeInsetsDirectional.only(start: 2),
        decoration: BoxDecoration(
          color: dark
              ? Colors.white.withValues(alpha: 0.08)
              : colors.surface.withValues(alpha: 0.78),
          borderRadius: BorderRadius.circular(12),
          border: Border.all(
            color: dark
                ? Colors.white.withValues(alpha: 0.12)
                : Colors.white.withValues(alpha: 0.88),
          ),
          boxShadow: [
            BoxShadow(
              color: _navy.withValues(alpha: dark ? 0.26 : 0.13),
              blurRadius: 8,
              offset: const Offset(0, 4),
            ),
            BoxShadow(
              color: Colors.white.withValues(alpha: dark ? 0.04 : 0.8),
              blurRadius: 0,
              offset: const Offset(0, -1),
            ),
          ],
        ),
        child: IconButton(tooltip: tooltip, onPressed: onPressed, icon: icon),
      ),
    );
  }
}

class ExecutorBalanceBadge extends StatelessWidget {
  const ExecutorBalanceBadge({
    super.key,
    required this.amount,
    required this.label,
  });

  final double amount;
  final String label;

  @override
  Widget build(BuildContext context) {
    final dark = Theme.of(context).brightness == Brightness.dark;
    return Padding(
      padding: const EdgeInsetsDirectional.only(start: 4, end: 4),
      child: Container(
        constraints: const BoxConstraints(minWidth: 92),
        padding: const EdgeInsetsDirectional.fromSTEB(10, 7, 8, 7),
        decoration: BoxDecoration(
          color: dark ? const Color(0xFF152B4B) : const Color(0xFFF8FBFF),
          borderRadius: BorderRadius.circular(8),
          border: Border.all(
            color: dark
                ? const Color(0xFF294765)
                : AhramColors.sky.withValues(alpha: 0.22),
          ),
          boxShadow: [
            BoxShadow(
              color: _navy.withValues(alpha: dark ? 0.22 : 0.1),
              blurRadius: 8,
              offset: const Offset(0, 4),
            ),
          ],
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                color: dark ? const Color(0xFFA5DCC8) : AhramColors.emeraldDeep,
                fontSize: 9,
                fontWeight: FontWeight.w700,
              ),
            ),
            const SizedBox(height: 1),
            Text(
              '${formatAmount(amount, fractionDigits: 0)} ج.م',
              textDirection: ui.TextDirection.ltr,
              style: TextStyle(
                color: Theme.of(context).colorScheme.onSurface,
                fontSize: 12,
                fontWeight: FontWeight.w900,
              ),
            ),
          ],
        ),
      ),
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
        color: AhramColors.emeraldDeep,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: _gold.withValues(alpha: 0.48)),
        boxShadow: [
          BoxShadow(
            color: AhramColors.emeraldDeep.withValues(alpha: 0.28),
            blurRadius: 24,
            offset: const Offset(0, 10),
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
    final dark = Theme.of(context).brightness == Brightness.dark;
    return Container(
      padding: const EdgeInsets.all(18),
      decoration: BoxDecoration(
        color: colors.surface,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: colors.outlineVariant),
        boxShadow: [
          BoxShadow(
            color: _navy.withValues(alpha: dark ? 0.3 : 0.11),
            blurRadius: 0,
            offset: const Offset(0, 5),
          ),
          BoxShadow(
            color: _gold.withValues(alpha: dark ? 0.08 : 0.12),
            blurRadius: 18,
            offset: const Offset(0, 9),
          ),
          BoxShadow(
            color: colors.surface.withValues(alpha: dark ? 0.08 : 0.9),
            blurRadius: 1,
            offset: const Offset(0, -1),
          ),
        ],
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
    final colors = Theme.of(context).colorScheme;
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
                    style: TextStyle(
                      fontSize: 12,
                      color: colors.onSurfaceVariant,
                    ),
                  ),
                  const SizedBox(height: 4),
                  FittedBox(
                    fit: BoxFit.scaleDown,
                    alignment: Alignment.centerRight,
                    child: Text(
                      '$value $suffix',
                      style: TextStyle(
                        fontWeight: FontWeight.w900,
                        color: colors.onSurface,
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
    final colors = Theme.of(context).colorScheme;
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
              color: colors.onSurface,
            ),
          ),
          Text(
            'سعر الخدمة الحالي',
            style: TextStyle(fontSize: 12, color: colors.onSurfaceVariant),
          ),
        ],
      ),
    );
  }
}

class SectionTitle extends StatelessWidget {
  const SectionTitle({
    super.key,
    required this.title,
    required this.icon,
    this.color = _green,
  });

  final String title;
  final IconData icon;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Container(
          width: 32,
          height: 32,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: color.withValues(alpha: 0.11),
            borderRadius: BorderRadius.circular(8),
          ),
          child: Icon(icon, color: color, size: 19),
        ),
        const SizedBox(width: 10),
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
        border: Border.all(
          color: dark
              ? color.withValues(alpha: 0.28)
              : color.withValues(alpha: 0.22),
        ),
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
    final dark = Theme.of(context).brightness == Brightness.dark;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 7),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 122,
            child: Text(
              label,
              style: TextStyle(
                color: dark ? const Color(0xFFCFD9E1) : colors.onSurfaceVariant,
              ),
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
    final colors = Theme.of(context).colorScheme;
    return Material(
      color: colors.surface,
      borderRadius: BorderRadius.circular(8),
      child: InkWell(
        borderRadius: BorderRadius.circular(8),
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.all(15),
          decoration: BoxDecoration(
            border: Border.all(color: colors.outlineVariant),
            borderRadius: BorderRadius.circular(8),
            boxShadow: [
              BoxShadow(
                color: _navy.withValues(alpha: 0.06),
                blurRadius: 14,
                offset: const Offset(0, 6),
              ),
            ],
          ),
          child: Row(
            children: [
              Container(
                width: 44,
                height: 44,
                decoration: BoxDecoration(
                  color: statusColor(status).withValues(alpha: 0.11),
                  borderRadius: BorderRadius.circular(8),
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
                      style: TextStyle(
                        fontWeight: FontWeight.w800,
                        color: colors.onSurface,
                      ),
                    ),
                    const SizedBox(height: 3),
                    Text(
                      '${transaction['customId'] ?? transaction['txId'] ?? '-'} · ${formatDate(transaction['createdAt'])}',
                      style: TextStyle(
                        fontSize: 12,
                        color: colors.onSurfaceVariant,
                      ),
                    ),
                  ],
                ),
              ),
              Column(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  Text(
                    '${formatEgpAmount(numberValue(transaction['amount']))} ج.م',
                    style: TextStyle(
                      fontWeight: FontWeight.w900,
                      color: colors.onSurface,
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
    final colors = Theme.of(context).colorScheme;
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
                  style: TextStyle(
                    fontWeight: FontWeight.w800,
                    color: colors.onSurface,
                  ),
                ),
                const SizedBox(height: 4),
                Text(
                  '${ticket['lastMessage'] ?? ticket['message'] ?? ''}',
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(color: colors.onSurfaceVariant),
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
    final colors = Theme.of(context).colorScheme;
    return SurfacePanel(
      child: Column(
        children: [
          Row(
            children: [
              CircleAvatar(
                backgroundColor: _green.withValues(alpha: 0.12),
                child: const Icon(Icons.person_outline, color: _green),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      '${account['name'] ?? '-'}',
                      style: TextStyle(
                        fontWeight: FontWeight.w800,
                        color: colors.onSurface,
                      ),
                    ),
                    Text(
                      '${account['accountCode'] ?? account['phone'] ?? ''}',
                      style: TextStyle(
                        fontSize: 12,
                        color: colors.onSurfaceVariant,
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
                color: balance < 0 ? _danger : colors.onSurface,
              ),
              _Metric(
                label: 'الحد الائتماني',
                value:
                    '${formatAmount(numberValue(account['creditLimit']))} د.ل',
                color: colors.onSurface,
              ),
              _Metric(
                label: 'الدين',
                value: '${formatAmount(debt)} د.ل',
                color: debt > 0 ? _danger : colors.onSurface,
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
    final colors = Theme.of(context).colorScheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          label,
          style: TextStyle(fontSize: 11, color: colors.onSurfaceVariant),
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
    required this.currentExecutorId,
    required this.acceptBlocked,
    required this.canRoute,
    required this.isManager,
    required this.onAccept,
    required this.onRoute,
    required this.onCancel,
    required this.onComplete,
    required this.onShare,
  });

  final Map<String, dynamic> task;
  final bool busy;
  final String currentExecutorId;
  final bool acceptBlocked;
  final bool canRoute;
  final bool isManager;
  final VoidCallback onAccept;
  final VoidCallback onRoute;
  final VoidCallback onCancel;
  final VoidCallback onComplete;
  final Future<void> Function() onShare;

  Future<void> _copyValue(
    BuildContext context,
    String value,
    String label,
  ) async {
    await Clipboard.setData(ClipboardData(text: value));
    if (context.mounted) showSnack(context, 'تم نسخ $label.');
  }

  @override
  Widget build(BuildContext context) {
    final accepted = task['status'] == 'accepted';
    final acceptedById = '${task['operatorId'] ?? ''}'.trim();
    final acceptedByName =
        '${task['acceptedByName'] ?? task['executorName'] ?? ''}'.trim();
    final assignedExecutorName =
        '${task['assignedExecutorName'] ?? acceptedByName}'.trim();
    // An accepted task is actionable only by its owner. Treat missing ownership
    // data as locked so an older API response cannot expose unsafe actions.
    final acceptedByMe =
        accepted &&
        (task['isOwnedByCurrentExecutor'] == true ||
            (acceptedById.isNotEmpty && acceptedById == currentExecutorId));
    final takenByAnother = accepted && !acceptedByMe;
    final canRouteTask = canRoute && !accepted;
    final takenByLabel = acceptedByName.isEmpty ? 'منفذ آخر' : acceptedByName;
    final assignmentStatus = accepted
        ? 'قيد التنفيذ لدى الموظف'
        : 'بانتظار قبول الموظف';
    final colors = Theme.of(context).colorScheme;
    final transferType = task['transferType']?.toString();
    final isCashWallet = transferType == 'vodafone';
    final recipient = '${task['recipientNumber'] ?? '-'}';
    final amount = formatEgpAmount(numberValue(task['amount']));
    final notes = '${task['notes'] ?? ''}'.trim();
    final receivedAt = task['executorReceivedAt'] ?? task['createdAt'];
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
                  color: AhramColors.sky.withValues(alpha: 0.11),
                  borderRadius: BorderRadius.circular(8),
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
                      'طلب ${task['txId'] ?? '-'}',
                      style: TextStyle(
                        fontWeight: FontWeight.w900,
                        color: colors.onSurface,
                      ),
                    ),
                    Text(
                      '${task['transferTypeLabel'] ?? serviceLabel(task['transferType']?.toString())}',
                      style: TextStyle(color: colors.onSurfaceVariant),
                    ),
                  ],
                ),
              ),
              StatusPill(
                label: isManager && assignedExecutorName.isNotEmpty
                    ? assignmentStatus
                    : statusLabel(task['status']?.toString()),
                color: statusColor(task['status']?.toString()),
              ),
            ],
          ),
          const SizedBox(height: 12),
          _TaskDataLine(
            icon: Icons.phone_iphone_outlined,
            label: isCashWallet ? 'رقم هاتف العميل' : 'رقم حساب المستلم',
            value: recipient,
            textDirection: ui.TextDirection.ltr,
            onCopy: recipient == '-'
                ? null
                : () => _copyValue(context, recipient, 'الرقم'),
          ),
          const Divider(height: 22),
          _TaskDataLine(
            icon: Icons.payments_outlined,
            label: 'القيمة المطلوب تحويلها',
            value: '$amount ج.م',
            valueColor: _green,
            textDirection: ui.TextDirection.ltr,
            onCopy: () => _copyValue(context, amount, 'القيمة'),
          ),
          const Divider(height: 22),
          Row(
            children: [
              Icon(
                Icons.schedule_outlined,
                size: 20,
                color: colors.onSurfaceVariant,
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'وقت وصول العملية',
                      style: TextStyle(
                        color: colors.onSurfaceVariant,
                        fontSize: 12,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      formatTaskArrival(receivedAt),
                      textDirection: ui.TextDirection.ltr,
                      style: TextStyle(
                        color: colors.onSurface,
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                  ],
                ),
              ),
              TaskElapsedTimer(startedAt: receivedAt),
            ],
          ),
          if (notes.isNotEmpty) ...[
            const Divider(height: 22),
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Icon(
                  Icons.sticky_note_2_outlined,
                  size: 20,
                  color: AhramColors.gold,
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        'ملاحظة العميل',
                        style: TextStyle(
                          color: colors.onSurfaceVariant,
                          fontSize: 12,
                        ),
                      ),
                      const SizedBox(height: 3),
                      SelectableText(
                        notes,
                        style: TextStyle(
                          color: colors.onSurface,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ],
          if (isManager && assignedExecutorName.isNotEmpty) ...[
            const Divider(height: 22),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 11),
              decoration: BoxDecoration(
                color: AhramColors.emeraldSoft.withValues(alpha: 0.72),
                borderRadius: BorderRadius.circular(10),
                border: Border.all(
                  color: AhramColors.emerald.withValues(alpha: 0.25),
                ),
              ),
              child: Row(
                children: [
                  const Icon(
                    Icons.assignment_ind_outlined,
                    color: AhramColors.emerald,
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          assignmentStatus,
                          style: TextStyle(
                            color: colors.onSurfaceVariant,
                            fontSize: 12,
                          ),
                        ),
                        const SizedBox(height: 2),
                        Text(
                          assignedExecutorName,
                          style: TextStyle(
                            color: colors.onSurface,
                            fontWeight: FontWeight.w900,
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ],
          if (takenByAnother) ...[
            const Divider(height: 22),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: AhramColors.sky.withValues(alpha: 0.10),
                borderRadius: BorderRadius.circular(10),
                border: Border.all(
                  color: AhramColors.sky.withValues(alpha: 0.28),
                ),
              ),
              child: Row(
                children: [
                  const Icon(
                    Icons.lock_person_outlined,
                    color: Color(0xFF1976D2),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(
                      'تم سحب العملية بواسطة $takenByLabel',
                      style: const TextStyle(fontWeight: FontWeight.w800),
                    ),
                  ),
                ],
              ),
            ),
          ],
          const Divider(height: 26),
          if (canRouteTask)
            SizedBox(
              width: double.infinity,
              child: FilledButton.icon(
                onPressed: busy ? null : onRoute,
                icon: const Icon(Icons.route_outlined),
                label: Text(
                  assignedExecutorName.isEmpty
                      ? 'توجيه إلى منفذ'
                      : 'إعادة التوجيه إلى منفذ',
                ),
              ),
            )
          else if (!accepted)
            SizedBox(
              width: double.infinity,
              child: FilledButton.icon(
                onPressed: busy || acceptBlocked ? null : onAccept,
                icon: const Icon(Icons.task_alt_outlined),
                label: Text(
                  acceptBlocked ? 'أكمل العملية الحالية أولاً' : 'قبول العملية',
                ),
              ),
            )
          else if (acceptedByMe)
            Row(
              children: [
                Expanded(
                  child: FilledButton.icon(
                    onPressed: busy ? null : onComplete,
                    icon: const Icon(Icons.task_alt_outlined),
                    label: const Text('تم التنفيذ'),
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: OutlinedButton.icon(
                    onPressed: busy ? null : onCancel,
                    icon: const Icon(Icons.cancel_outlined),
                    label: const Text('إلغاء'),
                    style: OutlinedButton.styleFrom(foregroundColor: _danger),
                  ),
                ),
                const SizedBox(width: 8),
                Tooltip(
                  message: 'مشاركة رسالة التنفيذ عبر واتساب',
                  child: SizedBox(
                    width: 50,
                    height: 50,
                    child: OutlinedButton(
                      onPressed: busy ? null : onShare,
                      style: OutlinedButton.styleFrom(
                        padding: EdgeInsets.zero,
                        foregroundColor: const Color(0xFF25D366),
                      ),
                      child: const Icon(Icons.share_outlined),
                    ),
                  ),
                ),
              ],
            )
          else
            SizedBox(
              width: double.infinity,
              child: OutlinedButton.icon(
                onPressed: null,
                icon: const Icon(Icons.lock_outline),
                label: Text('مسحوبة بواسطة $takenByLabel'),
              ),
            ),
        ],
      ),
    );
  }
}

class _TaskDataLine extends StatelessWidget {
  const _TaskDataLine({
    required this.icon,
    required this.label,
    required this.value,
    this.valueColor,
    this.textDirection,
    this.onCopy,
  });

  final IconData icon;
  final String label;
  final String value;
  final Color? valueColor;
  final ui.TextDirection? textDirection;
  final VoidCallback? onCopy;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return InkWell(
      onTap: onCopy,
      borderRadius: BorderRadius.circular(8),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 3),
        child: Row(
          children: [
            Icon(icon, size: 20, color: colors.onSurfaceVariant),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    label,
                    style: TextStyle(
                      color: colors.onSurfaceVariant,
                      fontSize: 12,
                    ),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    value,
                    textDirection: textDirection,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      color: valueColor ?? colors.onSurface,
                      fontWeight: FontWeight.w900,
                      fontSize: 16,
                    ),
                  ),
                ],
              ),
            ),
            if (onCopy != null)
              Tooltip(
                message: 'نسخ',
                child: Icon(
                  Icons.copy_outlined,
                  size: 18,
                  color: colors.primary,
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class TaskElapsedTimer extends StatefulWidget {
  const TaskElapsedTimer({super.key, required this.startedAt});

  final dynamic startedAt;

  @override
  State<TaskElapsedTimer> createState() => _TaskElapsedTimerState();
}

class _TaskElapsedTimerState extends State<TaskElapsedTimer> {
  Timer? _ticker;

  @override
  void initState() {
    super.initState();
    _ticker = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    _ticker?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final startedAt = DateTime.tryParse('${widget.startedAt ?? ''}')?.toLocal();
    final elapsed = startedAt == null
        ? Duration.zero
        : DateTime.now().difference(startedAt).isNegative
        ? Duration.zero
        : DateTime.now().difference(startedAt);
    final hours = elapsed.inHours.toString().padLeft(2, '0');
    final minutes = elapsed.inMinutes.remainder(60).toString().padLeft(2, '0');
    final seconds = elapsed.inSeconds.remainder(60).toString().padLeft(2, '0');
    final dark = Theme.of(context).brightness == Brightness.dark;
    return Container(
      padding: const EdgeInsetsDirectional.fromSTEB(9, 6, 9, 6),
      decoration: BoxDecoration(
        color: dark ? const Color(0xFF183A36) : AhramColors.emeraldSoft,
        borderRadius: BorderRadius.circular(8),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          Text(
            'الوقت المنقضي',
            style: TextStyle(
              color: dark ? const Color(0xFFA5DCC8) : AhramColors.emeraldDeep,
              fontSize: 10,
              fontWeight: FontWeight.w700,
            ),
          ),
          Text(
            '$hours:$minutes:$seconds',
            textDirection: ui.TextDirection.ltr,
            style: TextStyle(
              color: Theme.of(context).colorScheme.onSurface,
              fontFeatures: const [ui.FontFeature.tabularFigures()],
              fontWeight: FontWeight.w900,
            ),
          ),
        ],
      ),
    );
  }
}

class LiveQueuePanel extends StatefulWidget {
  const LiveQueuePanel({super.key, required this.title, required this.message});

  final String title;
  final String message;

  @override
  State<LiveQueuePanel> createState() => _LiveQueuePanelState();
}

class _LiveQueuePanelState extends State<LiveQueuePanel>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: const Duration(seconds: 2),
    )..repeat();
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return SurfacePanel(
      child: LayoutBuilder(
        builder: (context, constraints) {
          final narrow = constraints.maxWidth < 440;
          final visual = SizedBox(
            width: narrow ? 118 : 142,
            height: narrow ? 118 : 142,
            child: AnimatedBuilder(
              animation: _controller,
              builder: (context, _) => CustomPaint(
                painter: _LiveQueuePainter(
                  progress: _controller.value,
                  color: colors.primary,
                  muted: colors.onSurfaceVariant,
                ),
                child: const Center(
                  child: Icon(
                    Icons.notifications_active_outlined,
                    color: AhramColors.emerald,
                    size: 34,
                  ),
                ),
              ),
            ),
          );
          final copy = Expanded(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  widget.title,
                  style: TextStyle(
                    color: colors.onSurface,
                    fontSize: 18,
                    fontWeight: FontWeight.w900,
                  ),
                ),
                const SizedBox(height: 8),
                Text(
                  widget.message,
                  style: TextStyle(
                    color: colors.onSurfaceVariant,
                    height: 1.45,
                  ),
                ),
                const SizedBox(height: 14),
                Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Icon(Icons.sensors, size: 18, color: colors.primary),
                    const SizedBox(width: 7),
                    Text(
                      'المراقبة المباشرة تعمل',
                      style: TextStyle(
                        color: colors.primary,
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                  ],
                ),
              ],
            ),
          );
          return narrow
              ? Column(children: [visual, const SizedBox(height: 12), copy])
              : Row(children: [visual, const SizedBox(width: 22), copy]);
        },
      ),
    );
  }
}

class _LiveQueuePainter extends CustomPainter {
  const _LiveQueuePainter({
    required this.progress,
    required this.color,
    required this.muted,
  });

  final double progress;
  final Color color;
  final Color muted;

  @override
  void paint(Canvas canvas, Size size) {
    final center = Offset(size.width / 2, size.height / 2);
    final maximumRadius = math.min(size.width, size.height) / 2 - 4;
    final ringPaint = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.3;
    for (var index = 1; index <= 3; index++) {
      final phase = (progress + index / 3) % 1;
      ringPaint.color = color.withValues(alpha: (1 - phase) * 0.30);
      canvas.drawCircle(center, maximumRadius * phase, ringPaint);
    }
    ringPaint.color = muted.withValues(alpha: 0.20);
    canvas.drawCircle(center, maximumRadius, ringPaint);
    final angle = progress * math.pi * 2 - math.pi / 2;
    final beamEnd = Offset(
      center.dx + math.cos(angle) * maximumRadius,
      center.dy + math.sin(angle) * maximumRadius,
    );
    canvas.drawLine(
      center,
      beamEnd,
      Paint()
        ..color = color.withValues(alpha: 0.7)
        ..strokeWidth = 2,
    );
    canvas.drawCircle(center, 4, Paint()..color = color);
  }

  @override
  bool shouldRepaint(covariant _LiveQueuePainter oldDelegate) {
    return oldDelegate.progress != progress || oldDelegate.color != color;
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
    final colors = Theme.of(context).colorScheme;
    final dark = Theme.of(context).brightness == Brightness.dark;
    return SurfacePanel(
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 28),
        child: Column(
          children: [
            Container(
              width: 58,
              height: 58,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: _green.withValues(alpha: 0.1),
                borderRadius: BorderRadius.circular(8),
              ),
              child: Icon(icon, color: _green, size: 30),
            ),
            const SizedBox(height: 12),
            Text(
              title,
              style: TextStyle(
                fontWeight: FontWeight.w800,
                color: dark ? Colors.white : colors.onSurface,
              ),
            ),
            const SizedBox(height: 5),
            Text(
              message,
              textAlign: TextAlign.center,
              style: TextStyle(
                color: dark ? const Color(0xFFCFD9E1) : colors.onSurfaceVariant,
              ),
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
