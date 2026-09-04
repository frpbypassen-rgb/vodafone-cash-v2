// ============================================================================
// Al-Ahram Pay V3 — Demo Home Screen
// شاشة رئيسية تجريبية تعرض جميع المكونات الجديدة
// ============================================================================

import 'package:flutter/material.dart';
import 'brand_theme_v3.dart';
import 'components/ahram_3d_components.dart';
import 'components/ahram_adaptive_layout.dart';
import 'components/ahram_animations.dart';
import 'services/ahram_notification_hub.dart';

class HomeScreenV3Demo extends StatefulWidget {
  const HomeScreenV3Demo({super.key});

  @override
  State<HomeScreenV3Demo> createState() => _HomeScreenV3DemoState();
}

class _HomeScreenV3DemoState extends State<HomeScreenV3Demo> {
  int _currentIndex = 0;
  bool _showSuccess = false;

  @override
  Widget build(BuildContext context) {
    if (_showSuccess) {
      return AhramSuccessScreen(
        title: 'تمت العملية بنجاح!',
        amount: '5,000.00 LYD',
        subtitle: 'رقم العملية: TXN-7845123',
        primaryActionLabel: 'مشاركة الإيصال',
        onPrimaryAction: () {},
        secondaryActionLabel: 'العودة للرئيسية',
        onSecondaryAction: () => setState(() => _showSuccess = false),
      );
    }

    return AhramAdaptiveScaffold(
      appBar: AppBar(
        title: const Text('الرئيسية'),
        actions: [
          // زر الإشعارات مع عداد
          Stack(
            children: [
              IconButton(
                icon: const Icon(Icons.notifications_outlined),
                onPressed: () => _showInbox(context),
              ),
              if (AhramNotificationHub().unreadCount > 0)
                Positioned(
                  top: 8,
                  right: 8,
                  child: Container(
                    padding: const EdgeInsets.all(4),
                    decoration: const BoxDecoration(
                      color: AhramColorsV3.danger,
                      shape: BoxShape.circle,
                    ),
                    constraints: const BoxConstraints(
                      minWidth: 18,
                      minHeight: 18,
                    ),
                    child: Text(
                      '${AhramNotificationHub().unreadCount}',
                      style: const TextStyle(
                        color: Colors.white,
                        fontSize: 10,
                        fontWeight: FontWeight.w800,
                      ),
                      textAlign: TextAlign.center,
                    ),
                  ),
                ),
            ],
          ),
        ],
      ),
      currentIndex: _currentIndex,
      onNavigationChanged: (index) => setState(() => _currentIndex = index),
      destinations: const [
        AhramNavDestination(
          icon: Icons.home_outlined,
          selectedIcon: Icons.home_rounded,
          label: 'الرئيسية',
        ),
        AhramNavDestination(
          icon: Icons.swap_horiz_outlined,
          selectedIcon: Icons.swap_horiz_rounded,
          label: 'تحويل',
        ),
        AhramNavDestination(
          icon: Icons.bar_chart_outlined,
          selectedIcon: Icons.bar_chart_rounded,
          label: 'تقارير',
          badge: 3,
        ),
        AhramNavDestination(
          icon: Icons.person_outline,
          selectedIcon: Icons.person_rounded,
          label: 'حسابي',
        ),
      ],
      body: _buildBody(),
    );
  }

