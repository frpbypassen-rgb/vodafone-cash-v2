import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_app/company/company_gallery_screen.dart';
import 'package:mobile_app/company/company_service_catalog.dart';
import 'package:mobile_app/mobile_api.dart';
import 'package:mobile_app/workspace/workspace_kind.dart';
import 'package:mobile_app/workspace/workspace_nav.dart';

void main() {
  test('company gallery exposes six isolated channels', () {
    expect(companyServiceChannels, hasLength(6));
    expect(
      companyServiceChannels.map((item) => item.key),
      containsAll([
        'vodafone',
        'post_account',
        'post_card',
        'bank_account',
        'sefa_niger',
        'bankak_sudan',
      ]),
    );
  });

  test('company deposit goes through support text, not a wallet API', () {
    expect(
      companyDepositSupportMessage(amount: 1500, note: 'إيصال 44'),
      'طلب إيداع رصيد\nالقيمة: 1500.00 LYD\nالملاحظة: إيصال 44',
    );
  });

  test('only the company manager may request a deposit', () {
    final controller = SessionController(SessionStore());
    controller.session = MobileSession.fromJson(<String, dynamic>{
      'token': 't',
      'refreshToken': 'r',
      'id': 'mgr',
      'accountType': 'client_company',
      'persona': 'companyOwner',
      'name': 'مدير',
      'balance': 10,
      'tier': 1,
      'exchangeRate': 1,
      'baseExchangeRate': 1,
      'serviceRates': <String, dynamic>{},
      'serviceCatalog': <Map<String, dynamic>>[],
      'isOpen': true,
      'context': <String, dynamic>{},
    });
    expect(controller.canRequestCompanyDeposit, isTrue);
    expect(controller.canCreateTransfer, isTrue);

    controller.session = MobileSession.fromJson(<String, dynamic>{
      ...controller.session!.toJson(),
      'persona': 'companyAccountant',
      'id': 'acc',
    });
    expect(controller.canRequestCompanyDeposit, isFalse);
    expect(controller.canCreateTransfer, isFalse);
    expect(controller.hidesBalance, isFalse);

    controller.session = MobileSession.fromJson(<String, dynamic>{
      ...controller.session!.toJson(),
      'persona': 'companyEmployee',
      'id': 'emp',
    });
    expect(controller.canRequestCompanyDeposit, isFalse);
    expect(controller.canCreateTransfer, isTrue);
    expect(controller.canInternalTransfer, isFalse);
  });

  test('company execution starts at the isolated gallery tab', () {
    final ids = workspaceNavFor(
      WorkspaceKind.companyExecution,
    ).map((item) => item.id);
    expect(ids.first, WorkspaceNavId.services);
    expect(ids, isNot(contains(WorkspaceNavId.transfer)));
  });

  testWidgets('gallery renders six isolated tiles on 360', (tester) async {
    tester.view.physicalSize = const Size(360, 780);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    var opened = <String>[];

    await tester.pumpWidget(
      MaterialApp(
        home: Directionality(
          textDirection: TextDirection.rtl,
          child: Scaffold(
            body: CompanyGalleryGrid(
              availableKeys: companyServiceChannels
                  .map((item) => item.key)
                  .toSet(),
              onOpen: (choice) => opened.add(choice.serviceKey),
            ),
          ),
        ),
      ),
    );

    expect(find.text('معرض الخدمات'), findsOneWidget);
    expect(find.text('محافظ كاش'), findsOneWidget);
    expect(find.text('بريد حساب'), findsOneWidget);
    expect(find.text('بريد بطاقة'), findsOneWidget);
    expect(find.text('حساب بنكي'), findsOneWidget);
    expect(find.text('سيفا النيجر'), findsOneWidget);
    expect(find.text('بنكك السودان'), findsOneWidget);
    expect(find.text('تحويل بين الحسابات'), findsNothing);

    await tester.tap(find.text('محافظ كاش'));
    await tester.pump();
    expect(opened, ['vodafone']);
    expect(tester.takeException(), isNull);
  });
}
