const { createCanvas } = require('canvas');

const SUPPORT_PHONE = '01108172258';

const BRAND = {
    navy: '#101828',
    teal: '#00a6a6',
    gold: '#f5b83d',
    green: '#12b76a',
    bg: '#eef7fb',
    ink: '#111827',
    muted: '#667085',
    line: '#d9e4ea'
};

const formatAmount = (value) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return String(value || '0');
    return parsed.toLocaleString('ar-EG-u-nu-latn', { maximumFractionDigits: 0 });
};

const compactText = (value, max = 34) => {
    const text = String(value || '---').trim() || '---';
    return text.length > max ? `${text.slice(0, max - 3)}...` : text;
};

const roundedRect = (ctx, x, y, w, h, r) => {
    const radius = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + w - radius, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
    ctx.lineTo(x + w, y + h - radius);
    ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
    ctx.lineTo(x + radius, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
};

async function generateReceiptBase64(data) {
    const width = 640;
    const height = 1080;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    const setFont = (size, weight = 'bold', family = '"Segoe UI", Tahoma, Arial, sans-serif') => {
        ctx.font = `${weight} ${size}px ${family}`;
    };

    const fillCard = (x, y, w, h, r, fill, stroke = null, shadow = true) => {
        ctx.save();
        if (shadow) {
            ctx.shadowColor = 'rgba(16, 24, 40, 0.16)';
            ctx.shadowBlur = 22;
            ctx.shadowOffsetY = 14;
        }
        roundedRect(ctx, x, y, w, h, r);
        ctx.fillStyle = fill;
        ctx.fill();
        ctx.restore();

        if (stroke) {
            roundedRect(ctx, x, y, w, h, r);
            ctx.strokeStyle = stroke;
            ctx.lineWidth = 2;
            ctx.stroke();
        }
    };

    const drawCenteredFit = (text, y, maxWidth, size, color = BRAND.ink) => {
        const value = String(text || '---');
        let fontSize = size;
        do {
            setFont(fontSize, '900');
            if (ctx.measureText(value).width <= maxWidth || fontSize <= 24) break;
            fontSize -= 2;
        } while (fontSize > 24);
        ctx.textAlign = 'center';
        ctx.fillStyle = color;
        ctx.fillText(value, width / 2, y);
    };

    const drawEgpAmount = (amount, y, maxWidth, size) => {
        const numberText = formatAmount(amount);
        const currencyText = 'جنية';
        let fontSize = size;
        let totalWidth;
        let numberWidth;
        let currencyWidth;
        let gap;

        do {
            setFont(fontSize, '900');
            gap = Math.round(fontSize * 0.28);
            numberWidth = ctx.measureText(numberText).width;
            currencyWidth = ctx.measureText(currencyText).width;
            totalWidth = numberWidth + gap + currencyWidth;
            if (totalWidth <= maxWidth || fontSize <= 26) break;
            fontSize -= 2;
        } while (fontSize > 26);

        const startX = (width - totalWidth) / 2;
        ctx.textAlign = 'left';
        ctx.fillStyle = BRAND.teal;
        ctx.fillText(numberText, startX, y);
        ctx.fillText(currencyText, startX + numberWidth + gap, y);
    };

    const drawBrandMark = (x, y) => {
        ctx.save();
        ctx.globalAlpha = 0.16;
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(x, y, 30, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.fillStyle = BRAND.gold;
        ctx.beginPath();
        ctx.arc(x, y, 20, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = BRAND.navy;
        ctx.lineWidth = 5;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(x - 12, y);
        ctx.lineTo(x + 12, y);
        ctx.moveTo(x, y - 12);
        ctx.lineTo(x, y + 12);
        ctx.stroke();
        ctx.restore();
    };

    const bgGradient = ctx.createLinearGradient(0, 0, width, height);
    bgGradient.addColorStop(0, '#f8fcff');
    bgGradient.addColorStop(1, BRAND.bg);
    ctx.fillStyle = bgGradient;
    ctx.fillRect(0, 0, width, height);

    fillCard(34, 34, width - 68, height - 68, 34, '#f9fdff', null, true);

    const headerGradient = ctx.createLinearGradient(54, 58, width - 54, 214);
    headerGradient.addColorStop(0, BRAND.navy);
    headerGradient.addColorStop(0.58, '#14546a');
    headerGradient.addColorStop(1, BRAND.teal);
    fillCard(56, 58, width - 112, 166, 28, headerGradient, null, true);

    drawBrandMark(112, 166);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#fff';
    setFont(34, '900');
    ctx.fillText(data.documentTitle || 'إيصال تحويل', width - 84, 126);
    setFont(17, 'bold');
    ctx.fillStyle = '#d8fffb';
    ctx.fillText(data.documentSubtitle || 'مستند تنفيذ إلكتروني معتمد', width - 84, 158);

    fillCard(190, 202, 260, 52, 26, '#ffffff', null, true);
    ctx.fillStyle = BRAND.green;
    ctx.beginPath();
    ctx.arc(422, 228, 15, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(414, 228);
    ctx.lineTo(421, 236);
    ctx.lineTo(432, 219);
    ctx.stroke();
    ctx.fillStyle = BRAND.green;
    setFont(22, '900');
    ctx.textAlign = 'right';
    ctx.fillText('عملية ناجحة', 398, 236);

    const focusGradient = ctx.createLinearGradient(78, 288, width - 78, 430);
    focusGradient.addColorStop(0, '#ffffff');
    focusGradient.addColorStop(1, '#ecfffb');

    fillCard(76, 294, width - 152, 146, 30, focusGradient, '#bdebe4', true);
    ctx.fillStyle = BRAND.muted;
    setFont(19, '900');
    ctx.textAlign = 'center';
    ctx.fillText('رقم الهاتف / الحساب', width / 2, 334);
    drawCenteredFit(data.walletNumber, 400, width - 150, 52, BRAND.ink);

    fillCard(76, 464, width - 152, 150, 30, focusGradient, '#bdebe4', true);
    ctx.fillStyle = BRAND.muted;
    setFont(19, '900');
    ctx.fillText('القيمة', width / 2, 505);
    drawEgpAmount(data.amount, 574, width - 150, 62);

    const rows = [
        { label: 'الخدمة', value: data.serviceName || 'محافظ كاش' },
        { label: 'رقم العملية', value: data.customId },
        { label: 'الرقم المرجعي', value: data.referenceNumber || data.reference_number || '' },
        { label: 'التاريخ', value: data.date }
    ].filter((row) => String(row.value || '').trim());

    fillCard(76, 650, width - 152, 228, 26, 'rgba(255,255,255,0.92)', BRAND.line, false);
    let startY = 700;
    rows.forEach((row, index) => {
        ctx.textAlign = 'right';
        ctx.fillStyle = BRAND.muted;
        setFont(18, 'bold');
        ctx.fillText(row.label, width - 104, startY);
        ctx.textAlign = 'left';
        ctx.fillStyle = BRAND.ink;
        setFont(19, '900');
        ctx.fillText(compactText(row.value, 27), 104, startY);
        if (index < rows.length - 1) {
            ctx.strokeStyle = BRAND.line;
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(104, startY + 24);
            ctx.lineTo(width - 104, startY + 24);
            ctx.stroke();
        }
        startY += 48;
    });

    fillCard(76, 902, width - 152, 86, 24, '#fff7e6', '#f5d18b', false);
    ctx.textAlign = 'center';
    ctx.fillStyle = BRAND.ink;
    setFont(18, '900');
    ctx.fillText('الدعم الفني واتساب فقط', width / 2, 936);
    ctx.fillStyle = BRAND.teal;
    setFont(27, '900', 'Arial, sans-serif');
    ctx.fillText(SUPPORT_PHONE, width / 2, 974);

    ctx.strokeStyle = BRAND.line;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(96, 998);
    ctx.lineTo(width - 96, 998);
    ctx.stroke();
    ctx.fillStyle = BRAND.navy;
    setFont(24, '900', 'Arial, sans-serif');
    ctx.fillText('Power Pay AL-Ahram', width / 2, 1032);

    const base64Data = canvas.toDataURL('image/jpeg');
    return base64Data;
}

module.exports = { generateReceiptBase64 };
