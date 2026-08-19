import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_app/app_screens.dart';

Widget _testShell(Widget child) {
  return MaterialApp(
    locale: const Locale('ar'),
    home: Scaffold(
      body: SingleChildScrollView(
        child: Padding(padding: const EdgeInsets.all(16), child: child),
      ),
    ),
  );
}

void main() {
  testWidgets('employee report summary stays personal and compact', (
    tester,
  ) async {
    await tester.pumpWidget(
      _testShell(
        const ExecutorReportSummary(
          personalView: true,
          accountantView: false,
          report: <String, dynamic>{
            'summary': <String, dynamic>{
              'completedCount': 4,
              'cancelledCount': 1,
              'totalEGP': 1450,
              'averageDurationSeconds': 95,
            },
          },
        ),
      ),
    );

    expect(find.text('العمليات الناجحة'), findsOneWidget);
    expect(find.text('إجمالي التنفيذ'), findsOneWidget);
    expect(find.text('1 د 35 ث'), findsOneWidget);
    expect(find.text('1,450 ج.م'), findsOneWidget);
    expect(find.text('الرصيد الحالي'), findsNothing);
  });

  testWidgets('accountant reconciliation separates every financial movement', (
    tester,
  ) async {
    await tester.pumpWidget(
      _testShell(
        const ExecutorReconciliationPanel(
          summary: <String, dynamic>{
            'openingBalance': 750,
            'additions': 300,
            'deductions': 50,
            'executedAmount': 100,
            'netMovement': 150,
            'closingBalance': 900,
          },
          deposits: <Map<String, dynamic>>[],
        ),
      ),
    );

    expect(find.text('معادلة التسوية المالية'), findsOneWidget);
    expect(find.text('الرصيد الافتتاحي'), findsOneWidget);
    expect(find.text('إضافات الرصيد'), findsOneWidget);
    expect(find.text('خصومات إدارية'), findsOneWidget);
    expect(find.text('عمليات منفذة'), findsOneWidget);
    expect(find.text('الرصيد الختامي'), findsOneWidget);
    expect(find.text('لا توجد حركات رصيد'), findsOneWidget);
  });
}
