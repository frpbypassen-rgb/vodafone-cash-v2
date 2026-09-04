import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:intl/date_symbol_data_initialize.dart';

// ═════════════════════════════════════════════════════════════════════════════
// Imports الأصلية
// ═════════════════════════════════════════════════════════════════════════════
import 'appearance_controller.dart';
import 'app_screens.dart';
import 'brand_theme.dart';
import 'executor_alert_service.dart';
import 'language_controller.dart';
import 'mobile_api.dart';
import 'mobile_push_service.dart';

// ═════════════════════════════════════════════════════════════════════════════
// Imports الجديدة V3
// ═════════════════════════════════════════════════════════════════════════════
import 'brand_theme_v3.dart';
import 'components/ahram_3d_components.dart';
import 'components/ahram_adaptive_layout.dart';
import 'components/ahram_animations.dart';
import 'services/ahram_notification_hub.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  registerMobilePushBackgroundHandler();

  // ═══════════════════════════════════════════════════════════════════════════
  // تهيئة نظام الإشعارات V3
  // ═══════════════════════════════════════════════════════════════════════════
  await AhramNotificationHub().initialize(
    onTokenRefresh: (token) async {
      debugPrint('🔔 FCM Token: ${token?.substring(0, 20)}...');
      // TODO: أرسل التوكن للخادم
      // await MobileApi().registerDeviceToken(token);
    },
    onNotificationTap: (notification) async {
      debugPrint('🔔 Notification tapped: ${notification.title}');
      // TODO: انتقل للشاشة المناسبة حسب نوع الإشعار
    },
  );

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

          // ═══════════════════════════════════════════════════════════════════
          // ✅ الثيمات الجديدة V3
          // ═══════════════════════════════════════════════════════════════════
          theme: AhramThemeV3.light(),
          darkTheme: AhramThemeV3.dark(),
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
        // ═══════════════════════════════════════════════════════════════════
        // ✅ شاشة الترحيب الجديدة V3
        // ═══════════════════════════════════════════════════════════════════
        ? const AhramSplashScreenV3()
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

// ═════════════════════════════════════════════════════════════════════════════
// شاشة الترحيب V3 — تصميم فاخر محدث
// ═════════════════════════════════════════════════════════════════════════════

class AhramSplashScreenV3 extends StatefulWidget {
  const AhramSplashScreenV3({super.key});

  @override
  State<AhramSplashScreenV3> createState() => _AhramSplashScreenV3State();
}

class _AhramSplashScreenV3State extends State<AhramSplashScreenV3>
    with SingleTickerProviderStateMixin {
  late final AnimationController _animation;

  @override
  void initState() {
    super.initState();
    _animation = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 2000),
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
      // ✅ خلفية أزرق عميق بدل الأسود
      backgroundColor: AhramColorsV3.primaryDeep,
      body: SafeArea(
        child: Center(
          child: AnimatedBuilder(
            animation: curved,
            builder: (context, child) => Opacity(
              opacity: 0.6 + (0.4 * curved.value),
              child: Transform.scale(
                scale: 0.94 + (0.06 * curved.value),
                child: child,
              ),
            ),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                // ✅ شعار دائري مضيء
                Container(
                  padding: const EdgeInsets.all(24),
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    color: AhramColorsV3.primarySky.withOpacity(0.1),
                    boxShadow: [
                      BoxShadow(
                        color: AhramColorsV3.primarySky.withOpacity(0.2),
                        blurRadius: 40,
                        spreadRadius: 10,
                      ),
                    ],
                  ),
                  child: const Icon(
                    Icons.account_balance_wallet,
                    size: 64,
                    color: AhramColorsV3.gold,
                  ),
                ),
                const SizedBox(height: 32),
                // ✅ عنوان بظل ذهبي
                const _AhramSplashTitleV3(),
                const SizedBox(height: 24),
                Text(
                  'يتم تجهيز تطبيقك',
                  style: TextStyle(
                    color: AhramColorsV3.textMuted.withOpacity(0.8),
                    fontWeight: FontWeight.w800,
                    fontSize: 15,
                  ),
                ),
                const SizedBox(height: 28),
                SizedBox(
                  width: 140,
                  child: ClipRRect(
                    borderRadius: BorderRadius.circular(99),
                    child: LinearProgressIndicator(
                      minHeight: 4,
                      backgroundColor: Colors.white.withOpacity(0.1),
                      valueColor: const AlwaysStoppedAnimation(
                        AhramColorsV3.gold,
                      ),
                    ),
                  ),
                ),
                const SizedBox(height: 16),
                Text(
                  'الإصدار 3.0',
                  style: TextStyle(
                    color: AhramColorsV3.textMuted.withOpacity(0.5),
                    fontSize: 12,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _AhramSplashTitleV3 extends StatelessWidget {
  const _AhramSplashTitleV3();

  @override
  Widget build(BuildContext context) {
    const fontSize = 42.0;
    const weight = FontWeight.w900;

    return Stack(
      alignment: Alignment.center,
      children: [
        // Shadow layer
        Transform.translate(
          offset: const Offset(2.5, 4),
          child: const Text(
            'Ahram Pay',
            textDirection: TextDirection.ltr,
            style: TextStyle(
              color: Color(0xFF0A0A1A),
              fontSize: fontSize,
              fontWeight: weight,
              letterSpacing: 0,
            ),
          ),
        ),
        // Main text with gold glow
        const Text.rich(
          TextSpan(
            children: [
              TextSpan(
                text: 'Ahram ',
                style: TextStyle(color: Colors.white),
              ),
              TextSpan(
                text: 'Pay',
                style: TextStyle(
                  color: AhramColorsV3.gold,
                  shadows: [
                    Shadow(
                      color: AhramColorsV3.gold,
                      blurRadius: 20,
                      offset: Offset(0, 0),
                    ),
                  ],
                ),
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
                color: Colors.black.withOpacity(0.5),
                blurRadius: 15,
                offset: const Offset(0, 6),
              ),
            ],
          ),
        ),
      ],
    );
  }
}
