import 'package:flutter/material.dart';

import '../brand_theme.dart';
import '../mobile_api.dart';
import 'company_service_catalog.dart';

class CompanyDepositSheet extends StatefulWidget {
  const CompanyDepositSheet({super.key, required this.api});

  final MobileApi api;

  @override
  State<CompanyDepositSheet> createState() => _CompanyDepositSheetState();
}

class _CompanyDepositSheetState extends State<CompanyDepositSheet> {
  final _formKey = GlobalKey<FormState>();
  final _amount = TextEditingController();
  final _note = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _amount.dispose();
    _note.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!_formKey.currentState!.validate()) return;
    final amount = double.parse(_amount.text.replaceAll(',', '').trim());
    final note = _note.text.trim();
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await widget.api.createTicket(
        subject: 'طلب إيداع رصيد',
        message: companyDepositSupportMessage(amount: amount, note: note),
        category: 'balance',
      );
      if (mounted) Navigator.pop(context, true);
    } on ApiFailure catch (error) {
      if (mounted) setState(() => _error = error.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.only(
        left: 20,
        right: 20,
        top: 12,
        bottom: 20 + MediaQuery.viewInsetsOf(context).bottom,
      ),
      child: Form(
        key: _formKey,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              'طلب إيداع رصيد',
              style: Theme.of(
                context,
              ).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w900),
            ),
            const SizedBox(height: 6),
            Text(
              'يُرسل الطلب إلى الإدارة عبر الدعم الفني. لا يُخصم ولا يُضاف رصيد من هنا.',
              style: TextStyle(
                height: 1.5,
                color: Theme.of(context).colorScheme.onSurfaceVariant,
              ),
            ),
            const SizedBox(height: 14),
            TextFormField(
              controller: _amount,
              keyboardType: const TextInputType.numberWithOptions(
                decimal: true,
              ),
              decoration: const InputDecoration(
                labelText: 'القيمة بالدينار الليبي',
                prefixIcon: Icon(Icons.payments_outlined),
              ),
              validator: (value) {
                final parsed = double.tryParse(
                  (value ?? '').replaceAll(',', '').trim(),
                );
                if (parsed == null || parsed <= 0) {
                  return 'أدخل قيمة صحيحة أكبر من صفر.';
                }
                return null;
              },
            ),
            const SizedBox(height: 12),
            TextFormField(
              controller: _note,
              minLines: 2,
              maxLines: 3,
              decoration: const InputDecoration(
                labelText: 'مرجع الإيداع',
                prefixIcon: Icon(Icons.notes_outlined),
              ),
              validator: (value) => (value ?? '').trim().length < 3
                  ? 'أدخل ملاحظة توضح مرجع الإيداع.'
                  : null,
            ),
            if (_error != null) ...[
              const SizedBox(height: 10),
              Text(_error!, style: const TextStyle(color: AhramColors.danger)),
            ],
            const SizedBox(height: 16),
            FilledButton.icon(
              onPressed: _busy ? null : _submit,
              icon: _busy
                  ? const SizedBox(
                      width: 16,
                      height: 16,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.support_agent_outlined),
              label: Text(_busy ? 'جارٍ الإرسال...' : 'إرسال عبر الدعم'),
            ),
          ],
        ),
      ),
    );
  }
}
