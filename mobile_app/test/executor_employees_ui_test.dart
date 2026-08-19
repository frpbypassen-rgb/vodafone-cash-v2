import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_app/app_screens.dart';

Widget _shell(Widget child) {
  return MaterialApp(
    locale: const Locale('ar'),
    home: Scaffold(
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(16),
        child: child,
      ),
    ),
  );
}

void main() {
  testWidgets('employee workspace summary shows live operational totals', (
    tester,
  ) async {
    await tester.pumpWidget(
      _shell(
        const ExecutorEmployeesSummary(
          summary: <String, dynamic>{
            'totalEmployees': 8,
            'onlineEmployees': 5,
            'busyEmployees': 2,
            'completedCount': 17,
            'totalEGP': 12450,
          },
        ),
      ),
    );

    expect(find.text('أعضاء الفريق'), findsOneWidget);
    expect(find.text('متصلون الآن'), findsOneWidget);
    expect(find.text('مهام نشطة'), findsOneWidget);
    expect(find.text('تنفيذات اليوم'), findsOneWidget);
    expect(find.text('12,450 ج.م'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('employee card exposes current task, performance, and actions', (
    tester,
  ) async {
    var opened = false;
    var reportOpened = false;
    await tester.pumpWidget(
      _shell(
        ExecutorEmployeeTile(
          employee: <String, dynamic>{
            'id': 'operator-1',
            'name': 'موظف الاختبار',
            'phone': '0940000000',
            'webUsername': 'operator@ahram.com',
            'role': 'operator',
            'status': 'active',
            'canViewAllReports': false,
            'presence': <String, dynamic>{'isOnline': true},
            'metrics': <String, dynamic>{
              'completedCount': 6,
              'totalEGP': 2500,
              'averageDurationSeconds': 85,
            },
            'currentTask': <String, dynamic>{
              'customId': 'ATT-2608-1001',
              'recipient': '01108172258',
              'amount': 100,
              'receivedAt': DateTime.now()
                  .subtract(const Duration(seconds: 15))
                  .toIso8601String(),
            },
          },
          busy: false,
          onOpen: () => opened = true,
          onEdit: () {},
          onResetPassword: () {},
          onToggleStatus: () {},
          onToggleReports: () {},
          onReport: () => reportOpened = true,
          onArchive: () {},
        ),
      ),
    );

    expect(find.text('موظف الاختبار'), findsOneWidget);
    expect(find.text('متصل الآن'), findsOneWidget);
    expect(find.textContaining('ATT-2608-1001'), findsOneWidget);
    expect(find.text('6'), findsOneWidget);
    expect(find.text('2,500 ج.م'), findsOneWidget);
    expect(find.text('1 د 25 ث'), findsOneWidget);

    await tester.tap(find.text('فتح الملف'));
    expect(opened, isTrue);
    await tester.tap(find.text('التقرير'));
    expect(reportOpened, isTrue);
    expect(tester.takeException(), isNull);
  });
}
