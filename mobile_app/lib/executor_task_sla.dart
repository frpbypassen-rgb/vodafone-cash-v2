const kStuckAssigneeSlaSeconds = 90;

String? stuckAssigneeSlaHint({
  required String routingState,
  Object? assignedExecutorAt,
  DateTime? now,
  int thresholdSeconds = kStuckAssigneeSlaSeconds,
}) {
  if (routingState != 'pending_with_assignee' || assignedExecutorAt == null) {
    return null;
  }
  final assignedAt = assignedExecutorAt is DateTime
      ? assignedExecutorAt
      : DateTime.tryParse('$assignedExecutorAt');
  if (assignedAt == null) return null;
  final waited = (now ?? DateTime.now()).toUtc().difference(assignedAt.toUtc());
  if (waited.inSeconds < thresholdSeconds) return null;
  final minutes = waited.inMinutes < 1 ? 1 : waited.inMinutes;
  return 'معلّقة عنده منذ $minutes د — قد تحتاج إعادة توجيه';
}