  Widget _buildBody() {
    return CustomScrollView(
      slivers: [
        // ═══════════════════════════════════════════════════════════════════════
        // بطاقة الرصيد 3D
        // ═══════════════════════════════════════════════════════════════════════
        SliverToBoxAdapter(
          child: AhramBalanceCard3D(
            balance: 45320.00,
            currency: 'LYD',
            subLabel: 'الحد الائتماني: 10,000 LYD',
            onTransferTap: () {},
          ),
        ),

        // ═══════════════════════════════════════════════════════════════════════
        // عنوان القسم
        // ═══════════════════════════════════════════════════════════════════════
        SliverPadding(
          padding: AhramAdaptiveLayout.responsivePadding(context).copyWith(
            top: 24,
            bottom: 12,
          ),
          sliver: SliverToBoxAdapter(
            child: Row(
              children: [
                Text(
                  'الخدمات',
                  style: TextStyle(
                    fontSize: 20,
                    fontWeight: FontWeight.w900,
                    color: Theme.of(context).brightness == Brightness.dark
                        ? Colors.white
                        : AhramColorsV3.textPrimary,
                  ),
                ),
                const Spacer(),
                // زر عرض النجاح (للتجربة)
                TextButton.icon(
                  onPressed: () => setState(() => _showSuccess = true),
                  icon: const Icon(Icons.check_circle_outline, size: 18),
                  label: const Text('تجربة النجاح'),
                ),
              ],
            ),
          ),
        ),

        // ═══════════════════════════════════════════════════════════════════════
        // شبكة الخدمات المتكيفة
        // ═══════════════════════════════════════════════════════════════════════
        SliverPadding(
          padding: AhramAdaptiveLayout.responsivePadding(context).copyWith(
            top: 4,
          ),
          sliver: SliverGrid(
            gridDelegate: SliverGridDelegateWithFixedCrossAxisCount(
              crossAxisCount: AhramAdaptiveLayout.gridCrossAxisCount(context),
              childAspectRatio: 1.15,
              crossAxisSpacing: 14,
              mainAxisSpacing: 14,
            ),
            delegate: SliverChildListDelegate([
              AhramServiceCard3D(
                title: 'محافظ كاش',
                subtitle: 'فودافون كاش مصر',
                icon: Icons.phone_android,
                color: AhramColorsV3.primarySky,
                onTap: () {},
              ),
              AhramServiceCard3D(
                title: 'بريد حساب',
                subtitle: 'حساب بريدي مصري',
                icon: Icons.local_post_office,
                color: AhramColorsV3.emerald,
                onTap: () {},
              ),
              AhramServiceCard3D(
                title: 'بنكك السودان',
                subtitle: 'تحويل بنكي',
                icon: Icons.account_balance,
                color: AhramColorsV3.warning,
                onTap: () {},
              ),
              AhramServiceCard3D(
                title: 'سيفا النيجر',
                subtitle: 'تحويل XOF',
                icon: Icons.public,
                color: const Color(0xFF8B5CF6),
                onTap: () {},
                isNew: true,
              ),
              AhramServiceCard3D(
                title: 'تحويل داخلي',
                subtitle: 'بين حسابات المنظومة',
                icon: Icons.compare_arrows,
                color: AhramColorsV3.gold,
                onTap: () {},
              ),
              AhramServiceCard3D(
                title: 'بريد بطاقة',
                subtitle: 'بطاقة بريدية',
                icon: Icons.credit_card,
                color: const Color(0xFFEC4899),
                onTap: () {},
              ),
            ]),
          ),
        ),

        // ═══════════════════════════════════════════════════════════════════════
        // أزرار 3D
        // ═══════════════════════════════════════════════════════════════════════
        SliverPadding(
          padding: AhramAdaptiveLayout.responsivePadding(context).copyWith(
            top: 24,
          ),
          sliver: SliverToBoxAdapter(
            child: AhramSectionCard(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'أزرار ثلاثية الأبعاد',
                    style: TextStyle(
                      fontSize: 16,
                      fontWeight: FontWeight.w900,
                      color: Theme.of(context).brightness == Brightness.dark
                          ? Colors.white
                          : AhramColorsV3.textPrimary,
                    ),
                  ),
                  const SizedBox(height: 16),
                  Wrap(
                    spacing: 12,
                    runSpacing: 12,
                    children: [
                      Ahram3DButton(
                        label: 'أساسي',
                        icon: Icons.check,
                        variant: AhramButtonVariant.primary,
                        isFullWidth: false,
                        onPressed: () {},
                      ),
                      Ahram3DButton(
                        label: 'نجاح',
                        icon: Icons.done,
                        variant: AhramButtonVariant.success,
                        isFullWidth: false,
                        onPressed: () {},
                      ),
                      Ahram3DButton(
                        label: 'تحذير',
                        icon: Icons.warning,
                        variant: AhramButtonVariant.danger,
                        isFullWidth: false,
                        onPressed: () {},
                      ),
                      Ahram3DButton(
                        label: 'ذهبي',
                        icon: Icons.star,
                        variant: AhramButtonVariant.gold,
                        isFullWidth: false,
                        onPressed: () {},
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ),
        ),

        // ═══════════════════════════════════════════════════════════════════════
        // مؤشر التحميل
        // ═══════════════════════════════════════════════════════════════════════
        SliverPadding(
          padding: AhramAdaptiveLayout.responsivePadding(context).copyWith(
            top: 16,
          ),
          sliver: SliverToBoxAdapter(
            child: AhramSectionCard(
              child: Row(
                children: [
                  Text(
                    'مؤشر التحميل:',
                    style: TextStyle(
                      fontWeight: FontWeight.w700,
                      color: Theme.of(context).brightness == Brightness.dark
                          ? Colors.white
                          : AhramColorsV3.textPrimary,
                    ),
                  ),
                  const SizedBox(width: 24),
                  const AhramLoadingIndicator(size: 40),
                  const SizedBox(width: 24),
                  const AhramLoadingIndicator(
                    size: 32,
                    color: AhramColorsV3.gold,
                  ),
                ],
              ),
            ),
          ),
        ),

        // ═══════════════════════════════════════════════════════════════════════
        // دخول متتابع
        // ═══════════════════════════════════════════════════════════════════════
        SliverPadding(
          padding: AhramAdaptiveLayout.responsivePadding(context).copyWith(
            top: 16,
            bottom: 100,
          ),
          sliver: SliverToBoxAdapter(
            child: AhramSectionCard(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'تأثير الدخول المتتابع:',
                    style: TextStyle(
                      fontWeight: FontWeight.w700,
                      color: Theme.of(context).brightness == Brightness.dark
                          ? Colors.white
                          : AhramColorsV3.textPrimary,
                    ),
                  ),
                  const SizedBox(height: 16),
                  AhramStaggeredList(
                    children: List.generate(
                      4,
                      (i) => Container(
                        margin: const EdgeInsets.only(bottom: 8),
                        padding: const EdgeInsets.all(16),
                        decoration: BoxDecoration(
                          color: AhramColorsV3.primarySky.withOpacity(0.08),
                          borderRadius: BorderRadius.circular(12),
                        ),
                        child: Row(
                          children: [
                            Icon(
                              Icons.info_outline,
                              color: AhramColorsV3.primarySky.withOpacity(0.7),
                            ),
                            const SizedBox(width: 12),
                            Text('عنصر ${i + 1} — دخول متتابع'),
                          ],
                        ),
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ],
    );
  }

  void _showInbox(BuildContext context) {
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (context) => DraggableScrollableSheet(
        initialChildSize: 0.7,
        maxChildSize: 0.9,
        minChildSize: 0.5,
        builder: (context, scrollController) {
          return Container(
            decoration: BoxDecoration(
              color: Theme.of(context).scaffoldBackgroundColor,
              borderRadius: const BorderRadius.vertical(
                top: Radius.circular(24),
              ),
            ),
            child: Column(
              children: [
                Container(
                  margin: const EdgeInsets.only(top: 12),
                  width: 40,
                  height: 4,
                  decoration: BoxDecoration(
                    color: Colors.grey.shade400,
                    borderRadius: BorderRadius.circular(2),
                  ),
                ),
                Padding(
                  padding: const EdgeInsets.all(20),
                  child: Row(
                    children: [
                      Text(
                        'صندوق الوارد',
                        style: TextStyle(
                          fontSize: 20,
                          fontWeight: FontWeight.w900,
                          color:
                              Theme.of(context).brightness == Brightness.dark
                                  ? Colors.white
                                  : AhramColorsV3.textPrimary,
                        ),
                      ),
                      const Spacer(),
                      TextButton(
                        onPressed: () {
                          AhramNotificationHub().markAllAsRead();
                          Navigator.pop(context);
                        },
                        child: const Text('تحديد الكل مقروء'),
                      ),
                    ],
                  ),
                ),
                Expanded(
                  child: AhramNotificationHub().inbox.isEmpty
                      ? Center(
                          child: Column(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              Icon(
                                Icons.notifications_off_outlined,
                                size: 48,
                                color: AhramColorsV3.textMuted,
                              ),
                              const SizedBox(height: 12),
                              Text(
                                'لا توجد إشعارات',
                                style: TextStyle(
                                  color: AhramColorsV3.textMuted,
                                  fontWeight: FontWeight.w700,
                                ),
                              ),
                            ],
                          ),
                        )
                      : ListView.builder(
                          controller: scrollController,
                          itemCount: AhramNotificationHub().inbox.length,
                          itemBuilder: (context, index) {
                            final n = AhramNotificationHub().inbox[index];
                            return ListTile(
                              leading: Icon(
                                _iconForType(n.type),
                                color: n.isRead
                                    ? AhramColorsV3.textMuted
                                    : AhramColorsV3.primarySky,
                              ),
                              title: Text(
                                n.title,
                                style: TextStyle(
                                  fontWeight: n.isRead
                                      ? FontWeight.w600
                                      : FontWeight.w800,
                                ),
                              ),
                              subtitle: Text(n.body),
                              trailing: n.isRead
                                  ? null
                                  : Container(
                                      width: 8,
                                      height: 8,
                                      decoration: const BoxDecoration(
                                        color: AhramColorsV3.danger,
                                        shape: BoxShape.circle,
                                      ),
                                    ),
                              onTap: () {
                                AhramNotificationHub().markAsRead(n.id ?? '');
                                Navigator.pop(context);
                              },
                            );
                          },
                        ),
                ),
              ],
            ),
          );
        },
      ),
    );
  }

  IconData _iconForType(String type) => switch (type) {
        'transaction' => Icons.swap_horiz,
        'executor_task' => Icons.assignment,
        'rate_alert' => Icons.trending_up,
        'support_reply' => Icons.support_agent,
        'security' => Icons.security,
        'deposit' => Icons.account_balance_wallet,
        _ => Icons.notifications,
      };
}
