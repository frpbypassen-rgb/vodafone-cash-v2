'use strict';

const fs = require('fs');
const path = require('path');
const { proofFilePath } = require('./proofStorageService');

const escapeXml = (value) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

const formatAmount = (value) => `${Number(value || 0).toFixed(2)} LYD`;

const formatDate = (value) => {
    const date = value ? new Date(value) : new Date();
    return date.toLocaleString('en-GB', { hour12: true });
};

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

    fs.mkdirSync(path.dirname(fullPath), { recursive: true });

    const rows = [
        ['رقم العملية', transferId],
        ['المرسل', `${sourceName || '-'} (${sourceCode || '-'})`],
        ['المستقبل', `${targetName || '-'} (${targetCode || '-'})`],
        ['المبلغ', formatAmount(amount)],
        ['التاريخ', formatDate(createdAt)],
        ['الملاحظة', notes || '-']
    ];

    const rowSvg = rows.map(([label, value], index) => {
        const y = 410 + index * 58;
        return `
            <text x="520" y="${y}" class="label">${escapeXml(label)}</text>
            <text x="80" y="${y}" class="value">${escapeXml(value)}</text>
            <line x1="80" y1="${y + 20}" x2="520" y2="${y + 20}" class="dash"/>`;
    }).join('');

    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="600" height="920" viewBox="0 0 600 920">
    <defs>
        <style>
            .brand { font: 800 42px Arial, Tahoma, sans-serif; fill: #0f172a; }
            .title { font: 800 30px Arial, Tahoma, sans-serif; fill: #0f766e; direction: rtl; unicode-bidi: bidi-override; }
            .subtitle { font: 700 18px Arial, Tahoma, sans-serif; fill: #64748b; direction: rtl; unicode-bidi: bidi-override; }
            .node-title { font: 700 16px Arial, Tahoma, sans-serif; fill: #64748b; direction: rtl; unicode-bidi: bidi-override; }
            .node-name { font: 800 19px Arial, Tahoma, sans-serif; fill: #0f172a; direction: rtl; unicode-bidi: bidi-override; }
            .node-code { font: 700 16px Consolas, monospace; fill: #334155; }
            .amount { font: 900 38px Consolas, monospace; fill: #0f766e; }
            .label { font: 800 19px Arial, Tahoma, sans-serif; fill: #64748b; text-anchor: end; direction: rtl; unicode-bidi: bidi-override; }
            .value { font: 800 19px Arial, Tahoma, sans-serif; fill: #111827; text-anchor: start; direction: rtl; unicode-bidi: bidi-override; }
            .balance-label { font: 700 15px Arial, Tahoma, sans-serif; fill: #64748b; direction: rtl; unicode-bidi: bidi-override; }
            .balance-value { font: 800 17px Consolas, monospace; fill: #111827; }
            .dash { stroke: #d1d5db; stroke-width: 1.4; stroke-dasharray: 7 8; }
            .small { font: 700 15px Arial, Tahoma, sans-serif; fill: #64748b; direction: rtl; unicode-bidi: bidi-override; }
        </style>
    </defs>
    <rect width="600" height="920" rx="28" fill="#f8fafc"/>
    <rect x="38" y="38" width="524" height="844" rx="22" fill="#ffffff" stroke="#e2e8f0" stroke-width="2"/>
    <text x="300" y="102" text-anchor="middle" class="brand">Ahram Pay</text>
    <line x1="135" y1="128" x2="465" y2="128" class="dash"/>
    <circle cx="300" cy="182" r="38" fill="#0f766e"/>
    <path d="M279 183h38m0 0l-14-14m14 14l-14 14" fill="none" stroke="#ffffff" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>
    <text x="300" y="250" text-anchor="middle" class="title">إيصال تحويل رصيد داخلي</text>
    <text x="300" y="278" text-anchor="middle" class="subtitle">تم تنفيذ العملية بنجاح بين حسابين داخل المنظومة</text>

    <rect x="70" y="315" width="190" height="68" rx="14" fill="#fee2e2" stroke="#fecaca"/>
    <text x="165" y="340" text-anchor="middle" class="node-title">المرسل</text>
    <text x="165" y="365" text-anchor="middle" class="node-name">${escapeXml(sourceName || '-')}</text>
    <text x="165" y="385" text-anchor="middle" class="node-code">${escapeXml(sourceCode || '-')}</text>

    <rect x="340" y="315" width="190" height="68" rx="14" fill="#dcfce7" stroke="#bbf7d0"/>
    <text x="435" y="340" text-anchor="middle" class="node-title">المستقبل</text>
    <text x="435" y="365" text-anchor="middle" class="node-name">${escapeXml(targetName || '-')}</text>
    <text x="435" y="385" text-anchor="middle" class="node-code">${escapeXml(targetCode || '-')}</text>

    <text x="300" y="361" text-anchor="middle" font-size="28" font-family="Arial" fill="#2563eb">←</text>
    ${rowSvg}

    <rect x="80" y="760" width="440" height="78" rx="16" fill="#ecfdf5" stroke="#bbf7d0"/>
    <text x="300" y="793" text-anchor="middle" class="subtitle">المبلغ المحول</text>
    <text x="300" y="823" text-anchor="middle" class="amount">${escapeXml(formatAmount(amount))}</text>

    <g>
        <text x="430" y="680" class="balance-label">رصيد المرسل: قبل</text>
        <text x="270" y="680" class="balance-value">${escapeXml(formatAmount(sourceBalanceBefore))}</text>
        <text x="185" y="680" class="balance-label">بعد</text>
        <text x="80" y="680" class="balance-value">${escapeXml(formatAmount(sourceBalanceAfter))}</text>
        <line x1="80" y1="700" x2="520" y2="700" class="dash"/>
        <text x="430" y="730" class="balance-label">رصيد المستقبل: قبل</text>
        <text x="270" y="730" class="balance-value">${escapeXml(formatAmount(targetBalanceBefore))}</text>
        <text x="185" y="730" class="balance-label">بعد</text>
        <text x="80" y="730" class="balance-value">${escapeXml(formatAmount(targetBalanceAfter))}</text>
    </g>

    <text x="300" y="865" text-anchor="middle" class="small">تم إصدار هذا الإيصال تلقائياً من منظومة Ahram Pay.</text>
</svg>`;

    fs.writeFileSync(fullPath, svg, 'utf8');
    return proofId;
};

module.exports = { createBalanceTransferReceiptProof };
