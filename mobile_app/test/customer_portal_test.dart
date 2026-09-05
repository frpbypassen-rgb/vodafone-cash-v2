import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_app/customer/portal/components/inspector_panel.dart';
import 'package:mobile_app/customer/portal/components/quick_action_orb.dart';
import 'package:mobile_app/customer/portal/components/review_seal.dart';
import 'package:mobile_app/customer/portal/customer_breakpoints.dart';
import 'package:mobile_app/customer/portal/customer_theme.dart';
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
        child: Scaffold(body: child),
      ),
    ),
  );
}

void main() {
  test('customer portal breakpoints', () {
    expect(customerUseBottomNav(360), isTrue);
    expect(customerUseBottomNav(849), isTrue);
    expect(customerUseBottomNav(850), isFalse);
    expect(customerShowInspector(1199), isFalse);
    expect(customerShowInspector(1200), isTrue);
    expect(customerGridColumns(360), 1);
    expect(customerGridColumns(850), 2);
    expect(customerGridColumns(1280), 3);
  });

  test('customer wallet nav unchanged for portal shell', () {
    final nav = workspaceNavFor(WorkspaceKind.customerWallet);
    expect(nav.length, 5);
    expect(nav.first.id, WorkspaceNavId.account);
  });

  testWidgets('quick action orbs render four actions at 360', (tester) async {
    var tapped = 0;
    await _pumpAtWidth(
      tester,
      360,
      CustomerQuickActionRow(
        actions: List.generate(
          4,
          (index) => CustomerQuickAction(
            label: 'إجراء $index',
            icon: Icons.star_outline,
            onTap: () => tapped++,
          ),
        ),
      ),
    );
    expect(find.text('إجراء 0'), findsOneWidget);
    expect(find.text('إجراء 3'), findsOneWidget);
    await tester.tap(find.text('إجراء 1'));
    await tester.pump();
    expect(tapped, 1);
  });

  testWidgets('review seal shows summary lines', (tester) async {
    await _pumpAtWidth(
      tester,
      430,
      SizedBox(
        height: 520,
        child: CustomerReviewSeal(
          title: 'مراجعة',
          lines: const [
            CustomerReviewLine('المبلغ', '500 ج.م'),
            CustomerReviewLine('المستلم', '01012345678'),
          ],
          onConfirm: () {},
          onBack: () {},
        ),
      ),
    );
    expect(find.text('مراجعة'), findsOneWidget);
    expect(find.text('500 ج.م'), findsOneWidget);
    expect(find.text('تأكيد وإرسال'), findsOneWidget);
  });

  testWidgets('inspector panel shows placeholder when empty', (tester) async {
    await _pumpAtWidth(
      tester,
      1280,
      const Row(
        children: [
          Expanded(child: SizedBox()),
          CustomerInspectorPanel(),
        ],
      ),
    );
    expect(find.textContaining('اختر عملية'), findsOneWidget);
  });

  testWidgets('customer theme tokens stay on brand', (tester) async {
    expect(CustomerTheme.canvas, const Color(0xFF0C1B33));
    expect(CustomerTheme.action, const Color(0xFFC9A227));
    expect(CustomerTheme.metricFs, 22);
  });
}
