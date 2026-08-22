import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:mobile_app/app_screens.dart';
import 'package:mobile_app/mobile_api.dart';

void main() {
  testWidgets('support workspace renders before the API responds', (
    tester,
  ) async {
    final controller = SessionController(SessionStore());

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: ExecutorSupportScreen(controller: controller),
        ),
      ),
    );
    await tester.pump(const Duration(milliseconds: 120));

    expect(find.text('مركز دعم التنفيذ'), findsOneWidget);
    expect(find.text('طلب جديد'), findsOneWidget);
    expect(find.text('مجموعة الشركة'), findsOneWidget);

    // Let the guarded request finish so the test also verifies that a failed
    // server call does not leave a pending timer behind.
    await tester.pump(const Duration(seconds: 13));
  });
}
