import 'package:flutter/material.dart';

import '../customer_theme.dart';

class CustomerReviewLine {
  const CustomerReviewLine(this.label, this.value);

  final String label;
  final String value;
}

/// Full-screen or inline review before confirming a transfer (step 3).
class CustomerReviewSeal extends StatelessWidget {
  const CustomerReviewSeal({
    super.key,
    required this.title,
    required this.lines,
    required this.onConfirm,
    required this.onBack,
    this.busy = false,
    this.confirmLabel = 'تأكيد وإرسال',
  });

  final String title;
  final List<CustomerReviewLine> lines;
  final VoidCallback onConfirm;
  final VoidCallback onBack;
  final bool busy;
  final String confirmLabel;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Container(
          padding: const EdgeInsets.all(20),
          decoration: CustomerTheme.heroPanel(),
          child: Column(
            children: [
              Container(
                width: 72,
                height: 72,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  border: Border.all(
                    color: CustomerTheme.action.withValues(alpha: 0.55),
                    width: 3,
                  ),
                ),
                child: Icon(
                  Icons.verified_outlined,
                  color: CustomerTheme.action,
                  size: 36,
                ),
              ),
              const SizedBox(height: 12),
              Text(
                title,
                textAlign: TextAlign.center,
                style: const TextStyle(
                  color: Colors.white,
                  fontWeight: FontWeight.w900,
                  fontSize: 18,
                ),
              ),
              const SizedBox(height: 4),
              Text(
                'راجع البيانات قبل الختم',
                style: TextStyle(
                  color: Colors.white.withValues(alpha: 0.72),
                  fontSize: 13,
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 16),
        ...lines.map(
          (line) => Padding(
            padding: const EdgeInsets.only(bottom: 10),
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
              decoration: CustomerTheme.surfaceCard(context),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      line.label,
                      style: TextStyle(
                        color: colors.onSurfaceVariant,
                        fontWeight: FontWeight.w700,
                        fontSize: 13,
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Flexible(
                    child: Text(
                      line.value,
                      textAlign: TextAlign.end,
                      style: TextStyle(
                        color: colors.onSurface,
                        fontWeight: FontWeight.w900,
                        fontSize: 14,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
        const Spacer(),
        FilledButton(
          onPressed: busy ? null : onConfirm,
          style: FilledButton.styleFrom(
            backgroundColor: CustomerTheme.action,
            foregroundColor: CustomerTheme.canvas,
            minimumSize: const Size.fromHeight(CustomerTheme.buttonHeightMobile),
          ),
          child: busy
              ? const SizedBox(
                  width: 22,
                  height: 22,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : Text(confirmLabel),
        ),
        const SizedBox(height: 10),
        OutlinedButton(
          onPressed: busy ? null : onBack,
          child: const Text('رجوع للتعديل'),
        ),
      ],
    );
  }
}

/// Success stamp after transfer submission (step 4).
class CustomerSuccessSeal extends StatelessWidget {
  const CustomerSuccessSeal({
    super.key,
    required this.txId,
    required this.message,
    required this.onNewTransfer,
    this.onShare,
  });

  final String txId;
  final String message;
  final VoidCallback onNewTransfer;
  final VoidCallback? onShare;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Column(
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        Container(
          width: 88,
          height: 88,
          decoration: BoxDecoration(
            color: CustomerTheme.success.withValues(alpha: 0.12),
            shape: BoxShape.circle,
            border: Border.all(color: CustomerTheme.success, width: 3),
          ),
          child: const Icon(
            Icons.check_rounded,
            color: CustomerTheme.success,
            size: 48,
          ),
        ),
        const SizedBox(height: 18),
        Text(
          'تم ختم العملية',
          style: TextStyle(
            fontWeight: FontWeight.w900,
            fontSize: 22,
            color: colors.onSurface,
          ),
        ),
        const SizedBox(height: 8),
        Text(
          message,
          textAlign: TextAlign.center,
          style: TextStyle(color: colors.onSurfaceVariant),
        ),
        const SizedBox(height: 16),
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
          decoration: CustomerTheme.surfaceCard(
            context,
            accent: CustomerTheme.success,
          ),
          child: Text(
            'رقم العملية: $txId',
            style: const TextStyle(fontWeight: FontWeight.w900),
          ),
        ),
        const SizedBox(height: 24),
        if (onShare != null) ...[
          FilledButton.icon(
            onPressed: onShare,
            icon: const Icon(Icons.share_outlined),
            label: const Text('مشاركة واتساب'),
            style: FilledButton.styleFrom(
              backgroundColor: CustomerTheme.success,
              minimumSize: const Size.fromHeight(48),
            ),
          ),
          const SizedBox(height: 10),
        ],
        OutlinedButton(
          onPressed: onNewTransfer,
          child: const Text('عملية جديدة'),
        ),
      ],
    );
  }
}

/// Shows review as full-screen route on mobile or returns true on desktop inline.
Future<bool> showCustomerTransferReview(
  BuildContext context, {
  required String title,
  required List<CustomerReviewLine> lines,
  required Future<void> Function() onConfirm,
  bool fullScreen = true,
}) async {
  if (fullScreen) {
    final approved = await Navigator.of(context).push<bool>(
      MaterialPageRoute<bool>(
        builder: (routeContext) => Scaffold(
          appBar: AppBar(title: const Text('مراجعة التحويل')),
          body: Padding(
            padding: const EdgeInsets.all(16),
            child: _ReviewRouteBody(
              title: title,
              lines: lines,
              onConfirm: onConfirm,
            ),
          ),
        ),
      ),
    );
    return approved == true;
  }
  return false;
}

class _ReviewRouteBody extends StatefulWidget {
  const _ReviewRouteBody({
    required this.title,
    required this.lines,
    required this.onConfirm,
  });

  final String title;
  final List<CustomerReviewLine> lines;
  final Future<void> Function() onConfirm;

  @override
  State<_ReviewRouteBody> createState() => _ReviewRouteBodyState();
}

class _ReviewRouteBodyState extends State<_ReviewRouteBody> {
  var _busy = false;

  Future<void> _confirm() async {
    setState(() => _busy = true);
    try {
      await widget.onConfirm();
      if (mounted) Navigator.pop(context, true);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return CustomerReviewSeal(
      title: widget.title,
      lines: widget.lines,
      busy: _busy,
      onConfirm: _confirm,
      onBack: () => Navigator.pop(context, false),
    );
  }
}
