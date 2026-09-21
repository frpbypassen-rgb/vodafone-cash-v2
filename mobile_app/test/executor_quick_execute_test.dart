import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_app/executor_quick_execute.dart';

void main() {
  test('builds carrier USSD strings and redacts PIN in debug helpers', () {
    const phone = '01108172258';
    const amount = 250;
    const pin = '1234';

    expect(
      buildQuickExecuteUssd(network: 'vodafone', phone: phone, amount: amount, pin: pin),
      '*9*7*01108172258*250#',
    );
    expect(
      buildQuickExecuteUssd(network: 'etisalat', phone: phone, amount: amount, pin: pin),
      '*777*1*1234*250*01108172258*01108172258#',
    );
    expect(
      buildQuickExecuteUssd(network: 'orange', phone: phone, amount: amount, pin: pin),
      '*7115*7*01108172258*250*1234#',
    );
    expect(
      buildQuickExecuteUssd(network: 'we', phone: phone, amount: amount, pin: pin),
      '*7*2*01108172258*250*1234#',
    );

    final redacted = redactUssdForLog(
      buildQuickExecuteUssd(network: 'orange', phone: phone, amount: amount, pin: pin),
      pin,
    );
    expect(redacted.contains(pin), isFalse);
    expect(redacted.contains('[PIN]'), isTrue);
    expect(
      toQuickExecuteTelUri('*9*7*01108172258*250#'),
      'tel:*9*7*01108172258*250%23',
    );
  });

  test('sanitizes arabic digits and parses public state without secrets', () {
    expect(sanitizeQuickExecuteDigits('٠١١٠٨١٧٢٢٥٨'), '01108172258');
    expect(sanitizeQuickExecuteAmount('٢٥٠'), '250');
    final state = ExecutorQuickExecuteState.fromJson(const <String, dynamic>{
      'enabled': true,
      'network': 'etisalat',
      'pinSet': true,
      'ussdWalletPinEncrypted': 'secret-should-be-ignored',
    });
    expect(state.enabled, isTrue);
    expect(state.pinRequired, isTrue);
    expect(state.networkLabel, 'اتصالات');
    expect('$state'.contains('secret-should-be-ignored'), isFalse);
  });
}
