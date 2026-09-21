class ExecutorExecutionPolicy {
  const ExecutorExecutionPolicy({
    this.proofRequired = false,
    this.allowedPhoneLengths = const <int>[3, 4, 11],
    this.phoneLengthMode = 'all',
    this.splitRequiresFullPhone = true,
    this.maxConcurrentDevices = 1,
    this.sessionTtlEnabled = false,
    this.sessionTtlSeconds,
    this.quickExecuteEnabled = false,
    this.inherited,
  });

  factory ExecutorExecutionPolicy.fromJson(Map<String, dynamic>? json) {
    final source = json ?? const <String, dynamic>{};
    final rawLengths = source['allowedPhoneLengths'];
    final lengths = rawLengths is List
        ? rawLengths
              .map((value) => int.tryParse('$value') ?? 0)
              .where((value) => value == 3 || value == 4 || value == 11)
              .toSet()
              .toList()
        : const <int>[];
    final normalizedLengths = <int>[
      ...(lengths.isEmpty ? const <int>[3, 4, 11] : lengths),
    ]..sort();
    final inherited = source['inherited'];
    return ExecutorExecutionPolicy(
      proofRequired: source['proofRequired'] == true,
      allowedPhoneLengths: normalizedLengths,
      phoneLengthMode: '${source['phoneLengthMode'] ?? ''}'.trim().isEmpty
          ? _modeFromLengths(lengths.isEmpty ? const <int>[3, 4, 11] : lengths)
          : '${source['phoneLengthMode']}',
      splitRequiresFullPhone: source['splitRequiresFullPhone'] != false,
      maxConcurrentDevices: _clampDevices(source['maxConcurrentDevices']),
      sessionTtlEnabled: source['sessionTtlEnabled'] == true,
      sessionTtlSeconds: source['sessionTtlEnabled'] == true
          ? _clampTtl(source['sessionTtlSeconds'])
          : null,
      quickExecuteEnabled: source['quickExecuteEnabled'] == true,
      inherited: inherited is Map
          ? Map<String, dynamic>.from(inherited)
          : null,
    );
  }

  final bool proofRequired;
  final List<int> allowedPhoneLengths;
  final String phoneLengthMode;
  final bool splitRequiresFullPhone;
  final int maxConcurrentDevices;
  final bool sessionTtlEnabled;
  final int? sessionTtlSeconds;
  final bool quickExecuteEnabled;
  final Map<String, dynamic>? inherited;

  bool get inheritsCompanyPolicy {
    final flags = inherited;
    if (flags == null) return true;
    return flags['proofRequired'] != false &&
        flags['allowedPhoneLengths'] != false &&
        flags['maxConcurrentDevices'] != false &&
        flags['sessionTtl'] != false &&
        flags['quickExecute'] != false;
  }

  int get maxDigitLength => allowedPhoneLengths.reduce(
    (current, next) => current > next ? current : next,
  );

  String get lengthsHint {
    if (allowedPhoneLengths.length == 1) {
      return '${allowedPhoneLengths.first} رقماً';
    }
    return '${allowedPhoneLengths.join(' أو ')} أرقام';
  }

  String get executionNumberLabel => 'رقم التنفيذ ($lengthsHint) *';

  String senderPhoneLabel(int index) =>
      'رقم المرسل ${index + 1} ($lengthsHint)';

  String? validateDigits(String value, {required bool isSplit}) {
    final digits = value.replaceAll(RegExp(r'\D'), '');
    if (digits.isEmpty) return 'رقم المرسل مطلوب.';
    if (isSplit && splitRequiresFullPhone) {
      return RegExp(r'^01\d{9}$').hasMatch(digits)
          ? null
          : 'عند تقسيم العملية يجب إدخال 11 رقمًا كاملة.';
    }
    if (!allowedPhoneLengths.contains(digits.length)) {
      return 'طول الرقم غير مسموح. المسموح: $lengthsHint.';
    }
    if (digits.length == 11 && !RegExp(r'^01\d{9}$').hasMatch(digits)) {
      return 'رقم الهاتف الكامل يجب أن يبدأ بـ 01 ويتكون من 11 رقماً.';
    }
    return null;
  }

  Map<String, dynamic> toSavePayload({required bool inheritCompanyPolicy}) {
    if (inheritCompanyPolicy) {
      return const <String, dynamic>{'inheritCompanyPolicy': true};
    }
    return <String, dynamic>{
      'inheritCompanyPolicy': false,
      'inheritProofRequired': false,
      'inheritPhoneLengths': false,
      'inheritMaxConcurrentDevices': false,
      'inheritSessionTtl': false,
      'inheritQuickExecute': false,
      'phoneLengthMode': phoneLengthMode,
      'proofRequired': proofRequired,
      'quickExecuteEnabled': quickExecuteEnabled,
      'maxConcurrentDevices': maxConcurrentDevices,
      'sessionTtlEnabled': sessionTtlEnabled,
      if (sessionTtlEnabled) 'sessionTtlSeconds': sessionTtlSeconds,
    };
  }

  static String _modeFromLengths(List<int> lengths) {
    if (lengths.length == 1) return '${lengths.first}';
    return 'all';
  }

  static int _clampDevices(Object? value) {
    final parsed = int.tryParse('$value') ?? 1;
    if (parsed < 1) return 1;
    if (parsed > 20) return 20;
    return parsed;
  }

  static int _clampTtl(Object? value) {
    final parsed = int.tryParse('$value') ?? 28800;
    if (parsed < 900) return 900;
    if (parsed > 2592000) return 2592000;
    return parsed;
  }
}
