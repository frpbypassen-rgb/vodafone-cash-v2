'use strict';

const fs = require('fs');
const path = require('path');
const { SYSTEM_TIME_ZONE } = require('../config/systemTime');
const { proofFilePath } = require('./proofStorageService');

const BRAND = {
    navy: '#101828',
    teal: '#00a6a6',
    gold: '#f5b83d',
    green: '#12b76a',
    red: '#f04438',
    bg: '#eef7fb',
    ink: '#111827',
    muted: '#667085',
    line: '#d9e4ea'
};

const escapeXml = (value) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

const compactText = (value, max = 42) => {
    const text = String(value || '-').trim() || '-';
    return text.length > max ? `${text.slice(0, max - 3)}...` : text;
};

const formatAmount = (value, currency = 'د.ل') => {
    const parsed = Number(value);
    const amount = Number.isFinite(parsed) ? parsed : 0;
    return `${amount.toLocaleString('ar-EG-u-nu-latn', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
};

const formatDate = (value) => {
    const date = value ? new Date(value) : new Date();
    if (Number.isNaN(date.getTime())) return '-';
    return date.toLocaleString('ar-LY-u-nu-latn', { timeZone: SYSTEM_TIME_ZONE, hour12: true });
};

const rowSvg = (label, value, y) => `
    <text x="300" y="${y}" class="row-label rtl">${escapeXml(label)}</text>
    <text x="300" y="${y + 27}" class="row-value rtl">${escapeXml(compactText(value, 48))}</text>
    <line x1="80" y1="${y + 42}" x2="520" y2="${y + 42}" class="soft-line"/>`;

const createDepositReceiptProof = ({
    customId,
    accountName,
    accountCode,
    amount,
    balanceAfter,
    notes,
    createdAt,
    type = 'deposit'
}) => {
    const safeId = String(customId || `DEP-${Date.now()}`).replace(/[^\w.-]/g, '_');
    const fileName = `${safeId}_receipt.svg`;
    const fullPath = proofFilePath(fileName);
    const proofId = `proofs/${path.basename(fileName)}`;
    const isDeduction = type === 'deduction';
    const accent = isDeduction ? BRAND.red : BRAND.green;
    const title = isDeduction ? 'إيصال خصم رصيد' : 'إيصال إيداع رصيد';
    const status = isDeduction ? 'تم خصم الرصيد بنجاح' : 'تمت إضافة الرصيد بنجاح';

    fs.mkdirSync(path.dirname(fullPath), { recursive: true });

    const rows = [
        ['رقم العملية', customId || '-'],
        ['الحساب', accountName || 'حساب عميل'],
        ['كود الحساب', accountCode || '-'],
        ['المبلغ', formatAmount(amount)],
        ['الرصيد بعد العملية', formatAmount(balanceAfter)],
        ['تاريخ العملية', formatDate(createdAt)],
        ['الملاحظات', notes || '-']
    ];

    const detailsSvg = rows.map(([label, value], index) => rowSvg(label, value, 360 + index * 58)).join('');

    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="600" height="850" viewBox="0 0 600 850" direction="rtl">
    <defs>
        <linearGradient id="paperGradient" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="#f8fcff"/>
            <stop offset="100%" stop-color="#eaf7f7"/>
        </linearGradient>
        <linearGradient id="brandGradient" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="${BRAND.navy}"/>
            <stop offset="58%" stop-color="#14546a"/>
            <stop offset="100%" stop-color="${BRAND.teal}"/>
        </linearGradient>
        <linearGradient id="amountGradient" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="#ffffff"/>
            <stop offset="100%" stop-color="#f0fffb"/>
        </linearGradient>
        <filter id="cardShadow" x="-20%" y="-20%" width="140%" height="140%">
            <feDropShadow dx="0" dy="16" stdDeviation="18" flood-color="#101828" flood-opacity="0.18"/>
        </filter>
        <filter id="softShadow" x="-20%" y="-20%" width="140%" height="140%">
            <feDropShadow dx="0" dy="8" stdDeviation="10" flood-color="#101828" flood-opacity="0.14"/>
        </filter>
        <style>
            .title { font: 900 30px Tahoma, Arial, sans-serif; fill: #ffffff; }
            .subtitle { font: 700 15px Tahoma, Arial, sans-serif; fill: #d8fffb; }
            .status { font: 900 17px Tahoma, Arial, sans-serif; fill: ${accent}; }
            .amount-label { font: 800 16px Tahoma, Arial, sans-serif; fill: ${BRAND.muted}; }
            .amount { font: 900 42px Tahoma, Arial, sans-serif; fill: ${accent}; }
            .row-label { font: 700 13px Tahoma, Arial, sans-serif; fill: ${BRAND.muted}; text-anchor: middle; }
            .row-value { font: 900 18px Tahoma, Arial, sans-serif; fill: ${BRAND.ink}; text-anchor: middle; }
            .footer { font: 800 14px Arial, sans-serif; fill: ${BRAND.navy}; }
            .soft-line { stroke: ${BRAND.line}; stroke-width: 1.3; }
            .rtl { direction: rtl; unicode-bidi: plaintext; }
            .ltr { direction: ltr; unicode-bidi: plaintext; }
        </style>
    </defs>

    <rect width="600" height="850" rx="24" fill="${BRAND.bg}"/>
    <rect x="34" y="32" width="532" height="786" rx="28" fill="url(#paperGradient)" filter="url(#cardShadow)"/>
    <rect x="54" y="52" width="492" height="158" rx="24" fill="url(#brandGradient)"/>

    <circle cx="100" cy="98" r="28" fill="#ffffff" opacity="0.16"/>
    <circle cx="100" cy="98" r="18" fill="${BRAND.gold}"/>
    <path d="M92 99h20m-10-10v20" stroke="#101828" stroke-width="4" stroke-linecap="round"/>
    <text x="326" y="101" class="title rtl" text-anchor="middle">${escapeXml(title)}</text>
    <text x="326" y="132" class="subtitle rtl" text-anchor="middle">مستند مالي إلكتروني من منظومة Power Pay</text>

    <rect x="100" y="234" width="400" height="104" rx="24" fill="url(#amountGradient)" stroke="#d7efe9" filter="url(#softShadow)"/>
    <text x="300" y="268" text-anchor="middle" class="amount-label rtl">قيمة الحركة</text>
    <text x="300" y="318" text-anchor="middle" class="amount rtl">${escapeXml(formatAmount(amount))}</text>

    <rect x="174" y="180" width="252" height="42" rx="21" fill="#ffffff" filter="url(#softShadow)"/>
    <circle cx="406" cy="201" r="13" fill="${accent}"/>
    <path d="M400 201l5 5 10-13" fill="none" stroke="#fff" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/>
    <text x="300" y="207" text-anchor="middle" class="status rtl">${escapeXml(status)}</text>

    ${detailsSvg}

    <line x1="78" y1="768" x2="522" y2="768" class="soft-line"/>
    <text x="300" y="795" text-anchor="middle" class="footer">Power Pay AL-Ahram</text>
</svg>`;

    fs.writeFileSync(fullPath, svg, 'utf8');
    return proofId;
};

module.exports = { createDepositReceiptProof };
