import 'package:flutter/material.dart';

import 'auth/heritage_palette.dart';

enum RegistrationAccountType {
  direct('عميل مباشر', 'حساب فردي لإجراء التحويلات', Icons.person_outline),
  company('شركة', 'حساب لإدارة معاملات الشركة', Icons.business_outlined),
  agent('وكيل', 'حساب لإدارة معاملات عملائك', Icons.work_outline),
  newClient('عميل تابع', 'حساب مرتبط بوكيل', Icons.group_add_outlined);

  const RegistrationAccountType(this.title, this.subtitle, this.icon);

  final String title;
  final String subtitle;
  final IconData icon;
}

class RegistrationTypePicker extends StatelessWidget {
  const RegistrationTypePicker({super.key, required this.onSelect});

  final ValueChanged<RegistrationAccountType> onSelect;

  @override
  Widget build(BuildContext context) {
    final palette = HeritagePalette.of(context);
    return Directionality(
      textDirection: TextDirection.rtl,
      child: Scaffold(
        backgroundColor: palette.background,
        body: SafeArea(
          child: Align(
            alignment: Alignment.topCenter,
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 520),
              child: SingleChildScrollView(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    SizedBox(
                      height: 148,
                      child: Stack(
                        fit: StackFit.expand,
                        children: [
                          Image.asset(
                            'assets/images/pharaonic-login-hero.jpg',
                            fit: BoxFit.cover,
                            alignment: const Alignment(0, -.28),
                            excludeFromSemantics: true,
                          ),
                          const ColoredBox(color: Color(0x7706182C)),
                          const Center(
                            child: Text(
                              'AHRAM PAY',
                              textDirection: TextDirection.ltr,
                              textAlign: TextAlign.center,
                              style: TextStyle(
                                fontSize: 22,
                                letterSpacing: 2,
                                color: HeritagePalette.gold,
                                fontWeight: FontWeight.w800,
                              ),
                            ),
                          ),
                          PositionedDirectional(
                            top: 4,
                            start: 4,
                            child: IconButton(
                              tooltip: 'العودة',
                              color: HeritagePalette.ivory,
                              onPressed: () => Navigator.maybePop(context),
                              icon: const BackButtonIcon(),
                            ),
                          ),
                        ],
                      ),
                    ),
                    Padding(
                      padding: const EdgeInsets.fromLTRB(20, 18, 20, 12),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          Semantics(
                            header: true,
                            child: Text(
                              'إنشاء حساب',
                              textAlign: TextAlign.center,
                              style: TextStyle(
                                color: palette.text,
                                fontSize: 28,
                                fontWeight: FontWeight.w900,
                              ),
                            ),
                          ),
                          Text(
                            'اختر نوع الحساب للمتابعة',
                            textAlign: TextAlign.center,
                            style: TextStyle(color: palette.muted),
                          ),
                          const SizedBox(height: 16),
                          for (final type in RegistrationAccountType.values)
                            Padding(
                              padding: const EdgeInsets.only(bottom: 10),
                              child: _RegistrationTypeCard(
                                type: type,
                                palette: palette,
                                onTap: () => onSelect(type),
                              ),
                            ),
                          TextButton(
                            onPressed: () => Navigator.maybePop(context),
                            style: TextButton.styleFrom(
                              foregroundColor: palette.accent,
                              minimumSize: const Size(48, 48),
                            ),
                            child: const Text('العودة لتسجيل الدخول'),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _RegistrationTypeCard extends StatelessWidget {
  const _RegistrationTypeCard({
    required this.type,
    required this.palette,
    required this.onTap,
  });

  final RegistrationAccountType type;
  final HeritagePalette palette;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final shape = RoundedRectangleBorder(
      borderRadius: BorderRadius.circular(16),
      side: BorderSide(color: palette.border),
    );
    return Material(
      color: palette.surface,
      shape: shape,
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
          child: Row(
            children: [
              Container(
                width: 44,
                height: 44,
                decoration: BoxDecoration(
                  color: HeritagePalette.gold.withValues(alpha: .26),
                  borderRadius: BorderRadius.circular(10),
                ),
                child: Icon(type.icon, color: palette.accent),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      type.title,
                      style: TextStyle(
                        color: palette.text,
                        fontSize: 17,
                        fontWeight: FontWeight.w900,
                      ),
                    ),
                    Text(
                      type.subtitle,
                      style: TextStyle(color: palette.muted, fontSize: 13),
                    ),
                  ],
                ),
              ),
              Icon(Icons.chevron_left, color: palette.accent),
            ],
          ),
        ),
      ),
    );
  }
}
