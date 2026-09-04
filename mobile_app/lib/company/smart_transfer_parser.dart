class SmartTransferDraft {
  const SmartTransferDraft({
    required this.phone,
    required this.amountEGP,
    required this.note,
    required this.beneficiaryName,
    required this.serviceKey,
    required this.ready,
    required this.missing,
    required this.warnings,
    required this.confidence,
    required this.template,
    required this.candidatePhones,
    required this.candidateAmounts,
  });

  final String phone;
  final double? amountEGP;
  final String note;
  final String beneficiaryName;
  final String? serviceKey;
  final bool ready;
  final List<String> missing;
  final List<String> warnings;
  final String confidence;
  final String template;
  final List<String> candidatePhones;
  final List<double> candidateAmounts;
}

const _maxMessageLength = 2000;
const _maxNoteLength = 500;

final _servicePatterns = <({String key, RegExp pattern})>[
  (
    key: 'sefa_niger',
    pattern: RegExp(
      r'(?:سيفا|النيجر|nita(?:\s+account)?)',
      caseSensitive: false,
      unicode: true,
    ),
  ),
  (
    key: 'bankak_sudan',
    pattern: RegExp(r'(?:بنكك|السودان)', caseSensitive: false, unicode: true),
  ),
  (
    key: 'post_card',
    pattern: RegExp(
      r'(?:بريد\s*بطاق(?:ة|ه)|بطاق(?:ة|ه)\s*بريد)',
      caseSensitive: false,
      unicode: true,
    ),
  ),
  (
    key: 'post_account',
    pattern: RegExp(
      r'(?:بريد\s*حساب|حساب\s*بريد(?:ي)?)',
      caseSensitive: false,
      unicode: true,
    ),
  ),
  (
    key: 'bank_account',
    pattern: RegExp(
      r'(?:حساب\s*بنكي|تحويل\s*بنكي|\biban\b)',
      caseSensitive: false,
      unicode: true,
    ),
  ),
  (
    key: 'vodafone',
    pattern: RegExp(
      r'(?:محفظ(?:ة|ه)|فودافون|فودفون|اتصالات|اورنج|أورنج|وي|كاش)',
      caseSensitive: false,
      unicode: true,
    ),
  ),
];

final _amountPatterns = <RegExp>[
  RegExp(
    r'(?:المبلغ|مبلغ|القيمة|قيمة)\s*(?:هو|:|=|-)?\s*([0-9]+(?:[ \t.,][0-9]+)*)',
    caseSensitive: false,
    unicode: true,
  ),
  RegExp(
    r'([0-9]+(?:[ \t.,][0-9]+)*)\s*(?:جنيه(?:ات)?|جنية|جنيه\s*مصري|ج\.?\s*م\.?|ج|مصري|مصرى|egp|egyptian\s*pounds?)',
    caseSensitive: false,
    unicode: true,
  ),
  RegExp(
    r'(?:egp|جنيه(?:ات)?|جنية|جنيه\s*مصري|ج\.?\s*م\.?|ج|مصري|مصرى|egyptian\s*pounds?)\s*(?:هو|:|=|-)?\s*([0-9]+(?:[ \t.,][0-9]+)*)',
    caseSensitive: false,
    unicode: true,
  ),
];

final _phonePattern = RegExp(
  r'(?<!\d)(?:\+?20|0020)?[\s().-]*0?1[0125](?:[\s().-]*\d){8}(?!\d)',
  unicode: true,
);

String normalizeDigits(String value) {
  const eastern = '٠١٢٣٤٥٦٧٨٩';
  const persian = '۰۱۲۳۴۵۶۷۸۹';
  final buffer = StringBuffer();
  for (final rune in value.runes) {
    final char = String.fromCharCode(rune);
    final easternIndex = eastern.indexOf(char);
    if (easternIndex >= 0) {
      buffer.write(easternIndex);
      continue;
    }
    final persianIndex = persian.indexOf(char);
    if (persianIndex >= 0) {
      buffer.write(persianIndex);
      continue;
    }
    if (rune == 0x066B) {
      buffer.write('.');
      continue;
    }
    if (rune == 0x066C) {
      buffer.write(',');
      continue;
    }
    buffer.write(char);
  }
  return buffer.toString();
}

