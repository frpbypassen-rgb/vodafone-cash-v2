import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:intl/date_symbol_data_local.dart';
import 'package:mobile_app/app_screens.dart';

Widget _shell(Map<String, dynamic> task) {
  return MaterialApp(
    locale: const Locale('ar'),
    home: Scaffold(
      body: SingleChildScrollView(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: ExecutorTaskTile(
            task: task,
            busy: false,
            currentExecutorId: 'employee-1',
            acceptBlocked: false,
            canRoute: false,
            isManager: false,
            onAccept: () {},
            onRoute: () {},
            onCancel: () {},
            onComplete: () {},
            onShare: () async {},
          ),
        ),
      ),
    ),
  );
}

Map<String, dynamic> _task({required bool accepted}) => <String, dynamic>{
  'id': 'task-1',
  'txId': 'ATT-2608-2001',
  'transferType': 'vodafone',
  'transferTypeLabel': 'محافظ كاش',
  'amount': 100,
  'recipientNumber': accepted ? '01108172258' : '011',
  'recipientPrefix': '011',
  'recipientRevealed': accepted,
  'status': accepted ? 'accepted' : 'processing',
  'operatorId': accepted ? 'employee-1' : null,
  'isOwnedByCurrentExecutor': accepted,
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
}
