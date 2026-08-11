import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:intl/date_symbol_data_local.dart';

import 'appearance_controller.dart';
import 'app_screens.dart';
import 'brand_theme.dart';
import 'mobile_api.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await initializeDateFormatting('ar');
  final controller = SessionController(SessionStore());
  await controller.restore();
  runApp(
    PowerPayApp(controller: controller, appearance: AppearanceController()),
  );
}

class PowerPayApp extends StatelessWidget {
  const PowerPayApp({
    super.key,
    required this.controller,
    required this.appearance,
  });

  final SessionController controller;
  final AppearanceController appearance;

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: Listenable.merge(<Listenable>[controller, appearance]),
      builder: (context, _) {
        return MaterialApp(
          title: 'شركة الأهرام',
          debugShowCheckedModeBanner: false,
          locale: const Locale('ar'),
          supportedLocales: const [Locale('ar'), Locale('en')],
          localizationsDelegates: const [
            GlobalMaterialLocalizations.delegate,
            GlobalWidgetsLocalizations.delegate,
            GlobalCupertinoLocalizations.delegate,
          ],
          theme: AhramTheme.light(),
          darkTheme: AhramTheme.dark(),
          themeMode: appearance.themeMode,
          home: Directionality(
            textDirection: TextDirection.rtl,
            child: controller.session == null
                ? LoginScreen(controller: controller)
                : RoleShell(controller: controller, appearance: appearance),
          ),
        );
      },
    );
  }
}
