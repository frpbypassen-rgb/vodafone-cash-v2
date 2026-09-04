import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_app/mobile_api.dart';
import 'package:mobile_app/workspace/workspace_kind.dart';
import 'package:mobile_app/workspace/workspace_nav.dart';

void main() {
  test('routes official login personas to the eight workspaces', () {
    expect(
      resolveWorkspaceKind(accountType: 'client_user', persona: 'directClient'),
      WorkspaceKind.customerWallet,
    );
    expect(
      resolveWorkspaceKind(accountType: 'sub_client', persona: 'agentClient'),
      WorkspaceKind.customerWallet,
    );
    expect(
      resolveWorkspaceKind(
        accountType: 'client_company',
        persona: 'companyOwner',
      ),
      WorkspaceKind.companyManager,
    );
    expect(
      resolveWorkspaceKind(
        accountType: 'client_company',
        persona: 'companyManager',
      ),
      WorkspaceKind.companyManager,
    );
    expect(
      resolveWorkspaceKind(
        accountType: 'client_company',
        persona: 'companyEmployee',
      ),
      WorkspaceKind.companyExecution,
    );
    expect(
      resolveWorkspaceKind(
        accountType: 'client_company',
        persona: 'companyAccountant',
      ),
      WorkspaceKind.companyAccountant,
    );
    expect(
      resolveWorkspaceKind(accountType: 'client_user', persona: 'agentOwner'),
      WorkspaceKind.agentHq,
    );
    expect(
      resolveWorkspaceKind(
        accountType: 'agent_staff',
        persona: 'agentEmployee',
      ),
      WorkspaceKind.agentStaff,
    );
    expect(
      resolveWorkspaceKind(
        accountType: 'executor',
        persona: 'executor',
        executorRole: 'operator',
      ),
      WorkspaceKind.executorRoom,
    );
    expect(
      resolveWorkspaceKind(
        accountType: 'executor',
        persona: 'executor',
        executorRole: 'accountant',
      ),
      WorkspaceKind.executorControl,
    );
  });

  test('company accountant cannot open a transfer bench', () {
    expect(
      workspaceNavAllowsTransfer(WorkspaceKind.companyAccountant),
      isFalse,
    );
    expect(workspaceNavAllowsTransfer(WorkspaceKind.companyExecution), isTrue);
    expect(
      workspaceNavFor(WorkspaceKind.companyAccountant).map((item) => item.id),
      isNot(contains(WorkspaceNavId.transfer)),
    );
    expect(
      workspaceNavFor(WorkspaceKind.companyAccountant).map((item) => item.id),
      isNot(contains(WorkspaceNavId.services)),
    );
  });

  test('company employee starts at the isolated service gallery', () {
    final ids = workspaceNavFor(
      WorkspaceKind.companyExecution,
    ).map((item) => item.id).toList();
    expect(ids.first, WorkspaceNavId.services);
    expect(ids, contains(WorkspaceNavId.smartTransfer));
    expect(ids, isNot(contains(WorkspaceNavId.home)));
    expect(ids, isNot(contains(WorkspaceNavId.reports)));
    expect(ids.length, lessThanOrEqualTo(5));
  });

  test('agent staff cannot open the agency customer list', () {
    final ids = workspaceNavFor(
      WorkspaceKind.agentStaff,
    ).map((item) => item.id).toList();
    expect(ids.first, WorkspaceNavId.transfer);
    expect(ids, isNot(contains(WorkspaceNavId.customers)));
    expect(ids, isNot(contains(WorkspaceNavId.reports)));
    expect(ids.length, lessThanOrEqualTo(5));
  });

  test('agent staff sees customers only when granted read permission', () {
    final ids = workspaceNavFor(
      WorkspaceKind.agentStaff,
      canViewAgentCustomers: true,
    ).map((item) => item.id).toList();
    expect(ids, contains(WorkspaceNavId.customers));
    expect(ids, isNot(contains(WorkspaceNavId.reports)));
    expect(ids.length, lessThanOrEqualTo(5));
  });

  test('agent HQ has customers and reports without executor tasks', () {
    final ids = workspaceNavFor(
      WorkspaceKind.agentHq,
    ).map((item) => item.id).toList();
    expect(ids.first, WorkspaceNavId.home);
    expect(ids, contains(WorkspaceNavId.customers));
    expect(ids, contains(WorkspaceNavId.reports));
    expect(ids, contains(WorkspaceNavId.transfer));
    expect(ids, isNot(contains(WorkspaceNavId.services)));
    expect(ids.length, 5);
  });

  test('session controller exposes company finance visibility correctly', () {
    final controller = SessionController(SessionStore());
    controller.session = MobileSession.fromJson(<String, dynamic>{
      'token': 'access-token',
      'refreshToken': 'refresh-token',
      'id': 'accountant-1',
      'accountType': 'client_company',
      'persona': 'companyAccountant',
      'name': 'محاسب الشركة',
      'balance': 18000,
      'tier': 2,
      'exchangeRate': 6,
      'baseExchangeRate': 6,
      'serviceRates': <String, dynamic>{},
      'serviceCatalog': <Map<String, dynamic>>[],
      'isOpen': true,
      'context': <String, dynamic>{},
    });

    expect(controller.workspaceKind, WorkspaceKind.companyAccountant);
    expect(controller.isCompanyAccountant, isTrue);
    expect(controller.hidesBalance, isFalse);
    expect(controller.canCreateTransfer, isFalse);
    expect(controller.canInternalTransfer, isFalse);

    controller.session = MobileSession.fromJson(<String, dynamic>{
      ...controller.session!.toJson(),
      'persona': 'companyEmployee',
      'id': 'employee-1',
      'name': 'موظف الشركة',
    });
    expect(controller.workspaceKind, WorkspaceKind.companyExecution);
    expect(controller.hidesBalance, isTrue);
    expect(controller.canCreateTransfer, isTrue);
    expect(controller.canInternalTransfer, isFalse);
  });
}
