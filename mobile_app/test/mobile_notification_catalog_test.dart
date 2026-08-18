import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_app/mobile_notification_catalog.dart';
import 'package:mobile_app/mobile_notification_interaction.dart';

void main() {
  test(
    'defines a custom Android channel and sound for every executor event',
    () {
      const requiredCategories = <String>{
        'executor_task_new',
        'executor_task_routed',
        'executor_task_reminder',
        'executor_urgent_alert',
        'executor_task_accepted',
        'executor_task_completed',
        'executor_task_cancelled',
        'executor_support_reply',
        'executor_balance_warning',
        'executor_security_alert',
        'executor_report_ready',
      };

      expect(mobileNotificationDefinitions.keys.toSet(), requiredCategories);
      for (final definition in mobileNotificationDefinitions.values) {
        expect(definition.channelId, isNotEmpty);
        expect(definition.sound, startsWith('ahram_'));
        expect(<String>{
          'tasks',
          'reports',
          'support',
          'settings',
        }, contains(definition.route));
      }
    },
  );

  test('keeps operational task and urgent preferences enabled by default', () {
    expect(defaultMobileNotificationPreferences['tasks'], isTrue);
    expect(defaultMobileNotificationPreferences['urgent'], isTrue);
    expect(defaultMobileNotificationPreferences['reminders'], isTrue);
  });

  test(
    'round-trips notification navigation data through secure storage text',
    () {
      const interaction = MobileNotificationInteraction(
        action: 'open_executor_task',
        route: 'tasks',
        data: <String, dynamic>{
          'transactionId': 'transaction-1',
          'customId': 'ATT-2608-1001',
        },
      );

      final decoded = MobileNotificationInteraction.decode(
        interaction.encode(),
      );

      expect(decoded, isNotNull);
      expect(decoded!.route, 'tasks');
      expect(decoded.transactionId, 'transaction-1');
      expect(decoded.data['customId'], 'ATT-2608-1001');
    },
  );
}
