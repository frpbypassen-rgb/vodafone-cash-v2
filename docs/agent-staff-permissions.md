# Agent staff permissions

The mobile staff form offers basic permissions by role or six independent custom
capabilities: transfers, wallet balance, all transactions, all reports, customer
management, and staff management. A collapsed editor on each staff row uses the
same controls. Unselected custom capabilities are denied. Accountants cannot
transfer even if a crafted request selects that capability.

`AgentEmployee.staffPermissions` is optional. Existing records without it keep
their previous role and delegation rules; no migration is needed. New custom or
basic selections store all six explicit booleans. The agent owner retains full
access. Granular permissions do not implicitly grant settings administration.

The ledger requires both balance and all-transactions permission. Agency profits
require balance and all-reports permission. Balance-only access does not reveal
the agency ledger or individual customer accounts. Transaction lists and report
queries use separate scopes; details and receipts accept a record visible through
either authorized scope.

Only staff administrators may create or edit staff. Delegated administrators
cannot grant a capability they lack, edit a stronger account, modify themselves,
or use password/status actions to take over a stronger account. The backend
resolves ownership and tenant membership from the authenticated session.

Edits use an optimistic session-version match, increment the version, clear
pending OTP/refresh credentials, and write an audit record. The edited employee
must sign in again. Concurrent edits return a conflict instead of overwriting
newer permissions. The local preview does not persist staff changes.

Coverage includes policy combinations, separate report/transaction scopes,
delegation boundaries, ownership, persisted Mongo updates, session invalidation,
concurrent edits, legacy records, and mobile form/editor behavior.
