import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_app/agent/agent_hq_metrics.dart';
import 'package:mobile_app/app_screens.dart';
import 'package:mobile_app/mobile_api.dart';
import 'package:mobile_app/workspace/workspace_kind.dart';
import 'package:mobile_app/workspace/workspace_nav.dart';

Map<String, dynamic> _sessionJson({
  required String id,
  required String accountType,
  required String persona,
  List<String> permissions = const [],
}) {
  return <String, dynamic>{
    'token': 't',
    'refreshToken': 'r',
    'id': id,
    'accountType': accountType,
    'persona': persona,
    'name': 'حساب تجريبي',
    'balance': 900,
    'tier': 1,
    'exchangeRate': 1,
    'baseExchangeRate': 1,
    'serviceRates': <String, dynamic>{},
    'serviceCatalog': <Map<String, dynamic>>[],
    'isOpen': true,
    'context': <String, dynamic>{},
    'permissions': permissions,
  };
}

SessionController _controller({
  required String id,
  required String accountType,
  required String persona,
  List<String> permissions = const [],
}) {
  final controller = SessionController(SessionStore());
  controller.session = MobileSession.fromJson(
    _sessionJson(
      id: id,
      accountType: accountType,
      persona: persona,
      permissions: permissions,
    ),
  );
  return controller;
}

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
  test('agent HQ keeps five green-room tabs including reports', () {
    final ids = workspaceNavFor(
      WorkspaceKind.agentHq,
    ).map((item) => item.id).toList();
    expect(ids, [
      WorkspaceNavId.home,
      WorkspaceNavId.customers,
      WorkspaceNavId.transfer,
      WorkspaceNavId.reports,
      WorkspaceNavId.support,
    ]);
  });

  test('agent owner can create and manage customers without extra flags', () {
    final controller = _controller(
      id: 'agent-1',
      accountType: 'client_user',
      persona: 'agentOwner',
    );
    expect(controller.workspaceKind, WorkspaceKind.agentHq);
    expect(controller.isAgent, isTrue);
    expect(controller.canViewAgentCustomers, isTrue);
    expect(controller.canCreateAgentCustomers, isTrue);
    expect(controller.canManageAgentCustomers, isTrue);
    expect(controller.hidesBalance, isFalse);
  });

  test('agent staff stays off the customer list unless granted', () {
    final staff = _controller(
      id: 'staff-1',
      accountType: 'agent_staff',
      persona: 'agentEmployee',
    );
    expect(staff.workspaceKind, WorkspaceKind.agentStaff);
    expect(staff.isAgent, isFalse);
    expect(staff.canViewAgentCustomers, isFalse);
    expect(staff.canCreateAgentCustomers, isFalse);
    expect(staff.canManageAgentCustomers, isFalse);
    expect(staff.hidesBalance, isTrue);

    final granted = _controller(
      id: 'staff-2',
      accountType: 'agent_staff',
      persona: 'agentEmployee',
      permissions: const ['agent.sub_accounts.read'],
    );
    expect(granted.canViewAgentCustomers, isTrue);
    expect(granted.canCreateAgentCustomers, isFalse);
    expect(granted.canManageAgentCustomers, isFalse);

    final manager = _controller(
      id: 'staff-3',
      accountType: 'agent_staff',
      persona: 'agentEmployee',
      permissions: const [
        'agent.sub_accounts.read',
        'agent.sub_accounts.create',
        'agent.sub_accounts.update_credit_limit',
      ],
    );
    expect(manager.canCreateAgentCustomers, isTrue);
    expect(manager.canManageAgentCustomers, isTrue);
  });

  testWidgets('agency metrics use 22pt numbers on 360', (tester) async {
    await _pumpAtWidth(
      tester,
      360,
      const AgentHqMetrics(
        metrics: [
          AgentHqMetric(
            label: 'العملاء',
            value: '12',
            suffix: '',
            color: Color(0xFF0E9B86),
          ),
          AgentHqMetric(
            label: 'الديون',
            value: '40.00',
            suffix: 'د.ل',
            color: Color(0xFFB42318),
          ),
        ],
      ),
    );
    expect(find.text('العملاء'), findsOneWidget);
    expect(find.text('12'), findsOneWidget);
    expect(tester.widget<Text>(find.text('12')).style?.fontSize, 22);
    expect(tester.takeException(), isNull);
  });

  testWidgets('customer tile hides settle and limit without manage rights', (
    tester,
  ) async {
    await _pumpAtWidth(
      tester,
      360,
      SubAccountTile(
        account: const <String, dynamic>{
          'name': 'عميل تجريبي',
          'accountCode': 'AG-1',
          'status': 'active',
          'balance': 10,
          'creditLimit': 50,
          'debt': 0,
          'availableToSpend': 10,
        },
        canManage: false,
        onSetLimit: () {},
        onSettlement: () {},
      ),
    );
    expect(find.text('عميل تجريبي'), findsOneWidget);
    expect(
      find.widgetWithText(OutlinedButton, 'الحد الائتماني'),
      findsNothing,
    );
    expect(find.widgetWithText(FilledButton, 'تسوية'), findsNothing);
  });

  testWidgets('customer tile shows settle and limit when manage is allowed', (
    tester,
  ) async {
    await _pumpAtWidth(
      tester,
      430,
      SubAccountTile(
        account: const <String, dynamic>{
          'name': 'عميل الإدارة',
          'accountCode': 'AG-2',
          'status': 'active',
          'balance': 10,
          'creditLimit': 50,
          'debt': 0,
          'availableToSpend': 10,
        },
        onSetLimit: () {},
        onSettlement: () {},
      ),
    );
    expect(
      find.widgetWithText(OutlinedButton, 'الحد الائتماني'),
      findsOneWidget,
    );
    expect(find.widgetWithText(FilledButton, 'تسوية'), findsOneWidget);
  });

  testWidgets('attention banner reminds staff not to add customers', (
    tester,
  ) async {
    await _pumpAtWidth(
      tester,
      360,
      const AgentAttentionBanner(
        message:
            'إدارة العملاء والتسويات من تبويب العملاء فقط. موظف الوكالة لا يضيف عميلاً ما لم تُمنح له الصلاحية.',
      ),
    );
    expect(find.textContaining('موظف الوكالة لا يضيف'), findsOneWidget);
  });
}
