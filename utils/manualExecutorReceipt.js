'use strict';

const { createCanvas } = require('canvas');

const SUPPORT_PHONE = '01108172258';
const SUCCESS_COLORS = {
    page: '#f6faf8',
    paper: '#ffffff',
    accent: '#08a85b',
    accentDark: '#078b4c',
    accentSoft: '#eaf9f1',
    ink: '#14213a',
    muted: '#6b778d',
    line: '#dbe4e1',
    headerBorder: '#56c993',
    cardBorder: '#e2ece7',
    supportBorder: '#9ce2bd',
    iconBorder: '#c4ebd7',
    dotLine: '#74cfa2',
    markBorder: '#5bd49a',
    markShadow: 'rgba(8, 168, 91, 0.22)',
    headerFill: '#fbfffd',
    supportFill: '#fbfffd'
};

const CANCELLED_COLORS = {
    page: '#fff6f5',
    paper: '#ffffff',
    accent: '#d92d20',
    accentDark: '#a61b14',
    accentSoft: '#fff0ef',
    ink: '#1d2939',
    muted: '#7a5a58',
    line: '#efd7d4',
    headerBorder: '#eb8077',
    cardBorder: '#f0d8d5',
    supportBorder: '#efb9b3',
    iconBorder: '#f1c8c3',
    dotLine: '#e99b93',
    markBorder: '#eea29a',
    markShadow: 'rgba(217, 45, 32, 0.22)',
    headerFill: '#fffafa',
    supportFill: '#fffafa'
};

class ManualExecutionNumberError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'ManualExecutionNumberError';
        this.code = code;
    }
}

const digitsOnly = (value) => String(value || '').replace(/[^0-9]/g, '');

const maskManualExecutionNumber = (value) => {
    const digits = digitsOnly(value);
    if (!digits) return '';

    if (/^01\d{9}$/.test(digits)) return `${digits.slice(0, 3)}****${digits.slice(-4)}`;
    if (/^\d{3}$/.test(digits)) return `01******${digits}`;
    if (/^\d{4}$/.test(digits)) return `01*****${digits}`;

    throw new ManualExecutionNumberError(
        'INVALID_EXECUTION_NUMBER',
        'رقم التنفيذ يجب أن يكون رقم هاتف من 11 رقمًا أو آخر 3 أو 4 أرقام.'
    );
};

const formatAmount = (value) => {
    const amount = Number(value);
    if (!Number.isFinite(amount)) return '0';
    return amount.toLocaleString('en-US', { maximumFractionDigits: 0 });
};

