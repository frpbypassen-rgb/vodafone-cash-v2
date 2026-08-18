import 'dart:convert';

class MobileNotificationInteraction {
  const MobileNotificationInteraction({
    required this.action,
    required this.route,
    required this.data,
  });

  final String action;
  final String route;
  final Map<String, dynamic> data;

  String get transactionId => '${data['transactionId'] ?? ''}'.trim();
  String get ticketId => '${data['ticketId'] ?? ''}'.trim();

  Map<String, dynamic> toJson() => <String, dynamic>{
    'action': action,
    'route': route,
    'data': data,
  };

  String encode() => jsonEncode(toJson());

  static MobileNotificationInteraction? decode(String? raw) {
    if (raw == null || raw.trim().isEmpty) return null;
    try {
      final decoded = jsonDecode(raw);
      if (decoded is! Map) return null;
      final map = Map<String, dynamic>.from(decoded);
      final data = map['data'] is Map
          ? Map<String, dynamic>.from(map['data'] as Map)
          : <String, dynamic>{};
      return MobileNotificationInteraction(
        action: '${map['action'] ?? data['action'] ?? ''}',
        route: '${map['route'] ?? data['route'] ?? ''}',
        data: data,
      );
    } catch (_) {
      return null;
    }
  }
}
