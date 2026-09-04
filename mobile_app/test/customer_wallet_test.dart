import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_app/customer/customer_report_dashboard.dart';
import 'package:mobile_app/customer/customer_wallet_hero.dart';
import 'package:mobile_app/customer/transfer_step_bar.dart';
import 'package:mobile_app/workspace/workspace_kind.dart';
import 'package:mobile_app/workspace/workspace_nav.dart';

Future<void> _pumpAtWidth(
  WidgetTester tester,
  double width,
  Widget child,
) async {
  tester.view.physicalSize = Size(width, 780);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  await tester.pumpWidget(
    MaterialApp(
      home: Directionality(
        textDirection: TextDirection.rtl,
        child: Scaffold(body: SingleChildScrollView(child: child)),
      ),
    ),
  );
}

void main() {
  test('customer wallet keeps five tabs and starts at the account', () {
    final nav = workspaceNavFor(WorkspaceKind.customerWallet);
    expect(nav.length, 5);
    expect(nav.first.id, WorkspaceNavId.account);
    expect(
      nav.map((item) => item.id),
      isNot(contains(WorkspaceNavId.customers)),
    );
    expect(nav.map((item) => item.id), isNot(contains(WorkspaceNavId.home)));
  });

  test('catalog uses one column on 360 and two columns from 390', () {
    expect(transferCatalogColumns(360), 1);
    expect(transferCatalogColumns(390), 2);
    expect(transferCatalogColumns(430), 2);
    expect(transferCatalogColumns(600), 3);
  });

  testWidgets('wallet hero shows balance and available at 360', (tester) async {
    await _pumpAtWidth(
      tester,
      360,
      const CustomerWalletHero(balance: 1250.5, available: 980),
    );

    expect(find.text('الرصيد'), findsOneWidget);
    expect(find.text('المتاح للتحويل'), findsOneWidget);
    expect(find.textContaining('1,250.50'), findsOneWidget);
    expect(find.textContaining('980.00'), findsOneWidget);
    final valueStyle = tester
        .widget<Text>(find.textContaining('1,250.50'))
        .style;
    expect(valueStyle?.fontSize, 22);
  });

  testWidgets('wallet hero stays two-up on 430 without overflow', (
    tester,
  ) async {
    await _pumpAtWidth(
      tester,
      430,
      const CustomerWalletHero(balance: 80, available: 80),
    );
    expect(tester.takeException(), isNull);
    expect(find.text('الرصيد'), findsOneWidget);
    expect(find.text('المتاح للتحويل'), findsOneWidget);
  });

  testWidgets('transfer steps stay readable on a 360 phone', (tester) async {
    await _pumpAtWidth(tester, 360, const TransferStepBar(currentStep: 2));
    expect(find.text('خدمة'), findsOneWidget);
    expect(find.text('بيانات'), findsOneWidget);
    expect(find.text('مراجعة'), findsOneWidget);
    expect(find.text('ختم'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('report metrics use 22pt numbers and hide cost when asked', (
    tester,
  ) async {
    await _pumpAtWidth(
      tester,
      360,
      const CustomerReportMetrics(
        transactionCount: 4,
        completedCount: 3,
        totalEgp: '1,200 ج.م',
        totalLyd: '200.00 د.ل',
        showCost: false,
      ),
    );
    expect(find.text('العمليات'), findsOneWidget);
    expect(find.text('الناجحة'), findsOneWidget);
    expect(find.text('المصري'), findsOneWidget);
    expect(find.text('التكلفة'), findsNothing);
    expect(tester.widget<Text>(find.text('4')).style?.fontSize, 22);
  });

  testWidgets('operation cards keep only reference, amount and status', (
    tester,
  ) async {
    await _pumpAtWidth(
      tester,
      360,
      CustomerOperationCard(
        reference: 'ATT-2609-10',
        amount: '500 ج.م',
        status: 'ناجحة',
        statusColor: const Color(0xFF0E9B86),
      ),
    );
    expect(find.text('ATT-2609-10'), findsOneWidget);
    expect(find.text('500 ج.م'), findsOneWidget);
    expect(find.text('ناجحة'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('service bars render a compact daily breakdown', (tester) async {
    await _pumpAtWidth(
      tester,
      430,
      const CustomerServiceShareBars(
        shares: [
          CustomerServiceShare(
            label: 'محافظ كاش',
            count: 3,
            color: Color(0xFF0E9B86),
          ),
          CustomerServiceShare(
            label: 'بريد حساب',
            count: 1,
            color: Color(0xFFC9A227),
          ),
        ],
      ),
    );
    expect(find.text('محافظ كاش'), findsOneWidget);
    expect(find.text('3'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