const tripoliDateTimeParts = (value) => {
    const date = value instanceof Date ? value : new Date(value || Date.now());
    const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;
    const dateParts = new Intl.DateTimeFormat('en-GB-u-nu-latn', {
        timeZone: 'Africa/Tripoli',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).formatToParts(safeDate);
    const timeParts = new Intl.DateTimeFormat('en-US-u-nu-latn', {
        timeZone: 'Africa/Tripoli',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true
    }).formatToParts(safeDate);
    const getPart = (parts, type) => parts.find((part) => part.type === type)?.value || '';
    const dayPeriod = getPart(timeParts, 'dayPeriod').toLowerCase() === 'pm' ? 'م' : 'ص';

    return {
        date: `${getPart(dateParts, 'year')}/${getPart(dateParts, 'month')}/${getPart(dateParts, 'day')}`,
        time: `${getPart(timeParts, 'hour')}:${getPart(timeParts, 'minute')}:${getPart(timeParts, 'second')} ${dayPeriod}`
    };
};

const roundedRect = (ctx, x, y, width, height, radius) => {
    const safeRadius = Math.min(radius, width / 2, height / 2);
    ctx.beginPath();
    ctx.moveTo(x + safeRadius, y);
    ctx.lineTo(x + width - safeRadius, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + safeRadius);
    ctx.lineTo(x + width, y + height - safeRadius);
    ctx.quadraticCurveTo(x + width, y + height, x + width - safeRadius, y + height);
    ctx.lineTo(x + safeRadius, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - safeRadius);
    ctx.lineTo(x, y + safeRadius);
    ctx.quadraticCurveTo(x, y, x + safeRadius, y);
    ctx.closePath();
};

const fillRoundedRect = (ctx, x, y, width, height, radius, fill, stroke, shadow = false) => {
    ctx.save();
    if (shadow) {
        ctx.shadowColor = 'rgba(20, 33, 58, 0.12)';
        ctx.shadowBlur = 18;
        ctx.shadowOffsetY = 8;
    }
    roundedRect(ctx, x, y, width, height, radius);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.restore();
    if (!stroke) return;

    roundedRect(ctx, x, y, width, height, radius);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = stroke;
    ctx.stroke();
};

const setFont = (ctx, size, weight = '700') => {
    ctx.font = `${weight} ${size}px "Segoe UI", Tahoma, Arial, sans-serif`;
};

const drawRight = (ctx, text, x, y, options = {}) => {
    ctx.save();
    ctx.direction = 'rtl';
    ctx.textAlign = 'right';
    ctx.fillStyle = options.color || SUCCESS_COLORS.ink;
    setFont(ctx, options.size || 20, options.weight || '700');
    ctx.fillText(String(text || '---'), x, y);
    ctx.restore();
};

const drawLeft = (ctx, text, x, y, options = {}) => {
    ctx.save();
    ctx.direction = 'ltr';
    ctx.textAlign = options.align || 'left';
    ctx.fillStyle = options.color || SUCCESS_COLORS.ink;
    ctx.font = `${options.weight || '700'} ${options.size || 20}px Arial, "Segoe UI", sans-serif`;
    ctx.fillText(String(text || '---'), x, y);
    ctx.restore();
};

const drawCenter = (ctx, text, x, y, options = {}) => {
    ctx.save();
    ctx.direction = options.direction || 'rtl';
    ctx.textAlign = 'center';
    ctx.fillStyle = options.color || SUCCESS_COLORS.ink;
    setFont(ctx, options.size || 20, options.weight || '700');
    ctx.fillText(String(text || '---'), x, y);
    ctx.restore();
};

const fittedSize = (ctx, text, maxWidth, initialSize, weight = '900') => {
    for (let size = initialSize; size >= 14; size -= 1) {
        setFont(ctx, size, weight);
        if (ctx.measureText(String(text || '---')).width <= maxWidth) return size;
    }
    return 14;
};

const drawIconCircle = (ctx, x, y, drawIcon, colors) => {
    ctx.save();
    ctx.fillStyle = colors.accentSoft;
    ctx.beginPath();
    ctx.arc(x, y, 28, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = colors.iconBorder;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.strokeStyle = colors.accent;
    ctx.fillStyle = colors.accent;
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    drawIcon(ctx, x, y, colors);
    ctx.restore();
};

const receiptIcons = {
    phone: (ctx, x, y) => {
        roundedRect(ctx, x - 10, y - 15, 20, 30, 4);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(x, y + 10, 1.8, 0, Math.PI * 2);
        ctx.fill();
    },
    wallet: (ctx, x, y) => {
        roundedRect(ctx, x - 15, y - 10, 30, 22, 5);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x - 14, y - 4);
        ctx.lineTo(x + 8, y - 4);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(x + 8, y + 3, 1.8, 0, Math.PI * 2);
        ctx.fill();
    },
    service: (ctx, x, y) => {
        roundedRect(ctx, x - 13, y - 13, 26, 26, 4);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x - 7, y - 5);
        ctx.lineTo(x + 7, y - 5);
        ctx.moveTo(x - 7, y + 2);
        ctx.lineTo(x + 7, y + 2);
        ctx.moveTo(x - 7, y + 9);
        ctx.lineTo(x + 2, y + 9);
        ctx.stroke();
    },
    hash: (ctx, x, y, colors) => drawCenter(ctx, '#', x, y + 10, {
        size: 30,
        weight: '900',
        color: colors.accent,
        direction: 'ltr'
    }),
    reference: (ctx, x, y) => {
        ctx.beginPath();
        ctx.moveTo(x, y - 15);
        ctx.lineTo(x + 12, y - 8);
        ctx.lineTo(x + 12, y + 8);
        ctx.lineTo(x, y + 15);
        ctx.lineTo(x - 12, y + 8);
        ctx.lineTo(x - 12, y - 8);
        ctx.closePath();
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(x, y, 3, 0, Math.PI * 2);
        ctx.fill();
    },
    user: (ctx, x, y) => {
        ctx.beginPath();
        ctx.arc(x, y - 8, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(x, y + 11, 11, Math.PI, 0);
        ctx.stroke();
    },
    calendar: (ctx, x, y) => {
        roundedRect(ctx, x - 13, y - 12, 26, 25, 4);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x - 13, y - 4);
        ctx.lineTo(x + 13, y - 4);
        ctx.moveTo(x - 6, y - 16);
        ctx.lineTo(x - 6, y - 8);
        ctx.moveTo(x + 6, y - 16);
        ctx.lineTo(x + 6, y - 8);
        ctx.stroke();
    },
    clock: (ctx, x, y) => {
        ctx.beginPath();
        ctx.arc(x, y, 14, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x, y - 8);
        ctx.lineTo(x, y + 1);
        ctx.lineTo(x + 7, y + 5);
        ctx.stroke();
    },
    support: (ctx, x, y) => {
        ctx.beginPath();
        ctx.arc(x, y, 13, Math.PI * 1.15, Math.PI * 1.85);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x - 13, y + 2);
        ctx.lineTo(x - 13, y + 10);
        ctx.moveTo(x + 13, y + 2);
        ctx.lineTo(x + 13, y + 10);
        ctx.moveTo(x + 13, y + 10);
        ctx.lineTo(x + 5, y + 15);
        ctx.stroke();
    }
};