double? normalizeAmountToken(String? rawToken) {
  var token = normalizeDigits(
    rawToken ?? '',
  ).replaceAll(RegExp(r'[ \t]'), '').replaceAll(RegExp(r'[^0-9.,]'), '');
  if (token.isEmpty) return null;

  final commaIndex = token.lastIndexOf(',');
  final dotIndex = token.lastIndexOf('.');
  final decimalIndex = commaIndex > dotIndex ? commaIndex : dotIndex;
  if (decimalIndex >= 0) {
    final decimalLength = token.length - decimalIndex - 1;
    if (decimalLength == 1 || decimalLength == 2) {
      final integerPart = token
          .substring(0, decimalIndex)
          .replaceAll(RegExp(r'[.,]'), '');
      final decimalPart = token
          .substring(decimalIndex + 1)
          .replaceAll(RegExp(r'[.,]'), '');
      token = '$integerPart.$decimalPart';
    } else {
      token = token.replaceAll(RegExp(r'[.,]'), '');
    }
  }

  final value = double.tryParse(token);
  if (value == null || value <= 0 || value > 100000000) return null;
  return double.parse(value.toStringAsFixed(2));
}

class _PhoneHit {
  const _PhoneHit({required this.value, required this.source});

  final String value;
  final String source;
}

class _AmountHit {
  const _AmountHit({
    required this.value,
    required this.source,
    required this.candidates,
  });

  final double? value;
  final String source;
  final List<double> candidates;
}

List<_PhoneHit> _findPhones(String text) {
  final found = <_PhoneHit>[];
  for (final match in _phonePattern.allMatches(text)) {
    var digits = match.group(0)!.replaceAll(RegExp(r'\D'), '');
    if (digits.startsWith('0020')) {
      digits = digits.substring(4);
    } else if (digits.startsWith('20')) {
      digits = digits.substring(2);
    }
    if (RegExp(r'^1[0125]\d{8}$').hasMatch(digits)) {
      digits = '0$digits';
    }
    if (RegExp(r'^01[0125]\d{8}$').hasMatch(digits) &&
        found.every((item) => item.value != digits)) {
      found.add(_PhoneHit(value: digits, source: match.group(0)!));
    }
  }
  return found;
}

_AmountHit _findAmount(String text, List<_PhoneHit> phones) {
  final labelled = <({double value, String source})>[];
  for (final pattern in _amountPatterns) {
    for (final match in pattern.allMatches(text)) {
      final value = normalizeAmountToken(match.group(1));
      if (value != null && labelled.every((item) => item.value != value)) {
        labelled.add((value: value, source: match.group(0)!));
      }
    }
  }
  if (labelled.isNotEmpty) {
    return _AmountHit(
      value: labelled.first.value,
      source: labelled.first.source,
      candidates: labelled.map((item) => item.value).toList(),
    );
  }

  var fallbackText = text;
  for (final phone in phones) {
    fallbackText = fallbackText.replaceFirst(phone.source, ' ');
  }
  fallbackText = fallbackText.replaceAll(
    RegExp(
      r'(?:ملاحظ(?:ة|ه|ات)|ملحوظ(?:ة|ه|ات)|note)\s*[:：=\-]?\s*[^\r\n]+',
      caseSensitive: false,
      unicode: true,
    ),
    ' ',
  );
  final numericTokens = RegExp(r'\d+(?:[.,]\d+)*')
      .allMatches(fallbackText)
      .map(
        (match) =>
            (raw: match.group(0)!, value: normalizeAmountToken(match.group(0))),
      )
      .where((candidate) => candidate.value != null)
      .toList();
  final likelyAmounts = <({String raw, double value})>[];
  for (final candidate in numericTokens) {
    final value = candidate.value!;
    if (value >= 10 &&
        candidate.raw.replaceAll(RegExp(r'\D'), '').length <= 9) {
      if (likelyAmounts.every((item) => item.value != value)) {
        likelyAmounts.add((raw: candidate.raw, value: value));
      }
    }
  }
  if (likelyAmounts.isEmpty) {
    return const _AmountHit(value: null, source: '', candidates: []);
  }
  return _AmountHit(
    value: likelyAmounts.first.value,
    source: likelyAmounts.first.raw,
    candidates: likelyAmounts.map((item) => item.value).toList(),
  );
}

