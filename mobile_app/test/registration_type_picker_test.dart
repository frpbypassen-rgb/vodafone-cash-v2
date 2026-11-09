import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_app/app_screens.dart';
import 'package:mobile_app/mobile_api.dart';

void main() {
  for (final (type, field) in [
    ('عميل مباشر', 'اسم المحل'),
    ('شركة', 'اسم الشركة القانوني'),
    ('وكيل', 'اسم الوكالة'),
    ('عميل تابع', 'رقم الوكيل'),
  ]) {
    testWidgets('opens the correct form for $type', (tester) async {
      await tester.pumpWidget(
        MaterialApp(home: RegistrationScreen(api: MobileApi(SessionStore()))),
      );
      await tester.pumpAndSettle();
      expect(find.text('اختر نوع الحساب للمتابعة'), findsOneWidget);
      await tester.ensureVisible(find.text(type));
      await tester.tap(find.text(type));
      await tester.pumpAndSettle();
      expect(find.text(field), findsOneWidget);
      await tester.tap(find.byTooltip('اختيار نوع الحساب'));
      await tester.pumpAndSettle();
      expect(find.text('اختر نوع الحساب للمتابعة'), findsOneWidget);
    });
  }

  for (final brightness in Brightness.values) {
    for (final size in [const Size(320, 640), const Size(844, 390)]) {
      testWidgets('all account options fit $brightness $size at 2x', (
        tester,
      ) async {
        tester.view.physicalSize = size;
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        await tester.pumpWidget(
          MaterialApp(
            theme: ThemeData(brightness: brightness),
            builder: (context, child) => MediaQuery(
              data: MediaQuery.of(
                context,
              ).copyWith(textScaler: TextScaler.linear(2)),
              child: child!,
            ),
            home: RegistrationScreen(api: MobileApi(SessionStore())),
          ),
        );
        await tester.pumpAndSettle();
        for (final label in [
          'عميل مباشر',
          'شركة',
          'وكيل',
          'عميل تابع',
          'العودة لتسجيل الدخول',
        ]) {
          final item = find.text(label);
          await tester.ensureVisible(item);
          expect(item.hitTestable(), findsOneWidget);
        }
        expect(tester.takeException(), isNull);
      });
    }
  }
}
