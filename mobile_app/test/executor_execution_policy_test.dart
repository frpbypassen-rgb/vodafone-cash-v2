import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_app/executor_execution_policy.dart';

void main() {
  test('parses company policy and validates allowed sender digit lengths', () {
    final threeOnly = ExecutorExecutionPolicy.fromJson(const <String, dynamic>{
      'phoneLengthMode': '3',
      'allowedPhoneLengths': <int>[3],
      'proofRequired': true,
    });
    expect(threeOnly.validateDigits('258', isSplit: false), isNull);
    expect(threeOnly.validateDigits('2258', isSplit: false), isNotNull);
    expect(threeOnly.proofRequired, isTrue);
    expect(threeOnly.maxDigitLength, 3);

    final allAllowed = ExecutorExecutionPolicy.fromJson(const <String, dynamic>{
      'phoneLengthMode': 'all',
      'allowedPhoneLengths': <int>[3, 4, 11],
    });
    expect(allAllowed.validateDigits('258', isSplit: false), isNull);
    expect(allAllowed.validateDigits('2258', isSplit: false), isNull);
    expect(allAllowed.validateDigits('01108172258', isSplit: false), isNull);
    expect(allAllowed.maxDigitLength, 11);
  });

  test('inherits company policy unless an override payload is saved', () {
    final inherited = ExecutorExecutionPolicy.fromJson(const <String, dynamic>{
      'inherited': <String, dynamic>{
        'proofRequired': true,
        'allowedPhoneLengths': true,
        'maxConcurrentDevices': true,
        'sessionTtl': true,
      },
    });
    expect(inherited.inheritsCompanyPolicy, isTrue);
    expect(
      inherited.toSavePayload(inheritCompanyPolicy: true),
      equals(const <String, dynamic>{'inheritCompanyPolicy': true}),
    );

    final override = ExecutorExecutionPolicy.fromJson(const <String, dynamic>{
      'phoneLengthMode': '11',
      'allowedPhoneLengths': <int>[11],
      'proofRequired': false,
      'maxConcurrentDevices': 5,
      'sessionTtlEnabled': false,
      'inherited': <String, dynamic>{'proofRequired': false},
    });
    expect(override.inheritsCompanyPolicy, isFalse);
    final payload = override.toSavePayload(inheritCompanyPolicy: false);
    expect(payload['phoneLengthMode'], '11');
    expect(payload['maxConcurrentDevices'], 5);
    expect(payload['sessionTtlEnabled'], isFalse);
  });
}