String? _detectService(String text) {
  for (final service in _servicePatterns) {
    if (service.pattern.hasMatch(text)) return service.key;
  }
  return null;
}

String _cleanNote(String? value) {
  return (value ?? '')
      .replaceAll(RegExp(r'^[\s:：=\-–—|،,.;]+|[\s:：=\-–—|،,.;]+$'), '')
      .replaceAll(RegExp(r'[ \t]{2,}'), ' ')
      .trim()
      .charactersTake(_maxNoteLength);
}

extension on String {
  String charactersTake(int count) {
    if (length <= count) return this;
    return substring(0, count);
  }
}

String _findSequenceNote(String text) {
  final match = RegExp(
    r'(?:📌\s*)?(?:التسلسل|تسلسل|serial|reference|ref)\s*[:：=\-]?\s*([A-Z0-9][A-Z0-9_\-/]{0,79})',
    caseSensitive: false,
    unicode: true,
  ).firstMatch(text);
  return match == null ? '' : 'التسلسل: ${match.group(1)}';
}

String _findLeadingReferenceNote(String text) {
  final lines = text
      .split(RegExp(r'\r?\n'))
      .map(_cleanNote)
      .where((line) => line.isNotEmpty)
      .toList();
  if (lines.length < 3) return '';
  final reference = lines.first;
  final hasPhoneAfterReference = lines
      .skip(1)
      .any((line) => _findPhones(line).isNotEmpty);
  final hasCurrencyAmountAfterReference = lines
      .skip(1)
      .any((line) => _amountPatterns.any((pattern) => pattern.hasMatch(line)));
  if (hasPhoneAfterReference &&
      hasCurrencyAmountAfterReference &&
      RegExp(
        r'^[A-Z]*\d{1,20}$',
        caseSensitive: false,
        unicode: true,
      ).hasMatch(reference)) {
    return reference;
  }
  return '';
}

String _detectMessageTemplate(String text) {
  final hasWallet = RegExp(
    r'رقم\s*(?:المحفظة|الهاتف|الموبايل)',
    caseSensitive: false,
    unicode: true,
  ).hasMatch(text);
  final hasValue = RegExp(
    r'(?:القيمة|مبلغ|المبلغ)\s*[:：=\-]',
    caseSensitive: false,
    unicode: true,
  ).hasMatch(text);
  final hasSequence = RegExp(
    r'(?:التسلسل|تسلسل)\s*[:：=\-]',
    caseSensitive: false,
    unicode: true,
  ).hasMatch(text);
  if (hasWallet && hasValue && hasSequence) return 'wallet_value_sequence';
  return _findLeadingReferenceNote(text).isNotEmpty
      ? 'reference_wallet_amount'
      : 'free_form';
}

String _findNote(String text, List<String> phoneSources, String amountSource) {
  final explicit = RegExp(
    r'(?:ملاحظ(?:ة|ه|ات)|ملحوظ(?:ة|ه|ات)|note)\s*[:：=\-]?\s*([^\r\n]+)',
    caseSensitive: false,
    unicode: true,
  ).firstMatch(text);
  if (explicit != null) return _cleanNote(explicit.group(1));
  final sequenceNote = _findSequenceNote(text);
  if (sequenceNote.isNotEmpty) return sequenceNote;
  final referenceNote = _findLeadingReferenceNote(text);
  if (referenceNote.isNotEmpty) return referenceNote;

  var remainder = text;
  for (final source in phoneSources.where((item) => item.isNotEmpty)) {
    remainder = remainder.replaceFirst(source, ' ');
  }
  if (amountSource.isNotEmpty) {
    remainder = remainder.replaceFirst(amountSource, ' ');
  }
  remainder = remainder
      .replaceAll(
        RegExp(
          r'(?:المبلغ|مبلغ|القيمة|قيمة|رقم\s*(?:الهاتف|الموبايل|المحفظة)|هاتف|موبايل)',
          caseSensitive: false,
          unicode: true,
        ),
        ' ',
      )
      .replaceAll(
        RegExp(
          r'(?:جنيه(?:ات)?|جنية|جنيه\s*مصري|ج\.?\s*م\.?|ج|egp)',
          caseSensitive: false,
          unicode: true,
        ),
        ' ',
      )
      .replaceAll(
        RegExp(
          r'(?:حول|حوّل|تحويل|ارسال|إرسال|الى|إلى|على|من\s*فضلك|لو\s*سمحت)',
          caseSensitive: false,
          unicode: true,
        ),
        ' ',
      )
      .replaceAll(
        RegExp(
          r'(?:محفظ(?:ة|ه)|فودافون|فودفون|اتصالات|اورنج|أورنج|وي|كاش|بريد\s*حساب|بريد\s*بطاق(?:ة|ه)|حساب\s*بنكي|سيفا|النيجر|nita|بنكك|السودان)',
          caseSensitive: false,
          unicode: true,
        ),
        ' ',
      )
      .replaceAll(RegExp(r'[\r\n]+'), ' ');
  return _cleanNote(remainder);
}