const drawStatusMark = (ctx, x, y, cancelled, colors) => {
    ctx.save();
    ctx.shadowColor = colors.markShadow;
    ctx.shadowBlur = 14;
    ctx.shadowOffsetY = 6;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(x, y, 45, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.strokeStyle = colors.markBorder;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(x, y, 45, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = colors.accent;
    ctx.lineWidth = 11;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    if (cancelled) {
        ctx.moveTo(x - 18, y - 18);
        ctx.lineTo(x + 18, y + 18);
        ctx.moveTo(x - 18, y + 18);
        ctx.lineTo(x + 18, y - 18);
    } else {
        ctx.moveTo(x - 20, y);
        ctx.lineTo(x - 5, y + 16);
        ctx.lineTo(x + 23, y - 17);
    }
    ctx.stroke();
};

const drawDetailRow = (ctx, y, row, isLast, colors) => {
    drawIconCircle(ctx, 620, y - 8, receiptIcons[row.icon] || receiptIcons.service, colors);
    drawRight(ctx, row.label, 572, y, { size: 18, color: colors.muted, weight: '800' });
    const valueSize = fittedSize(ctx, row.value, row.direction === 'ltr' ? 450 : 290, 19);
    if (row.direction === 'ltr') {
        drawLeft(ctx, row.value, 94, y, { size: valueSize, color: colors.ink, weight: '900' });
    } else {
        drawRight(ctx, row.value, 390, y, { size: valueSize, color: colors.ink, weight: '900' });
    }
    if (isLast) return;
    ctx.strokeStyle = colors.line;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(88, y + 24);
    ctx.lineTo(586, y + 24);
    ctx.stroke();
    ctx.setLineDash([]);
};

const isCancelledStatus = (value) => ['cancelled', 'cancelled_by_admin', 'rejected'].includes(String(value || '').toLowerCase());

function generateExecutorReceiptBase64(data = {}) {
    const width = 720;
    const height = 1340;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    const cancelled = isCancelledStatus(data.status);
    const colors = cancelled ? CANCELLED_COLORS : SUCCESS_COLORS;
    const dateTime = tripoliDateTimeParts(data.completedAt || data.cancelledAt);
    const customerPhone = String(data.customerPhone || data.walletNumber || '---').trim() || '---';
    const executionNumber = String(data.executionNumber || '').trim() || '---';
    const reference = String(data.executorReference || data.referenceNumber || '---').trim() || '---';
    const cancellationNumber = String(data.cancellationNumber || '---').trim() || '---';
    const cancellationReason = String(data.cancellationReason || data.reason || 'غير محدد').trim() || 'غير محدد';
    const amountCurrencyLabel = String(
        data.amountCurrencyLabel || (String(data.transferType || '').toLowerCase() === 'sefa_niger' ? 'سيفا' : 'ج.م')
    ).trim() || 'ج.م';

    ctx.fillStyle = colors.page;
    ctx.fillRect(0, 0, width, height);
    fillRoundedRect(ctx, 18, 18, width - 36, height - 36, 30, colors.paper, colors.cardBorder, true);

    fillRoundedRect(ctx, 56, 58, width - 112, 248, 28, colors.headerFill, colors.headerBorder, false);
    drawStatusMark(ctx, width / 2, 146, cancelled, colors);
    ctx.fillStyle = colors.accent;
    ctx.beginPath();
    ctx.arc(130, 145, 5, 0, Math.PI * 2);
    ctx.arc(590, 145, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = colors.dotLine;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([2, 5]);
    ctx.beginPath();
    ctx.moveTo(144, 145);
    ctx.lineTo(262, 145);
    ctx.moveTo(458, 145);
    ctx.lineTo(576, 145);
    ctx.stroke();
    ctx.setLineDash([]);
    drawCenter(ctx, cancelled ? 'تم إلغاء العملية' : 'تمت العملية بنجاح', width / 2, 238, {
        size: 40,
        weight: '900',
        color: colors.accentDark
    });
    ctx.fillStyle = colors.accent;
    ctx.beginPath();
    ctx.arc(width / 2, 270, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = colors.accent;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(width / 2 - 66, 270);
    ctx.lineTo(width / 2 - 10, 270);
    ctx.moveTo(width / 2 + 10, 270);
    ctx.lineTo(width / 2 + 66, 270);
    ctx.stroke();

    fillRoundedRect(ctx, 56, 344, width - 112, 148, 25, colors.paper, colors.cardBorder, true);
    drawIconCircle(ctx, 120, 418, receiptIcons.phone, colors);
    drawRight(ctx, 'رقم هاتف العميل', 620, 400, { size: 21, color: colors.muted, weight: '800' });
    drawLeft(ctx, customerPhone, 620, 452, {
        align: 'right',
        size: fittedSize(ctx, customerPhone, 430, 31),
        weight: '900',
        color: colors.ink
    });

    fillRoundedRect(ctx, 56, 520, width - 112, 148, 25, colors.paper, colors.cardBorder, true);
    drawIconCircle(ctx, 120, 594, receiptIcons.wallet, colors);
    drawRight(ctx, 'القيمة', 620, 574, { size: 21, color: colors.muted, weight: '800' });
    drawLeft(ctx, formatAmount(data.amount), 620, 626, { align: 'right', size: 38, weight: '900', color: colors.accent });
    drawRight(ctx, amountCurrencyLabel, 480, 626, { size: 25, weight: '900', color: colors.accent });

    const rows = cancelled
        ? [
            { icon: 'service', label: 'الخدمة', value: data.serviceName || 'محافظ كاش' },
            { icon: 'hash', label: 'رقم طلب الأهرام', value: data.customId || '---', direction: 'ltr' },
            { icon: 'reference', label: 'رقم الإلغاء', value: cancellationNumber, direction: 'ltr' },
            { icon: 'user', label: 'سبب الإلغاء', value: cancellationReason },
            { icon: 'calendar', label: 'التاريخ', value: dateTime.date, direction: 'ltr' },
            { icon: 'clock', label: 'الوقت', value: dateTime.time, direction: 'ltr' }
        ]
        : [
            { icon: 'service', label: 'الخدمة', value: data.serviceName || 'محافظ كاش' },
            { icon: 'hash', label: 'رقم طلب الأهرام', value: data.customId || '---', direction: 'ltr' },
            { icon: 'reference', label: data.executionReferenceLabel || 'مرجع المنفذ', value: reference, direction: 'ltr' },
            { icon: 'user', label: data.executionNumberLabel || 'رقم التنفيذ', value: executionNumber, direction: 'ltr' },
            { icon: 'calendar', label: 'التاريخ', value: dateTime.date, direction: 'ltr' },
            { icon: 'clock', label: 'الوقت', value: dateTime.time, direction: 'ltr' }
        ];

    const detailsY = 700;
    const detailsHeight = 88 + (rows.length * 56);
    fillRoundedRect(ctx, 56, detailsY, width - 112, detailsHeight, 25, colors.paper, colors.cardBorder, true);
    drawRight(ctx, 'تفاصيل العملية', 572, detailsY + 43, { size: 25, color: colors.accentDark, weight: '900' });
    drawIconCircle(ctx, 620, detailsY + 34, receiptIcons.service, colors);
    rows.forEach((row, index) => drawDetailRow(ctx, detailsY + 94 + (index * 56), row, index === rows.length - 1, colors));

    const supportY = detailsY + detailsHeight + 28;
    fillRoundedRect(ctx, 56, supportY, width - 112, 98, 24, colors.supportFill, colors.supportBorder, false);
    drawIconCircle(ctx, 120, supportY + 49, receiptIcons.support, colors);
    drawCenter(ctx, 'الدعم الفني واتساب فقط', 397, supportY + 39, { size: 18, weight: '900', color: colors.ink });
    drawCenter(ctx, SUPPORT_PHONE, 397, supportY + 73, { size: 24, weight: '900', color: colors.accentDark, direction: 'ltr' });

    const footerY = supportY + 140;
    ctx.strokeStyle = colors.supportBorder;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(80, footerY);
    ctx.lineTo(215, footerY);
    ctx.moveTo(505, footerY);
    ctx.lineTo(640, footerY);
    ctx.stroke();
    drawCenter(ctx, 'Power Pay AL-Ahram', width / 2, footerY + 10, { size: 23, weight: '900', color: colors.ink, direction: 'ltr' });

    return canvas.toDataURL('image/jpeg', 0.94);
}

module.exports = {
    ManualExecutionNumberError,
    maskManualExecutionNumber,
    tripoliDateTimeParts,
    generateExecutorReceiptBase64,
    generateManualExecutorReceiptBase64: generateExecutorReceiptBase64
};
