import 'package:flutter/material.dart';

import 'workspace_kind.dart';

enum WorkspaceNavId {
  home,
  finance,
  services,
  smartTransfer,
  transfer,
  transactions,
  reports,
  support,
  account,
  rates,
  customers,
  tasks,
  deposits,
  employees,
  settings,
}

class WorkspaceNavSpec {
  const WorkspaceNavSpec({
    required this.id,
    required this.label,
    required this.icon,
  });

  final WorkspaceNavId id;
  final String label;
  final IconData icon;
}

List<WorkspaceNavSpec> workspaceNavFor(
  WorkspaceKind kind, {
  bool english = false,
  bool canViewAgentCustomers = false,
  String executorRole = 'operator',
}) {
  switch (kind) {
    case WorkspaceKind.companyManager:
      return [
        WorkspaceNavSpec(
          id: WorkspaceNavId.home,
          label: english ? 'Home' : 'الرئيسية',
          icon: Icons.space_dashboard_outlined,
        ),
        WorkspaceNavSpec(
          id: WorkspaceNavId.services,
          label: english ? 'Services' : 'الخدمات',
          icon: Icons.apps_outlined,
        ),
        WorkspaceNavSpec(
          id: WorkspaceNavId.transactions,
          label: english ? 'Activity' : 'العمليات',
          icon: Icons.receipt_long_outlined,
        ),
        WorkspaceNavSpec(
          id: WorkspaceNavId.reports,
          label: english ? 'Reports' : 'التقارير',
          icon: Icons.assessment_outlined,
        ),
        WorkspaceNavSpec(
          id: WorkspaceNavId.support,
          label: english ? 'Support' : 'الدعم',
          icon: Icons.support_agent_outlined,
        ),
      ];
    case WorkspaceKind.companyExecution:
      return [
        WorkspaceNavSpec(
          id: WorkspaceNavId.services,
          label: english ? 'Services' : 'الخدمات',
          icon: Icons.apps_outlined,
        ),
        WorkspaceNavSpec(
          id: WorkspaceNavId.smartTransfer,
          label: english ? 'Smart' : 'ذكي',
          icon: Icons.auto_fix_high_outlined,
        ),
        WorkspaceNavSpec(
          id: WorkspaceNavId.transactions,
          label: english ? 'Today' : 'العمليات',
          icon: Icons.receipt_long_outlined,
        ),
        WorkspaceNavSpec(
          id: WorkspaceNavId.support,
          label: english ? 'Support' : 'الدعم',
          icon: Icons.support_agent_outlined,
        ),
      ];
    case WorkspaceKind.companyAccountant:
      return [
        WorkspaceNavSpec(
          id: WorkspaceNavId.finance,
          label: english ? 'Finance' : 'المالية',
          icon: Icons.account_balance_wallet_outlined,
        ),
        WorkspaceNavSpec(
          id: WorkspaceNavId.reports,
          label: english ? 'Reports' : 'التقارير',
          icon: Icons.assessment_outlined,
        ),
        WorkspaceNavSpec(
          id: WorkspaceNavId.transactions,
          label: english ? 'Ledger' : 'العمليات',
          icon: Icons.receipt_long_outlined,
        ),
        WorkspaceNavSpec(
          id: WorkspaceNavId.support,
          label: english ? 'Support' : 'الدعم',
          icon: Icons.support_agent_outlined,
        ),
      ];
    case WorkspaceKind.agentHq:
      return [
        WorkspaceNavSpec(
          id: WorkspaceNavId.home,
          label: english ? 'Home' : 'الرئيسية',
          icon: Icons.space_dashboard_outlined,
        ),
        WorkspaceNavSpec(
          id: WorkspaceNavId.customers,
          label: english ? 'Customers' : 'العملاء',
          icon: Icons.groups_2_outlined,
        ),
        WorkspaceNavSpec(
          id: WorkspaceNavId.transfer,
          label: english ? 'Transfer' : 'تحويل',
          icon: Icons.send_to_mobile_outlined,
        ),
        WorkspaceNavSpec(
          id: WorkspaceNavId.reports,
          label: english ? 'Reports' : 'التقارير',
          icon: Icons.assessment_outlined,
        ),
        WorkspaceNavSpec(
          id: WorkspaceNavId.support,
          label: english ? 'Support' : 'الدعم',
          icon: Icons.support_agent_outlined,
        ),
      ];
    case WorkspaceKind.agentStaff:
      return [
        WorkspaceNavSpec(
          id: WorkspaceNavId.transfer,
          label: english ? 'Transfer' : 'تحويل',
          icon: Icons.send_to_mobile_outlined,
        ),
        WorkspaceNavSpec(
          id: WorkspaceNavId.transactions,
          label: english ? 'Today' : 'العمليات',
          icon: Icons.receipt_long_outlined,
        ),
        if (canViewAgentCustomers)
          WorkspaceNavSpec(
            id: WorkspaceNavId.customers,
            label: english ? 'Customers' : 'العملاء',
            icon: Icons.groups_2_outlined,
          ),
        WorkspaceNavSpec(
          id: WorkspaceNavId.support,
          label: english ? 'Support' : 'الدعم',
          icon: Icons.support_agent_outlined,
        ),
      ];
    case WorkspaceKind.customerWallet:
      return [
        WorkspaceNavSpec(
          id: WorkspaceNavId.account,
          label: english ? 'Account' : 'الحساب',
          icon: Icons.account_balance_wallet_outlined,
        ),
        WorkspaceNavSpec(
          id: WorkspaceNavId.transfer,
          label: english ? 'Transfers' : 'التحويلات',
          icon: Icons.send_to_mobile_outlined,
        ),
        WorkspaceNavSpec(
          id: WorkspaceNavId.rates,
          label: english ? 'Exchange rates' : 'أسعار الصرف',
          icon: Icons.currency_exchange_outlined,
        ),
        WorkspaceNavSpec(
          id: WorkspaceNavId.reports,
          label: english ? 'Reports' : 'التقارير',
          icon: Icons.assessment_outlined,
        ),
        WorkspaceNavSpec(
          id: WorkspaceNavId.support,
          label: english ? 'Support' : 'الدعم الفني',
          icon: Icons.support_agent_outlined,
        ),
      ];
    case WorkspaceKind.executorRoom:
      return executorWorkspaceNavFor(executorRole);
    case WorkspaceKind.executorControl:
      return executorWorkspaceNavFor('accountant');
  }
}

