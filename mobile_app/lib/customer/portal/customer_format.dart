import 'package:flutter/material.dart';

import '../../brand_theme.dart';

String customerFormatAmount(num? value, {int fractionDigits = 2}) {
  if (value == null) return '0';
  return value
      .toStringAsFixed(fractionDigits)
      .replaceAllMapped(
        RegExp(r'(\d{1,3})(?=(\d{3})+(?!\d))'),
        (match) => '${match[1]},',
      );
}

String customerFormatEgp(num? value) =>
    customerFormatAmount(value, fractionDigits: 0);

double customerNumber(dynamic value, [double fallback = 0]) {
  if (value == null) return fallback;
  if (value is num) return value.toDouble();
  return double.tryParse('$value'.replaceAll(',', '')) ?? fallback;
}

String customerStatusLabel(String? status) {
  return switch ('${status ?? ''}'.trim().toLowerCase()) {
    'completed' => 'ناجحة',
    'pending' => 'قيد التنفيذ',
    'accepted' => 'مقبولة',
    'assigned' => 'مُسندة',
    'processing' || 'in_progress' => 'جاري التنفيذ',
    'rejected' || 'failed' => 'مرفوضة',
    'cancelled' || 'canceled' || 'cancelled_by_admin' => 'ملغاة',
    _ => status?.trim().isNotEmpty == true ? status!.trim() : 'غير معروف',
  };
}

Color customerStatusColor(String? status) {
  return switch ('${status ?? ''}'.trim().toLowerCase()) {
    'completed' => AhramColors.emerald,
    'pending' ||
    'accepted' ||
    'assigned' ||
    'processing' ||
    'in_progress' =>
      AhramColors.gold,
    'rejected' || 'failed' || 'cancelled' || 'canceled' => AhramColors.danger,
    _ => AhramColors.inkSoft,
  };
}

String customerServiceLabel(String? key) {
  return switch ('${key ?? ''}'.trim().toLowerCase()) {
    'vodafone' => 'محافظ كاش',
    'post_account' => 'بريد حساب',
    'post_card' => 'بريد بطاقة',
    'bank_account' => 'تحويل بنكي',
    'bankak_sudan' => 'بنكك',
    'sefa_niger' => 'سيفا',
    'balance_transfer' => 'تحويل رصيد',
    _ => key?.trim().isNotEmpty == true ? key!.trim() : 'خدمة',
  };
}
