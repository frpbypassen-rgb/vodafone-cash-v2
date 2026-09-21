import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:intl/date_symbol_data_local.dart';
import 'package:mobile_app/app_screens.dart';

Widget _shell(
  Map<String, dynamic> task, {
  String currentExecutorId = 'employee-1',
  bool canRoute = false,
  bool isManager = false,
  bool quickExecuteEnabled = false,
}) {
  return MaterialApp(
    locale: const Locale('ar'),
    home: Scaffold(
      body: SingleChildScrollView(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: ExecutorTaskTile(
            task: task,
            busy: false,
            currentExecutorId: currentExecutorId,
            acceptBlocked: false,
            canRoute: canRoute,
            isManager: isManager,
            onAccept: () {},
            onRoute: () {},
            onCancel: () {},
            onComplete: () {},
            onShare: () async {},
            quickExecuteEnabled: quickExecuteEnabled,
            onQuickExecute: () {},
          ),
        ),
      ),
    ),
  );
}

Map<String, dynamic> _task({
  required bool accepted,
  String? assignedExecutorId,
  String? assignedExecutorName,
  String? routingState,
  String? routingStateLabel,
  bool isAssignedToCurrentExecutor = false,
  bool isOwnedByCurrentExecutor = false,
  String? operatorId,
}) =>
    <String, dynamic>{
      'id': 'task-1',
      'txId': 'ATT-2608-2001',
      'transferType': 'vodafone',
      'transferTypeLabel': 'محافظ كاش',
      'amount': 100,
      'recipientNumber': accepted ? '01108172258' : '011',
      'recipientPrefix': '011',
      'recipientRevealed': accepted,
      'status': accepted ? 'accepted' : 'processing',
      'operatorId': operatorId ?? (accepted ? 'employee-1' : null),
      'assignedExecutorId': assignedExecutorId,
      'assignedExecutorName': assignedExecutorName,
      'routingState': routingState,
      'routingStateLabel': routingStateLabel,
      'isAssignedToCurrentExecutor': isAssignedToCurrentExecutor,
      'isOwnedByCurrentExecutor': isOwnedByCurrentExecutor || accepted,
      'createdAt': DateTime(2026, 8, 19, 10).toIso8601String(),
    };

Future<void> main() async {
  TestWidgetsFlutterBinding.ensureInitialized();
  await initializeDateFormatting('ar');

  testWidgets('task hides recipient and copy action before acceptance', (
    tester,
  ) async {
    await tester.pumpWidget(_shell(_task(accepted: false)));

    expect(find.text('011'), findsOneWidget);
    expect(find.text('01108172258'), findsNothing);
    expect(find.text('بادئة رقم هاتف العميل'), findsOneWidget);
    // The amount remains copyable, while the recipient copy action is hidden.
    expect(find.byIcon(Icons.copy_outlined), findsOneWidget);
    expect(
      find.textContaining('يظهر الرقم كاملاً بعد قبول المهمة'),
      findsOneWidget,
    );
  });

  testWidgets('task reveals full recipient and copy action to its owner', (
    tester,
  ) async {
    await tester.pumpWidget(_shell(_task(accepted: true)));

    expect(find.text('01108172258'), findsOneWidget);
    expect(find.text('رقم هاتف العميل'), findsOneWidget);
    // Recipient and amount are both copyable after ownership is confirmed.
    expect(find.byIcon(Icons.copy_outlined), findsNWidgets(2));
    expect(
      find.textContaining('يظهر الرقم كاملاً بعد قبول المهمة'),
      findsNothing,
    );
  });

  testWidgets('manager sees assignee name and معلّقة عنده before claim', (
    tester,
  ) async {
    await tester.pumpWidget(
      _shell(
        _task(
          accepted: false,
          assignedExecutorId: 'external-1',
          assignedExecutorName: 'أحمد الخارجي',
          routingState: 'pending_with_assignee',
          routingStateLabel: 'معلّقة عنده',
        ),
        canRoute: true,
        isManager: true,
        currentExecutorId: 'manager-1',
      ),
    );

    expect(find.text('معلّقة عنده'), findsWidgets);
    expect(find.text('أحمد الخارجي'), findsOneWidget);
    expect(find.text('إعادة التوجيه إلى منفذ'), findsOneWidget);
    expect(find.text('اسحب المهمة الموجهة إليك'), findsNothing);
  });

  testWidgets('manager sees بدأ التنفيذ after the assignee accepts', (
    tester,
  ) async {
    await tester.pumpWidget(
      _shell(
        _task(
          accepted: true,
          assignedExecutorId: 'external-1',
          assignedExecutorName: 'أحمد الخارجي',
          routingState: 'in_progress',
          routingStateLabel: 'بدأ التنفيذ',
          operatorId: 'external-1',
          isOwnedByCurrentExecutor: false,
        ),
        canRoute: true,
        isManager: true,
        currentExecutorId: 'manager-1',
      ),
    );

    expect(find.text('بدأ التنفيذ'), findsWidgets);
    expect(find.text('أحمد الخارجي'), findsOneWidget);
    expect(find.text('قبول العملية'), findsNothing);
  });

  testWidgets('external executor sees a routed task with a claim action', (
    tester,
  ) async {
    await tester.pumpWidget(
      _shell(
        _task(
          accepted: false,
          assignedExecutorId: 'external-1',
          assignedExecutorName: 'أحمد الخارجي',
          routingState: 'pending_with_assignee',
          routingStateLabel: 'معلّقة عنده',
          isAssignedToCurrentExecutor: true,
        ),
        currentExecutorId: 'external-1',
      ),
    );

    expect(find.text('موجهة إليك'), findsWidgets);
    expect(find.text('اسحب المهمة الموجهة إليك'), findsOneWidget);
    expect(find.text('قبول العملية'), findsNothing);
  });

  testWidgets('owned cash task shows quick-execute handset when enabled', (
    tester,
  ) async {
    await tester.pumpWidget(
      _shell(_task(accepted: true), quickExecuteEnabled: true),
    );

    expect(find.text('تم التنفيذ'), findsOneWidget);
    expect(find.byIcon(Icons.phone_in_talk_outlined), findsOneWidget);

    await tester.pumpWidget(_shell(_task(accepted: true)));
    expect(find.byIcon(Icons.phone_in_talk_outlined), findsNothing);
  });
}
