import 'package:flutter/material.dart';

import '../brand_theme.dart';

class CompanyServiceChoice {
  const CompanyServiceChoice({required this.serviceKey, this.subtype});

  final String serviceKey;
  final String? subtype;
}

class CompanyServiceChannel {
  const CompanyServiceChannel({
    required this.key,
    required this.title,
    required this.subtitle,
    required this.icon,
    required this.color,
    this.subtypes = const [],
  });

  final String key;
  final String title;
  final String subtitle;
  final IconData icon;
  final Color color;
  final List<CompanyServiceChoice> subtypes;
}

const companyServiceChannels = <CompanyServiceChannel>[
  CompanyServiceChannel(
    key: 'vodafone',
    title: 'محافظ كاش',
    subtitle: 'منضدة مستقلة للمحفظة المصرية',
    icon: Icons.account_balance_wallet_outlined,
    color: AhramColors.emerald,
  ),
  CompanyServiceChannel(
    key: 'post_account',
    title: 'بريد حساب',
    subtitle: 'تحويل إلى الحساب البريدي فقط',
    icon: Icons.account_balance_outlined,
    color: AhramColors.sky,
  ),
  CompanyServiceChannel(
    key: 'post_card',
    title: 'بريد بطاقة',
    subtitle: 'تحويل بالرقم القومي وصورة الهوية',
    icon: Icons.credit_card_outlined,
    color: Color(0xFF1769E0),
  ),
  CompanyServiceChannel(
    key: 'bank_account',
    title: 'حساب بنكي',
    subtitle: 'تحويل بنكي أو إنستا باي',
    icon: Icons.account_balance_outlined,
    color: AhramColors.gold,
    subtypes: [
      CompanyServiceChoice(
        serviceKey: 'bank_account',
        subtype: 'bank_transfer',
      ),
      CompanyServiceChoice(serviceKey: 'bank_account', subtype: 'instapay'),
    ],
  ),
  CompanyServiceChannel(
    key: 'sefa_niger',
    title: 'سيفا النيجر',
    subtitle: 'NITA أو NITA ACCOUNT',
    icon: Icons.language_outlined,
    color: Color(0xFF158A9B),
    subtypes: [
      CompanyServiceChoice(serviceKey: 'sefa_niger', subtype: 'nita'),
      CompanyServiceChoice(serviceKey: 'sefa_niger', subtype: 'nita_account'),
    ],
  ),
  CompanyServiceChannel(
    key: 'bankak_sudan',
    title: 'بنكك السودان',
    subtitle: 'تحويل إلى حساب بنكك',
    icon: Icons.currency_exchange_outlined,
    color: AhramColors.danger,
  ),
];

String companyDepositSupportMessage({
  required double amount,
  required String note,
}) {
  return 'طلب إيداع رصيد\nالقيمة: ${amount.toStringAsFixed(2)} LYD\nالملاحظة: $note';
}
