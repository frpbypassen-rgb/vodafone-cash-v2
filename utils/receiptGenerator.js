const { createCanvas } = require('canvas');

const SUPPORT_PHONE = '01108172258';

const formatAmount = (value) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return String(value || '0');
    return parsed.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

async function generateReceiptBase64(data) {
    const width = 640;
    const height = 1080;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    const drawCenteredFit = (text, y, maxWidth, size, weight = 'bold') => {
        const value = String(text || '---');
        let fontSize = size;
        do {
            ctx.font = `${weight} ${fontSize}px "Segoe UI", Arial, sans-serif`;
            if (ctx.measureText(value).width <= maxWidth || fontSize <= 24) break;
            fontSize -= 2;
        } while (fontSize > 24);
        ctx.textAlign = 'center';
        ctx.fillText(value, width / 2, y);
    };

    const drawDashedLine = (y) => {
        ctx.beginPath();
        ctx.setLineDash([8, 10]);
        ctx.moveTo(70, y);
        ctx.lineTo(width - 70, y);
        ctx.stroke();
        ctx.setLineDash([]);
    };

    const drawCheck = (centerX, centerY) => {
        ctx.beginPath();
        ctx.arc(centerX, centerY, 26, 0, Math.PI * 2);
        ctx.fillStyle = '#000';
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 6;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(centerX - 13, centerY);
        ctx.lineTo(centerX - 4, centerY + 11);
        ctx.lineTo(centerX + 15, centerY - 13);
        ctx.stroke();
        ctx.lineCap = 'butt';
        ctx.lineJoin = 'miter';
        ctx.lineWidth = 1;
        ctx.strokeStyle = '#000';
        ctx.fillStyle = '#000';
    };

    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 3;
    ctx.strokeRect(28, 28, width - 56, height - 56);

    ctx.fillStyle = '#000';
    ctx.textBaseline = 'alphabetic';
    ctx.font = 'bold 34px "Segoe UI", Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('إيصال تحويل', width / 2, 88);
    drawDashedLine(122);

    drawCheck(width / 2, 168);
    ctx.font = 'bold 32px "Segoe UI", Arial, sans-serif';
    ctx.fillText('عملية ناجحة', width / 2, 232);

    ctx.font = 'bold 22px "Segoe UI", Arial, sans-serif';
    ctx.fillText('رقم الهاتف / الحساب', width / 2, 298);
    drawCenteredFit(data.walletNumber, 366, width - 120, 56, 'bold');

    ctx.font = 'bold 22px "Segoe UI", Arial, sans-serif';
    ctx.fillText('القيمة', width / 2, 434);
    drawCenteredFit(`${formatAmount(data.amount)} ج.م`, 506, width - 120, 64, 'bold');

    drawDashedLine(548);

    let startY = 602;
    const rowHeight = 52;
    const rows = [
        { label: 'الخدمة', value: data.serviceName || 'تحويل كاش' },
        { label: 'رقم العملية', value: data.customId },
        { label: 'الرقم المرجعي', value: data.referenceNumber || data.reference_number || '' },
        { label: 'التاريخ', value: data.date }
    ].filter((row) => String(row.value || '').trim());

    rows.forEach(row => {
        ctx.font = 'bold 21px "Segoe UI", Arial, sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText(row.label, width - 82, startY);
        ctx.textAlign = 'left';
        ctx.fillText(String(row.value), 82, startY);
        drawDashedLine(startY + 18);
        startY += rowHeight;
    });

    const supportY = Math.max(startY + 28, height - 240);
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 2;
    ctx.strokeRect(70, supportY, width - 140, 90);
    ctx.textAlign = 'center';
    ctx.font = 'bold 20px "Segoe UI", Arial, sans-serif';
    ctx.fillText('الدعم الفني واتساب فقط', width / 2, supportY + 34);
    ctx.font = 'bold 28px Arial, sans-serif';
    ctx.fillText(SUPPORT_PHONE, width / 2, supportY + 72);

    drawDashedLine(supportY + 122);
    ctx.font = 'bold 24px Arial, sans-serif';
    ctx.fillText('Power Pay AL-Ahram', width / 2, supportY + 164);

    const base64Data = canvas.toDataURL('image/jpeg');
    return base64Data;
}

module.exports = { generateReceiptBase64 };
