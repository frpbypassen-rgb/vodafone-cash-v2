'use strict';

const fs = require('fs');
const path = require('path');
const { SYSTEM_TIME_ZONE } = require('../config/systemTime');
const { proofFilePath } = require('./proofStorageService');

const escapeXml = (value) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

const compactText = (value, max = 34) => {
    const text = String(value || '-').trim();
    return text.length > max ? `${text.slice(0, max - 3)}...` : text;
};

const formatAmount = (value) => {
    const amount = Number(value);
    return Number.isFinite(amount)
        ? `${amount.toLocaleString('ar-EG-u-nu-latn', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} د.ل`
        : '---';
};

const formatDate = (value) => {
    const date = value ? new Date(value) : new Date();
    return date.toLocaleString('en-GB', { timeZone: SYSTEM_TIME_ZONE, hour12: true });
};

const rtlText = (x, y, value, className, anchor = 'end') => (
    `<text x="${x}" y="${y}" text-anchor="${anchor}" class="${className}">${escapeXml(value)}</text>`
);

const ltrText = (x, y, value, className, anchor = 'start') => (
    `<text x="${x}" y="${y}" text-anchor="${anchor}" class="${className}">${escapeXml(value)}</text>`
);

const createBalanceTransferReceiptProof = ({
    transferId,
    sourceName,
    sourceCode,
    targetName,
    targetCode,
    amount,
    sourceBalanceBefore,
    sourceBalanceAfter,
    targetBalanceBefore,
    targetBalanceAfter,
    notes,
    createdAt
}) => {
    const safeId = String(transferId || `BTR-${Date.now()}`).replace(/[^\w.-]/g, '_');
    const fileName = `${safeId}_balance_transfer_receipt.svg`;
    const fullPath = proofFilePath(fileName);
    const proofId = `proofs/${path.basename(fileName)}`;
    const issuedAt = formatDate(createdAt);
    const cleanNotes = compactText(notes || 'لا توجد ملاحظات', 48);

    fs.mkdirSync(path.dirname(fullPath), { recursive: true });

    const detailRows = [
        ['رقم العملية', transferId || '-'],
        ['تاريخ التنفيذ', issuedAt],
        ['حالة العملية', 'مكتملة بنجاح'],
        ['الملاحظات', cleanNotes]
    ];

    const detailsSvg = detailRows.map(([label, value], index) => {
        const y = 608 + index * 58;
        return `
            ${rtlText(602, y, label, 'detail-label')}
            ${rtlText(86, y, value, 'detail-value', 'start')}
            <line x1="82" y1="${y + 20}" x2="604" y2="${y + 20}" class="soft-line"/>`;
    }).join('');

    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="686" height="980" viewBox="0 0 686 980">
    <defs>
        <linearGradient id="headerGradient" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="#101828"/>
            <stop offset="58%" stop-color="#14546a"/>
            <stop offset="100%" stop-color="#00a6a6"/>
        </linearGradient>
        <linearGradient id="amountGradient" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="#ffffff"/>
            <stop offset="100%" stop-color="#ecfffb"/>
        </linearGradient>
        <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
            <feDropShadow dx="0" dy="18" stdDeviation="20" flood-color="#101828" flood-opacity="0.18"/>
        </filter>
        <filter id="softShadow" x="-20%" y="-20%" width="140%" height="140%">
            <feDropShadow dx="0" dy="10" stdDeviation="12" flood-color="#101828" flood-opacity="0.14"/>
        </filter>
        <style>
            .brand { font: 900 23px Arial, Tahoma, sans-serif; fill: #ffffff; letter-spacing: 0; }
            .header-title { font: 900 29px Arial, Tahoma, sans-serif; fill: #ffffff; }
            .header-subtitle { font: 700 16px Arial, Tahoma, sans-serif; fill: #d8fffb; }
            .status { font: 800 14px Arial, Tahoma, sans-serif; fill: #065f46; }
            .section-title { font: 800 19px Arial, Tahoma, sans-serif; fill: #0f172a; }
            .small-muted { font: 700 14px Arial, Tahoma, sans-serif; fill: #64748b; }
            .node-name { font: 900 22px Arial, Tahoma, sans-serif; fill: #0f172a; }
            .node-code { font: 800 16px Consolas, monospace; fill: #334155; }
            .amount-label { font: 800 16px Arial, Tahoma, sans-serif; fill: #00a6a6; }
            .amount-value { font: 900 44px Arial, Tahoma, sans-serif; fill: #00a6a6; }
            .detail-label { font: 800 17px Arial, Tahoma, sans-serif; fill: #64748b; }
            .detail-value { font: 800 18px Arial, Tahoma, sans-serif; fill: #111827; }
            .balance-label { font: 800 14px Arial, Tahoma, sans-serif; fill: #64748b; }
            .balance-value { font: 900 16px Arial, Tahoma, sans-serif; fill: #111827; }
            .footer { font: 700 14px Arial, Tahoma, sans-serif; fill: #64748b; }
            .soft-line { stroke: #e2e8f0; stroke-width: 1.4; }
        </style>
    </defs>

    <rect width="686" height="980" fill="#f6f8fb"/>
    <rect x="34" y="30" width="618" height="920" rx="28" fill="#ffffff" filter="url(#shadow)"/>

    <rect x="54" y="50" width="578" height="156" rx="24" fill="url(#headerGradient)"/>
    ${rtlText(604, 96, 'إيصال تحويل بين الحسابات', 'header-title')}
    ${rtlText(604, 128, 'مستند إلكتروني معتمد لحركة رصيد داخلية', 'header-subtitle')}
    <circle cx="104" cy="164" r="27" fill="#ffffff" opacity="0.16"/>
    <circle cx="104" cy="164" r="18" fill="#f5b83d"/>
    <path d="M93 164h22m-11-11v22" stroke="#101828" stroke-width="4" stroke-linecap="round"/>
    <text x="140" y="172" text-anchor="start" class="brand">Power Pay</text>
    <rect x="452" y="154" width="154" height="34" rx="17" fill="#d1fae5"/>
    ${rtlText(586, 177, 'تم التنفيذ بنجاح', 'status')}

    <rect x="76" y="236" width="534" height="118" rx="22" fill="url(#amountGradient)" stroke="#bdebe4" filter="url(#softShadow)"/>
    ${rtlText(343, 271, 'المبلغ المحول', 'amount-label', 'middle')}
    <text x="343" y="322" text-anchor="middle" class="amount-value">${escapeXml(formatAmount(amount))}</text>

    ${rtlText(610, 398, 'مسار العملية', 'section-title')}
    <rect x="378" y="424" width="232" height="112" rx="20" fill="#fff1f2" stroke="#fecdd3"/>
    ${rtlText(586, 456, 'من حساب', 'small-muted')}
    ${rtlText(586, 488, compactText(sourceName, 24), 'node-name')}
    ${ltrText(402, 520, sourceCode || '-', 'node-code')}

    <circle cx="343" cy="480" r="28" fill="#eff6ff" stroke="#bfdbfe" stroke-width="2"/>
    <path d="M355 480H328m0 0l11-11m-11 11l11 11" fill="none" stroke="#2563eb" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>

    <rect x="76" y="424" width="232" height="112" rx="20" fill="#ecfdf5" stroke="#bbf7d0"/>
    ${rtlText(284, 456, 'إلى حساب', 'small-muted')}
    ${rtlText(284, 488, compactText(targetName, 24), 'node-name')}
    ${ltrText(100, 520, targetCode || '-', 'node-code')}

    ${rtlText(610, 578, 'تفاصيل العملية', 'section-title')}
    <rect x="68" y="590" width="550" height="250" rx="20" fill="#ffffff" stroke="#e2e8f0"/>
    ${detailsSvg}

    <rect x="356" y="852" width="262" height="72" rx="17" fill="#fff1f2" stroke="#fecdd3"/>
    ${rtlText(596, 875, 'رصيد المرسل', 'balance-label')}
    ${rtlText(596, 899, 'قبل', 'balance-label')}
    ${ltrText(378, 899, formatAmount(sourceBalanceBefore), 'balance-value')}
    ${rtlText(596, 918, 'بعد', 'balance-label')}
    ${ltrText(378, 918, formatAmount(sourceBalanceAfter), 'balance-value')}
    <rect x="68" y="852" width="262" height="72" rx="17" fill="#ecfdf5" stroke="#bbf7d0"/>
    ${rtlText(308, 875, 'رصيد المستقبل', 'balance-label')}
    ${rtlText(308, 899, 'قبل', 'balance-label')}
    ${ltrText(90, 899, formatAmount(targetBalanceBefore), 'balance-value')}
    ${rtlText(308, 918, 'بعد', 'balance-label')}
    ${ltrText(90, 918, formatAmount(targetBalanceAfter), 'balance-value')}

    <line x1="84" y1="924" x2="602" y2="924" stroke="#e2e8f0" stroke-width="1.4" stroke-dasharray="7 8"/>
    ${rtlText(602, 946, 'تم إصدار هذا الإيصال تلقائياً ولا يحتاج إلى توقيع يدوي.', 'footer')}
    <text x="84" y="946" text-anchor="start" class="footer">Power Pay AL-Ahram</text>
</svg>`;

    fs.writeFileSync(fullPath, svg, 'utf8');
    return proofId;
};

module.exports = { createBalanceTransferReceiptProof };
