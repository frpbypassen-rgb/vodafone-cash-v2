import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_app/executor_task_sla.dart';

void main() {
  test('manager SLA hint stays hidden until the routed task is stuck', () {
    final assignedAt = DateTime.utc(2026, 9, 21, 12);
    expect(
      stuckAssigneeSlaHint(
        routingState: 'pending_with_assignee',
        assignedExecutorAt: assignedAt,
        now: assignedAt.add(const Duration(seconds: 30)),
      ),
      isNull,
    );
    expect(
      stuckAssigneeSlaHint(
        routingState: 'pending_with_assignee',
        assignedExecutorAt: assignedAt,
        now: assignedAt.add(Duration(seconds: kStuckAssigneeSlaSeconds + 5)),
      ),
      contains('معلّقة عنده'),
    );
    expect(
      stuckAssigneeSlaHint(
        routingState: 'in_progress',
        assignedExecutorAt: assignedAt,
        now: assignedAt.add(const Duration(minutes: 10)),
      ),
      isNull,
    );
  });
}
