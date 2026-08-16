import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

class RateAlertOverlay extends StatefulWidget {
  const RateAlertOverlay({
    super.key,
    required this.alert,
    this.activated = false,
    this.onExpired,
  });

  final Map<String, dynamic> alert;
  final bool activated;
  final VoidCallback? onExpired;

  @override
  State<RateAlertOverlay> createState() => _RateAlertOverlayState();
}

class _RateAlertOverlayState extends State<RateAlertOverlay> {
  Timer? _ticker;
  bool _finalWarningPlayed = false;
  bool _minimized = false;

  @override
  void initState() {
    super.initState();
    if (!widget.activated) {
      _ticker = Timer.periodic(const Duration(seconds: 1), (_) => _tick());
    } else {
      SystemSound.play(SystemSoundType.alert);
    }
  }

  @override
  void didUpdateWidget(covariant RateAlertOverlay oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.alert['effectiveAt'] != widget.alert['effectiveAt']) {
      _finalWarningPlayed = false;
    }
  }

  @override
  void dispose() {
    _ticker?.cancel();
    super.dispose();
  }

  int get _seconds {
    final effectiveAt = DateTime.tryParse(
      '${widget.alert['effectiveAt'] ?? ''}',
    );
    if (effectiveAt == null) return 0;
    return effectiveAt.difference(DateTime.now()).inSeconds.clamp(0, 3600);
  }

  void _tick() {
    if (!mounted) return;
    final seconds = _seconds;
    if (seconds <= 0) {
      _ticker?.cancel();
      widget.onExpired?.call();
      return;
    }
    if (seconds <= 10 && !_finalWarningPlayed) {
      _finalWarningPlayed = true;
      SystemSound.play(SystemSoundType.alert);
    }
    setState(() {});
  }

  String _formatCountdown(int seconds) {
    final minutes = (seconds ~/ 60).toString().padLeft(2, '0');
    final remainder = (seconds % 60).toString().padLeft(2, '0');
    return '$minutes:$remainder';
  }

  List<Map<String, dynamic>> get _rateChanges {
    final raw = widget.alert['rateChanges'];
    if (raw is! List) return const [];
    return raw
        .whereType<Map>()
        .map((row) => Map<String, dynamic>.from(row))
        .toList(growable: false);
  }

  Widget _buildRateRows() {
    final rows = _rateChanges;
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 0, 12, 12),
      child: Column(
        children: rows
            .map((row) {
              final isUp = '${row['direction'] ?? ''}' != 'down';
              final oldRate = (row['oldRate'] as num?)?.toDouble() ?? 0;
              final newRate = (row['newRate'] as num?)?.toDouble() ?? 0;
              return Container(
                margin: const EdgeInsets.only(top: 7),
                padding: const EdgeInsets.symmetric(
                  horizontal: 11,
                  vertical: 9,
                ),
                decoration: BoxDecoration(
                  color: Colors.white.withValues(alpha: .11),
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(color: Colors.white.withValues(alpha: .2)),
                ),
                child: Row(
                  children: [
                    Expanded(
                      child: Text(
                        '${row['label'] ?? ''}',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          color: Colors.white,
                          fontWeight: FontWeight.w800,
                        ),
                      ),
                    ),
                    Text(
                      oldRate.toStringAsFixed(2),
                      textDirection: TextDirection.ltr,
                      style: TextStyle(
                        color: Colors.white.withValues(alpha: .68),
                        decoration: TextDecoration.lineThrough,
                      ),
                    ),
                    const SizedBox(width: 6),
                    Icon(
                      isUp
                          ? Icons.arrow_upward_rounded
                          : Icons.arrow_downward_rounded,
                      size: 18,
                      color: isUp
                          ? const Color(0xFF9FF1CA)
                          : const Color(0xFFFFD2D2),
                    ),
                    const SizedBox(width: 6),
                    Text(
                      newRate.toStringAsFixed(2),
                      textDirection: TextDirection.ltr,
                      style: const TextStyle(
                        color: Colors.white,
                        fontWeight: FontWeight.w900,
                      ),
                    ),
                  ],
                ),
              );
            })
            .toList(growable: false),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final scheduled = !widget.activated;
    final seconds = _seconds;
    final title = scheduled
        ? 'تنبيه طارئ: تحديث أسعار الصرف'
        : 'تم تفعيل السعر الجديد';
    final subtitle = scheduled
        ? 'سيتم تطبيق السعر الجديد تلقائياً عند انتهاء العداد'
        : 'تم تحديث الأسعار في حسابك بنجاح';
    final details =
        '${widget.alert[scheduled ? 'rateChangesText' : 'currentRatesText'] ?? ''}'
            .trim();
    final total = (widget.alert['delaySeconds'] is num)
        ? (widget.alert['delaySeconds'] as num).toDouble()
        : 60.0;
    final progress = scheduled && total > 0
        ? (seconds / total).clamp(0.0, 1.0)
        : 1.0;

    if (_minimized && scheduled) {
      return SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(12, 10, 12, 0),
          child: Align(
            alignment: AlignmentDirectional.topEnd,
            child: Material(
              color: Colors.transparent,
              child: InkWell(
                onTap: () => setState(() => _minimized = false),
                borderRadius: BorderRadius.circular(30),
                child: Ink(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 12,
                    vertical: 10,
                  ),
                  decoration: BoxDecoration(
                    color: const Color(0xFF075C82),
                    borderRadius: BorderRadius.circular(30),
                    border: Border.all(
                      color: Colors.white.withValues(alpha: .3),
                    ),
                    boxShadow: [
                      BoxShadow(
                        color: Colors.black.withValues(alpha: .24),
                        blurRadius: 18,
                        offset: const Offset(0, 8),
                      ),
                    ],
                  ),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      const Icon(
                        Icons.notifications_active_outlined,
                        color: Color(0xFFF4C344),
                        size: 19,
                      ),
                      const SizedBox(width: 7),
                      Text(
                        _formatCountdown(seconds),
                        textDirection: TextDirection.ltr,
                        style: const TextStyle(
                          color: Colors.white,
                          fontWeight: FontWeight.w900,
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
      );
    }

    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(12, 10, 12, 0),
        child: Material(
          color: Colors.transparent,
          child: Container(
            width: double.infinity,
            decoration: BoxDecoration(
              color: scheduled
                  ? const Color(0xFF075C82)
                  : const Color(0xFF00875A),
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: Colors.white.withValues(alpha: .30)),
              boxShadow: [
                BoxShadow(
                  color: Colors.black.withValues(alpha: .24),
                  blurRadius: 24,
                  offset: const Offset(0, 10),
                ),
              ],
            ),
            child: ClipRRect(
              borderRadius: BorderRadius.circular(12),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Padding(
                    padding: const EdgeInsets.all(12),
                    child: Row(
                      children: [
                        Container(
                          width: 38,
                          height: 38,
                          decoration: BoxDecoration(
                            color: Colors.white.withValues(alpha: .15),
                            shape: BoxShape.circle,
                          ),
                          child: Icon(
                            scheduled
                                ? Icons.notifications_active_outlined
                                : Icons.verified_rounded,
                            color: Colors.white,
                          ),
                        ),
                        const SizedBox(width: 10),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                title,
                                style: const TextStyle(
                                  color: Colors.white,
                                  fontWeight: FontWeight.w900,
                                ),
                              ),
                              const SizedBox(height: 2),
                              Text(
                                subtitle,
                                style: TextStyle(
                                  color: Colors.white.withValues(alpha: .85),
                                  fontSize: 12,
                                ),
                              ),
                            ],
                          ),
                        ),
                        if (scheduled)
                          Text(
                            _formatCountdown(seconds),
                            textDirection: TextDirection.ltr,
                            style: const TextStyle(
                              color: Colors.white,
                              fontSize: 20,
                              fontWeight: FontWeight.w900,
                            ),
                          ),
                        if (scheduled) ...[
                          const SizedBox(width: 8),
                          IconButton(
                            tooltip: 'تصغير التنبيه',
                            onPressed: () => setState(() => _minimized = true),
                            icon: const Icon(
                              Icons.remove_rounded,
                              color: Colors.white,
                            ),
                          ),
                        ],
                      ],
                    ),
                  ),
                  if (scheduled && _rateChanges.isNotEmpty)
                    _buildRateRows()
                  else if (details.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.fromLTRB(14, 0, 14, 14),
                      child: Text(
                        details,
                        style: const TextStyle(
                          color: Colors.white,
                          height: 1.55,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                    ),
                  if (scheduled)
                    LinearProgressIndicator(
                      value: progress,
                      minHeight: 4,
                      backgroundColor: Colors.white.withValues(alpha: .25),
                      valueColor: AlwaysStoppedAnimation<Color>(
                        colors.tertiary,
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
