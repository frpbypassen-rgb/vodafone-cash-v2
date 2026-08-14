import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_app/app_screens.dart';
import 'package:mobile_app/appearance_controller.dart';
import 'package:mobile_app/language_controller.dart';
import 'package:mobile_app/mobile_api.dart';

void main() {
  test('maps a login response into a durable mobile session', () {
    final session = MobileSession.fromJson(<String, dynamic>{
      'token': 'access-token',
      'refreshToken': 'refresh-token',
      'id': 'account-1',
      'accountType': 'client_user',
      'persona': 'directClient',
      'name': 'عميل تجريبي',
      'balance': 250.5,
      'tier': 2,
      'exchangeRate': 5.98,
      'baseExchangeRate': 6.0,
      'serviceRates': <String, dynamic>{'vodafone': 5.98},
      'serviceCatalog': <Map<String, dynamic>>[
        <String, dynamic>{'key': 'vodafone', 'label': 'محافظ كاش'},
      ],
      'isOpen': true,
      'context': <String, dynamic>{},
    });

    expect(session.name, 'عميل تجريبي');
    expect(session.serviceRates['vodafone'], 5.98);
    expect(session.serviceCatalog.single['key'], 'vodafone');
    expect(session.applyHome(<String, dynamic>{'balance': 100}).balance, 100);
  });

  test('only agent owner and manager get the agency management shell', () {
    final controller = SessionController(SessionStore());
    controller.session = MobileSession.fromJson(<String, dynamic>{
      'token': 'access-token',
      'refreshToken': 'refresh-token',
      'id': 'employee-1',
      'accountType': 'agent_staff',
      'persona': 'agentEmployee',
      'name': 'موظف وكالة',
      'balance': 0,
      'tier': 1,
      'exchangeRate': 1,
      'baseExchangeRate': 1,
      'serviceRates': <String, dynamic>{},
      'serviceCatalog': <Map<String, dynamic>>[],
      'isOpen': true,
      'context': <String, dynamic>{},
    });

    expect(controller.isAgent, isFalse);
    expect(controller.hidesBalance, isTrue);

    controller.session = controller.session!.copyWith();
    controller.session = MobileSession.fromJson(<String, dynamic>{
      ...controller.session!.toJson(),
      'persona': 'agentOwner',
      'accountType': 'client_user',
    });
    expect(controller.isAgent, isTrue);
  });

  test(
    'keeps the manager navigation for executor sessions from older clients',
    () {
      final controller = SessionController(SessionStore());
      controller.session = MobileSession.fromJson(<String, dynamic>{
        'token': 'access-token',
        'refreshToken': 'refresh-token',
        'id': 'executor-manager-1',
        'accountType': 'executor',
        'persona': 'executor',
        'name': 'مدير المنفذ',
        'balance': 1200,
        'tier': 1,
        'exchangeRate': 1,
        'baseExchangeRate': 1,
        'serviceRates': <String, dynamic>{},
        'serviceCatalog': <Map<String, dynamic>>[],
        'isOpen': true,
        // Legacy app releases persisted this generic value in the role field.
        'role': 'executor',
        'context': <String, dynamic>{'executorRole': 'manager'},
      });

      expect(controller.executorRole, 'manager');
      expect(controller.isExecutorManager, isTrue);
      expect(controller.isExecutorOperator, isFalse);
    },
  );

  testWidgets('shows the employees navigation tab for an executor manager', (
    tester,
  ) async {
    final controller = SessionController(SessionStore());
    controller.session = MobileSession.fromJson(<String, dynamic>{
      'token': 'access-token',
      'refreshToken': 'refresh-token',
      'id': 'executor-manager-1',
      'accountType': 'executor',
      'persona': 'executor',
      'name': 'مدير المنفذ',
      'balance': 1200,
      'tier': 1,
      'exchangeRate': 1,
      'baseExchangeRate': 1,
      'serviceRates': <String, dynamic>{},
      'serviceCatalog': <Map<String, dynamic>>[],
      'isOpen': true,
      'role': 'manager',
      'context': <String, dynamic>{
        'executorRole': 'manager',
        'executorGroupName': 'شركة التنفيذ التجريبية',
      },
    });
    addTearDown(controller.dispose);

    await tester.pumpWidget(
      MaterialApp(
        home: Directionality(
          textDirection: TextDirection.rtl,
          child: RoleShell(
            controller: controller,
            appearance: AppearanceController(),
            language: LanguageController(),
            enableBackgroundAlerts: false,
          ),
        ),
      ),
    );
    await tester.pump();

    expect(find.text('الموظفون'), findsOneWidget);
    expect(find.byIcon(Icons.manage_accounts_outlined), findsOneWidget);
  });
}
