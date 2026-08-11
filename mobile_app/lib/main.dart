import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:intl/date_symbol_data_local.dart';

import 'appearance_controller.dart';
import 'app_screens.dart';
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
    const seed = Color(0xFF009B68);
    return AnimatedBuilder(
      animation: Listenable.merge(<Listenable>[controller, appearance]),
      builder: (context, _) {
        return MaterialApp(
          title: 'Power Pay AL-Ahram',
          debugShowCheckedModeBanner: false,
          locale: const Locale('ar'),
          supportedLocales: const [Locale('ar'), Locale('en')],
          localizationsDelegates: const [
            GlobalMaterialLocalizations.delegate,
            GlobalWidgetsLocalizations.delegate,
            GlobalCupertinoLocalizations.delegate,
          ],
          theme: ThemeData(
            useMaterial3: true,
            colorScheme: ColorScheme.fromSeed(
              seedColor: seed,
              primary: seed,
              secondary: const Color(0xFFF1B931),
              surface: Colors.white,
            ),
            scaffoldBackgroundColor: const Color(0xFFF4F7FB),
            appBarTheme: const AppBarTheme(
              backgroundColor: Color(0xFFF4F7FB),
              foregroundColor: Color(0xFF10233F),
              elevation: 0,
              scrolledUnderElevation: 0,
              centerTitle: false,
            ),
            inputDecorationTheme: InputDecorationTheme(
              filled: true,
              fillColor: Colors.white,
              contentPadding: const EdgeInsets.symmetric(
                horizontal: 16,
                vertical: 16,
              ),
              border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(10),
                borderSide: const BorderSide(color: Color(0xFFD9E1EC)),
              ),
              enabledBorder: OutlineInputBorder(
                borderRadius: BorderRadius.circular(10),
                borderSide: const BorderSide(color: Color(0xFFD9E1EC)),
              ),
              focusedBorder: OutlineInputBorder(
                borderRadius: BorderRadius.circular(10),
                borderSide: const BorderSide(color: seed, width: 1.5),
              ),
            ),
            navigationBarTheme: const NavigationBarThemeData(
              height: 70,
              indicatorColor: Color(0xFFDFF5EA),
              labelTextStyle: WidgetStatePropertyAll(
                TextStyle(fontWeight: FontWeight.w700, fontSize: 12),
              ),
            ),
          ),
          darkTheme: ThemeData(
            useMaterial3: true,
            brightness: Brightness.dark,
            colorScheme: ColorScheme.fromSeed(
              seedColor: seed,
              brightness: Brightness.dark,
              primary: const Color(0xFF37C88D),
              secondary: const Color(0xFFF1B931),
              surface: const Color(0xFF14243B),
            ),
            scaffoldBackgroundColor: const Color(0xFF0B1628),
            appBarTheme: const AppBarTheme(
              backgroundColor: Color(0xFF0B1628),
              foregroundColor: Color(0xFFF2F6FB),
              elevation: 0,
              scrolledUnderElevation: 0,
              centerTitle: false,
            ),
            inputDecorationTheme: InputDecorationTheme(
              filled: true,
              fillColor: const Color(0xFF14243B),
              contentPadding: const EdgeInsets.symmetric(
                horizontal: 16,
                vertical: 16,
              ),
              border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(10),
                borderSide: const BorderSide(color: Color(0xFF31445F)),
              ),
              enabledBorder: OutlineInputBorder(
                borderRadius: BorderRadius.circular(10),
                borderSide: const BorderSide(color: Color(0xFF31445F)),
              ),
              focusedBorder: OutlineInputBorder(
                borderRadius: BorderRadius.circular(10),
                borderSide: const BorderSide(
                  color: Color(0xFF37C88D),
                  width: 1.5,
                ),
              ),
            ),
            navigationBarTheme: const NavigationBarThemeData(
              height: 70,
              backgroundColor: Color(0xFF102038),
              indicatorColor: Color(0xFF1D5848),
              labelTextStyle: WidgetStatePropertyAll(
                TextStyle(fontWeight: FontWeight.w700, fontSize: 12),
              ),
            ),
          ),
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
