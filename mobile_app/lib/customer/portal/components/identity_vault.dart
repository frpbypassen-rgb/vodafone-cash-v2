import 'package:flutter/material.dart';

import '../customer_theme.dart';

class CustomerIdentityHeader extends StatelessWidget {
  const CustomerIdentityHeader({
    super.key,
    required this.name,
    required this.statusLabel,
    required this.statusColor,
    required this.isActive,
    this.photoUrl,
    this.authToken,
    this.uploading = false,
    this.onEditPhoto,
    this.onEditProfile,
  });

  final String name;
  final String statusLabel;
  final Color statusColor;
  final bool isActive;
  final String? photoUrl;
  final String? authToken;
  final bool uploading;
  final VoidCallback? onEditPhoto;
  final VoidCallback? onEditProfile;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(18),
      decoration: CustomerTheme.surfaceCard(context, accent: CustomerTheme.action),
      child: Column(
        children: [
          Stack(
            clipBehavior: Clip.none,
            children: [
              Container(
                width: 96,
                height: 96,
                padding: const EdgeInsets.all(3),
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  border: Border.all(
                    color: CustomerTheme.action.withValues(alpha: 0.45),
                    width: 2,
                  ),
                ),
                child: ClipOval(
                  child: photoUrl == null
                      ? Container(
                          color: CustomerTheme.action.withValues(alpha: 0.10),
                          child: const Icon(
                            Icons.person_outline,
                            color: CustomerTheme.action,
                            size: 48,
                          ),
                        )
                      : Image.network(
                          photoUrl!,
                          fit: BoxFit.cover,
                          headers: authToken == null
                              ? null
                              : {'Authorization': 'Bearer $authToken'},
                          errorBuilder: (_, _, _) => Container(
                            color: CustomerTheme.action.withValues(alpha: 0.10),
                            child: const Icon(
                              Icons.person_outline,
                              color: CustomerTheme.action,
                              size: 48,
                            ),
                          ),
                        ),
                ),
              ),
              if (onEditPhoto != null)
                PositionedDirectional(
                  bottom: -4,
                  end: -4,
                  child: Material(
                    color: CustomerTheme.action,
                    shape: const CircleBorder(),
                    child: InkWell(
                      onTap: uploading ? null : onEditPhoto,
                      customBorder: const CircleBorder(),
                      child: SizedBox(
                        width: 38,
                        height: 38,
                        child: uploading
                            ? const Padding(
                                padding: EdgeInsets.all(10),
                                child: CircularProgressIndicator(
                                  strokeWidth: 2,
                                  color: Colors.white,
                                ),
                              )
                            : const Icon(
                                Icons.camera_alt_outlined,
                                color: Colors.white,
                                size: 18,
                              ),
                      ),
                    ),
                  ),
                ),
            ],
          ),
          const SizedBox(height: 14),
          Text(
            name,
            textAlign: TextAlign.center,
            style: Theme.of(context).textTheme.titleLarge?.copyWith(
              fontWeight: FontWeight.w900,
            ),
          ),
          const SizedBox(height: 8),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
            decoration: BoxDecoration(
              color: statusColor.withValues(alpha: 0.10),
              borderRadius: BorderRadius.circular(99),
              border: Border.all(color: statusColor.withValues(alpha: 0.25)),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(
                  isActive
                      ? Icons.check_circle_outline
                      : Icons.pause_circle_outline,
                  color: statusColor,
                  size: 16,
                ),
                const SizedBox(width: 6),
                Text(
                  statusLabel,
                  style: TextStyle(
                    color: statusColor,
                    fontWeight: FontWeight.w800,
                    fontSize: 13,
                  ),
                ),
              ],
            ),
          ),
          if (onEditProfile != null) ...[
            const SizedBox(height: 12),
            OutlinedButton.icon(
              onPressed: onEditProfile,
              icon: const Icon(Icons.edit_outlined, size: 18),
              label: const Text('تعديل البيانات'),
            ),
          ],
        ],
      ),
    );
  }
}

class CustomerGroupedSection extends StatelessWidget {
  const CustomerGroupedSection({
    super.key,
    required this.title,
    required this.icon,
    required this.children,
  });

  final String title;
  final IconData icon;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: CustomerTheme.surfaceCard(context),
      padding: const EdgeInsets.fromLTRB(14, 14, 14, 6),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Container(
                width: 36,
                height: 36,
                decoration: BoxDecoration(
                  color: CustomerTheme.action.withValues(alpha: 0.12),
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Icon(icon, color: CustomerTheme.action, size: 20),
              ),
              const SizedBox(width: 10),
              Text(
                title,
                style: const TextStyle(
                  fontWeight: FontWeight.w900,
                  fontSize: 16,
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          ...children,
        ],
      ),
    );
  }
}

class CustomerSettingsRow extends StatelessWidget {
  const CustomerSettingsRow({
    super.key,
    required this.icon,
    required this.title,
    this.subtitle,
    this.trailing,
    this.onTap,
    this.last = false,
  });

  final IconData icon;
  final String title;
  final String? subtitle;
  final Widget? trailing;
  final VoidCallback? onTap;
  final bool last;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Column(
      children: [
        InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(8),
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 10),
            child: Row(
              children: [
                Icon(icon, color: CustomerTheme.action, size: 22),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        title,
                        style: const TextStyle(fontWeight: FontWeight.w800),
                      ),
                      if (subtitle != null) ...[
                        const SizedBox(height: 2),
                        Text(
                          subtitle!,
                          style: TextStyle(
                            fontSize: 12,
                            color: colors.onSurfaceVariant,
                          ),
                        ),
                      ],
                    ],
                  ),
                ),
                trailing ??
                    Icon(
                      Icons.chevron_left,
                      color: colors.onSurfaceVariant,
                    ),
              ],
            ),
          ),
        ),
        if (!last)
          Divider(height: 1, color: colors.outlineVariant.withValues(alpha: 0.6)),
      ],
    );
  }
}
