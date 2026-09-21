const kQuickExecutePinSecurityNote =
    'تنبيه أمني: لشبكات اتصالات وأورنج ووي يظهر رقم سر المحفظة في شاشة الاتصال. لا تشارك الشاشة ولا تترك الهاتف دون مراقبة أثناء الاتصال.';

const kQuickExecuteNetworks = <String, String>{
  'vodafone': 'فودافون',
  'etisalat': 'اتصالات',
  'orange': 'أورنج',
  'we': 'وي',
};

String sanitizeQuickExecuteDigits(String? value) {
  final mapped = StringBuffer();
  for (final rune in (value ?? '').runes) {
    final char = String.fromCharCode(rune);
    const indic = '٠١٢٣٤٥٦٧٨٩';
    const eastern = '۰۱۲۳۴۵۶۷۸۹';
    final indicIndex = indic.indexOf(char);
    if (indicIndex >= 0) {
      mapped.write('$indicIndex');
      continue;
    }
    final easternIndex = eastern.indexOf(char);
    if (easternIndex >= 0) {
      mapped.write('$easternIndex');
      continue;
    }
    mapped.write(char);
  }
  return mapped.toString().replaceAll(RegExp(r'\D'), '');
}

String sanitizeQuickExecuteAmount(Object? value) {
  if (value is num && value.isFinite) {
    return value.round().abs().toString();
  }
  final mapped = StringBuffer();
  for (final rune in '$value'.replaceAll(',', '').runes) {
    final char = String.fromCharCode(rune);
    const indic = '٠١٢٣٤٥٦٧٨٩';
    const eastern = '۰۱۲۳۴۵۶۷۸۹';
    final indicIndex = indic.indexOf(char);
    if (indicIndex >= 0) {
      mapped.write('$indicIndex');
      continue;
    }
    final easternIndex = eastern.indexOf(char);
    if (easternIndex >= 0) {
      mapped.write('$easternIndex');
      continue;
    }
    if (RegExp(r'[\d.]').hasMatch(char)) mapped.write(char);
  }
  final parsed = num.tryParse(mapped.toString());
  if (parsed == null || parsed <= 0) return '';
  return parsed.round().toString();
}

String normalizeQuickExecuteNetwork(String? value) {
  final key = (value ?? '').trim().toLowerCase();
  return kQuickExecuteNetworks.containsKey(key) ? key : 'vodafone';
}

bool quickExecuteNetworkRequiresPin(String? network) {
  final key = normalizeQuickExecuteNetwork(network);
  return key == 'etisalat' || key == 'orange' || key == 'we';
}

String buildQuickExecuteUssd({
  required String network,
  required Object? phone,
  required Object? amount,
  String? pin,
}) {
  final carrier = normalizeQuickExecuteNetwork(network);
  final phoneDigits = sanitizeQuickExecuteDigits('$phone');
  final amountDigits = sanitizeQuickExecuteAmount(amount);
  if (phoneDigits.isEmpty) {
    throw const FormatException('رقم الهاتف غير صالح للتنفيذ السريع.');
  }
  if (amountDigits.isEmpty) {
    throw const FormatException('المبلغ غير صالح للتنفيذ السريع.');
  }
  final pinDigits = sanitizeQuickExecuteDigits(pin);
  if (quickExecuteNetworkRequiresPin(carrier) &&
      (pinDigits.length < 4 || pinDigits.length > 8)) {
    throw const FormatException('رقم سر المحفظة مطلوب لهذه الشبكة.');
  }
  switch (carrier) {
    case 'etisalat':
      return '*777*1*$pinDigits*$amountDigits*$phoneDigits*$phoneDigits#';
    case 'orange':
      return '*7115*7*$phoneDigits*$amountDigits*$pinDigits#';
    case 'we':
      return '*7*2*$phoneDigits*$amountDigits*$pinDigits#';
    default:
      return '*9*7*$phoneDigits*$amountDigits#';
  }
}

String redactUssdForLog(String ussd, String? pin) {
  final pinDigits = sanitizeQuickExecuteDigits(pin);
  if (pinDigits.isEmpty) return ussd;
  return ussd.split(pinDigits).join('[PIN]');
}

String toQuickExecuteTelUri(String ussd) {
  final decoded = ussd
      .replaceFirst(RegExp(r'^tel:', caseSensitive: false), '')
      .replaceAll('%2A', '*')
      .replaceAll('%2a', '*')
      .replaceAll('%23', '#');
  return 'tel:${decoded.replaceAll('*', '%2A').replaceAll('#', '%23')}';
}

bool taskOffersQuickExecute({
  required bool enabled,
  required String? transferType,
  bool acceptedByMe = false,
  bool assignedToMe = false,
  bool? canQuickExecute,
  bool? canClaimThenQuickExecute,
}) {
  if (!enabled) return false;
  if ((transferType ?? '').trim() != 'vodafone') return false;
  if (canQuickExecute == true || canClaimThenQuickExecute == true) return true;
  return acceptedByMe || assignedToMe;
}

class ExecutorQuickExecuteState {
  const ExecutorQuickExecuteState({
    this.enabled = false,
    this.network = 'vodafone',
    this.pinRequired = false,
    this.pinSet = false,
    this.securityNote = kQuickExecutePinSecurityNote,
  });

  factory ExecutorQuickExecuteState.fromJson(Map<String, dynamic>? json) {
    final source = json ?? const <String, dynamic>{};
    final network = normalizeQuickExecuteNetwork('${source['network'] ?? ''}');
    return ExecutorQuickExecuteState(
      enabled: source['enabled'] == true,
      network: network,
      pinRequired: source['pinRequired'] == true ||
          quickExecuteNetworkRequiresPin(network),
      pinSet: source['pinSet'] == true,
      securityNote: '${source['securityNote'] ?? kQuickExecutePinSecurityNote}',
    );
  }

  final bool enabled;
  final String network;
  final bool pinRequired;
  final bool pinSet;
  final String securityNote;

  String get networkLabel => kQuickExecuteNetworks[network] ?? 'فودافون';
}
