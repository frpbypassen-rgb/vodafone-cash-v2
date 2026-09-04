import 'package:flutter/material.dart';

import '../brand_theme.dart';
import '../customer/transfer_step_bar.dart';
import '../mobile_api.dart';
import 'company_access_denied.dart';
import 'company_service_catalog.dart';

class CompanyGalleryScreen extends StatelessWidget {
  const CompanyGalleryScreen({
    super.key,
    required this.controller,
    required this.onOpenBench,
  });

  final SessionController controller;
  final ValueChanged<CompanyServiceChoice> onOpenBench;

  @override
  Widget build(BuildContext context) {
    if (!controller.canCreateTransfer) {
      return const CompanyAccessDenied(
        title: 'غير مسموح بإنشاء تحويل',
        message:
            'حساب المحاسب يتابع الرصيد والكشوف فقط، ولا يفتح معرض الإرسال.',
      );
    }
    final available = controller.session?.serviceCatalog
        .map((item) => '${item['key'] ?? ''}')
        .where((key) => key.isNotEmpty)
        .toSet();
    return CompanyGalleryGrid(
      availableKeys: available == null || available.isEmpty
          ? companyServiceChannels.map((item) => item.key).toSet()
          : available,
      onOpen: onOpenBench,
    );
  }
}

class CompanyGalleryGrid extends StatelessWidget {
  const CompanyGalleryGrid({
    super.key,
    required this.availableKeys,
    required this.onOpen,
  });

  final Set<String> availableKeys;
  final ValueChanged<CompanyServiceChoice> onOpen;

  Future<void> _openChannel(
    BuildContext context,
    CompanyServiceChannel channel,
  ) async {
    if (channel.subtypes.isEmpty) {
      onOpen(CompanyServiceChoice(serviceKey: channel.key));
      return;
    }
    final selected = await showModalBottomSheet<CompanyServiceChoice>(
      context: context,
      showDragHandle: true,
      builder: (sheetContext) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 20),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(
                channel.title,
                style: const TextStyle(
                  fontWeight: FontWeight.w900,
                  fontSize: 18,
                ),
              ),
              const SizedBox(height: 6),
              Text(
                'اختر نوع المنضدة. لن تُفتح الخدمات الأخرى معها.',
                style: TextStyle(
                  color: Theme.of(sheetContext).colorScheme.onSurfaceVariant,
                ),
              ),
              const SizedBox(height: 14),
              for (final choice in channel.subtypes)
                Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: ListTile(
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(12),
                      side: BorderSide(
                        color: AhramColors.gold.withValues(alpha: 0.28),
                      ),
                    ),
                    title: Text(
                      choice.subtype == 'instapay'
                          ? 'إنستا باي'
                          : choice.subtype == 'nita_account'
                          ? 'NITA ACCOUNT'
                          : choice.subtype == 'nita'
                          ? 'NITA'
                          : 'تحويل بنكي',
                      style: const TextStyle(fontWeight: FontWeight.w800),
                    ),
                    trailing: const Icon(Icons.chevron_left),
                    onTap: () => Navigator.pop(sheetContext, choice),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
    if (selected != null) onOpen(selected);
  }

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 34),
      children: [
        Text(
          'معرض الخدمات',
          style: Theme.of(
            context,
          ).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w900),
        ),
        const SizedBox(height: 6),
        Text(
          'كل قناة تفتح منضدة مستقلة. لا توجد صفحة تحويل مجمّعة.',
          style: TextStyle(
            height: 1.5,
            color: Theme.of(context).colorScheme.onSurfaceVariant,
          ),
        ),
        const SizedBox(height: 16),
        LayoutBuilder(
          builder: (context, constraints) {
            final columns = transferCatalogColumns(constraints.maxWidth);
            final width =
                (constraints.maxWidth - (12 * (columns - 1))) / columns;
            return Wrap(
              spacing: 12,
              runSpacing: 12,
              children: companyServiceChannels.map((channel) {
                final available = availableKeys.contains(channel.key);
                return SizedBox(
                  width: width,
                  child: _ChannelTile(
                    channel: channel,
                    available: available,
                    onTap: available
                        ? () => _openChannel(context, channel)
                        : null,
                  ),
                );
              }).toList(),
            );
          },
        ),
      ],
    );
  }
}

class _ChannelTile extends StatelessWidget {
  const _ChannelTile({
    required this.channel,
    required this.available,
    required this.onTap,
  });

  final CompanyServiceChannel channel;
  final bool available;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Material(
      color: colors.surface,
      borderRadius: BorderRadius.circular(16),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(16),
        child: Container(
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(16),
            border: Border.all(
              color: channel.color.withValues(alpha: available ? 0.38 : 0.16),
            ),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Icon(channel.icon, color: channel.color, size: 28),
              const SizedBox(height: 10),
              Text(
                channel.title,
                style: const TextStyle(
                  fontWeight: FontWeight.w900,
                  fontSize: 15,
                ),
              ),
              const SizedBox(height: 4),
              Text(
                available ? channel.subtitle : 'غير متاحة لهذا الحساب',
                style: TextStyle(
                  fontSize: 12,
                  height: 1.4,
                  color: colors.onSurfaceVariant,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
