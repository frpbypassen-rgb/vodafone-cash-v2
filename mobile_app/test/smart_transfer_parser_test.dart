import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_app/company/smart_transfer_parser.dart';

void main() {
  test('extracts Arabic digits, phone, amount and explicit note', () {
    final parsed = parseTransferMessage(
      'حوّل ٠١٠١٢٣٤٥٦٧٨ مبلغ ١,٦٠٠ جنيه. ملاحظة: دفعة أحمد',
    );
    expect(parsed.phone, '01012345678');
    expect(parsed.amountEGP, 1600);
    expect(parsed.note, 'دفعة أحمد');
    expect(parsed.ready, isTrue);
    expect(parsed.confidence, 'high');
  });

  test('extracts an explicitly labelled beneficiary name', () {
    final parsed = parseTransferMessage(
      'سيفا 01012345678 مبلغ 250 اسم المستفيد: أحمد محمد علي | ملاحظة: دفعة شهرية',
    );
    expect(parsed.beneficiaryName, 'أحمد محمد علي');
    expect(parsed.serviceKey, 'sefa_niger');
  });

  test('accepts the common abbreviated Egyptian pound symbol', () {
    final parsed = parseTransferMessage(
      '01012345678 ١,٢٥٠ ج ملاحظة: توريد اليوم',
    );
    expect(parsed.phone, '01012345678');
    expect(parsed.amountEGP, 1250);
    expect(parsed.note, 'توريد اليوم');
    expect(parsed.ready, isTrue);
  });

  test(
    'recognizes the Arabic wallet, value and sequence collection template',
    () {
      final parsed = parseTransferMessage(
        '📌 التسلسل: 1716\n📱 رقم المحفظة: 01001352034\n💰 القيمة: 1000\n🔠 القيمة بالحروف: ألف جنيه',
      );
      expect(parsed.phone, '01001352034');
      expect(parsed.amountEGP, 1000);
      expect(parsed.note, 'التسلسل: 1716');
      expect(parsed.serviceKey, 'vodafone');
      expect(parsed.template, 'wallet_value_sequence');
      expect(parsed.ready, isTrue);
    },
  );

  test(
    'recognizes an alphanumeric sequence without confusing it with the amount',
    () {
      final parsed = parseTransferMessage(
        '📌 التسلسل : P1193\n📱 رقم المحفظة: ‎01214089875\n💰 القيمة: 1000',
      );
      expect(parsed.phone, '01214089875');
      expect(parsed.amountEGP, 1000);
      expect(parsed.note, 'التسلسل: P1193');
      expect(parsed.template, 'wallet_value_sequence');
      expect(parsed.ready, isTrue);
      expect(parsed.candidateAmounts, [1000]);
    },
  );

  test('recognizes a compact reference, wallet number and Egyptian amount', () {
    final parsed = parseTransferMessage('a0089\n01002186880\n2٫000مصري');
    expect(parsed.phone, '01002186880');
    expect(parsed.amountEGP, 2000);
    expect(parsed.note, 'a0089');
    expect(parsed.template, 'reference_wallet_amount');
    expect(parsed.ready, isTrue);
    expect(parsed.candidateAmounts, [2000]);
  });

  test('recognizes a numeric reference with Vodafone Cash', () {
    final parsed = parseTransferMessage('044\n01005160210\nفودفون كاش\n1350 ج');
    expect(parsed.phone, '01005160210');
    expect(parsed.amountEGP, 1350);
    expect(parsed.note, '044');
    expect(parsed.serviceKey, 'vodafone');
    expect(parsed.template, 'reference_wallet_amount');
    expect(parsed.ready, isTrue);
  });

  test('does not mark a two-phone message ready to send', () {
    final parsed = parseTransferMessage('01011111111 و 01022222222 مبلغ 500');
    expect(parsed.ready, isFalse);
    expect(parsed.confidence, 'review');
    expect(parsed.warnings.join(' '), contains('أكثر من رقم'));
  });

  test('requires review when a message contains two distinct amounts', () {
    final parsed = parseTransferMessage(
      '01011111111 مبلغ 500 جنيه ورسوم 20 جنيه ملاحظة اختبار',
    );
    expect(parsed.ready, isFalse);
    expect(parsed.candidateAmounts, containsAll([500, 20]));
    expect(parsed.warnings.join(' '), contains('أكثر من قيمة'));
  });
}
