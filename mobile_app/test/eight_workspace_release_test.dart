import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_app/mobile_api.dart';
import 'package:mobile_app/workspace/workspace_kind.dart';
import 'package:mobile_app/workspace/workspace_nav.dart';

void main() {
  test('release checklist: eight workspaces resolve from login personas', () {
    expect(
      resolveWorkspaceKind(accountType: 'client_user', persona: 'directClient'),
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

  test('release checklist: company accountant and executor accountant stay read-only', () {
    final companyAccountant = SessionController(SessionStore())
      ..session = MobileSession.fromJson(<String, dynamic>{
        'token': 't',
        'refreshToken': 'r',
        'id': 'acc',
        'accountType': 'client_company',
        'persona': 'companyAccountant',
        'name': 'محاسب',
        'balance': 1,
        'tier': 1,
        'exchangeRate': 1,
        'baseExchangeRate': 1,
        'serviceRates': <String, dynamic>{},
        'serviceCatalog': <Map<String, dynamic>>[],
        'isOpen': true,
        'context': <String, dynamic>{},
      });
    expect(companyAccountant.canCreateTransfer, isFalse);
    expect(companyAccountant.canInternalTransfer, isFalse);
    expect(companyAccountant.hidesBalance, isFalse);

    final executorAccountant = SessionController(SessionStore())
      ..session = MobileSession.fromJson(<String, dynamic>{
        'token': 't',
        'refreshToken': 'r',
        'id': 'exec-acc',
        'accountType': 'executor',
        'persona': 'executor',
        'name': 'محاسب تنفيذ',
        'balance': 1,
        'tier': 1,
        'exchangeRate': 1,
        'baseExchangeRate': 1,
        'serviceRates': <String, dynamic>{},
        'serviceCatalog': <Map<String, dynamic>>[],
        'isOpen': true,
        'context': <String, dynamic>{'executorRole': 'accountant'},
      });
    expect(executorAccountant.canAcceptExecutorTasks, isFalse);
    expect(executorAccountant.canCreateTransfer, isFalse);
    expect(
      executorWorkspaceNavFor('accountant').map((item) => item.id),
      isNot(contains(WorkspaceNavId.tasks)),
    );
  });
}