List<WorkspaceNavSpec> executorWorkspaceNavFor(String role) {
  final normalized = role.trim().toLowerCase();
  const tasks = WorkspaceNavSpec(
    id: WorkspaceNavId.tasks,
    label: 'مهام التنفيذ',
    icon: Icons.assignment_turned_in_outlined,
  );
  const reports = WorkspaceNavSpec(
    id: WorkspaceNavId.reports,
    label: 'التقارير',
    icon: Icons.assessment_outlined,
  );
  const deposits = WorkspaceNavSpec(
    id: WorkspaceNavId.deposits,
    label: 'الإيداعات',
    icon: Icons.account_balance_wallet_outlined,
  );
  const employees = WorkspaceNavSpec(
    id: WorkspaceNavId.employees,
    label: 'الموظفون',
    icon: Icons.manage_accounts_outlined,
  );
  const support = WorkspaceNavSpec(
    id: WorkspaceNavId.support,
    label: 'الدعم',
    icon: Icons.support_agent_outlined,
  );
  const settings = WorkspaceNavSpec(
    id: WorkspaceNavId.settings,
    label: 'الإعدادات',
    icon: Icons.settings_outlined,
  );

  if (normalized == 'manager') {
    return const [tasks, reports, deposits, employees, support, settings];
  }
  if (normalized == 'accountant') {
    return const [reports, support, settings];
  }
  return const [tasks, reports, support, settings];
}

bool workspaceNavAllowsTransfer(WorkspaceKind kind) {
  return kind != WorkspaceKind.companyAccountant &&
      kind != WorkspaceKind.executorControl;
}
