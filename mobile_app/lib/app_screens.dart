import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:dio/dio.dart';
import 'package:flutter/services.dart';
import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:intl/intl.dart';
import 'package:share_plus/share_plus.dart';

import 'appearance_controller.dart';
import 'brand_theme.dart';
import 'executor_alert_service.dart';
import 'executor_notification_center.dart';
import 'executor_ui.dart';
import 'external_link.dart';
import 'language_controller.dart';
import 'mobile_api.dart';
import 'mobile_notification_catalog.dart';
import 'mobile_push_service.dart';
import 'rate_alerts/rate_alert_overlay.dart';
import 'report_download.dart';

const _navy = AhramColors.ink;
const _green = AhramColors.emerald;
const _gold = AhramColors.gold;
const _danger = AhramColors.danger;

bool usesEnglish(BuildContext context) =>
    Localizations.localeOf(context).languageCode == 'en';

String localized(BuildContext context, String arabic, String english) =>
    usesEnglish(context) ? english : arabic;

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

String formatSupportUpdatedAt(DateTime value) {
  final local = value.toLocal();
  final hour = local.hour % 12 == 0 ? 12 : local.hour % 12;
  final minute = local.minute.toString().padLeft(2, '0');
  final period = local.hour < 12 ? 'ص' : 'م';
  return '$hour:$minute $period';
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

  Future<String?> _requestAuthenticatorCode() async {
    final code = TextEditingController();
    try {
      return await showDialog<String>(
        context: context,
        barrierDismissible: false,
        builder: (dialogContext) => AlertDialog(
          title: const Text('رمز Authenticator'),
          content: TextField(
            controller: code,
            autofocus: true,
            keyboardType: TextInputType.number,
            maxLength: 6,
            textAlign: TextAlign.center,
            decoration: const InputDecoration(
              labelText: 'أدخل الرمز المكون من 6 أرقام',
              prefixIcon: Icon(Icons.security_outlined),
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(dialogContext),
              child: const Text('إلغاء'),
            ),
            FilledButton(
              onPressed: () {
                final value = code.text.trim();
                if (!RegExp(r'^\d{6}$').hasMatch(value)) return;
                Navigator.pop(dialogContext, value);
              },
              child: const Text('متابعة'),
            ),
          ],
        ),
      );
    } finally {
      code.dispose();
    }
  }

  Future<void> _completeMandatoryAuthenticatorEnrollment(
    String enrollmentToken,
  ) async {
    final code = TextEditingController();
    Map<String, dynamic>? setup;
    String? error;
    var busy = false;
    try {
      setup = await widget.controller.api.beginMandatoryMfaEnrollment(
        enrollmentToken,
      );
    } on ApiFailure catch (failure) {
      if (mounted) setState(() => _error = failure.message);
      return;
    }
    if (!mounted || setup == null) return;
    await showDialog<void>(
      context: context,
      barrierDismissible: false,
      builder: (dialogContext) => StatefulBuilder(
        builder: (context, setDialogState) => AlertDialog(
          title: const Text('تفعيل Authenticator مطلوب'),
          content: SizedBox(
            width: 420,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const Text(
                  'تم اعتماد هذا الجهاز. انسخ المفتاح إلى تطبيق Authenticator ثم أدخل رمز الـ 6 أرقام لإكمال الدخول.',
                ),
                const SizedBox(height: 14),
                SelectableText(
                  '${setup!['secret'] ?? ''}',
                  textAlign: TextAlign.center,
                  style: const TextStyle(
                    fontWeight: FontWeight.w900,
                    letterSpacing: 2,
                  ),
                ),
                const SizedBox(height: 12),
                TextField(
                  controller: code,
                  keyboardType: TextInputType.number,
                  maxLength: 6,
                  autofocus: true,
                  textAlign: TextAlign.center,
                  decoration: const InputDecoration(
                    labelText: 'رمز Authenticator',
                  ),
                ),
                if (error != null)
                  InlineMessage(message: error!, color: _danger),
              ],
            ),
          ),
          actions: [
            FilledButton(
              onPressed: busy
                  ? null
                  : () async {
                      if (!RegExp(r'^\d{6}$').hasMatch(code.text.trim())) {
                        setDialogState(
                          () => error = 'أدخل رمزًا مكوّنًا من 6 أرقام.',
                        );
                        return;
                      }
                      setDialogState(() {
                        busy = true;
                        error = null;
                      });
                      try {
                        await widget.controller.api
                            .confirmMandatoryMfaEnrollment(
                              enrollmentToken: enrollmentToken,
                              secret: '${setup!['secret'] ?? ''}',
                              token: code.text.trim(),
                              recoveryCodes:
                                  (setup!['recoveryCodes'] as List? ?? const [])
                                      .map((item) => '$item')
                                      .toList(),
                            );
                        if (context.mounted) Navigator.pop(context);
                        if (mounted)
                          setState(
                            () => _error =
                                'تم التفعيل. سجّل الدخول مرة أخرى باستخدام رمز Authenticator.',
                          );
                      } on ApiFailure catch (failure) {
                        setDialogState(() => error = failure.message);
                      } finally {
                        if (context.mounted) setDialogState(() => busy = false);
                      }
                    },
              child: Text(busy ? 'جارٍ التفعيل...' : 'تأكيد التفعيل'),
            ),
          ],
        ),
      ),
    );
    code.dispose();
  }

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
      if (error.code == 'MFA_REQUIRED') {
        final code = await _requestAuthenticatorCode();
        if (code != null && code.isNotEmpty) {
          try {
            await widget.controller.signIn(
              username: _username.text.trim(),
              password: _password.text,
              mfaToken: code,
              trustDevice: true,
            );
            if (_rememberLogin) {
              await widget.controller.saveLogin(
                username: _username.text.trim(),
                password: _password.text,
              );
            }
            if (widget.controller.isExecutor ||
                widget.controller.isCustomerAccount) {
              await ExecutorAlertService.instance.requestPermissionsAndStart();
            }
            return;
          } on ApiFailure catch (mfaError) {
            if (mounted) setState(() => _error = mfaError.message);
          }
        }
      } else if (error.code == 'MFA_ENROLLMENT_REQUIRED') {
        final enrollmentToken = '${error.data?['mfaEnrollmentToken'] ?? ''}'
            .trim();
        if (enrollmentToken.isNotEmpty) {
          await _completeMandatoryAuthenticatorEnrollment(enrollmentToken);
        } else if (mounted) {
          setState(() => _error = error.message);
        }
      } else if (mounted) {
        setState(() => _error = error.message);
      }
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
        decoration: const BoxDecoration(color: AhramColors.ink),
        child: SafeArea(
          child: LayoutBuilder(
            builder: (context, constraints) => Center(
              child: SingleChildScrollView(
                padding: const EdgeInsets.all(22),
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 420),
                  child: Container(
                    padding: const EdgeInsets.fromLTRB(28, 30, 28, 26),
                    decoration: BoxDecoration(
                      color: Colors.white.withValues(alpha: 0.97),
                      borderRadius: BorderRadius.circular(8),
                      // A rounded BoxDecoration needs a uniform border. This
                      // keeps the login card renderable on Flutter web too.
                      border: Border.all(color: _gold, width: 3),
                      boxShadow: [
                        BoxShadow(
                          color: Colors.black.withValues(alpha: 0.38),
                          blurRadius: 42,
                          offset: const Offset(0, 20),
                        ),
                      ],
                    ),
                    child: Material(
                      color: Colors.transparent,
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
                              margin: const EdgeInsets.symmetric(
                                horizontal: 92,
                              ),
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
                                    borderRadius: BorderRadius.circular(8),
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
                                icon: const Icon(
                                  Icons.person_add_alt_1_outlined,
                                ),
                                label: const Text('إنشاء حساب جديد'),
                                style: OutlinedButton.styleFrom(
                                  foregroundColor: const Color(0xFF001A4D),
                                  side: const BorderSide(
                                    color: Color(0xFF001A4D),
                                  ),
                                  shape: RoundedRectangleBorder(
                                    borderRadius: BorderRadius.circular(8),
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
        initialValue: _city,
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
                    initialValue: _nationality,
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
    required this.language,
    this.enableBackgroundAlerts = true,
  });

  final SessionController controller;
  final AppearanceController appearance;
  final LanguageController language;
  final bool enableBackgroundAlerts;

  @override
  State<RoleShell> createState() => _RoleShellState();
}

class _RoleShellState extends State<RoleShell> with WidgetsBindingObserver {
  late List<_NavItem> _items;
  String _itemsLocale = 'ar';
  int _index = 0;
  Map<String, dynamic>? _executorOverview;
  Timer? _rateAlertPoll;
  Timer? _executorInboxPoll;
  StreamSubscription<MobileNotificationInteraction>?
  _pushInteractionSubscription;
  int _executorUnreadNotifications = 0;
  Map<String, dynamic>? _pendingRateAlert;
  Map<String, dynamic>? _activatedRateAlert;

  @override
  void initState() {
    super.initState();
    _items = _createItems();
    if (widget.enableBackgroundAlerts &&
        (widget.controller.isExecutor ||
            widget.controller.receivesClientNotifications)) {
      WidgetsBinding.instance.addObserver(this);
      if (widget.controller.isExecutor) {
        unawaited(_loadExecutorOverview());
        _pushInteractionSubscription = MobilePushService.instance.interactions
            .listen((interaction) {
              unawaited(_handlePushInteraction(interaction));
            });
        unawaited(_refreshExecutorNotificationCount());
        _executorInboxPoll = Timer.periodic(const Duration(seconds: 30), (_) {
          unawaited(_refreshExecutorNotificationCount());
        });
        WidgetsBinding.instance.addPostFrameCallback((_) {
          unawaited(_openPendingPushInteraction());
        });
      }
      unawaited(ExecutorAlertService.instance.startForStoredAccount());
      unawaited(ExecutorAlertService.instance.setAppVisible(true));
    }
    if (!widget.controller.isExecutor &&
        widget.controller.receivesClientNotifications) {
      _startRateAlertPolling();
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (!widget.controller.isExecutor &&
        !widget.controller.receivesClientNotifications) {
      return;
    }
    final visible = state == AppLifecycleState.resumed;
    unawaited(ExecutorAlertService.instance.setAppVisible(visible));
    if (visible && widget.controller.isExecutor) {
      unawaited(_refreshExecutorNotificationCount());
      unawaited(_openPendingPushInteraction());
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _rateAlertPoll?.cancel();
    _executorInboxPoll?.cancel();
    _pushInteractionSubscription?.cancel();
    super.dispose();
  }

  Future<void> _refreshExecutorNotificationCount() async {
    if (!widget.controller.isExecutor) return;
    try {
      final response = await widget.controller.api.pushInbox(
        unreadOnly: true,
        limit: 1,
      );
      final unread = response['unread'] is num
          ? (response['unread'] as num).toInt()
          : int.tryParse('${response['unread'] ?? ''}') ?? 0;
      if (mounted && unread != _executorUnreadNotifications) {
        setState(() => _executorUnreadNotifications = unread);
      }
    } catch (_) {
      // The badge refreshes automatically after connectivity is restored.
    }
  }

  Future<void> _openPendingPushInteraction() async {
    final interaction = await MobilePushService.instance
        .takePendingInteraction();
    if (interaction != null) await _handlePushInteraction(interaction);
  }

  Future<void> _handlePushInteraction(
    MobileNotificationInteraction interaction,
  ) async {
    if (!mounted || !widget.controller.isExecutor) return;
    var target = switch (interaction.route) {
      'reports' => _itemIndex('التقارير'),
      'support' => _itemIndex('الدعم'),
      'settings' => _itemIndex('الإعدادات'),
      _ => _itemIndex('مهام التنفيذ'),
    };
    if (target < 0 && interaction.route == 'tasks') {
      target = _itemIndex('التقارير');
    }
    if (target >= 0 && target != _index) {
      setState(() => _index = target);
    }
    await _refreshExecutorNotificationCount();
  }

  int _itemIndex(String label) => _items.indexWhere(
    (item) => item.label == label || item.label.startsWith(label),
  );

  Future<void> _openExecutorNotificationCenter() async {
    final target = await Navigator.of(context).push<Map<String, dynamic>>(
      MaterialPageRoute<Map<String, dynamic>>(
        builder: (_) =>
            ExecutorNotificationCenterScreen(api: widget.controller.api),
      ),
    );
    if (!mounted) return;
    if (target != null) {
      final rawData = target['data'];
      await _handlePushInteraction(
        MobileNotificationInteraction(
          action: 'open_notification_center_item',
          route: '${target['route'] ?? 'tasks'}',
          data: rawData is Map
              ? Map<String, dynamic>.from(rawData)
              : <String, dynamic>{},
        ),
      );
    } else {
      await _refreshExecutorNotificationCount();
    }
  }

  void _startRateAlertPolling() {
    unawaited(_refreshRateAlert());
    _rateAlertPoll = Timer.periodic(const Duration(seconds: 8), (_) {
      unawaited(_refreshRateAlert());
    });
  }

  Future<void> _refreshRateAlert() async {
    try {
      final home = await widget.controller.refreshHome();
      final rawPending = home['pendingRateUpdate'];
      final pending = rawPending is Map
          ? Map<String, dynamic>.from(rawPending)
          : null;
      final effectiveAt = DateTime.tryParse('${pending?['effectiveAt'] ?? ''}');
      final isScheduled =
          effectiveAt != null && effectiveAt.isAfter(DateTime.now());
      if (isScheduled && pending != null) {
        if (!mounted) return;
        setState(() {
          _pendingRateAlert = pending;
          _activatedRateAlert = null;
        });
        return;
      }
      if (_pendingRateAlert != null && mounted) {
        final completed = _pendingRateAlert!;
        setState(() {
          _pendingRateAlert = null;
          _activatedRateAlert = completed;
        });
        SystemSound.play(SystemSoundType.alert);
        Future<void>.delayed(const Duration(seconds: 12), () {
          if (mounted && _activatedRateAlert == completed) {
            setState(() => _activatedRateAlert = null);
          }
        });
      }
    } catch (_) {
      // The last known alert stays visible while a short network outage recovers.
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

  List<_NavItem> _createItems({bool english = false}) {
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
            'الإيداعات',
            Icons.account_balance_wallet_outlined,
            ExecutorDepositsScreen(controller: widget.controller),
          ),
          _NavItem(
            'الموظفون',
            Icons.manage_accounts_outlined,
            ExecutorEmployeesScreen(controller: widget.controller),
          ),
          _NavItem(
            'الدعم',
            Icons.support_agent_outlined,
            ExecutorSupportScreen(controller: widget.controller),
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
            'الدعم',
            Icons.support_agent_outlined,
            ExecutorSupportScreen(controller: widget.controller),
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
            'الدعم',
            Icons.support_agent_outlined,
            ExecutorSupportScreen(controller: widget.controller),
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
        _NavItem(
          'الدعم',
          Icons.support_agent_outlined,
          ExecutorSupportScreen(controller: widget.controller),
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
          english ? 'Account' : 'الحساب',
          Icons.account_balance_wallet_outlined,
          CustomerAccountScreen(
            controller: widget.controller,
            appearance: widget.appearance,
            language: widget.language,
          ),
        ),
        _NavItem(
          english ? 'Transfers' : 'التحويلات',
          Icons.send_to_mobile_outlined,
          TransferScreen(controller: widget.controller),
        ),
        _NavItem(
          english ? 'Exchange rates' : 'أسعار الصرف',
          Icons.currency_exchange_outlined,
          ExchangeRatesScreen(controller: widget.controller),
        ),
        _NavItem(
          english ? 'Reports' : 'التقارير',
          Icons.assessment_outlined,
          CustomerReportsScreen(controller: widget.controller),
        ),
        _NavItem(
          english ? 'Support' : 'الدعم الفني',
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
      await ExecutorAlertService.instance.signOut();
      await widget.controller.signOut();
    }
  }

  @override
  Widget build(BuildContext context) {
    final locale = Localizations.localeOf(context).languageCode;
    if (_itemsLocale != locale) {
      _itemsLocale = locale;
      _items = _createItems(english: locale == 'en');
    }
    final selected = _items[_index];
    final isCustomerShell = widget.controller.isCustomerAccount;
    final isExecutorShell = widget.controller.isExecutor;
    final compactExecutorHeader =
        isExecutorShell && MediaQuery.sizeOf(context).width < 430;
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
      backgroundColor: isExecutorShell
          ? ExecutorUiColors.surface(context)
          : null,
      titleSpacing: isCustomerShell ? 12 : (compactExecutorHeader ? 8 : 18),
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
          : isExecutorShell
          ? ExecutorWordmark(compact: compactExecutorHeader)
          : compactExecutorHeader
          ? const BrandMark(iconOnly: true)
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
                ? localized(context, 'الوضع النهاري', 'Light mode')
                : localized(context, 'الوضع الليلي', 'Dark mode'),
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
            compact: compactExecutorHeader,
          ),
        if (isExecutorShell)
          ExecutorTopActionButton(
            tooltip: 'مركز الإشعارات',
            icon: Icons.notifications_none_rounded,
            onPressed: _openExecutorNotificationCenter,
            badge: _executorUnreadNotifications,
          ),
        if (isExecutorShell)
          ExecutorTopActionButton(
            tooltip: widget.appearance.isDark
                ? 'الوضع النهاري'
                : 'الوضع الليلي',
            icon: widget.appearance.isDark
                ? Icons.light_mode_outlined
                : Icons.dark_mode_outlined,
            onPressed: widget.appearance.toggle,
          ),
        if (isExecutorShell)
          ExecutorTopActionButton(
            tooltip: 'تسجيل الخروج',
            icon: Icons.logout_outlined,
            onPressed: _confirmLogout,
          )
        else
          GlassIconButton(
            tooltip: localized(context, 'تسجيل الخروج', 'Sign out'),
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
    final pageContent = isExecutorShell
        ? ExecutorWorkspaceBackground(child: pages)
        : pages;
    return LayoutBuilder(
      builder: (context, constraints) {
        final desktop = constraints.maxWidth >= 850;
        final shellBody = desktop
            ? Row(
                children: [
                  Container(
                    width: 232,
                    decoration: BoxDecoration(
                      color: isExecutorShell
                          ? ExecutorUiColors.surface(context)
                          : Theme.of(context).colorScheme.surface,
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
                              icon: isExecutorShell
                                  ? ExecutorMetalIcon(icon: item.icon, size: 36)
                                  : GlassIconBadge(icon: item.icon),
                              selectedIcon: isExecutorShell
                                  ? ExecutorMetalIcon(
                                      icon: item.icon,
                                      selected: true,
                                    )
                                  : GlassIconBadge(
                                      icon: item.icon,
                                      selected: true,
                                    ),
                              label: Text(item.label),
                            ),
                          )
                          .toList(),
                    ),
                  ),
                  Expanded(child: pageContent),
                ],
              )
            : pageContent;
        return Scaffold(
          appBar: appBar,
          body: Stack(
            children: [
              shellBody,
              if (_pendingRateAlert != null)
                Align(
                  alignment: AlignmentDirectional.topCenter,
                  child: RateAlertOverlay(
                    alert: _pendingRateAlert!,
                    onExpired: _refreshRateAlert,
                  ),
                ),
              if (_activatedRateAlert != null)
                Align(
                  alignment: AlignmentDirectional.topCenter,
                  child: RateAlertOverlay(
                    alert: _activatedRateAlert!,
                    activated: true,
                  ),
                ),
            ],
          ),
          bottomNavigationBar: desktop
              ? null
              : Padding(
                  padding: EdgeInsets.fromLTRB(
                    isCustomerShell ? 10 : 0,
                    isCustomerShell ? 6 : 0,
                    isCustomerShell ? 10 : 0,
                    isCustomerShell ? 10 : 0,
                  ),
                  child: DecoratedBox(
                    decoration: BoxDecoration(
                      color: isExecutorShell
                          ? ExecutorUiColors.surface(context)
                          : Theme.of(context).colorScheme.surface,
                      borderRadius: isCustomerShell
                          ? BorderRadius.circular(8)
                          : BorderRadius.zero,
                      border: Border.all(
                        color: isCustomerShell
                            ? AhramColors.gold.withValues(alpha: 0.28)
                            : Theme.of(context).colorScheme.outlineVariant,
                      ),
                      boxShadow: [
                        BoxShadow(
                          color: _navy.withValues(
                            alpha: isCustomerShell ? 0.18 : 0.08,
                          ),
                          blurRadius: isCustomerShell ? 18 : 16,
                          offset: const Offset(0, -4),
                        ),
                        if (isCustomerShell)
                          BoxShadow(
                            color: AhramColors.gold.withValues(alpha: 0.11),
                            blurRadius: 0,
                            offset: const Offset(0, 5),
                          ),
                      ],
                    ),
                    child: ClipRRect(
                      borderRadius: isCustomerShell
                          ? BorderRadius.circular(8)
                          : BorderRadius.zero,
                      child: NavigationBar(
                        selectedIndex: _index,
                        onDestinationSelected: (next) =>
                            setState(() => _index = next),
                        destinations: _items
                            .map(
                              (item) => NavigationDestination(
                                icon: isExecutorShell
                                    ? ExecutorMetalIcon(
                                        icon: item.icon,
                                        size: 34,
                                      )
                                    : GlassIconBadge(icon: item.icon),
                                selectedIcon: isExecutorShell
                                    ? ExecutorMetalIcon(
                                        icon: item.icon,
                                        size: 36,
                                        selected: true,
                                      )
                                    : GlassIconBadge(
                                        icon: item.icon,
                                        selected: true,
                                      ),
                                label: item.label,
                              ),
                            )
                            .toList(),
                      ),
                    ),
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
    required this.language,
  });

  final SessionController controller;
  final AppearanceController appearance;
  final LanguageController language;

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
    if (saved == true && mounted) {
      showSnack(
        context,
        localized(
          context,
          'تم تحديث بيانات الحساب.',
          'Account details updated.',
        ),
      );
    }
  }

  Future<void> _showDevices() async {
    await showDialog<void>(
      context: context,
      builder: (context) =>
          _CustomerDevicesDialog(controller: widget.controller),
    );
  }

  Future<void> _manageAuthenticator() async {
    await showDialog<void>(
      context: context,
      builder: (context) => _AuthenticatorDialog(controller: widget.controller),
    );
  }

  Future<void> _changePassword() async {
    final changed = await showDialog<bool>(
      context: context,
      builder: (context) =>
          _CustomerPasswordDialog(controller: widget.controller),
    );
    if (changed == true && mounted) {
      showSnack(
        context,
        localized(
          context,
          'تم تغيير كلمة المرور. سجّل الدخول بكلمة المرور الجديدة.',
          'Password changed. Sign in with your new password.',
        ),
      );
    }
  }

  Future<void> _openSupport() async {
    final created = await showDialog<bool>(
      context: context,
      builder: (context) => TicketDialog(api: widget.controller.api),
    );
    if (created == true && mounted) {
      showSnack(
        context,
        localized(
          context,
          'تم فتح تذكرة الدعم بنجاح.',
          'Support ticket opened successfully.',
        ),
      );
    }
  }

  Future<void> _openWhatsAppSupport() async {
    final opened = await openExternalLink(
      Uri.parse('https://wa.me/201108172258'),
    );
    if (opened) return;
    await Clipboard.setData(const ClipboardData(text: '01108172258'));
    if (mounted) {
      showSnack(
        context,
        localized(
          context,
          'تم نسخ رقم واتساب الدعم.',
          'Support WhatsApp number copied.',
        ),
        error: true,
      );
    }
  }

  Future<void> _showPolicy() async {
    await showDialog<void>(
      context: context,
      builder: (context) => const _CustomerUsagePolicyDialog(),
    );
  }

  Future<void> _chooseLanguage() async {
    await showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      builder: (sheetContext) => _CustomerLanguageSheet(
        controller: widget.language,
        onSelected: (mode) async {
          await widget.language.setMode(mode);
          if (sheetContext.mounted) Navigator.pop(sheetContext);
        },
      ),
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
      if (mounted) {
        showSnack(
          context,
          localized(
            context,
            'اختر صورة أصغر من 2 ميجابايت.',
            'Choose an image smaller than 2 MB.',
          ),
          error: true,
        );
      }
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
      if (mounted) {
        showSnack(
          context,
          localized(
            context,
            'تم تحديث الصورة الشخصية.',
            'Profile photo updated.',
          ),
        );
      }
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

  String _joinedAt(BuildContext context, Object? value) {
    final parsed = DateTime.tryParse('${value ?? ''}');
    if (parsed == null) return localized(context, 'غير مسجل', 'Not available');
    final locale = usesEnglish(context) ? 'en' : 'ar';
    final prefix = localized(context, 'انضم في', 'Joined');
    return '$prefix ${DateFormat('d MMMM yyyy', locale).format(parsed.toLocal())}';
  }

  @override
  Widget build(BuildContext context) {
    String t(String arabic, String english) =>
        localized(context, arabic, english);
    final session = widget.controller.session!;
    final contextData = session.context;
    final profileRaw = contextData['profile'];
    final profile = profileRaw is Map
        ? Map<String, dynamic>.from(profileRaw)
        : <String, dynamic>{};
    final isAgentCustomer =
        session.accountType == 'sub_client' ||
        session.persona.toLowerCase() == 'agentclient';
    final agentName = _value(
      contextData['agentName'] ?? contextData['masterName'],
      fallback: t('غير مسجل', 'Not available'),
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
      title: t('الحساب', 'Account'),
      subtitle: t(
        'ملفك الشخصي وبيانات حسابك في الأهرام.',
        'Your personal profile and Ahram account details.',
      ),
      onRefresh: _refresh,
      action: OutlinedButton.icon(
        onPressed: _manageAuthenticator,
        icon: const Icon(Icons.shield_outlined, size: 18),
        label: Text(t('الحماية', 'Security')),
      ),
      child: [
        ExecutorSurface(
          accent: ExecutorUiColors.cobalt,
          elevated: false,
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
                style: Theme.of(
                  context,
                ).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w900),
              ),
              const SizedBox(height: 8),
              Container(
                padding: const EdgeInsetsDirectional.fromSTEB(10, 6, 10, 6),
                decoration: BoxDecoration(
                  color: statusColor.withValues(alpha: 0.10),
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(
                    color: statusColor.withValues(alpha: 0.25),
                  ),
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
                      isActive
                          ? t('حساب نشط', 'Active account')
                          : t('حساب معلق', 'Suspended account'),
                      style: TextStyle(
                        color: statusColor,
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 14),
              OutlinedButton.icon(
                onPressed: () => _editProfile(profile),
                icon: const Icon(Icons.edit_outlined),
                label: Text(t('تعديل البيانات', 'Edit details')),
              ),
            ],
          ),
        ),
        const SizedBox(height: 14),
        _CustomerProfileSection(
          title: t('بيانات العميل', 'Customer details'),
          icon: Icons.badge_outlined,
          children: [
            _CustomerProfileRow(
              icon: Icons.person_outline,
              label: t('اسم العميل', 'Customer name'),
              value: session.name,
            ),
            _CustomerProfileRow(
              icon: Icons.phone_outlined,
              label: t('رقم الهاتف', 'Phone number'),
              value: _value(
                profile['phone'],
                fallback: t('غير مسجل', 'Not available'),
              ),
              ltr: true,
            ),
            _CustomerProfileRow(
              icon: Icons.location_on_outlined,
              label: t('العنوان', 'Address'),
              value: _value(
                profile['address'],
                fallback: t('غير مسجل', 'Not available'),
              ),
              last: true,
            ),
          ],
        ),
        const SizedBox(height: 14),
        _CustomerProfileSection(
          title: t('بيانات الحساب', 'Account details'),
          icon: Icons.account_balance_wallet_outlined,
          children: [
            _CustomerProfileRow(
              icon: Icons.alternate_email_outlined,
              label: t('اسم المستخدم', 'Username'),
              value: _value(
                profile['username'],
                fallback: t('غير مسجل', 'Not available'),
              ),
              ltr: true,
            ),
            _CustomerProfileRow(
              icon: Icons.groups_2_outlined,
              label: t('نوع الحساب', 'Account type'),
              value: isAgentCustomer
                  ? t('عميل وكيل', 'Agent customer')
                  : t('عميل مباشر', 'Direct customer'),
            ),
            _CustomerProfileRow(
              icon: Icons.account_balance_outlined,
              label: isAgentCustomer
                  ? t('الوكيل', 'Agent')
                  : t('الجهة المسؤولة', 'Account provider'),
              value: isAgentCustomer
                  ? agentName
                  : t('شركة الأهرام', 'Ahram Pay'),
            ),
            if (isAgentCustomer && agencyCode.isNotEmpty)
              _CustomerProfileRow(
                icon: Icons.numbers_outlined,
                label: t('رقم حساب الوكالة', 'Agency account number'),
                value: agencyCode,
                copyable: true,
                ltr: true,
              ),
            _CustomerProfileRow(
              icon: Icons.calendar_month_outlined,
              label: t('تاريخ الانضمام', 'Member since'),
              value: _joinedAt(context, profile['joinedAt']),
              ltr: true,
              last: !hasAccountCode,
            ),
            if (hasAccountCode)
              _CustomerProfileRow(
                icon: Icons.content_copy_outlined,
                label: t('رمز الحساب', 'Account code'),
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
          title: t('الأمان', 'Security'),
          icon: Icons.shield_outlined,
          children: [
            _CustomerActionRow(
              icon: Icons.lock_reset_outlined,
              title: t('تغيير كلمة المرور', 'Change password'),
              subtitle: t(
                'سيتم تسجيل خروجك من كل الأجهزة بعد التغيير.',
                'Changing it signs out all other devices.',
              ),
              onTap: _changePassword,
            ),
            _CustomerActionRow(
              icon: Icons.phonelink_lock_outlined,
              title: t(
                'Authenticator والحماية الإضافية',
                'Authenticator security',
              ),
              subtitle: t(
                'ثقة مستقلة للموقع والتطبيق لمدة 24 ساعة لكل منهما.',
                'Separate 24-hour trust for one web and one app session.',
              ),
              onTap: _manageAuthenticator,
            ),
            _CustomerActionRow(
              icon: Icons.devices_outlined,
              title: t('الأجهزة المسجل منها الدخول', 'Signed-in devices'),
              subtitle: t(
                'عرض آخر الأجهزة التي سجلت الدخول إلى الحساب.',
                'Review devices with access to this account.',
              ),
              onTap: _showDevices,
              last: true,
            ),
          ],
        ),
        const SizedBox(height: 14),
        _CustomerProfileSection(
          title: t('التفضيلات', 'Preferences'),
          icon: Icons.tune_outlined,
          children: [
            _CustomerPreferenceRow(
              icon: widget.appearance.isDark
                  ? Icons.dark_mode_outlined
                  : Icons.light_mode_outlined,
              title: t('الوضع الليلي', 'Dark mode'),
              subtitle: t(
                'ألوان مريحة للقراءة في الإضاءة المنخفضة.',
                'Comfortable colours for low-light reading.',
              ),
              value: widget.appearance.isDark,
              onChanged: (_) => widget.appearance.toggle(),
            ),
            _CustomerPreferenceRow(
              icon: Icons.notifications_active_outlined,
              title: t('إشعارات التطبيق', 'App notifications'),
              subtitle: t(
                'تنبيهات العمليات وردود الدعم على هذا الجهاز.',
                'Transaction and support updates on this device.',
              ),
              value: widget.controller.customerNotificationsEnabled,
              onChanged: (value) => unawaited(_setCustomerNotifications(value)),
            ),
            _CustomerActionRow(
              icon: Icons.language_outlined,
              title: t('لغة التطبيق', 'App language'),
              subtitle: switch (widget.language.mode) {
                AppLanguageMode.system => t(
                  'تلقائي حسب لغة الهاتف',
                  'Automatic (phone language)',
                ),
                AppLanguageMode.arabic => t('العربية', 'Arabic'),
                AppLanguageMode.english => t('الإنجليزية', 'English'),
              },
              trailing: Icon(
                usesEnglish(context) ? Icons.chevron_right : Icons.chevron_left,
              ),
              last: true,
              onTap: _chooseLanguage,
            ),
          ],
        ),
        const SizedBox(height: 14),
        _CustomerProfileSection(
          title: t('الدعم', 'Support'),
          icon: Icons.support_agent_outlined,
          children: [
            _CustomerActionRow(
              icon: Icons.chat_outlined,
              title: t('فتح محادثة دعم', 'Open a support chat'),
              subtitle: t(
                'أرسل طلبك مباشرة إلى فريق الدعم.',
                'Send a request directly to the support team.',
              ),
              onTap: _openSupport,
            ),
            _CustomerActionRow(
              icon: Icons.chat_bubble_outline,
              title: t('واتساب الدعم', 'Support WhatsApp'),
              subtitle: t(
                '01108172258 - واتساب فقط',
                '01108172258 - WhatsApp only',
              ),
              onTap: _openWhatsAppSupport,
            ),
            _CustomerActionRow(
              icon: Icons.policy_outlined,
              title: t('سياسة الاستخدام', 'Terms of use'),
              subtitle: t(
                'خصوصية الحساب ومسؤولية إدخال البيانات.',
                'Account privacy and data-entry responsibility.',
              ),
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
                style: Theme.of(
                  context,
                ).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w900),
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

class _AuthenticatorDialog extends StatefulWidget {
  const _AuthenticatorDialog({required this.controller});

  final SessionController controller;

  @override
  State<_AuthenticatorDialog> createState() => _AuthenticatorDialogState();
}

class _AuthenticatorDialogState extends State<_AuthenticatorDialog> {
  late Future<Map<String, dynamic>> _statusFuture;
  Map<String, dynamic>? _setup;
  final _token = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _statusFuture = widget.controller.api.mfaStatus();
  }

  @override
  void dispose() {
    _token.dispose();
    super.dispose();
  }

  String t(String arabic, String english) =>
      localized(context, arabic, english);

  Future<void> _startSetup() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final setup = await widget.controller.api.beginMfaSetup();
      if (mounted) setState(() => _setup = setup);
    } on ApiFailure catch (error) {
      if (mounted) setState(() => _error = error.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _confirm() async {
    final setup = _setup;
    final token = _token.text.trim();
    final codes = (setup?['recoveryCodes'] as List? ?? const [])
        .map((item) => '$item')
        .toList();
    if (setup == null || !RegExp(r'^\d{6}$').hasMatch(token)) {
      setState(
        () => _error = t(
          'أدخل رمز Authenticator المكون من 6 أرقام.',
          'Enter the 6-digit Authenticator code.',
        ),
      );
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await widget.controller.api.confirmMfaSetup(
        secret: '${setup['secret'] ?? ''}',
        token: token,
        recoveryCodes: codes,
      );
      if (mounted) {
        await showDialog<void>(
          context: context,
          builder: (context) => AlertDialog(
            title: Text(t('تم تفعيل Authenticator', 'Authenticator enabled')),
            content: Text(
              t(
                'احفظ رموز الاسترداد في مكان آمن. سيبقى هذا الجهاز موثوقاً لمدة 24 ساعة فقط.',
                'Save the recovery codes securely. This device is trusted for 24 hours only.',
              ),
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(context),
                child: const Text('حسناً'),
              ),
            ],
          ),
        );
        if (mounted) Navigator.pop(context);
      }
    } on ApiFailure catch (error) {
      if (mounted) setState(() => _error = error.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _disable() async {
    final token = _token.text.trim();
    if (token.isEmpty) {
      setState(
        () => _error = t(
          'أدخل رمز Authenticator أو رمز استرداد.',
          'Enter an Authenticator or recovery code.',
        ),
      );
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await widget.controller.api.disableMfa(token);
      if (mounted) Navigator.pop(context);
    } on ApiFailure catch (error) {
      if (mounted) setState(() => _error = error.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Row(
        children: [
          const Icon(Icons.phonelink_lock_outlined),
          const SizedBox(width: 8),
          Expanded(
            child: Text(t('المصادقة الثنائية', 'Two-factor authentication')),
          ),
        ],
      ),
      content: SizedBox(
        width: 470,
        child: FutureBuilder<Map<String, dynamic>>(
          future: _statusFuture,
          builder: (context, snapshot) {
            if (snapshot.connectionState != ConnectionState.done) {
              return const SizedBox(
                height: 130,
                child: Center(child: CircularProgressIndicator()),
              );
            }
            if (snapshot.hasError) {
              return Text(
                t(
                  'تعذر تحميل حالة الحماية.',
                  'Unable to load security status.',
                ),
              );
            }
            final enabled = snapshot.data?['enabled'] == true;
            if (enabled && _setup == null) {
              return Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Text(
                    t(
                      'Authenticator مفعّل لهذا الحساب.',
                      'Authenticator is enabled for this account.',
                    ),
                  ),
                  const SizedBox(height: 10),
                  Text(
                    t(
                      'الجهاز الموثوق صالح لمدة 24 ساعة فقط، وبعدها يطلب رمز جديد.',
                      'The trusted device expires after 24 hours and then requires a new code.',
                    ),
                  ),
                  const SizedBox(height: 16),
                  TextField(
                    controller: _token,
                    keyboardType: TextInputType.text,
                    maxLength: 8,
                    decoration: InputDecoration(
                      labelText: t(
                        'رمز Authenticator أو الاسترداد',
                        'Authenticator or recovery code',
                      ),
                    ),
                  ),
                  if (_error != null)
                    InlineMessage(message: _error!, color: _danger),
                  const SizedBox(height: 8),
                  FilledButton.icon(
                    onPressed: _busy ? null : _disable,
                    icon: const Icon(Icons.remove_circle_outline),
                    label: Text(
                      t('إيقاف Authenticator', 'Disable Authenticator'),
                    ),
                  ),
                ],
              );
            }
            final setup = _setup;
            return Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(
                  t(
                    'فعّل Authenticator من Google أو Microsoft Authenticator. سيظهر مفتاح الإعداد مرة واحدة فقط.',
                    'Enable Authenticator with Google or Microsoft Authenticator. The setup key is shown once.',
                  ),
                ),
                if (setup == null) ...[
                  const SizedBox(height: 16),
                  FilledButton.icon(
                    onPressed: _busy ? null : _startSetup,
                    icon: const Icon(Icons.qr_code_2_outlined),
                    label: Text(t('بدء الإعداد', 'Start setup')),
                  ),
                ] else ...[
                  const SizedBox(height: 14),
                  SelectableText(
                    '${setup['secret'] ?? ''}',
                    textAlign: TextAlign.center,
                    style: const TextStyle(
                      fontWeight: FontWeight.w900,
                      letterSpacing: 2,
                    ),
                  ),
                  const SizedBox(height: 8),
                  TextButton.icon(
                    onPressed: () => Clipboard.setData(
                      ClipboardData(text: '${setup['qrUri'] ?? ''}'),
                    ),
                    icon: const Icon(Icons.copy_outlined),
                    label: Text(t('نسخ رابط الإعداد', 'Copy setup URI')),
                  ),
                  Text(
                    t(
                      'رموز الاسترداد (احفظها الآن):',
                      'Recovery codes (save them now):',
                    ),
                    style: const TextStyle(fontWeight: FontWeight.w800),
                  ),
                  SelectableText(
                    (setup['recoveryCodes'] as List? ?? const []).join('  '),
                  ),
                  const SizedBox(height: 10),
                  TextField(
                    controller: _token,
                    keyboardType: TextInputType.number,
                    maxLength: 6,
                    decoration: InputDecoration(
                      labelText: t('رمز التفعيل', 'Activation code'),
                    ),
                  ),
                  if (_error != null)
                    InlineMessage(message: _error!, color: _danger),
                  FilledButton.icon(
                    onPressed: _busy ? null : _confirm,
                    icon: const Icon(Icons.verified_outlined),
                    label: Text(t('تأكيد التفعيل', 'Confirm activation')),
                  ),
                ],
              ],
            );
          },
        ),
      ),
      actions: [
        OutlinedButton.icon(
          onPressed: _busy
              ? null
              : () => showDialog<void>(
                  context: context,
                  builder: (context) =>
                      _CustomerDevicesDialog(controller: widget.controller),
                ),
          icon: const Icon(Icons.devices_outlined),
          label: Text(t('الأجهزة والجلسات', 'Devices and sessions')),
        ),
        TextButton(
          onPressed: _busy ? null : () => Navigator.pop(context),
          child: Text(t('إغلاق', 'Close')),
        ),
      ],
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
                  tooltip: localized(
                    context,
                    'نسخ رمز الحساب',
                    'Copy account code',
                  ),
                  onPressed: () {
                    Clipboard.setData(ClipboardData(text: value));
                    showSnack(
                      context,
                      localized(
                        context,
                        'تم نسخ رمز الحساب.',
                        'Account code copied.',
                      ),
                    );
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
          SectionTitle(
            title: localized(
              context,
              'الرصيد والحد الائتماني',
              'Balance and credit limit',
            ),
            icon: Icons.account_balance_wallet_outlined,
          ),
          const SizedBox(height: 12),
          Row(
            children: [
              Expanded(
                child: _CustomerMoneyMetric(
                  label: localized(
                    context,
                    'الرصيد المتاح',
                    'Available balance',
                  ),
                  value: available,
                  color: available < 0 ? _danger : _green,
                ),
              ),
              Container(width: 1, height: 48, color: colors.outlineVariant),
              Expanded(
                child: _CustomerMoneyMetric(
                  label: localized(context, 'الحد الائتماني', 'Credit limit'),
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
          '${formatAmount(value)} ${localized(context, 'د.ل', 'LYD')}',
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
    this.trailing,
    this.last = false,
    this.onTap,
  });

  final IconData icon;
  final String title;
  final String subtitle;
  final Widget? trailing;
  final bool last;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final rowColor = Theme.of(context).colorScheme.primary;
    return Column(
      children: [
        ListTile(
          contentPadding: EdgeInsets.zero,
          leading: Icon(icon, color: rowColor),
          title: Text(
            title,
            style: const TextStyle(fontWeight: FontWeight.w800),
          ),
          subtitle: Text(subtitle),
          trailing:
              trailing ??
              (onTap == null
                  ? null
                  : Icon(
                      usesEnglish(context)
                          ? Icons.chevron_right
                          : Icons.chevron_left,
                    )),
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
          title: Text(
            title,
            style: const TextStyle(fontWeight: FontWeight.w800),
          ),
          subtitle: Text(subtitle),
          value: value,
          onChanged: onChanged,
        ),
        const Divider(height: 1),
      ],
    );
  }
}

class _CustomerLanguageSheet extends StatelessWidget {
  const _CustomerLanguageSheet({
    required this.controller,
    required this.onSelected,
  });

  final LanguageController controller;
  final ValueChanged<AppLanguageMode> onSelected;

  @override
  Widget build(BuildContext context) {
    final english = usesEnglish(context);
    String t(String arabic, String englishText) =>
        english ? englishText : arabic;
    final options =
        <
          ({AppLanguageMode mode, String title, String subtitle, IconData icon})
        >[
          (
            mode: AppLanguageMode.system,
            title: t('تلقائي حسب لغة الهاتف', 'Automatic (phone language)'),
            subtitle: t(
              'استخدم لغة الجهاز تلقائياً.',
              'Use the device language automatically.',
            ),
            icon: Icons.settings_suggest_outlined,
          ),
          (
            mode: AppLanguageMode.arabic,
            title: 'العربية',
            subtitle: t(
              'واجهة عربية من اليمين إلى اليسار.',
              'Arabic right-to-left interface.',
            ),
            icon: Icons.translate_outlined,
          ),
          (
            mode: AppLanguageMode.english,
            title: 'English',
            subtitle: t(
              'واجهة إنجليزية من اليسار إلى اليمين.',
              'English left-to-right interface.',
            ),
            icon: Icons.language_outlined,
          ),
        ];

    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 4, 20, 24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              t('لغة التطبيق', 'App language'),
              style: Theme.of(
                context,
              ).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w900),
            ),
            const SizedBox(height: 8),
            Text(
              t(
                'يمكنك العودة إلى لغة الهاتف في أي وقت.',
                'You can return to your phone language at any time.',
              ),
              style: TextStyle(
                color: Theme.of(context).colorScheme.onSurfaceVariant,
              ),
            ),
            const SizedBox(height: 12),
            RadioGroup<AppLanguageMode>(
              groupValue: controller.mode,
              onChanged: (value) {
                if (value != null) onSelected(value);
              },
              child: Column(
                children: options
                    .map(
                      (option) => RadioListTile<AppLanguageMode>(
                        contentPadding: EdgeInsets.zero,
                        value: option.mode,
                        title: Text(
                          option.title,
                          style: const TextStyle(fontWeight: FontWeight.w800),
                        ),
                        subtitle: Text(option.subtitle),
                        secondary: Icon(
                          option.icon,
                          color: Theme.of(context).colorScheme.primary,
                        ),
                      ),
                    )
                    .toList(),
              ),
            ),
          ],
        ),
      ),
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
  State<_CustomerProfileEditDialog> createState() =>
      _CustomerProfileEditDialogState();
}

class _CustomerProfileEditDialogState
    extends State<_CustomerProfileEditDialog> {
  late final TextEditingController _name = TextEditingController(
    text: widget.initialName,
  );
  late final TextEditingController _address = TextEditingController(
    text: widget.initialAddress,
  );
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
    String t(String arabic, String english) =>
        localized(context, arabic, english);
    return AlertDialog(
      title: Text(t('تعديل بيانات الحساب', 'Edit account details')),
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
                  decoration: InputDecoration(
                    labelText: t('الاسم الثلاثي', 'Full name'),
                  ),
                  validator: (value) => (value ?? '').trim().length < 3
                      ? t('اكتب الاسم الثلاثي.', 'Enter your full name.')
                      : null,
                ),
                const SizedBox(height: 12),
                TextFormField(
                  controller: _address,
                  maxLength: 200,
                  decoration: InputDecoration(
                    labelText: t('العنوان', 'Address'),
                  ),
                ),
                const SizedBox(height: 6),
                TextFormField(
                  initialValue: widget.phone,
                  enabled: false,
                  textDirection: ui.TextDirection.ltr,
                  decoration: InputDecoration(
                    labelText: t('رقم الهاتف', 'Phone number'),
                    helperText: t(
                      'لتعديل الرقم يرجى تقديم طلب رسمي للدعم.',
                      'Contact support to request a phone number change.',
                    ),
                  ),
                ),
                const SizedBox(height: 12),
                TextFormField(
                  initialValue: widget.username,
                  enabled: false,
                  textDirection: ui.TextDirection.ltr,
                  decoration: InputDecoration(
                    labelText: t('اسم المستخدم', 'Username'),
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
          child: Text(t('إلغاء', 'Cancel')),
        ),
        FilledButton(
          onPressed: _busy ? null : _save,
          child: Text(
            _busy
                ? t('جارٍ الحفظ...', 'Saving...')
                : t('حفظ التعديل', 'Save changes'),
          ),
        ),
      ],
    );
  }
}

class _CustomerPasswordDialog extends StatefulWidget {
  const _CustomerPasswordDialog({required this.controller});

  final SessionController controller;

  @override
  State<_CustomerPasswordDialog> createState() =>
      _CustomerPasswordDialogState();
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
    String t(String arabic, String english) =>
        localized(context, arabic, english);
    return AlertDialog(
      title: Text(t('تغيير كلمة المرور', 'Change password')),
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
                decoration: InputDecoration(
                  labelText: t('كلمة المرور الحالية', 'Current password'),
                ),
                validator: (value) => (value ?? '').isEmpty
                    ? t('هذا الحقل مطلوب.', 'This field is required.')
                    : null,
              ),
              const SizedBox(height: 12),
              TextFormField(
                controller: _next,
                obscureText: true,
                decoration: InputDecoration(
                  labelText: t('كلمة المرور الجديدة', 'New password'),
                ),
                validator: (value) => (value ?? '').length < 8
                    ? t(
                        'يجب أن تتكون كلمة المرور من 8 أحرف على الأقل.',
                        'Password must be at least 8 characters long.',
                      )
                    : null,
              ),
              const SizedBox(height: 12),
              TextFormField(
                controller: _confirm,
                obscureText: true,
                decoration: InputDecoration(
                  labelText: t(
                    'تأكيد كلمة المرور الجديدة',
                    'Confirm new password',
                  ),
                ),
                validator: (value) => value != _next.text
                    ? t(
                        'كلمتا المرور غير متطابقتين.',
                        'Passwords do not match.',
                      )
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
          child: Text(t('إلغاء', 'Cancel')),
        ),
        FilledButton(
          onPressed: _busy ? null : _save,
          child: Text(
            _busy
                ? t('جارٍ الحفظ...', 'Saving...')
                : t('تغيير كلمة المرور', 'Change password'),
          ),
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
  Map<String, dynamic>? _data;
  Object? _error;
  String? _busyId;

  String t(String arabic, String english) =>
      localized(context, arabic, english);

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final data = await widget.controller.securitySessions();
      if (mounted) {
        setState(() {
          _data = data;
          _error = null;
        });
      }
    } catch (error) {
      if (mounted) setState(() => _error = error);
    }
  }

  List<Map<String, dynamic>> _items(String key) {
    final raw = _data?[key];
    if (raw is! List) return <Map<String, dynamic>>[];
    return raw
        .whereType<Map>()
        .map((item) => Map<String, dynamic>.from(item))
        .toList();
  }

  Future<void> _revoke(Map<String, dynamic> device) async {
    final id = '${device['id'] ?? ''}';
    if (id.isEmpty) return;
    final approved = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(t('إنهاء الجلسة', 'End session')),
        content: Text(
          t(
            device['current'] == true
                ? 'سيتم تسجيل خروجك من هذا التطبيق. هل تريد المتابعة؟'
                : 'سيتم منع هذا الجهاز من الوصول إلى الحساب.',
            device['current'] == true
                ? 'You will be signed out of this app. Continue?'
                : 'This device will no longer have access to the account.',
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: Text(t('إلغاء', 'Cancel')),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: Text(t('إنهاء', 'End')),
          ),
        ],
      ),
    );
    if (approved != true || !mounted) return;
    setState(() => _busyId = id);
    try {
      final response = await widget.controller.revokeSecuritySession(id);
      if (response['currentRevoked'] == true) {
        await widget.controller.clearLocalSession();
        if (mounted) Navigator.of(context).popUntil((route) => route.isFirst);
        return;
      }
      await _load();
      if (mounted) showSnack(context, t('تم إنهاء الجلسة.', 'Session ended.'));
    } on ApiFailure catch (error) {
      if (mounted) showSnack(context, error.message, error: true);
    } finally {
      if (mounted) setState(() => _busyId = null);
    }
  }

  Future<void> _review(Map<String, dynamic> request, bool approve) async {
    final id = '${request['id'] ?? ''}';
    if (id.isEmpty) return;
    setState(() => _busyId = id);
    try {
      final response = await widget.controller.reviewSecuritySessionRequest(
        id: id,
        approve: approve,
      );
      if (approve && response['channel'] == 'app') {
        await widget.controller.clearLocalSession();
        if (mounted) Navigator.of(context).popUntil((route) => route.isFirst);
        return;
      }
      await _load();
      if (mounted) {
        showSnack(
          context,
          approve
              ? t('تم اعتماد الجهاز الجديد.', 'New device approved.')
              : t('تم رفض طلب الجهاز.', 'Device request rejected.'),
        );
      }
    } on ApiFailure catch (error) {
      if (mounted) showSnack(context, error.message, error: true);
    } finally {
      if (mounted) setState(() => _busyId = null);
    }
  }

  String _channelLabel(Object? value) =>
      value == 'app' ? t('تطبيق الهاتف', 'Mobile app') : t('موقع الويب', 'Web');

  @override
  Widget build(BuildContext context) {
    String t(String arabic, String english) =>
        localized(context, arabic, english);
    return AlertDialog(
      title: Text(t('الأجهزة المسجل منها الدخول', 'Signed-in devices')),
      content: SizedBox(
        width: 500,
        child: _data == null && _error == null
            ? const SizedBox(
                height: 160,
                child: Center(child: CircularProgressIndicator()),
              )
            : _error != null
            ? Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Icon(
                    Icons.cloud_off_outlined,
                    size: 42,
                    color: _danger,
                  ),
                  const SizedBox(height: 10),
                  Text(t('تعذر تحميل الجلسات.', 'Unable to load sessions.')),
                  const SizedBox(height: 10),
                  OutlinedButton.icon(
                    onPressed: _load,
                    icon: const Icon(Icons.refresh),
                    label: Text(t('إعادة المحاولة', 'Retry')),
                  ),
                ],
              )
            : ConstrainedBox(
                constraints: const BoxConstraints(maxHeight: 520),
                child: ListView(
                  shrinkWrap: true,
                  children: [
                    Container(
                      padding: const EdgeInsets.all(12),
                      decoration: BoxDecoration(
                        color: _green.withValues(alpha: .08),
                        borderRadius: BorderRadius.circular(8),
                      ),
                      child: Text(
                        t(
                          'يمكنك استخدام موقع واحد وتطبيق واحد معًا. أي جهاز إضافي يحتاج موافقتك.',
                          'You can use one web session and one app session together. Any additional device requires your approval.',
                        ),
                        style: const TextStyle(
                          fontSize: 12,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                    ),
                    const SizedBox(height: 14),
                    Text(
                      t('الجلسات النشطة', 'Active sessions'),
                      style: const TextStyle(fontWeight: FontWeight.w900),
                    ),
                    const SizedBox(height: 6),
                    if (_items('devices').isEmpty)
                      Text(t('لا توجد جلسات مسجلة.', 'No sessions recorded.')),
                    ..._items('devices').map(
                      (device) => Card(
                        margin: const EdgeInsets.only(bottom: 8),
                        child: ListTile(
                          leading: Icon(
                            device['channel'] == 'app'
                                ? Icons.phone_android_outlined
                                : Icons.computer_outlined,
                            color: device['channel'] == 'app'
                                ? _green
                                : const Color(0xFF2563EB),
                          ),
                          title: Text(
                            '${device['displayName'] ?? _channelLabel(device['channel'])}',
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                          ),
                          subtitle: Text(
                            '${_channelLabel(device['channel'])} · ${t('آخر نشاط', 'Last active')}: ${formatDate(device['lastSeenAt'])}',
                          ),
                          trailing: _busyId == '${device['id']}'
                              ? const SizedBox.square(
                                  dimension: 20,
                                  child: CircularProgressIndicator(
                                    strokeWidth: 2,
                                  ),
                                )
                              : IconButton(
                                  tooltip: t('إنهاء الجلسة', 'End session'),
                                  onPressed: () => _revoke(device),
                                  icon: const Icon(
                                    Icons.logout,
                                    color: _danger,
                                  ),
                                ),
                        ),
                      ),
                    ),
                    const SizedBox(height: 12),
                    Text(
                      t('طلبات أجهزة جديدة', 'New device requests'),
                      style: const TextStyle(fontWeight: FontWeight.w900),
                    ),
                    const SizedBox(height: 6),
                    if (_items('requests').isEmpty)
                      Text(t('لا توجد طلبات معلقة.', 'No pending requests.')),
                    ..._items('requests').map(
                      (request) => Card(
                        margin: const EdgeInsets.only(bottom: 8),
                        child: Padding(
                          padding: const EdgeInsets.all(12),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                '${request['displayName'] ?? _channelLabel(request['channel'])}',
                                style: const TextStyle(
                                  fontWeight: FontWeight.w900,
                                ),
                              ),
                              const SizedBox(height: 3),
                              Text(
                                '${_channelLabel(request['channel'])} · ${request['requestCode'] ?? ''}',
                                style: Theme.of(context).textTheme.bodySmall,
                              ),
                              const SizedBox(height: 10),
                              if (_busyId == '${request['id']}')
                                const Center(child: CircularProgressIndicator())
                              else
                                Row(
                                  children: [
                                    Expanded(
                                      child: FilledButton.icon(
                                        onPressed: () => _review(request, true),
                                        icon: const Icon(Icons.check),
                                        label: Text(t('موافقة', 'Approve')),
                                      ),
                                    ),
                                    const SizedBox(width: 8),
                                    Expanded(
                                      child: OutlinedButton.icon(
                                        onPressed: () =>
                                            _review(request, false),
                                        icon: const Icon(Icons.close),
                                        label: Text(t('رفض', 'Reject')),
                                      ),
                                    ),
                                  ],
                                ),
                            ],
                          ),
                        ),
                      ),
                    ),
                  ],
                ),
              ),
      ),
      actions: [
        IconButton(
          onPressed: _load,
          tooltip: t('تحديث', 'Refresh'),
          icon: const Icon(Icons.refresh),
        ),
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: Text(t('إغلاق', 'Close')),
        ),
      ],
    );
  }
}

class _CustomerUsagePolicyDialog extends StatelessWidget {
  const _CustomerUsagePolicyDialog();

  @override
  Widget build(BuildContext context) {
    String t(String arabic, String english) =>
        localized(context, arabic, english);
    return AlertDialog(
      title: Row(
        children: [
          const Icon(Icons.policy_outlined, color: _green),
          const SizedBox(width: 10),
          Text(t('سياسة استخدام Ahram Pay', 'Ahram Pay terms of use')),
        ],
      ),
      content: SizedBox(
        width: 480,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                t('آخر تحديث: 14 أغسطس 2026', 'Last updated: August 14, 2026'),
                style: TextStyle(color: Colors.grey, fontSize: 12),
              ),
              SizedBox(height: 14),
              _UsagePolicySection(
                title: t('استخدام الحساب', 'Using your account'),
                body: t(
                  'الحساب شخصي ومخصص لصاحبه المسجل فقط. يجب الحفاظ على صحة الاسم ورقم الهاتف والعنوان وإبلاغ الدعم عند أي تغيير رسمي.',
                  'Your account is personal and is for the registered owner only. Keep your name, phone number, and address accurate, and contact support for any official change.',
                ),
              ),
              _UsagePolicySection(
                title: t('حماية البيانات', 'Protecting your data'),
                body: t(
                  'لا تشارك اسم المستخدم أو كلمة المرور أو رمز التحقق مع أي شخص. يحق للنظام إنهاء الجلسات أو تعليق الحساب عند الاشتباه في استخدام غير مصرح به.',
                  'Do not share your username, password, or verification code with anyone. The system may end sessions or suspend an account when unauthorised use is suspected.',
                ),
              ),
              _UsagePolicySection(
                title: t('التحويلات المالية', 'Financial transfers'),
                body: t(
                  'يتحمل العميل مسؤولية مراجعة رقم المستلم والقيمة والخدمة قبل الإرسال. تظهر العملية في السجل بعد استلامها، وأي إلغاء أو استرجاع يخضع لحالة التنفيذ وقواعد الخدمة.',
                  'You are responsible for checking the recipient number, amount, and service before sending. A transfer appears in the activity log after receipt. Cancellations and reversals depend on execution status and service rules.',
                ),
              ),
              _UsagePolicySection(
                title: t('الإشعارات والدعم', 'Notifications and support'),
                body: t(
                  'يستخدم التطبيق الإشعارات لإبلاغك بالإيداعات والعمليات وردود الدعم. يمكن إيقافها من التفضيلات، بينما تظل التفاصيل الكاملة متاحة داخل الحساب.',
                  'The app uses notifications for deposits, transfers, and support replies. You can turn them off in Preferences while full details remain available in your account.',
                ),
              ),
              _UsagePolicySection(
                title: t('التواصل الرسمي', 'Official support'),
                body: t(
                  'للدعم استخدم تذاكر التطبيق أو رقم واتساب الدعم الظاهر في الحساب. لا يعتمد أي طلب لتعديل رقم الهاتف أو اسم المستخدم إلا بعد مراجعة رسمية من الإدارة.',
                  'Use in-app support tickets or the support WhatsApp number shown in your account. Requests to change a phone number or username require an official administration review.',
                ),
              ),
            ],
          ),
        ),
      ),
      actions: [
        FilledButton(
          onPressed: () => Navigator.pop(context),
          child: Text(t('فهمت', 'I understand')),
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

  Future<void> _openAuthenticator() async {
    await showDialog<void>(
      context: context,
      builder: (context) => _AuthenticatorDialog(controller: widget.controller),
    );
  }

  @override
  Widget build(BuildContext context) {
    if (_loading && _home == null) return const PageLoading();
    if (_error != null && _home == null) {
      return ErrorPage(error: _error!, onRetry: _load);
    }
    final session = widget.controller.session!;
    final home = _home ?? <String, dynamic>{};
    final balance = numberValue(home['balance'], session.balance);
    final english = usesEnglish(context);
    return PageFrame(
      title: widget.controller.isCompany ? 'ملخص الشركة' : 'مساحة العميل',
      subtitle: widget.controller.isCompany
          ? 'متابعة الرصيد وأسعار الخدمات والعمليات الجارية.'
          : 'كل ما تحتاجه لإدارة تحويلاتك في واجهة واحدة.',
      onRefresh: _load,
      action: OutlinedButton.icon(
        onPressed: _openAuthenticator,
        icon: const Icon(Icons.shield_outlined, size: 18),
        label: Text(english ? 'Security' : 'الحماية'),
      ),
      child: [
        CustomerWelcomePanel(
          name: session.name,
          role: widget.controller.isCompany ? 'حساب شركة' : 'حساب عميل',
          balance: balance,
          showBalance: !widget.controller.hidesBalance,
          systemOpen: home['isOpen'] != false,
          onSecurity: _openAuthenticator,
        ),
        if (session.availableToSpend != null &&
            !widget.controller.hidesBalance) ...[
          const SizedBox(height: 18),
          StatTile(
            label: 'المتاح للتحويل',
            value: formatAmount(session.availableToSpend),
            suffix: 'د.ل',
            icon: Icons.account_balance_wallet_outlined,
            color: const Color(0xFF3366CC),
          ),
        ],
        const SizedBox(height: 18),
        CustomerHomeSection(
          title: english ? 'Your workspace' : 'مساحتك اليومية',
          subtitle: english
              ? 'Quick access to the actions you use most.'
              : 'وصول سريع إلى الأدوات التي تستخدمها أكثر.',
          children: [
            CustomerQuickTile(
              icon: Icons.send_to_mobile_outlined,
              title: english ? 'New transfer' : 'تحويل جديد',
              caption: english ? 'Send money securely' : 'ابدأ طلب تحويل آمن',
              color: AhramColors.sky,
            ),
            CustomerQuickTile(
              icon: Icons.currency_exchange_outlined,
              title: english ? 'Exchange rates' : 'أسعار الصرف',
              caption: english
                  ? 'Live rates and calculator'
                  : 'الأسعار الحالية والحاسبة',
              color: AhramColors.emerald,
            ),
            CustomerQuickTile(
              icon: Icons.receipt_long_outlined,
              title: english ? 'Activity' : 'سجل العمليات',
              caption: english
                  ? 'Track your recent requests'
                  : 'تابع طلباتك الأخيرة',
              color: AhramColors.gold,
            ),
            CustomerQuickTile(
              icon: Icons.support_agent_outlined,
              title: english ? 'Support' : 'الدعم الفني',
              caption: english ? 'We are ready to help' : 'نحن جاهزون لمساعدتك',
              color: const Color(0xFF7C5CFC),
            ),
          ],
        ),
      ],
    );
  }
}

class CustomerWelcomePanel extends StatelessWidget {
  const CustomerWelcomePanel({
    super.key,
    required this.name,
    required this.role,
    required this.balance,
    required this.showBalance,
    required this.systemOpen,
    required this.onSecurity,
  });

  final String name;
  final String role;
  final double balance;
  final bool showBalance;
  final bool systemOpen;
  final VoidCallback onSecurity;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final dark = Theme.of(context).brightness == Brightness.dark;
    final balanceColor = balance < 0
        ? colors.error
        : balance > 0
        ? AhramColors.emerald
        : colors.onSurfaceVariant;
    return TweenAnimationBuilder<double>(
      tween: Tween(begin: 0.96, end: 1),
      duration: const Duration(milliseconds: 520),
      curve: Curves.easeOutCubic,
      builder: (context, scale, child) => Transform.scale(
        scale: scale,
        alignment: AlignmentDirectional.topCenter,
        child: child,
      ),
      child: Container(
        padding: const EdgeInsets.all(20),
        decoration: BoxDecoration(
          color: dark ? const Color(0xFF142C3B) : Colors.white,
          borderRadius: BorderRadius.circular(18),
          border: Border.all(color: AhramColors.gold.withValues(alpha: 0.42)),
          boxShadow: [
            BoxShadow(
              color: AhramColors.ink.withValues(alpha: dark ? 0.28 : 0.10),
              blurRadius: 24,
              offset: const Offset(0, 12),
            ),
          ],
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const BrandMark(compact: true),
                const Spacer(),
                Container(
                  padding: const EdgeInsetsDirectional.fromSTEB(10, 6, 10, 6),
                  decoration: BoxDecoration(
                    color: (systemOpen ? AhramColors.emerald : colors.error)
                        .withValues(alpha: 0.10),
                    borderRadius: BorderRadius.circular(20),
                  ),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Icon(
                        systemOpen
                            ? Icons.check_circle_outline
                            : Icons.pause_circle_outline,
                        size: 17,
                        color: systemOpen ? AhramColors.emerald : colors.error,
                      ),
                      const SizedBox(width: 5),
                      Text(
                        systemOpen ? 'الخدمات متاحة' : 'الخدمات متوقفة',
                        style: TextStyle(
                          color: systemOpen
                              ? AhramColors.emerald
                              : colors.error,
                          fontWeight: FontWeight.w800,
                          fontSize: 12,
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
            const SizedBox(height: 20),
            Text(
              'مرحباً، $name',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: Theme.of(context).textTheme.headlineSmall?.copyWith(
                color: colors.onSurface,
                fontWeight: FontWeight.w900,
              ),
            ),
            const SizedBox(height: 4),
            Text(
              role,
              style: TextStyle(
                color: colors.onSurfaceVariant,
                fontWeight: FontWeight.w700,
              ),
            ),
            const SizedBox(height: 18),
            Container(
              padding: const EdgeInsets.all(15),
              decoration: BoxDecoration(
                color: balanceColor.withValues(alpha: dark ? 0.12 : 0.065),
                borderRadius: BorderRadius.circular(14),
                border: Border.all(color: balanceColor.withValues(alpha: 0.22)),
              ),
              child: Row(
                children: [
                  Container(
                    width: 42,
                    height: 42,
                    decoration: BoxDecoration(
                      color: balanceColor.withValues(alpha: 0.12),
                      borderRadius: BorderRadius.circular(12),
                    ),
                    child: Icon(
                      Icons.account_balance_wallet_outlined,
                      color: balanceColor,
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          'الرصيد الحالي',
                          style: TextStyle(
                            color: colors.onSurfaceVariant,
                            fontSize: 12,
                          ),
                        ),
                        const SizedBox(height: 3),
                        Text(
                          showBalance
                              ? '${formatAmount(balance)} د.ل'
                              : 'غير معروض',
                          textDirection: ui.TextDirection.ltr,
                          style: TextStyle(
                            color: balanceColor,
                            fontSize: 20,
                            fontWeight: FontWeight.w900,
                          ),
                        ),
                      ],
                    ),
                  ),
                  IconButton(
                    tooltip: 'إعدادات الحماية',
                    onPressed: onSecurity,
                    icon: Icon(Icons.shield_outlined, color: colors.primary),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 14),
            Row(
              children: [
                Expanded(
                  child: Container(
                    height: 4,
                    decoration: const BoxDecoration(color: AhramColors.sky),
                  ),
                ),
                const SizedBox(width: 3),
                Expanded(
                  child: Container(
                    height: 4,
                    decoration: const BoxDecoration(color: AhramColors.gold),
                  ),
                ),
                const SizedBox(width: 3),
                Expanded(
                  child: Container(
                    height: 4,
                    decoration: const BoxDecoration(color: AhramColors.emerald),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class CustomerHomeSection extends StatelessWidget {
  const CustomerHomeSection({
    super.key,
    required this.title,
    required this.subtitle,
    required this.children,
  });

  final String title;
  final String subtitle;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          title,
          style: Theme.of(
            context,
          ).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w900),
        ),
        const SizedBox(height: 4),
        Text(
          subtitle,
          style: TextStyle(
            color: Theme.of(context).colorScheme.onSurfaceVariant,
          ),
        ),
        const SizedBox(height: 12),
        LayoutBuilder(
          builder: (context, constraints) {
            final columns = constraints.maxWidth >= 760
                ? 4
                : constraints.maxWidth >= 430
                ? 2
                : 1;
            final width =
                (constraints.maxWidth - ((columns - 1) * 12)) / columns;
            return Wrap(
              spacing: 12,
              runSpacing: 12,
              children: children
                  .map((child) => SizedBox(width: width, child: child))
                  .toList(),
            );
          },
        ),
      ],
    );
  }
}

class CustomerQuickTile extends StatelessWidget {
  const CustomerQuickTile({
    super.key,
    required this.icon,
    required this.title,
    required this.caption,
    required this.color,
  });

  final IconData icon;
  final String title;
  final String caption;
  final Color color;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return SurfacePanel(
      child: Row(
        children: [
          Container(
            width: 42,
            height: 42,
            decoration: BoxDecoration(
              color: color.withValues(alpha: 0.12),
              borderRadius: BorderRadius.circular(12),
            ),
            child: Icon(icon, color: color),
          ),
          const SizedBox(width: 11),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: colors.onSurface,
                    fontWeight: FontWeight.w900,
                  ),
                ),
                const SizedBox(height: 3),
                Text(
                  caption,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: colors.onSurfaceVariant,
                    fontSize: 11,
                  ),
                ),
              ],
            ),
          ),
          Icon(Icons.chevron_left, color: colors.onSurfaceVariant, size: 19),
        ],
      ),
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
  String _activeMarket = 'egypt';
  String? _selectedServiceKey;
  final TextEditingController _amountController = TextEditingController(
    text: '1',
  );
  final TextEditingController _convertedAmountController =
      TextEditingController();
  bool _syncingCalculator = false;
  Timer? _rateChangeTimer;

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
      final rawRates = home['serviceRates'];
      if (_convertedAmountController.text.trim().isEmpty && rawRates is Map) {
        final initialRate = rawRates.values
            .map(numberValue)
            .firstWhere((rate) => rate > 0, orElse: () => 0);
        if (initialRate > 0) {
          _convertedAmountController.text = _calculatorAmount(
            numberValue(_amountController.text) * initialRate,
          );
        }
      }
      if (mounted) {
        setState(() => _home = home);
        _armRateChangeTimer();
      }
    } catch (error) {
      if (mounted) setState(() => _error = error);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  void dispose() {
    _rateChangeTimer?.cancel();
    _amountController.dispose();
    _convertedAmountController.dispose();
    super.dispose();
  }

  int _pendingRateSeconds() {
    final pending = _home?['pendingRateUpdate'];
    if (pending is! Map) return 0;
    final effectiveAt = DateTime.tryParse('${pending['effectiveAt'] ?? ''}');
    if (effectiveAt == null) return 0;
    return math.max(0, effectiveAt.difference(DateTime.now()).inSeconds);
  }

  void _armRateChangeTimer() {
    _rateChangeTimer?.cancel();
    if (_pendingRateSeconds() <= 0) return;
    _rateChangeTimer = Timer.periodic(const Duration(seconds: 1), (timer) {
      if (!mounted) return timer.cancel();
      if (_pendingRateSeconds() <= 0) {
        final currentRatesText = _pendingRateText('currentRatesText');
        timer.cancel();
        unawaited(
          _load().then((_) {
            if (!mounted) return;
            ScaffoldMessenger.of(context).showSnackBar(
              SnackBar(
                behavior: SnackBarBehavior.floating,
                backgroundColor: _green,
                content: Text(
                  currentRatesText.isEmpty
                      ? 'تم تفعيل السعر الجديد في حسابك.'
                      : 'تم تفعيل السعر الجديد:\n$currentRatesText',
                ),
              ),
            );
          }),
        );
        return;
      }
      setState(() {});
    });
  }

  String _pendingRateText(String field) {
    final pending = _home?['pendingRateUpdate'];
    if (pending is! Map) return '';
    return '${pending[field] ?? ''}'.trim();
  }

  void _syncCalculator({
    required bool fromSource,
    required Map<String, dynamic> service,
  }) {
    if (_syncingCalculator) return;
    final rate = numberValue(service['rate']);
    if (rate <= 0) return;
    final input = numberValue(
      (fromSource ? _amountController.text : _convertedAmountController.text)
          .replaceAll(',', ''),
    );
    final converted = fromSource ? input * rate : input / rate;
    _syncingCalculator = true;
    final target = fromSource ? _convertedAmountController : _amountController;
    target.value = target.value.copyWith(
      text: _calculatorAmount(converted),
      selection: TextSelection.collapsed(
        offset: _calculatorAmount(converted).length,
      ),
      composing: TextRange.empty,
    );
    _syncingCalculator = false;
    if (mounted) setState(() {});
  }

  void _setQuickAmount(double value, Map<String, dynamic> service) {
    _amountController.text = _calculatorAmount(value);
    _syncCalculator(fromSource: true, service: service);
  }

  List<Map<String, dynamic>> _rateRows(
    Map<String, dynamic> rates,
    List<Map<String, dynamic>> catalog,
  ) {
    final catalogByKey = <String, Map<String, dynamic>>{
      for (final item in catalog) '${item['key'] ?? ''}': item,
    };
    return rates.entries
        .where((entry) => numberValue(entry.value) > 0)
        .map(
          (entry) => <String, dynamic>{
            'key': entry.key,
            'rate': numberValue(entry.value),
            ...?catalogByKey[entry.key],
          },
        )
        .toList();
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
    final rows = _rateRows(rates, catalog);
    final marketRows = rows
        .where(
          (item) => _exchangeMarket(item['key']?.toString()) == _activeMarket,
        )
        .toList();
    final visibleRows = marketRows.isEmpty ? rows : marketRows;
    final pendingSeconds = _pendingRateSeconds();
    final pendingRateChanges = _pendingRateText('rateChangesText');
    final selected = visibleRows.firstWhere(
      (item) => item['key'] == _selectedServiceKey,
      orElse: () =>
          visibleRows.isEmpty ? <String, dynamic>{} : visibleRows.first,
    );

    return PageFrame(
      title: 'أسعار الصرف',
      subtitle: 'الأسعار الخاصة بحسابك والمطبقة قبل تأكيد التحويل.',
      onRefresh: _load,
      child: [
        if (pendingSeconds > 0) ...[
          _RateChangeCountdownBanner(
            seconds: pendingSeconds,
            rateChangesText: pendingRateChanges,
          ),
          const SizedBox(height: 12),
        ],
        if (rates.isEmpty)
          const EmptyPanel(
            icon: Icons.currency_exchange_outlined,
            title: 'لا توجد أسعار متاحة حالياً',
            message: 'اسحب الصفحة للتحديث أو تواصل مع الدعم الفني.',
          )
        else ...[
          Text(
            'اختر الدولة',
            style: Theme.of(
              context,
            ).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w900),
          ),
          const SizedBox(height: 10),
          Wrap(
            spacing: 6,
            runSpacing: 6,
            children:
                const [
                      ('egypt', 'مصر', '🇪🇬'),
                      ('niger', 'النيجر', '🇳🇪'),
                      ('sudan', 'السودان', '🇸🇩'),
                    ]
                    .map(
                      (market) => ChoiceChip(
                        label: Text(market.$2),
                        selected: _activeMarket == market.$1,
                        avatar: Text(market.$3),
                        visualDensity: VisualDensity.compact,
                        labelStyle: const TextStyle(
                          fontSize: 12,
                          fontWeight: FontWeight.w800,
                        ),
                        onSelected: (_) {
                          final nextRows = rows
                              .where(
                                (item) =>
                                    _exchangeMarket(item['key']?.toString()) ==
                                    market.$1,
                              )
                              .toList();
                          final nextService = nextRows.isEmpty
                              ? selected
                              : nextRows.first;
                          setState(() {
                            _activeMarket = market.$1;
                            _selectedServiceKey = nextService['key']
                                ?.toString();
                          });
                          _syncCalculator(
                            fromSource: true,
                            service: nextService,
                          );
                        },
                      ),
                    )
                    .toList(),
          ),
          const SizedBox(height: 18),
          _ExchangeRateHero(
            service: selected,
            amountController: _amountController,
            convertedAmountController: _convertedAmountController,
            updatedAt: home['serverTime']?.toString(),
            onSourceChanged: () =>
                _syncCalculator(fromSource: true, service: selected),
            onTargetChanged: () =>
                _syncCalculator(fromSource: false, service: selected),
            onQuickAmount: (amount) => _setQuickAmount(amount, selected),
          ),
          const SizedBox(height: 18),
          Text(
            'خدمات ${_exchangeMarketName(_activeMarket)}',
            style: Theme.of(
              context,
            ).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w900),
          ),
          const SizedBox(height: 8),
          LayoutBuilder(
            builder: (context, constraints) {
              final cardWidth = constraints.maxWidth >= 620
                  ? (constraints.maxWidth - 12) / 2
                  : constraints.maxWidth;
              return Wrap(
                spacing: 8,
                runSpacing: 8,
                children: visibleRows
                    .map(
                      (item) => SizedBox(
                        width: cardWidth,
                        child: _ExchangeRateServiceCard(
                          service: item,
                          selected: item['key'] == selected['key'],
                          onTap: () {
                            setState(
                              () =>
                                  _selectedServiceKey = item['key']?.toString(),
                            );
                            _syncCalculator(fromSource: true, service: item);
                          },
                        ),
                      ),
                    )
                    .toList(),
              );
            },
          ),
          const SizedBox(height: 16),
          Text(
            'يتم اعتماد السعر الظاهر عند تأكيد الطلب، وقد يتغير وفق تحديثات الإدارة.',
            style: TextStyle(
              color: Theme.of(context).colorScheme.onSurfaceVariant,
              fontSize: 12,
              height: 1.55,
            ),
          ),
        ],
      ],
    );
  }
}

String _calculatorAmount(double value) {
  if (!value.isFinite) return '0';
  return value.toStringAsFixed(3).replaceFirst(RegExp(r'\.?0+$'), '');
}

String _exchangeServiceLabel(Map<String, dynamic> service) =>
    service['shortLabel']?.toString() ??
    service['label']?.toString() ??
    serviceLabel(service['key']?.toString());

String _exchangeMarket(String? key) {
  if (key == 'sefa_niger') return 'niger';
  if (key == 'bankak_sudan') return 'sudan';
  return 'egypt';
}

String _exchangeMarketName(String market) {
  switch (market) {
    case 'niger':
      return 'النيجر';
    case 'sudan':
      return 'السودان';
    default:
      return 'مصر';
  }
}

List<int> _exchangeQuickAmounts(Map<String, dynamic> service) {
  switch (service['key']) {
    case 'sefa_niger':
      return const [10, 50, 100, 500];
    case 'bankak_sudan':
      return const [500, 1000, 5000, 10000];
    case 'post_account':
    case 'post_card':
    case 'bank_account':
      return const [500, 1000, 5000, 10000];
    default:
      return const [100, 500, 1000, 5000];
  }
}

String _exchangeUpdateLabel(String? value) {
  final date = value == null ? null : DateTime.tryParse(value);
  if (date == null) return 'السعر محدث';
  return 'آخر تحديث ${DateFormat('HH:mm', 'ar').format(date.toLocal())}';
}

String _exchangeFlag(String? key) {
  switch (key) {
    case 'sefa_niger':
      return '🇳🇪';
    case 'bankak_sudan':
      return '🇸🇩';
    default:
      return '🇪🇬';
  }
}

Color _exchangeColor(String? key) {
  switch (key) {
    case 'sefa_niger':
      return const Color(0xFF158A9B);
    case 'bankak_sudan':
      return const Color(0xFF6B4A9A);
    case 'post_card':
      return const Color(0xFFC47216);
    case 'bank_account':
      return const Color(0xFF3366CC);
    default:
      return _green;
  }
}

String _exchangeSourceLabel(Map<String, dynamic> service) {
  switch (service['key']) {
    case 'sefa_niger':
      return 'سيفا';
    case 'bankak_sudan':
      return 'دينار ليبي';
    default:
      return 'دينار ليبي';
  }
}

String _exchangeTargetLabel(Map<String, dynamic> service) {
  switch (service['key']) {
    case 'sefa_niger':
      return 'دينار ليبي';
    case 'bankak_sudan':
      return 'جنيه سوداني';
    default:
      return 'جنيه مصري';
  }
}

String _exchangeFormula(Map<String, dynamic> service, double rate) {
  final formatted = formatAmount(rate);
  if (service['key'] == 'sefa_niger') {
    return '1 سيفا = $formatted د.ل';
  }
  if (service['key'] == 'bankak_sudan') {
    return '1 د.ل = $formatted ج.س';
  }
  return '1 د.ل = $formatted ج.م';
}

class _ExchangeRateHero extends StatelessWidget {
  const _ExchangeRateHero({
    required this.service,
    required this.amountController,
    required this.convertedAmountController,
    required this.updatedAt,
    required this.onSourceChanged,
    required this.onTargetChanged,
    required this.onQuickAmount,
  });

  final Map<String, dynamic> service;
  final TextEditingController amountController;
  final TextEditingController convertedAmountController;
  final String? updatedAt;
  final VoidCallback onSourceChanged;
  final VoidCallback onTargetChanged;
  final ValueChanged<double> onQuickAmount;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final rate = numberValue(service['rate']);
    final accent = _exchangeColor(service['key']?.toString());
    return SurfacePanel(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                width: 36,
                height: 36,
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  color: accent.withValues(alpha: 0.12),
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Text(
                  _exchangeFlag(service['key']?.toString()),
                  style: const TextStyle(fontSize: 19),
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      _exchangeServiceLabel(service),
                      style: TextStyle(
                        color: colors.onSurface,
                        fontWeight: FontWeight.w900,
                        fontSize: 15,
                      ),
                    ),
                    Text(
                      _exchangeUpdateLabel(updatedAt),
                      style: TextStyle(
                        color: colors.onSurfaceVariant,
                        fontSize: 12,
                      ),
                    ),
                  ],
                ),
              ),
              Icon(Icons.verified_rounded, color: accent),
            ],
          ),
          const SizedBox(height: 12),
          Container(
            width: double.infinity,
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
            decoration: BoxDecoration(
              color: accent.withValues(alpha: 0.1),
              borderRadius: BorderRadius.circular(8),
              border: Border.all(color: accent.withValues(alpha: 0.24)),
            ),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    _exchangeFormula(service, rate),
                    textDirection: ui.TextDirection.ltr,
                    style: TextStyle(
                      color: colors.onSurface,
                      fontWeight: FontWeight.w900,
                      fontSize: 20,
                    ),
                  ),
                ),
                Icon(Icons.trending_up_rounded, color: accent),
              ],
            ),
          ),
          const SizedBox(height: 14),
          LayoutBuilder(
            builder: (context, constraints) {
              final compact = constraints.maxWidth < 530;
              final source = _ExchangeCalculatorField(
                label: _exchangeSourceLabel(service),
                flag: service['key'] == 'sefa_niger' ? '🇳🇪' : '🇱🇾',
                controller: amountController,
                accent: accent,
                onChanged: onSourceChanged,
              );
              final target = _ExchangeCalculatorField(
                label: _exchangeTargetLabel(service),
                flag: _exchangeFlag(service['key']?.toString()),
                controller: convertedAmountController,
                accent: accent,
                onChanged: onTargetChanged,
              );
              if (compact) {
                return Column(
                  children: [
                    source,
                    Padding(
                      padding: const EdgeInsets.symmetric(vertical: 6),
                      child: Icon(Icons.south_rounded, color: accent, size: 19),
                    ),
                    target,
                  ],
                );
              }
              return Row(
                children: [
                  Expanded(child: source),
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 10),
                    child: Tooltip(
                      message: 'الكتابة متاحة في الحقلين',
                      child: Icon(Icons.sync_alt_rounded, color: accent),
                    ),
                  ),
                  Expanded(child: target),
                ],
              );
            },
          ),
          const SizedBox(height: 10),
          Wrap(
            spacing: 6,
            runSpacing: 6,
            children: _exchangeQuickAmounts(service)
                .map(
                  (amount) => ActionChip(
                    label: Text('$amount'),
                    onPressed: () => onQuickAmount(amount.toDouble()),
                    visualDensity: VisualDensity.compact,
                    avatar: Icon(Icons.add_rounded, color: accent, size: 14),
                    side: BorderSide(color: accent.withValues(alpha: 0.25)),
                    labelStyle: TextStyle(
                      color: colors.onSurface,
                      fontWeight: FontWeight.w800,
                      fontSize: 12,
                    ),
                  ),
                )
                .toList(),
          ),
        ],
      ),
    );
  }
}

class _ExchangeCalculatorField extends StatelessWidget {
  const _ExchangeCalculatorField({
    required this.label,
    required this.flag,
    required this.controller,
    required this.accent,
    required this.onChanged,
  });

  final String label;
  final String flag;
  final TextEditingController controller;
  final Color accent;
  final VoidCallback onChanged;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return TextField(
      controller: controller,
      keyboardType: const TextInputType.numberWithOptions(decimal: true),
      textDirection: ui.TextDirection.ltr,
      style: TextStyle(
        color: colors.onSurface,
        fontSize: 19,
        fontWeight: FontWeight.w900,
      ),
      onChanged: (_) => onChanged(),
      decoration: InputDecoration(
        labelText: label,
        hintText: '0.000',
        isDense: true,
        suffixIcon: Padding(
          padding: const EdgeInsetsDirectional.only(end: 10),
          child: Center(
            widthFactor: 1,
            child: Text(flag, style: const TextStyle(fontSize: 16)),
          ),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(8),
          borderSide: BorderSide(color: accent.withValues(alpha: 0.28)),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(8),
          borderSide: BorderSide(color: accent, width: 1.6),
        ),
      ),
    );
  }
}

class _ExchangeRateServiceCard extends StatelessWidget {
  const _ExchangeRateServiceCard({
    required this.service,
    required this.selected,
    required this.onTap,
  });

  final Map<String, dynamic> service;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final accent = _exchangeColor(service['key']?.toString());
    final rate = numberValue(service['rate']);
    return Semantics(
      button: true,
      label: 'اختيار خدمة ${_exchangeServiceLabel(service)}',
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(8),
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 180),
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            color: selected ? accent.withValues(alpha: 0.12) : colors.surface,
            borderRadius: BorderRadius.circular(8),
            border: Border.all(
              color: selected ? accent : colors.outlineVariant,
              width: selected ? 1.5 : 1,
            ),
            boxShadow: [
              BoxShadow(
                color: accent.withValues(alpha: selected ? 0.18 : 0.07),
                blurRadius: selected ? 16 : 9,
                offset: const Offset(0, 5),
              ),
            ],
          ),
          child: Row(
            children: [
              Container(
                width: 36,
                height: 36,
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  color: accent.withValues(alpha: 0.13),
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Text(
                  _exchangeFlag(service['key']?.toString()),
                  style: const TextStyle(fontSize: 18),
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      _exchangeServiceLabel(service),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        color: colors.onSurface,
                        fontWeight: FontWeight.w900,
                        fontSize: 13,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      _exchangeFormula(service, rate),
                      textDirection: ui.TextDirection.ltr,
                      style: TextStyle(
                        color: colors.onSurfaceVariant,
                        fontSize: 11,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                  ],
                ),
              ),
              Icon(
                selected ? Icons.radio_button_checked : Icons.chevron_left,
                color: selected ? accent : colors.onSurfaceVariant,
              ),
            ],
          ),
        ),
      ),
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
  final _balanceTransferFormKey = GlobalKey<FormState>();
  final _amount = TextEditingController();
  final _lydAmount = TextEditingController();
  final _number = TextEditingController();
  final _targetAccountCode = TextEditingController();
  final _clientPhone = TextEditingController();
  final _recipientPhone = TextEditingController();
  final _bankNameController = TextEditingController();
  final _name = TextEditingController();
  final _city = TextEditingController();
  final _notes = TextEditingController();
  final _picker = ImagePicker();
  Map<String, dynamic>? _home;
  String _serviceKey = 'vodafone';
  String? _serviceSubtype;
  String? _governorate;
  String? _bankName;
  bool _showServiceCatalog = true;
  bool _isBalanceTransfer = false;
  bool _dataEntryAcknowledged = false;
  bool _lookingUpTarget = false;
  Map<String, dynamic>? _balanceTransferTarget;
  Uint8List? _idCard;
  Uint8List? _oldReceipt;
  bool _busy = false;
  bool _syncingCashAmounts = false;
  String? _error;

  static const _egyptGovernorates = <String>[
    'القاهرة',
    'الجيزة',
    'الإسكندرية',
    'الدقهلية',
    'البحر الأحمر',
    'البحيرة',
    'الفيوم',
    'الغربية',
    'الإسماعيلية',
    'المنوفية',
    'المنيا',
    'القليوبية',
    'الوادي الجديد',
    'السويس',
    'أسوان',
    'أسيوط',
    'بني سويف',
    'بورسعيد',
    'دمياط',
    'الشرقية',
    'جنوب سيناء',
    'كفر الشيخ',
    'مطروح',
    'الأقصر',
    'قنا',
    'شمال سيناء',
    'سوهاج',
  ];

  // MyNITA city selector values are kept in the transfer client so the
  // beneficiary city is always selected from the supported Niger locations.
  static const _nigerCities = <String>[
    'Abalak',
    'Abala',
    'Agadez',
    'Aguié',
    'Ayorou',
    'Balleyara',
    'Banibangou',
    'Bankilaré',
    'Belbédji',
    'Bilma',
    "Birni N'Gaouré",
    "Birni N'Konni",
    'Bouza',
    'Dakoro',
    'Damagaram Takaya',
    'Diffa',
    'Dogondoutchi',
    'Dosso',
    'Dungass',
    'Filingué',
    'Gaya',
    'Gothèye',
    'Gouré',
    'Guidan-Roumdji',
    'Illéla',
    'Kéita',
    'Kollo',
    'Loga',
    'Madaoua',
    'Madarounfa',
    'Magaria',
    'Mainé-Soroa',
    'Maradi',
    'Matamèye',
    'Mayahi',
    'Mirriah',
    "N'Guigmi",
    'Niamey',
    'Ouallam',
    'Say',
    'Tahoua',
    'Tanout',
    'Tchintabaraden',
    'Tchirozérine',
    'Téra',
    'Tessaoua',
    'Tibiri',
    'Tillabéri',
    'Zinder',
  ];

  static const _egyptBanks = <String>[
    'البنك الأهلي المصري',
    'بنك مصر',
    'بنك القاهرة',
    'البنك التجاري الدولي CIB',
    'بنك الإسكندرية',
    'بنك قطر الوطني الأهلي QNB',
    'بنك فيصل الإسلامي المصري',
    'المصرف المتحد',
    'بنك البركة مصر',
    'بنك أبو ظبي الإسلامي مصر',
    'بنك أبو ظبي التجاري مصر',
    'بنك الإمارات دبي الوطني مصر',
    'بنك التعمير والإسكان',
    'بنك قناة السويس',
    'البنك العربي الأفريقي الدولي',
    'البنك العربي',
    'بنك الشركة المصرفية العربية الدولية SAIB',
    'بنك كريدي أجريكول مصر',
    'بنك المشرق مصر',
    'البنك الأهلي الكويتي مصر',
    'بنك المؤسسة العربية المصرفية ABC',
    'بنك نكست',
    'بنك التنمية الصناعية',
    'بنك الاستثمار العربي',
    'المصرف العربي الدولي',
    'سيتي بنك مصر',
    'بنك HSBC مصر',
    'البنك العقاري المصري العربي',
    'البنك المصري الخليجي EGBANK',
    'بنك الكويت الوطني مصر',
    'البنك الأهلي المتحد مصر',
    'البنك الزراعي المصري',
    'البنك المصري لتنمية الصادرات',
  ];

  @override
  void initState() {
    super.initState();
    _loadRates();
  }

  @override
  void dispose() {
    _amount.dispose();
    _lydAmount.dispose();
    _number.dispose();
    _targetAccountCode.dispose();
    _clientPhone.dispose();
    _recipientPhone.dispose();
    _bankNameController.dispose();
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
        {'post_account', 'post_card', 'sefa_niger'}.contains(_serviceKey);
  }

  bool get _requiresCity {
    final fields = (_service['requiredFields'] as List? ?? const [])
        .map((item) => '$item')
        .toSet();
    return fields.contains('city') ||
        (_serviceKey == 'sefa_niger' && _serviceSubtype == 'nita');
  }

  bool get _requiresIdCard => _serviceKey == 'post_card';

  bool get _showsOldReceipt => _serviceKey == 'post_account';

  bool get _isSefa => _serviceKey == 'sefa_niger';

  ({String label, Color color})? get _cashWalletProvider {
    final number = _number.text.replaceAll(RegExp(r'\s+'), '');
    if (number.startsWith('010')) {
      return (label: 'فودافون كاش', color: const Color(0xFFD43C3C));
    }
    if (number.startsWith('011')) {
      return (label: 'اتصالات كاش', color: const Color(0xFF159447));
    }
    if (number.startsWith('012')) {
      return (label: 'أورانج كاش', color: const Color(0xFFF07818));
    }
    if (number.startsWith('015')) {
      return (label: 'WE Pay', color: const Color(0xFF6F42C1));
    }
    return null;
  }

  double get _cashAmount =>
      numberValue(_amount.text.replaceAll(',', '').trim());

  double get _cashAmountLyd => _rate <= 0 ? 0 : _cashAmount / _rate;

  double get _sefaAmountLyd => _cashAmount * _rate;

  String _editableCurrencyValue(double value) {
    if (!value.isFinite || value == 0) return '';
    return value
        .toStringAsFixed(2)
        .replaceFirst(RegExp(r'\.00$'), '')
        .replaceFirst(RegExp(r'(\.\d)0$'), r'$1');
  }

  void _updateLydFromEgp() {
    if (_syncingCashAmounts) return;
    _syncingCashAmounts = true;
    _lydAmount.value = TextEditingValue(
      text: _editableCurrencyValue(_cashAmountLyd),
      selection: TextSelection.collapsed(
        offset: _editableCurrencyValue(_cashAmountLyd).length,
      ),
    );
    _syncingCashAmounts = false;
    setState(() {});
  }

  void _updateEgpFromLyd() {
    if (_syncingCashAmounts) return;
    _syncingCashAmounts = true;
    final lyd = numberValue(_lydAmount.text.replaceAll(',', '').trim());
    final egp = lyd * _rate;
    final value = _editableCurrencyValue(egp);
    _amount.value = TextEditingValue(
      text: value,
      selection: TextSelection.collapsed(offset: value.length),
    );
    _syncingCashAmounts = false;
    setState(() {});
  }

  void _updateLydFromSefa() {
    if (_syncingCashAmounts) return;
    _syncingCashAmounts = true;
    final value = _editableCurrencyValue(_sefaAmountLyd);
    _lydAmount.value = TextEditingValue(
      text: value,
      selection: TextSelection.collapsed(offset: value.length),
    );
    _syncingCashAmounts = false;
    setState(() {});
  }

  void _updateSefaFromLyd() {
    if (_syncingCashAmounts) return;
    _syncingCashAmounts = true;
    final lyd = numberValue(_lydAmount.text.replaceAll(',', '').trim());
    final sefa = _rate <= 0 ? 0 : lyd / _rate;
    final value = _editableCurrencyValue(sefa.toDouble());
    _amount.value = TextEditingValue(
      text: value,
      selection: TextSelection.collapsed(offset: value.length),
    );
    _syncingCashAmounts = false;
    setState(() {});
  }

  String get _selectedServiceLabel {
    if (_serviceKey == 'bank_account' && _serviceSubtype == 'instapay') {
      return 'تحويل إنستا باي';
    }
    if (_serviceKey == 'bank_account') return 'تحويل بنكي';
    if (_serviceKey == 'sefa_niger' && _serviceSubtype == 'nita') return 'NITA';
    if (_serviceKey == 'sefa_niger' && _serviceSubtype == 'nita_account') {
      return 'NITA ACCOUNT';
    }
    return '${_service['shortLabel'] ?? _service['label'] ?? serviceLabel(_serviceKey)}';
  }

  String get _numberLabel {
    if (_serviceKey == 'bank_account' && _serviceSubtype == 'instapay') {
      return 'رقم إنستا باي أو رقم الهاتف';
    }
    if (_isSefa) return 'رقم حساب NITA';
    return '${_service['numberLabel'] ?? 'رقم الهاتف أو الحساب'}';
  }

  double get _rate {
    final rates = _home?['serviceRates'] is Map
        ? Map<String, dynamic>.from(_home!['serviceRates'] as Map)
        : widget.controller.session?.serviceRates ?? const <String, dynamic>{};
    return numberValue(
      rates[_serviceKey],
      widget.controller.session?.exchangeRate ?? 1,
    );
  }

  bool _isAvailable(String serviceKey) =>
      _servicesFrom(_home).any((item) => item['key'] == serviceKey);

  double _rateFor(String serviceKey) {
    final rates = _home?['serviceRates'] is Map
        ? Map<String, dynamic>.from(_home!['serviceRates'] as Map)
        : widget.controller.session?.serviceRates ?? const <String, dynamic>{};
    return numberValue(rates[serviceKey]);
  }

  void _openService(String serviceKey, {String? subtype}) {
    setState(() {
      _serviceKey = serviceKey;
      _serviceSubtype = subtype;
      _showServiceCatalog = false;
      _isBalanceTransfer = false;
      _idCard = null;
      _oldReceipt = null;
      _recipientPhone.clear();
      _governorate = null;
      _bankName = null;
      _bankNameController.clear();
      _dataEntryAcknowledged = false;
      _error = null;
    });
  }

  void _openBalanceTransfer() {
    setState(() {
      _showServiceCatalog = false;
      _isBalanceTransfer = true;
      _balanceTransferTarget = null;
      _error = null;
    });
  }

  void _backToServices() {
    setState(() {
      _showServiceCatalog = true;
      _isBalanceTransfer = false;
      _error = null;
    });
  }

  Future<void> _lookupBalanceTransferTarget() async {
    final code = _targetAccountCode.text.trim();
    if (code.isEmpty) {
      setState(() => _error = 'أدخل رمز الحساب أولاً.');
      return;
    }
    setState(() {
      _lookingUpTarget = true;
      _error = null;
      _balanceTransferTarget = null;
    });
    try {
      final response = await widget.controller.api.lookupBalanceTransferTarget(
        code,
      );
      final target = response['target'];
      if (!mounted) return;
      setState(() {
        _balanceTransferTarget = target is Map
            ? Map<String, dynamic>.from(target)
            : null;
      });
    } on ApiFailure catch (error) {
      if (mounted) setState(() => _error = error.message);
    } finally {
      if (mounted) setState(() => _lookingUpTarget = false);
    }
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
    if (_serviceKey == 'vodafone' && (amount < 100 || amount > 50000)) {
      setState(
        () => _error =
            'قيمة تحويل محافظ كاش يجب أن تكون بين 100 و50,000 جنيه مصري للعملية الواحدة.',
      );
      return;
    }
    if (_serviceKey == 'post_account' && amount < 500) {
      setState(() => _error = 'الحد الأدنى لتحويل بريد حساب هو 500 جنيه مصري.');
      return;
    }
    if (_serviceKey == 'post_card' && amount < 500) {
      setState(
        () => _error = 'الحد الأدنى لتحويل بريد بطاقة هو 500 جنيه مصري.',
      );
      return;
    }
    if (_serviceKey == 'bank_account' && amount < 500) {
      setState(
        () => _error = _serviceSubtype == 'instapay'
            ? 'الحد الأدنى لتحويل إنستا باي هو 500 جنيه مصري.'
            : 'الحد الأدنى للتحويل البنكي هو 500 جنيه مصري.',
      );
      return;
    }
    if (_serviceKey == 'vodafone' &&
        !RegExp(
          r'^(010|011|012|015)\d{8}$',
        ).hasMatch(_number.text.replaceAll(RegExp(r'\s+'), ''))) {
      setState(
        () => _error =
            'رقم المستلم يجب أن يكون 11 رقماً ويبدأ بـ 010 أو 011 أو 012 أو 015.',
      );
      return;
    }
    if (_serviceKey == 'post_account' &&
        !RegExp(
          r'^\d{15}$',
        ).hasMatch(_number.text.replaceAll(RegExp(r'\s+'), ''))) {
      setState(() => _error = 'رقم الحساب البريدي يجب أن يكون 15 رقماً.');
      return;
    }
    if (_serviceKey == 'post_card') {
      final nationalId = _number.text.replaceAll(RegExp(r'\s+'), '');
      final recipientPhone = _recipientPhone.text.replaceAll(
        RegExp(r'\s+'),
        '',
      );
      final nameParts = _name.text
          .trim()
          .split(RegExp(r'\s+'))
          .where((part) => part.isNotEmpty);
      if (!RegExp(r'^\d{14}$').hasMatch(nationalId) ||
          !RegExp(r'^(010|011|012|015)\d{8}$').hasMatch(recipientPhone) ||
          nameParts.length < 3 ||
          (_governorate ?? '').isEmpty) {
        setState(
          () => _error =
              'راجع الاسم الثلاثي والرقم القومي وهاتف المستلم والمحافظة قبل الإرسال.',
        );
        return;
      }
    }
    if (_serviceKey == 'bankak_sudan') {
      final account = _number.text.replaceAll(RegExp(r'\s+'), '');
      final recipientPhone = _recipientPhone.text.replaceAll(
        RegExp(r'\s+'),
        '',
      );
      if (_name.text.trim().length < 2 ||
          !RegExp(r'^\d{14}$').hasMatch(account) ||
          !RegExp(r'^\+?\d{9,15}$').hasMatch(recipientPhone)) {
        setState(
          () => _error =
              'راجع اسم المستفيد ورقم حساب بنكك المكون من 14 رقماً وهاتف المستلم.',
        );
        return;
      }
    }
    if (_serviceKey == 'bank_account' && _serviceSubtype != 'instapay') {
      final nameParts = _name.text
          .trim()
          .split(RegExp(r'\s+'))
          .where((part) => part.isNotEmpty);
      if (nameParts.length < 3 || (_bankName ?? '').isEmpty) {
        setState(
          () =>
              _error = 'أدخل اسم المستفيد الثلاثي واختر اسم البنك قبل الإرسال.',
        );
        return;
      }
    }
    if (_serviceKey == 'bank_account' && _serviceSubtype == 'instapay') {
      final nameParts = _name.text
          .trim()
          .split(RegExp(r'\s+'))
          .where((part) => part.isNotEmpty);
      final recipient = _number.text.replaceAll(RegExp(r'\s+'), '');
      final validRecipient = RegExp(
        r'^(?:(010|011|012|015)\d{8}|[A-Za-z0-9._@-]{3,50}|\d{16})$',
      ).hasMatch(recipient);
      if (nameParts.length < 3 || !validRecipient) {
        setState(
          () => _error =
              'أدخل الاسم الثلاثي ورقم الهاتف أو عنوان الدفع اللحظي أو رقم البطاقة الإلكتروني الصحيح.',
        );
        return;
      }
    }
    if (_requiresIdCard && _idCard == null) {
      setState(() => _error = 'صورة البطاقة الشخصية مطلوبة لهذه الخدمة.');
      return;
    }
    if (_isSefa && !_dataEntryAcknowledged) {
      setState(
        () => _error =
            'يرجى تأكيد مسؤوليتك عن صحة بيانات المستفيد قبل إرسال تحويل سيفا.',
      );
      return;
    }
    final payload = <String, dynamic>{
      'transferType': _serviceKey,
      'amount': amount,
      'number': _number.text.trim(),
      if (_serviceSubtype != null) 'serviceSubtype': _serviceSubtype,
      if (_serviceKey == 'post_card' || _serviceKey == 'bankak_sudan')
        'recipientPhone': _recipientPhone.text.trim(),
      if (_serviceKey == 'post_card') 'governorate': _governorate,
      if (_serviceKey == 'bank_account' && _bankName != null)
        'bankName': _bankName,
      if (_isSefa) 'dataEntryAcknowledged': _dataEntryAcknowledged,
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
        _lydAmount.clear();
        _number.clear();
        _clientPhone.clear();
        _recipientPhone.clear();
        _name.clear();
        _city.clear();
        _governorate = null;
        _bankName = null;
        _bankNameController.clear();
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

  Future<void> _submitBalanceTransfer() async {
    if (!_balanceTransferFormKey.currentState!.validate()) return;
    if (_balanceTransferTarget == null) {
      setState(() => _error = 'تحقق من رمز حساب المستلم قبل الإرسال.');
      return;
    }
    final amount = double.tryParse(_amount.text.replaceAll(',', '').trim());
    if (amount == null || amount <= 0) {
      setState(() => _error = 'أدخل قيمة تحويل صحيحة.');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final response = await widget.controller.api.createBalanceTransfer(
        targetAccountCode: _targetAccountCode.text,
        amount: amount,
        notes: _notes.text,
      );
      await widget.controller.refreshHome();
      if (!mounted) return;
      await showDialog<void>(
        context: context,
        builder: (context) => AlertDialog(
          icon: const Icon(Icons.check_circle_outline, color: _green, size: 42),
          title: const Text('تم التحويل بين الحسابات'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(response['message']?.toString() ?? 'تم تحويل الرصيد بنجاح.'),
              const SizedBox(height: 12),
              DetailLine(
                label: 'رقم العملية',
                value: '${response['transferId'] ?? '-'}',
              ),
              DetailLine(
                label: 'المستلم',
                value: '${response['targetName'] ?? '-'}',
              ),
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
      setState(() {
        _amount.clear();
        _targetAccountCode.clear();
        _notes.clear();
        _balanceTransferTarget = null;
      });
    } on ApiFailure catch (error) {
      if (mounted) setState(() => _error = error.message);
    } catch (_) {
      if (mounted) {
        setState(() => _error = 'تعذر تنفيذ التحويل بين الحسابات حالياً.');
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _confirmBalanceTransfer() async {
    if (!_balanceTransferFormKey.currentState!.validate()) return;
    if (_balanceTransferTarget == null) {
      setState(() => _error = 'تحقق من رقم حساب المستلم قبل التحويل.');
      return;
    }
    final amount = double.tryParse(_amount.text.replaceAll(',', '').trim());
    if (amount == null || amount <= 0) {
      setState(() => _error = 'أدخل قيمة تحويل صحيحة.');
      return;
    }

    await showDialog<void>(
      context: context,
      builder: (context) => AlertDialog(
        icon: const Icon(Icons.warning_amber_rounded, color: _gold, size: 42),
        title: const Text('تأكيد التحويل الداخلي'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Text(
              'تأكد من اسم المستلم والقيمة. لا يمكن التراجع عن التحويل بعد إرساله.',
            ),
            const SizedBox(height: 16),
            DetailLine(
              label: 'المستلم',
              value: '${_balanceTransferTarget!['name'] ?? '-'}',
            ),
            DetailLine(
              label: 'نوع الحساب',
              value: '${_balanceTransferTarget!['type'] ?? 'حساب'}',
            ),
            DetailLine(label: 'القيمة', value: '${formatAmount(amount)} د.ل'),
            if (_notes.text.trim().isNotEmpty)
              DetailLine(label: 'الملاحظة', value: _notes.text.trim()),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('إلغاء'),
          ),
          FilledButton.icon(
            onPressed: () async {
              Navigator.pop(context);
              await _submitBalanceTransfer();
            },
            icon: const Icon(Icons.send_outlined),
            label: const Text('إرسال التحويل'),
          ),
        ],
      ),
    );
  }

  Future<void> _chooseServiceGroup({
    required String title,
    required String subtitle,
    required List<_TransferServiceOption> options,
  }) async {
    await showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      builder: (sheetContext) => _TransferServiceOptionSheet(
        title: title,
        subtitle: subtitle,
        options: options,
        onSelected: (option) {
          Navigator.pop(sheetContext);
          _openService(option.serviceKey, subtype: option.subtype);
        },
      ),
    );
  }

  Widget _serviceGrid(List<Widget> children) {
    return LayoutBuilder(
      builder: (context, constraints) {
        final columns = constraints.maxWidth >= 820
            ? 3
            : (constraints.maxWidth >= 540 ? 2 : 2);
        final width = (constraints.maxWidth - (12 * (columns - 1))) / columns;
        return Wrap(
          spacing: 12,
          runSpacing: 12,
          children: children
              .map((child) => SizedBox(width: width, child: child))
              .toList(),
        );
      },
    );
  }

  Widget _catalogPage(List<Map<String, dynamic>> services) {
    final postalAvailable =
        _isAvailable('post_account') || _isAvailable('post_card');
    final bankAvailable = _isAvailable('bank_account');
    final sefaAvailable = _isAvailable('sefa_niger');

    return RefreshIndicator(
      onRefresh: _loadRates,
      color: _green,
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.fromLTRB(16, 16, 16, 30),
        children: [
          const _AhramTransferSectionHeader(
            title: 'الخدمات المصرية',
            subtitle: 'تحويلات سريعة إلى مصر',
            icon: Icons.account_balance_outlined,
          ),
          const SizedBox(height: 10),
          _serviceGrid([
            _TransferServiceCard(
              title: 'محافظ كاش',
              subtitle: 'تحويل مباشر للمحافظ المصرية',
              icon: Icons.account_balance_wallet_outlined,
              color: _green,
              rate: _rateFor('vodafone'),
              available: _isAvailable('vodafone'),
              onTap: _isAvailable('vodafone')
                  ? () => _openService('vodafone')
                  : null,
            ),
            _TransferServiceCard(
              title: 'تحويل بريد',
              subtitle: 'بريد حساب أو بريد بطاقة',
              icon: Icons.markunread_mailbox_outlined,
              color: AhramColors.sky,
              rate: _rateFor('post_account'),
              available: postalAvailable,
              onTap: postalAvailable
                  ? () => _chooseServiceGroup(
                      title: 'تحويل بريد',
                      subtitle: 'اختر نوع التحويل المناسب للمستفيد.',
                      options: [
                        if (_isAvailable('post_account'))
                          const _TransferServiceOption(
                            serviceKey: 'post_account',
                            title: 'بريد حساب',
                            subtitle: 'تحويل إلى الحساب البريدي باسم المستفيد.',
                            icon: Icons.account_balance_outlined,
                          ),
                        if (_isAvailable('post_card'))
                          const _TransferServiceOption(
                            serviceKey: 'post_card',
                            title: 'بريد بطاقة',
                            subtitle: 'تحويل بالرقم القومي مع صورة الهوية.',
                            icon: Icons.credit_card_outlined,
                          ),
                      ],
                    )
                  : null,
            ),
            _TransferServiceCard(
              title: 'تحويل بنكي',
              subtitle: 'تحويل بنكي أو إنستا باي',
              icon: Icons.account_balance_outlined,
              color: _gold,
              rate: _rateFor('bank_account'),
              available: bankAvailable,
              onTap: bankAvailable
                  ? () => _chooseServiceGroup(
                      title: 'تحويل بنكي',
                      subtitle: 'اختر قناة التحويل البنكي.',
                      options: const [
                        _TransferServiceOption(
                          serviceKey: 'bank_account',
                          subtype: 'bank_transfer',
                          title: 'تحويل بنكي',
                          subtitle: 'رقم حساب مصرفي أو IBAN.',
                          icon: Icons.account_balance_outlined,
                        ),
                        _TransferServiceOption(
                          serviceKey: 'bank_account',
                          subtype: 'instapay',
                          title: 'تحويل إنستا باي',
                          subtitle:
                              'استخدم رقم إنستا باي أو رقم الهاتف المسجل.',
                          icon: Icons.bolt_outlined,
                        ),
                      ],
                    )
                  : null,
            ),
          ]),
          const SizedBox(height: 20),
          const _AhramTransferSectionHeader(
            title: 'الخدمات الأخرى',
            subtitle: 'تحويلات إقليمية وداخلية',
            icon: Icons.public_outlined,
          ),
          const SizedBox(height: 10),
          _serviceGrid([
            _TransferServiceCard(
              title: 'سيفا النيجر',
              subtitle: 'NITA أو NITA ACCOUNT',
              icon: Icons.language_outlined,
              color: const Color(0xFF158A9B),
              rate: _rateFor('sefa_niger'),
              available: sefaAvailable,
              onTap: sefaAvailable
                  ? () => _chooseServiceGroup(
                      title: 'سيفا النيجر',
                      subtitle: 'اختر نوع حساب المستفيد.',
                      options: const [
                        _TransferServiceOption(
                          serviceKey: 'sefa_niger',
                          subtype: 'nita',
                          title: 'NITA',
                          subtitle: 'يتطلب اسم المستفيد ورقم الحساب والمدينة.',
                          icon: Icons.location_city_outlined,
                        ),
                        _TransferServiceOption(
                          serviceKey: 'sefa_niger',
                          subtype: 'nita_account',
                          title: 'NITA ACCOUNT',
                          subtitle: 'يتطلب اسم المستفيد ورقم الحساب.',
                          icon: Icons.account_balance_outlined,
                        ),
                      ],
                    )
                  : null,
            ),
            _TransferServiceCard(
              title: 'بنكك السودان',
              subtitle: 'تحويل إلى حساب بنكك',
              icon: Icons.currency_exchange_outlined,
              color: _danger,
              rate: _rateFor('bankak_sudan'),
              available: _isAvailable('bankak_sudan'),
              onTap: _isAvailable('bankak_sudan')
                  ? () => _openService('bankak_sudan')
                  : null,
            ),
            _TransferServiceCard(
              title: 'تحويل بين الحسابات',
              subtitle: 'تحويل الرصيد داخل منظومة الأهرام',
              icon: Icons.swap_horiz_outlined,
              color: AhramColors.sky,
              rate: null,
              available: true,
              onTap: _openBalanceTransfer,
            ),
          ]),
        ],
      ),
    );
  }

  Widget _selectedServiceSummary() {
    return SurfacePanel(
      child: ListTile(
        contentPadding: EdgeInsets.zero,
        leading: Container(
          width: 42,
          height: 42,
          decoration: BoxDecoration(
            color: _green.withValues(alpha: 0.10),
            borderRadius: BorderRadius.circular(8),
          ),
          child: const Icon(Icons.send_to_mobile_outlined, color: _green),
        ),
        title: Text(
          _selectedServiceLabel,
          style: const TextStyle(fontWeight: FontWeight.w900),
        ),
        subtitle: Text('سعر الصرف ${formatAmount(_rate)} د.ل'),
        trailing: TextButton.icon(
          onPressed: _backToServices,
          icon: const Icon(Icons.apps_outlined),
          label: const Text('تغيير'),
        ),
      ),
    );
  }

  Widget _balanceTransferPage() {
    return PageFrame(
      title: 'تحويل بين الحسابات',
      subtitle: 'انقل رصيدك إلى حساب آخر داخل منظومة الأهرام.',
      onRefresh: _loadRates,
      child: [
        Align(
          alignment: AlignmentDirectional.centerStart,
          child: TextButton.icon(
            onPressed: _busy ? null : _backToServices,
            icon: const Icon(Icons.arrow_forward_outlined),
            label: const Text('كل الخدمات'),
          ),
        ),
        const SizedBox(height: 4),
        Form(
          key: _balanceTransferFormKey,
          child: ResponsivePanel(
            children: [
              TextFormField(
                controller: _targetAccountCode,
                enabled: !_busy,
                keyboardType: TextInputType.number,
                textDirection: ui.TextDirection.ltr,
                decoration: InputDecoration(
                  labelText: 'رقم الحساب أو كود العميل',
                  helperText: 'اكتب الرقم ثم اضغط تحقق لعرض اسم المستلم.',
                  prefixIcon: const Icon(Icons.pin_outlined),
                  suffixIcon: _lookingUpTarget
                      ? const Padding(
                          padding: EdgeInsets.all(12),
                          child: SizedBox(
                            width: 18,
                            height: 18,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          ),
                        )
                      : TextButton.icon(
                          style: TextButton.styleFrom(
                            minimumSize: const Size(0, 42),
                          ),
                          onPressed: _busy
                              ? null
                              : _lookupBalanceTransferTarget,
                          icon: const Icon(Icons.search_outlined, size: 18),
                          label: const Text('تحقق'),
                        ),
                ),
                validator: (value) =>
                    RegExp(r'^\d{4,6}$').hasMatch((value ?? '').trim())
                    ? null
                    : 'رمز الحساب يجب أن يتكون من 4 إلى 6 أرقام.',
                onChanged: (_) {
                  if (_balanceTransferTarget != null) {
                    setState(() => _balanceTransferTarget = null);
                  }
                },
              ),
              if (_balanceTransferTarget != null)
                Container(
                  margin: const EdgeInsets.only(top: 12),
                  padding: const EdgeInsets.all(14),
                  decoration: BoxDecoration(
                    color: _green.withValues(alpha: 0.08),
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(color: _green.withValues(alpha: 0.28)),
                  ),
                  child: Row(
                    children: [
                      const Icon(Icons.verified_user_outlined, color: _green),
                      const SizedBox(width: 10),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              '${_balanceTransferTarget!['name'] ?? '-'}',
                              style: const TextStyle(
                                fontWeight: FontWeight.w900,
                              ),
                            ),
                            Text(
                              '${_balanceTransferTarget!['type'] ?? 'حساب'}',
                              style: TextStyle(
                                color: Theme.of(
                                  context,
                                ).colorScheme.onSurfaceVariant,
                              ),
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
              const SizedBox(height: 12),
              TextFormField(
                controller: _amount,
                enabled: !_busy,
                keyboardType: const TextInputType.numberWithOptions(
                  decimal: true,
                ),
                decoration: InputDecoration(
                  labelText: 'القيمة بالدينار الليبي',
                  prefixIcon: Icon(Icons.payments_outlined),
                ),
                validator: (value) {
                  final amount = double.tryParse(
                    (value ?? '').replaceAll(',', '').trim(),
                  );
                  return amount != null && amount > 0
                      ? null
                      : 'أدخل قيمة صحيحة أكبر من صفر.';
                },
              ),
              const SizedBox(height: 12),
              TextFormField(
                controller: _notes,
                enabled: !_busy,
                minLines: 2,
                maxLines: 3,
                maxLength: 500,
                decoration: const InputDecoration(
                  labelText: 'ملاحظة التحويل (اختيارية)',
                  prefixIcon: Icon(Icons.notes_outlined),
                ),
              ),
            ],
          ),
        ),
        if (_error != null) ...[
          const SizedBox(height: 14),
          InlineMessage(message: _error!, color: _danger),
        ],
        const SizedBox(height: 22),
        FilledButton.icon(
          onPressed: _busy ? null : _confirmBalanceTransfer,
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
          label: Text(_busy ? 'جارٍ تنفيذ التحويل...' : 'تحويل'),
        ),
      ],
    );
  }

  Future<void> _previewCashTransfer() async {
    if (!_formKey.currentState!.validate()) return;
    final amount = _cashAmount;
    if (amount < 100 || amount > 50000) {
      setState(
        () => _error =
            'قيمة تحويل محافظ كاش يجب أن تكون بين 100 و50,000 جنيه مصري للعملية الواحدة.',
      );
      return;
    }
    final destination = _number.text.replaceAll(RegExp(r'\s+'), '');
    if (!RegExp(r'^(010|011|012|015)\d{8}$').hasMatch(destination)) {
      setState(
        () => _error =
            'رقم المستلم يجب أن يكون 11 رقماً ويبدأ بـ 010 أو 011 أو 012 أو 015.',
      );
      return;
    }
    setState(() => _error = null);
    if (!mounted) return;
    await showDialog<void>(
      context: context,
      builder: (context) => _CashTransferPreviewDialog(
        destination: destination,
        provider: _cashWalletProvider!,
        amountEgp: amount,
        rate: _rate,
        amountLyd: _cashAmountLyd,
        clientPhone: _clientPhone.text.trim(),
        notes: _notes.text.trim(),
        onConfirm: () async {
          Navigator.pop(context);
          await _submit();
        },
      ),
    );
  }

  Future<void> _previewPostAccountTransfer() async {
    if (!_formKey.currentState!.validate()) return;
    final amount = _cashAmount;
    final account = _number.text.replaceAll(RegExp(r'\s+'), '');
    final nameParts = _name.text
        .trim()
        .split(RegExp(r'\s+'))
        .where((part) => part.isNotEmpty);
    if (amount < 500 ||
        !RegExp(r'^\d{15}$').hasMatch(account) ||
        nameParts.length < 3) {
      setState(
        () => _error =
            'راجع الاسم الثلاثي ورقم الحساب المكون من 15 رقماً وقيمة التحويل.',
      );
      return;
    }
    setState(() => _error = null);
    await showDialog<void>(
      context: context,
      builder: (context) => _PostAccountPreviewDialog(
        beneficiaryName: _name.text.trim(),
        accountNumber: account,
        amountEgp: amount,
        rate: _rate,
        amountLyd: _cashAmountLyd,
        clientPhone: _clientPhone.text.trim(),
        hasOldReceipt: _oldReceipt != null,
        notes: _notes.text.trim(),
        onConfirm: () async {
          Navigator.pop(context);
          await _submit();
        },
      ),
    );
  }

  Future<void> _previewPostCardTransfer() async {
    if (!_formKey.currentState!.validate()) return;
    if (_idCard == null) {
      setState(
        () => _error = 'أرفق صورة البطاقة من الأمام قبل معاينة العملية.',
      );
      return;
    }
    final amount = _cashAmount;
    final nationalId = _number.text.replaceAll(RegExp(r'\s+'), '');
    final recipientPhone = _recipientPhone.text.replaceAll(RegExp(r'\s+'), '');
    final nameParts = _name.text
        .trim()
        .split(RegExp(r'\s+'))
        .where((part) => part.isNotEmpty);
    if (amount < 500 ||
        !RegExp(r'^\d{14}$').hasMatch(nationalId) ||
        !RegExp(r'^(010|011|012|015)\d{8}$').hasMatch(recipientPhone) ||
        nameParts.length < 3 ||
        (_governorate ?? '').isEmpty) {
      setState(
        () => _error =
            'راجع جميع الحقول المطلوبة: الاسم الثلاثي، الرقم القومي، الهاتف، المحافظة وصورة البطاقة.',
      );
      return;
    }
    setState(() => _error = null);
    await showDialog<void>(
      context: context,
      builder: (context) => _PostCardPreviewDialog(
        beneficiaryName: _name.text.trim(),
        nationalId: nationalId,
        recipientPhone: recipientPhone,
        governorate: _governorate!,
        amountEgp: amount,
        rate: _rate,
        amountLyd: _cashAmountLyd,
        clientPhone: _clientPhone.text.trim(),
        notes: _notes.text.trim(),
        onConfirm: () async {
          Navigator.pop(context);
          await _submit();
        },
      ),
    );
  }

  Future<void> _previewNitaTransfer({bool nitaAccount = false}) async {
    if (!_formKey.currentState!.validate()) return;
    final amount = _cashAmount;
    final account = _number.text.replaceAll(RegExp(r'\s+'), '');
    if (amount < 10 ||
        amount != amount.roundToDouble() ||
        !RegExp(r'^\d{8,11}$').hasMatch(account) ||
        _name.text.trim().length < 2 ||
        (!nitaAccount && !_nigerCities.contains(_city.text.trim())) ||
        (!nitaAccount && !_dataEntryAcknowledged)) {
      setState(
        () => _error = nitaAccount
            ? 'راجع اسم المستفيد ورقم الحساب وقيمة السيفا.'
            : 'راجع الاسم ورقم الحساب والمدينة وقيمة السيفا وتأكيد صحة البيانات.',
      );
      return;
    }
    setState(() => _error = null);
    await showDialog<void>(
      context: context,
      builder: (context) => _NitaPreviewDialog(
        beneficiaryName: _name.text.trim(),
        accountNumber: account,
        city: nitaAccount ? null : _city.text.trim(),
        nitaAccount: nitaAccount,
        amountSefa: amount,
        rate: _rate,
        amountLyd: _sefaAmountLyd,
        clientPhone: _clientPhone.text.trim(),
        notes: _notes.text.trim(),
        onConfirm: () async {
          Navigator.pop(context);
          await _submit();
        },
      ),
    );
  }

  Widget _nitaPage({bool nitaAccount = false}) {
    final title = nitaAccount ? 'NITA ACCOUNT' : 'NITA';
    return PageFrame(
      title: title,
      subtitle: nitaAccount
          ? 'تحويل سيفا إلى حساب NITA ACCOUNT في النيجر.'
          : 'تحويل سيفا إلى حساب NITA في النيجر.',
      onRefresh: _loadRates,
      child: [
        Align(
          alignment: AlignmentDirectional.centerStart,
          child: TextButton.icon(
            onPressed: _busy ? null : _backToServices,
            icon: const Icon(Icons.arrow_forward_outlined),
            label: const Text('كل الخدمات'),
          ),
        ),
        const SizedBox(height: 4),
        SurfacePanel(
          child: Row(
            children: [
              HeritageServiceGlyph(
                icon: Icons.language_outlined,
                color: const Color(0xFF158A9B),
                muted: false,
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'تحويل $title',
                      style: TextStyle(fontWeight: FontWeight.w900),
                    ),
                    SizedBox(height: 3),
                    Text(
                      'الحد الأدنى للعملية 10 سيفا',
                      style: TextStyle(fontSize: 12),
                    ),
                  ],
                ),
              ),
              const Text(
                '🇳🇪',
                textDirection: ui.TextDirection.ltr,
                style: TextStyle(fontSize: 24),
              ),
            ],
          ),
        ),
        const SizedBox(height: 14),
        Form(
          key: _formKey,
          child: Column(
            children: [
              TextFormField(
                controller: _name,
                enabled: !_busy,
                decoration: const InputDecoration(
                  labelText: 'اسم المستفيد',
                  prefixIcon: Icon(Icons.badge_outlined),
                ),
                validator: (value) => (value ?? '').trim().length >= 2
                    ? null
                    : 'أدخل اسم المستفيد.',
              ),
              const SizedBox(height: 14),
              TextFormField(
                controller: _number,
                enabled: !_busy,
                keyboardType: TextInputType.number,
                textDirection: ui.TextDirection.ltr,
                maxLength: 11,
                decoration: InputDecoration(
                  labelText: 'رقم حساب $title',
                  hintText: 'من 8 إلى 11 رقماً',
                  prefixIcon: Icon(Icons.account_balance_outlined),
                ),
                validator: (value) =>
                    RegExp(
                      r'^\d{8,11}$',
                    ).hasMatch((value ?? '').replaceAll(RegExp(r'\s+'), ''))
                    ? null
                    : 'رقم الحساب يجب أن يكون من 8 إلى 11 رقماً.',
              ),
              if (!nitaAccount) ...[
                const SizedBox(height: 14),
                TextFormField(
                  controller: _city,
                  readOnly: true,
                  enabled: !_busy,
                  onTap: _selectNigerCity,
                  decoration: const InputDecoration(
                    labelText: 'مدينة المستفيد',
                    hintText: 'اختر من قائمة MyNITA',
                    prefixIcon: Icon(Icons.location_city_outlined),
                    suffixIcon: Icon(Icons.search_outlined),
                  ),
                  validator: (value) =>
                      _nigerCities.contains((value ?? '').trim())
                      ? null
                      : 'اختر مدينة المستفيد من القائمة.',
                ),
              ],
              const SizedBox(height: 14),
              TextFormField(
                controller: _amount,
                enabled: !_busy,
                keyboardType: TextInputType.number,
                textDirection: ui.TextDirection.ltr,
                decoration: const InputDecoration(
                  labelText: 'القيمة بالسيفا',
                  hintText: '10 أو أكثر',
                  prefixIcon: Padding(
                    padding: EdgeInsets.all(13),
                    child: Text(
                      '🇳🇪',
                      textDirection: ui.TextDirection.ltr,
                      style: TextStyle(fontSize: 20),
                    ),
                  ),
                ),
                validator: (value) {
                  final amount = numberValue((value ?? '').replaceAll(',', ''));
                  return amount >= 10 && amount == amount.roundToDouble()
                      ? null
                      : 'أدخل قيمة صحيحة لا تقل عن 10 سيفا.';
                },
                onChanged: (_) => _updateLydFromSefa(),
              ),
              const SizedBox(height: 12),
              _SefaRateSummary(
                rate: _rate,
                controller: _lydAmount,
                enabled: !_busy,
                onChanged: (_) => _updateSefaFromLyd(),
              ),
              const SizedBox(height: 14),
              TextFormField(
                controller: _clientPhone,
                enabled: !_busy,
                keyboardType: TextInputType.phone,
                textDirection: ui.TextDirection.ltr,
                decoration: const InputDecoration(
                  labelText: 'رقم واتساب العميل',
                  hintText: '09xxxxxxxx أو 01xxxxxxxxx',
                  prefixIcon: Icon(Icons.chat_outlined),
                ),
                validator: (value) {
                  final digits = (value ?? '').replaceAll(RegExp(r'\D'), '');
                  return RegExp(r'^09\d{8}$').hasMatch(digits) ||
                          RegExp(r'^01\d{9}$').hasMatch(digits)
                      ? null
                      : 'أدخل رقم واتساب صحيحاً لاستلام الإيصال.';
                },
              ),
              const SizedBox(height: 14),
              TextFormField(
                controller: _notes,
                enabled: !_busy,
                minLines: 2,
                maxLines: 3,
                maxLength: 500,
                decoration: const InputDecoration(
                  labelText: 'ملاحظات (اختيارية)',
                  prefixIcon: Icon(Icons.notes_outlined),
                ),
              ),
              if (!nitaAccount) ...[
                const SizedBox(height: 6),
                CheckboxListTile(
                  value: _dataEntryAcknowledged,
                  contentPadding: EdgeInsets.zero,
                  controlAffinity: ListTileControlAffinity.leading,
                  title: const Text(
                    'أؤكد أن بيانات المستفيد صحيحة وأتحمل مسؤوليتها.',
                    style: TextStyle(fontSize: 13, fontWeight: FontWeight.w700),
                  ),
                  onChanged: _busy
                      ? null
                      : (value) => setState(
                          () => _dataEntryAcknowledged = value ?? false,
                        ),
                ),
              ],
            ],
          ),
        ),
        if (_error != null) ...[
          const SizedBox(height: 14),
          InlineMessage(message: _error!, color: _danger),
        ],
        const SizedBox(height: 22),
        FilledButton.icon(
          onPressed: _busy
              ? null
              : () => _previewNitaTransfer(nitaAccount: nitaAccount),
          style: FilledButton.styleFrom(
            minimumSize: const Size.fromHeight(54),
            backgroundColor: const Color(0xFF158A9B),
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
              : const Icon(Icons.visibility_outlined),
          label: Text(_busy ? 'جارٍ تجهيز العملية...' : 'معاينة العملية'),
        ),
      ],
    );
  }

  Future<void> _previewBankakTransfer() async {
    if (!_formKey.currentState!.validate()) return;
    final amount = _cashAmount;
    final account = _number.text.replaceAll(RegExp(r'\s+'), '');
    final recipientPhone = _recipientPhone.text.replaceAll(RegExp(r'\s+'), '');
    if (amount <= 0 ||
        _name.text.trim().length < 2 ||
        !RegExp(r'^\d{14}$').hasMatch(account) ||
        !RegExp(r'^\+?\d{9,15}$').hasMatch(recipientPhone)) {
      setState(
        () => _error =
            'راجع اسم المستفيد ورقم الحساب المكون من 14 رقماً وهاتف المستلم وقيمة التحويل.',
      );
      return;
    }
    setState(() => _error = null);
    await showDialog<void>(
      context: context,
      builder: (context) => _BankakPreviewDialog(
        beneficiaryName: _name.text.trim(),
        accountNumber: account,
        recipientPhone: recipientPhone,
        amountSudanese: amount,
        rate: _rate,
        amountLyd: _cashAmountLyd,
        clientPhone: _clientPhone.text.trim(),
        notes: _notes.text.trim(),
        onConfirm: () async {
          Navigator.pop(context);
          await _submit();
        },
      ),
    );
  }

  Widget _bankakPage() {
    return PageFrame(
      title: 'بنكك السودان',
      subtitle: 'تحويل بالجنيه السوداني إلى حساب بنكك.',
      onRefresh: _loadRates,
      child: [
        Align(
          alignment: AlignmentDirectional.centerStart,
          child: TextButton.icon(
            onPressed: _busy ? null : _backToServices,
            icon: const Icon(Icons.arrow_forward_outlined),
            label: const Text('كل الخدمات'),
          ),
        ),
        const SizedBox(height: 4),
        SurfacePanel(
          child: Row(
            children: [
              HeritageServiceGlyph(
                icon: Icons.account_balance_outlined,
                color: const Color(0xFF198754),
                muted: false,
              ),
              const SizedBox(width: 12),
              const Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'تحويل بنكك السودان',
                      style: TextStyle(fontWeight: FontWeight.w900),
                    ),
                    SizedBox(height: 3),
                    Text('رقم الحساب 14 رقماً', style: TextStyle(fontSize: 12)),
                  ],
                ),
              ),
              const Text(
                '🇸🇩',
                textDirection: ui.TextDirection.ltr,
                style: TextStyle(fontSize: 24),
              ),
            ],
          ),
        ),
        const SizedBox(height: 14),
        Form(
          key: _formKey,
          child: Column(
            children: [
              TextFormField(
                controller: _name,
                enabled: !_busy,
                decoration: const InputDecoration(
                  labelText: 'اسم المستفيد',
                  prefixIcon: Icon(Icons.badge_outlined),
                ),
                validator: (value) => (value ?? '').trim().length >= 2
                    ? null
                    : 'أدخل اسم المستفيد.',
              ),
              const SizedBox(height: 14),
              TextFormField(
                controller: _number,
                enabled: !_busy,
                keyboardType: TextInputType.number,
                textDirection: ui.TextDirection.ltr,
                maxLength: 14,
                decoration: const InputDecoration(
                  labelText: 'رقم حساب بنكك',
                  hintText: '14 رقماً',
                  prefixIcon: Icon(Icons.account_balance_outlined),
                ),
                validator: (value) =>
                    RegExp(
                      r'^\d{14}$',
                    ).hasMatch((value ?? '').replaceAll(RegExp(r'\s+'), ''))
                    ? null
                    : 'رقم حساب بنكك يجب أن يتكون من 14 رقماً.',
              ),
              const SizedBox(height: 14),
              TextFormField(
                controller: _recipientPhone,
                enabled: !_busy,
                keyboardType: TextInputType.phone,
                textDirection: ui.TextDirection.ltr,
                decoration: const InputDecoration(
                  labelText: 'رقم هاتف المستلم',
                  hintText: 'رقم هاتف المستفيد في السودان',
                  prefixIcon: Icon(Icons.phone_android_outlined),
                ),
                validator: (value) =>
                    RegExp(
                      r'^\+?\d{9,15}$',
                    ).hasMatch((value ?? '').replaceAll(RegExp(r'\s+'), ''))
                    ? null
                    : 'أدخل رقم هاتف مستلم صحيحاً.',
              ),
              const SizedBox(height: 14),
              TextFormField(
                controller: _amount,
                enabled: !_busy,
                keyboardType: const TextInputType.numberWithOptions(
                  decimal: true,
                ),
                textDirection: ui.TextDirection.ltr,
                decoration: const InputDecoration(
                  labelText: 'القيمة بالجنيه السوداني',
                  hintText: '0',
                  prefixIcon: Padding(
                    padding: EdgeInsets.all(13),
                    child: Text(
                      '🇸🇩',
                      textDirection: ui.TextDirection.ltr,
                      style: TextStyle(fontSize: 20),
                    ),
                  ),
                ),
                validator: (value) =>
                    numberValue((value ?? '').replaceAll(',', '')) > 0
                    ? null
                    : 'أدخل قيمة صحيحة أكبر من صفر.',
                onChanged: (_) => _updateLydFromEgp(),
              ),
              const SizedBox(height: 12),
              _BankakRateSummary(
                rate: _rate,
                controller: _lydAmount,
                enabled: !_busy,
                onChanged: (_) => _updateEgpFromLyd(),
              ),
              const SizedBox(height: 14),
              TextFormField(
                controller: _clientPhone,
                enabled: !_busy,
                keyboardType: TextInputType.phone,
                textDirection: ui.TextDirection.ltr,
                decoration: const InputDecoration(
                  labelText: 'رقم واتساب العميل',
                  hintText: '09xxxxxxxx أو 01xxxxxxxxx',
                  prefixIcon: Icon(Icons.chat_outlined),
                ),
                validator: (value) {
                  final digits = (value ?? '').replaceAll(RegExp(r'\D'), '');
                  return RegExp(r'^09\d{8}$').hasMatch(digits) ||
                          RegExp(r'^01\d{9}$').hasMatch(digits)
                      ? null
                      : 'أدخل رقم واتساب صحيحاً لاستلام الإيصال.';
                },
              ),
              const SizedBox(height: 14),
              TextFormField(
                controller: _notes,
                enabled: !_busy,
                minLines: 2,
                maxLines: 3,
                maxLength: 500,
                decoration: const InputDecoration(
                  labelText: 'ملاحظات (اختيارية)',
                  prefixIcon: Icon(Icons.notes_outlined),
                ),
              ),
            ],
          ),
        ),
        if (_error != null) ...[
          const SizedBox(height: 14),
          InlineMessage(message: _error!, color: _danger),
        ],
        const SizedBox(height: 22),
        FilledButton.icon(
          onPressed: _busy ? null : _previewBankakTransfer,
          style: FilledButton.styleFrom(
            minimumSize: const Size.fromHeight(54),
            backgroundColor: const Color(0xFF198754),
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
              : const Icon(Icons.visibility_outlined),
          label: Text(_busy ? 'جارٍ تجهيز العملية...' : 'معاينة العملية'),
        ),
      ],
    );
  }

  bool _isValidInstapayRecipient(String value) {
    final normalized = value.replaceAll(RegExp(r'\s+'), '');
    return RegExp(
      r'^(?:(010|011|012|015)\d{8}|[A-Za-z0-9._@-]{3,50}|\d{16})$',
    ).hasMatch(normalized);
  }

  Future<void> _previewInstapayTransfer() async {
    if (!_formKey.currentState!.validate()) return;
    final amount = _cashAmount;
    final recipient = _number.text.replaceAll(RegExp(r'\s+'), '');
    final nameParts = _name.text
        .trim()
        .split(RegExp(r'\s+'))
        .where((part) => part.isNotEmpty);
    if (amount < 500 ||
        nameParts.length < 3 ||
        !_isValidInstapayRecipient(recipient)) {
      setState(
        () => _error =
            'راجع الاسم الثلاثي وبيانات المستلم وقيمة التحويل قبل المتابعة.',
      );
      return;
    }
    setState(() => _error = null);
    await showDialog<void>(
      context: context,
      builder: (context) => _InstapayPreviewDialog(
        beneficiaryName: _name.text.trim(),
        recipient: recipient,
        amountEgp: amount,
        rate: _rate,
        amountLyd: _cashAmountLyd,
        clientPhone: _clientPhone.text.trim(),
        notes: _notes.text.trim(),
        onConfirm: () async {
          Navigator.pop(context);
          await _submit();
        },
      ),
    );
  }

  Widget _instapayPage() {
    return PageFrame(
      title: 'تحويل إنستا باي',
      subtitle: 'تحويل فوري إلى رقم هاتف أو عنوان دفع أو بطاقة إلكترونية.',
      onRefresh: _loadRates,
      child: [
        Align(
          alignment: AlignmentDirectional.centerStart,
          child: TextButton.icon(
            onPressed: _busy ? null : _backToServices,
            icon: const Icon(Icons.arrow_forward_outlined),
            label: const Text('كل الخدمات'),
          ),
        ),
        const SizedBox(height: 4),
        SurfacePanel(
          child: Row(
            children: [
              HeritageServiceGlyph(
                icon: Icons.bolt_outlined,
                color: AhramColors.sky,
                muted: false,
              ),
              const SizedBox(width: 12),
              const Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'تحويل إنستا باي',
                      style: TextStyle(fontWeight: FontWeight.w900),
                    ),
                    SizedBox(height: 3),
                    Text(
                      'الحد الأدنى للعملية 500 ج.م',
                      style: TextStyle(fontSize: 12),
                    ),
                  ],
                ),
              ),
              const Text(
                '🇪🇬',
                textDirection: ui.TextDirection.ltr,
                style: TextStyle(fontSize: 24),
              ),
            ],
          ),
        ),
        const SizedBox(height: 14),
        Form(
          key: _formKey,
          child: Column(
            children: [
              TextFormField(
                controller: _name,
                enabled: !_busy,
                decoration: const InputDecoration(
                  labelText: 'اسم المستفيد الثلاثي',
                  hintText: 'الاسم الأول واسم الأب والجد',
                  prefixIcon: Icon(Icons.badge_outlined),
                ),
                validator: (value) =>
                    (value ?? '')
                            .trim()
                            .split(RegExp(r'\s+'))
                            .where((part) => part.isNotEmpty)
                            .length >=
                        3
                    ? null
                    : 'أدخل اسم المستفيد ثلاثياً.',
              ),
              const SizedBox(height: 14),
              TextFormField(
                controller: _number,
                enabled: !_busy,
                keyboardType: TextInputType.text,
                textDirection: ui.TextDirection.ltr,
                maxLength: 50,
                decoration: const InputDecoration(
                  labelText: 'هاتف أو عنوان دفع لحظي أو بطاقة إلكترونية',
                  hintText: '010xxxxxxxx أو name@bank أو رقم البطاقة',
                  prefixIcon: Icon(Icons.alternate_email_outlined),
                ),
                validator: (value) => _isValidInstapayRecipient(value ?? '')
                    ? null
                    : 'أدخل رقم هاتف أو عنوان دفع لحظي أو رقم بطاقة صحيحاً.',
              ),
              const SizedBox(height: 14),
              TextFormField(
                controller: _amount,
                enabled: !_busy,
                keyboardType: const TextInputType.numberWithOptions(
                  decimal: true,
                ),
                textDirection: ui.TextDirection.ltr,
                decoration: const InputDecoration(
                  labelText: 'القيمة بالجنيه المصري',
                  hintText: '500 أو أكثر',
                  prefixIcon: Padding(
                    padding: EdgeInsets.all(13),
                    child: Text(
                      '🇪🇬',
                      textDirection: ui.TextDirection.ltr,
                      style: TextStyle(fontSize: 20),
                    ),
                  ),
                ),
                validator: (value) =>
                    numberValue((value ?? '').replaceAll(',', '')) >= 500
                    ? null
                    : 'الحد الأدنى 500 جنيه مصري.',
                onChanged: (_) => _updateLydFromEgp(),
              ),
              const SizedBox(height: 12),
              _CashRateSummary(
                rate: _rate,
                controller: _lydAmount,
                enabled: !_busy,
                onChanged: (_) => _updateEgpFromLyd(),
              ),
              const SizedBox(height: 14),
              TextFormField(
                controller: _clientPhone,
                enabled: !_busy,
                keyboardType: TextInputType.phone,
                textDirection: ui.TextDirection.ltr,
                decoration: const InputDecoration(
                  labelText: 'رقم واتساب العميل',
                  hintText: '09xxxxxxxx أو 01xxxxxxxxx',
                  prefixIcon: Icon(Icons.chat_outlined),
                ),
                validator: (value) {
                  final digits = (value ?? '').replaceAll(RegExp(r'\D'), '');
                  return RegExp(r'^09\d{8}$').hasMatch(digits) ||
                          RegExp(r'^01\d{9}$').hasMatch(digits)
                      ? null
                      : 'أدخل رقم واتساب صحيحاً لاستلام الإيصال.';
                },
              ),
              const SizedBox(height: 14),
              TextFormField(
                controller: _notes,
                enabled: !_busy,
                minLines: 2,
                maxLines: 3,
                maxLength: 500,
                decoration: const InputDecoration(
                  labelText: 'ملاحظات (اختيارية)',
                  prefixIcon: Icon(Icons.notes_outlined),
                ),
              ),
            ],
          ),
        ),
        if (_error != null) ...[
          const SizedBox(height: 14),
          InlineMessage(message: _error!, color: _danger),
        ],
        const SizedBox(height: 22),
        FilledButton.icon(
          onPressed: _busy ? null : _previewInstapayTransfer,
          style: FilledButton.styleFrom(
            minimumSize: const Size.fromHeight(54),
            backgroundColor: AhramColors.sky,
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
              : const Icon(Icons.visibility_outlined),
          label: Text(_busy ? 'جارٍ تجهيز العملية...' : 'معاينة العملية'),
        ),
      ],
    );
  }

  Future<void> _selectEgyptBank() async {
    final search = TextEditingController();
    final selected = await showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      builder: (context) => StatefulBuilder(
        builder: (context, setModalState) {
          final query = search.text.trim().toLowerCase();
          final banks = _egyptBanks
              .where(
                (bank) => query.isEmpty || bank.toLowerCase().contains(query),
              )
              .toList();
          return SafeArea(
            child: FractionallySizedBox(
              heightFactor: 0.82,
              child: Padding(
                padding: const EdgeInsets.fromLTRB(20, 8, 20, 20),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Center(
                      child: Container(
                        width: 38,
                        height: 4,
                        decoration: BoxDecoration(
                          color: Theme.of(context).colorScheme.outlineVariant,
                          borderRadius: BorderRadius.circular(4),
                        ),
                      ),
                    ),
                    const SizedBox(height: 18),
                    const Text(
                      'اختيار البنك',
                      style: TextStyle(
                        fontWeight: FontWeight.w900,
                        fontSize: 19,
                      ),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      'ابحث باسم البنك أو جزء منه.',
                      style: TextStyle(
                        color: Theme.of(context).colorScheme.onSurfaceVariant,
                        fontSize: 12,
                      ),
                    ),
                    const SizedBox(height: 14),
                    TextField(
                      controller: search,
                      autofocus: true,
                      onChanged: (_) => setModalState(() {}),
                      decoration: const InputDecoration(
                        labelText: 'بحث عن بنك',
                        prefixIcon: Icon(Icons.search_outlined),
                      ),
                    ),
                    const SizedBox(height: 8),
                    Expanded(
                      child: banks.isEmpty
                          ? const Center(child: Text('لا توجد نتائج مطابقة.'))
                          : ListView.separated(
                              itemCount: banks.length,
                              separatorBuilder: (_, _) =>
                                  const Divider(height: 1),
                              itemBuilder: (context, index) {
                                final bank = banks[index];
                                return ListTile(
                                  leading: const Icon(
                                    Icons.account_balance_outlined,
                                  ),
                                  title: Text(bank),
                                  trailing: _bankName == bank
                                      ? const Icon(
                                          Icons.check_circle,
                                          color: _green,
                                        )
                                      : null,
                                  onTap: () => Navigator.pop(context, bank),
                                );
                              },
                            ),
                    ),
                  ],
                ),
              ),
            ),
          );
        },
      ),
    );
    search.dispose();
    if (!mounted || selected == null) return;
    setState(() {
      _bankName = selected;
      _bankNameController.text = selected;
    });
  }

  Future<void> _selectNigerCity() async {
    final search = TextEditingController();
    final selected = await showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      builder: (context) => StatefulBuilder(
        builder: (context, setModalState) {
          final query = search.text.trim().toLowerCase();
          final cities = _nigerCities
              .where(
                (city) => query.isEmpty || city.toLowerCase().contains(query),
              )
              .toList();
          return SafeArea(
            child: FractionallySizedBox(
              heightFactor: 0.82,
              child: Padding(
                padding: const EdgeInsets.fromLTRB(20, 8, 20, 20),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Center(
                      child: Container(
                        width: 38,
                        height: 4,
                        decoration: BoxDecoration(
                          color: Theme.of(context).colorScheme.outlineVariant,
                          borderRadius: BorderRadius.circular(4),
                        ),
                      ),
                    ),
                    const SizedBox(height: 18),
                    const Text(
                      'اختيار مدينة المستفيد',
                      style: TextStyle(
                        fontWeight: FontWeight.w900,
                        fontSize: 19,
                      ),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      'ابحث باسم المدينة كما يظهر في MyNITA.',
                      style: TextStyle(
                        color: Theme.of(context).colorScheme.onSurfaceVariant,
                        fontSize: 12,
                      ),
                    ),
                    const SizedBox(height: 14),
                    TextField(
                      controller: search,
                      autofocus: true,
                      onChanged: (_) => setModalState(() {}),
                      decoration: const InputDecoration(
                        labelText: 'بحث عن مدينة',
                        prefixIcon: Icon(Icons.search_outlined),
                      ),
                    ),
                    const SizedBox(height: 8),
                    Expanded(
                      child: cities.isEmpty
                          ? const Center(child: Text('لا توجد مدينة مطابقة.'))
                          : ListView.separated(
                              itemCount: cities.length,
                              separatorBuilder: (_, _) =>
                                  const Divider(height: 1),
                              itemBuilder: (context, index) {
                                final city = cities[index];
                                return ListTile(
                                  leading: const Icon(
                                    Icons.location_city_outlined,
                                  ),
                                  title: Text(city),
                                  trailing: _city.text == city
                                      ? const Icon(
                                          Icons.check_circle,
                                          color: _green,
                                        )
                                      : null,
                                  onTap: () => Navigator.pop(context, city),
                                );
                              },
                            ),
                    ),
                  ],
                ),
              ),
            ),
          );
        },
      ),
    );
    search.dispose();
    if (!mounted || selected == null) return;
    setState(() => _city.text = selected);
  }

  Future<void> _previewBankTransfer() async {
    if (!_formKey.currentState!.validate()) return;
    final amount = _cashAmount;
    final account = _number.text.replaceAll(RegExp(r'\s+'), '');
    final nameParts = _name.text
        .trim()
        .split(RegExp(r'\s+'))
        .where((part) => part.isNotEmpty);
    if (amount < 500 ||
        !RegExp(r'^[A-Za-z0-9-]{8,34}$').hasMatch(account) ||
        nameParts.length < 3 ||
        (_bankName ?? '').isEmpty) {
      setState(
        () => _error =
            'راجع اسم المستفيد الثلاثي ورقم الحساب أو IBAN واسم البنك وقيمة التحويل.',
      );
      return;
    }
    setState(() => _error = null);
    await showDialog<void>(
      context: context,
      builder: (context) => _BankTransferPreviewDialog(
        beneficiaryName: _name.text.trim(),
        accountNumber: account,
        bankName: _bankName!,
        amountEgp: amount,
        rate: _rate,
        amountLyd: _cashAmountLyd,
        clientPhone: _clientPhone.text.trim(),
        hasAccountProof: _oldReceipt != null,
        notes: _notes.text.trim(),
        onConfirm: () async {
          Navigator.pop(context);
          await _submit();
        },
      ),
    );
  }

  Widget _bankTransferPage() {
    return PageFrame(
      title: 'تحويل بنكي',
      subtitle: 'تحويل آمن إلى حساب مصرفي أو IBAN داخل مصر.',
      onRefresh: _loadRates,
      child: [
        Align(
          alignment: AlignmentDirectional.centerStart,
          child: TextButton.icon(
            onPressed: _busy ? null : _backToServices,
            icon: const Icon(Icons.arrow_forward_outlined),
            label: const Text('كل الخدمات'),
          ),
        ),
        const SizedBox(height: 4),
        SurfacePanel(
          child: Row(
            children: [
              HeritageServiceGlyph(
                icon: Icons.account_balance_outlined,
                color: _gold,
                muted: false,
              ),
              const SizedBox(width: 12),
              const Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'تحويل بنكي مصري',
                      style: TextStyle(fontWeight: FontWeight.w900),
                    ),
                    SizedBox(height: 3),
                    Text(
                      'الحد الأدنى للعملية 500 ج.م',
                      style: TextStyle(fontSize: 12),
                    ),
                  ],
                ),
              ),
              const Text(
                '🇪🇬',
                textDirection: ui.TextDirection.ltr,
                style: TextStyle(fontSize: 24),
              ),
            ],
          ),
        ),
        const SizedBox(height: 14),
        Form(
          key: _formKey,
          child: Column(
            children: [
              TextFormField(
                controller: _name,
                enabled: !_busy,
                decoration: const InputDecoration(
                  labelText: 'اسم المستفيد الثلاثي',
                  hintText: 'الاسم الأول واسم الأب والجد',
                  prefixIcon: Icon(Icons.badge_outlined),
                ),
                validator: (value) =>
                    (value ?? '')
                            .trim()
                            .split(RegExp(r'\s+'))
                            .where((part) => part.isNotEmpty)
                            .length >=
                        3
                    ? null
                    : 'أدخل اسم المستفيد ثلاثياً.',
              ),
              const SizedBox(height: 14),
              TextFormField(
                controller: _number,
                enabled: !_busy,
                keyboardType: TextInputType.text,
                textDirection: ui.TextDirection.ltr,
                maxLength: 34,
                decoration: const InputDecoration(
                  labelText: 'رقم الحساب البنكي أو IBAN',
                  hintText: 'مثال: EG00 0000 0000 0000',
                  prefixIcon: Icon(Icons.account_balance_wallet_outlined),
                ),
                validator: (value) =>
                    RegExp(
                      r'^[A-Za-z0-9\s-]{8,34}$',
                    ).hasMatch((value ?? '').trim())
                    ? null
                    : 'أدخل رقم حساب أو IBAN صحيحاً.',
              ),
              const SizedBox(height: 14),
              TextFormField(
                controller: _bankNameController,
                enabled: !_busy,
                readOnly: true,
                onTap: _busy ? null : _selectEgyptBank,
                decoration: const InputDecoration(
                  labelText: 'اسم البنك',
                  hintText: 'اضغط لاختيار البنك',
                  prefixIcon: Icon(Icons.account_balance_outlined),
                  suffixIcon: Icon(Icons.keyboard_arrow_down_outlined),
                ),
                validator: (value) =>
                    (value ?? '').trim().isEmpty ? 'اختر اسم البنك.' : null,
              ),
              const SizedBox(height: 14),
              TextFormField(
                controller: _amount,
                enabled: !_busy,
                keyboardType: const TextInputType.numberWithOptions(
                  decimal: true,
                ),
                textDirection: ui.TextDirection.ltr,
                decoration: const InputDecoration(
                  labelText: 'القيمة بالجنيه المصري',
                  hintText: '500 أو أكثر',
                  prefixIcon: Padding(
                    padding: EdgeInsets.all(13),
                    child: Text(
                      '🇪🇬',
                      textDirection: ui.TextDirection.ltr,
                      style: TextStyle(fontSize: 20),
                    ),
                  ),
                ),
                validator: (value) =>
                    numberValue((value ?? '').replaceAll(',', '')) >= 500
                    ? null
                    : 'الحد الأدنى 500 جنيه مصري.',
                onChanged: (_) => _updateLydFromEgp(),
              ),
              const SizedBox(height: 12),
              _CashRateSummary(
                rate: _rate,
                controller: _lydAmount,
                enabled: !_busy,
                onChanged: (_) => _updateEgpFromLyd(),
              ),
              const SizedBox(height: 14),
              SurfacePanel(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    const Text(
                      'صورة بيانات الحساب',
                      style: TextStyle(fontWeight: FontWeight.w900),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      'اختيارية، أرفقها عند توفر بيانات الحساب أو IBAN.',
                      style: TextStyle(
                        color: Theme.of(context).colorScheme.onSurfaceVariant,
                        fontSize: 12,
                      ),
                    ),
                    const SizedBox(height: 12),
                    ProofPicker(
                      required: false,
                      image: _oldReceipt,
                      onPick: () => _pickImage(card: false),
                      onClear: () => setState(() => _oldReceipt = null),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 14),
              TextFormField(
                controller: _clientPhone,
                enabled: !_busy,
                keyboardType: TextInputType.phone,
                textDirection: ui.TextDirection.ltr,
                decoration: const InputDecoration(
                  labelText: 'رقم واتساب العميل',
                  hintText: '09xxxxxxxx أو 01xxxxxxxxx',
                  prefixIcon: Icon(Icons.chat_outlined),
                ),
                validator: (value) {
                  final digits = (value ?? '').replaceAll(RegExp(r'\D'), '');
                  return RegExp(r'^09\d{8}$').hasMatch(digits) ||
                          RegExp(r'^01\d{9}$').hasMatch(digits)
                      ? null
                      : 'أدخل رقم واتساب صحيحاً لاستلام الإيصال.';
                },
              ),
              const SizedBox(height: 14),
              TextFormField(
                controller: _notes,
                enabled: !_busy,
                minLines: 2,
                maxLines: 3,
                maxLength: 500,
                decoration: const InputDecoration(
                  labelText: 'ملاحظات (اختيارية)',
                  prefixIcon: Icon(Icons.notes_outlined),
                ),
              ),
            ],
          ),
        ),
        if (_error != null) ...[
          const SizedBox(height: 14),
          InlineMessage(message: _error!, color: _danger),
        ],
        const SizedBox(height: 22),
        FilledButton.icon(
          onPressed: _busy ? null : _previewBankTransfer,
          style: FilledButton.styleFrom(
            minimumSize: const Size.fromHeight(54),
            backgroundColor: _gold,
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
              : const Icon(Icons.visibility_outlined),
          label: Text(_busy ? 'جارٍ تجهيز العملية...' : 'معاينة العملية'),
        ),
      ],
    );
  }

  Widget _postCardPage() {
    return PageFrame(
      title: 'بريد بطاقة',
      subtitle: 'أدخل بيانات البطاقة والمستفيد بدقة قبل إرسال التحويل.',
      onRefresh: _loadRates,
      child: [
        Align(
          alignment: AlignmentDirectional.centerStart,
          child: TextButton.icon(
            onPressed: _busy ? null : _backToServices,
            icon: const Icon(Icons.arrow_forward_outlined),
            label: const Text('كل الخدمات'),
          ),
        ),
        const SizedBox(height: 4),
        SurfacePanel(
          child: Row(
            children: [
              HeritageServiceGlyph(
                icon: Icons.credit_card_outlined,
                color: const Color(0xFFB8750B),
                muted: false,
              ),
              const SizedBox(width: 12),
              const Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'تحويل بريد بطاقة',
                      style: TextStyle(fontWeight: FontWeight.w900),
                    ),
                    SizedBox(height: 3),
                    Text(
                      'الحد الأدنى للعملية 500 ج.م',
                      style: TextStyle(fontSize: 12),
                    ),
                  ],
                ),
              ),
              const Text(
                '🇪🇬',
                textDirection: ui.TextDirection.ltr,
                style: TextStyle(fontSize: 24),
              ),
            ],
          ),
        ),
        const SizedBox(height: 14),
        Form(
          key: _formKey,
          child: Column(
            children: [
              TextFormField(
                controller: _name,
                enabled: !_busy,
                decoration: const InputDecoration(
                  labelText: 'اسم المستفيد الثلاثي',
                  hintText: 'الاسم الأول واسم الأب والجد',
                  prefixIcon: Icon(Icons.badge_outlined),
                ),
                validator: (value) =>
                    (value ?? '')
                            .trim()
                            .split(RegExp(r'\s+'))
                            .where((part) => part.isNotEmpty)
                            .length >=
                        3
                    ? null
                    : 'أدخل اسم المستفيد ثلاثياً.',
              ),
              const SizedBox(height: 14),
              TextFormField(
                controller: _number,
                enabled: !_busy,
                keyboardType: TextInputType.number,
                textDirection: ui.TextDirection.ltr,
                maxLength: 14,
                decoration: const InputDecoration(
                  labelText: 'الرقم القومي',
                  hintText: '14 رقماً',
                  prefixIcon: Icon(Icons.perm_identity_outlined),
                ),
                validator: (value) =>
                    RegExp(
                      r'^\d{14}$',
                    ).hasMatch((value ?? '').replaceAll(RegExp(r'\s+'), ''))
                    ? null
                    : 'الرقم القومي يجب أن يكون 14 رقماً.',
              ),
              const SizedBox(height: 14),
              TextFormField(
                controller: _recipientPhone,
                enabled: !_busy,
                keyboardType: TextInputType.phone,
                textDirection: ui.TextDirection.ltr,
                maxLength: 11,
                decoration: const InputDecoration(
                  labelText: 'رقم هاتف المستلم في مصر',
                  hintText: '010 أو 011 أو 012 أو 015',
                  prefixIcon: Icon(Icons.phone_android_outlined),
                ),
                validator: (value) =>
                    RegExp(
                      r'^(010|011|012|015)\d{8}$',
                    ).hasMatch((value ?? '').replaceAll(RegExp(r'\s+'), ''))
                    ? null
                    : 'أدخل رقم هاتف مصري صحيحاً من 11 رقماً.',
              ),
              const SizedBox(height: 14),
              TextFormField(
                controller: _amount,
                enabled: !_busy,
                keyboardType: const TextInputType.numberWithOptions(
                  decimal: true,
                ),
                textDirection: ui.TextDirection.ltr,
                decoration: const InputDecoration(
                  labelText: 'القيمة بالجنيه المصري',
                  hintText: '500 أو أكثر',
                  prefixIcon: Padding(
                    padding: EdgeInsets.all(13),
                    child: Text(
                      '🇪🇬',
                      textDirection: ui.TextDirection.ltr,
                      style: TextStyle(fontSize: 20),
                    ),
                  ),
                ),
                validator: (value) =>
                    numberValue((value ?? '').replaceAll(',', '')) >= 500
                    ? null
                    : 'الحد الأدنى 500 جنيه مصري.',
                onChanged: (_) => _updateLydFromEgp(),
              ),
              const SizedBox(height: 12),
              _CashRateSummary(
                rate: _rate,
                controller: _lydAmount,
                enabled: !_busy,
                onChanged: (_) => _updateEgpFromLyd(),
              ),
              const SizedBox(height: 14),
              DropdownButtonFormField<String>(
                initialValue: _governorate,
                isExpanded: true,
                decoration: const InputDecoration(
                  labelText: 'محافظة المستلم',
                  prefixIcon: Icon(Icons.location_city_outlined),
                ),
                items: _egyptGovernorates
                    .map(
                      (governorate) => DropdownMenuItem(
                        value: governorate,
                        child: Text(governorate),
                      ),
                    )
                    .toList(),
                onChanged: _busy
                    ? null
                    : (value) => setState(() => _governorate = value),
                validator: (value) => value == null || value.isEmpty
                    ? 'اختر محافظة المستلم.'
                    : null,
              ),
              const SizedBox(height: 14),
              SurfacePanel(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    const Text(
                      'صورة البطاقة من الأمام',
                      style: TextStyle(fontWeight: FontWeight.w900),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      'مطلوبة للتحقق من الرقم القومي وبيانات المستفيد.',
                      style: TextStyle(
                        color: Theme.of(context).colorScheme.onSurfaceVariant,
                        fontSize: 12,
                      ),
                    ),
                    const SizedBox(height: 12),
                    ProofPicker(
                      required: true,
                      image: _idCard,
                      onPick: () => _pickImage(card: true),
                      onClear: () => setState(() => _idCard = null),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 14),
              TextFormField(
                controller: _clientPhone,
                enabled: !_busy,
                keyboardType: TextInputType.phone,
                textDirection: ui.TextDirection.ltr,
                decoration: const InputDecoration(
                  labelText: 'رقم واتساب العميل',
                  hintText: '09xxxxxxxx أو 01xxxxxxxxx',
                  prefixIcon: Icon(Icons.chat_outlined),
                ),
                validator: (value) {
                  final digits = (value ?? '').replaceAll(RegExp(r'\D'), '');
                  return RegExp(r'^09\d{8}$').hasMatch(digits) ||
                          RegExp(r'^01\d{9}$').hasMatch(digits)
                      ? null
                      : 'أدخل رقم واتساب صحيحاً لاستلام الإيصال.';
                },
              ),
              const SizedBox(height: 14),
              TextFormField(
                controller: _notes,
                enabled: !_busy,
                minLines: 2,
                maxLines: 3,
                maxLength: 500,
                decoration: const InputDecoration(
                  labelText: 'ملاحظات (اختيارية)',
                  prefixIcon: Icon(Icons.notes_outlined),
                ),
              ),
            ],
          ),
        ),
        if (_error != null) ...[
          const SizedBox(height: 14),
          InlineMessage(message: _error!, color: _danger),
        ],
        const SizedBox(height: 22),
        FilledButton.icon(
          onPressed: _busy ? null : _previewPostCardTransfer,
          style: FilledButton.styleFrom(
            minimumSize: const Size.fromHeight(54),
            backgroundColor: const Color(0xFFB8750B),
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
              : const Icon(Icons.visibility_outlined),
          label: Text(_busy ? 'جارٍ تجهيز العملية...' : 'معاينة العملية'),
        ),
      ],
    );
  }

  Widget _postAccountPage() {
    return PageFrame(
      title: 'بريد حساب',
      subtitle: 'أدخل بيانات المستفيد بدقة قبل إرسال التحويل.',
      onRefresh: _loadRates,
      child: [
        Align(
          alignment: AlignmentDirectional.centerStart,
          child: TextButton.icon(
            onPressed: _busy ? null : _backToServices,
            icon: const Icon(Icons.arrow_forward_outlined),
            label: const Text('كل الخدمات'),
          ),
        ),
        const SizedBox(height: 4),
        SurfacePanel(
          child: Row(
            children: [
              HeritageServiceGlyph(
                icon: Icons.markunread_mailbox_outlined,
                color: AhramColors.sky,
                muted: false,
              ),
              const SizedBox(width: 12),
              const Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'تحويل بريد حساب',
                      style: TextStyle(fontWeight: FontWeight.w900),
                    ),
                    SizedBox(height: 3),
                    Text(
                      'الحد الأدنى للعملية 500 ج.م',
                      style: TextStyle(fontSize: 12),
                    ),
                  ],
                ),
              ),
              const Text(
                '🇪🇬',
                textDirection: ui.TextDirection.ltr,
                style: TextStyle(fontSize: 24),
              ),
            ],
          ),
        ),
        const SizedBox(height: 14),
        Form(
          key: _formKey,
          child: Column(
            children: [
              TextFormField(
                controller: _name,
                enabled: !_busy,
                decoration: const InputDecoration(
                  labelText: 'اسم المستفيد الثلاثي',
                  hintText: 'الاسم الأول واسم الأب والجد',
                  prefixIcon: Icon(Icons.badge_outlined),
                ),
                validator: (value) =>
                    (value ?? '')
                            .trim()
                            .split(RegExp(r'\s+'))
                            .where((part) => part.isNotEmpty)
                            .length >=
                        3
                    ? null
                    : 'أدخل اسم المستفيد ثلاثياً.',
              ),
              const SizedBox(height: 14),
              TextFormField(
                controller: _number,
                enabled: !_busy,
                keyboardType: TextInputType.number,
                textDirection: ui.TextDirection.ltr,
                maxLength: 15,
                decoration: const InputDecoration(
                  labelText: 'رقم الحساب البريدي',
                  hintText: '15 رقماً',
                  prefixIcon: Icon(Icons.account_balance_outlined),
                ),
                validator: (value) =>
                    RegExp(
                      r'^\d{15}$',
                    ).hasMatch((value ?? '').replaceAll(RegExp(r'\s+'), ''))
                    ? null
                    : 'رقم الحساب البريدي يجب أن يكون 15 رقماً.',
              ),
              const SizedBox(height: 14),
              TextFormField(
                controller: _amount,
                enabled: !_busy,
                keyboardType: const TextInputType.numberWithOptions(
                  decimal: true,
                ),
                textDirection: ui.TextDirection.ltr,
                decoration: const InputDecoration(
                  labelText: 'القيمة بالجنيه المصري',
                  hintText: '500 أو أكثر',
                  prefixIcon: Padding(
                    padding: EdgeInsets.all(13),
                    child: Text(
                      '🇪🇬',
                      textDirection: ui.TextDirection.ltr,
                      style: TextStyle(fontSize: 20),
                    ),
                  ),
                ),
                validator: (value) =>
                    numberValue((value ?? '').replaceAll(',', '')) >= 500
                    ? null
                    : 'الحد الأدنى 500 جنيه مصري.',
                onChanged: (_) => _updateLydFromEgp(),
              ),
              const SizedBox(height: 12),
              _CashRateSummary(
                rate: _rate,
                controller: _lydAmount,
                enabled: !_busy,
                onChanged: (_) => _updateEgpFromLyd(),
              ),
              const SizedBox(height: 14),
              SurfacePanel(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    const Text(
                      'إيصال تحويل قديم',
                      style: TextStyle(fontWeight: FontWeight.w900),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      'اختياري، أرفقه فقط إذا كان متوفراً لديك.',
                      style: TextStyle(
                        color: Theme.of(context).colorScheme.onSurfaceVariant,
                        fontSize: 12,
                      ),
                    ),
                    const SizedBox(height: 12),
                    ProofPicker(
                      required: false,
                      image: _oldReceipt,
                      onPick: () => _pickImage(card: false),
                      onClear: () => setState(() => _oldReceipt = null),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 14),
              TextFormField(
                controller: _clientPhone,
                enabled: !_busy,
                keyboardType: TextInputType.phone,
                textDirection: ui.TextDirection.ltr,
                decoration: const InputDecoration(
                  labelText: 'رقم واتساب العميل',
                  hintText: '09xxxxxxxx أو 01xxxxxxxxx',
                  prefixIcon: Icon(Icons.chat_outlined),
                ),
                validator: (value) {
                  final digits = (value ?? '').replaceAll(RegExp(r'\D'), '');
                  return RegExp(r'^09\d{8}$').hasMatch(digits) ||
                          RegExp(r'^01\d{9}$').hasMatch(digits)
                      ? null
                      : 'أدخل رقم واتساب صحيحاً لاستلام الإيصال.';
                },
              ),
              const SizedBox(height: 14),
              TextFormField(
                controller: _notes,
                enabled: !_busy,
                minLines: 2,
                maxLines: 3,
                maxLength: 500,
                decoration: const InputDecoration(
                  labelText: 'ملاحظات (اختيارية)',
                  prefixIcon: Icon(Icons.notes_outlined),
                ),
              ),
            ],
          ),
        ),
        if (_error != null) ...[
          const SizedBox(height: 14),
          InlineMessage(message: _error!, color: _danger),
        ],
        const SizedBox(height: 22),
        FilledButton.icon(
          onPressed: _busy ? null : _previewPostAccountTransfer,
          style: FilledButton.styleFrom(
            minimumSize: const Size.fromHeight(54),
            backgroundColor: AhramColors.sky,
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
              : const Icon(Icons.visibility_outlined),
          label: Text(_busy ? 'جارٍ تجهيز العملية...' : 'معاينة العملية'),
        ),
      ],
    );
  }

  Widget _cashTransferPage() {
    final provider = _cashWalletProvider;
    return PageFrame(
      title: 'محافظ كاش',
      subtitle: 'تحويل سريع وآمن إلى المحافظ الإلكترونية المصرية.',
      onRefresh: _loadRates,
      child: [
        Align(
          alignment: AlignmentDirectional.centerStart,
          child: TextButton.icon(
            onPressed: _busy ? null : _backToServices,
            icon: const Icon(Icons.arrow_forward_outlined),
            label: const Text('كل الخدمات'),
          ),
        ),
        const SizedBox(height: 2),
        SurfacePanel(
          child: Row(
            children: [
              Container(
                width: 48,
                height: 48,
                decoration: BoxDecoration(
                  color: _green.withValues(alpha: 0.12),
                  borderRadius: BorderRadius.circular(8),
                ),
                child: const Icon(
                  Icons.account_balance_wallet_outlined,
                  color: _green,
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text(
                      'محافظ كاش',
                      style: TextStyle(fontWeight: FontWeight.w900),
                    ),
                    const SizedBox(height: 3),
                    Text(
                      'الحد للعملية: من 100 إلى 50,000 ج.م',
                      style: TextStyle(
                        color: Theme.of(context).colorScheme.onSurfaceVariant,
                        fontSize: 12,
                      ),
                    ),
                  ],
                ),
              ),
              const Text(
                '🇪🇬',
                textDirection: ui.TextDirection.ltr,
                style: TextStyle(fontSize: 25),
              ),
            ],
          ),
        ),
        const SizedBox(height: 14),
        Form(
          key: _formKey,
          child: Column(
            children: [
              TextFormField(
                controller: _number,
                enabled: !_busy,
                keyboardType: TextInputType.phone,
                textDirection: ui.TextDirection.ltr,
                maxLength: 11,
                decoration: const InputDecoration(
                  labelText: 'رقم هاتف المستلم',
                  hintText: '010XXXXXXXX',
                  prefixIcon: Icon(Icons.phone_android_outlined),
                ),
                validator: (value) {
                  final number = (value ?? '').replaceAll(RegExp(r'\s+'), '');
                  return RegExp(r'^(010|011|012|015)\d{8}$').hasMatch(number)
                      ? null
                      : 'أدخل رقم محفظة صحيحاً من 11 رقماً.';
                },
                onChanged: (_) => setState(() {}),
              ),
              if (provider != null) ...[
                const SizedBox(height: 8),
                Container(
                  width: double.infinity,
                  padding: const EdgeInsetsDirectional.fromSTEB(14, 10, 14, 10),
                  decoration: BoxDecoration(
                    color: provider.color.withValues(alpha: 0.10),
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(
                      color: provider.color.withValues(alpha: 0.32),
                    ),
                  ),
                  child: Row(
                    children: [
                      Icon(
                        Icons.verified_outlined,
                        color: provider.color,
                        size: 20,
                      ),
                      const SizedBox(width: 8),
                      Text(
                        provider.label,
                        style: TextStyle(
                          color: provider.color,
                          fontWeight: FontWeight.w900,
                        ),
                      ),
                    ],
                  ),
                ),
              ],
              const SizedBox(height: 14),
              TextFormField(
                controller: _amount,
                enabled: !_busy,
                keyboardType: const TextInputType.numberWithOptions(
                  decimal: true,
                ),
                textDirection: ui.TextDirection.ltr,
                decoration: const InputDecoration(
                  labelText: 'القيمة بالجنيه المصري',
                  hintText: '100 - 50,000',
                  prefixIcon: Padding(
                    padding: EdgeInsets.all(13),
                    child: Text(
                      '🇪🇬',
                      textDirection: ui.TextDirection.ltr,
                      style: TextStyle(fontSize: 20),
                    ),
                  ),
                ),
                validator: (value) {
                  final amount = double.tryParse(
                    (value ?? '').replaceAll(',', '').trim(),
                  );
                  if (amount == null || amount < 100 || amount > 50000) {
                    return 'أدخل قيمة بين 100 و50,000 جنيه مصري.';
                  }
                  return null;
                },
                onChanged: (_) => _updateLydFromEgp(),
              ),
              const SizedBox(height: 12),
              _CashRateSummary(
                rate: _rate,
                controller: _lydAmount,
                enabled: !_busy,
                onChanged: (_) => _updateEgpFromLyd(),
              ),
              const SizedBox(height: 14),
              TextFormField(
                controller: _clientPhone,
                enabled: !_busy,
                keyboardType: TextInputType.phone,
                textDirection: ui.TextDirection.ltr,
                decoration: const InputDecoration(
                  labelText: 'رقم هاتف العميل للواتساب',
                  hintText: '09xxxxxxxx أو 01xxxxxxxxx',
                  helperText:
                      'يجب أن يكون الرقم مرتبطاً بواتساب ليستلم إيصال التحويل.',
                  prefixIcon: Icon(Icons.chat_outlined),
                ),
                validator: (value) {
                  final phone = (value ?? '').trim();
                  if (phone.isEmpty) {
                    return 'أدخل رقم واتساب العميل لاستلام الإيصال.';
                  }
                  final digits = phone.replaceAll(RegExp(r'\D'), '');
                  final isLibyan = RegExp(r'^09\d{8}$').hasMatch(digits);
                  final isEgyptian = RegExp(r'^01\d{9}$').hasMatch(digits);
                  return isLibyan || isEgyptian
                      ? null
                      : 'أدخل رقماً ليبياً يبدأ بـ 09 أو مصرياً يبدأ بـ 01.';
                },
              ),
              const SizedBox(height: 14),
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
        if (_error != null) ...[
          const SizedBox(height: 14),
          InlineMessage(message: _error!, color: _danger),
        ],
        const SizedBox(height: 22),
        FilledButton.icon(
          onPressed: _busy ? null : _previewCashTransfer,
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
              : const Icon(Icons.visibility_outlined),
          label: Text(_busy ? 'جارٍ تجهيز العملية...' : 'معاينة العملية'),
        ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    final services = _servicesFrom(_home);
    if (_showServiceCatalog) return _catalogPage(services);
    if (_isBalanceTransfer) return _balanceTransferPage();
    if (_serviceKey == 'vodafone') return _cashTransferPage();
    if (_serviceKey == 'post_account') return _postAccountPage();
    if (_serviceKey == 'post_card') return _postCardPage();
    if (_serviceKey == 'bank_account' && _serviceSubtype == 'instapay') {
      return _instapayPage();
    }
    if (_serviceKey == 'bank_account' && _serviceSubtype != 'instapay') {
      return _bankTransferPage();
    }
    if (_serviceKey == 'bankak_sudan') return _bankakPage();
    if (_serviceKey == 'sefa_niger' && _serviceSubtype == 'nita') {
      return _nitaPage();
    }
    if (_serviceKey == 'sefa_niger' && _serviceSubtype == 'nita_account') {
      return _nitaPage(nitaAccount: true);
    }
    final rate = _rate;
    final inputAmount = numberValue(_amount.text.replaceAll(',', ''));
    final sefa = _isSefa;
    final estimate = sefa
        ? inputAmount * rate
        : (rate == 0 ? 0 : inputAmount / rate);

    return PageFrame(
      title: _selectedServiceLabel,
      subtitle: 'أدخل بيانات المستلم بدقة قبل إرسال العملية.',
      onRefresh: _loadRates,
      child: [
        Form(
          key: _formKey,
          child: ResponsivePanel(
            children: [
              _selectedServiceSummary(),
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
                  labelText: _numberLabel,
                  prefixIcon: const Icon(Icons.phone_android_outlined),
                ),
                validator: (value) {
                  final normalized = (value ?? '').replaceAll(
                    RegExp(r'\s+'),
                    '',
                  );
                  if (normalized.length < 5) return 'أدخل الرقم بشكل صحيح.';
                  if (_isSefa && !RegExp(r'^\d{8,10}$').hasMatch(normalized)) {
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
        if (_isSefa) ...[
          const SizedBox(height: 14),
          const InlineMessage(
            message:
                'العميل مسؤول عن صحة البيانات المدخلة، ولا تتحمل الشركة مسؤولية الأخطاء الناتجة عن بيانات المستلم.',
            color: Color(0xFF8A6200),
          ),
          CheckboxListTile.adaptive(
            contentPadding: EdgeInsets.zero,
            value: _dataEntryAcknowledged,
            onChanged: _busy
                ? null
                : (value) =>
                      setState(() => _dataEntryAcknowledged = value ?? false),
            controlAffinity: ListTileControlAffinity.leading,
            title: const Text(
              'أؤكد أنني راجعت اسم المستفيد ورقم الحساب والمدينة قبل الإرسال.',
              style: TextStyle(fontWeight: FontWeight.w800),
            ),
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

class AhramTransferHero extends StatelessWidget {
  const AhramTransferHero({super.key, required this.onTransactions});

  final VoidCallback onTransactions;

  @override
  Widget build(BuildContext context) {
    return Container(
      height: 184,
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(
        color: AhramColors.ink,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: AhramColors.gold.withValues(alpha: 0.62)),
        boxShadow: [
          BoxShadow(
            color: AhramColors.ink.withValues(alpha: 0.28),
            blurRadius: 22,
            offset: const Offset(0, 12),
          ),
          BoxShadow(
            color: AhramColors.gold.withValues(alpha: 0.18),
            blurRadius: 0,
            offset: const Offset(0, 5),
          ),
        ],
      ),
      child: Stack(
        children: [
          PositionedDirectional(
            end: -28,
            top: -36,
            child: Container(
              width: 170,
              height: 170,
              decoration: BoxDecoration(
                border: Border.all(
                  color: AhramColors.gold.withValues(alpha: 0.20),
                ),
                borderRadius: BorderRadius.circular(8),
              ),
            ),
          ),
          PositionedDirectional(
            end: 8,
            bottom: 0,
            child: const _AhramTransferTotem(),
          ),
          Positioned.fill(
            child: Padding(
              padding: const EdgeInsetsDirectional.fromSTEB(20, 20, 140, 17),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Container(
                    padding: const EdgeInsetsDirectional.fromSTEB(9, 5, 9, 5),
                    decoration: BoxDecoration(
                      color: AhramColors.gold.withValues(alpha: 0.14),
                      borderRadius: BorderRadius.circular(8),
                      border: Border.all(
                        color: AhramColors.gold.withValues(alpha: 0.32),
                      ),
                    ),
                    child: const Text(
                      'بوابة المتوسط',
                      style: TextStyle(
                        color: Color(0xFFFFE7A5),
                        fontSize: 11,
                        fontWeight: FontWeight.w900,
                      ),
                    ),
                  ),
                  const SizedBox(height: 11),
                  const Text(
                    'أرسل حوالتك\nبكل وضوح',
                    style: TextStyle(
                      color: Colors.white,
                      fontSize: 23,
                      height: 1.2,
                      fontWeight: FontWeight.w900,
                    ),
                  ),
                  const Spacer(),
                  TextButton.icon(
                    onPressed: onTransactions,
                    style: TextButton.styleFrom(
                      foregroundColor: const Color(0xFFEAF5FF),
                      padding: const EdgeInsets.symmetric(horizontal: 0),
                      visualDensity: VisualDensity.compact,
                    ),
                    icon: const Icon(Icons.receipt_long_outlined, size: 18),
                    label: const Text(
                      'سجل العمليات',
                      style: TextStyle(fontWeight: FontWeight.w800),
                    ),
                  ),
                ],
              ),
            ),
          ),
          const Positioned(
            top: 0,
            left: 0,
            right: 0,
            child: Row(
              children: [
                Expanded(
                  child: SizedBox(
                    height: 4,
                    child: ColoredBox(color: AhramColors.gold),
                  ),
                ),
                Expanded(
                  child: SizedBox(
                    height: 4,
                    child: ColoredBox(color: AhramColors.emerald),
                  ),
                ),
                Expanded(
                  child: SizedBox(
                    height: 4,
                    child: ColoredBox(color: AhramColors.sky),
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

class _AhramTransferTotem extends StatelessWidget {
  const _AhramTransferTotem();

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: 146,
      height: 160,
      child: Stack(
        clipBehavior: Clip.none,
        children: [
          Positioned(
            bottom: 8,
            left: 17,
            child: Container(
              width: 106,
              height: 24,
              decoration: BoxDecoration(
                color: const Color(0xFF021127),
                borderRadius: BorderRadius.circular(8),
                boxShadow: [
                  BoxShadow(
                    color: Colors.black.withValues(alpha: 0.42),
                    blurRadius: 16,
                    offset: const Offset(0, 9),
                  ),
                ],
              ),
            ),
          ),
          Positioned(
            bottom: 26,
            left: 21,
            child: Transform.rotate(
              angle: -0.16,
              child: Container(
                width: 100,
                height: 68,
                decoration: BoxDecoration(
                  color: const Color(0xFF1471D8),
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(
                    color: const Color(0xFF7EB4FF),
                    width: 1.2,
                  ),
                  boxShadow: [
                    BoxShadow(
                      color: Colors.black.withValues(alpha: 0.34),
                      blurRadius: 12,
                      offset: const Offset(0, 8),
                    ),
                  ],
                ),
                child: const Center(
                  child: Icon(
                    Icons.currency_exchange_outlined,
                    color: Colors.white,
                    size: 34,
                  ),
                ),
              ),
            ),
          ),
          Positioned(
            bottom: 51,
            left: 37,
            child: Transform.rotate(
              angle: 0.13,
              child: Container(
                width: 91,
                height: 60,
                decoration: BoxDecoration(
                  color: const Color(0xFF10A995),
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(
                    color: const Color(0xFF8BE0D2),
                    width: 1.2,
                  ),
                  boxShadow: [
                    BoxShadow(
                      color: Colors.black.withValues(alpha: 0.30),
                      blurRadius: 10,
                      offset: const Offset(0, 6),
                    ),
                  ],
                ),
                child: const Center(
                  child: Icon(
                    Icons.account_balance_wallet_outlined,
                    color: Colors.white,
                    size: 30,
                  ),
                ),
              ),
            ),
          ),
          ...List.generate(
            3,
            (index) => Positioned(
              bottom: 24 + index * 6.0,
              right: 9 + index * 6.0,
              child: Container(
                width: 24,
                height: 24,
                decoration: BoxDecoration(
                  color: index == 2
                      ? const Color(0xFFFFD15C)
                      : const Color(0xFFD6A629),
                  shape: BoxShape.circle,
                  border: Border.all(color: const Color(0xFFFFE8A8)),
                  boxShadow: const [
                    BoxShadow(
                      color: Color(0x55000000),
                      blurRadius: 5,
                      offset: Offset(0, 3),
                    ),
                  ],
                ),
                child: const Icon(
                  Icons.star_outline,
                  color: Color(0xFF805D00),
                  size: 14,
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _AhramTransferSectionHeader extends StatelessWidget {
  const _AhramTransferSectionHeader({
    required this.title,
    required this.subtitle,
    required this.icon,
  });

  final String title;
  final String subtitle;
  final IconData icon;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        HeritageServiceGlyph(
          icon: icon,
          color: AhramColors.emerald,
          muted: false,
        ),
        const SizedBox(width: 10),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                title,
                style: const TextStyle(
                  fontWeight: FontWeight.w900,
                  fontSize: 17,
                ),
              ),
              const SizedBox(height: 1),
              Text(
                subtitle,
                style: TextStyle(
                  color: Theme.of(context).colorScheme.onSurfaceVariant,
                  fontSize: 11,
                  fontWeight: FontWeight.w700,
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

class _TransferServiceCard extends StatelessWidget {
  const _TransferServiceCard({
    required this.title,
    required this.subtitle,
    required this.icon,
    required this.color,
    required this.rate,
    required this.available,
    required this.onTap,
  });

  final String title;
  final String subtitle;
  final IconData icon;
  final Color color;
  final double? rate;
  final bool available;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final muted = !available;
    final textColor = muted
        ? Theme.of(context).colorScheme.onSurfaceVariant
        : Theme.of(context).colorScheme.onSurface;
    return Semantics(
      button: available,
      label: title,
      child: SizedBox(
        height: 154,
        child: Stack(
          children: [
            Positioned.fill(
              top: 7,
              child: Container(
                decoration: BoxDecoration(
                  color: color.withValues(alpha: muted ? 0.05 : 0.20),
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(color: color.withValues(alpha: 0.16)),
                ),
              ),
            ),
            Material(
              color: Colors.transparent,
              child: InkWell(
                onTap: onTap,
                borderRadius: BorderRadius.circular(8),
                child: Ink(
                  height: 147,
                  padding: const EdgeInsets.all(13),
                  decoration: BoxDecoration(
                    color: muted
                        ? Theme.of(context).colorScheme.surfaceContainerHighest
                        : Theme.of(context).colorScheme.surface,
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(
                      color: muted
                          ? Theme.of(context).colorScheme.outlineVariant
                          : color.withValues(alpha: 0.33),
                    ),
                    boxShadow: muted
                        ? null
                        : [
                            BoxShadow(
                              color: color.withValues(alpha: 0.13),
                              blurRadius: 12,
                              offset: const Offset(0, 6),
                            ),
                            BoxShadow(
                              color: Colors.white.withValues(alpha: 0.9),
                              blurRadius: 0,
                              offset: const Offset(0, -1),
                            ),
                          ],
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          HeritageServiceGlyph(
                            icon: icon,
                            color: muted ? textColor : color,
                            muted: muted,
                          ),
                          const Spacer(),
                          Container(
                            width: 30,
                            height: 30,
                            alignment: Alignment.center,
                            decoration: BoxDecoration(
                              color: color.withValues(alpha: 0.10),
                              borderRadius: BorderRadius.circular(8),
                            ),
                            child: Icon(
                              available
                                  ? Icons.arrow_back_ios_new_outlined
                                  : Icons.pause_circle_outline,
                              size: 15,
                              color: muted ? textColor : color,
                            ),
                          ),
                        ],
                      ),
                      const Spacer(),
                      Text(
                        title,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          color: textColor,
                          fontWeight: FontWeight.w900,
                        ),
                      ),
                      const SizedBox(height: 3),
                      Text(
                        subtitle,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          color: Theme.of(context).colorScheme.onSurfaceVariant,
                          fontSize: 10,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                      const SizedBox(height: 7),
                      Text(
                        available
                            ? (rate == null
                                  ? 'متاح الآن'
                                  : '${formatAmount(rate)} د.ل')
                            : 'غير متاح حالياً',
                        style: TextStyle(
                          color: available ? color : _danger,
                          fontSize: 11,
                          fontWeight: FontWeight.w900,
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class HeritageServiceGlyph extends StatelessWidget {
  const HeritageServiceGlyph({
    super.key,
    required this.icon,
    required this.color,
    required this.muted,
  });

  final IconData icon;
  final Color color;
  final bool muted;

  @override
  Widget build(BuildContext context) {
    final dark = Theme.of(context).brightness == Brightness.dark;
    return Container(
      width: 40,
      height: 40,
      decoration: BoxDecoration(
        color: color.withValues(alpha: dark ? 0.18 : 0.11),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: color.withValues(alpha: 0.22)),
        boxShadow: muted
            ? null
            : [
                BoxShadow(
                  color: color.withValues(alpha: dark ? 0.12 : 0.17),
                  blurRadius: 8,
                  offset: const Offset(0, 4),
                ),
                BoxShadow(
                  color: Colors.white.withValues(alpha: dark ? 0.04 : 0.76),
                  blurRadius: 0,
                  offset: const Offset(0, -1),
                ),
              ],
      ),
      child: Icon(icon, color: color, size: 21),
    );
  }
}

class _BankakRateSummary extends StatelessWidget {
  const _BankakRateSummary({
    required this.rate,
    required this.controller,
    required this.enabled,
    required this.onChanged,
  });

  final double rate;
  final TextEditingController controller;
  final bool enabled;
  final ValueChanged<String> onChanged;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: const Color(0xFF198754).withValues(alpha: 0.09),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(
          color: const Color(0xFF198754).withValues(alpha: 0.28),
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Icon(
                Icons.currency_exchange_outlined,
                color: Color(0xFF198754),
                size: 19,
              ),
              const SizedBox(width: 8),
              Text(
                'سعر الصرف: ${formatAmount(rate)} ج.س لكل د.ل',
                textDirection: ui.TextDirection.ltr,
                style: TextStyle(
                  color: Theme.of(context).colorScheme.onSurfaceVariant,
                  fontSize: 12,
                  fontWeight: FontWeight.w800,
                ),
              ),
            ],
          ),
          const SizedBox(height: 10),
          TextFormField(
            controller: controller,
            enabled: enabled,
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
            textDirection: ui.TextDirection.ltr,
            decoration: const InputDecoration(
              labelText: 'القيمة بالدينار الليبي',
              hintText: '0',
              filled: true,
              prefixIcon: Padding(
                padding: EdgeInsets.all(13),
                child: Text(
                  '🇱🇾',
                  textDirection: ui.TextDirection.ltr,
                  style: TextStyle(fontSize: 20),
                ),
              ),
            ),
            onChanged: onChanged,
          ),
        ],
      ),
    );
  }
}

class _SefaRateSummary extends StatelessWidget {
  const _SefaRateSummary({
    required this.rate,
    required this.controller,
    required this.enabled,
    required this.onChanged,
  });

  final double rate;
  final TextEditingController controller;
  final bool enabled;
  final ValueChanged<String> onChanged;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: const Color(0xFF158A9B).withValues(alpha: 0.09),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(
          color: const Color(0xFF158A9B).withValues(alpha: 0.28),
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Icon(
                Icons.currency_exchange_outlined,
                color: Color(0xFF158A9B),
                size: 19,
              ),
              const SizedBox(width: 8),
              Text(
                'سعر الصرف: ${formatAmount(rate)} د.ل لكل سيفا',
                textDirection: ui.TextDirection.ltr,
                style: TextStyle(
                  color: Theme.of(context).colorScheme.onSurfaceVariant,
                  fontSize: 12,
                  fontWeight: FontWeight.w800,
                ),
              ),
            ],
          ),
          const SizedBox(height: 10),
          TextFormField(
            controller: controller,
            enabled: enabled,
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
            textDirection: ui.TextDirection.ltr,
            decoration: const InputDecoration(
              labelText: 'القيمة بالدينار الليبي',
              hintText: '0',
              filled: true,
              prefixIcon: Padding(
                padding: EdgeInsets.all(13),
                child: Text(
                  '🇱🇾',
                  textDirection: ui.TextDirection.ltr,
                  style: TextStyle(fontSize: 20),
                ),
              ),
            ),
            onChanged: onChanged,
          ),
        ],
      ),
    );
  }
}

class _CashRateSummary extends StatelessWidget {
  const _CashRateSummary({
    required this.rate,
    required this.controller,
    required this.enabled,
    required this.onChanged,
  });

  final double rate;
  final TextEditingController controller;
  final bool enabled;
  final ValueChanged<String> onChanged;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: _green.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: _green.withValues(alpha: 0.26)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Icon(
                Icons.currency_exchange_outlined,
                color: _green,
                size: 19,
              ),
              const SizedBox(width: 8),
              Text(
                'سعر الصرف: ${formatAmount(rate)} ج.م لكل د.ل',
                textDirection: ui.TextDirection.ltr,
                style: TextStyle(
                  color: Theme.of(context).colorScheme.onSurfaceVariant,
                  fontSize: 12,
                  fontWeight: FontWeight.w800,
                ),
              ),
            ],
          ),
          const SizedBox(height: 10),
          TextFormField(
            controller: controller,
            enabled: enabled,
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
            textDirection: ui.TextDirection.ltr,
            decoration: const InputDecoration(
              labelText: 'القيمة بالدينار الليبي',
              hintText: '0',
              filled: true,
              prefixIcon: Padding(
                padding: EdgeInsets.all(13),
                child: Text(
                  '🇱🇾',
                  textDirection: ui.TextDirection.ltr,
                  style: TextStyle(fontSize: 20),
                ),
              ),
            ),
            onChanged: onChanged,
          ),
        ],
      ),
    );
  }
}

class _BankakPreviewDialog extends StatelessWidget {
  const _BankakPreviewDialog({
    required this.beneficiaryName,
    required this.accountNumber,
    required this.recipientPhone,
    required this.amountSudanese,
    required this.rate,
    required this.amountLyd,
    required this.clientPhone,
    required this.notes,
    required this.onConfirm,
  });

  final String beneficiaryName;
  final String accountNumber;
  final String recipientPhone;
  final double amountSudanese;
  final double rate;
  final double amountLyd;
  final String clientPhone;
  final String notes;
  final Future<void> Function() onConfirm;

  @override
  Widget build(BuildContext context) {
    return Dialog(
      insetPadding: const EdgeInsets.symmetric(horizontal: 20, vertical: 24),
      clipBehavior: Clip.antiAlias,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 460),
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Container(
                padding: const EdgeInsetsDirectional.fromSTEB(20, 18, 14, 18),
                decoration: BoxDecoration(
                  color: const Color(0xFF198754).withValues(alpha: 0.10),
                  border: Border(
                    bottom: BorderSide(
                      color: const Color(0xFF198754).withValues(alpha: 0.28),
                    ),
                  ),
                ),
                child: Row(
                  children: [
                    Container(
                      width: 42,
                      height: 42,
                      decoration: BoxDecoration(
                        color: const Color(0xFF198754),
                        borderRadius: BorderRadius.circular(12),
                      ),
                      child: const Icon(
                        Icons.account_balance_outlined,
                        color: Colors.white,
                      ),
                    ),
                    const SizedBox(width: 12),
                    const Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            'مراجعة تحويل بنكك',
                            style: TextStyle(
                              fontWeight: FontWeight.w900,
                              fontSize: 18,
                            ),
                          ),
                          SizedBox(height: 2),
                          Text(
                            'تأكد من بيانات المستفيد قبل الإرسال',
                            style: TextStyle(fontSize: 12),
                          ),
                        ],
                      ),
                    ),
                    IconButton(
                      tooltip: 'إغلاق',
                      onPressed: () => Navigator.pop(context),
                      icon: const Icon(Icons.close_outlined),
                    ),
                  ],
                ),
              ),
              Padding(
                padding: const EdgeInsets.all(18),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    _CashPreviewRow(
                      label: 'اسم المستفيد',
                      value: beneficiaryName,
                    ),
                    _CashPreviewRow(
                      label: 'رقم حساب بنكك',
                      value: accountNumber,
                      ltr: true,
                    ),
                    _CashPreviewRow(
                      label: 'هاتف المستلم',
                      value: recipientPhone,
                      ltr: true,
                    ),
                    _CashPreviewRow(
                      label: 'القيمة',
                      value: '🇸🇩 ${formatAmount(amountSudanese)} ج.س',
                      ltr: true,
                    ),
                    _CashPreviewRow(
                      label: 'سعر الصرف',
                      value: '${formatAmount(rate)} ج.س لكل د.ل',
                      ltr: true,
                    ),
                    _CashPreviewRow(
                      label: 'المبلغ بالدينار',
                      value: '🇱🇾 ${formatAmount(amountLyd)} د.ل',
                      ltr: true,
                    ),
                    _CashPreviewRow(
                      label: 'واتساب الإيصال',
                      value: clientPhone,
                      ltr: true,
                    ),
                    if (notes.isNotEmpty)
                      _CashPreviewRow(label: 'الملاحظات', value: notes),
                    const SizedBox(height: 8),
                    const InlineMessage(
                      message:
                          'راجع رقم الحساب وهاتف المستلم وقيمة التحويل قبل التأكيد.',
                      color: Color(0xFF8A6200),
                    ),
                  ],
                ),
              ),
              Padding(
                padding: const EdgeInsetsDirectional.fromSTEB(18, 0, 18, 18),
                child: Row(
                  children: [
                    Expanded(
                      child: OutlinedButton(
                        onPressed: () => Navigator.pop(context),
                        style: OutlinedButton.styleFrom(
                          minimumSize: const Size(0, 48),
                        ),
                        child: const Text('تعديل'),
                      ),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      flex: 2,
                      child: FilledButton.icon(
                        style: FilledButton.styleFrom(
                          minimumSize: const Size(0, 48),
                          backgroundColor: const Color(0xFF198754),
                        ),
                        onPressed: () async => onConfirm(),
                        icon: const Icon(Icons.check_circle_outline),
                        label: const Text('تأكيد وإرسال'),
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _NitaPreviewDialog extends StatelessWidget {
  const _NitaPreviewDialog({
    required this.beneficiaryName,
    required this.accountNumber,
    required this.city,
    required this.nitaAccount,
    required this.amountSefa,
    required this.rate,
    required this.amountLyd,
    required this.clientPhone,
    required this.notes,
    required this.onConfirm,
  });

  final String beneficiaryName;
  final String accountNumber;
  final String? city;
  final bool nitaAccount;
  final double amountSefa;
  final double rate;
  final double amountLyd;
  final String clientPhone;
  final String notes;
  final Future<void> Function() onConfirm;

  @override
  Widget build(BuildContext context) {
    return Dialog(
      insetPadding: const EdgeInsets.symmetric(horizontal: 20, vertical: 24),
      clipBehavior: Clip.antiAlias,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 460),
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Container(
                padding: const EdgeInsetsDirectional.fromSTEB(20, 18, 14, 18),
                decoration: BoxDecoration(
                  color: const Color(0xFF158A9B).withValues(alpha: 0.10),
                  border: Border(
                    bottom: BorderSide(
                      color: const Color(0xFF158A9B).withValues(alpha: 0.28),
                    ),
                  ),
                ),
                child: Row(
                  children: [
                    Container(
                      width: 42,
                      height: 42,
                      decoration: BoxDecoration(
                        color: const Color(0xFF158A9B),
                        borderRadius: BorderRadius.circular(12),
                      ),
                      child: const Icon(
                        Icons.language_outlined,
                        color: Colors.white,
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            nitaAccount
                                ? 'مراجعة تحويل NITA ACCOUNT'
                                : 'مراجعة تحويل NITA',
                            style: TextStyle(
                              fontWeight: FontWeight.w900,
                              fontSize: 18,
                            ),
                          ),
                          SizedBox(height: 2),
                          Text(
                            'تأكد من بيانات المستفيد قبل الإرسال',
                            style: TextStyle(fontSize: 12),
                          ),
                        ],
                      ),
                    ),
                    IconButton(
                      tooltip: 'إغلاق',
                      onPressed: () => Navigator.pop(context),
                      icon: const Icon(Icons.close_outlined),
                    ),
                  ],
                ),
              ),
              Padding(
                padding: const EdgeInsets.all(18),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    _CashPreviewRow(
                      label: 'اسم المستفيد',
                      value: beneficiaryName,
                    ),
                    _CashPreviewRow(
                      label: nitaAccount
                          ? 'رقم حساب NITA ACCOUNT'
                          : 'رقم حساب NITA',
                      value: accountNumber,
                      ltr: true,
                    ),
                    if (!nitaAccount)
                      _CashPreviewRow(label: 'المدينة', value: city!),
                    _CashPreviewRow(
                      label: 'القيمة',
                      value: '🇳🇪 ${formatAmount(amountSefa)} سيفا',
                      ltr: true,
                    ),
                    _CashPreviewRow(
                      label: 'سعر الصرف',
                      value: '${formatAmount(rate)} د.ل لكل سيفا',
                      ltr: true,
                    ),
                    _CashPreviewRow(
                      label: 'المبلغ بالدينار',
                      value: '🇱🇾 ${formatAmount(amountLyd)} د.ل',
                      ltr: true,
                    ),
                    _CashPreviewRow(
                      label: 'واتساب الإيصال',
                      value: clientPhone,
                      ltr: true,
                    ),
                    if (notes.isNotEmpty)
                      _CashPreviewRow(label: 'الملاحظات', value: notes),
                    const SizedBox(height: 8),
                    InlineMessage(
                      message: nitaAccount
                          ? 'راجع رقم الحساب وقيمة السيفا قبل التأكيد.'
                          : 'راجع رقم الحساب والمدينة وقيمة السيفا قبل التأكيد.',
                      color: Color(0xFF8A6200),
                    ),
                  ],
                ),
              ),
              Padding(
                padding: const EdgeInsetsDirectional.fromSTEB(18, 0, 18, 18),
                child: Row(
                  children: [
                    Expanded(
                      child: OutlinedButton(
                        onPressed: () => Navigator.pop(context),
                        style: OutlinedButton.styleFrom(
                          minimumSize: const Size(0, 48),
                        ),
                        child: const Text('تعديل'),
                      ),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      flex: 2,
                      child: FilledButton.icon(
                        style: FilledButton.styleFrom(
                          minimumSize: const Size(0, 48),
                          backgroundColor: const Color(0xFF158A9B),
                        ),
                        onPressed: () async => onConfirm(),
                        icon: const Icon(Icons.check_circle_outline),
                        label: const Text('تأكيد وإرسال'),
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _InstapayPreviewDialog extends StatelessWidget {
  const _InstapayPreviewDialog({
    required this.beneficiaryName,
    required this.recipient,
    required this.amountEgp,
    required this.rate,
    required this.amountLyd,
    required this.clientPhone,
    required this.notes,
    required this.onConfirm,
  });

  final String beneficiaryName;
  final String recipient;
  final double amountEgp;
  final double rate;
  final double amountLyd;
  final String clientPhone;
  final String notes;
  final Future<void> Function() onConfirm;

  @override
  Widget build(BuildContext context) {
    return Dialog(
      insetPadding: const EdgeInsets.symmetric(horizontal: 20, vertical: 24),
      clipBehavior: Clip.antiAlias,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 460),
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Container(
                padding: const EdgeInsetsDirectional.fromSTEB(20, 18, 14, 18),
                decoration: BoxDecoration(
                  color: AhramColors.sky.withValues(alpha: 0.10),
                  border: Border(
                    bottom: BorderSide(
                      color: AhramColors.sky.withValues(alpha: 0.28),
                    ),
                  ),
                ),
                child: Row(
                  children: [
                    Container(
                      width: 42,
                      height: 42,
                      decoration: BoxDecoration(
                        color: AhramColors.sky,
                        borderRadius: BorderRadius.circular(12),
                      ),
                      child: const Icon(
                        Icons.bolt_outlined,
                        color: Colors.white,
                      ),
                    ),
                    const SizedBox(width: 12),
                    const Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            'مراجعة تحويل إنستا باي',
                            style: TextStyle(
                              fontWeight: FontWeight.w900,
                              fontSize: 18,
                            ),
                          ),
                          SizedBox(height: 2),
                          Text(
                            'تأكد من بيانات المستفيد قبل الإرسال',
                            style: TextStyle(fontSize: 12),
                          ),
                        ],
                      ),
                    ),
                    IconButton(
                      tooltip: 'إغلاق',
                      onPressed: () => Navigator.pop(context),
                      icon: const Icon(Icons.close_outlined),
                    ),
                  ],
                ),
              ),
              Padding(
                padding: const EdgeInsets.all(18),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    _CashPreviewRow(
                      label: 'اسم المستفيد',
                      value: beneficiaryName,
                    ),
                    _CashPreviewRow(
                      label: 'بيانات المستلم',
                      value: recipient,
                      ltr: true,
                    ),
                    _CashPreviewRow(
                      label: 'القيمة',
                      value: '🇪🇬 ${formatEgpAmount(amountEgp)} ج.م',
                      ltr: true,
                    ),
                    _CashPreviewRow(
                      label: 'سعر الصرف',
                      value: '${formatAmount(rate)} ج.م لكل د.ل',
                      ltr: true,
                    ),
                    _CashPreviewRow(
                      label: 'المبلغ بالدينار',
                      value: '🇱🇾 ${formatAmount(amountLyd)} د.ل',
                      ltr: true,
                    ),
                    _CashPreviewRow(
                      label: 'واتساب الإيصال',
                      value: clientPhone,
                      ltr: true,
                    ),
                    if (notes.isNotEmpty)
                      _CashPreviewRow(label: 'الملاحظات', value: notes),
                    const SizedBox(height: 8),
                    const InlineMessage(
                      message:
                          'راجع رقم الهاتف أو عنوان الدفع أو رقم البطاقة بعناية قبل التأكيد.',
                      color: Color(0xFF8A6200),
                    ),
                  ],
                ),
              ),
              Padding(
                padding: const EdgeInsetsDirectional.fromSTEB(18, 0, 18, 18),
                child: Row(
                  children: [
                    Expanded(
                      child: OutlinedButton(
                        onPressed: () => Navigator.pop(context),
                        style: OutlinedButton.styleFrom(
                          minimumSize: const Size(0, 48),
                        ),
                        child: const Text('تعديل'),
                      ),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      flex: 2,
                      child: FilledButton.icon(
                        style: FilledButton.styleFrom(
                          minimumSize: const Size(0, 48),
                          backgroundColor: AhramColors.sky,
                        ),
                        onPressed: () async => onConfirm(),
                        icon: const Icon(Icons.check_circle_outline),
                        label: const Text('تأكيد وإرسال'),
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _BankTransferPreviewDialog extends StatelessWidget {
  const _BankTransferPreviewDialog({
    required this.beneficiaryName,
    required this.accountNumber,
    required this.bankName,
    required this.amountEgp,
    required this.rate,
    required this.amountLyd,
    required this.clientPhone,
    required this.hasAccountProof,
    required this.notes,
    required this.onConfirm,
  });

  final String beneficiaryName;
  final String accountNumber;
  final String bankName;
  final double amountEgp;
  final double rate;
  final double amountLyd;
  final String clientPhone;
  final bool hasAccountProof;
  final String notes;
  final Future<void> Function() onConfirm;

  @override
  Widget build(BuildContext context) {
    return Dialog(
      insetPadding: const EdgeInsets.symmetric(horizontal: 20, vertical: 24),
      clipBehavior: Clip.antiAlias,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 460),
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Container(
                padding: const EdgeInsetsDirectional.fromSTEB(20, 18, 14, 18),
                decoration: BoxDecoration(
                  color: _gold.withValues(alpha: 0.10),
                  border: Border(
                    bottom: BorderSide(color: _gold.withValues(alpha: 0.28)),
                  ),
                ),
                child: Row(
                  children: [
                    Container(
                      width: 42,
                      height: 42,
                      decoration: BoxDecoration(
                        color: _gold,
                        borderRadius: BorderRadius.circular(12),
                      ),
                      child: const Icon(
                        Icons.account_balance_outlined,
                        color: Colors.white,
                      ),
                    ),
                    const SizedBox(width: 12),
                    const Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            'مراجعة التحويل البنكي',
                            style: TextStyle(
                              fontWeight: FontWeight.w900,
                              fontSize: 18,
                            ),
                          ),
                          SizedBox(height: 2),
                          Text(
                            'تأكد من بيانات الحساب قبل الإرسال',
                            style: TextStyle(fontSize: 12),
                          ),
                        ],
                      ),
                    ),
                    IconButton(
                      tooltip: 'إغلاق',
                      onPressed: () => Navigator.pop(context),
                      icon: const Icon(Icons.close_outlined),
                    ),
                  ],
                ),
              ),
              Padding(
                padding: const EdgeInsets.all(18),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    _CashPreviewRow(
                      label: 'اسم المستفيد',
                      value: beneficiaryName,
                    ),
                    _CashPreviewRow(label: 'البنك', value: bankName),
                    _CashPreviewRow(
                      label: 'رقم الحساب أو IBAN',
                      value: accountNumber,
                      ltr: true,
                    ),
                    _CashPreviewRow(
                      label: 'القيمة',
                      value: '🇪🇬 ${formatEgpAmount(amountEgp)} ج.م',
                      ltr: true,
                    ),
                    _CashPreviewRow(
                      label: 'سعر الصرف',
                      value: '${formatAmount(rate)} ج.م لكل د.ل',
                      ltr: true,
                    ),
                    _CashPreviewRow(
                      label: 'المبلغ بالدينار',
                      value: '🇱🇾 ${formatAmount(amountLyd)} د.ل',
                      ltr: true,
                    ),
                    _CashPreviewRow(
                      label: 'واتساب الإيصال',
                      value: clientPhone,
                      ltr: true,
                    ),
                    _CashPreviewRow(
                      label: 'بيانات الحساب',
                      value: hasAccountProof ? 'تم إرفاق صورة' : 'غير مرفقة',
                    ),
                    if (notes.isNotEmpty)
                      _CashPreviewRow(label: 'الملاحظات', value: notes),
                    const SizedBox(height: 8),
                    const InlineMessage(
                      message:
                          'راجع رقم الحساب واسم البنك بعناية. لا يمكن تعديل العملية بعد إرسالها للتنفيذ.',
                      color: Color(0xFF8A6200),
                    ),
                  ],
                ),
              ),
              Padding(
                padding: const EdgeInsetsDirectional.fromSTEB(18, 0, 18, 18),
                child: Row(
                  children: [
                    Expanded(
                      child: OutlinedButton(
                        onPressed: () => Navigator.pop(context),
                        style: OutlinedButton.styleFrom(
                          minimumSize: const Size(0, 48),
                        ),
                        child: const Text('تعديل'),
                      ),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      flex: 2,
                      child: FilledButton.icon(
                        style: FilledButton.styleFrom(
                          minimumSize: const Size(0, 48),
                          backgroundColor: _gold,
                        ),
                        onPressed: () async => onConfirm(),
                        icon: const Icon(Icons.check_circle_outline),
                        label: const Text('تأكيد وإرسال'),
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _PostCardPreviewDialog extends StatelessWidget {
  const _PostCardPreviewDialog({
    required this.beneficiaryName,
    required this.nationalId,
    required this.recipientPhone,
    required this.governorate,
    required this.amountEgp,
    required this.rate,
    required this.amountLyd,
    required this.clientPhone,
    required this.notes,
    required this.onConfirm,
  });

  final String beneficiaryName;
  final String nationalId;
  final String recipientPhone;
  final String governorate;
  final double amountEgp;
  final double rate;
  final double amountLyd;
  final String clientPhone;
  final String notes;
  final Future<void> Function() onConfirm;

  @override
  Widget build(BuildContext context) {
    return Dialog(
      insetPadding: const EdgeInsets.symmetric(horizontal: 20, vertical: 24),
      clipBehavior: Clip.antiAlias,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 460),
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Container(
                padding: const EdgeInsetsDirectional.fromSTEB(20, 18, 14, 18),
                decoration: BoxDecoration(
                  color: const Color(0xFFB8750B).withValues(alpha: 0.10),
                  border: Border(
                    bottom: BorderSide(
                      color: const Color(0xFFB8750B).withValues(alpha: 0.26),
                    ),
                  ),
                ),
                child: Row(
                  children: [
                    Container(
                      width: 42,
                      height: 42,
                      decoration: BoxDecoration(
                        color: const Color(0xFFB8750B),
                        borderRadius: BorderRadius.circular(12),
                      ),
                      child: const Icon(
                        Icons.credit_card_outlined,
                        color: Colors.white,
                      ),
                    ),
                    const SizedBox(width: 12),
                    const Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            'مراجعة تحويل بريد بطاقة',
                            style: TextStyle(
                              fontWeight: FontWeight.w900,
                              fontSize: 18,
                            ),
                          ),
                          SizedBox(height: 2),
                          Text(
                            'تأكد من بيانات المستفيد قبل الإرسال',
                            style: TextStyle(fontSize: 12),
                          ),
                        ],
                      ),
                    ),
                    IconButton(
                      tooltip: 'إغلاق',
                      onPressed: () => Navigator.pop(context),
                      icon: const Icon(Icons.close_outlined),
                    ),
                  ],
                ),
              ),
              Padding(
                padding: const EdgeInsets.all(18),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    _CashPreviewRow(
                      label: 'اسم المستفيد',
                      value: beneficiaryName,
                    ),
                    _CashPreviewRow(
                      label: 'الرقم القومي',
                      value: nationalId,
                      ltr: true,
                    ),
                    _CashPreviewRow(
                      label: 'هاتف المستلم',
                      value: recipientPhone,
                      ltr: true,
                    ),
                    _CashPreviewRow(label: 'المحافظة', value: governorate),
                    _CashPreviewRow(
                      label: 'القيمة',
                      value: '🇪🇬 ${formatEgpAmount(amountEgp)} ج.م',
                      ltr: true,
                    ),
                    _CashPreviewRow(
                      label: 'سعر الصرف',
                      value: '${formatAmount(rate)} ج.م لكل د.ل',
                      ltr: true,
                    ),
                    _CashPreviewRow(
                      label: 'المبلغ بالدينار',
                      value: '🇱🇾 ${formatAmount(amountLyd)} د.ل',
                      ltr: true,
                    ),
                    _CashPreviewRow(
                      label: 'واتساب الإيصال',
                      value: clientPhone,
                      ltr: true,
                    ),
                    const _CashPreviewRow(
                      label: 'صورة البطاقة',
                      value: 'تم إرفاقها',
                    ),
                    if (notes.isNotEmpty)
                      _CashPreviewRow(label: 'الملاحظات', value: notes),
                    const SizedBox(height: 8),
                    const InlineMessage(
                      message:
                          'لا يمكن تعديل بيانات العملية بعد إرسالها للتنفيذ. راجع الاسم والرقم القومي والهاتف بعناية.',
                      color: Color(0xFF8A6200),
                    ),
                  ],
                ),
              ),
              Padding(
                padding: const EdgeInsetsDirectional.fromSTEB(18, 0, 18, 18),
                child: Row(
                  children: [
                    Expanded(
                      child: OutlinedButton(
                        onPressed: () => Navigator.pop(context),
                        style: OutlinedButton.styleFrom(
                          minimumSize: const Size(0, 48),
                        ),
                        child: const Text('تعديل'),
                      ),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      flex: 2,
                      child: FilledButton.icon(
                        style: FilledButton.styleFrom(
                          minimumSize: const Size(0, 48),
                          backgroundColor: const Color(0xFFB8750B),
                        ),
                        onPressed: () async => onConfirm(),
                        icon: const Icon(Icons.check_circle_outline),
                        label: const Text('تأكيد وإرسال'),
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _PostAccountPreviewDialog extends StatelessWidget {
  const _PostAccountPreviewDialog({
    required this.beneficiaryName,
    required this.accountNumber,
    required this.amountEgp,
    required this.rate,
    required this.amountLyd,
    required this.clientPhone,
    required this.hasOldReceipt,
    required this.notes,
    required this.onConfirm,
  });

  final String beneficiaryName;
  final String accountNumber;
  final double amountEgp;
  final double rate;
  final double amountLyd;
  final String clientPhone;
  final bool hasOldReceipt;
  final String notes;
  final Future<void> Function() onConfirm;

  @override
  Widget build(BuildContext context) {
    return Dialog(
      insetPadding: const EdgeInsets.symmetric(horizontal: 20, vertical: 24),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 460),
        child: Padding(
          padding: const EdgeInsets.all(18),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  HeritageServiceGlyph(
                    icon: Icons.markunread_mailbox_outlined,
                    color: AhramColors.sky,
                    muted: false,
                  ),
                  const SizedBox(width: 10),
                  const Expanded(
                    child: Text(
                      'مراجعة تحويل بريد حساب',
                      style: TextStyle(
                        fontWeight: FontWeight.w900,
                        fontSize: 17,
                      ),
                    ),
                  ),
                  IconButton(
                    onPressed: () => Navigator.pop(context),
                    icon: const Icon(Icons.close_outlined),
                  ),
                ],
              ),
              const SizedBox(height: 14),
              _CashPreviewRow(label: 'اسم المستفيد', value: beneficiaryName),
              _CashPreviewRow(
                label: 'رقم الحساب البريدي',
                value: accountNumber,
                ltr: true,
              ),
              _CashPreviewRow(
                label: 'القيمة',
                value: '🇪🇬 ${formatEgpAmount(amountEgp)} ج.م',
                ltr: true,
              ),
              _CashPreviewRow(
                label: 'سعر الصرف',
                value: '${formatAmount(rate)} ج.م لكل د.ل',
                ltr: true,
              ),
              _CashPreviewRow(
                label: 'المبلغ بالدينار',
                value: '🇱🇾 ${formatAmount(amountLyd)} د.ل',
                ltr: true,
              ),
              _CashPreviewRow(
                label: 'واتساب الإيصال',
                value: clientPhone,
                ltr: true,
              ),
              _CashPreviewRow(
                label: 'إيصال قديم',
                value: hasOldReceipt ? 'تم إرفاقه' : 'غير مرفق',
              ),
              if (notes.isNotEmpty)
                _CashPreviewRow(label: 'الملاحظات', value: notes),
              const SizedBox(height: 8),
              const InlineMessage(
                message: 'راجع بيانات المستفيد والقيمة قبل الإرسال النهائي.',
                color: Color(0xFF8A6200),
              ),
              const SizedBox(height: 16),
              Row(
                children: [
                  Expanded(
                    child: OutlinedButton(
                      onPressed: () => Navigator.pop(context),
                      child: const Text('تعديل'),
                    ),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    flex: 2,
                    child: FilledButton.icon(
                      style: FilledButton.styleFrom(
                        backgroundColor: AhramColors.sky,
                      ),
                      onPressed: () async => onConfirm(),
                      icon: const Icon(Icons.check_circle_outline),
                      label: const Text('تأكيد وإرسال'),
                    ),
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

class _CashTransferPreviewDialog extends StatelessWidget {
  const _CashTransferPreviewDialog({
    required this.destination,
    required this.provider,
    required this.amountEgp,
    required this.rate,
    required this.amountLyd,
    required this.clientPhone,
    required this.notes,
    required this.onConfirm,
  });

  final String destination;
  final ({String label, Color color}) provider;
  final double amountEgp;
  final double rate;
  final double amountLyd;
  final String clientPhone;
  final String notes;
  final Future<void> Function() onConfirm;

  @override
  Widget build(BuildContext context) {
    return Dialog(
      insetPadding: const EdgeInsets.symmetric(horizontal: 20, vertical: 24),
      clipBehavior: Clip.antiAlias,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 460),
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Container(
                padding: const EdgeInsetsDirectional.fromSTEB(20, 18, 14, 18),
                decoration: BoxDecoration(
                  color: _green.withValues(alpha: 0.09),
                  border: Border(
                    bottom: BorderSide(color: _green.withValues(alpha: 0.18)),
                  ),
                ),
                child: Row(
                  children: [
                    Container(
                      width: 42,
                      height: 42,
                      decoration: BoxDecoration(
                        color: _green,
                        borderRadius: BorderRadius.circular(12),
                      ),
                      child: const Icon(
                        Icons.fact_check_outlined,
                        color: Colors.white,
                      ),
                    ),
                    const SizedBox(width: 12),
                    const Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            'مراجعة التحويل',
                            style: TextStyle(
                              fontWeight: FontWeight.w900,
                              fontSize: 18,
                            ),
                          ),
                          SizedBox(height: 2),
                          Text(
                            'تأكد من البيانات قبل الإرسال',
                            style: TextStyle(fontSize: 12),
                          ),
                        ],
                      ),
                    ),
                    IconButton(
                      tooltip: 'إغلاق',
                      onPressed: () => Navigator.pop(context),
                      icon: const Icon(Icons.close_outlined),
                    ),
                  ],
                ),
              ),
              Padding(
                padding: const EdgeInsets.all(18),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Container(
                      padding: const EdgeInsets.all(13),
                      decoration: BoxDecoration(
                        color: provider.color.withValues(alpha: 0.10),
                        borderRadius: BorderRadius.circular(8),
                        border: Border.all(
                          color: provider.color.withValues(alpha: 0.30),
                        ),
                      ),
                      child: Row(
                        children: [
                          Icon(
                            Icons.account_balance_wallet_outlined,
                            color: provider.color,
                          ),
                          const SizedBox(width: 9),
                          Text(
                            provider.label,
                            style: TextStyle(
                              color: provider.color,
                              fontWeight: FontWeight.w900,
                            ),
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(height: 14),
                    _CashPreviewRow(
                      label: 'رقم المستلم',
                      value: destination,
                      ltr: true,
                    ),
                    _CashPreviewRow(
                      label: 'القيمة',
                      value: '🇪🇬 ${formatEgpAmount(amountEgp)} ج.م',
                      ltr: true,
                    ),
                    _CashPreviewRow(
                      label: 'سعر الصرف',
                      value: '${formatAmount(rate)} د.ل',
                      ltr: true,
                    ),
                    _CashPreviewRow(
                      label: 'المبلغ المستحق',
                      value: '🇱🇾 ${formatAmount(amountLyd)} د.ل',
                      ltr: true,
                    ),
                    _CashPreviewRow(
                      label: 'واتساب الإيصال',
                      value: clientPhone,
                      ltr: true,
                    ),
                    if (notes.isNotEmpty)
                      _CashPreviewRow(label: 'الملاحظة', value: notes),
                    const SizedBox(height: 8),
                    const InlineMessage(
                      message:
                          'راجع رقم المستلم والقيمة قبل التأكيد. لا يمكن تعديل العملية بعد إرسالها للتنفيذ.',
                      color: Color(0xFF8A6200),
                    ),
                  ],
                ),
              ),
              Padding(
                padding: const EdgeInsetsDirectional.fromSTEB(18, 0, 18, 18),
                child: Row(
                  children: [
                    Expanded(
                      child: OutlinedButton(
                        onPressed: () => Navigator.pop(context),
                        style: OutlinedButton.styleFrom(
                          minimumSize: const Size(0, 48),
                        ),
                        child: const Text('تعديل'),
                      ),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      flex: 2,
                      child: FilledButton.icon(
                        style: FilledButton.styleFrom(
                          minimumSize: const Size(0, 48),
                          backgroundColor: _green,
                        ),
                        onPressed: () async => onConfirm(),
                        icon: const Icon(Icons.check_circle_outline),
                        label: const Text('تأكيد وإرسال'),
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _CashPreviewRow extends StatelessWidget {
  const _CashPreviewRow({
    required this.label,
    required this.value,
    this.ltr = false,
  });

  final String label;
  final String value;
  final bool ltr;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            child: Text(
              label,
              style: TextStyle(
                color: Theme.of(context).colorScheme.onSurfaceVariant,
              ),
            ),
          ),
          const SizedBox(width: 16),
          Expanded(
            child: Text(
              value,
              textAlign: TextAlign.end,
              textDirection: ltr ? ui.TextDirection.ltr : null,
              style: const TextStyle(fontWeight: FontWeight.w900),
            ),
          ),
        ],
      ),
    );
  }
}

class _TransferServiceOption {
  const _TransferServiceOption({
    required this.serviceKey,
    required this.title,
    required this.subtitle,
    required this.icon,
    this.subtype,
  });

  final String serviceKey;
  final String? subtype;
  final String title;
  final String subtitle;
  final IconData icon;
}

class _TransferServiceOptionSheet extends StatelessWidget {
  const _TransferServiceOptionSheet({
    required this.title,
    required this.subtitle,
    required this.options,
    required this.onSelected,
  });

  final String title;
  final String subtitle;
  final List<_TransferServiceOption> options;
  final ValueChanged<_TransferServiceOption> onSelected;

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 4, 20, 24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              title,
              style: Theme.of(
                context,
              ).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w900),
            ),
            const SizedBox(height: 6),
            Text(
              subtitle,
              style: TextStyle(
                color: Theme.of(context).colorScheme.onSurfaceVariant,
              ),
            ),
            const SizedBox(height: 14),
            ...options.map(
              (option) => Padding(
                padding: const EdgeInsets.only(bottom: 10),
                child: OutlinedButton(
                  onPressed: () => onSelected(option),
                  style: OutlinedButton.styleFrom(
                    minimumSize: const Size.fromHeight(76),
                    alignment: AlignmentDirectional.centerStart,
                    padding: const EdgeInsetsDirectional.fromSTEB(
                      14,
                      10,
                      14,
                      10,
                    ),
                  ),
                  child: Row(
                    children: [
                      Icon(option.icon),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              option.title,
                              style: const TextStyle(
                                fontWeight: FontWeight.w900,
                              ),
                            ),
                            const SizedBox(height: 3),
                            Text(
                              option.subtitle,
                              style: const TextStyle(fontSize: 11),
                            ),
                          ],
                        ),
                      ),
                      const Icon(Icons.chevron_left),
                    ],
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class CustomerReportsScreen extends StatefulWidget {
  const CustomerReportsScreen({super.key, required this.controller});

  final SessionController controller;

  @override
  State<CustomerReportsScreen> createState() => _CustomerReportsScreenState();
}

class _CustomerReportsScreenState extends State<CustomerReportsScreen> {
  int? _section;
  bool _loading = true;
  bool _downloading = false;
  Object? _error;
  List<Map<String, dynamic>> _dailyTransactions = <Map<String, dynamic>>[];
  List<Map<String, dynamic>> _searchResults = <Map<String, dynamic>>[];
  Map<String, dynamic>? _periodReport;
  DateTime _fromDate = DateTime.now();
  DateTime _toDate = DateTime.now();
  String _statusFilter = 'all';
  final TextEditingController _searchController = TextEditingController();

  String _dateValue(DateTime value) => DateFormat('yyyy-MM-dd').format(value);

  @override
  void initState() {
    super.initState();
    _loadDaily();
  }

  @override
  void dispose() {
    _searchController.dispose();
    super.dispose();
  }

  Future<void> _loadDaily() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final transactions = await widget.controller.api.clientTransactions(
        dateFrom: _dateValue(DateTime.now()),
        dateTo: _dateValue(DateTime.now()),
      );
      if (mounted) setState(() => _dailyTransactions = transactions);
    } catch (error) {
      if (mounted) setState(() => _error = error);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _pickDate({required bool from}) async {
    final selected = await showDatePicker(
      context: context,
      initialDate: from ? _fromDate : _toDate,
      firstDate: DateTime(2024),
      lastDate: DateTime.now(),
      helpText: from ? 'اختر تاريخ البداية' : 'اختر تاريخ النهاية',
    );
    if (selected == null || !mounted) return;
    setState(() {
      if (from) {
        _fromDate = selected;
        if (_toDate.isBefore(selected)) _toDate = selected;
      } else {
        _toDate = selected;
      }
    });
  }

  Future<void> _loadPeriodReport() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final response = await widget.controller.api.clientReport(
        dateFrom: _dateValue(_fromDate),
        dateTo: _dateValue(_toDate),
      );
      final data = response['data'];
      if (mounted && data is Map) {
        setState(() => _periodReport = Map<String, dynamic>.from(data));
      }
    } on ApiFailure catch (error) {
      if (mounted) showSnack(context, error.message, error: true);
    } catch (error) {
      if (mounted) setState(() => _error = error);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _downloadPdf() async {
    if (_downloading) return;
    final target = prepareReportDownload();
    setState(() => _downloading = true);
    try {
      final url = await widget.controller.api.clientReportDownloadUrl(
        dateFrom: _dateValue(_fromDate),
        dateTo: _dateValue(_toDate),
      );
      final opened = await openPreparedReportDownload(target, url);
      if (!opened) throw const ApiFailure('تعذر فتح ملف التقرير للتنزيل.');
      if (mounted) showSnack(context, 'تم فتح تقرير PDF للتنزيل.');
    } on ApiFailure catch (error) {
      cancelPreparedReportDownload(target);
      if (mounted) showSnack(context, error.message, error: true);
    } catch (_) {
      cancelPreparedReportDownload(target);
      if (mounted) {
        showSnack(context, 'تعذر تنزيل التقرير حاليًا.', error: true);
      }
    } finally {
      if (mounted) setState(() => _downloading = false);
    }
  }

  Future<void> _search() async {
    final query = _searchController.text.trim();
    if (query.length < 4) {
      showSnack(
        context,
        'أدخل رقم هاتف أو آخر 4 أرقام من رقم العملية.',
        error: true,
      );
      return;
    }
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final transactions = await widget.controller.api.clientTransactions(
        search: query,
      );
      if (mounted) setState(() => _searchResults = transactions);
    } on ApiFailure catch (error) {
      if (mounted) showSnack(context, error.message, error: true);
    } catch (error) {
      if (mounted) setState(() => _error = error);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  bool _isCancelled(Map<String, dynamic> transaction) {
    return const {
      'rejected',
      'cancelled',
      'canceled',
      'cancelled_by_admin',
      'failed',
    }.contains('${transaction['status'] ?? ''}'.trim().toLowerCase());
  }

  bool _matchesStatus(Map<String, dynamic> transaction) {
    if (_statusFilter == 'all') return true;
    final status = '${transaction['status'] ?? ''}'.trim().toLowerCase();
    if (_statusFilter == 'cancelled') return _isCancelled(transaction);
    if (_statusFilter == 'pending') {
      return const {
        'pending',
        'accepted',
        'assigned',
        'processing',
        'in_progress',
      }.contains(status);
    }
    return status == 'completed';
  }

  Widget _statusFilters() {
    const filters = [
      ('all', 'الكل'),
      ('completed', 'ناجحة'),
      ('pending', 'قيد التنفيذ'),
      ('cancelled', 'ملغاة'),
    ];
    return Wrap(
      spacing: 6,
      runSpacing: 6,
      children: filters
          .map(
            (filter) => ChoiceChip(
              label: Text(filter.$2),
              selected: _statusFilter == filter.$1,
              visualDensity: VisualDensity.compact,
              onSelected: (_) => setState(() => _statusFilter = filter.$1),
            ),
          )
          .toList(),
    );
  }

  List<Map<String, dynamic>> _mapList(dynamic value) {
    return value is List
        ? value
              .whereType<Map>()
              .map((item) => Map<String, dynamic>.from(item))
              .toList()
        : <Map<String, dynamic>>[];
  }

  Widget _operationList(
    BuildContext context,
    List<Map<String, dynamic>> transactions, {
    String emptyTitle = 'لا توجد عمليات للعرض',
    String emptyMessage = 'ستظهر هنا العمليات المسجلة في هذه الفترة.',
  }) {
    final filtered = transactions.where(_matchesStatus).toList();
    final active = filtered.where((item) => !_isCancelled(item)).toList();
    final cancelled = filtered.where(_isCancelled).toList();
    return Column(
      children: [
        if (active.isEmpty)
          EmptyPanel(
            icon: Icons.receipt_long_outlined,
            title: emptyTitle,
            message: emptyMessage,
          )
        else
          ...active.map(
            (transaction) => Padding(
              padding: const EdgeInsets.only(bottom: 9),
              child: TransactionTile(
                transaction: transaction,
                onTap: () => _openDetails(transaction),
              ),
            ),
          ),
        if (cancelled.isNotEmpty) ...[
          const SizedBox(height: 16),
          const SectionTitle(
            title: 'العمليات الملغاة',
            icon: Icons.cancel_outlined,
            color: _danger,
          ),
          const SizedBox(height: 6),
          Text(
            'هذه العمليات منفصلة ولا تدخل ضمن إجماليات التقرير.',
            style: TextStyle(
              color: Theme.of(context).colorScheme.onSurfaceVariant,
              fontSize: 12,
            ),
          ),
          const SizedBox(height: 9),
          ...cancelled.map(
            (transaction) => Padding(
              padding: const EdgeInsets.only(bottom: 9),
              child: TransactionTile(
                transaction: transaction,
                onTap: () => _openDetails(transaction),
              ),
            ),
          ),
        ],
      ],
    );
  }

  Future<void> _openDetails(Map<String, dynamic> transaction) async {
    final id = '${transaction['id'] ?? ''}';
    if (id.isEmpty) return;
    try {
      final response = await widget.controller.api.transactionDetails(id);
      final detail = <String, dynamic>{
        ...transaction,
        if (response['transaction'] is Map)
          ...Map<String, dynamic>.from(response['transaction'] as Map),
      };
      if (!mounted) return;
      await showCustomerReceiptSheet(
        context,
        detail,
        api: widget.controller.api,
      );
    } on ApiFailure catch (error) {
      if (mounted) showSnack(context, error.message, error: true);
    }
  }

  Future<void> _refresh() {
    if (_section == 0) {
      return _loadDaily();
    }
    if (_section == 1 && _periodReport != null) {
      return _loadPeriodReport();
    }
    if (_section == 2 && _searchController.text.trim().isNotEmpty) {
      return _search();
    }
    return Future<void>.value();
  }

  @override
  Widget build(BuildContext context) {
    final reportTransactions = _mapList(_periodReport?['operations']);
    final reportCancelled = _mapList(_periodReport?['cancelledOperations']);
    final combinedReport = [
      ...reportTransactions.where((item) => !_isCancelled(item)),
      ...reportCancelled,
    ];
    final completedReport = combinedReport
        .where((item) => !_isCancelled(item))
        .toList();
    final cancelledReport = combinedReport.where(_isCancelled).toList();

    return PageFrame(
      title: 'التقارير',
      subtitle: 'راجع السجل اليومي، واستخرج تقريرًا للفترة التي تختارها.',
      onRefresh: _refresh,
      child: [
        if (_section == null) ...[
          _CustomerReportEntryCard(
            icon: Icons.today_outlined,
            title: 'السجل اليومي',
            description: 'عمليات اليوم فقط مع حالة كل عملية ووقتها.',
            color: AhramColors.sky,
            onTap: () {
              setState(() => _section = 0);
              if (_dailyTransactions.isEmpty) {
                _loadDaily();
              }
            },
          ),
          const SizedBox(height: 10),
          _CustomerReportEntryCard(
            icon: Icons.assessment_outlined,
            title: 'تقارير العمليات',
            description: 'اختر فترة زمنية واعرض أو حمّل تقرير PDF.',
            color: _green,
            onTap: () => setState(() => _section = 1),
          ),
          const SizedBox(height: 10),
          _CustomerReportEntryCard(
            icon: Icons.manage_search_outlined,
            title: 'بحث عن عملية',
            description: 'ابحث برقم الهاتف أو آخر 4 أرقام من رقم العملية.',
            color: const Color(0xFF6B4A9A),
            onTap: () => setState(() => _section = 2),
          ),
        ] else ...[
          OutlinedButton.icon(
            onPressed: () => setState(() => _section = null),
            icon: const Icon(Icons.arrow_forward_rounded),
            label: const Text('كل أقسام التقارير'),
          ),
          const SizedBox(height: 16),
        ],
        if (_section == 0) ...[
          _ClientReportSummary(
            transactionCount: _dailyTransactions
                .where((item) => !_isCancelled(item))
                .length,
            cancelledCount: _dailyTransactions.where(_isCancelled).length,
            totalEgp: _dailyTransactions
                .where((item) => !_isCancelled(item))
                .fold(0, (total, item) => total + numberValue(item['amount'])),
            totalLyd: _dailyTransactions
                .where((item) => !_isCancelled(item))
                .fold(0, (total, item) => total + numberValue(item['costLYD'])),
          ),
          const SizedBox(height: 18),
          _statusFilters(),
          const SizedBox(height: 14),
          const SectionTitle(
            title: 'سجل اليوم',
            icon: Icons.receipt_long_outlined,
          ),
          const SizedBox(height: 10),
          _operationList(
            context,
            _dailyTransactions,
            emptyTitle: 'لا توجد عمليات اليوم',
            emptyMessage: 'ستظهر عمليات اليوم فور تسجيلها في المنظومة.',
          ),
        ],
        if (_section == 1) ...[
          SurfacePanel(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(
                  'تقرير العمليات',
                  style: Theme.of(
                    context,
                  ).textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w900),
                ),
                const SizedBox(height: 6),
                Text(
                  'اختر بداية ونهاية الفترة ثم اعرض التقرير الخاص بحسابك فقط.',
                  style: TextStyle(
                    color: Theme.of(context).colorScheme.onSurfaceVariant,
                    fontSize: 12,
                  ),
                ),
                const SizedBox(height: 14),
                Row(
                  children: [
                    Expanded(
                      child: OutlinedButton.icon(
                        onPressed: () => _pickDate(from: true),
                        icon: const Icon(Icons.calendar_today_outlined),
                        label: Text(
                          DateFormat('d MMM yyyy', 'ar').format(_fromDate),
                        ),
                      ),
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: OutlinedButton.icon(
                        onPressed: () => _pickDate(from: false),
                        icon: const Icon(Icons.event_outlined),
                        label: Text(
                          DateFormat('d MMM yyyy', 'ar').format(_toDate),
                        ),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 12),
                FilledButton.icon(
                  onPressed: _loading ? null : _loadPeriodReport,
                  icon: const Icon(Icons.visibility_outlined),
                  label: const Text('عرض التقرير'),
                ),
              ],
            ),
          ),
          const SizedBox(height: 16),
          if (_periodReport == null)
            const EmptyPanel(
              icon: Icons.date_range_outlined,
              title: 'اختر فترة التقرير',
              message: 'حدّد تاريخ البداية والنهاية ثم اضغط عرض التقرير.',
            )
          else ...[
            Row(
              children: [
                Expanded(
                  child: Text(
                    'تقرير ${DateFormat('d MMM', 'ar').format(_fromDate)} - ${DateFormat('d MMM yyyy', 'ar').format(_toDate)}',
                    style: Theme.of(context).textTheme.titleSmall?.copyWith(
                      fontWeight: FontWeight.w900,
                    ),
                  ),
                ),
                IconButton(
                  tooltip: 'تحميل PDF',
                  onPressed: _downloading ? null : _downloadPdf,
                  icon: _downloading
                      ? const SizedBox(
                          width: 18,
                          height: 18,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Icon(Icons.download_outlined),
                ),
              ],
            ),
            const SizedBox(height: 10),
            _ClientReportSummary(
              transactionCount: numberValue(
                _periodReport?['completedCount'],
              ).toInt(),
              cancelledCount: numberValue(
                _periodReport?['rejectedCount'],
              ).toInt(),
              totalEgp: numberValue(_periodReport?['totalEGP']),
              totalLyd: numberValue(_periodReport?['totalLYD']),
            ),
            const SizedBox(height: 18),
            _statusFilters(),
            const SizedBox(height: 14),
            _operationList(context, [...completedReport, ...cancelledReport]),
          ],
        ],
        if (_section == 2) ...[
          SurfacePanel(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(
                  'بحث عن عملية',
                  style: Theme.of(
                    context,
                  ).textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w900),
                ),
                const SizedBox(height: 6),
                Text(
                  'ابحث برقم هاتف المستلم أو آخر 4 أرقام من رقم العملية.',
                  style: TextStyle(
                    color: Theme.of(context).colorScheme.onSurfaceVariant,
                    fontSize: 12,
                  ),
                ),
                const SizedBox(height: 12),
                TextField(
                  controller: _searchController,
                  keyboardType: TextInputType.number,
                  onSubmitted: (_) => _search(),
                  decoration: const InputDecoration(
                    labelText: 'رقم الهاتف أو آخر 4 أرقام',
                    prefixIcon: Icon(Icons.search_rounded),
                  ),
                ),
                const SizedBox(height: 12),
                FilledButton.icon(
                  onPressed: _loading ? null : _search,
                  icon: const Icon(Icons.search_rounded),
                  label: const Text('بحث'),
                ),
              ],
            ),
          ),
          const SizedBox(height: 16),
          if (_searchResults.isNotEmpty) ...[
            _statusFilters(),
            const SizedBox(height: 14),
            _operationList(context, _searchResults),
          ] else
            const EmptyPanel(
              icon: Icons.manage_search_outlined,
              title: 'ابحث عن عملية',
              message:
                  'أدخل رقم الهاتف أو آخر 4 أرقام من رقم العملية لعرض النتيجة.',
            ),
        ],
        if (_loading)
          const Padding(
            padding: EdgeInsets.only(top: 14),
            child: LinearProgressIndicator(),
          ),
        if (_error != null && !_loading)
          Padding(
            padding: const EdgeInsets.only(top: 12),
            child: InlineMessage(
              message: 'تعذر تحديث البيانات. اسحب الصفحة للمحاولة مجددًا.',
              color: _danger,
            ),
          ),
      ],
    );
  }
}

class _CustomerReportEntryCard extends StatelessWidget {
  const _CustomerReportEntryCard({
    required this.icon,
    required this.title,
    required this.description,
    required this.color,
    required this.onTap,
  });

  final IconData icon;
  final String title;
  final String description;
  final Color color;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Semantics(
      button: true,
      label: title,
      child: Material(
        color: colors.surface,
        borderRadius: BorderRadius.circular(8),
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(8),
          child: Container(
            width: double.infinity,
            padding: const EdgeInsets.all(15),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(8),
              border: Border.all(color: color.withValues(alpha: 0.28)),
              boxShadow: [
                BoxShadow(
                  color: color.withValues(alpha: 0.08),
                  blurRadius: 14,
                  offset: const Offset(0, 6),
                ),
              ],
            ),
            child: Row(
              children: [
                GlassIconBadge(icon: icon, color: color, size: 46),
                const SizedBox(width: 13),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        title,
                        style: TextStyle(
                          color: colors.onSurface,
                          fontSize: 16,
                          fontWeight: FontWeight.w900,
                        ),
                      ),
                      const SizedBox(height: 4),
                      Text(
                        description,
                        style: TextStyle(
                          color: colors.onSurfaceVariant,
                          fontSize: 12,
                          height: 1.45,
                        ),
                      ),
                    ],
                  ),
                ),
                Icon(Icons.chevron_left_rounded, color: color),
              ],
            ),
          ),
        ),
      ),
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
  String _range = 'all';
  DateTime _selectedDate = DateTime.now();
  final TextEditingController _searchController = TextEditingController();

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _searchController.dispose();
    super.dispose();
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
      final detail = <String, dynamic>{
        ...tx,
        if (response['transaction'] is Map)
          ...Map<String, dynamic>.from(response['transaction'] as Map),
      };
      if (!mounted) return;
      await showCustomerReceiptSheet(
        context,
        detail,
        api: widget.controller.api,
      );
    } on ApiFailure catch (error) {
      if (mounted) showSnack(context, error.message, error: true);
    }
  }

  bool _matchesSelectedPeriod(Map<String, dynamic> transaction) {
    if (_range == 'all') return true;
    final date = DateTime.tryParse(
      '${transaction['createdAt'] ?? ''}',
    )?.toLocal();
    if (date == null) return false;
    if (_range == 'month') {
      return date.year == _selectedDate.year &&
          date.month == _selectedDate.month;
    }
    return date.year == _selectedDate.year &&
        date.month == _selectedDate.month &&
        date.day == _selectedDate.day;
  }

  bool _matchesSearch(Map<String, dynamic> transaction) {
    final query = _searchController.text.trim().toLowerCase();
    if (query.isEmpty) return true;
    final searchable = [
      transaction['customId'],
      transaction['txId'],
      transaction['recipientNumber'],
      transaction['transferTypeLabel'],
      serviceLabel(transaction['transferType']?.toString()),
    ].join(' ').toLowerCase();
    return searchable.contains(query);
  }

  bool _isCancelled(Map<String, dynamic> transaction) {
    return const {
      'cancelled',
      'canceled',
    }.contains('${transaction['status'] ?? ''}'.trim().toLowerCase());
  }

  Future<void> _pickPeriod() async {
    final date = await showDatePicker(
      context: context,
      initialDate: _selectedDate,
      firstDate: DateTime(2024),
      lastDate: DateTime.now(),
      helpText: _range == 'month' ? 'اختر أي يوم من الشهر' : 'اختر اليوم',
    );
    if (date != null && mounted) setState(() => _selectedDate = date);
  }

  String get _periodLabel {
    if (_range == 'all') return 'كل العمليات';
    return _range == 'month'
        ? DateFormat('MMMM yyyy', 'ar').format(_selectedDate)
        : DateFormat('d MMMM yyyy', 'ar').format(_selectedDate);
  }

  @override
  Widget build(BuildContext context) {
    if (_loading && _transactions.isEmpty) return const PageLoading();
    if (_error != null && _transactions.isEmpty) {
      return ErrorPage(error: _error!, onRetry: _load);
    }
    final visibleTransactions = _transactions
        .where(_matchesSelectedPeriod)
        .where(_matchesSearch)
        .toList();
    final cancelledTransactions = visibleTransactions
        .where(_isCancelled)
        .toList();
    final completedTransactions = visibleTransactions
        .where((transaction) => !_isCancelled(transaction))
        .toList();
    final totalEgp = completedTransactions.fold<double>(
      0,
      (total, transaction) => total + numberValue(transaction['amount']),
    );
    final totalLyd = completedTransactions.fold<double>(
      0,
      (total, transaction) => total + numberValue(transaction['costLYD']),
    );

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
        ExecutorSurface(
          accent: ExecutorUiColors.jade,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'فترة التقرير',
                style: Theme.of(
                  context,
                ).textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w900),
              ),
              const SizedBox(height: 10),
              SegmentedButton<String>(
                segments: const [
                  ButtonSegment<String>(
                    value: 'all',
                    label: Text('الكل'),
                    icon: Icon(Icons.all_inbox_outlined),
                  ),
                  ButtonSegment<String>(
                    value: 'day',
                    label: Text('يوم'),
                    icon: Icon(Icons.today_outlined),
                  ),
                  ButtonSegment<String>(
                    value: 'month',
                    label: Text('شهر'),
                    icon: Icon(Icons.calendar_month_outlined),
                  ),
                ],
                selected: {_range},
                onSelectionChanged: (selection) {
                  setState(() => _range = selection.first);
                },
              ),
              if (_range != 'all') ...[
                const SizedBox(height: 10),
                OutlinedButton.icon(
                  onPressed: _pickPeriod,
                  icon: const Icon(Icons.date_range_outlined),
                  label: Text(_periodLabel),
                ),
              ],
              const SizedBox(height: 12),
              TextField(
                controller: _searchController,
                onChanged: (_) => setState(() {}),
                decoration: const InputDecoration(
                  labelText: 'بحث في التقرير',
                  hintText: 'رقم العملية أو هاتف المستلم',
                  prefixIcon: Icon(Icons.search_rounded),
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 16),
        _ClientReportSummary(
          transactionCount: completedTransactions.length,
          cancelledCount: cancelledTransactions.length,
          totalEgp: totalEgp,
          totalLyd: totalLyd,
        ),
        const SizedBox(height: 20),
        SectionTitle(
          title: 'العمليات المسجلة',
          icon: Icons.receipt_long_outlined,
        ),
        const SizedBox(height: 10),
        if (completedTransactions.isEmpty)
          const EmptyPanel(
            icon: Icons.receipt_long_outlined,
            title: 'لا توجد عمليات للعرض',
            message: 'عدّل الفترة أو البحث لعرض العمليات المسجلة.',
          )
        else
          ...completedTransactions.map(
            (tx) => Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: TransactionTile(
                transaction: tx,
                onTap: () => _openDetails(tx),
              ),
            ),
          ),
        if (cancelledTransactions.isNotEmpty) ...[
          const SizedBox(height: 18),
          const SectionTitle(
            title: 'العمليات الملغاة',
            icon: Icons.cancel_outlined,
            color: _danger,
          ),
          const SizedBox(height: 6),
          Text(
            'هذه العمليات منفصلة ولا تدخل ضمن إجمالي التحويلات.',
            style: TextStyle(
              color: Theme.of(context).colorScheme.onSurfaceVariant,
              fontSize: 12,
            ),
          ),
          const SizedBox(height: 10),
          ...cancelledTransactions.map(
            (tx) => Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: TransactionTile(
                transaction: tx,
                onTap: () => _openDetails(tx),
              ),
            ),
          ),
        ],
      ],
    );
  }
}

class _ClientReportSummary extends StatelessWidget {
  const _ClientReportSummary({
    required this.transactionCount,
    required this.cancelledCount,
    required this.totalEgp,
    required this.totalLyd,
  });

  final int transactionCount;
  final int cancelledCount;
  final double totalEgp;
  final double totalLyd;

  @override
  Widget build(BuildContext context) {
    final metrics = [
      _ClientReportMetric(
        label: 'العمليات',
        value: '$transactionCount',
        icon: Icons.receipt_long_outlined,
        color: AhramColors.sky,
      ),
      _ClientReportMetric(
        label: 'إجمالي المصري',
        value: '${formatEgpAmount(totalEgp)} ج.م',
        icon: Icons.payments_outlined,
        color: _green,
      ),
      _ClientReportMetric(
        label: 'إجمالي الليبي',
        value: '${formatAmount(totalLyd)} د.ل',
        icon: Icons.account_balance_wallet_outlined,
        color: const Color(0xFF3366CC),
      ),
      _ClientReportMetric(
        label: 'الملغاة',
        value: '$cancelledCount',
        icon: Icons.cancel_outlined,
        color: _danger,
      ),
    ];
    return LayoutBuilder(
      builder: (context, constraints) {
        final width = constraints.maxWidth >= 560
            ? (constraints.maxWidth - 12) / 2
            : (constraints.maxWidth - 8) / 2;
        return Wrap(
          spacing: 8,
          runSpacing: 8,
          children: metrics
              .map((metric) => SizedBox(width: width, child: metric))
              .toList(),
        );
      },
    );
  }
}

class _ClientReportMetric extends StatelessWidget {
  const _ClientReportMetric({
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
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: colors.surface,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: color.withValues(alpha: 0.22)),
      ),
      child: Row(
        children: [
          GlassIconBadge(icon: icon, color: color, size: 34),
          const SizedBox(width: 9),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  label,
                  style: TextStyle(
                    color: colors.onSurfaceVariant,
                    fontSize: 11,
                  ),
                ),
                const SizedBox(height: 3),
                Text(
                  value,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  textDirection: ui.TextDirection.ltr,
                  style: TextStyle(
                    color: colors.onSurface,
                    fontWeight: FontWeight.w900,
                    fontSize: 13,
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

  Future<void> _openTicket(Map<String, dynamic> ticket) async {
    final updated = await Navigator.of(context).push<bool>(
      MaterialPageRoute(
        builder: (_) => SupportConversationScreen(
          api: widget.controller.api,
          ticketId: '${ticket['id'] ?? ''}',
          subject: '${ticket['subject'] ?? 'تذكرة دعم'}',
        ),
      ),
    );
    if (updated == true) await _load();
  }

  Future<void> _openWhatsAppSupport() async {
    final opened = await openExternalLink(
      Uri.parse('https://wa.me/201108172258'),
    );
    if (opened) return;
    await Clipboard.setData(const ClipboardData(text: '01108172258'));
    if (mounted) showSnack(context, 'تم نسخ رقم واتساب الدعم.');
  }

  Future<void> _showHelpTopics() async {
    await showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      builder: (context) => const _SupportHelpTopicsSheet(),
    );
  }

  @override
  Widget build(BuildContext context) {
    if (_loading && _tickets.isEmpty) return const PageLoading();
    if (_error != null && _tickets.isEmpty) {
      return ErrorPage(error: _error!, onRetry: _load);
    }
    return PageFrame(
      title: 'الدعم الفني',
      subtitle: 'تواصل آمن ومباشر مع فريق الأهرام.',
      onRefresh: _load,
      action: FilledButton.icon(
        onPressed: _createTicket,
        icon: const Icon(Icons.add_comment_outlined),
        label: const Text('تذكرة جديدة'),
      ),
      child: [
        SurfacePanel(
          child: Row(
            children: [
              GlassIconBadge(
                icon: Icons.support_agent_outlined,
                color: _green,
                size: 50,
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'الدعم متاح الآن',
                      style: Theme.of(context).textTheme.titleSmall?.copyWith(
                        fontWeight: FontWeight.w900,
                      ),
                    ),
                    const SizedBox(height: 3),
                    Text(
                      'تابع التذكرة من التطبيق أو تواصل عبر واتساب.',
                      style: TextStyle(
                        color: Theme.of(context).colorScheme.onSurfaceVariant,
                        fontSize: 12,
                      ),
                    ),
                  ],
                ),
              ),
              StatusPill(label: 'متاح', color: _green),
            ],
          ),
        ),
        const SizedBox(height: 14),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            _SupportQuickAction(
              icon: Icons.add_comment_outlined,
              label: 'طلب جديد',
              onTap: _createTicket,
            ),
            _SupportQuickAction(
              icon: Icons.chat_outlined,
              label: 'واتساب الدعم',
              onTap: _openWhatsAppSupport,
            ),
            _SupportQuickAction(
              icon: Icons.help_outline,
              label: 'مساعدة سريعة',
              onTap: _showHelpTopics,
            ),
          ],
        ),
        const SizedBox(height: 24),
        SectionTitle(title: 'طلباتي الحالية', icon: Icons.forum_outlined),
        const SizedBox(height: 10),
        if (_tickets.isEmpty)
          const EmptyPanel(
            icon: Icons.support_agent_outlined,
            title: 'لا توجد طلبات دعم حالية',
            message: 'افتح طلباً جديداً وسيظهر هنا مع كل الردود والتحديثات.',
          )
        else
          ..._tickets.map(
            (ticket) => Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: InkWell(
                borderRadius: BorderRadius.circular(8),
                onTap: () => _openTicket(ticket),
                child: SupportTicketTile(ticket: ticket),
              ),
            ),
          ),
      ],
    );
  }
}

class _SupportQuickAction extends StatelessWidget {
  const _SupportQuickAction({
    required this.icon,
    required this.label,
    required this.onTap,
  });

  final IconData icon;
  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return OutlinedButton.icon(
      onPressed: onTap,
      icon: Icon(icon, size: 18),
      label: Text(label),
      style: OutlinedButton.styleFrom(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 11),
      ),
    );
  }
}

class _SupportHelpTopicsSheet extends StatelessWidget {
  const _SupportHelpTopicsSheet();

  @override
  Widget build(BuildContext context) {
    const topics = [
      ('عملية معلقة', 'أرسل رقم العملية وسيتم مراجعة حالتها.'),
      ('مشكلة في الإيصال', 'أرفق رقم العملية أو صورة الإيصال إن توفرت.'),
      ('إيداع أو خصم', 'اختر نوع الطلب واكتب القيمة المرجعية.'),
      ('بيانات الحساب', 'تغييرات الهاتف واسم المستخدم تحتاج مراجعة رسمية.'),
    ];
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 0, 20, 24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'مساعدة سريعة',
              style: Theme.of(
                context,
              ).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w900),
            ),
            const SizedBox(height: 10),
            ...topics.map(
              (topic) => ListTile(
                contentPadding: EdgeInsets.zero,
                leading: const Icon(Icons.check_circle_outline, color: _green),
                title: Text(topic.$1),
                subtitle: Text(topic.$2),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class SupportConversationScreen extends StatefulWidget {
  const SupportConversationScreen({
    super.key,
    required this.api,
    required this.ticketId,
    required this.subject,
  });

  final MobileApi api;
  final String ticketId;
  final String subject;

  @override
  State<SupportConversationScreen> createState() =>
      _SupportConversationScreenState();
}

class _SupportConversationScreenState extends State<SupportConversationScreen> {
  final _reply = TextEditingController();
  Map<String, dynamic>? _ticket;
  Object? _error;
  bool _loading = true;
  bool _sending = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _reply.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    if (mounted) {
      setState(() {
        _loading = true;
        _error = null;
      });
    }
    try {
      final response = await widget.api.ticketDetails(widget.ticketId);
      if (mounted) {
        final ticket = response['ticket'];
        setState(
          () => _ticket = ticket is Map
              ? Map<String, dynamic>.from(ticket)
              : <String, dynamic>{},
        );
      }
    } catch (error) {
      if (mounted) setState(() => _error = error);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _sendReply() async {
    final text = _reply.text.trim();
    if (text.isEmpty || _sending) return;
    setState(() => _sending = true);
    try {
      await widget.api.replyToTicket(id: widget.ticketId, text: text);
      _reply.clear();
      await _load();
      if (mounted) showSnack(context, 'تم إرسال رسالتك إلى الدعم.');
    } on ApiFailure catch (error) {
      if (mounted) showSnack(context, error.message, error: true);
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_loading && _ticket == null) return const Scaffold(body: PageLoading());
    if (_error != null && _ticket == null) {
      return Scaffold(
        body: ErrorPage(error: _error!, onRetry: _load),
      );
    }
    final ticket = _ticket ?? <String, dynamic>{};
    final messages = ticket['messages'] is List
        ? (ticket['messages'] as List)
              .whereType<Map>()
              .map((item) => Map<String, dynamic>.from(item))
              .toList()
        : <Map<String, dynamic>>[];
    final closed = ['closed', 'resolved'].contains('${ticket['status'] ?? ''}');
    return Scaffold(
      appBar: AppBar(
        title: Text(widget.subject),
        actions: [
          IconButton(onPressed: _load, icon: const Icon(Icons.refresh)),
        ],
      ),
      body: SafeArea(
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.all(14),
              child: SurfacePanel(
                child: Row(
                  children: [
                    const Icon(
                      Icons.confirmation_number_outlined,
                      color: _green,
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        'رقم الطلب: ${ticket['ticketId'] ?? '-'}',
                        style: const TextStyle(fontWeight: FontWeight.w800),
                      ),
                    ),
                    StatusPill(
                      label: closed ? 'مغلقة' : 'مفتوحة',
                      color: closed ? _green : _gold,
                    ),
                  ],
                ),
              ),
            ),
            Expanded(
              child: messages.isEmpty
                  ? const EmptyPanel(
                      icon: Icons.forum_outlined,
                      title: 'لا توجد رسائل',
                      message: 'أرسل رسالة ليبدأ فريق الدعم المتابعة.',
                    )
                  : ListView.separated(
                      padding: const EdgeInsets.fromLTRB(14, 0, 14, 14),
                      itemCount: messages.length,
                      separatorBuilder: (_, _) => const SizedBox(height: 8),
                      itemBuilder: (context, index) =>
                          _SupportMessageBubble(message: messages[index]),
                    ),
            ),
            if (!closed)
              Container(
                padding: const EdgeInsets.fromLTRB(14, 10, 14, 14),
                decoration: BoxDecoration(
                  border: Border(
                    top: BorderSide(
                      color: Theme.of(context).colorScheme.outlineVariant,
                    ),
                  ),
                ),
                child: Row(
                  children: [
                    Expanded(
                      child: TextField(
                        controller: _reply,
                        minLines: 1,
                        maxLines: 4,
                        decoration: const InputDecoration(
                          hintText: 'اكتب رسالتك إلى الدعم...',
                        ),
                      ),
                    ),
                    const SizedBox(width: 8),
                    IconButton.filled(
                      onPressed: _sending ? null : _sendReply,
                      icon: _sending
                          ? const SizedBox(
                              width: 18,
                              height: 18,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            )
                          : const Icon(Icons.send_rounded),
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

class _SupportMessageBubble extends StatelessWidget {
  const _SupportMessageBubble({required this.message});

  final Map<String, dynamic> message;

  @override
  Widget build(BuildContext context) {
    final isUser = '${message['sender'] ?? ''}' == 'user';
    final color = isUser ? _green : Theme.of(context).colorScheme.secondary;
    return Align(
      alignment: isUser
          ? AlignmentDirectional.centerEnd
          : AlignmentDirectional.centerStart,
      child: Container(
        constraints: const BoxConstraints(maxWidth: 420),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
        decoration: BoxDecoration(
          color: color.withValues(alpha: 0.11),
          borderRadius: BorderRadius.circular(10),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              isUser ? 'أنت' : '${message['senderName'] ?? 'الدعم'}',
              style: TextStyle(
                color: color,
                fontSize: 11,
                fontWeight: FontWeight.w900,
              ),
            ),
            const SizedBox(height: 4),
            Text('${message['text'] ?? ''}'),
            const SizedBox(height: 5),
            Text(
              formatDate(message['createdAt']),
              style: TextStyle(
                color: Theme.of(context).colorScheme.onSurfaceVariant,
                fontSize: 10,
              ),
            ),
          ],
        ),
      ),
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

const Map<String, String> _executorSupportCategoryLabels = <String, String>{
  'transaction': 'مشكلة في عملية',
  'pending_transaction': 'عملية متأخرة',
  'balance': 'الرصيد والمطابقة',
  'report': 'التقارير',
  'receipt': 'الإيصال أو الإثبات',
  'cancellation': 'إلغاء عملية',
  'application': 'مشكلة في التطبيق',
  'notifications': 'الإشعارات',
  'employee_account': 'حساب موظف',
  'api': 'منفذ API',
  'other': 'طلب آخر',
};

List<String> _executorSupportCategoriesFor(String role) {
  if (role == 'manager') return _executorSupportCategoryLabels.keys.toList();
  if (role == 'accountant') {
    return const <String>[
      'balance',
      'report',
      'employee_account',
      'application',
      'notifications',
      'other',
    ];
  }
  return const <String>[
    'transaction',
    'pending_transaction',
    'receipt',
    'cancellation',
    'application',
    'notifications',
    'other',
  ];
}

String _executorSupportStatusLabel(String status) {
  switch (status) {
    case 'answered':
      return 'تم الرد';
    case 'pending_internal':
      return 'قيد المراجعة';
    case 'resolved':
      return 'تم الحل';
    case 'closed':
      return 'مغلق';
    default:
      return 'بانتظار الدعم';
  }
}

Color _executorSupportStatusColor(String status) {
  switch (status) {
    case 'answered':
      return const Color(0xFF1976D2);
    case 'pending_internal':
      return const Color(0xFF8A6200);
    case 'resolved':
    case 'closed':
      return _green;
    default:
      return const Color(0xFF7A57D1);
  }
}

String _executorSupportPriorityLabel(String priority) {
  switch (priority) {
    case 'urgent':
      return 'طارئ';
    case 'high':
      return 'مرتفع';
    case 'low':
      return 'منخفض';
    default:
      return 'عادي';
  }
}

Color _executorSupportPriorityColor(String priority) {
  switch (priority) {
    case 'urgent':
      return _danger;
    case 'high':
      return const Color(0xFFD97706);
    case 'low':
      return const Color(0xFF1976D2);
    default:
      return _green;
  }
}

class ExecutorDepositsScreen extends StatefulWidget {
  const ExecutorDepositsScreen({super.key, required this.controller});

  final SessionController controller;

  @override
  State<ExecutorDepositsScreen> createState() => _ExecutorDepositsScreenState();
}

class _ExecutorDepositsScreenState extends State<ExecutorDepositsScreen> {
  List<Map<String, dynamic>> _requests = <Map<String, dynamic>>[];
  Object? _error;
  bool _loading = true;
  String? _busyId;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final rows = await widget.controller.api.executorDepositRequests();
      if (mounted) setState(() => _requests = rows);
    } catch (error) {
      if (mounted) setState(() => _error = error);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<String?> _cancelReason() async {
    final field = TextEditingController();
    final result = await showDialog<String>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('إلغاء طلب الإيداع'),
        content: TextField(
          controller: field,
          maxLength: 1000,
          minLines: 2,
          maxLines: 4,
          decoration: const InputDecoration(hintText: 'اكتب سبب الإلغاء بوضوح'),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext),
            child: const Text('تراجع'),
          ),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: _danger),
            onPressed: () {
              final value = field.text.trim();
              if (value.length < 3) return;
              Navigator.pop(dialogContext, value);
            },
            child: const Text('تأكيد الإلغاء'),
          ),
        ],
      ),
    );
    field.dispose();
    return result;
  }

  Future<void> _review(Map<String, dynamic> request, bool approve) async {
    final id = '${request['id'] ?? ''}';
    if (id.isEmpty || _busyId != null || request['reviewable'] != true) return;
    String reason = '';
    if (approve) {
      final accepted = await showDialog<bool>(
        context: context,
        builder: (dialogContext) => AlertDialog(
          title: const Text('قبول الإيداع؟'),
          content: Text(
            'سيُضاف ${formatEgpAmount(numberValue(request['amount']))} EGP إلى رصيد الشركة مرة واحدة فقط.',
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(dialogContext, false),
              child: const Text('تراجع'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(dialogContext, true),
              child: const Text('قبول الإيداع'),
            ),
          ],
        ),
      );
      if (accepted != true) return;
    } else {
      final value = await _cancelReason();
      if (value == null) return;
      reason = value;
    }
    setState(() => _busyId = id);
    try {
      await widget.controller.api.reviewExecutorDeposit(
        id: id,
        approve: approve,
        reason: reason,
      );
      await widget.controller.refreshHome();
      if (!mounted) return;
      showSnack(
        context,
        approve
            ? 'تم قبول الإيداع وإضافة الرصيد.'
            : 'تم إلغاء طلب الإيداع وإبلاغ الإدارة.',
      );
      await _load();
    } catch (error) {
      if (mounted) {
        showSnack(
          context,
          error is ApiFailure
              ? error.message
              : 'تعذر حفظ القرار. حدّث الصفحة ثم أعد المحاولة.',
          error: true,
        );
      }
    } finally {
      if (mounted) setState(() => _busyId = null);
    }
  }

  void _openReceipt(String rawUrl) {
    final url = widget.controller.api.resolveMediaUrl(rawUrl).toString();
    showDialog<void>(
      context: context,
      builder: (_) => Dialog(
        child: InteractiveViewer(
          child: Image.network(url, fit: BoxFit.contain),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    if (_loading && _requests.isEmpty) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }
    if (_error != null && _requests.isEmpty)
      return ErrorPage(error: _error!, onRetry: _load);
    return PageFrame(
      title: 'مراجعة الإيداعات',
      subtitle: 'طلبات الإدارة المرفقة بإيصالات — القبول يضيف الرصيد للشركة.',
      onRefresh: _load,
      child: [
        if (_requests.isEmpty)
          const ExecutorSurface(
            accent: ExecutorUiColors.cobalt,
            child: Column(
              children: [
                Icon(Icons.account_balance_wallet_outlined, size: 42),
                SizedBox(height: 10),
                Text(
                  'لا توجد طلبات إيداع',
                  style: TextStyle(fontWeight: FontWeight.w900),
                ),
                SizedBox(height: 5),
                Text(
                  'ستظهر هنا طلبات الإيداع الواردة من الإدارة.',
                  textAlign: TextAlign.center,
                ),
              ],
            ),
          )
        else
          ..._requests.map(_requestCard),
      ],
    );
  }

  Widget _requestCard(Map<String, dynamic> request) {
    final status = '${request['status'] ?? 'pending'}';
    final pending = status == 'pending';
    final fromAdmin = request['submittedByRole'] == 'admin';
    final reviewable = request['reviewable'] == true;
    final busy = _busyId == '${request['id'] ?? ''}';
    final receipts = (request['receiptUrls'] as List? ?? const <dynamic>[])
        .map((item) => '$item')
        .where((item) => item.isNotEmpty)
        .toList();
    final colors = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: ExecutorSurface(
        accent: pending
            ? ExecutorUiColors.amber
            : (status == 'deposit' ? ExecutorUiColors.jade : _danger),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    '${request['customId'] ?? 'طلب إيداع'}',
                    style: const TextStyle(fontWeight: FontWeight.w900),
                  ),
                ),
                StatusPill(
                  label: status == 'deposit'
                      ? 'مقبول'
                      : (status == 'rejected' ? 'ملغى' : 'قيد المراجعة'),
                  color: status == 'deposit'
                      ? _green
                      : (status == 'rejected' ? _danger : _gold),
                ),
              ],
            ),
            const SizedBox(height: 8),
            Text(
              '${formatEgpAmount(numberValue(request['amount']))} EGP',
              style: const TextStyle(fontSize: 23, fontWeight: FontWeight.w900),
            ),
            Text(
              '${request['note'] ?? 'لا توجد ملاحظة'}',
              style: TextStyle(color: colors.onSurfaceVariant),
            ),
            const SizedBox(height: 6),
            Text(
              'تاريخ الطلب: ${formatDate(request['createdAt'])}',
              style: TextStyle(fontSize: 11, color: colors.onSurfaceVariant),
            ),
            const SizedBox(height: 5),
            Text(
              fromAdmin
                  ? 'مرسل من الإدارة — بانتظار قرار شركة التنفيذ.'
                  : 'طلب داخلي للشركة — للعرض فقط.',
              style: TextStyle(
                fontSize: 11,
                fontWeight: FontWeight.w700,
                color: fromAdmin
                    ? ExecutorUiColors.amber
                    : colors.onSurfaceVariant,
              ),
            ),
            if (receipts.isNotEmpty) ...[
              const SizedBox(height: 12),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: receipts
                    .map(
                      (url) => InkWell(
                        onTap: () => _openReceipt(url),
                        child: ClipRRect(
                          borderRadius: BorderRadius.circular(10),
                          child: Image.network(
                            widget.controller.api
                                .resolveMediaUrl(url)
                                .toString(),
                            width: 62,
                            height: 62,
                            fit: BoxFit.cover,
                          ),
                        ),
                      ),
                    )
                    .toList(),
              ),
            ],
            if (pending && reviewable) ...[
              const SizedBox(height: 14),
              Row(
                children: [
                  Expanded(
                    child: FilledButton.icon(
                      onPressed: busy ? null : () => _review(request, true),
                      icon: busy
                          ? const SizedBox(
                              width: 16,
                              height: 16,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            )
                          : const Icon(Icons.check_circle_outline),
                      label: const Text('قبول الإيداع'),
                    ),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: OutlinedButton.icon(
                      style: OutlinedButton.styleFrom(foregroundColor: _danger),
                      onPressed: busy ? null : () => _review(request, false),
                      icon: const Icon(Icons.cancel_outlined),
                      label: const Text('إلغاء الطلب'),
                    ),
                  ),
                ],
              ),
            ],
            if (pending && !reviewable) ...[
              const SizedBox(height: 12),
              Container(
                padding: const EdgeInsets.all(10),
                decoration: BoxDecoration(
                  color: colors.surfaceContainerHighest.withValues(alpha: .42),
                  borderRadius: BorderRadius.circular(10),
                ),
                child: Text(
                  fromAdmin
                      ? 'تحتاج إلى الدخول بحساب مدير شركة التنفيذ لإتمام المراجعة.'
                      : 'هذا الطلب ليس واصلاً من الإدارة، لذلك لا يمكن قبوله أو إلغاؤه من هنا.',
                  style: const TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class ExecutorSupportScreen extends StatefulWidget {
  const ExecutorSupportScreen({super.key, required this.controller});

  final SessionController controller;

  @override
  State<ExecutorSupportScreen> createState() => _ExecutorSupportScreenState();
}

class _ExecutorSupportScreenState extends State<ExecutorSupportScreen>
    with WidgetsBindingObserver {
  final _search = TextEditingController();
  List<Map<String, dynamic>> _tickets = <Map<String, dynamic>>[];
  Map<String, dynamic> _summary = <String, dynamic>{};
  Map<String, dynamic> _permissions = <String, dynamic>{};
  Object? _error;
  bool _loading = true;
  String? _syncError;
  DateTime? _lastUpdated;
  String _status = 'active';
  String _category = '';

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _load();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _search.dispose();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed && _tickets.isNotEmpty) {
      unawaited(_load(quiet: true));
    }
  }

  Future<void> _load({bool quiet = false}) async {
    if (!quiet && mounted) {
      setState(() {
        _loading = true;
        _error = null;
      });
    }
    try {
      final response = await widget.controller.api
          .executorSupportTickets(
            status: _status,
            category: _category,
            search: _search.text,
          )
          .timeout(
            const Duration(seconds: 12),
            onTimeout: () => throw const ApiFailure(
              'انتهت مهلة الاتصال بالدعم. تحقق من الخادم ثم أعد المحاولة.',
            ),
          );
      final rawTickets = response['tickets'];
      if (!mounted) return;
      setState(() {
        _tickets = rawTickets is List
            ? rawTickets
                  .whereType<Map>()
                  .map((item) => Map<String, dynamic>.from(item))
                  .toList()
            : <Map<String, dynamic>>[];
        _summary = response['summary'] is Map
            ? Map<String, dynamic>.from(response['summary'] as Map)
            : <String, dynamic>{};
        _permissions = response['permissions'] is Map
            ? Map<String, dynamic>.from(response['permissions'] as Map)
            : <String, dynamic>{};
        _error = null;
        _syncError = null;
        _lastUpdated = DateTime.now();
      });
    } catch (error) {
      if (mounted) {
        setState(() {
          if (!quiet || _tickets.isEmpty) _error = error;
          _syncError = 'تعذر تحديث طلبات الدعم الآن. اضغط هنا لإعادة المحاولة.';
        });
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _createTicket({Map<String, dynamic>? diagnostics}) async {
    final created = await Navigator.of(context).push<bool>(
      MaterialPageRoute(
        builder: (_) => ExecutorSupportCreateScreen(
          controller: widget.controller,
          initialDiagnostics: diagnostics,
        ),
      ),
    );
    if (created == true) await _load();
  }

  Future<void> _openTicket(Map<String, dynamic> ticket) async {
    final updated = await Navigator.of(context).push<bool>(
      MaterialPageRoute(
        builder: (_) => ExecutorSupportConversationScreen(
          controller: widget.controller,
          ticketId: '${ticket['id'] ?? ''}',
        ),
      ),
    );
    if (updated == true) await _load();
  }

  Future<void> _openGroupChat() async {
    final updated = await Navigator.of(context).push<bool>(
      MaterialPageRoute(
        builder: (_) => ExecutorSupportConversationScreen(
          controller: widget.controller,
          groupChat: true,
        ),
      ),
    );
    if (updated == true) await _load(quiet: true);
  }

  Future<void> _showDiagnostics() async {
    showDialog<void>(
      context: context,
      barrierDismissible: false,
      builder: (_) => const Center(child: CircularProgressIndicator()),
    );
    try {
      final response = await widget.controller.api.executorSupportDiagnostics();
      if (!mounted) return;
      Navigator.of(context, rootNavigator: true).pop();
      final diagnostics = response['diagnostics'] is Map
          ? Map<String, dynamic>.from(response['diagnostics'] as Map)
          : <String, dynamic>{};
      final attach = await showModalBottomSheet<bool>(
        context: context,
        showDragHandle: true,
        isScrollControlled: true,
        builder: (_) =>
            ExecutorSupportDiagnosticsSheet(diagnostics: diagnostics),
      );
      if (attach == true && mounted) {
        await _createTicket(
          diagnostics: <String, dynamic>{
            'appVersion': '1.2.26+32',
            'platform': 'Flutter',
            'apiBaseUrl': widget.controller.api.baseUrl,
            'networkStatus': '${diagnostics['server'] ?? 'unknown'}',
            'backgroundService': 'configured',
            'notificationPermission': 'requested',
          },
        );
      }
    } on ApiFailure catch (error) {
      if (!mounted) return;
      Navigator.of(context, rootNavigator: true).pop();
      showSnack(context, error.message, error: true);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_error != null && _tickets.isEmpty) {
      return ErrorPage(error: _error!, onRetry: _load);
    }
    final role = '${_permissions['role'] ?? widget.controller.executorRole}';
    // Older API builds returned permissions.categories as null or an object.
    // Never let that response shape break the whole support page during build.
    final rawCategories = _permissions['categories'];
    final categorySource = rawCategories is List
        ? rawCategories
        : _executorSupportCategoriesFor(role);
    final categories = categorySource
        .map((item) => '$item')
        .where(_executorSupportCategoryLabels.containsKey)
        .toList();

    return PageFrame(
      title: 'الدعم الفني',
      subtitle: role == 'manager'
          ? 'متابعة طلبات شركة التنفيذ والتواصل المباشر مع الإدارة.'
          : 'طلباتك ومحادثاتك مع فريق الدعم في مكان واحد.',
      onRefresh: _load,
      action: IconButton.filledTonal(
        tooltip: 'فحص الاتصال',
        onPressed: _showDiagnostics,
        icon: const Icon(Icons.health_and_safety_outlined),
      ),
      child: [
        if (_syncError != null) ...[
          InkWell(
            onTap: () => _load(),
            borderRadius: BorderRadius.circular(8),
            child: Container(
              padding: const EdgeInsets.all(11),
              decoration: BoxDecoration(
                color: _gold.withValues(alpha: 0.10),
                borderRadius: BorderRadius.circular(8),
                border: Border.all(color: _gold.withValues(alpha: 0.32)),
              ),
              child: Row(
                children: [
                  const Icon(Icons.sync_problem_outlined, color: _gold),
                  const SizedBox(width: 9),
                  Expanded(
                    child: Text(
                      _syncError!,
                      style: const TextStyle(fontWeight: FontWeight.w700),
                    ),
                  ),
                  const Icon(Icons.refresh_rounded, color: _gold),
                ],
              ),
            ),
          ),
          const SizedBox(height: 12),
        ],
        ExecutorSurface(
          accent: ExecutorUiColors.jade,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  const ExecutorMetalIcon(
                    icon: Icons.headset_mic_outlined,
                    color: ExecutorUiColors.jade,
                    size: 48,
                    selected: true,
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Text(
                          'مركز دعم التنفيذ',
                          style: TextStyle(
                            fontWeight: FontWeight.w900,
                            fontSize: 17,
                          ),
                        ),
                        Text(
                          'متصل الآن · تُحفظ كل المحادثات والمرفقات داخل الطلب.',
                          style: TextStyle(
                            color: Theme.of(
                              context,
                            ).colorScheme.onSurfaceVariant,
                            fontSize: 12,
                          ),
                        ),
                      ],
                    ),
                  ),
                  const StatusPill(label: 'متاح', color: _green),
                ],
              ),
              const SizedBox(height: 16),
              Row(
                children: [
                  Expanded(
                    child: _ExecutorSupportSummaryCard(
                      label: 'نشطة',
                      value: '${numberValue(_summary['active']).toInt()}',
                      icon: Icons.pending_actions_outlined,
                      color: ExecutorUiColors.amber,
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: _ExecutorSupportSummaryCard(
                      label: 'ردود جديدة',
                      value: '${numberValue(_summary['unread']).toInt()}',
                      icon: Icons.mark_chat_unread_outlined,
                      color: const Color(0xFF1976D2),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: _ExecutorSupportSummaryCard(
                      label: 'مغلقة',
                      value: '${numberValue(_summary['closed']).toInt()}',
                      icon: Icons.task_alt_outlined,
                      color: _green,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 14),
              Row(
                children: [
                  Expanded(
                    child: FilledButton.icon(
                      onPressed: _openGroupChat,
                      icon: const Icon(Icons.groups_2_outlined),
                      label: const Text('مجموعة الشركة'),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: OutlinedButton.icon(
                      onPressed: _createTicket,
                      icon: const Icon(Icons.add_comment_outlined),
                      label: const Text('طلب جديد'),
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
        if (_lastUpdated != null) ...[
          const SizedBox(height: 7),
          Align(
            alignment: AlignmentDirectional.centerStart,
            child: Text(
              'آخر تحديث ${formatSupportUpdatedAt(_lastUpdated!)}',
              style: TextStyle(
                color: Theme.of(context).colorScheme.onSurfaceVariant,
                fontSize: 11,
              ),
            ),
          ),
        ],
        const SizedBox(height: 14),
        ExecutorSurface(
          accent: ExecutorUiColors.cobalt,
          elevated: false,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              SegmentedButton<String>(
                segments: const <ButtonSegment<String>>[
                  ButtonSegment(
                    value: 'active',
                    label: Text('النشطة'),
                    icon: Icon(Icons.pending_actions_outlined),
                  ),
                  ButtonSegment(
                    value: 'closed',
                    label: Text('المغلقة'),
                    icon: Icon(Icons.task_alt_outlined),
                  ),
                  ButtonSegment(
                    value: 'all',
                    label: Text('الكل'),
                    icon: Icon(Icons.list_alt_outlined),
                  ),
                ],
                selected: <String>{_status},
                onSelectionChanged: (selected) {
                  setState(() => _status = selected.first);
                  _load();
                },
              ),
              const SizedBox(height: 12),
              TextField(
                controller: _search,
                textInputAction: TextInputAction.search,
                onSubmitted: (_) => _load(),
                decoration: InputDecoration(
                  labelText: 'بحث برقم الطلب أو العملية',
                  prefixIcon: const Icon(Icons.search),
                  suffixIcon: _search.text.isEmpty
                      ? null
                      : IconButton(
                          tooltip: 'مسح البحث',
                          onPressed: () {
                            _search.clear();
                            _load();
                          },
                          icon: const Icon(Icons.close),
                        ),
                ),
              ),
              const SizedBox(height: 10),
              DropdownButtonFormField<String>(
                initialValue: _category,
                decoration: const InputDecoration(
                  labelText: 'نوع الطلب',
                  prefixIcon: Icon(Icons.tune_outlined),
                ),
                items: <DropdownMenuItem<String>>[
                  const DropdownMenuItem(value: '', child: Text('كل الأنواع')),
                  ...categories.map(
                    (key) => DropdownMenuItem(
                      value: key,
                      child: Text(_executorSupportCategoryLabels[key] ?? key),
                    ),
                  ),
                ],
                onChanged: (value) {
                  setState(() => _category = value ?? '');
                  _load();
                },
              ),
            ],
          ),
        ),
        const SizedBox(height: 14),
        if (_loading)
          const LinearProgressIndicator()
        else if (_tickets.isEmpty)
          EmptyPanel(
            icon: _status == 'closed'
                ? Icons.task_alt_outlined
                : Icons.support_agent_outlined,
            title: 'لا توجد طلبات في هذا القسم',
            message: _status == 'active'
                ? 'عند فتح طلب جديد سيظهر هنا ويمكن متابعة رد الإدارة لحظة بلحظة.'
                : 'لا توجد طلبات مغلقة مطابقة للفلاتر الحالية.',
          )
        else
          ..._tickets.map(
            (ticket) => Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: ExecutorSupportTicketCard(
                ticket: ticket,
                showRequester: _permissions['canViewGroupTickets'] == true,
                onTap: () => _openTicket(ticket),
              ),
            ),
          ),
      ],
    );
  }
}

class _ExecutorSupportSummaryCard extends StatelessWidget {
  const _ExecutorSupportSummaryCard({
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
    return Container(
      constraints: const BoxConstraints(minHeight: 88),
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: color.withValues(alpha: 0.18)),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          ExecutorMetalIcon(icon: icon, color: color, size: 30),
          const SizedBox(height: 8),
          Text(
            value,
            style: TextStyle(
              color: color,
              fontWeight: FontWeight.w900,
              fontSize: 18,
            ),
          ),
          Text(
            label,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
              color: Theme.of(context).colorScheme.onSurfaceVariant,
              fontSize: 10,
            ),
          ),
        ],
      ),
    );
  }
}

class ExecutorSupportTicketCard extends StatelessWidget {
  const ExecutorSupportTicketCard({
    super.key,
    required this.ticket,
    required this.showRequester,
    required this.onTap,
  });

  final Map<String, dynamic> ticket;
  final bool showRequester;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final status = '${ticket['status'] ?? 'open'}';
    final priority = '${ticket['priority'] ?? 'normal'}';
    final requester = ticket['requester'] is Map
        ? Map<String, dynamic>.from(ticket['requester'] as Map)
        : <String, dynamic>{};
    final transaction = ticket['transaction'] is Map
        ? Map<String, dynamic>.from(ticket['transaction'] as Map)
        : <String, dynamic>{};
    final unread = numberValue(ticket['unreadCount']).toInt();

    return Material(
      color: colors.surface,
      borderRadius: BorderRadius.circular(8),
      child: InkWell(
        borderRadius: BorderRadius.circular(8),
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(8),
            border: Border.all(
              color: unread > 0
                  ? const Color(0xFF1976D2).withValues(alpha: 0.45)
                  : colors.outlineVariant,
            ),
            boxShadow: [
              BoxShadow(
                color: _navy.withValues(alpha: 0.05),
                blurRadius: 14,
                offset: const Offset(0, 6),
              ),
            ],
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
                      color: _executorSupportStatusColor(
                        status,
                      ).withValues(alpha: 0.11),
                      borderRadius: BorderRadius.circular(8),
                    ),
                    child: Icon(
                      Icons.forum_outlined,
                      color: _executorSupportStatusColor(status),
                    ),
                  ),
                  const SizedBox(width: 11),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          '${ticket['subject'] ?? 'طلب دعم'}',
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(fontWeight: FontWeight.w900),
                        ),
                        const SizedBox(height: 2),
                        Text(
                          '${ticket['ticketId'] ?? '-'} · ${ticket['categoryLabel'] ?? ''}',
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            color: colors.onSurfaceVariant,
                            fontSize: 11,
                          ),
                        ),
                      ],
                    ),
                  ),
                  const Icon(Icons.chevron_left),
                ],
              ),
              if (showRequester && '${requester['name'] ?? ''}'.isNotEmpty) ...[
                const SizedBox(height: 10),
                Row(
                  children: [
                    const Icon(Icons.person_outline, size: 17),
                    const SizedBox(width: 6),
                    Text(
                      '${requester['name']} · ${_roleLabelForSupport('${requester['role'] ?? 'operator'}')}',
                      style: const TextStyle(
                        fontSize: 12,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                  ],
                ),
              ],
              if ('${transaction['customId'] ?? ''}'.isNotEmpty) ...[
                const SizedBox(height: 8),
                Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 9,
                    vertical: 7,
                  ),
                  decoration: BoxDecoration(
                    color: colors.surfaceContainerHighest,
                    borderRadius: BorderRadius.circular(6),
                  ),
                  child: Row(
                    children: [
                      const Icon(Icons.receipt_long_outlined, size: 17),
                      const SizedBox(width: 6),
                      Expanded(
                        child: Text(
                          'مرتبطة بالعملية ${transaction['customId']}',
                          style: const TextStyle(
                            fontSize: 11,
                            fontWeight: FontWeight.w700,
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ],
              const SizedBox(height: 10),
              Text(
                '${ticket['lastMessage'] ?? ''}',
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(color: colors.onSurfaceVariant, fontSize: 12),
              ),
              const SizedBox(height: 10),
              Wrap(
                spacing: 7,
                runSpacing: 7,
                children: [
                  StatusPill(
                    label: _executorSupportStatusLabel(status),
                    color: _executorSupportStatusColor(status),
                  ),
                  StatusPill(
                    label: _executorSupportPriorityLabel(priority),
                    color: _executorSupportPriorityColor(priority),
                  ),
                  if (unread > 0)
                    StatusPill(
                      label: '$unread رد جديد',
                      color: const Color(0xFF1976D2),
                    ),
                  StatusPill(
                    label: formatDate(ticket['updatedAt']),
                    color: colors.onSurfaceVariant,
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

String _roleLabelForSupport(String role) {
  switch (role) {
    case 'manager':
      return 'مدير';
    case 'accountant':
      return 'محاسب';
    default:
      return 'موظف تنفيذ';
  }
}

class ExecutorSupportCreateScreen extends StatefulWidget {
  const ExecutorSupportCreateScreen({
    super.key,
    required this.controller,
    this.initialDiagnostics,
  });

  final SessionController controller;
  final Map<String, dynamic>? initialDiagnostics;

  @override
  State<ExecutorSupportCreateScreen> createState() =>
      _ExecutorSupportCreateScreenState();
}

class _ExecutorSupportCreateScreenState
    extends State<ExecutorSupportCreateScreen> {
  final _subject = TextEditingController();
  final _message = TextEditingController();
  final _transaction = TextEditingController();
  final _picker = ImagePicker();
  final List<Uint8List> _images = <Uint8List>[];
  late String _category;
  String _priority = 'normal';
  bool _includeDiagnostics = false;
  bool _busy = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _category = _executorSupportCategoriesFor(
      widget.controller.executorRole,
    ).first;
    _includeDiagnostics = widget.initialDiagnostics != null;
  }

  @override
  void dispose() {
    _subject.dispose();
    _message.dispose();
    _transaction.dispose();
    super.dispose();
  }

  Future<void> _pickImages() async {
    final source = await showModalBottomSheet<ImageSource>(
      context: context,
      showDragHandle: true,
      builder: (context) => SafeArea(
        child: Wrap(
          children: [
            ListTile(
              leading: const Icon(Icons.photo_library_outlined),
              title: const Text('اختيار من المعرض'),
              onTap: () => Navigator.pop(context, ImageSource.gallery),
            ),
            ListTile(
              leading: const Icon(Icons.camera_alt_outlined),
              title: const Text('التقاط صورة'),
              onTap: () => Navigator.pop(context, ImageSource.camera),
            ),
          ],
        ),
      ),
    );
    if (source == null) return;
    final remaining = 3 - _images.length;
    if (remaining <= 0) {
      if (mounted) {
        showSnack(context, 'يمكن إرفاق 3 صور بحد أقصى.', error: true);
      }
      return;
    }
    if (source == ImageSource.gallery) {
      final files = await _picker.pickMultiImage(
        imageQuality: 74,
        maxWidth: 1600,
      );
      final bytes = await Future.wait(
        files.take(remaining).map((file) => file.readAsBytes()),
      );
      if (mounted) setState(() => _images.addAll(bytes));
      return;
    }
    final file = await _picker.pickImage(
      source: source,
      imageQuality: 74,
      maxWidth: 1600,
    );
    if (file == null) return;
    final bytes = await file.readAsBytes();
    if (mounted) setState(() => _images.add(bytes));
  }

  Future<void> _submit() async {
    final subject = _subject.text.trim();
    final message = _message.text.trim();
    if (subject.length < 4 || message.length < 5) {
      setState(
        () => _error = 'اكتب عنواناً واضحاً ووصفاً للمشكلة قبل الإرسال.',
      );
      return;
    }
    final approved = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('مراجعة طلب الدعم'),
        content: SizedBox(
          width: 420,
          child: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                DetailLine(label: 'العنوان', value: subject),
                DetailLine(
                  label: 'نوع الطلب',
                  value: _executorSupportCategoryLabels[_category] ?? _category,
                ),
                DetailLine(
                  label: 'الأولوية',
                  value: _executorSupportPriorityLabel(_priority),
                ),
                if (_transaction.text.trim().isNotEmpty)
                  DetailLine(
                    label: 'رقم العملية',
                    value: _transaction.text.trim(),
                  ),
                DetailLine(label: 'المرفقات', value: '${_images.length}'),
                const SizedBox(height: 10),
                Align(
                  alignment: AlignmentDirectional.centerStart,
                  child: Text(message),
                ),
              ],
            ),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('رجوع'),
          ),
          FilledButton.icon(
            onPressed: () => Navigator.pop(context, true),
            icon: const Icon(Icons.send_outlined),
            label: const Text('إرسال الطلب'),
          ),
        ],
      ),
    );
    if (approved != true || !mounted) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final attachments = _images
          .map((image) => 'data:image/jpeg;base64,${base64Encode(image)}')
          .toList();
      await widget.controller.api.createExecutorSupportTicket(
        subject: subject,
        category: _category,
        priority: _priority,
        message: message,
        transactionRef: _transaction.text,
        imagesBase64: attachments,
        diagnostics: _includeDiagnostics
            ? (widget.initialDiagnostics ??
                  <String, dynamic>{
                    'appVersion': '1.2.18+23',
                    'platform': 'Flutter',
                    'apiBaseUrl': widget.controller.api.baseUrl,
                    'networkStatus': 'online',
                    'backgroundService': 'configured',
                    'notificationPermission': 'requested',
                  })
            : null,
      );
      if (!mounted) return;
      showSnack(context, 'تم فتح طلب الدعم وإبلاغ الإدارة بنجاح.');
      Navigator.pop(context, true);
    } on ApiFailure catch (error) {
      if (mounted) setState(() => _error = error.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final categories = _executorSupportCategoriesFor(
      widget.controller.executorRole,
    );
    return Scaffold(
      appBar: AppBar(title: const Text('طلب دعم جديد')),
      body: SafeArea(
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 720),
            child: ListView(
              padding: const EdgeInsets.all(16),
              children: [
                SurfacePanel(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      const Text(
                        'كيف يمكننا مساعدتك؟',
                        style: TextStyle(
                          fontWeight: FontWeight.w900,
                          fontSize: 19,
                        ),
                      ),
                      const SizedBox(height: 5),
                      Text(
                        'اختر النوع وأرفق رقم العملية والصور إن كانت مرتبطة بالمشكلة.',
                        style: TextStyle(
                          color: Theme.of(context).colorScheme.onSurfaceVariant,
                        ),
                      ),
                      const SizedBox(height: 18),
                      DropdownButtonFormField<String>(
                        initialValue: _category,
                        decoration: const InputDecoration(
                          labelText: 'نوع الطلب',
                          prefixIcon: Icon(Icons.category_outlined),
                        ),
                        items: categories
                            .map(
                              (key) => DropdownMenuItem(
                                value: key,
                                child: Text(
                                  _executorSupportCategoryLabels[key] ?? key,
                                ),
                              ),
                            )
                            .toList(),
                        onChanged: (value) => setState(() {
                          _category = value ?? categories.first;
                          if (<String>{
                            'pending_transaction',
                            'cancellation',
                            'api',
                          }.contains(_category)) {
                            _priority = 'high';
                          }
                        }),
                      ),
                      const SizedBox(height: 12),
                      TextField(
                        controller: _subject,
                        maxLength: 120,
                        decoration: const InputDecoration(
                          labelText: 'عنوان مختصر',
                          prefixIcon: Icon(Icons.title_outlined),
                          hintText: 'مثال: عملية مقبولة لا تظهر في المهام',
                        ),
                      ),
                      const SizedBox(height: 4),
                      TextField(
                        controller: _transaction,
                        textDirection: ui.TextDirection.ltr,
                        decoration: const InputDecoration(
                          labelText: 'رقم العملية (اختياري)',
                          prefixIcon: Icon(Icons.receipt_long_outlined),
                          hintText: 'ATT-0000-0000',
                        ),
                      ),
                      const SizedBox(height: 12),
                      TextField(
                        controller: _message,
                        minLines: 5,
                        maxLines: 8,
                        maxLength: 2000,
                        decoration: const InputDecoration(
                          labelText: 'وصف المشكلة',
                          alignLabelWithHint: true,
                          hintText:
                              'اكتب ما حدث، والنتيجة المتوقعة، وأي رسالة خطأ ظهرت لك.',
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 14),
                SurfacePanel(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      const Text(
                        'الأولوية والمرفقات',
                        style: TextStyle(fontWeight: FontWeight.w900),
                      ),
                      const SizedBox(height: 12),
                      SegmentedButton<String>(
                        segments: const <ButtonSegment<String>>[
                          ButtonSegment(value: 'normal', label: Text('عادي')),
                          ButtonSegment(value: 'high', label: Text('مرتفع')),
                          ButtonSegment(value: 'urgent', label: Text('طارئ')),
                        ],
                        selected: <String>{_priority},
                        onSelectionChanged: (value) =>
                            setState(() => _priority = value.first),
                      ),
                      const SizedBox(height: 14),
                      ExecutorSupportAttachmentPicker(
                        images: _images,
                        onPick: _pickImages,
                        onRemove: (index) =>
                            setState(() => _images.removeAt(index)),
                      ),
                      const SizedBox(height: 8),
                      SwitchListTile.adaptive(
                        contentPadding: EdgeInsets.zero,
                        value: _includeDiagnostics,
                        onChanged: (value) =>
                            setState(() => _includeDiagnostics = value),
                        secondary: const Icon(Icons.health_and_safety_outlined),
                        title: const Text('إرفاق تقرير الاتصال'),
                        subtitle: const Text(
                          'يرسل إصدار التطبيق وحالة الاتصال فقط دون كلمات مرور أو بيانات حساسة.',
                        ),
                      ),
                    ],
                  ),
                ),
                if (_error != null) ...[
                  const SizedBox(height: 12),
                  InlineMessage(message: _error!, color: _danger),
                ],
                const SizedBox(height: 16),
                FilledButton.icon(
                  onPressed: _busy ? null : _submit,
                  icon: _busy
                      ? const SizedBox.square(
                          dimension: 18,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Icon(Icons.preview_outlined),
                  label: Text(_busy ? 'جارٍ الإرسال...' : 'مراجعة وإرسال'),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class ExecutorSupportAttachmentPicker extends StatelessWidget {
  const ExecutorSupportAttachmentPicker({
    super.key,
    required this.images,
    required this.onPick,
    required this.onRemove,
  });

  final List<Uint8List> images;
  final VoidCallback onPick;
  final ValueChanged<int> onRemove;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (images.isNotEmpty)
          SizedBox(
            height: 92,
            child: ListView.separated(
              scrollDirection: Axis.horizontal,
              itemCount: images.length,
              separatorBuilder: (_, _) => const SizedBox(width: 8),
              itemBuilder: (context, index) => Stack(
                children: [
                  ClipRRect(
                    borderRadius: BorderRadius.circular(8),
                    child: Image.memory(
                      images[index],
                      width: 92,
                      height: 92,
                      fit: BoxFit.cover,
                    ),
                  ),
                  PositionedDirectional(
                    top: 4,
                    end: 4,
                    child: Material(
                      color: _danger,
                      shape: const CircleBorder(),
                      child: InkWell(
                        customBorder: const CircleBorder(),
                        onTap: () => onRemove(index),
                        child: const Padding(
                          padding: EdgeInsets.all(4),
                          child: Icon(
                            Icons.close,
                            size: 15,
                            color: Colors.white,
                          ),
                        ),
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        if (images.isNotEmpty) const SizedBox(height: 9),
        OutlinedButton.icon(
          onPressed: images.length >= 3 ? null : onPick,
          icon: const Icon(Icons.add_photo_alternate_outlined),
          label: Text(
            images.isEmpty
                ? 'إرفاق صور (اختياري)'
                : 'إضافة صورة أخرى (${images.length}/3)',
          ),
        ),
      ],
    );
  }
}

class ExecutorSupportConversationScreen extends StatefulWidget {
  const ExecutorSupportConversationScreen({
    super.key,
    required this.controller,
    this.ticketId = '',
    this.groupChat = false,
  });

  final SessionController controller;
  final String ticketId;
  final bool groupChat;

  @override
  State<ExecutorSupportConversationScreen> createState() =>
      _ExecutorSupportConversationScreenState();
}

class _ExecutorSupportConversationScreenState
    extends State<ExecutorSupportConversationScreen> {
  final _reply = TextEditingController();
  final _scroll = ScrollController();
  final _picker = ImagePicker();
  final List<Uint8List> _images = <Uint8List>[];
  Map<String, dynamic>? _ticket;
  List<Map<String, dynamic>> _members = <Map<String, dynamic>>[];
  Timer? _poll;
  Object? _error;
  bool _loading = true;
  bool _sending = false;
  bool _changed = false;
  String? _syncError;

  @override
  void initState() {
    super.initState();
    _load();
    _poll = Timer.periodic(const Duration(seconds: 15), (_) {
      _load(quiet: true);
    });
  }

  @override
  void dispose() {
    _poll?.cancel();
    _reply.dispose();
    _scroll.dispose();
    super.dispose();
  }

  Future<void> _load({bool quiet = false}) async {
    if (!quiet && mounted) setState(() => _loading = true);
    try {
      final response = widget.groupChat
          ? await widget.controller.api.executorSupportGroupChat()
          : await widget.controller.api.executorSupportTicketDetails(
              widget.ticketId,
            );
      final raw = response['ticket'];
      if (!mounted || raw is! Map) return;
      final next = Map<String, dynamic>.from(raw);
      final oldMessages = (_ticket?['messages'] as List?)?.length ?? 0;
      final nextMessages = (next['messages'] as List?)?.length ?? 0;
      setState(() {
        _ticket = next;
        final rawMembers = response['members'];
        _members = rawMembers is List
            ? rawMembers
                  .whereType<Map>()
                  .map((item) => Map<String, dynamic>.from(item))
                  .toList()
            : <Map<String, dynamic>>[];
        _error = null;
        _syncError = null;
        if (nextMessages != oldMessages) _changed = true;
      });
      if (nextMessages != oldMessages) _scrollToEnd();
    } catch (error) {
      if (mounted) {
        setState(() {
          if (!quiet || _ticket == null) _error = error;
          _syncError = 'تعذر تحديث المحادثة الآن. اضغط لإعادة المحاولة.';
        });
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  void _scrollToEnd() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!_scroll.hasClients) return;
      _scroll.animateTo(
        _scroll.position.maxScrollExtent,
        duration: const Duration(milliseconds: 280),
        curve: Curves.easeOut,
      );
    });
  }

  Future<void> _pickImages() async {
    final files = await _picker.pickMultiImage(
      imageQuality: 74,
      maxWidth: 1600,
    );
    final remaining = 3 - _images.length;
    final bytes = await Future.wait(
      files.take(remaining).map((file) => file.readAsBytes()),
    );
    if (mounted) setState(() => _images.addAll(bytes));
  }

  Future<void> _send() async {
    final text = _reply.text.trim();
    if (text.isEmpty && _images.isEmpty) return;
    setState(() => _sending = true);
    try {
      final imagesBase64 = _images
          .map((image) => 'data:image/jpeg;base64,${base64Encode(image)}')
          .toList();
      if (widget.groupChat) {
        await widget.controller.api.replyToExecutorSupportGroupChat(
          message: text,
          imagesBase64: imagesBase64,
        );
      } else {
        await widget.controller.api.replyToExecutorSupportTicket(
          id: widget.ticketId,
          message: text,
          imagesBase64: imagesBase64,
        );
      }
      _reply.clear();
      _images.clear();
      _changed = true;
      await _load(quiet: true);
    } on ApiFailure catch (error) {
      if (mounted) showSnack(context, error.message, error: true);
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final ticket = _ticket;
    if (_loading && ticket == null) return const Scaffold(body: PageLoading());
    if (_error != null && ticket == null) {
      return Scaffold(
        body: ErrorPage(error: _error!, onRetry: _load),
      );
    }
    final status = '${ticket?['status'] ?? 'open'}';
    final closed = <String>{'closed', 'resolved'}.contains(status);
    final messages = (ticket?['messages'] as List? ?? const <dynamic>[])
        .whereType<Map>()
        .map((item) => Map<String, dynamic>.from(item))
        .toList();
    final transaction = ticket?['transaction'] is Map
        ? Map<String, dynamic>.from(ticket!['transaction'] as Map)
        : <String, dynamic>{};

    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, result) {
        if (!didPop) Navigator.pop(context, _changed);
      },
      child: Scaffold(
        appBar: AppBar(
          title: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                widget.groupChat
                    ? 'مجموعة شركة التنفيذ'
                    : '${ticket?['subject'] ?? 'طلب دعم'}',
              ),
              Text(
                '${ticket?['ticketId'] ?? ''}',
                textDirection: ui.TextDirection.ltr,
                style: const TextStyle(fontSize: 11),
              ),
            ],
          ),
          actions: [
            IconButton(
              tooltip: 'تحديث المحادثة',
              onPressed: _loading ? null : _load,
              icon: const Icon(Icons.refresh),
            ),
          ],
        ),
        body: SafeArea(
          child: Column(
            children: [
              Expanded(
                child: RefreshIndicator(
                  onRefresh: _load,
                  child: ListView(
                    controller: _scroll,
                    padding: const EdgeInsets.all(14),
                    children: [
                      if (_syncError != null)
                        Padding(
                          padding: const EdgeInsets.only(bottom: 10),
                          child: InkWell(
                            onTap: () => _load(),
                            borderRadius: BorderRadius.circular(8),
                            child: Container(
                              padding: const EdgeInsets.all(10),
                              decoration: BoxDecoration(
                                color: _gold.withValues(alpha: 0.10),
                                borderRadius: BorderRadius.circular(8),
                                border: Border.all(
                                  color: _gold.withValues(alpha: 0.32),
                                ),
                              ),
                              child: Row(
                                children: [
                                  const Icon(
                                    Icons.sync_problem_outlined,
                                    color: _gold,
                                  ),
                                  const SizedBox(width: 8),
                                  Expanded(
                                    child: Text(
                                      _syncError!,
                                      style: const TextStyle(
                                        fontWeight: FontWeight.w700,
                                      ),
                                    ),
                                  ),
                                  const Icon(
                                    Icons.refresh_rounded,
                                    color: _gold,
                                  ),
                                ],
                              ),
                            ),
                          ),
                        ),
                      SurfacePanel(
                        child: Column(
                          children: [
                            Row(
                              children: [
                                Expanded(
                                  child: Text(
                                    '${ticket?['categoryLabel'] ?? ''}',
                                    style: const TextStyle(
                                      fontWeight: FontWeight.w900,
                                    ),
                                  ),
                                ),
                                StatusPill(
                                  label: _executorSupportStatusLabel(status),
                                  color: _executorSupportStatusColor(status),
                                ),
                                const SizedBox(width: 6),
                                StatusPill(
                                  label: _executorSupportPriorityLabel(
                                    '${ticket?['priority'] ?? 'normal'}',
                                  ),
                                  color: _executorSupportPriorityColor(
                                    '${ticket?['priority'] ?? 'normal'}',
                                  ),
                                ),
                              ],
                            ),
                            if ('${transaction['customId'] ?? ''}'
                                .isNotEmpty) ...[
                              const Divider(height: 24),
                              DetailLine(
                                label: 'العملية المرتبطة',
                                value: '${transaction['customId']}',
                              ),
                              DetailLine(
                                label: 'القيمة',
                                value:
                                    '${formatEgpAmount(numberValue(transaction['amount']))} ج.م',
                              ),
                              DetailLine(
                                label: 'الحالة',
                                value: statusLabel(
                                  '${transaction['status'] ?? ''}',
                                ),
                              ),
                            ],
                            if (widget.groupChat && _members.isNotEmpty) ...[
                              const Divider(height: 24),
                              Text(
                                'الأعضاء (${_members.length})',
                                style: const TextStyle(
                                  fontWeight: FontWeight.w900,
                                ),
                              ),
                              const SizedBox(height: 7),
                              Wrap(
                                spacing: 6,
                                runSpacing: 6,
                                children: _members
                                    .map(
                                      (member) => Chip(
                                        avatar: Icon(
                                          '${member['role'] ?? ''}' == 'admin'
                                              ? Icons
                                                    .admin_panel_settings_outlined
                                              : Icons.person_outline,
                                          size: 16,
                                        ),
                                        label: Text(
                                          '${member['name'] ?? 'عضو'}',
                                        ),
                                        visualDensity: VisualDensity.compact,
                                      ),
                                    )
                                    .toList(),
                              ),
                            ],
                          ],
                        ),
                      ),
                      const SizedBox(height: 16),
                      if (messages.isEmpty)
                        const EmptyPanel(
                          icon: Icons.chat_bubble_outline,
                          title: 'لا توجد رسائل',
                          message: 'ستظهر المحادثة مع فريق الدعم هنا.',
                        )
                      else
                        ...messages.map(
                          (message) => Padding(
                            padding: const EdgeInsets.only(bottom: 10),
                            child: ExecutorSupportMessageBubble(
                              api: widget.controller.api,
                              message: message,
                            ),
                          ),
                        ),
                    ],
                  ),
                ),
              ),
              if (closed)
                Container(
                  width: double.infinity,
                  padding: const EdgeInsets.all(14),
                  decoration: BoxDecoration(
                    color: _green.withValues(alpha: 0.08),
                    border: Border(
                      top: BorderSide(color: _green.withValues(alpha: 0.22)),
                    ),
                  ),
                  child: const Row(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      Icon(Icons.task_alt_outlined, color: _green),
                      SizedBox(width: 8),
                      Text(
                        'تم إغلاق هذا الطلب. افتح طلباً جديداً عند الحاجة.',
                        style: TextStyle(fontWeight: FontWeight.w800),
                      ),
                    ],
                  ),
                )
              else
                _ExecutorSupportReplyComposer(
                  controller: _reply,
                  images: _images,
                  sending: _sending,
                  onPick: _pickImages,
                  onRemove: (index) => setState(() => _images.removeAt(index)),
                  onSend: _send,
                  onQuickReply: (text) {
                    _reply.text = text;
                    _reply.selection = TextSelection.collapsed(
                      offset: _reply.text.length,
                    );
                  },
                ),
            ],
          ),
        ),
      ),
    );
  }
}

class _ExecutorSupportReplyComposer extends StatelessWidget {
  const _ExecutorSupportReplyComposer({
    required this.controller,
    required this.images,
    required this.sending,
    required this.onPick,
    required this.onRemove,
    required this.onSend,
    required this.onQuickReply,
  });

  final TextEditingController controller;
  final List<Uint8List> images;
  final bool sending;
  final VoidCallback onPick;
  final ValueChanged<int> onRemove;
  final VoidCallback onSend;
  final ValueChanged<String> onQuickReply;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.fromLTRB(12, 9, 12, 12),
      decoration: BoxDecoration(
        color: colors.surface,
        border: Border(top: BorderSide(color: colors.outlineVariant)),
        boxShadow: [
          BoxShadow(
            color: _navy.withValues(alpha: 0.06),
            blurRadius: 14,
            offset: const Offset(0, -4),
          ),
        ],
      ),
      child: SafeArea(
        top: false,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (images.isNotEmpty) ...[
              SizedBox(
                height: 64,
                child: ListView.separated(
                  scrollDirection: Axis.horizontal,
                  itemCount: images.length,
                  separatorBuilder: (_, _) => const SizedBox(width: 7),
                  itemBuilder: (_, index) => Stack(
                    children: [
                      ClipRRect(
                        borderRadius: BorderRadius.circular(7),
                        child: Image.memory(
                          images[index],
                          width: 64,
                          height: 64,
                          fit: BoxFit.cover,
                        ),
                      ),
                      PositionedDirectional(
                        top: 2,
                        end: 2,
                        child: InkWell(
                          onTap: () => onRemove(index),
                          child: const CircleAvatar(
                            radius: 10,
                            backgroundColor: _danger,
                            child: Icon(
                              Icons.close,
                              size: 12,
                              color: Colors.white,
                            ),
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
              const SizedBox(height: 8),
            ],
            SizedBox(
              height: 34,
              child: ListView(
                scrollDirection: Axis.horizontal,
                children: [
                  ActionChip(
                    label: const Text('المشكلة مستمرة'),
                    onPressed: () => onQuickReply('المشكلة ما زالت مستمرة.'),
                  ),
                  const SizedBox(width: 6),
                  ActionChip(
                    label: const Text('تم إرفاق التفاصيل'),
                    onPressed: () =>
                        onQuickReply('تم إرفاق التفاصيل المطلوبة.'),
                  ),
                  const SizedBox(width: 6),
                  ActionChip(
                    label: const Text('تم الحل'),
                    onPressed: () => onQuickReply('تم حل المشكلة، شكراً لكم.'),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 8),
            Row(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                IconButton.filledTonal(
                  tooltip: 'إرفاق صور',
                  onPressed: images.length >= 3 || sending ? null : onPick,
                  icon: const Icon(Icons.add_photo_alternate_outlined),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: TextField(
                    controller: controller,
                    minLines: 1,
                    maxLines: 4,
                    enabled: !sending,
                    decoration: const InputDecoration(
                      hintText: 'اكتب ردك لفريق الدعم...',
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                IconButton.filled(
                  tooltip: 'إرسال',
                  onPressed: sending ? null : onSend,
                  icon: sending
                      ? const SizedBox.square(
                          dimension: 18,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Icon(Icons.send_outlined),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class ExecutorSupportMessageBubble extends StatelessWidget {
  const ExecutorSupportMessageBubble({
    super.key,
    required this.api,
    required this.message,
  });

  final MobileApi api;
  final Map<String, dynamic> message;

  @override
  Widget build(BuildContext context) {
    final fromExecutor = '${message['sender'] ?? 'user'}' == 'user';
    final colors = Theme.of(context).colorScheme;
    final imageUrl = '${message['imageUrl'] ?? ''}'.trim();
    final text = '${message['text'] ?? ''}'.trim();
    return Align(
      alignment: fromExecutor
          ? AlignmentDirectional.centerEnd
          : AlignmentDirectional.centerStart,
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 520),
        child: Container(
          padding: const EdgeInsets.all(11),
          decoration: BoxDecoration(
            color: fromExecutor
                ? const Color(0xFF1976D2).withValues(alpha: 0.11)
                : colors.surface,
            borderRadius: BorderRadius.circular(8),
            border: Border.all(
              color: fromExecutor
                  ? const Color(0xFF1976D2).withValues(alpha: 0.24)
                  : colors.outlineVariant,
            ),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(
                    fromExecutor
                        ? Icons.person_outline
                        : Icons.support_agent_outlined,
                    size: 16,
                    color: fromExecutor ? const Color(0xFF1976D2) : _green,
                  ),
                  const SizedBox(width: 5),
                  Text(
                    '${message['senderName'] ?? (fromExecutor ? 'المنفذ' : 'الدعم')}',
                    style: const TextStyle(
                      fontWeight: FontWeight.w800,
                      fontSize: 11,
                    ),
                  ),
                ],
              ),
              if (imageUrl.isNotEmpty) ...[
                const SizedBox(height: 8),
                InkWell(
                  onTap: () => showDialog<void>(
                    context: context,
                    builder: (_) => Dialog(
                      child: InteractiveViewer(
                        child: Image.network(
                          api.resolveMediaUrl(imageUrl).toString(),
                          fit: BoxFit.contain,
                          errorBuilder: (_, _, _) =>
                              const _ReceiptImageUnavailable(),
                        ),
                      ),
                    ),
                  ),
                  child: ClipRRect(
                    borderRadius: BorderRadius.circular(7),
                    child: Image.network(
                      api.resolveMediaUrl(imageUrl).toString(),
                      width: 240,
                      height: 170,
                      fit: BoxFit.cover,
                      errorBuilder: (_, _, _) =>
                          const _ReceiptImageUnavailable(),
                    ),
                  ),
                ),
              ],
              if (text.isNotEmpty) ...[const SizedBox(height: 7), Text(text)],
              const SizedBox(height: 6),
              Text(
                formatDate(message['createdAt']),
                style: TextStyle(color: colors.onSurfaceVariant, fontSize: 9),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class ExecutorSupportDiagnosticsSheet extends StatelessWidget {
  const ExecutorSupportDiagnosticsSheet({super.key, required this.diagnostics});

  final Map<String, dynamic> diagnostics;

  @override
  Widget build(BuildContext context) {
    final serverOk = diagnostics['server'] == 'online';
    final databaseOk = diagnostics['database'] == 'connected';
    final accountOk = diagnostics['account'] == 'active';
    final groupOk = diagnostics['executorGroup'] == 'active';
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(18, 0, 18, 18),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Text(
              'فحص الاتصال والتشغيل',
              style: TextStyle(fontWeight: FontWeight.w900, fontSize: 19),
            ),
            const SizedBox(height: 5),
            Text(
              'الفحص لا يرسل كلمات مرور أو بيانات حساسة.',
              style: TextStyle(
                color: Theme.of(context).colorScheme.onSurfaceVariant,
              ),
            ),
            const SizedBox(height: 16),
            _ExecutorDiagnosticLine(label: 'خادم Ahram Pay', passed: serverOk),
            _ExecutorDiagnosticLine(
              label: 'قاعدة البيانات',
              passed: databaseOk,
            ),
            _ExecutorDiagnosticLine(label: 'حساب المنفذ', passed: accountOk),
            _ExecutorDiagnosticLine(label: 'شركة التنفيذ', passed: groupOk),
            const SizedBox(height: 14),
            FilledButton.icon(
              onPressed: () => Navigator.pop(context, true),
              icon: const Icon(Icons.add_comment_outlined),
              label: const Text('إرفاق الفحص بطلب دعم'),
            ),
            TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: const Text('إغلاق'),
            ),
          ],
        ),
      ),
    );
  }
}

class _ExecutorDiagnosticLine extends StatelessWidget {
  const _ExecutorDiagnosticLine({required this.label, required this.passed});

  final String label;
  final bool passed;

  @override
  Widget build(BuildContext context) {
    return ListTile(
      contentPadding: EdgeInsets.zero,
      leading: Icon(
        passed ? Icons.check_circle_outline : Icons.error_outline,
        color: passed ? _green : _danger,
      ),
      title: Text(label, style: const TextStyle(fontWeight: FontWeight.w800)),
      trailing: StatusPill(
        label: passed ? 'يعمل' : 'يحتاج مراجعة',
        color: passed ? _green : _danger,
      ),
    );
  }
}

class ExecutorTasksScreen extends StatefulWidget {
  const ExecutorTasksScreen({super.key, required this.controller});

  final SessionController controller;

  @override
  State<ExecutorTasksScreen> createState() => _ExecutorTasksScreenState();
}

class _ExecutorTasksScreenState extends State<ExecutorTasksScreen>
    with WidgetsBindingObserver {
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
  String? _syncError;
  Map<String, dynamic>? _overview;
  DateTime? _lastUpdated;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _load();
    _timer = Timer.periodic(
      const Duration(seconds: 5),
      (_) => _load(silent: true),
    );
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _timer?.cancel();
    _urgentToneTimer?.cancel();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      unawaited(_load(silent: true));
    }
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
          _syncError = null;
        });
        _syncUrgentAlerts(urgentAlerts);
        _showNewUrgentAlertDialog(urgentAlerts);
      }
    } catch (error) {
      if (mounted) {
        setState(() {
          if (!silent) _error = error;
          _syncError =
              'تعذر تحديث مهام التنفيذ. اضغط لإعادة المحاولة وتحقق من اتصال الخادم.';
        });
      }
    } finally {
      if (!silent && mounted) setState(() => _loading = false);
    }
  }

  Future<void> _accept(Map<String, dynamic> task) async {
    final taskId = '${task['id'] ?? ''}'.trim();
    if (taskId.isEmpty) {
      if (mounted) {
        showSnack(
          context,
          'معرف العملية غير صالح. حدّث قائمة المهام.',
          error: true,
        );
      }
      return;
    }
    setState(() => _actionBusy = true);
    final acceptKey =
        'executor-accept-${taskId}_${DateTime.now().microsecondsSinceEpoch}';
    try {
      await widget.controller.api.acceptTask(taskId, idempotencyKey: acceptKey);
      if (mounted) {
        showSnack(context, 'تم قبول العملية وأصبحت في قائمة تنفيذك.');
      }
      await _load();
    } on ApiFailure catch (error) {
      // The server may commit the atomic accept and lose the HTTP response
      // (or receive a duplicate tap). Confirm the authoritative task state
      // before showing a false failure to the executor.
      if (error.statusCode == null || (error.statusCode ?? 0) >= 500) {
        try {
          await widget.controller.api.acceptTask(
            taskId,
            idempotencyKey: acceptKey,
          );
          if (mounted) {
            showSnack(context, 'تم قبول العملية وأصبحت في قائمة تنفيذك.');
          }
          await _load();
          return;
        } on ApiFailure catch (_) {
          // Confirm the authoritative state below before showing an error.
        }
      }
      {
        try {
          final response = await widget.controller.api.executorLiveTasks();
          final rawTasks = response['data'];
          final currentExecutorId = widget.controller.session?.id ?? '';
          final acceptedByMe =
              rawTasks is List &&
              rawTasks.whereType<Map>().any((item) {
                final candidate = Map<String, dynamic>.from(item);
                return '${candidate['id'] ?? ''}' == taskId &&
                    candidate['status'] == 'accepted' &&
                    (candidate['isOwnedByCurrentExecutor'] == true ||
                        candidate['isAssignedToCurrentExecutor'] == true ||
                        '${candidate['operatorId'] ?? ''}' ==
                            currentExecutorId);
              });
          if (acceptedByMe) {
            if (mounted) {
              showSnack(
                context,
                'تم قبول العملية بالفعل وأصبحت في قائمة تنفيذك.',
              );
            }
            await _load();
            return;
          }
        } catch (_) {
          // Keep the original server error if the confirmation request fails.
        }
      }
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
        if (_syncError != null) ...[
          Material(
            color: _danger.withValues(alpha: 0.10),
            borderRadius: BorderRadius.circular(8),
            child: InkWell(
              borderRadius: BorderRadius.circular(8),
              onTap: () => _load(),
              child: Padding(
                padding: const EdgeInsets.all(11),
                child: Row(
                  children: [
                    const Icon(Icons.sync_problem_outlined, color: _danger),
                    const SizedBox(width: 8),
                    Expanded(child: Text(_syncError!)),
                    const Icon(Icons.refresh_rounded, color: _danger),
                  ],
                ),
              ),
            ),
          ),
          const SizedBox(height: 10),
        ],
        ExecutorTaskCommandHeader(
          taskCount: _tasks.length,
          lastUpdated: _lastUpdated,
          manualRouting: _manualTaskRoutingEnabled,
          managerView: canViewCompanyBalance,
        ),
        const SizedBox(height: 14),
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

class ExecutorTaskCommandHeader extends StatelessWidget {
  const ExecutorTaskCommandHeader({
    super.key,
    required this.taskCount,
    required this.lastUpdated,
    required this.manualRouting,
    required this.managerView,
  });

  final int taskCount;
  final DateTime? lastUpdated;
  final bool manualRouting;
  final bool managerView;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final time = lastUpdated == null
        ? '--:--'
        : DateFormat('h:mm a', 'ar').format(lastUpdated!);
    return ExecutorSurface(
      elevated: false,
      accent: ExecutorUiColors.jade,
      padding: const EdgeInsetsDirectional.fromSTEB(16, 14, 14, 14),
      child: LayoutBuilder(
        builder: (context, constraints) {
          final compact = constraints.maxWidth < 440;
          final status = Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.circle, color: ExecutorUiColors.jade, size: 9),
              const SizedBox(width: 6),
              Text(
                'متصل',
                style: TextStyle(
                  color: colors.onSurface,
                  fontWeight: FontWeight.w900,
                  fontSize: 12,
                ),
              ),
              const SizedBox(width: 10),
              Text(
                'آخر تحديث $time',
                style: TextStyle(color: colors.onSurfaceVariant, fontSize: 11),
              ),
            ],
          );
          final queue = Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              ExecutorMetalIcon(
                icon: taskCount == 0
                    ? Icons.notifications_none_rounded
                    : Icons.assignment_turned_in_outlined,
                color: taskCount == 0
                    ? ExecutorUiColors.jade
                    : ExecutorUiColors.cobalt,
                size: 42,
                selected: taskCount > 0,
              ),
              const SizedBox(width: 10),
              Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    taskCount == 0 ? 'قائمة الانتظار فارغة' : '$taskCount مهمة',
                    style: TextStyle(
                      color: colors.onSurface,
                      fontWeight: FontWeight.w900,
                    ),
                  ),
                  if (managerView)
                    Text(
                      manualRouting
                          ? 'التوجيه اليدوي مفعل'
                          : 'السحب المباشر مفعل',
                      style: TextStyle(
                        color: colors.onSurfaceVariant,
                        fontSize: 11,
                      ),
                    ),
                ],
              ),
            ],
          );
          if (compact) {
            return Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [queue, const SizedBox(height: 12), status],
            );
          }
          return Row(
            children: [
              Expanded(child: queue),
              status,
            ],
          );
        },
      ),
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

class ExecutorLiveQueueCard extends StatelessWidget {
  const ExecutorLiveQueueCard({
    super.key,
    required this.title,
    required this.message,
  });

  final String title;
  final String message;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 620),
        child: ExecutorSurface(
          accent: ExecutorUiColors.cobalt,
          padding: const EdgeInsetsDirectional.fromSTEB(20, 18, 20, 22),
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: 430),
            child: Column(
              children: [
                const ExecutorSectionHeading(
                  title: 'المراقبة المباشرة نشطة',
                  subtitle: 'اتصال مباشر وآمن بخادم العمليات',
                  icon: Icons.sensors_rounded,
                  trailing: StatusPill(
                    label: 'متصل',
                    color: ExecutorUiColors.jade,
                  ),
                ),
                const SizedBox(height: 10),
                ExecutorLiveHalo(
                  size: 248,
                  child: Image.asset(
                    'assets/images/executor-live-bell.png',
                    height: 212,
                    fit: BoxFit.contain,
                    filterQuality: FilterQuality.high,
                  ),
                ),
                Text(
                  title,
                  textAlign: TextAlign.center,
                  style: TextStyle(
                    color: colors.onSurface,
                    fontSize: 21,
                    fontWeight: FontWeight.w900,
                  ),
                ),
                const SizedBox(height: 7),
                Text(
                  message,
                  textAlign: TextAlign.center,
                  style: TextStyle(
                    color: colors.onSurfaceVariant,
                    height: 1.45,
                    fontSize: 13,
                  ),
                ),
                const SizedBox(height: 16),
                Container(
                  width: double.infinity,
                  padding: const EdgeInsets.symmetric(
                    horizontal: 13,
                    vertical: 11,
                  ),
                  decoration: BoxDecoration(
                    color: ExecutorUiColors.cobalt.withValues(alpha: 0.08),
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(
                      color: ExecutorUiColors.cobalt.withValues(alpha: 0.18),
                    ),
                  ),
                  child: Row(
                    children: [
                      const Icon(
                        Icons.notifications_active_outlined,
                        color: ExecutorUiColors.cobalt,
                        size: 20,
                      ),
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
          ),
        ),
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
    return ExecutorSurface(
      elevated: false,
      padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 15),
      child: Row(
        children: [
          const ExecutorMetalIcon(
            icon: Icons.support_agent_outlined,
            color: ExecutorUiColors.jade,
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
                Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const Icon(
                      Icons.circle,
                      color: ExecutorUiColors.jade,
                      size: 9,
                    ),
                    const SizedBox(width: 5),
                    Text(
                      'متصل',
                      style: TextStyle(
                        color: colors.onSurface,
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
          const ExecutorMetalIcon(
            icon: Icons.schedule_outlined,
            color: ExecutorUiColors.cobalt,
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
    return ExecutorSurface(
      accent: ExecutorUiColors.coral,
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              ExecutorLiveHalo(
                size: 58,
                color: ExecutorUiColors.coral,
                child: ExecutorMetalIcon(
                  icon: alarmPlaying
                      ? Icons.notifications_active_outlined
                      : Icons.notifications_paused_outlined,
                  color: ExecutorUiColors.coral,
                  size: 46,
                  selected: alarmPlaying,
                ),
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
      icon: const ExecutorLiveHalo(
        size: 92,
        color: ExecutorUiColors.coral,
        child: ExecutorMetalIcon(
          icon: Icons.notification_important_rounded,
          color: ExecutorUiColors.coral,
          size: 62,
          selected: true,
        ),
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

enum _ExecutorReportPeriodMode { day, month, range }

enum _ExecutorReportTab {
  summary,
  operations,
  deposits,
  cancelled,
  reconciliation,
}

class _ExecutorReportsScreenState extends State<ExecutorReportsScreen>
    with WidgetsBindingObserver {
  Map<String, dynamic>? _report;
  Object? _error;
  bool _loading = true;
  bool _downloading = false;
  String? _syncError;
  DateTime? _lastUpdated;
  _ExecutorReportPeriodMode _periodMode = _ExecutorReportPeriodMode.day;
  _ExecutorReportTab _tab = _ExecutorReportTab.summary;
  DateTime _selectedDate = DateTime.now();
  late DateTimeRange _selectedRange;

  bool get _operatorOnly => widget.controller.isExecutorOperator;

  String get _dateType => switch (_periodMode) {
    _ExecutorReportPeriodMode.day => 'day',
    _ExecutorReportPeriodMode.month => 'month',
    _ExecutorReportPeriodMode.range => 'range',
  };

  String get _dateValue => switch (_periodMode) {
    _ExecutorReportPeriodMode.day => DateFormat(
      'yyyy-MM-dd',
    ).format(_selectedDate),
    _ExecutorReportPeriodMode.month => DateFormat(
      'yyyy-MM',
    ).format(_selectedDate),
    _ExecutorReportPeriodMode.range => '',
  };

  String? get _dateFrom => _periodMode == _ExecutorReportPeriodMode.range
      ? DateFormat('yyyy-MM-dd').format(_selectedRange.start)
      : null;

  String? get _dateTo => _periodMode == _ExecutorReportPeriodMode.range
      ? DateFormat('yyyy-MM-dd').format(_selectedRange.end)
      : null;

  String get _periodButtonLabel => switch (_periodMode) {
    _ExecutorReportPeriodMode.day => _dateValue,
    _ExecutorReportPeriodMode.month => _dateValue,
    _ExecutorReportPeriodMode.range => '$_dateFrom ← $_dateTo',
  };

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    final now = DateTime.now();
    _selectedRange = DateTimeRange(
      start: DateTime(now.year, now.month, 1),
      end: now,
    );
    _load();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed && _report != null) {
      unawaited(_load(silent: true));
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
      final response = await widget.controller.api.executorReports(
        dateType: _dateType,
        dateValue: _dateValue,
        dateFrom: _dateFrom,
        dateTo: _dateTo,
        employeeId: widget.employeeId,
      );
      final data = response['data'];
      if (data is! Map) {
        throw const ApiFailure('تعذر قراءة بيانات تقرير التنفيذ من الخادم.');
      }
      if (mounted) {
        setState(() {
          _report = Map<String, dynamic>.from(data);
          _syncError = null;
          _lastUpdated = DateTime.now();
        });
      }
    } catch (error) {
      if (mounted) {
        setState(() {
          if (!silent || _report == null) _error = error;
          _syncError = 'تعذر تحديث التقرير الآن. اضغط هنا لإعادة المحاولة.';
        });
      }
    } finally {
      if (!silent && mounted) setState(() => _loading = false);
    }
  }

  Future<void> _pickPeriod() async {
    if (_periodMode == _ExecutorReportPeriodMode.range) {
      final result = await showDateRangePicker(
        context: context,
        initialDateRange: _selectedRange,
        firstDate: DateTime(2024),
        lastDate: DateTime.now(),
        helpText: 'اختر فترة التقرير',
        saveText: 'اعتماد الفترة',
      );
      if (result != null && mounted) {
        setState(() => _selectedRange = result);
        await _load();
      }
      return;
    }
    final result = await showDatePicker(
      context: context,
      initialDate: _selectedDate,
      firstDate: DateTime(2024),
      lastDate: DateTime.now(),
      helpText: _periodMode == _ExecutorReportPeriodMode.month
          ? 'اختر أي يوم من الشهر'
          : 'اختر اليوم',
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
        dateType: _dateType,
        dateValue: _dateValue,
        dateFrom: _dateFrom,
        dateTo: _dateTo,
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

  List<Map<String, dynamic>> _rows(String key) {
    final value = _report?[key];
    if (value is! List) return <Map<String, dynamic>>[];
    return value
        .whereType<Map>()
        .map((item) => Map<String, dynamic>.from(item))
        .toList();
  }

  Map<String, dynamic> _map(String key) {
    final value = _report?[key];
    return value is Map
        ? Map<String, dynamic>.from(value)
        : <String, dynamic>{};
  }

  List<_ExecutorReportTab> _availableTabs(bool canReconcile) =>
      <_ExecutorReportTab>[
        _ExecutorReportTab.summary,
        _ExecutorReportTab.operations,
        _ExecutorReportTab.deposits,
        _ExecutorReportTab.cancelled,
        if (canReconcile) _ExecutorReportTab.reconciliation,
      ];

  Widget _tabButton(_ExecutorReportTab tab, int count) {
    final selected = _tab == tab;
    final color = switch (tab) {
      _ExecutorReportTab.summary => AhramColors.sky,
      _ExecutorReportTab.operations => _green,
      _ExecutorReportTab.deposits => ExecutorUiColors.jade,
      _ExecutorReportTab.cancelled => _danger,
      _ExecutorReportTab.reconciliation => _gold,
    };
    final label = switch (tab) {
      _ExecutorReportTab.summary => 'الملخص',
      _ExecutorReportTab.operations => 'العمليات',
      _ExecutorReportTab.deposits => 'الإيداعات',
      _ExecutorReportTab.cancelled => 'الملغاة',
      _ExecutorReportTab.reconciliation => 'التسوية',
    };
    final icon = switch (tab) {
      _ExecutorReportTab.summary => Icons.dashboard_outlined,
      _ExecutorReportTab.operations => Icons.receipt_long_outlined,
      _ExecutorReportTab.deposits => Icons.account_balance_wallet_outlined,
      _ExecutorReportTab.cancelled => Icons.cancel_outlined,
      _ExecutorReportTab.reconciliation => Icons.balance_outlined,
    };
    return Padding(
      padding: const EdgeInsetsDirectional.only(end: 8),
      child: ChoiceChip(
        selected: selected,
        onSelected: (_) => setState(() => _tab = tab),
        avatar: Icon(icon, size: 18, color: selected ? color : null),
        label: Text(count > 0 ? '$label  $count' : label),
        side: BorderSide(
          color: color.withValues(alpha: selected ? 0.45 : 0.18),
        ),
        selectedColor: color.withValues(alpha: 0.12),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(7)),
      ),
    );
  }

  Widget _periodChoice(
    _ExecutorReportPeriodMode mode,
    String label,
    IconData icon,
  ) {
    final selected = _periodMode == mode;
    return ChoiceChip(
      selected: selected,
      avatar: Icon(icon, size: 17),
      label: Text(label),
      onSelected: (_) async {
        if (_periodMode == mode) return;
        setState(() => _periodMode = mode);
        await _load();
      },
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(7)),
    );
  }

  Widget _operationsTab({
    required List<Map<String, dynamic>> operations,
    required List<Map<String, dynamic>> pending,
    required bool personal,
    required bool canViewEvidence,
  }) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (pending.isNotEmpty) ...[
          const SectionTitle(
            title: 'عمليات جارية',
            icon: Icons.hourglass_top_outlined,
            color: Color(0xFF1976D2),
          ),
          const SizedBox(height: 8),
          ...pending.map(
            (operation) => Padding(
              padding: const EdgeInsets.only(bottom: 9),
              child: ExecutorReportOperationTile(
                operation: operation,
                onTap: canViewEvidence
                    ? () => _openReportOperation(operation, canViewEvidence)
                    : null,
              ),
            ),
          ),
          const SizedBox(height: 12),
        ],
        const SectionTitle(
          title: 'العمليات الناجحة',
          icon: Icons.task_alt_outlined,
          color: _green,
        ),
        const SizedBox(height: 8),
        if (operations.isEmpty)
          EmptyPanel(
            icon: Icons.receipt_long_outlined,
            title: 'لا توجد عمليات ناجحة',
            message: personal
                ? 'لا توجد عمليات منفذة على حسابك في هذه الفترة.'
                : 'لم تسجل شركة التنفيذ عمليات ناجحة في هذه الفترة.',
          )
        else
          ...operations.map(
            (operation) => Padding(
              padding: const EdgeInsets.only(bottom: 9),
              child: ExecutorReportOperationTile(
                operation: operation,
                onTap: canViewEvidence
                    ? () => _openReportOperation(operation, canViewEvidence)
                    : null,
              ),
            ),
          ),
      ],
    );
  }

  Widget _cancelledTab(
    List<Map<String, dynamic>> cancelled, {
    required bool canViewEvidence,
  }) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Container(
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            color: _danger.withValues(alpha: 0.07),
            borderRadius: BorderRadius.circular(7),
            border: Border.all(color: _danger.withValues(alpha: 0.2)),
          ),
          child: const Text(
            'هذا القسم مستقل للمراجعة ولا تدخل عملياته ضمن الإجماليات المالية.',
            style: TextStyle(fontSize: 12, fontWeight: FontWeight.w700),
          ),
        ),
        const SizedBox(height: 12),
        if (cancelled.isEmpty)
          const EmptyPanel(
            icon: Icons.verified_outlined,
            title: 'لا توجد عمليات ملغاة',
            message: 'لم تسجل عمليات ملغاة أو مرفوضة في هذه الفترة.',
          )
        else
          ...cancelled.map(
            (operation) => Padding(
              padding: const EdgeInsets.only(bottom: 9),
              child: ExecutorReportOperationTile(
                operation: operation,
                cancelled: true,
                onTap: canViewEvidence
                    ? () => _openReportOperation(operation, canViewEvidence)
                    : null,
              ),
            ),
          ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    if (_loading && _report == null) return const PageLoading();
    if (_error != null && _report == null) {
      return ErrorPage(error: _error!, onRetry: _load);
    }

    final report = _report ?? <String, dynamic>{};
    final operations = _rows('operations');
    final pendingOperations = _rows('pendingOperations');
    final cancelledOperations = _rows('cancelledOperations');
    final deposits = _rows('deposits');
    final capabilities = _map('capabilities');
    final personal = report['scope'] == 'employee';
    final canReconcile = capabilities['canViewReconciliation'] == true;
    final canViewTeam = capabilities['canViewTeamPerformance'] == true;
    final canViewEvidence = report['role'] == 'manager';
    final availableTabs = _availableTabs(canReconcile);
    final activeTab = availableTabs.contains(_tab)
        ? _tab
        : _ExecutorReportTab.summary;
    final period = report['reportPeriod'];
    final periodValue = period is Map
        ? '${period['value'] ?? _periodButtonLabel}'
        : _periodButtonLabel;
    final title = widget.employeeName == null
        ? (_operatorOnly ? 'تقاريري' : 'تقارير التنفيذ')
        : 'تقرير ${widget.employeeName}';
    final subtitle = personal
        ? 'تقرير شخصي محمي يعرض عمليات صاحب الحساب فقط.'
        : widget.controller.isExecutorAccountant
        ? 'تسوية مالية وقراءة دقيقة لحساب شركة التنفيذ.'
        : 'متابعة أداء شركة التنفيذ والموظفين من شاشة واحدة.';

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
        if (_syncError != null) ...[
          Material(
            color: _danger.withValues(alpha: 0.10),
            borderRadius: BorderRadius.circular(8),
            child: InkWell(
              borderRadius: BorderRadius.circular(8),
              onTap: _load,
              child: Padding(
                padding: const EdgeInsets.all(11),
                child: Row(
                  children: [
                    const Icon(Icons.sync_problem_outlined, color: _danger),
                    const SizedBox(width: 8),
                    Expanded(child: Text(_syncError!)),
                    const Icon(Icons.refresh_rounded, color: _danger),
                  ],
                ),
              ),
            ),
          ),
          const SizedBox(height: 10),
        ],
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
                spacing: 8,
                runSpacing: 8,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: [
                  _periodChoice(
                    _ExecutorReportPeriodMode.day,
                    'يوم',
                    Icons.today_outlined,
                  ),
                  _periodChoice(
                    _ExecutorReportPeriodMode.month,
                    'شهر',
                    Icons.calendar_month_outlined,
                  ),
                  _periodChoice(
                    _ExecutorReportPeriodMode.range,
                    'فترة',
                    Icons.date_range_outlined,
                  ),
                  OutlinedButton.icon(
                    onPressed: _pickPeriod,
                    icon: const Icon(Icons.date_range_outlined),
                    label: Text(
                      periodValue,
                      textDirection: ui.TextDirection.ltr,
                    ),
                  ),
                ],
              ),
              if (_lastUpdated != null) ...[
                const SizedBox(height: 9),
                Text(
                  'آخر تحديث ${DateFormat('h:mm a', 'ar').format(_lastUpdated!)}',
                  style: Theme.of(context).textTheme.bodySmall,
                ),
              ],
            ],
          ),
        ),
        if (_loading) ...[
          const SizedBox(height: 8),
          const LinearProgressIndicator(minHeight: 2),
        ],
        const SizedBox(height: 14),
        SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          child: Row(
            children: availableTabs.map((tab) {
              final count = switch (tab) {
                _ExecutorReportTab.operations =>
                  operations.length + pendingOperations.length,
                _ExecutorReportTab.deposits => deposits.length,
                _ExecutorReportTab.cancelled => cancelledOperations.length,
                _ => 0,
              };
              return _tabButton(tab, count);
            }).toList(),
          ),
        ),
        const SizedBox(height: 16),
        if (activeTab == _ExecutorReportTab.summary) ...[
          ExecutorReportSummary(
            report: report,
            personalView: personal,
            accountantView: widget.controller.isExecutorAccountant,
          ),
          if (canViewTeam) ...[
            const SizedBox(height: 20),
            ExecutorTeamPerformancePanel(
              rows: _rows('teamPerformance'),
              controller: widget.controller,
            ),
          ],
        ] else if (activeTab == _ExecutorReportTab.operations)
          _operationsTab(
            operations: operations,
            pending: pendingOperations,
            personal: personal,
            canViewEvidence: canViewEvidence,
          )
        else if (activeTab == _ExecutorReportTab.deposits)
          ExecutorDepositReportPanel(deposits: deposits)
        else if (activeTab == _ExecutorReportTab.cancelled)
          _cancelledTab(cancelledOperations, canViewEvidence: canViewEvidence)
        else
          ExecutorReconciliationPanel(
            summary: _map('financialSummary'),
            deposits: deposits,
          ),
      ],
    );
  }

  Future<void> _openReportOperation(
    Map<String, dynamic> operation,
    bool canViewEvidence,
  ) async {
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (_) => ExecutorReportOperationSheet(
        operation: operation,
        api: widget.controller.api,
        canViewEvidence: canViewEvidence,
      ),
    );
  }
}

class ExecutorReportSummary extends StatelessWidget {
  const ExecutorReportSummary({
    super.key,
    required this.report,
    required this.personalView,
    required this.accountantView,
  });

  final Map<String, dynamic> report;
  final bool personalView;
  final bool accountantView;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final tiles = <Widget>[];

    final summary = report['summary'] is Map
        ? Map<String, dynamic>.from(report['summary'] as Map)
        : <String, dynamic>{};
    final financial = report['financialSummary'] is Map
        ? Map<String, dynamic>.from(report['financialSummary'] as Map)
        : <String, dynamic>{};
    if (personalView) {
      return Wrap(
        spacing: 12,
        runSpacing: 12,
        children: [
          ExecutorMetricCard(
            label: 'العمليات الناجحة',
            value: '${numberValue(summary['completedCount']).toInt()}',
            icon: Icons.receipt_long_outlined,
            color: AhramColors.sky,
          ),
          ExecutorMetricCard(
            label: 'إجمالي التنفيذ',
            value: '${formatEgpAmount(numberValue(summary['totalEGP']))} ج.م',
            icon: Icons.payments_outlined,
            color: _green,
            valueColor: _green,
          ),
          ExecutorMetricCard(
            label: 'متوسط مدة التنفيذ',
            value: formatExecutionDuration(summary['averageDurationSeconds']),
            icon: Icons.timer_outlined,
            color: const Color(0xFF1976D2),
          ),
          ExecutorMetricCard(
            label: 'العمليات الملغاة',
            value: '${numberValue(summary['cancelledCount']).toInt()}',
            icon: Icons.cancel_outlined,
            color: _danger,
            valueColor: _danger,
          ),
        ],
      );
    }

    if (accountantView && financial.isNotEmpty) {
      return Wrap(
        spacing: 12,
        runSpacing: 12,
        children: [
          ExecutorMetricCard(
            label: 'الرصيد الافتتاحي',
            value:
                '${formatEgpAmount(numberValue(financial['openingBalance']))} ج.م',
            icon: Icons.account_balance_wallet_outlined,
            color: AhramColors.sky,
          ),
          ExecutorMetricCard(
            label: 'الإضافات',
            value:
                '${formatEgpAmount(numberValue(financial['additions']))} ج.م',
            icon: Icons.add_circle_outline,
            color: _green,
            valueColor: _green,
          ),
          ExecutorMetricCard(
            label: 'الخصومات',
            value:
                '${formatEgpAmount(numberValue(financial['deductions']))} ج.م',
            icon: Icons.remove_circle_outline,
            color: _danger,
            valueColor: _danger,
          ),
          ExecutorMetricCard(
            label: 'إجمالي التنفيذ',
            value:
                '${formatEgpAmount(numberValue(financial['executedAmount']))} ج.م',
            icon: Icons.payments_outlined,
            color: _gold,
          ),
          ExecutorMetricCard(
            label: 'الرصيد الختامي',
            value:
                '${formatEgpAmount(numberValue(financial['closingBalance']))} ج.م',
            icon: Icons.fact_check_outlined,
            color: colors.primary,
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
        label: 'العمليات الناجحة',
        value: '${numberValue(summary['completedCount']).toInt()}',
        icon: Icons.receipt_long_outlined,
        color: AhramColors.sky,
      ),
      ExecutorMetricCard(
        label: 'إجمالي التنفيذ',
        value: '${formatEgpAmount(numberValue(summary['totalEGP']))} ج.م',
        icon: Icons.payments_outlined,
        color: _green,
        valueColor: _green,
      ),
      ExecutorMetricCard(
        label: 'الرصيد السابق',
        value: '${formatEgpAmount(previousBalance)} ج.م',
        icon: Icons.history_outlined,
        color: balanceColor(previousBalance),
        valueColor: balanceColor(previousBalance),
      ),
      ExecutorMetricCard(
        label: 'صافي الفترة',
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
      ExecutorMetricCard(
        label: 'قيد التنفيذ',
        value: '${numberValue(summary['pendingCount']).toInt()}',
        icon: Icons.hourglass_top_outlined,
        color: const Color(0xFF1976D2),
      ),
      ExecutorMetricCard(
        label: 'الملغاة',
        value: '${numberValue(summary['cancelledCount']).toInt()}',
        icon: Icons.cancel_outlined,
        color: _danger,
        valueColor: _danger,
      ),
    ]);

    return Wrap(spacing: 12, runSpacing: 12, children: tiles);
  }
}

class ExecutorTeamPerformancePanel extends StatelessWidget {
  const ExecutorTeamPerformancePanel({
    super.key,
    required this.rows,
    required this.controller,
  });

  final List<Map<String, dynamic>> rows;
  final SessionController controller;

  void _openEmployeeReport(
    BuildContext context,
    Map<String, dynamic> employee,
  ) {
    final id = '${employee['employeeId'] ?? ''}'.trim();
    if (id.isEmpty) return;
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => Scaffold(
          appBar: AppBar(
            title: Text('تقرير ${employee['employeeName'] ?? 'الموظف'}'),
          ),
          body: ExecutorReportsScreen(
            controller: controller,
            employeeId: id,
            employeeName: '${employee['employeeName'] ?? 'الموظف'}',
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const SectionTitle(
          title: 'أداء فريق التنفيذ',
          icon: Icons.groups_2_outlined,
          color: Color(0xFF7A57D1),
        ),
        const SizedBox(height: 6),
        Text(
          'ترتيب الموظفين وفق العمليات الناجحة في الفترة المحددة.',
          style: TextStyle(color: colors.onSurfaceVariant, fontSize: 12),
        ),
        const SizedBox(height: 10),
        if (rows.isEmpty)
          const EmptyPanel(
            icon: Icons.query_stats_outlined,
            title: 'لا توجد بيانات أداء',
            message: 'يظهر ترتيب الموظفين بعد تنفيذ أول عملية في الفترة.',
          )
        else
          ...rows.asMap().entries.map((entry) {
            final rank = entry.key + 1;
            final row = entry.value;
            return Padding(
              padding: const EdgeInsets.only(bottom: 9),
              child: InkWell(
                onTap: () => _openEmployeeReport(context, row),
                borderRadius: BorderRadius.circular(8),
                child: Container(
                  padding: const EdgeInsets.all(13),
                  decoration: BoxDecoration(
                    color: colors.surface,
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(
                      color: const Color(0xFF7A57D1).withValues(alpha: 0.2),
                    ),
                  ),
                  child: Row(
                    children: [
                      CircleAvatar(
                        radius: 20,
                        backgroundColor: rank == 1
                            ? _gold.withValues(alpha: 0.18)
                            : colors.surfaceContainerHighest,
                        child: Text(
                          '$rank',
                          style: TextStyle(
                            fontWeight: FontWeight.w900,
                            color: rank == 1 ? const Color(0xFF8A6200) : null,
                          ),
                        ),
                      ),
                      const SizedBox(width: 11),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              '${row['employeeName'] ?? 'منفذ'}',
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(
                                fontWeight: FontWeight.w900,
                              ),
                            ),
                            const SizedBox(height: 4),
                            Text(
                              '${numberValue(row['completedCount']).toInt()} ناجحة · ${numberValue(row['cancelledCount']).toInt()} ملغاة · ${formatExecutionDuration(row['averageDurationSeconds'])}',
                              style: TextStyle(
                                color: colors.onSurfaceVariant,
                                fontSize: 11,
                              ),
                            ),
                          ],
                        ),
                      ),
                      const SizedBox(width: 8),
                      Column(
                        crossAxisAlignment: CrossAxisAlignment.end,
                        children: [
                          Text(
                            '${formatEgpAmount(numberValue(row['totalEGP']))} ج.م',
                            textDirection: ui.TextDirection.ltr,
                            style: const TextStyle(
                              color: _green,
                              fontWeight: FontWeight.w900,
                            ),
                          ),
                          const SizedBox(height: 3),
                          Icon(
                            Icons.arrow_forward_ios_rounded,
                            size: 13,
                            color: colors.onSurfaceVariant,
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
              ),
            );
          }),
      ],
    );
  }
}

class ExecutorDepositReportPanel extends StatelessWidget {
  const ExecutorDepositReportPanel({super.key, required this.deposits});

  final List<Map<String, dynamic>> deposits;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    if (deposits.isEmpty) {
      return const EmptyPanel(
        icon: Icons.account_balance_wallet_outlined,
        title: 'لا توجد إيداعات في هذه الفترة',
        message: 'ستظهر الإيداعات والخصومات بعد تسجيلها أو اعتمادها.',
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const SectionTitle(
          title: 'الإيداعات والخصومات',
          icon: Icons.account_balance_wallet_outlined,
          color: ExecutorUiColors.jade,
        ),
        const SizedBox(height: 8),
        ...deposits.map((item) {
          final status = '${item['status'] ?? ''}';
          final pending = status == 'deposit_pending';
          final deduction = status == 'deduction';
          final color = pending
              ? ExecutorUiColors.amber
              : (deduction ? ExecutorUiColors.coral : ExecutorUiColors.jade);
          final label = pending
              ? 'إيداع قيد المراجعة'
              : (deduction ? 'خصم إداري' : 'إيداع معتمد');
          return Padding(
            padding: const EdgeInsets.only(bottom: 10),
            child: ExecutorSurface(
              accent: color,
              child: Row(
                children: [
                  ExecutorMetalIcon(
                    icon: pending
                        ? Icons.pending_actions_outlined
                        : (deduction
                              ? Icons.remove_circle_outline
                              : Icons.add_circle_outline),
                    color: color,
                    size: 42,
                    selected: true,
                  ),
                  const SizedBox(width: 11),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          label,
                          style: const TextStyle(fontWeight: FontWeight.w900),
                        ),
                        const SizedBox(height: 3),
                        Text(
                          '${item['customId'] ?? '---'} · ${formatDate(item['createdAt'])}',
                          style: TextStyle(
                            color: colors.onSurfaceVariant,
                            fontSize: 11,
                          ),
                        ),
                        if ('${item['notes'] ?? ''}'.trim().isNotEmpty) ...[
                          const SizedBox(height: 3),
                          Text(
                            '${item['notes']}',
                            maxLines: 2,
                            overflow: TextOverflow.ellipsis,
                          ),
                        ],
                      ],
                    ),
                  ),
                  Text(
                    '${deduction ? '-' : '+'}${formatEgpAmount(numberValue(item['amount']))} ج.م',
                    textDirection: ui.TextDirection.ltr,
                    style: TextStyle(color: color, fontWeight: FontWeight.w900),
                  ),
                ],
              ),
            ),
          );
        }),
      ],
    );
  }
}

class ExecutorReconciliationPanel extends StatelessWidget {
  const ExecutorReconciliationPanel({
    super.key,
    required this.summary,
    required this.deposits,
  });

  final Map<String, dynamic> summary;
  final List<Map<String, dynamic>> deposits;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final opening = numberValue(summary['openingBalance']);
    final additions = numberValue(summary['additions']);
    final deductions = numberValue(summary['deductions']);
    final executed = numberValue(summary['executedAmount']);
    final net = numberValue(summary['netMovement']);
    final closing = numberValue(summary['closingBalance']);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        SurfacePanel(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const SectionTitle(
                title: 'معادلة التسوية المالية',
                icon: Icons.balance_outlined,
                color: _gold,
              ),
              const SizedBox(height: 14),
              ExecutorReconciliationRow(
                label: 'الرصيد الافتتاحي',
                value: opening,
                color: colors.onSurface,
              ),
              ExecutorReconciliationRow(
                label: 'إضافات الرصيد',
                value: additions,
                color: _green,
                prefix: '+',
              ),
              ExecutorReconciliationRow(
                label: 'خصومات إدارية',
                value: deductions,
                color: _danger,
                prefix: '-',
              ),
              ExecutorReconciliationRow(
                label: 'عمليات منفذة',
                value: executed,
                color: const Color(0xFF1976D2),
                prefix: '-',
              ),
              const Divider(height: 20),
              ExecutorReconciliationRow(
                label: 'صافي حركة الفترة',
                value: net,
                color: net < 0 ? _danger : _green,
                bold: true,
              ),
              ExecutorReconciliationRow(
                label: 'الرصيد الختامي',
                value: closing,
                color: closing < 0 ? _green : _danger,
                bold: true,
              ),
            ],
          ),
        ),
        const SizedBox(height: 18),
        const SectionTitle(
          title: 'الإيداعات والخصومات',
          icon: Icons.account_balance_outlined,
          color: AhramColors.sky,
        ),
        const SizedBox(height: 8),
        if (deposits.isEmpty)
          const EmptyPanel(
            icon: Icons.account_balance_wallet_outlined,
            title: 'لا توجد حركات رصيد',
            message: 'لا توجد إيداعات أو خصومات خلال الفترة المحددة.',
          )
        else
          ...deposits.map((item) {
            final deduction = item['status'] == 'deduction';
            final pending = item['status'] == 'deposit_pending';
            final color = pending
                ? const Color(0xFF8A6200)
                : deduction
                ? _danger
                : _green;
            return Padding(
              padding: const EdgeInsets.only(bottom: 9),
              child: SurfacePanel(
                child: Row(
                  children: [
                    GlassIconBadge(
                      icon: deduction
                          ? Icons.remove_circle_outline
                          : pending
                          ? Icons.schedule_outlined
                          : Icons.add_circle_outline,
                      color: color,
                      size: 42,
                    ),
                    const SizedBox(width: 11),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            pending
                                ? 'إيداع قيد الاعتماد'
                                : deduction
                                ? 'خصم'
                                : 'إيداع',
                            style: const TextStyle(fontWeight: FontWeight.w900),
                          ),
                          Text(
                            '${item['customId'] ?? '-'} · ${formatDate(item['createdAt'])}',
                            style: TextStyle(
                              color: colors.onSurfaceVariant,
                              fontSize: 11,
                            ),
                          ),
                        ],
                      ),
                    ),
                    Text(
                      '${deduction ? '-' : '+'}${formatEgpAmount(numberValue(item['amount']))} ج.م',
                      textDirection: ui.TextDirection.ltr,
                      style: TextStyle(
                        color: color,
                        fontWeight: FontWeight.w900,
                      ),
                    ),
                  ],
                ),
              ),
            );
          }),
      ],
    );
  }
}

class ExecutorReconciliationRow extends StatelessWidget {
  const ExecutorReconciliationRow({
    super.key,
    required this.label,
    required this.value,
    required this.color,
    this.prefix = '',
    this.bold = false,
  });

  final String label;
  final double value;
  final Color color;
  final String prefix;
  final bool bold;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 5),
      child: Row(
        children: [
          Expanded(
            child: Text(
              label,
              style: TextStyle(fontWeight: bold ? FontWeight.w900 : null),
            ),
          ),
          Text(
            '$prefix${formatEgpAmount(value)} ج.م',
            textDirection: ui.TextDirection.ltr,
            style: TextStyle(
              color: color,
              fontWeight: bold ? FontWeight.w900 : FontWeight.w700,
            ),
          ),
        ],
      ),
    );
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
      width: 156,
      height: 112,
      child: ExecutorSurface(
        padding: const EdgeInsets.all(12),
        accent: color,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                ExecutorMetalIcon(icon: icon, color: color, size: 34),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    label,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      height: 1.35,
                      fontSize: 11,
                      color: colors.onSurfaceVariant,
                    ),
                  ),
                ),
              ],
            ),
            const Spacer(),
            Align(
              alignment: AlignmentDirectional.centerStart,
              child: FittedBox(
                fit: BoxFit.scaleDown,
                alignment: AlignmentDirectional.centerStart,
                child: Text(
                  value,
                  textDirection: ui.TextDirection.ltr,
                  style: TextStyle(
                    fontSize: 14,
                    fontWeight: FontWeight.w900,
                    color: valueColor ?? colors.onSurface,
                  ),
                ),
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
    this.onTap,
  });

  final Map<String, dynamic> operation;
  final bool cancelled;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final executorName = '${operation['executorName'] ?? ''}'.trim();
    final surface = ExecutorSurface(
      accent: cancelled ? ExecutorUiColors.coral : ExecutorUiColors.jade,
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
    return onTap == null
        ? surface
        : Material(
            color: Colors.transparent,
            borderRadius: BorderRadius.circular(10),
            child: InkWell(
              onTap: onTap,
              borderRadius: BorderRadius.circular(10),
              child: surface,
            ),
          );
  }
}

class ExecutorReportOperationSheet extends StatelessWidget {
  const ExecutorReportOperationSheet({
    super.key,
    required this.operation,
    required this.api,
    required this.canViewEvidence,
  });

  final Map<String, dynamic> operation;
  final MobileApi api;
  final bool canViewEvidence;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final senderEntries = operation['executorSenderEntries'] is List
        ? (operation['executorSenderEntries'] as List)
              .whereType<Map>()
              .map((entry) => Map<String, dynamic>.from(entry))
              .toList()
        : <Map<String, dynamic>>[];
    final proofCount = numberValue(operation['executorProofCount']).toInt();
    return FractionallySizedBox(
      heightFactor: 0.92,
      child: Material(
        color: colors.surface,
        borderRadius: const BorderRadius.vertical(top: Radius.circular(14)),
        child: SafeArea(
          top: false,
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(18, 12, 18, 24),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Center(
                  child: Container(
                    width: 44,
                    height: 4,
                    decoration: BoxDecoration(
                      color: colors.outlineVariant,
                      borderRadius: BorderRadius.circular(10),
                    ),
                  ),
                ),
                const SizedBox(height: 14),
                Row(
                  children: [
                    IconButton(
                      onPressed: () => Navigator.pop(context),
                      icon: const Icon(Icons.close_rounded),
                    ),
                    const Spacer(),
                    const Text(
                      'تفاصيل العملية والإيصال',
                      style: TextStyle(fontWeight: FontWeight.w900),
                    ),
                  ],
                ),
                ExecutorSurface(
                  accent: _green,
                  child: Column(
                    children: [
                      DetailLine(
                        label: 'رقم العملية',
                        value: '${operation['customId'] ?? '-'}',
                      ),
                      DetailLine(
                        label: 'المستلم',
                        value: '${operation['recipientNumber'] ?? '-'}',
                      ),
                      DetailLine(
                        label: 'القيمة',
                        value:
                            '${formatEgpAmount(numberValue(operation['amount']))} ج.م',
                      ),
                      DetailLine(
                        label: 'الحالة',
                        value: statusLabel(operation['status']?.toString()),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 14),
                const SectionTitle(
                  title: 'الإيصال الرسمي',
                  icon: Icons.receipt_long_outlined,
                  color: _green,
                ),
                const SizedBox(height: 8),
                ExecutorReportImageCard(
                  title: 'إيصال العملية',
                  future: api.executorTransactionImageBytes(
                    '${operation['id']}',
                  ),
                ),
                if (canViewEvidence) ...[
                  const SizedBox(height: 18),
                  const SectionTitle(
                    title: 'بيانات المنفذ الخاصة بالمدير',
                    icon: Icons.admin_panel_settings_outlined,
                    color: _gold,
                  ),
                  const SizedBox(height: 8),
                  ExecutorSurface(
                    accent: _gold,
                    child: Column(
                      children: [
                        DetailLine(
                          label: 'رقم التنفيذ الكامل',
                          value:
                              '${operation['executorExecutionNumber'] ?? '-'}',
                        ),
                        if (senderEntries.isEmpty)
                          const DetailLine(
                            label: 'أرقام المرسل',
                            value: 'لم تُسجل',
                          )
                        else
                          ...senderEntries.map(
                            (entry) => DetailLine(
                              label: senderEntries.length > 1
                                  ? 'رقم المرسل'
                                  : 'رقم المرسل المسجل',
                              value:
                                  '${entry['phone'] ?? '-'}${entry['amount'] == null ? '' : ' · ${formatEgpAmount(numberValue(entry['amount']))} ج.م'}',
                            ),
                          ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 10),
                  if (proofCount == 0)
                    const EmptyPanel(
                      icon: Icons.image_not_supported_outlined,
                      title: 'لا توجد صور مرفوعة من المنفذ',
                      message: 'تم حفظ الإيصال الرسمي فقط.',
                    )
                  else
                    ...List<Widget>.generate(
                      proofCount,
                      (index) => Padding(
                        padding: const EdgeInsets.only(bottom: 10),
                        child: ExecutorReportImageCard(
                          title: 'إثبات المنفذ ${index + 1}',
                          future: api.executorTransactionImageBytes(
                            '${operation['id']}',
                            source: 'executor',
                            index: index,
                          ),
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
  }
}

class ExecutorReportImageCard extends StatelessWidget {
  const ExecutorReportImageCard({
    super.key,
    required this.title,
    required this.future,
  });

  final String title;
  final Future<Uint8List> future;

  @override
  Widget build(BuildContext context) {
    return ExecutorSurface(
      accent: _green,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(title, style: const TextStyle(fontWeight: FontWeight.w900)),
          const SizedBox(height: 8),
          ClipRRect(
            borderRadius: BorderRadius.circular(8),
            child: FutureBuilder<Uint8List>(
              future: future,
              builder: (context, snapshot) {
                if (snapshot.connectionState != ConnectionState.done) {
                  return const SizedBox(
                    height: 180,
                    child: Center(child: CircularProgressIndicator()),
                  );
                }
                if (snapshot.hasError || snapshot.data == null) {
                  return const SizedBox(
                    height: 120,
                    child: Center(child: _ReceiptImageUnavailable()),
                  );
                }
                return Image.memory(
                  snapshot.data!,
                  height: 280,
                  width: double.infinity,
                  fit: BoxFit.contain,
                );
              },
            ),
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
  bool _manualTaskRoutingEnabled = false;
  bool _routingBusy = false;
  Map<String, dynamic> _pushStatus = <String, dynamic>{};
  Map<String, dynamic> _localPushDiagnostics = <String, dynamic>{};
  Object? _pushStatusError;
  bool _backgroundServiceRunning = false;
  String _pushTestCategory = 'executor_task_new';
  bool _pushBusy = false;
  bool _preferenceBusy = false;
  bool _previewBusy = false;
  Map<String, dynamic>? _mfaStatus;

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
      Map<String, dynamic>? mfaStatus;
      try {
        mfaStatus = await widget.controller.api.mfaStatus();
      } catch (_) {
        // Security has a dedicated retry action. Its status should not block
        // access to operational settings during a transient network failure.
      }
      final localPushDiagnostics = await MobilePushService.instance
          .localDiagnostics();
      final backgroundServiceRunning = await ExecutorAlertService.instance
          .isRunning();
      var manualTaskRoutingEnabled = _manualTaskRoutingEnabled;
      if (widget.controller.isExecutorManager) {
        final liveTasks = await widget.controller.api.executorLiveTasks();
        manualTaskRoutingEnabled =
            liveTasks['manualTaskRoutingEnabled'] == true;
      }
      var pushStatus = <String, dynamic>{};
      Object? pushStatusError;
      try {
        final installationId = await widget.controller.store
            .readOrCreatePushInstallationId();
        pushStatus = await widget.controller.api.pushDeviceStatus(
          installationId,
        );
      } catch (error) {
        pushStatusError = error;
      }
      if (mounted && raw is Map) {
        setState(() {
          _overview = Map<String, dynamic>.from(raw);
          _manualTaskRoutingEnabled = manualTaskRoutingEnabled;
          _pushStatus = pushStatus;
          _pushStatusError = pushStatusError;
          _localPushDiagnostics = localPushDiagnostics;
          _backgroundServiceRunning = backgroundServiceRunning;
          _mfaStatus = mfaStatus;
        });
      }
    } catch (error) {
      if (mounted) setState(() => _error = error);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _showSecuritySessions() => showDialog<void>(
    context: context,
    builder: (context) => _CustomerDevicesDialog(controller: widget.controller),
  );

  Future<void> _manageAuthenticator() async {
    await showDialog<void>(
      context: context,
      builder: (context) => _AuthenticatorDialog(controller: widget.controller),
    );
    if (mounted) await _load();
  }

  Future<void> _testPushNotification() async {
    setState(() => _pushBusy = true);
    try {
      await MobilePushService.instance.requestPermissionAndRegister();
      await ExecutorAlertService.instance.startForStoredAccount();
      final localDiagnostics = await MobilePushService.instance
          .localDiagnostics();
      if (localDiagnostics['permissionEnabled'] != true) {
        if (mounted) {
          showSnack(
            context,
            'إذن الإشعارات غير مسموح. افتح إعدادات الهاتف وفعّل إشعارات Ahram Pay.',
            error: true,
          );
        }
        await _load();
        return;
      }
      if (localDiagnostics['clientConfigured'] != true) {
        await MobilePushService.instance.previewCategory(_pushTestCategory);
        if (mounted) {
          showSnack(
            context,
            'نجح تنبيه الهاتف المحلي. الإرسال السحابي والتشغيل بعد إغلاق التطبيق يحتاجان نسخة APK مرتبطة بـ Firebase.',
          );
        }
        await _load();
        return;
      }
      await MobilePushService.instance.registerStoredSession();
      final installationId = await widget.controller.store
          .readOrCreatePushInstallationId();
      await widget.controller.api.testPushDevice(
        installationId,
        category: _pushTestCategory,
      );
      if (!mounted) return;
      showSnack(context, 'تم إرسال إشعار حقيقي إلى هذا الهاتف عبر الخادم.');
      await _load();
    } on ApiFailure catch (error) {
      if (!mounted) return;
      if (error.statusCode == 404) {
        showSnack(
          context,
          'الخادم يعمل بإصدار قديم لا يحتوي مسار اختبار الإشعارات. اسحب آخر تحديث وأعد تشغيل PM2.',
          error: true,
        );
      } else if (<String>{
        'FCM_NOT_CONFIGURED',
        'MISSING_CONFIGURATION',
        'PUSH_TEST_FAILED',
      }.contains(error.code)) {
        showSnack(
          context,
          'إعداد Firebase غير مكتمل على الخادم. راجع حساب الخدمة ثم أعد تشغيل PM2.',
          error: true,
        );
      } else {
        showSnack(context, error.message, error: true);
      }
      await _load();
    } catch (_) {
      if (mounted) {
        showSnack(
          context,
          'تعذر اختبار الإشعارات. تحقق من إذن الهاتف وإعدادات Firebase.',
          error: true,
        );
      }
    } finally {
      if (mounted) setState(() => _pushBusy = false);
    }
  }

  Future<void> _previewPushSound() async {
    if (_previewBusy) return;
    setState(() => _previewBusy = true);
    try {
      await MobilePushService.instance.previewCategory(_pushTestCategory);
      if (mounted) showSnack(context, 'تم تشغيل معاينة الإشعار والنغمة.');
    } catch (_) {
      if (mounted) {
        showSnack(context, 'تعذر تشغيل المعاينة على هذا الجهاز.', error: true);
      }
    } finally {
      if (mounted) setState(() => _previewBusy = false);
    }
  }

  Future<void> _toggleAllNotifications(bool enabled) async {
    if (_preferenceBusy || _pushBusy) return;
    setState(() {
      _preferenceBusy = true;
      _pushBusy = enabled;
    });
    try {
      if (enabled) {
        await MobilePushService.instance.requestPermissionAndRegister();
        final diagnostics = await MobilePushService.instance.localDiagnostics();
        if (diagnostics['permissionEnabled'] != true) {
          throw const ApiFailure(
            'إذن إشعارات الهاتف غير مسموح. فعّله من إعدادات الهاتف ثم أعد المحاولة.',
          );
        }
        await ExecutorAlertService.instance.startForStoredAccount();
        final installationId = await widget.controller.store
            .readOrCreatePushInstallationId();
        await widget.controller.api.updatePushPreferences(
          installationId: installationId,
          preferences: Map<String, bool>.from(
            defaultMobileNotificationPreferences,
          ),
        );
      } else {
        // Remove this installation from server push delivery before stopping
        // the local monitor, so notifications are also disabled in background.
        await MobilePushService.instance.unregisterCurrentSession();
        await ExecutorAlertService.instance.stop();
      }
      if (mounted) {
        showSnack(
          context,
          enabled ? 'تم تشغيل جميع الإشعارات.' : 'تم إيقاف جميع الإشعارات.',
        );
      }
      await _load();
    } on ApiFailure catch (error) {
      if (mounted) showSnack(context, error.message, error: true);
    } catch (_) {
      if (mounted) {
        showSnack(
          context,
          enabled
              ? 'تعذر تشغيل الإشعارات. تحقق من إذن الهاتف.'
              : 'تعذر إيقاف الإشعارات حالياً.',
          error: true,
        );
      }
    } finally {
      if (mounted) {
        setState(() {
          _preferenceBusy = false;
          _pushBusy = false;
        });
      }
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
      case 'external':
        return 'موظف خارجي';
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
    final firebase = _pushStatus['firebase'] is Map
        ? Map<String, dynamic>.from(_pushStatus['firebase'] as Map)
        : <String, dynamic>{};
    final pushDevice = _pushStatus['device'] is Map
        ? Map<String, dynamic>.from(_pushStatus['device'] as Map)
        : <String, dynamic>{};
    final localPermissionEnabled =
        _localPushDiagnostics['permissionEnabled'] == true;
    final clientFirebaseConfigured =
        _localPushDiagnostics['clientConfigured'] == true;
    final serverRouteMissing =
        _pushStatusError is ApiFailure &&
        (_pushStatusError as ApiFailure).statusCode == 404;
    final cloudPushReady =
        clientFirebaseConfigured &&
        firebase['configured'] == true &&
        firebase['enabled'] == true &&
        pushDevice['enabled'] == true &&
        <String>{
          'authorized',
          'provisional',
        }.contains('${pushDevice['permissionStatus'] ?? ''}');
    final localFallbackReady =
        localPermissionEnabled && _backgroundServiceRunning;
    final notificationsReady = cloudPushReady || localFallbackReady;
    final notificationStatusLabel = cloudPushReady
        ? 'تعمل سحابيًا'
        : localFallbackReady
        ? 'تعمل محليًا'
        : 'تحتاج إعدادًا';

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
                  const ExecutorWordmark(),
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
        const SizedBox(height: 18),
        ExecutorSurface(
          accent: _mfaStatus?['enabled'] == true
              ? ExecutorUiColors.jade
              : ExecutorUiColors.amber,
          child: ListTile(
            contentPadding: EdgeInsets.zero,
            leading: ExecutorMetalIcon(
              icon: _mfaStatus?['enabled'] == true
                  ? Icons.verified_user_outlined
                  : Icons.shield_outlined,
              color: _mfaStatus?['enabled'] == true
                  ? ExecutorUiColors.jade
                  : ExecutorUiColors.amber,
              size: 42,
              selected: true,
            ),
            title: const Text(
              'حماية Authenticator',
              style: TextStyle(fontWeight: FontWeight.w900),
            ),
            subtitle: Text(
              _mfaStatus?['enabled'] == true
                  ? 'الحماية مفعّلة. إدارة الجهاز الموثوق ورموز الاسترداد من هنا.'
                  : 'الحماية غير مفعّلة — فعّل رمزًا إضافيًا لحماية حساب التنفيذ.',
            ),
            trailing: const Icon(Icons.chevron_left),
            onTap: _manageAuthenticator,
          ),
        ),
        const SizedBox(height: 18),
        ExecutorSurface(
          accent: ExecutorUiColors.cobalt,
          child: ListTile(
            contentPadding: EdgeInsets.zero,
            leading: const ExecutorMetalIcon(
              icon: Icons.devices_outlined,
              color: ExecutorUiColors.cobalt,
              size: 42,
              selected: true,
            ),
            title: const Text(
              'الأجهزة والجلسات',
              style: TextStyle(fontWeight: FontWeight.w900),
            ),
            subtitle: const Text(
              'جهاز واحد فقط للحساب؛ نقل الجهاز يتطلب Authenticator وموافقة الإدارة.',
            ),
            trailing: const Icon(Icons.chevron_left),
            onTap: _showSecuritySessions,
          ),
        ),
        const SizedBox(height: 18),
        ExecutorSurface(
          accent: notificationsReady
              ? ExecutorUiColors.jade
              : ExecutorUiColors.coral,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  ExecutorLiveHalo(
                    size: 54,
                    color: notificationsReady
                        ? ExecutorUiColors.jade
                        : ExecutorUiColors.coral,
                    child: ExecutorMetalIcon(
                      icon: notificationsReady
                          ? Icons.notifications_active_outlined
                          : Icons.notifications_off_outlined,
                      color: notificationsReady
                          ? ExecutorUiColors.jade
                          : ExecutorUiColors.coral,
                      size: 42,
                      selected: notificationsReady,
                    ),
                  ),
                  const SizedBox(width: 10),
                  const Expanded(
                    child: Text(
                      'إشعارات المهام على الهاتف',
                      style: TextStyle(fontWeight: FontWeight.w900),
                    ),
                  ),
                  StatusPill(
                    label: notificationStatusLabel,
                    color: notificationsReady ? _green : _danger,
                  ),
                ],
              ),
              const Divider(height: 28),
              DetailLine(
                label: 'إذن الهاتف',
                value: localPermissionEnabled ? 'مسموح' : 'غير مفعل',
              ),
              DetailLine(
                label: 'مراقبة الخلفية',
                value: _backgroundServiceRunning ? 'نشطة' : 'متوقفة',
              ),
              DetailLine(
                label: 'إعداد التطبيق',
                value: clientFirebaseConfigured
                    ? 'مرتبط بـ Firebase'
                    : 'نسخة APK غير مرتبطة بـ Firebase',
              ),
              DetailLine(
                label: 'اتصال الخادم',
                value: serverRouteMissing
                    ? 'إصدار الخادم قديم'
                    : firebase['configured'] == true &&
                          firebase['enabled'] == true
                    ? 'جاهز للإرسال'
                    : 'إعداد Firebase غير مكتمل',
              ),
              if (pushDevice['lastSuccessfulPushAt'] != null)
                DetailLine(
                  label: 'آخر إرسال ناجح',
                  value: formatDate(pushDevice['lastSuccessfulPushAt']),
                ),
              const SizedBox(height: 14),
              DropdownButtonFormField<String>(
                initialValue: _pushTestCategory,
                decoration: const InputDecoration(
                  labelText: 'نوع الإشعار المطلوب اختباره',
                  prefixIcon: Icon(Icons.notifications_active_outlined),
                ),
                items: mobileNotificationDefinitions.entries
                    .map(
                      (entry) => DropdownMenuItem<String>(
                        value: entry.key,
                        child: Text(entry.value.channelName),
                      ),
                    )
                    .toList(),
                onChanged: _pushBusy || _previewBusy
                    ? null
                    : (value) {
                        if (value != null) {
                          setState(() => _pushTestCategory = value);
                        }
                      },
              ),
              const SizedBox(height: 12),
              Wrap(
                spacing: 10,
                runSpacing: 10,
                children: [
                  FilledButton.icon(
                    onPressed: _pushBusy ? null : _testPushNotification,
                    icon: _pushBusy
                        ? const SizedBox.square(
                            dimension: 18,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Icon(Icons.send_to_mobile_outlined),
                    label: const Text('اختبار من الخادم'),
                  ),
                  OutlinedButton.icon(
                    onPressed: _previewBusy ? null : _previewPushSound,
                    icon: _previewBusy
                        ? const SizedBox.square(
                            dimension: 18,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Icon(Icons.volume_up_outlined),
                    label: const Text('معاينة النغمة'),
                  ),
                  OutlinedButton.icon(
                    onPressed:
                        MobilePushService.instance.openNotificationSettings,
                    icon: const Icon(Icons.tune_rounded),
                    label: const Text('إعدادات الهاتف'),
                  ),
                  OutlinedButton.icon(
                    onPressed:
                        MobilePushService.instance.openBackgroundSettings,
                    icon: const Icon(Icons.battery_saver_outlined),
                    label: const Text('تشغيل الخلفية'),
                  ),
                ],
              ),
              if (serverRouteMissing ||
                  !clientFirebaseConfigured ||
                  firebase['configured'] != true ||
                  firebase['enabled'] != true) ...[
                const SizedBox(height: 14),
                Container(
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(
                    color: _gold.withValues(alpha: 0.10),
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(color: _gold.withValues(alpha: 0.34)),
                  ),
                  child: Text(
                    serverRouteMissing
                        ? 'لم تُنشر مسارات الإشعارات الجديدة على الخادم بعد. اسحب آخر إصدار من main ثم أعد تشغيل PM2.'
                        : !clientFirebaseConfigured
                        ? 'هذه النسخة تستخدم المراقبة المحلية فقط. يلزم بناء APK بقيم مشروع Firebase لتصل التنبيهات فورًا بعد إغلاق التطبيق.'
                        : 'ربط التطبيق جاهز، لكن حساب خدمة Firebase غير مكتمل على الخادم.',
                    style: const TextStyle(
                      fontSize: 12,
                      fontWeight: FontWeight.w800,
                      height: 1.45,
                    ),
                  ),
                ),
              ],
              const Divider(height: 32),
              SwitchListTile.adaptive(
                contentPadding: EdgeInsets.zero,
                value: notificationsReady,
                onChanged: _preferenceBusy || _pushBusy
                    ? null
                    : _toggleAllNotifications,
                secondary: ExecutorMetalIcon(
                  icon: notificationsReady
                      ? Icons.notifications_active_outlined
                      : Icons.notifications_off_outlined,
                  color: notificationsReady
                      ? ExecutorUiColors.jade
                      : ExecutorUiColors.coral,
                  size: 38,
                  selected: notificationsReady,
                ),
                title: Text(
                  notificationsReady ? 'إيقاف الإشعارات' : 'تشغيل الإشعارات',
                  style: const TextStyle(fontWeight: FontWeight.w900),
                ),
                subtitle: Text(
                  notificationsReady
                      ? 'إشعارات المهام والعمليات والدعم تعمل الآن.'
                      : 'الإشعارات متوقفة على هذا الجهاز.',
                ),
              ),
            ],
          ),
        ),
        if (widget.controller.isExecutorManager) ...[
          const SizedBox(height: 18),
          ExecutorSurface(
            accent: ExecutorUiColors.amber,
            child: SwitchListTile.adaptive(
              contentPadding: EdgeInsets.zero,
              value: _manualTaskRoutingEnabled,
              onChanged: _routingBusy ? null : _toggleManualTaskRouting,
              secondary: const ExecutorMetalIcon(
                icon: Icons.route_outlined,
                color: ExecutorUiColors.amber,
                size: 38,
                selected: true,
              ),
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
            color: ExecutorUiColors.cobalt,
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

class _ExecutorEmployeesScreenState extends State<ExecutorEmployeesScreen>
    with WidgetsBindingObserver {
  List<Map<String, dynamic>> _employees = <Map<String, dynamic>>[];
  Map<String, dynamic> _summary = <String, dynamic>{};
  final TextEditingController _searchController = TextEditingController();
  Object? _error;
  bool _loading = true;
  String? _busyId;
  String? _syncError;
  DateTime? _lastUpdated;
  String _roleFilter = 'all';
  String _statusFilter = 'all';
  String _sortMode = 'activity';

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _load();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _searchController.dispose();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed && _employees.isNotEmpty) {
      unawaited(_load(silent: true));
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
      final workspace = await widget.controller.api
          .executorEmployeesWorkspace()
          .timeout(
            const Duration(seconds: 12),
            onTimeout: () => throw const ApiFailure(
              'انتهت مهلة الاتصال ببيانات الموظفين. تحقق من الخادم ثم أعد المحاولة.',
            ),
          );
      final rawEmployees = workspace['employees'];
      final employees = rawEmployees is List
          ? rawEmployees
                .whereType<Map>()
                .map((item) => Map<String, dynamic>.from(item))
                .toList()
          : <Map<String, dynamic>>[];
      final rawSummary = workspace['summary'];
      if (mounted) {
        setState(() {
          _employees = employees;
          _summary = rawSummary is Map
              ? Map<String, dynamic>.from(rawSummary)
              : <String, dynamic>{};
          _syncError = null;
          _lastUpdated = DateTime.now();
        });
      }
    } catch (error) {
      if (mounted) {
        setState(() {
          if (!silent || _employees.isEmpty) _error = error;
          _syncError =
              'تعذر تحديث فريق التنفيذ الآن. اضغط هنا لإعادة المحاولة.';
        });
      }
    } finally {
      if (!silent && mounted) setState(() => _loading = false);
    }
  }

  List<Map<String, dynamic>> get _visibleEmployees {
    final query = _searchController.text.trim().toLowerCase();
    final visible = _employees.where((employee) {
      final role = '${employee['role']}';
      final status = '${employee['status']}';
      final presence = employee['presence'] is Map
          ? Map<String, dynamic>.from(employee['presence'] as Map)
          : const <String, dynamic>{};
      final hasTask = employee['currentTask'] is Map;
      final searchable = <dynamic>[
        employee['name'],
        employee['phone'],
        employee['webUsername'],
      ].join(' ').toLowerCase();

      if (query.isNotEmpty && !searchable.contains(query)) return false;
      if (_roleFilter != 'all' && role != _roleFilter) return false;
      if (_statusFilter == 'active' && status != 'active') return false;
      if (_statusFilter == 'suspended' && status == 'active') return false;
      if (_statusFilter == 'online' && presence['isOnline'] != true) {
        return false;
      }
      if (_statusFilter == 'busy' && !hasTask) return false;
      return true;
    }).toList();

    int completedCount(Map<String, dynamic> employee) {
      final metrics = employee['metrics'];
      return metrics is Map
          ? numberValue(metrics['completedCount']).toInt()
          : 0;
    }

    int activityRank(Map<String, dynamic> employee) {
      if (employee['currentTask'] is Map) return 3;
      final presence = employee['presence'];
      if (presence is Map && presence['isOnline'] == true) return 2;
      return employee['status'] == 'active' ? 1 : 0;
    }

    visible.sort((left, right) {
      if (_sortMode == 'name') {
        return '${left['name']}'.compareTo('${right['name']}');
      }
      if (_sortMode == 'performance') {
        return completedCount(right).compareTo(completedCount(left));
      }
      final activity = activityRank(right).compareTo(activityRank(left));
      if (activity != 0) return activity;
      return completedCount(right).compareTo(completedCount(left));
    });
    return visible;
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

  Future<void> _toggleReportsPermission(Map<String, dynamic> employee) async {
    final id = '${employee['id']}';
    setState(() => _busyId = id);
    try {
      await widget.controller.api.toggleExecutorEmployeeReports(id);
      if (mounted) {
        showSnack(
          context,
          employee['canViewAllReports'] == true
              ? 'تم تقييد التقارير على حساب الموظف.'
              : 'تم السماح للموظف بعرض تقارير الشركة.',
        );
      }
      await _load();
    } on ApiFailure catch (error) {
      if (mounted) showSnack(context, error.message, error: true);
    } finally {
      if (mounted) setState(() => _busyId = null);
    }
  }

  Future<void> _archive(Map<String, dynamic> employee) async {
    final approved = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('أرشفة حساب الموظف'),
        content: Text(
          'سيتم إيقاف دخول ${employee['name'] ?? 'الموظف'} وإخفاء الحساب من الفريق، مع الاحتفاظ بجميع عملياته وتقاريره في السجل.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('إلغاء'),
          ),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: _danger),
            onPressed: () => Navigator.pop(context, true),
            child: const Text('أرشفة الحساب'),
          ),
        ],
      ),
    );
    if (approved != true) return;
    final id = '${employee['id']}';
    setState(() => _busyId = id);
    try {
      await widget.controller.api.deleteExecutorEmployee(id);
      if (mounted) showSnack(context, 'تمت أرشفة الحساب مع حفظ سجل العمليات.');
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

  void _openEmployee(Map<String, dynamic> employee) {
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => ExecutorEmployeeDetailsScreen(
          employee: employee,
          busy: _busyId == '${employee['id']}',
          onEdit: () => _editEmployee(employee),
          onResetPassword: () => _resetPassword(employee),
          onToggleStatus: () => _toggleStatus(employee),
          onToggleReports: () => _toggleReportsPermission(employee),
          onReport: () => _openReport(employee),
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
    final visibleEmployees = _visibleEmployees;
    return PageFrame(
      title: 'فريق التنفيذ',
      subtitle: 'متابعة الحضور والمهام والأداء وإدارة صلاحيات الفريق.',
      onRefresh: _load,
      action: FilledButton(
        onPressed: _loading ? null : () => _editEmployee(),
        style: FilledButton.styleFrom(
          padding: const EdgeInsets.all(12),
          minimumSize: const Size.square(44),
        ),
        child: const Icon(Icons.person_add_alt_1_outlined),
      ),
      child: [
        if (_syncError != null) ...[
          InkWell(
            onTap: () => _load(),
            borderRadius: BorderRadius.circular(8),
            child: Container(
              padding: const EdgeInsets.all(11),
              decoration: BoxDecoration(
                color: _gold.withValues(alpha: 0.10),
                borderRadius: BorderRadius.circular(8),
                border: Border.all(color: _gold.withValues(alpha: 0.32)),
              ),
              child: Row(
                children: [
                  const Icon(Icons.sync_problem_outlined, color: _gold),
                  const SizedBox(width: 9),
                  Expanded(
                    child: Text(
                      _syncError!,
                      style: const TextStyle(fontWeight: FontWeight.w700),
                    ),
                  ),
                  const Icon(Icons.refresh_rounded, color: _gold),
                ],
              ),
            ),
          ),
          const SizedBox(height: 12),
        ],
        ExecutorEmployeesSummary(summary: _summary),
        if (_lastUpdated != null) ...[
          const SizedBox(height: 7),
          Align(
            alignment: AlignmentDirectional.centerStart,
            child: Text(
              'آخر تحديث ${DateFormat('h:mm a', 'ar').format(_lastUpdated!)}',
              style: TextStyle(
                color: Theme.of(context).colorScheme.onSurfaceVariant,
                fontSize: 11,
              ),
            ),
          ),
        ],
        const SizedBox(height: 14),
        ExecutorSurface(
          accent: ExecutorUiColors.cobalt,
          elevated: false,
          child: LayoutBuilder(
            builder: (context, constraints) {
              final phone = constraints.maxWidth < 430;
              final compact = constraints.maxWidth < 650;
              final filterWidth = phone
                  ? constraints.maxWidth
                  : compact
                  ? (constraints.maxWidth - 10) / 2
                  : (constraints.maxWidth - 20) / 3;
              return Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  TextField(
                    controller: _searchController,
                    onChanged: (_) => setState(() {}),
                    decoration: InputDecoration(
                      labelText: 'بحث عن موظف',
                      hintText: 'الاسم أو الهاتف أو اسم المستخدم',
                      prefixIcon: const Icon(Icons.search_rounded),
                      suffixIcon: _searchController.text.isEmpty
                          ? null
                          : IconButton(
                              tooltip: 'مسح البحث',
                              onPressed: () {
                                _searchController.clear();
                                setState(() {});
                              },
                              icon: const Icon(Icons.close_rounded),
                            ),
                    ),
                  ),
                  const SizedBox(height: 10),
                  Wrap(
                    spacing: 10,
                    runSpacing: 10,
                    children: [
                      SizedBox(
                        width: filterWidth,
                        child: DropdownButtonFormField<String>(
                          initialValue: _roleFilter,
                          decoration: const InputDecoration(
                            labelText: 'الوظيفة',
                            prefixIcon: Icon(Icons.badge_outlined),
                          ),
                          items: const [
                            DropdownMenuItem(
                              value: 'all',
                              child: Text('كل الوظائف'),
                            ),
                            DropdownMenuItem(
                              value: 'operator',
                              child: Text('موظف تنفيذ'),
                            ),
                            DropdownMenuItem(
                              value: 'accountant',
                              child: Text('محاسب'),
                            ),
                            DropdownMenuItem(
                              value: 'external',
                              child: Text('موظف خارجي'),
                            ),
                            DropdownMenuItem(
                              value: 'manager',
                              child: Text('مدير'),
                            ),
                          ],
                          onChanged: (value) =>
                              setState(() => _roleFilter = value ?? 'all'),
                        ),
                      ),
                      SizedBox(
                        width: filterWidth,
                        child: DropdownButtonFormField<String>(
                          initialValue: _statusFilter,
                          decoration: const InputDecoration(
                            labelText: 'الحالة',
                            prefixIcon: Icon(Icons.radar_outlined),
                          ),
                          items: const [
                            DropdownMenuItem(
                              value: 'all',
                              child: Text('كل الحالات'),
                            ),
                            DropdownMenuItem(
                              value: 'online',
                              child: Text('متصل الآن'),
                            ),
                            DropdownMenuItem(
                              value: 'busy',
                              child: Text('لديه مهمة'),
                            ),
                            DropdownMenuItem(
                              value: 'active',
                              child: Text('نشط'),
                            ),
                            DropdownMenuItem(
                              value: 'suspended',
                              child: Text('موقوف'),
                            ),
                          ],
                          onChanged: (value) =>
                              setState(() => _statusFilter = value ?? 'all'),
                        ),
                      ),
                      SizedBox(
                        width: phone || compact
                            ? constraints.maxWidth
                            : filterWidth,
                        child: DropdownButtonFormField<String>(
                          initialValue: _sortMode,
                          decoration: const InputDecoration(
                            labelText: 'الترتيب',
                            prefixIcon: Icon(Icons.sort_rounded),
                          ),
                          items: const [
                            DropdownMenuItem(
                              value: 'activity',
                              child: Text('النشاط الحالي'),
                            ),
                            DropdownMenuItem(
                              value: 'performance',
                              child: Text('أداء اليوم'),
                            ),
                            DropdownMenuItem(
                              value: 'name',
                              child: Text('الاسم'),
                            ),
                          ],
                          onChanged: (value) =>
                              setState(() => _sortMode = value ?? 'activity'),
                        ),
                      ),
                    ],
                  ),
                ],
              );
            },
          ),
        ),
        const SizedBox(height: 16),
        Row(
          children: [
            Expanded(
              child: Text(
                'أعضاء الفريق',
                style: Theme.of(
                  context,
                ).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w900),
              ),
            ),
            StatusPill(
              label: '${visibleEmployees.length} حساب',
              color: Theme.of(context).colorScheme.primary,
            ),
          ],
        ),
        const SizedBox(height: 10),
        if (_employees.isEmpty)
          const EmptyPanel(
            icon: Icons.groups_outlined,
            title: 'لا توجد حسابات موظفين',
            message: 'أضف موظف تنفيذ أو محاسباً لشركة التنفيذ.',
          )
        else if (visibleEmployees.isEmpty)
          EmptyPanel(
            icon: Icons.manage_search_outlined,
            title: 'لا توجد نتائج مطابقة',
            message: 'غيّر البحث أو الفلاتر لعرض أعضاء الفريق.',
            action: TextButton.icon(
              onPressed: () {
                _searchController.clear();
                setState(() {
                  _roleFilter = 'all';
                  _statusFilter = 'all';
                });
              },
              icon: const Icon(Icons.restart_alt_rounded),
              label: const Text('إعادة الضبط'),
            ),
          )
        else
          ...visibleEmployees.map(
            (employee) => Padding(
              padding: const EdgeInsets.only(bottom: 12),
              child: ExecutorEmployeeTile(
                employee: employee,
                busy: _busyId == '${employee['id']}',
                onOpen: () => _openEmployee(employee),
                onEdit: () => _editEmployee(employee),
                onResetPassword: () => _resetPassword(employee),
                onToggleStatus: () => _toggleStatus(employee),
                onToggleReports: () => _toggleReportsPermission(employee),
                onReport: () => _openReport(employee),
                onArchive: () => _archive(employee),
              ),
            ),
          ),
      ],
    );
  }
}

class ExecutorEmployeesSummary extends StatelessWidget {
  const ExecutorEmployeesSummary({super.key, required this.summary});

  final Map<String, dynamic> summary;

  @override
  Widget build(BuildContext context) {
    final items = <({String label, String value, IconData icon, Color color})>[
      (
        label: 'أعضاء الفريق',
        value: '${numberValue(summary['totalEmployees']).toInt()}',
        icon: Icons.groups_2_outlined,
        color: AhramColors.sky,
      ),
      (
        label: 'متصلون الآن',
        value: '${numberValue(summary['onlineEmployees']).toInt()}',
        icon: Icons.wifi_tethering_rounded,
        color: _green,
      ),
      (
        label: 'مهام نشطة',
        value: '${numberValue(summary['busyEmployees']).toInt()}',
        icon: Icons.pending_actions_outlined,
        color: _gold,
      ),
      (
        label: 'تنفيذات اليوم',
        value: '${numberValue(summary['completedCount']).toInt()}',
        icon: Icons.task_alt_outlined,
        color: ExecutorUiColors.cobalt,
      ),
    ];

    return LayoutBuilder(
      builder: (context, constraints) {
        final columns = constraints.maxWidth >= 760 ? 4 : 2;
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            GridView.builder(
              shrinkWrap: true,
              physics: const NeverScrollableScrollPhysics(),
              gridDelegate: SliverGridDelegateWithFixedCrossAxisCount(
                crossAxisCount: columns,
                crossAxisSpacing: 10,
                mainAxisSpacing: 10,
                childAspectRatio: columns == 4 ? 2.35 : 1.75,
              ),
              itemCount: items.length,
              itemBuilder: (context, index) {
                final item = items[index];
                return _EmployeeSummaryCard(
                  label: item.label,
                  value: item.value,
                  icon: item.icon,
                  color: item.color,
                );
              },
            ),
            const SizedBox(height: 9),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
              decoration: BoxDecoration(
                color: Theme.of(
                  context,
                ).colorScheme.primary.withValues(alpha: 0.06),
                borderRadius: BorderRadius.circular(8),
              ),
              child: Row(
                children: [
                  Icon(
                    Icons.payments_outlined,
                    size: 18,
                    color: Theme.of(context).colorScheme.primary,
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      'إجمالي تنفيذات اليوم',
                      style: TextStyle(
                        color: Theme.of(context).colorScheme.onSurfaceVariant,
                        fontSize: 12,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                  ),
                  Text(
                    '${formatEgpAmount(numberValue(summary['totalEGP']))} ج.م',
                    textDirection: ui.TextDirection.ltr,
                    style: const TextStyle(
                      fontSize: 14,
                      fontWeight: FontWeight.w900,
                    ),
                  ),
                ],
              ),
            ),
          ],
        );
      },
    );
  }
}

class _EmployeeSummaryCard extends StatelessWidget {
  const _EmployeeSummaryCard({
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
    return ExecutorSurface(
      padding: const EdgeInsets.all(12),
      accent: color,
      child: Row(
        children: [
          ExecutorMetalIcon(icon: icon, color: color, size: 39),
          const SizedBox(width: 9),
          Expanded(
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  value,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  textDirection: ui.TextDirection.ltr,
                  style: const TextStyle(
                    fontSize: 18,
                    fontWeight: FontWeight.w900,
                  ),
                ),
                Text(
                  label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: colors.onSurfaceVariant,
                    fontSize: 10,
                    fontWeight: FontWeight.w700,
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

class ExecutorEmployeeTile extends StatelessWidget {
  const ExecutorEmployeeTile({
    super.key,
    required this.employee,
    required this.busy,
    required this.onOpen,
    required this.onEdit,
    required this.onResetPassword,
    required this.onToggleStatus,
    required this.onToggleReports,
    required this.onReport,
    required this.onArchive,
  });

  final Map<String, dynamic> employee;
  final bool busy;
  final VoidCallback onOpen;
  final VoidCallback onEdit;
  final VoidCallback onResetPassword;
  final VoidCallback onToggleStatus;
  final VoidCallback onToggleReports;
  final VoidCallback onReport;
  final VoidCallback onArchive;

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
    final metrics = employee['metrics'] is Map
        ? Map<String, dynamic>.from(employee['metrics'] as Map)
        : const <String, dynamic>{};
    final presence = employee['presence'] is Map
        ? Map<String, dynamic>.from(employee['presence'] as Map)
        : const <String, dynamic>{};
    final currentTask = employee['currentTask'] is Map
        ? Map<String, dynamic>.from(employee['currentTask'] as Map)
        : null;
    final online = presence['isOnline'] == true;
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
    return Material(
      color: colors.surface,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(8),
        side: BorderSide(
          color: currentTask != null
              ? colors.primary.withValues(alpha: 0.38)
              : roleColor.withValues(alpha: 0.22),
        ),
      ),
      elevation: 2,
      shadowColor: _navy.withValues(alpha: 0.18),
      child: InkWell(
        onTap: onOpen,
        borderRadius: BorderRadius.circular(8),
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Stack(
                    clipBehavior: Clip.none,
                    children: [
                      ExecutorMetalIcon(
                        icon: roleIcon,
                        color: roleColor,
                        size: 48,
                      ),
                      PositionedDirectional(
                        end: -2,
                        bottom: -2,
                        child: Container(
                          width: 13,
                          height: 13,
                          decoration: BoxDecoration(
                            color: online ? _green : colors.outlineVariant,
                            shape: BoxShape.circle,
                            border: Border.all(color: colors.surface, width: 2),
                          ),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          '${employee['name'] ?? '-'}',
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            fontWeight: FontWeight.w900,
                            color: colors.onSurface,
                            fontSize: 16,
                          ),
                        ),
                        const SizedBox(height: 5),
                        Wrap(
                          spacing: 6,
                          runSpacing: 6,
                          children: [
                            StatusPill(label: _role, color: roleColor),
                            StatusPill(
                              label: online
                                  ? 'متصل الآن'
                                  : active
                                  ? 'غير متصل'
                                  : 'موقوف',
                              color: online
                                  ? _green
                                  : active
                                  ? colors.onSurfaceVariant
                                  : _danger,
                            ),
                          ],
                        ),
                      ],
                    ),
                  ),
                  if (busy)
                    const Padding(
                      padding: EdgeInsets.all(8),
                      child: SizedBox.square(
                        dimension: 18,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      ),
                    )
                  else if (!isManager)
                    PopupMenuButton<String>(
                      tooltip: 'إجراءات الموظف',
                      onSelected: (value) {
                        if (value == 'edit') onEdit();
                        if (value == 'password') onResetPassword();
                        if (value == 'reports') onToggleReports();
                        if (value == 'status') onToggleStatus();
                        if (value == 'archive') onArchive();
                      },
                      itemBuilder: (context) => [
                        const PopupMenuItem(
                          value: 'edit',
                          child: ListTile(
                            dense: true,
                            leading: Icon(Icons.edit_outlined),
                            title: Text('تعديل البيانات'),
                          ),
                        ),
                        const PopupMenuItem(
                          value: 'password',
                          child: ListTile(
                            dense: true,
                            leading: Icon(Icons.key_outlined),
                            title: Text('تغيير كلمة المرور'),
                          ),
                        ),
                        PopupMenuItem(
                          value: 'reports',
                          child: ListTile(
                            dense: true,
                            leading: const Icon(Icons.policy_outlined),
                            title: Text(
                              employee['canViewAllReports'] == true
                                  ? 'تقييد التقارير'
                                  : 'السماح بتقارير الشركة',
                            ),
                          ),
                        ),
                        PopupMenuItem(
                          value: 'status',
                          child: ListTile(
                            dense: true,
                            leading: Icon(
                              active
                                  ? Icons.pause_circle_outline
                                  : Icons.play_circle_outline,
                            ),
                            title: Text(
                              active ? 'إيقاف الحساب' : 'تفعيل الحساب',
                            ),
                          ),
                        ),
                        const PopupMenuDivider(),
                        const PopupMenuItem(
                          value: 'archive',
                          child: ListTile(
                            dense: true,
                            leading: Icon(
                              Icons.archive_outlined,
                              color: _danger,
                            ),
                            title: Text(
                              'أرشفة الحساب',
                              style: TextStyle(color: _danger),
                            ),
                          ),
                        ),
                      ],
                    ),
                ],
              ),
              if (currentTask != null) ...[
                const SizedBox(height: 12),
                Container(
                  padding: const EdgeInsets.all(11),
                  decoration: BoxDecoration(
                    color: colors.primary.withValues(alpha: 0.07),
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(
                      color: colors.primary.withValues(alpha: 0.18),
                    ),
                  ),
                  child: Row(
                    children: [
                      Icon(
                        Icons.assignment_turned_in_outlined,
                        color: colors.primary,
                      ),
                      const SizedBox(width: 9),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              'ينفذ الآن ${currentTask['customId'] ?? ''}',
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(
                                fontWeight: FontWeight.w900,
                                fontSize: 12,
                              ),
                            ),
                            const SizedBox(height: 3),
                            Text(
                              '${currentTask['recipient'] ?? '-'} · ${formatEgpAmount(numberValue(currentTask['amount']))} ج.م',
                              textDirection: ui.TextDirection.ltr,
                              style: TextStyle(
                                color: colors.onSurfaceVariant,
                                fontSize: 12,
                              ),
                            ),
                          ],
                        ),
                      ),
                      TaskElapsedTimer(startedAt: currentTask['receivedAt']),
                    ],
                  ),
                ),
              ],
              const SizedBox(height: 13),
              Row(
                children: [
                  Expanded(
                    child: EmployeeMetricCell(
                      label: 'عمليات اليوم',
                      value:
                          '${numberValue(metrics['completedCount']).toInt()}',
                    ),
                  ),
                  Expanded(
                    child: EmployeeMetricCell(
                      label: 'إجمالي اليوم',
                      value:
                          '${formatEgpAmount(numberValue(metrics['totalEGP']))} ج.م',
                    ),
                  ),
                  Expanded(
                    child: EmployeeMetricCell(
                      label: 'متوسط التنفيذ',
                      value: metrics['averageDurationSeconds'] == null
                          ? '-'
                          : formatExecutionDuration(
                              metrics['averageDurationSeconds'],
                            ),
                    ),
                  ),
                ],
              ),
              const Divider(height: 22),
              Row(
                children: [
                  Expanded(
                    child: TextButton.icon(
                      onPressed: onOpen,
                      icon: const Icon(Icons.person_search_outlined),
                      label: const Text('فتح الملف'),
                    ),
                  ),
                  const SizedBox(width: 8),
                  OutlinedButton.icon(
                    onPressed: busy ? null : onReport,
                    icon: const Icon(Icons.assessment_outlined),
                    label: const Text('التقرير'),
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

class EmployeeMetricCell extends StatelessWidget {
  const EmployeeMetricCell({
    super.key,
    required this.label,
    required this.value,
  });

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          label,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: TextStyle(color: colors.onSurfaceVariant, fontSize: 10),
        ),
        const SizedBox(height: 4),
        Text(
          value,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          textDirection: ui.TextDirection.ltr,
          style: TextStyle(
            color: colors.onSurface,
            fontSize: 12,
            fontWeight: FontWeight.w900,
          ),
        ),
      ],
    );
  }
}

class ExecutorEmployeeDetailsScreen extends StatelessWidget {
  const ExecutorEmployeeDetailsScreen({
    super.key,
    required this.employee,
    required this.busy,
    required this.onEdit,
    required this.onResetPassword,
    required this.onToggleStatus,
    required this.onToggleReports,
    required this.onReport,
  });

  final Map<String, dynamic> employee;
  final bool busy;
  final VoidCallback onEdit;
  final VoidCallback onResetPassword;
  final VoidCallback onToggleStatus;
  final VoidCallback onToggleReports;
  final VoidCallback onReport;

  String get _roleLabel => switch ('${employee['role']}') {
    'manager' => 'مدير تنفيذي',
    'accountant' => 'محاسب',
    'external' => 'موظف خارجي',
    _ => 'موظف تنفيذ',
  };

  Map<String, dynamic> get _metrics => employee['metrics'] is Map
      ? Map<String, dynamic>.from(employee['metrics'] as Map)
      : const <String, dynamic>{};

  Map<String, dynamic> get _presence => employee['presence'] is Map
      ? Map<String, dynamic>.from(employee['presence'] as Map)
      : const <String, dynamic>{};

  Map<String, dynamic>? get _currentTask => employee['currentTask'] is Map
      ? Map<String, dynamic>.from(employee['currentTask'] as Map)
      : null;

  @override
  Widget build(BuildContext context) {
    final active = employee['status'] == 'active';
    final online = _presence['isOnline'] == true;
    return DefaultTabController(
      length: 3,
      child: Scaffold(
        appBar: AppBar(
          title: Text('${employee['name'] ?? 'ملف الموظف'}'),
          actions: [
            IconButton(
              tooltip: 'فتح التقرير',
              onPressed: onReport,
              icon: const Icon(Icons.assessment_outlined),
            ),
          ],
          bottom: const TabBar(
            tabs: [
              Tab(text: 'نظرة عامة'),
              Tab(text: 'المهمة الحالية'),
              Tab(text: 'الحساب'),
            ],
          ),
        ),
        body: TabBarView(
          children: [
            _employeeOverview(context, online),
            _employeeTask(context),
            _employeeAccount(context, active),
          ],
        ),
      ),
    );
  }

  Widget _employeeOverview(BuildContext context, bool online) {
    final colors = Theme.of(context).colorScheme;
    final successRate = _metrics['successRate'];
    return ListView(
      padding: const EdgeInsets.all(18),
      children: [
        SurfacePanel(
          child: Row(
            children: [
              Stack(
                clipBehavior: Clip.none,
                children: [
                  GlassIconBadge(
                    icon: employee['role'] == 'accountant'
                        ? Icons.calculate_outlined
                        : employee['role'] == 'manager'
                        ? Icons.admin_panel_settings_outlined
                        : Icons.support_agent_outlined,
                    color: employee['role'] == 'accountant'
                        ? _gold
                        : employee['role'] == 'manager'
                        ? AhramColors.sky
                        : _green,
                    size: 58,
                  ),
                  PositionedDirectional(
                    end: -1,
                    bottom: -1,
                    child: Container(
                      width: 15,
                      height: 15,
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        color: online ? _green : colors.outlineVariant,
                        border: Border.all(color: colors.surface, width: 2),
                      ),
                    ),
                  ),
                ],
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      '${employee['name'] ?? '-'}',
                      style: const TextStyle(
                        fontSize: 18,
                        fontWeight: FontWeight.w900,
                      ),
                    ),
                    const SizedBox(height: 5),
                    Text(
                      '$_roleLabel · ${online ? 'متصل الآن' : 'آخر ظهور ${formatDate(_presence['lastSeenAt'])}'}',
                      style: TextStyle(
                        color: colors.onSurfaceVariant,
                        fontSize: 12,
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 12),
        GridView.count(
          shrinkWrap: true,
          physics: const NeverScrollableScrollPhysics(),
          crossAxisCount: 2,
          crossAxisSpacing: 10,
          mainAxisSpacing: 10,
          childAspectRatio: 1.9,
          children: [
            _EmployeeSummaryCard(
              label: 'عمليات اليوم',
              value: '${numberValue(_metrics['completedCount']).toInt()}',
              icon: Icons.task_alt_outlined,
              color: _green,
            ),
            _EmployeeSummaryCard(
              label: 'إجمالي اليوم',
              value:
                  '${formatEgpAmount(numberValue(_metrics['totalEGP']))} ج.م',
              icon: Icons.payments_outlined,
              color: AhramColors.sky,
            ),
            _EmployeeSummaryCard(
              label: 'متوسط التنفيذ',
              value: _metrics['averageDurationSeconds'] == null
                  ? '-'
                  : formatExecutionDuration(_metrics['averageDurationSeconds']),
              icon: Icons.timer_outlined,
              color: _gold,
            ),
            _EmployeeSummaryCard(
              label: 'نسبة النجاح',
              value: successRate == null
                  ? '-'
                  : '${numberValue(successRate).toInt()}%',
              icon: Icons.trending_up_rounded,
              color: const Color(0xFF6B57C8),
            ),
          ],
        ),
        const SizedBox(height: 12),
        SizedBox(
          width: double.infinity,
          child: FilledButton.icon(
            onPressed: onReport,
            icon: const Icon(Icons.assessment_outlined),
            label: const Text('فتح التقرير الفردي'),
          ),
        ),
      ],
    );
  }

  Widget _employeeTask(BuildContext context) {
    final task = _currentTask;
    if (task == null) {
      return ListView(
        padding: const EdgeInsets.all(18),
        children: const [
          EmptyPanel(
            icon: Icons.task_alt_outlined,
            title: 'لا توجد مهمة نشطة',
            message: 'الموظف متاح لاستقبال عملية جديدة.',
          ),
        ],
      );
    }
    return ListView(
      padding: const EdgeInsets.all(18),
      children: [
        SurfacePanel(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  const GlassIconBadge(
                    icon: Icons.pending_actions_outlined,
                    color: AhramColors.sky,
                    size: 46,
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Text(
                          'عملية قيد التنفيذ',
                          style: TextStyle(fontWeight: FontWeight.w900),
                        ),
                        Text(
                          '${task['customId'] ?? '-'}',
                          textDirection: ui.TextDirection.ltr,
                        ),
                      ],
                    ),
                  ),
                  TaskElapsedTimer(startedAt: task['receivedAt']),
                ],
              ),
              const Divider(height: 28),
              DetailLine(
                label: 'الخدمة',
                value: serviceLabel('${task['transferType']}'),
              ),
              DetailLine(
                label: 'رقم المستلم',
                value: '${task['recipient'] ?? '-'}',
              ),
              DetailLine(
                label: 'القيمة',
                value: '${formatEgpAmount(numberValue(task['amount']))} ج.م',
              ),
              DetailLine(
                label: 'وقت الوصول',
                value: formatTaskArrival(task['receivedAt']),
              ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _employeeAccount(BuildContext context, bool active) {
    final isManager = employee['role'] == 'manager';
    return ListView(
      padding: const EdgeInsets.all(18),
      children: [
        SurfacePanel(
          child: Column(
            children: [
              DetailLine(label: 'الوظيفة', value: _roleLabel),
              DetailLine(label: 'حالة الحساب', value: active ? 'نشط' : 'موقوف'),
              DetailLine(
                label: 'رقم الهاتف',
                value: '${employee['phone'] ?? '-'}',
              ),
              DetailLine(
                label: 'اسم المستخدم',
                value: '${employee['webUsername'] ?? '-'}',
              ),
              DetailLine(
                label: 'تاريخ الانضمام',
                value: formatDate(employee['createdAt']),
              ),
              DetailLine(
                label: 'إشعارات الهاتف',
                value: _presence['pushReady'] == true
                    ? 'جاهزة'
                    : 'تحتاج إعداداً',
              ),
              if ('${_presence['deviceName'] ?? ''}'.isNotEmpty)
                DetailLine(
                  label: 'آخر جهاز',
                  value: '${_presence['deviceName']}',
                ),
            ],
          ),
        ),
        if (!isManager) ...[
          const SizedBox(height: 12),
          SurfacePanel(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(
                  'إدارة الحساب',
                  style: Theme.of(context).textTheme.titleMedium?.copyWith(
                    fontWeight: FontWeight.w900,
                  ),
                ),
                const SizedBox(height: 12),
                FilledButton.icon(
                  onPressed: busy ? null : onEdit,
                  icon: const Icon(Icons.edit_outlined),
                  label: const Text('تعديل بيانات الموظف'),
                ),
                const SizedBox(height: 9),
                OutlinedButton.icon(
                  onPressed: busy ? null : onResetPassword,
                  icon: const Icon(Icons.key_outlined),
                  label: const Text('تغيير كلمة المرور'),
                ),
                const SizedBox(height: 9),
                OutlinedButton.icon(
                  onPressed: busy ? null : onToggleReports,
                  icon: const Icon(Icons.policy_outlined),
                  label: Text(
                    employee['canViewAllReports'] == true
                        ? 'تقييد التقارير على حسابه'
                        : 'السماح بعرض تقارير الشركة',
                  ),
                ),
                const SizedBox(height: 9),
                OutlinedButton.icon(
                  style: OutlinedButton.styleFrom(
                    foregroundColor: active ? _danger : _green,
                  ),
                  onPressed: busy ? null : onToggleStatus,
                  icon: Icon(
                    active
                        ? Icons.pause_circle_outline
                        : Icons.play_circle_outline,
                  ),
                  label: Text(active ? 'إيقاف الحساب' : 'تفعيل الحساب'),
                ),
              ],
            ),
          ),
        ],
      ],
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
                      DropdownMenuItem(
                        value: 'external',
                        child: Text('موظف خارجي'),
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
  String _category = 'general';
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
        category: _category,
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
                decoration: const InputDecoration(
                  labelText: 'عنوان الطلب',
                  prefixIcon: Icon(Icons.subject_outlined),
                ),
                validator: (value) =>
                    (value ?? '').trim().isEmpty ? 'العنوان مطلوب.' : null,
              ),
              const SizedBox(height: 12),
              DropdownButtonFormField<String>(
                initialValue: _category,
                decoration: const InputDecoration(
                  labelText: 'نوع الطلب',
                  prefixIcon: Icon(Icons.category_outlined),
                ),
                items: const [
                  DropdownMenuItem(
                    value: 'transaction',
                    child: Text('تحويل أو عملية'),
                  ),
                  DropdownMenuItem(
                    value: 'balance',
                    child: Text('إيداع أو خصم'),
                  ),
                  DropdownMenuItem(
                    value: 'account',
                    child: Text('الحساب والبيانات'),
                  ),
                  DropdownMenuItem(
                    value: 'general',
                    child: Text('استفسار عام'),
                  ),
                  DropdownMenuItem(value: 'other', child: Text('أخرى')),
                ],
                onChanged: _busy
                    ? null
                    : (value) => setState(() => _category = value ?? 'general'),
              ),
              const SizedBox(height: 12),
              TextFormField(
                controller: _message,
                minLines: 4,
                maxLines: 6,
                decoration: const InputDecoration(
                  labelText: 'الرسالة',
                  hintText: 'اكتب رقم العملية إن وجد ثم تفاصيل الطلب.',
                ),
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
      icon: const ExecutorMetalIcon(
        icon: Icons.cancel_outlined,
        color: ExecutorUiColors.coral,
        size: 58,
        selected: true,
      ),
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
  final List<Uint8List> _images = <Uint8List>[];
  final List<TextEditingController> _senderPhones = <TextEditingController>[];
  final List<TextEditingController> _senderAmounts = <TextEditingController>[];
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _execution.dispose();
    for (final controller in _senderPhones) {
      controller.dispose();
    }
    for (final controller in _senderAmounts) {
      controller.dispose();
    }
    super.dispose();
  }

  void _addSender() {
    if (_senderPhones.length >= 5) return;
    setState(() {
      _senderPhones.add(TextEditingController());
      _senderAmounts.add(TextEditingController());
    });
  }

  void _removeSender(int index) {
    setState(() {
      _senderPhones.removeAt(index).dispose();
      _senderAmounts.removeAt(index).dispose();
    });
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
    if (source == ImageSource.gallery) {
      final files = await _picker.pickMultiImage(
        imageQuality: 72,
        maxWidth: 1600,
      );
      if (files.isEmpty) return;
      final available = 5 - _images.length;
      final images = await Future.wait(
        files.take(available).map((file) => file.readAsBytes()),
      );
      if (mounted) setState(() => _images.addAll(images));
      return;
    }
    final file = await _picker.pickImage(
      source: ImageSource.camera,
      imageQuality: 72,
      maxWidth: 1600,
    );
    if (file == null) return;
    final image = await file.readAsBytes();
    if (mounted) setState(() => _images.add(image));
  }

  Future<void> _complete() async {
    final executionNumber = _execution.text.trim();
    if (!RegExp(r'^\d{11}$').hasMatch(executionNumber)) {
      setState(() => _error = 'رقم التنفيذ إجباري ويجب أن يتكون من 11 رقماً.');
      return;
    }
    final senderEntries = <Map<String, dynamic>>[];
    for (var index = 0; index < _senderPhones.length; index++) {
      final phone = _senderPhones[index].text.trim();
      if (!RegExp(r'^\d{11}$').hasMatch(phone)) {
        setState(() => _error = 'كل رقم مرسل يجب أن يتكون من 11 رقماً.');
        return;
      }
      final entry = <String, dynamic>{'phone': phone};
      if (_senderPhones.length > 1) {
        final amount = double.tryParse(_senderAmounts[index].text.trim());
        if (amount == null || amount <= 0) {
          setState(
            () => _error = 'أدخل قيمة كل رقم مرسل عند وجود أكثر من رقم.',
          );
          return;
        }
        entry['amount'] = amount;
      }
      senderEntries.add(entry);
    }
    if (senderEntries.length > 1) {
      final total = senderEntries.fold<double>(
        0,
        (sum, entry) => sum + numberValue(entry['amount']),
      );
      final operationAmount = numberValue(widget.task['amount']);
      if ((total - operationAmount).abs() > 0.01) {
        setState(
          () => _error =
              'مجموع قيم أرقام المرسلين يجب أن يساوي ${formatEgpAmount(operationAmount)} ج.م.',
        );
        return;
      }
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final proofImages = _images
          .map((image) => 'data:image/jpeg;base64,${base64Encode(image)}')
          .toList();
      await widget.api.completeTask(
        id: '${widget.task['id']}',
        executionNumber: executionNumber,
        senderEntries: senderEntries,
        // Keep the first attachment for servers that still accept the legacy
        // single-image field while the full list reaches updated servers.
        imageBase64: proofImages.isEmpty ? null : proofImages.first,
        imagesBase64: proofImages,
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
      icon: const ExecutorLiveHalo(
        size: 82,
        color: ExecutorUiColors.jade,
        child: ExecutorMetalIcon(
          icon: Icons.task_alt_rounded,
          color: ExecutorUiColors.jade,
          size: 56,
          selected: true,
        ),
      ),
      title: const Text('إتمام المهمة'),
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
                keyboardType: TextInputType.number,
                maxLength: 11,
                inputFormatters: [FilteringTextInputFormatter.digitsOnly],
                decoration: const InputDecoration(
                  labelText: 'رقم التنفيذ (11 رقماً) *',
                  prefixIcon: Icon(Icons.tag_outlined),
                ),
              ),
              const SizedBox(height: 12),
              Text(
                'رقم المرسل (اختياري)',
                style: Theme.of(
                  context,
                ).textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w900),
              ),
              const SizedBox(height: 4),
              Text(
                _senderPhones.isEmpty
                    ? 'يمكن إكمال العملية دون إضافة رقم مرسل.'
                    : _senderPhones.length == 1
                    ? 'تُستخدم قيمة العملية تلقائياً لهذا الرقم.'
                    : 'أدخل قيمة كل رقم، ويجب أن يساوي مجموعها قيمة العملية.',
                style: TextStyle(
                  color: Theme.of(context).colorScheme.onSurfaceVariant,
                  fontSize: 12,
                ),
              ),
              const SizedBox(height: 8),
              ...List<Widget>.generate(_senderPhones.length, (index) {
                return Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Row(
                        children: [
                          Expanded(
                            child: TextField(
                              controller: _senderPhones[index],
                              textDirection: ui.TextDirection.ltr,
                              keyboardType: TextInputType.phone,
                              maxLength: 11,
                              inputFormatters: [
                                FilteringTextInputFormatter.digitsOnly,
                              ],
                              decoration: InputDecoration(
                                labelText: 'رقم المرسل ${index + 1}',
                                prefixIcon: const Icon(
                                  Icons.phone_android_outlined,
                                ),
                                counterText: '',
                              ),
                            ),
                          ),
                          if (_senderPhones.length > 1)
                            IconButton(
                              tooltip: 'حذف الرقم',
                              onPressed: () => _removeSender(index),
                              icon: const Icon(Icons.remove_circle_outline),
                            ),
                        ],
                      ),
                      if (_senderPhones.length > 1) ...[
                        const SizedBox(height: 6),
                        TextField(
                          controller: _senderAmounts[index],
                          textDirection: ui.TextDirection.ltr,
                          keyboardType: const TextInputType.numberWithOptions(
                            decimal: true,
                          ),
                          decoration: const InputDecoration(
                            labelText: 'قيمة هذا الرقم بالجنيه المصري',
                            prefixIcon: Icon(Icons.payments_outlined),
                          ),
                        ),
                      ],
                    ],
                  ),
                );
              }),
              Align(
                alignment: AlignmentDirectional.centerStart,
                child: TextButton.icon(
                  onPressed: _senderPhones.length >= 5 ? null : _addSender,
                  icon: const Icon(Icons.add_circle_outline),
                  label: const Text('إضافة رقم مرسل'),
                ),
              ),
              const SizedBox(height: 4),
              ExecutorProofAttachments(
                images: _images,
                onPick: _pick,
                onRemove: (index) => setState(() => _images.removeAt(index)),
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

class ExecutorProofAttachments extends StatelessWidget {
  const ExecutorProofAttachments({
    super.key,
    required this.images,
    required this.onPick,
    required this.onRemove,
  });

  final List<Uint8List> images;
  final VoidCallback onPick;
  final ValueChanged<int> onRemove;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        OutlinedButton.icon(
          onPressed: images.length >= 5 ? null : onPick,
          style: OutlinedButton.styleFrom(
            minimumSize: const Size.fromHeight(50),
            alignment: Alignment.centerRight,
          ),
          icon: const Icon(Icons.add_photo_alternate_outlined),
          label: Text(
            images.isEmpty
                ? 'إرفاق صور إثبات (اختياري)'
                : 'إضافة صورة (${images.length}/5)',
          ),
        ),
        if (images.isNotEmpty) ...[
          const SizedBox(height: 10),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: List<Widget>.generate(
              images.length,
              (index) => Stack(
                clipBehavior: Clip.none,
                children: [
                  ClipRRect(
                    borderRadius: BorderRadius.circular(8),
                    child: Image.memory(
                      images[index],
                      width: 76,
                      height: 76,
                      fit: BoxFit.cover,
                    ),
                  ),
                  Positioned(
                    top: -9,
                    right: -9,
                    child: IconButton.filled(
                      tooltip: 'حذف الصورة',
                      onPressed: () => onRemove(index),
                      icon: const Icon(Icons.close, size: 16),
                      color: _danger,
                      iconSize: 16,
                      padding: const EdgeInsets.all(4),
                      constraints: const BoxConstraints.tightFor(
                        width: 28,
                        height: 28,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ],
        const SizedBox(height: 6),
        Text(
          'يمكن إنهاء العملية دون صورة؛ سيُنشأ إيصال المنظومة تلقائياً.',
          style: Theme.of(context).textTheme.bodySmall,
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
      padding: const EdgeInsets.fromLTRB(18, 18, 18, 34),
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
                      HeritagePillar(height: subtitle == null ? 34 : 48),
                      const SizedBox(width: 12),
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
                  const SizedBox(height: 20),
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

class HeritagePillar extends StatelessWidget {
  const HeritagePillar({super.key, required this.height});

  final double height;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: 5,
      height: height,
      child: Column(
        children: [
          Expanded(
            child: Container(
              decoration: const BoxDecoration(
                color: AhramColors.gold,
                borderRadius: BorderRadius.vertical(top: Radius.circular(5)),
              ),
            ),
          ),
          const SizedBox(height: 2),
          Expanded(child: Container(color: AhramColors.emerald)),
          const SizedBox(height: 2),
          Expanded(
            child: Container(
              decoration: const BoxDecoration(
                color: AhramColors.sky,
                borderRadius: BorderRadius.vertical(bottom: Radius.circular(5)),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class BrandMark extends StatelessWidget {
  const BrandMark({
    super.key,
    this.large = false,
    this.compact = false,
    this.iconOnly = false,
  });

  final bool large;
  final bool compact;
  final bool iconOnly;

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
        if (!compact && !iconOnly) ...[
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
        if (compact && !iconOnly) ...[
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
    this.compact = false,
  });

  final double amount;
  final String label;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    final dark = Theme.of(context).brightness == Brightness.dark;
    return Padding(
      padding: const EdgeInsetsDirectional.only(start: 4, end: 4),
      child: Container(
        constraints: BoxConstraints(minWidth: compact ? 70 : 92),
        padding: EdgeInsetsDirectional.fromSTEB(
          compact ? 7 : 10,
          compact ? 9 : 7,
          compact ? 7 : 8,
          compact ? 9 : 7,
        ),
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
            if (!compact) ...[
              Text(
                label,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  color: dark
                      ? const Color(0xFFA5DCC8)
                      : AhramColors.emeraldDeep,
                  fontSize: 9,
                  fontWeight: FontWeight.w700,
                ),
              ),
              const SizedBox(height: 1),
            ],
            Text(
              '${formatAmount(amount, fractionDigits: 0)} ج.م',
              textDirection: ui.TextDirection.ltr,
              style: TextStyle(
                color: Theme.of(context).colorScheme.onSurface,
                fontSize: compact ? 11 : 12,
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

class _RateChangeCountdownBanner extends StatelessWidget {
  const _RateChangeCountdownBanner({
    required this.seconds,
    required this.rateChangesText,
  });

  final int seconds;
  final String rateChangesText;

  @override
  Widget build(BuildContext context) {
    final minutes = seconds ~/ 60;
    final remainingSeconds = seconds % 60;
    final countdown =
        '${minutes.toString().padLeft(2, '0')}:${remainingSeconds.toString().padLeft(2, '0')}';
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: _gold.withValues(alpha: 0.11),
        border: Border.all(color: _gold.withValues(alpha: 0.48)),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Row(
        children: [
          const Icon(Icons.timer_outlined, color: _gold),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text(
                  'تحديث أسعار الصرف قريباً',
                  style: TextStyle(fontWeight: FontWeight.w900),
                ),
                const SizedBox(height: 2),
                const Text(
                  'ستتحدث الأسعار الخاصة بحسابك تلقائياً عند انتهاء العداد.',
                  style: TextStyle(fontSize: 11),
                ),
                if (rateChangesText.isNotEmpty) ...[
                  const SizedBox(height: 5),
                  Text(
                    rateChangesText,
                    style: const TextStyle(fontSize: 11, height: 1.45),
                  ),
                ],
              ],
            ),
          ),
          Text(
            countdown,
            textDirection: ui.TextDirection.ltr,
            style: const TextStyle(
              fontSize: 20,
              fontWeight: FontWeight.w900,
              color: _gold,
            ),
          ),
        ],
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

Future<void> showCustomerReceiptSheet(
  BuildContext context,
  Map<String, dynamic> transaction, {
  MobileApi? api,
}) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    backgroundColor: Colors.transparent,
    builder: (_) => CustomerReceiptSheet(transaction: transaction, api: api),
  );
}

class CustomerReceiptSheet extends StatelessWidget {
  const CustomerReceiptSheet({super.key, required this.transaction, this.api});

  final Map<String, dynamic> transaction;
  final MobileApi? api;

  bool get _isCancelled => const {
    'cancelled',
    'canceled',
    'cancelled_by_admin',
    'rejected',
    'failed',
  }.contains('${transaction['status'] ?? ''}'.trim().toLowerCase());

  bool get _isCompleted => '${transaction['status'] ?? ''}' == 'completed';

  String get _receiptUrl => '${transaction['receiptUrl'] ?? ''}'.trim();

  String get _transactionId =>
      '${transaction['id'] ?? transaction['_id'] ?? ''}'.trim();

  bool get _canLoadReceipt =>
      _receiptUrl.isNotEmpty || (api != null && _transactionId.isNotEmpty);

  Future<Uint8List?> _loadReceiptBytes() async {
    if (_receiptUrl.isNotEmpty) {
      try {
        final response = await Dio().get<List<int>>(
          _receiptUrl,
          options: Options(responseType: ResponseType.bytes),
        );
        final bytes = response.data;
        if (bytes != null && bytes.isNotEmpty) return Uint8List.fromList(bytes);
      } catch (_) {
        // The signed public URL is optional. Fall back to the authenticated
        // mobile endpoint below when the public route is unavailable.
      }
    }
    if (api == null || _transactionId.isEmpty) return null;
    try {
      return await api!.clientReceiptImageBytes(_transactionId);
    } catch (_) {
      return null;
    }
  }

  Future<void> _copy(BuildContext context, String value, String label) async {
    if (value.isEmpty || value == '-') return;
    await Clipboard.setData(ClipboardData(text: value));
    if (context.mounted) showSnack(context, 'تم نسخ $label.');
  }

  Future<void> _share(BuildContext context) async {
    final reference =
        '${transaction['customId'] ?? transaction['txId'] ?? '-'}';
    final recipient = '${transaction['recipientNumber'] ?? '-'}';
    final message = StringBuffer('إيصال تحويل الأهرام')
      ..writeln('\nرقم العملية: $reference')
      ..writeln('المستلم: $recipient')
      ..writeln(
        'القيمة: ${formatEgpAmount(numberValue(transaction['amount']))} ج.م',
      );
    final shareText = message.toString().trim();
    try {
      final bytes = await _loadReceiptBytes();
      if (bytes != null && bytes.isNotEmpty) {
        await Share.shareXFiles(
          [
            XFile.fromData(
              bytes,
              name: 'ahram-pay-receipt.jpg',
              mimeType: 'image/jpeg',
            ),
          ],
          text: shareText,
          subject: 'إيصال تحويل الأهرام',
        );
        return;
      }

      final whatsappUrl = Uri.https('wa.me', '/', <String, String>{
        'text': shareText,
      });
      final opened = await openExternalLink(whatsappUrl);
      if (!opened) throw StateError('WHATSAPP_NOT_OPENED');
    } catch (_) {
      await Clipboard.setData(ClipboardData(text: shareText));
      if (context.mounted) {
        showSnack(
          context,
          !_canLoadReceipt
              ? 'تم نسخ بيانات الإيصال للمشاركة.'
              : 'تعذر إرفاق الصورة تلقائياً، تم نسخ بيانات الإيصال. افتح واتساب وأرفق الصورة من زر عرض الإيصال.',
          error: _canLoadReceipt,
        );
      }
    }
  }

  void _openReceipt(BuildContext context) {
    if (!_canLoadReceipt) return;
    final receiptFuture = _loadReceiptBytes();
    showDialog<void>(
      context: context,
      builder: (_) => Dialog.fullscreen(
        child: SafeArea(
          child: Column(
            children: [
              Padding(
                padding: const EdgeInsetsDirectional.fromSTEB(12, 8, 12, 8),
                child: Row(
                  children: [
                    IconButton(
                      tooltip: 'إغلاق',
                      onPressed: () => Navigator.pop(context),
                      icon: const Icon(Icons.close_rounded),
                    ),
                    const SizedBox(width: 8),
                    const Expanded(
                      child: Text(
                        'الإيصال الرسمي',
                        style: TextStyle(fontWeight: FontWeight.w900),
                      ),
                    ),
                    IconButton(
                      tooltip: 'نسخ رابط الإيصال',
                      onPressed: _receiptUrl.isEmpty
                          ? null
                          : () => _copy(context, _receiptUrl, 'رابط الإيصال'),
                      icon: const Icon(Icons.link_rounded),
                    ),
                  ],
                ),
              ),
              const Divider(height: 1),
              Expanded(
                child: InteractiveViewer(
                  minScale: 0.8,
                  maxScale: 4,
                  child: Center(
                    child: FutureBuilder<Uint8List?>(
                      future: receiptFuture,
                      builder: (context, snapshot) {
                        if (snapshot.connectionState != ConnectionState.done) {
                          return const SizedBox(
                            width: 34,
                            height: 34,
                            child: CircularProgressIndicator(strokeWidth: 3),
                          );
                        }
                        final bytes = snapshot.data;
                        if (bytes != null && bytes.isNotEmpty) {
                          return Image.memory(bytes, fit: BoxFit.contain);
                        }
                        return const _ReceiptImageUnavailable();
                      },
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final stateColor = _isCancelled
        ? _danger
        : (_isCompleted ? _green : AhramColors.sky);
    final stateIcon = _isCancelled
        ? Icons.cancel_outlined
        : (_isCompleted
              ? Icons.check_circle_outline_rounded
              : Icons.schedule_outlined);
    final reference =
        '${transaction['customId'] ?? transaction['txId'] ?? '-'}';
    final recipient = '${transaction['recipientNumber'] ?? '-'}';
    final service =
        '${transaction['transferTypeLabel'] ?? serviceLabel(transaction['transferType']?.toString())}';
    final notes = '${transaction['notes'] ?? ''}'.trim();
    final cancellationReason = '${transaction['cancellationReason'] ?? ''}'
        .trim();

    return FractionallySizedBox(
      heightFactor: 0.94,
      child: Material(
        color: colors.surface,
        borderRadius: const BorderRadius.vertical(top: Radius.circular(12)),
        child: SafeArea(
          top: false,
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(18, 10, 18, 24),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Center(
                  child: Container(
                    width: 42,
                    height: 4,
                    decoration: BoxDecoration(
                      color: colors.outlineVariant,
                      borderRadius: BorderRadius.circular(10),
                    ),
                  ),
                ),
                const SizedBox(height: 16),
                Row(
                  children: [
                    IconButton(
                      tooltip: 'إغلاق',
                      onPressed: () => Navigator.pop(context),
                      icon: const Icon(Icons.close_rounded),
                    ),
                    const Spacer(),
                    Text(
                      _isCancelled
                          ? 'عملية ملغاة'
                          : (_isCompleted
                                ? 'تمت العملية بنجاح'
                                : 'تفاصيل العملية'),
                      style: Theme.of(context).textTheme.titleMedium?.copyWith(
                        fontWeight: FontWeight.w900,
                        color: colors.onSurface,
                      ),
                    ),
                    const SizedBox(width: 10),
                    Container(
                      width: 42,
                      height: 42,
                      decoration: BoxDecoration(
                        color: stateColor.withValues(alpha: 0.12),
                        borderRadius: BorderRadius.circular(8),
                      ),
                      child: Icon(stateIcon, color: stateColor),
                    ),
                  ],
                ),
                const SizedBox(height: 18),
                Container(
                  padding: const EdgeInsets.all(18),
                  decoration: BoxDecoration(
                    color: stateColor.withValues(alpha: 0.07),
                    border: Border.all(
                      color: stateColor.withValues(alpha: 0.32),
                    ),
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: Column(
                    children: [
                      Text(
                        _isCancelled
                            ? 'تم إلغاء العملية'
                            : (_isCompleted
                                  ? 'تم التحويل بنجاح'
                                  : statusLabel(
                                      transaction['status']?.toString(),
                                    )),
                        style: TextStyle(
                          color: stateColor,
                          fontSize: 17,
                          fontWeight: FontWeight.w900,
                        ),
                      ),
                      const SizedBox(height: 8),
                      Text(
                        '${formatEgpAmount(numberValue(transaction['amount']))} ج.م',
                        textDirection: ui.TextDirection.ltr,
                        style: Theme.of(context).textTheme.headlineMedium
                            ?.copyWith(
                              fontWeight: FontWeight.w900,
                              color: colors.onSurface,
                            ),
                      ),
                      const SizedBox(height: 4),
                      Text(
                        'القيمة بالليبي ${formatAmount(numberValue(transaction['costLYD']))} د.ل',
                        style: TextStyle(
                          color: colors.onSurfaceVariant,
                          fontSize: 12,
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 12),
                Row(
                  children: [
                    Expanded(
                      child: _ReceiptInfoBox(
                        icon: Icons.phone_android_outlined,
                        label: 'رقم المستلم',
                        value: recipient,
                        color: AhramColors.sky,
                        onCopy: () => _copy(context, recipient, 'رقم المستلم'),
                      ),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: _ReceiptInfoBox(
                        icon: Icons.account_balance_wallet_outlined,
                        label: 'الخدمة',
                        value: service,
                        color: _green,
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 16),
                SectionTitle(
                  title: 'تفاصيل العملية',
                  icon: Icons.receipt_long_outlined,
                  color: _gold,
                ),
                const SizedBox(height: 10),
                Container(
                  decoration: BoxDecoration(
                    border: Border.all(color: colors.outlineVariant),
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: Column(
                    children: [
                      _ReceiptDetailRow(
                        icon: Icons.tag_outlined,
                        label: 'رقم مرجع الأهرام',
                        value: reference,
                        onCopy: () => _copy(context, reference, 'رقم العملية'),
                      ),
                      _ReceiptDetailRow(
                        icon: Icons.calendar_today_outlined,
                        label: 'التاريخ والوقت',
                        value: formatDate(transaction['createdAt']),
                      ),
                      _ReceiptDetailRow(
                        icon: Icons.currency_exchange_outlined,
                        label: 'سعر الصرف',
                        value:
                            '${formatAmount(numberValue(transaction['exchangeRate']))} د.ل',
                      ),
                      _ReceiptDetailRow(
                        icon: Icons.verified_outlined,
                        label: 'الحالة',
                        value: statusLabel(transaction['status']?.toString()),
                        valueColor: stateColor,
                        last: notes.isEmpty && cancellationReason.isEmpty,
                      ),
                      if (notes.isNotEmpty)
                        _ReceiptDetailRow(
                          icon: Icons.notes_outlined,
                          label: 'ملاحظة العميل',
                          value: notes,
                          last: cancellationReason.isEmpty,
                        ),
                      if (cancellationReason.isNotEmpty)
                        _ReceiptDetailRow(
                          icon: Icons.info_outline,
                          label: 'سبب الإلغاء',
                          value: cancellationReason,
                          valueColor: _danger,
                          last: true,
                        ),
                    ],
                  ),
                ),
                const SizedBox(height: 14),
                Container(
                  padding: const EdgeInsets.all(14),
                  decoration: BoxDecoration(
                    color: colors.surface,
                    border: Border.all(color: colors.outlineVariant),
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: Row(
                    children: [
                      Container(
                        width: 42,
                        height: 42,
                        alignment: Alignment.center,
                        decoration: BoxDecoration(
                          color: _gold.withValues(alpha: 0.12),
                          borderRadius: BorderRadius.circular(8),
                        ),
                        child: const Icon(
                          Icons.verified_user_outlined,
                          color: _gold,
                        ),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            const Text(
                              'الإيصال الرسمي',
                              style: TextStyle(fontWeight: FontWeight.w900),
                            ),
                            const SizedBox(height: 2),
                            Text(
                              _receiptUrl.isEmpty
                                  ? 'سيظهر بعد توليد الإيصال من المنظومة.'
                                  : 'صورة الإيصال المعتمدة من المنظومة.',
                              style: TextStyle(
                                color: colors.onSurfaceVariant,
                                fontSize: 12,
                              ),
                            ),
                          ],
                        ),
                      ),
                      IconButton(
                        tooltip: 'عرض الإيصال',
                        onPressed: !_canLoadReceipt
                            ? null
                            : () => _openReceipt(context),
                        icon: Icon(
                          Icons.visibility_outlined,
                          color: !_canLoadReceipt ? colors.outline : _green,
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 16),
                Row(
                  children: [
                    Expanded(
                      child: OutlinedButton.icon(
                        onPressed: !_canLoadReceipt
                            ? null
                            : () => _openReceipt(context),
                        icon: const Icon(Icons.receipt_long_outlined),
                        label: const Text('عرض الإيصال'),
                      ),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: FilledButton.icon(
                        onPressed: () => _share(context),
                        icon: const Icon(Icons.share_outlined),
                        label: const Text('مشاركة'),
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _ReceiptInfoBox extends StatelessWidget {
  const _ReceiptInfoBox({
    required this.icon,
    required this.label,
    required this.value,
    required this.color,
    this.onCopy,
  });

  final IconData icon;
  final String label;
  final String value;
  final Color color;
  final VoidCallback? onCopy;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.all(13),
      decoration: BoxDecoration(
        color: colors.surface,
        border: Border.all(color: colors.outlineVariant),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, color: color, size: 20),
          const SizedBox(height: 9),
          Text(
            label,
            style: TextStyle(color: colors.onSurfaceVariant, fontSize: 11),
          ),
          const SizedBox(height: 3),
          Row(
            children: [
              Expanded(
                child: Text(
                  value,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  textDirection: ui.TextDirection.ltr,
                  style: TextStyle(
                    color: colors.onSurface,
                    fontWeight: FontWeight.w900,
                  ),
                ),
              ),
              if (onCopy != null)
                InkWell(
                  onTap: onCopy,
                  borderRadius: BorderRadius.circular(6),
                  child: const Padding(
                    padding: EdgeInsets.all(3),
                    child: Icon(Icons.content_copy_outlined, size: 16),
                  ),
                ),
            ],
          ),
        ],
      ),
    );
  }
}

class _ReceiptDetailRow extends StatelessWidget {
  const _ReceiptDetailRow({
    required this.icon,
    required this.label,
    required this.value,
    this.valueColor,
    this.onCopy,
    this.last = false,
  });

  final IconData icon;
  final String label;
  final String value;
  final Color? valueColor;
  final VoidCallback? onCopy;
  final bool last;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return DecoratedBox(
      decoration: BoxDecoration(
        border: last
            ? null
            : Border(bottom: BorderSide(color: colors.outlineVariant)),
      ),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 11),
        child: Row(
          children: [
            Icon(icon, size: 18, color: colors.onSurfaceVariant),
            const SizedBox(width: 9),
            Expanded(
              child: Text(
                label,
                style: TextStyle(color: colors.onSurfaceVariant, fontSize: 12),
              ),
            ),
            Flexible(
              child: Text(
                value,
                textAlign: TextAlign.end,
                style: TextStyle(
                  color: valueColor ?? colors.onSurface,
                  fontWeight: FontWeight.w800,
                  fontSize: 12,
                ),
              ),
            ),
            if (onCopy != null) ...[
              const SizedBox(width: 5),
              InkWell(
                onTap: onCopy,
                borderRadius: BorderRadius.circular(6),
                child: const Padding(
                  padding: EdgeInsets.all(3),
                  child: Icon(Icons.content_copy_outlined, size: 15),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _ReceiptImageUnavailable extends StatelessWidget {
  const _ReceiptImageUnavailable();

  @override
  Widget build(BuildContext context) {
    return const Padding(
      padding: EdgeInsets.all(28),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.broken_image_outlined, size: 42),
          SizedBox(height: 10),
          Text('تعذر تحميل صورة الإيصال حالياً.'),
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

  Future<void> _copyValue(
    BuildContext context,
    String value,
    String label,
  ) async {
    if (value.isEmpty || value == '-') return;
    await Clipboard.setData(ClipboardData(text: value));
    if (context.mounted) showSnack(context, 'تم نسخ $label.');
  }

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
              _TransactionReceiptPreview(transaction: transaction),
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
              PopupMenuButton<String>(
                tooltip: 'نسخ بيانات العملية',
                icon: Icon(
                  Icons.content_copy_outlined,
                  color: colors.onSurfaceVariant,
                ),
                onSelected: (value) {
                  if (value == 'operation') {
                    _copyValue(
                      context,
                      '${transaction['customId'] ?? transaction['txId'] ?? ''}',
                      'رقم العملية',
                    );
                  } else {
                    _copyValue(
                      context,
                      '${transaction['recipientNumber'] ?? ''}',
                      'رقم المستلم',
                    );
                  }
                },
                itemBuilder: (context) => const [
                  PopupMenuItem(
                    value: 'operation',
                    child: Text('نسخ رقم العملية'),
                  ),
                  PopupMenuItem(
                    value: 'recipient',
                    child: Text('نسخ رقم المستلم'),
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

class _TransactionReceiptPreview extends StatelessWidget {
  const _TransactionReceiptPreview({required this.transaction});

  final Map<String, dynamic> transaction;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final url = '${transaction['receiptUrl'] ?? ''}'.trim();
    final hasReceipt = transaction['hasProofImage'] == true && url.isNotEmpty;
    if (!hasReceipt) {
      final status = transaction['status']?.toString();
      return Container(
        width: 44,
        height: 44,
        decoration: BoxDecoration(
          color: statusColor(status).withValues(alpha: 0.11),
          borderRadius: BorderRadius.circular(8),
        ),
        child: Icon(Icons.receipt_long_outlined, color: statusColor(status)),
      );
    }

    return Semantics(
      label: 'صورة الإيصال متاحة',
      child: ClipRRect(
        borderRadius: BorderRadius.circular(8),
        child: Container(
          width: 44,
          height: 44,
          color: colors.surfaceContainerHighest,
          child: Image.network(
            url,
            fit: BoxFit.cover,
            errorBuilder: (_, _, _) =>
                Icon(Icons.receipt_long_outlined, color: colors.primary),
            loadingBuilder: (context, child, progress) {
              if (progress == null) return child;
              return const Center(
                child: SizedBox(
                  width: 16,
                  height: 16,
                  child: CircularProgressIndicator(strokeWidth: 2),
                ),
              );
            },
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
    final unread = numberValue(ticket['unreadCount']).round();
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
                  '${ticket['ticketId'] ?? '-'} · ${formatDate(ticket['updatedAt'] ?? ticket['createdAt'])}',
                  style: TextStyle(
                    color: colors.onSurfaceVariant,
                    fontSize: 11,
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
                Row(
                  children: [
                    StatusPill(
                      label: closed ? 'مغلقة' : 'مفتوحة',
                      color: closed ? _green : const Color(0xFF8A6200),
                    ),
                    if (unread > 0) ...[
                      const SizedBox(width: 7),
                      StatusPill(label: '$unread رد جديد', color: _green),
                    ],
                  ],
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
    final recipientRevealed = task['recipientRevealed'] == true && acceptedByMe;
    final amount = formatEgpAmount(numberValue(task['amount']));
    final notes = '${task['notes'] ?? ''}'.trim();
    final receivedAt = task['executorReceivedAt'] ?? task['createdAt'];
    return ExecutorSurface(
      accent: acceptedByMe
          ? ExecutorUiColors.jade
          : (takenByAnother ? ExecutorUiColors.amber : ExecutorUiColors.cobalt),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              ExecutorMetalIcon(
                icon: accepted
                    ? Icons.lock_open_rounded
                    : Icons.assignment_turned_in_outlined,
                color: acceptedByMe
                    ? ExecutorUiColors.jade
                    : ExecutorUiColors.cobalt,
                size: 46,
                selected: accepted,
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
            label: recipientRevealed
                ? (isCashWallet ? 'رقم هاتف العميل' : 'رقم حساب المستلم')
                : (isCashWallet ? 'بادئة رقم هاتف العميل' : 'بادئة رقم الحساب'),
            value: recipient,
            textDirection: ui.TextDirection.ltr,
            onCopy: !recipientRevealed || recipient == '-'
                ? null
                : () => _copyValue(context, recipient, 'الرقم'),
          ),
          if (!recipientRevealed) ...[
            const SizedBox(height: 8),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 9),
              decoration: BoxDecoration(
                color: AhramColors.sky.withValues(alpha: 0.08),
                borderRadius: BorderRadius.circular(8),
                border: Border.all(
                  color: AhramColors.sky.withValues(alpha: 0.20),
                ),
              ),
              child: Row(
                children: [
                  const Icon(
                    Icons.lock_person_outlined,
                    size: 18,
                    color: AhramColors.sky,
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      'يظهر الرقم كاملاً بعد قبول المهمة للمنفذ الذي سحبها فقط.',
                      style: TextStyle(
                        color: colors.onSurfaceVariant,
                        fontSize: 12,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ],
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
                borderRadius: BorderRadius.circular(8),
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
                borderRadius: BorderRadius.circular(8),
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
    this.action,
  });

  final IconData icon;
  final String title;
  final String message;
  final Widget? action;

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
            if (action != null) ...[const SizedBox(height: 12), action!],
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
