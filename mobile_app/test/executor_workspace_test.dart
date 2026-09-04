import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_app/app_screens.dart';
import 'package:mobile_app/mobile_api.dart';
import 'package:mobile_app/workspace/workspace_kind.dart';
import 'package:mobile_app/workspace/workspace_nav.dart';

Map<String, dynamic> _executorSession({
  required String id,
  required String role,
}) {
  return <String, dynamic>{
    'token': 't',
    'refreshToken': 'r',
    'id': id,
    'accountType': 'executor',
    'persona': 'executor',
    'name': 'منفذ تجريبي',
    'balance': 400,
    'tier': 1,
    'exchangeRate': 1,
    'baseExchangeRate': 1,
    'serviceRates': <String, dynamic>{},
    'serviceCatalog': <Map<String, dynamic>>[],
    'isOpen': true,
    'role': role,
    'context': <String, dynamic>{
      'executorRole': role,
      'executorGroupName': 'غرفة التنفيذ',
    },
  };
}

SessionController _controller({required String id, required String role}) {
  final controller = SessionController(SessionStore());
  controller.session = MobileSession.fromJson(
    _executorSession(id: id, role: role),
  );
  return controller;
}

void main() {
  test('operator room starts at live tasks without deposits or employees', () {
    final ids = executorWorkspaceNavFor('operator').map((item) => item.id);
    expect(ids.first, WorkspaceNavId.tasks);
    expect(ids, contains(WorkspaceNavId.reports));
    expect(ids, isNot(contains(WorkspaceNavId.deposits)));
    expect(ids, isNot(contains(WorkspaceNavId.employees)));
    expect(ids, isNot(contains(WorkspaceNavId.customers)));
  });

  test('executor accountant starts at reports and cannot open tasks', () {
    final ids = executorWorkspaceNavFor('accountant').map((item) => item.id);
    expect(ids.first, WorkspaceNavId.reports);
    expect(ids, isNot(contains(WorkspaceNavId.tasks)));
    expect(ids, isNot(contains(WorkspaceNavId.employees)));
    expect(
      workspaceNavFor(WorkspaceKind.executorControl).map((item) => item.id),
      isNot(contains(WorkspaceNavId.tasks)),
    );
  });

  test('manager keeps live tasks plus team and deposits', () {
    final ids = executorWorkspaceNavFor('manager').map((item) => item.id);
    expect(ids.first, WorkspaceNavId.tasks);
    expect(ids, contains(WorkspaceNavId.employees));
    expect(ids, contains(WorkspaceNavId.deposits));
    expect(ids, contains(WorkspaceNavId.support));
  });

  test('only operators and managers may accept or prove a task', () {
    final operator = _controller(id: 'op-1', role: 'operator');
    expect(operator.workspaceKind, WorkspaceKind.executorRoom);
    expect(operator.canAcceptExecutorTasks, isTrue);
    expect(operator.canCompleteExecutorProof, isTrue);
    expect(operator.canRouteExecutorTasks, isFalse);
    expect(operator.canCreateTransfer, isTrue);

    final manager = _controller(id: 'mgr-1', role: 'manager');
    expect(manager.canAcceptExecutorTasks, isTrue);
    expect(manager.canRouteExecutorTasks, isTrue);

    final accountant = _controller(id: 'acc-1', role: 'accountant');
    expect(accountant.workspaceKind, WorkspaceKind.executorControl);
    expect(accountant.canAcceptExecutorTasks, isFalse);
    expect(accountant.canCompleteExecutorProof, isFalse);
    expect(accountant.canRouteExecutorTasks, isFalse);
    expect(accountant.canCreateTransfer, isFalse);
  });

  testWidgets('accountant sees a lock instead of accept or proof', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        locale: const Locale('ar'),
        home: ExecutorTasksScreen(
          controller: _controller(id: 'acc-2', role: 'accountant'),
        ),
      ),
    );
    await tester.pump();

    expect(find.text('غرفة المهام غير متاحة'), findsOneWidget);
    expect(find.text('قبول العملية'), findsNothing);
    expect(find.text('تم التنفيذ'), findsNothing);
  });

  testWidgets('executor report numbers stay at 22pt', (tester) async {
    await tester.pumpWidget(
      const MaterialApp(
        locale: Locale('ar'),
        home: Scaffold(
          body: ExecutorMetricCard(
            label: 'العمليات الناجحة',
            value: '4',
            icon: Icons.receipt_long_outlined,
            color: Color(0xFF1457D9),
          ),
        ),
      ),
    );

    expect(tester.widget<Text>(find.text('4')).style?.fontSize, 22);
  });

  testWidgets('urgent alert stays a dedicated alarm card', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        locale: const Locale('ar'),
        home: Scaffold(
          body: ExecutorUrgentAlertCard(
            alert: const <String, dynamic>{
              'txId': 'ATT-2609-88',
              'emergencyAlert': 'تأخير في التنفيذ',
            },
            alarmPlaying: true,
            busy: false,
            onStop: () {},
            onReview: () {},
          ),
        ),
      ),
    );

    expect(find.text('إنذار استعجال'), findsOneWidget);
    expect(find.textContaining('ATT-2609-88'), findsOneWidget);
    expect(find.text('إيقاف الصوت'), findsOneWidget);
  });
}