String _findBeneficiaryName(String text) {
  final explicit = RegExp(
    r'(?:اسم\s*(?:المستفيد|العميل)|المستفيد|recipient|name)\s*[:：=\-]\s*([^\r\n|،]+)',
    caseSensitive: false,
    unicode: true,
  ).firstMatch(text);
  if (explicit == null) return '';
  return _cleanNote(
    explicit
        .group(1)!
        .replaceAll(
          RegExp(
            r'(?:ملاحظ(?:ة|ه)|ملحوظ(?:ة|ه)|note)\s*[:：=\-]?.*$',
            caseSensitive: false,
            unicode: true,
          ),
          '',
        )
        .replaceAll(
          RegExp(
            r'(?:المبلغ|مبلغ|القيمة|قيمة)\s*[:：=\-]?.*$',
            caseSensitive: false,
            unicode: true,
          ),
          '',
        ),
  );
}

SmartTransferDraft parseTransferMessage(String rawMessage) {
  final message = normalizeDigits(rawMessage).replaceAll('\r\n', '\n').trim();
  final clipped = message.length > _maxMessageLength
      ? message.substring(0, _maxMessageLength)
      : message;
  final phones = _findPhones(clipped);
  final phone = phones.isEmpty
      ? const _PhoneHit(value: '', source: '')
      : phones.first;
  final amount = _findAmount(clipped, phones);
  final note = _findNote(
    clipped,
    phones.map((item) => item.source).toList(),
    amount.source,
  );
  final beneficiaryName = _findBeneficiaryName(clipped);
  final serviceKey = _detectService(clipped);
  final template = _detectMessageTemplate(clipped);
  final missing = <String>[
    if (phone.value.isEmpty) 'رقم الهاتف',
    if (amount.value == null) 'المبلغ بالجنيه',
  ];
  final warnings = <String>[
    if (phones.length > 1)
      'توجد أكثر من رقم هاتف؛ تم اختيار الرقم الأول. راجعه قبل الإرسال.',
    if (amount.candidates.length > 1)
      'توجد أكثر من قيمة مالية؛ تم اختيار أول مبلغ. راجعه قبل الإرسال.',
    if (serviceKey == null)
      'لم يتم تحديد خدمة التحويل؛ تم اختيار محافظ كاش ويمكنك تغييرها.',
    if (note.isEmpty)
      'لم يتم العثور على ملاحظة؛ يمكنك إضافة ملاحظة اختيارية قبل الإرسال.',
  ];
  final confidence = missing.isNotEmpty
      ? 'low'
      : (phones.length > 1 || amount.candidates.length > 1 ? 'review' : 'high');

  return SmartTransferDraft(
    phone: phone.value,
    amountEGP: amount.value,
    note: note,
    beneficiaryName: beneficiaryName,
    serviceKey: serviceKey,
    ready:
        missing.isEmpty && phones.length <= 1 && amount.candidates.length <= 1,
    missing: missing,
    warnings: warnings,
    confidence: confidence,
    template: template,
    candidatePhones: phones.map((item) => item.value).toList(),
    candidateAmounts: amount.candidates,
  );
}
