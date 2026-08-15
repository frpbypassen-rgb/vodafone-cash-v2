import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:intl/date_symbol_data_local.dart';

import 'appearance_controller.dart';
import 'app_screens.dart';
import 'brand_theme.dart';
import 'executor_alert_service.dart';
import 'language_controller.dart';
import 'mobile_api.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final controller = SessionController(SessionStore());
  final language = LanguageController();
  runApp(
    PowerPayApp(
      controller: controller,
      appearance: AppearanceController(),
      language: language,
    ),
  );

  // The first frame must never wait on secure storage, locale data, or native
  // notification setup. A slow device previously showed a white native screen.
  unawaited(_warmUpApplication(language));
}

Future<void> _warmUpApplication(LanguageController language) async {
  try {
    await Future.wait<void>([
      initializeDateFormatting('ar'),
      initializeDateFormatting('en'),
      language.restore(),
    ]);
  } catch (_) {
    // The application already rendered with system defaults.
  }
  try {
    await ExecutorAlertService.instance.configure();
  } catch (_) {
    // Notifications remain unavailable until the next successful start.
  }
}

class PowerPayApp extends StatelessWidget {
  const PowerPayApp({
    super.key,
    required this.controller,
    required this.appearance,
    required this.language,
  });

  final SessionController controller;
  final AppearanceController appearance;
  final LanguageController language;

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: Listenable.merge(<Listenable>[
        controller,
        appearance,
        language,
      ]),
      builder: (context, _) {
        return MaterialApp(
          title: 'Ahram Pay',
          debugShowCheckedModeBanner: false,
          locale: language.locale,
          supportedLocales: const [Locale('ar'), Locale('en')],
          localizationsDelegates: const [
            GlobalMaterialLocalizations.delegate,
            GlobalWidgetsLocalizations.delegate,
            GlobalCupertinoLocalizations.delegate,
          ],
          theme: AhramTheme.light(),
          darkTheme: AhramTheme.dark(),
          themeMode: appearance.themeMode,
          home: Builder(
            builder: (context) {
              final isArabic =
                  Localizations.localeOf(context).languageCode == 'ar';
              return Directionality(
                textDirection: isArabic ? TextDirection.rtl : TextDirection.ltr,
                child: AppBootstrap(
                  controller: controller,
                  appearance: appearance,
                  language: language,
                ),
              );
            },
          ),
        );
      },
    );
  }
}

class AppBootstrap extends StatefulWidget {
  const AppBootstrap({
    super.key,
    required this.controller,
    required this.appearance,
    required this.language,
  });

  final SessionController controller;
  final AppearanceController appearance;
  final LanguageController language;

  @override
  State<AppBootstrap> createState() => _AppBootstrapState();
}

class _AppBootstrapState extends State<AppBootstrap> {
  bool _ready = false;

  @override
  void initState() {
    super.initState();
    _bootstrap();
  }

  Future<void> _bootstrap() async {
    await Future.wait<void>([
      widget.controller
          .restore()
          .timeout(const Duration(seconds: 3), onTimeout: () {})
          .catchError((_) {}),
      Future<void>.delayed(const Duration(milliseconds: 1100)),
    ]);
    if (mounted) setState(() => _ready = true);
  }

  @override
  Widget build(BuildContext context) {
    final screen = !_ready
        ? const AhramSplashScreen()
        : (widget.controller.session == null
              ? LoginScreen(controller: widget.controller)
              : RoleShell(
                  controller: widget.controller,
                  appearance: widget.appearance,
                  language: widget.language,
                ));
    return AnimatedSwitcher(
      duration: const Duration(milliseconds: 520),
      switchInCurve: Curves.easeOutCubic,
      switchOutCurve: Curves.easeInCubic,
      transitionBuilder: (child, animation) {
        final slide = Tween<Offset>(
          begin: const Offset(0, 0.045),
          end: Offset.zero,
        ).animate(animation);
        return FadeTransition(
          opacity: animation,
          child: SlideTransition(position: slide, child: child),
        );
      },
      child: KeyedSubtree(key: ValueKey<bool>(_ready), child: screen),
    );
  }
}

class AhramSplashScreen extends StatefulWidget {
  const AhramSplashScreen({super.key});

  @override
  State<AhramSplashScreen> createState() => _AhramSplashScreenState();
}

class _AhramSplashScreenState extends State<AhramSplashScreen>
    with SingleTickerProviderStateMixin {
  late final AnimationController _animation;

  @override
  void initState() {
    super.initState();
    _animation = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1800),
    )..repeat(reverse: true);
  }

  @override
  void dispose() {
    _animation.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final curved = CurvedAnimation(
      parent: _animation,
      curve: Curves.easeOutCubic,
    );
    return Scaffold(
      body: ColoredBox(
        color: Colors.black,
        child: SafeArea(
          child: Center(
            child: AnimatedBuilder(
              animation: curved,
              builder: (context, child) => Opacity(
                opacity: 0.72 + (0.28 * curved.value),
                child: Transform.scale(
                  scale: 0.96 + (0.04 * curved.value),
                  child: child,
                ),
              ),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const _AhramPaySplashTitle(),
                  const SizedBox(height: 18),
                  const Text(
                    'يتم تجهيز التطبيق',
                    style: TextStyle(
                      color: Color(0xFFB9B9B9),
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                  const SizedBox(height: 20),
                  SizedBox(
                    width: 122,
                    child: LinearProgressIndicator(
                      minHeight: 3,
                      borderRadius: BorderRadius.circular(99),
                      color: const Color(0xFFD7A92E),
                      backgroundColor: const Color(0xFF2A2A2A),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _AhramPaySplashTitle extends StatelessWidget {
  const _AhramPaySplashTitle();

  @override
  Widget build(BuildContext context) {
    const fontSize = 42.0;
    const weight = FontWeight.w900;
    return Stack(
      alignment: Alignment.center,
      children: [
        Transform.translate(
          offset: const Offset(2.5, 4),
          child: const Text(
            'Ahram Pay',
            textDirection: TextDirection.ltr,
            style: TextStyle(
              color: Color(0xFF242424),
              fontSize: fontSize,
              fontWeight: weight,
              letterSpacing: 0,
            ),
          ),
        ),
        const Text.rich(
          TextSpan(
            children: [
              TextSpan(
                text: 'Ahram ',
                style: TextStyle(color: Colors.white),
              ),
              TextSpan(
                text: 'Pay',
                style: TextStyle(color: Color(0xFFD7A92E)),
              ),
            ],
          ),
          textDirection: TextDirection.ltr,
          style: TextStyle(
            fontSize: fontSize,
            fontWeight: weight,
            letterSpacing: 0,
            shadows: [
              Shadow(
                color: Color(0x99000000),
                blurRadius: 10,
                offset: Offset(0, 5),
              ),
            ],
          ),
        ),
      ],
    );
  }
}
