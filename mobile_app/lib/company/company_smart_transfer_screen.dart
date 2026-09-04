import 'package:flutter/material.dart';

import '../brand_theme.dart';
import '../mobile_api.dart';
import 'company_access_denied.dart';
import 'smart_transfer_parser.dart';

class CompanySmartTransferScreen extends StatefulWidget {
  const CompanySmartTransferScreen({
    super.key,
    required this.controller,
    required this.onOpenBench,
  });

  final SessionController controller;
  final ValueChanged<SmartTransferDraft> onOpenBench;

  @override
  State<CompanySmartTransferScreen> createState() =>
      _CompanySmartTransferScreenState();
}

class _CompanySmartTransferScreenState
    extends State<CompanySmartTransferScreen> {
  final _message = TextEditingController();
  SmartTransferDraft? _draft;
  String? _status;

  @override
  void dispose() {
    _message.dispose();
    super.dispose();
  }

  void _analyze() {
    final text = _message.text.trim();
    if (text.length < 3) {
      setState(() {
        _draft = null;
        _status = 'الصق رسالة التحويل أولاً ثم اضغط تحليل.';
      });
      return;
    }
    final draft = parseTransferMessage(text);
    setState(() {
      _draft = draft;
      _status = draft.ready
          ? 'تم التحليل. راجع البيانات ثم افتح منضدة الخدمة. لن يُرسل التحويل من هنا.'
          : 'التحليل يحتاج مراجعة قبل فتح المنضدة.';
    });
  }

  String _serviceLabel(String? key) {
    return switch (key) {
      'post_account' => 'بريد حساب',
      'post_card' => 'بريد بطاقة',
      'bank_account' => 'حساب بنكي',
      'sefa_niger' => 'سيفا النيجر',
      'bankak_sudan' => 'بنكك السودان',
      _ => 'محافظ كاش',
    };
  }

  @override
  Widget build(BuildContext context) {
    if (!widget.controller.canCreateTransfer) {
      return const CompanyAccessDenied(
        title: 'غير مسموح بإنشاء تحويل',
        message:
            'حساب المحاسب يتابع الرصيد والكشوف فقط، ولا يحلل رسائل لإرسالها.',
      );
    }
    final colors = Theme.of(context).colorScheme;
    final draft = _draft;
    return ListView(
      padding: const EdgeInsets.fromLTRB(18, 18, 18, 34),
      children: [
        Text(
          'التحويل الذكي',
          style: TextStyle(
            fontSize: 22,
            fontWeight: FontWeight.w900,
            color: colors.onSurface,
          ),
        ),
        const SizedBox(height: 6),
        Text(
          'الصق رسالة العميل. التحليل يفتح منضدة الخدمة ولا يرسل العملية.',
          style: TextStyle(height: 1.55, color: colors.onSurfaceVariant),
        ),
        const SizedBox(height: 16),
        TextField(
          controller: _message,
          minLines: 5,
          maxLines: 8,
          maxLength: 2000,
          onChanged: (_) {
            if (_draft != null || _status != null) {
              setState(() {
                _draft = null;
                _status = null;
              });
            }
          },
          decoration: const InputDecoration(
            labelText: 'رسالة التحويل',
            alignLabelWithHint: true,
          ),
        ),
        const SizedBox(height: 8),
        FilledButton.icon(
          onPressed: _analyze,
          icon: const Icon(Icons.search_outlined),
          label: const Text('تحليل الرسالة'),
        ),
        if (_status != null) ...[
          const SizedBox(height: 14),
          Text(
            _status!,
            style: TextStyle(height: 1.5, color: colors.onSurfaceVariant),
          ),
        ],
        if (draft != null) ...[
          const SizedBox(height: 16),
          Container(
            padding: const EdgeInsets.all(16),
            decoration: BoxDecoration(
              color: colors.surface,
              borderRadius: BorderRadius.circular(14),
              border: Border.all(
                color: AhramColors.gold.withValues(alpha: 0.36),
              ),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                _DraftRow(
                  label: 'الخدمة',
                  value: _serviceLabel(draft.serviceKey),
                ),
                _DraftRow(
                  label: 'الهاتف',
                  value: draft.phone.isEmpty ? '—' : draft.phone,
                ),
                _DraftRow(
                  label: 'المبلغ',
                  value: draft.amountEGP == null
                      ? '—'
                      : '${draft.amountEGP} ج.م',
                ),
                if (draft.beneficiaryName.isNotEmpty)
                  _DraftRow(label: 'المستفيد', value: draft.beneficiaryName),
                if (draft.note.isNotEmpty)
                  _DraftRow(label: 'ملاحظة', value: draft.note),
                if (draft.missing.isNotEmpty)
                  _DraftRow(label: 'ناقص', value: draft.missing.join('، ')),
                ...draft.warnings.map(
                  (warning) => Padding(
                    padding: const EdgeInsets.only(top: 8),
                    child: Text(
                      warning,
                      style: TextStyle(
                        height: 1.45,
                        color: colors.onSurfaceVariant,
                      ),
                    ),
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 14),
          FilledButton.icon(
            onPressed: draft.phone.isEmpty && draft.amountEGP == null
                ? null
                : () => widget.onOpenBench(draft),
            icon: const Icon(Icons.open_in_new_outlined),
            label: const Text('فتح المنضدة دون إرسال'),
          ),
        ],
      ],
    );
  }
}

class _DraftRow extends StatelessWidget {
  const _DraftRow({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 78,
            child: Text(
              label,
              style: TextStyle(
                fontWeight: FontWeight.w800,
                color: Theme.of(context).colorScheme.onSurfaceVariant,
              ),
            ),
          ),
          Expanded(
            child: Text(
              value,
              style: const TextStyle(fontWeight: FontWeight.w700),
            ),
          ),
        ],
      ),
    );
  }
}
