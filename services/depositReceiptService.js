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

const formatAmount = (value) => Number(value || 0).toFixed(2);

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
    const operationTitle = type === 'deduction' ? 'Deduction Receipt' : 'Deposit Receipt';
    const operationStatus = type === 'deduction' ? 'Balance Deducted' : 'Balance Added';
    const operationColor = type === 'deduction' ? '#b91c1c' : '#047857';
    const dateText = createdAt
        ? new Date(createdAt).toLocaleString('en-GB', { hour12: true })
        : new Date().toLocaleString('en-GB', { hour12: true });

    fs.mkdirSync(path.dirname(fullPath), { recursive: true });

    const rows = [
        ['Transaction ID', customId],
        ['Account', accountName || 'Client account'],
        ['Account Code', accountCode || '-'],
        ['Amount', `${formatAmount(amount)} LYD`],
        ['Balance After', `${formatAmount(balanceAfter)} LYD`],
        ['Date', dateText],
        ['Notes', notes || '-']
    ];

    const rowSvg = rows.map(([label, value], index) => {
        const y = 310 + index * 64;
        return `
            <text x="80" y="${y}" class="label">${escapeXml(label)}</text>
            <text x="520" y="${y}" class="value">${escapeXml(value)}</text>
            <line x1="80" y1="${y + 22}" x2="520" y2="${y + 22}" class="dash" />`;
    }).join('');

    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="600" height="850" viewBox="0 0 600 850">
    <defs>
        <style>
            .brand { font: 700 42px Arial, sans-serif; fill: #111827; }
            .title { font: 700 34px Arial, sans-serif; fill: ${operationColor}; }
            .subtitle { font: 600 20px Arial, sans-serif; fill: #4b5563; }
            .label { font: 700 20px Arial, sans-serif; fill: #6b7280; text-anchor: start; }
            .value { font: 700 21px Arial, sans-serif; fill: #111827; text-anchor: end; }
            .dash { stroke: #d1d5db; stroke-width: 1.5; stroke-dasharray: 7 8; }
            .small { font: 600 16px Arial, sans-serif; fill: #6b7280; }
        </style>
    </defs>
    <rect width="600" height="850" rx="24" fill="#f9fafb"/>
    <rect x="38" y="38" width="524" height="774" rx="18" fill="#ffffff" stroke="#e5e7eb" stroke-width="2"/>
    <text x="300" y="105" text-anchor="middle" class="brand">Ahram Pay</text>
    <line x1="140" y1="130" x2="460" y2="130" class="dash"/>
    <circle cx="300" cy="185" r="38" fill="${operationColor}"/>
    <path d="M283 185l11 12 26-30" fill="none" stroke="#ffffff" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>
    <text x="300" y="260" text-anchor="middle" class="title">${escapeXml(operationTitle)}</text>
    <text x="300" y="288" text-anchor="middle" class="subtitle">${escapeXml(operationStatus)}</text>
    ${rowSvg}
    <rect x="80" y="765" width="440" height="1" fill="#e5e7eb"/>
    <text x="300" y="795" text-anchor="middle" class="small">This receipt was generated automatically by Ahram Pay.</text>
</svg>`;

    fs.writeFileSync(fullPath, svg, 'utf8');
    return proofId;
};

module.exports = { createDepositReceiptProof };
