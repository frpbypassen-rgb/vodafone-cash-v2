enum WorkspaceKind {
  customerWallet,
  companyManager,
  companyExecution,
  companyAccountant,
  agentHq,
  agentStaff,
  executorRoom,
  executorControl,
}

WorkspaceKind resolveWorkspaceKind({
  required String accountType,
  required String persona,
  String executorRole = 'operator',
}) {
  final type = accountType.trim().toLowerCase();
  final role = persona.trim().toLowerCase();

  if (type == 'executor') {
    return executorRole == 'accountant'
        ? WorkspaceKind.executorControl
        : WorkspaceKind.executorRoom;
  }
  if (role == 'agentowner' || role == 'agentmanager') {
    return WorkspaceKind.agentHq;
  }
  if (type == 'agent_staff' || role == 'agentemployee') {
    return WorkspaceKind.agentStaff;
  }

  final isCompany = type == 'client_company' || role.startsWith('company');
  if (isCompany) {
    if (role.contains('accountant')) return WorkspaceKind.companyAccountant;
    if (role.contains('employee')) return WorkspaceKind.companyExecution;
    return WorkspaceKind.companyManager;
  }

  return WorkspaceKind.customerWallet;
}
