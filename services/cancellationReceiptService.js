'use strict';

const fs = require('fs');
const path = require('path');
const Transaction = require('../models/Transaction');
const Counter = require('../models/Counter');
const { proofFilePath } = require('./proofStorageService');

const escapeXml = (value) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

const formatMoney = (value, currency = '') => {
    const amount = Number(value || 0);
    const formatted = Number.isFinite(amount) ? amount.toFixed(3).replace(/\.?0+$/, '') : '0';
    return currency ? `${formatted} ${currency}` : formatted;
};

const formatDate = (value) => {
    const date = value ? new Date(value) : new Date();
    if (Number.isNaN(date.getTime())) return '-';
    return date.toLocaleString('en-GB', { hour12: true });
};

const safeFileId = (value) => String(value || `cancel-${Date.now()}`).replace(/[^\w.-]/g, '_');

const nextCancellationNumber = async () => {
    const now = new Date();
    const year = String(now.getFullYear()).slice(-2);
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const counter = await Counter.findOneAndUpdate(
        { name: `cancellation-${year}${month}` },
        { $inc: { value: 1 } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    return `CAN-${year}${month}-${String(counter.value).padStart(5, '0')}`;
};

const createCancellationReceiptProof = ({
    tx,
    reason,
    cancellationNumber,
    performedBy,
    cancelledAt
}) => {
    const safeId = safeFileId(cancellationNumber || tx.customId || tx._id);
    const fileName = `${safeId}_cancellation_receipt.svg`;
    const fullPath = proofFilePath(fileName);
    const proofId = `proofs/${path.basename(fileName)}`;

    fs.mkdirSync(path.dirname(fullPath), { recursive: true });

    const targetNumber = tx.vodafoneNumber || tx.accountNumber || '-';
    const accountName = tx.accountName || tx.employeeName || tx.companyName || '-';
    const transferType = tx.transferType || '-';
    const statusText = tx.status === 'cancelled_by_admin' ? 'Cancelled By Admin' : 'Cancelled';

    const rows = [
        ['Cancellation No.', cancellationNumber || tx.cancellationNumber || '-'],
        ['Original Transaction', tx.customId || '-'],
        ['Target Number', targetNumber],
        ['Account / Client', accountName],
        ['Transfer Type', transferType],
        ['Amount', formatMoney(tx.amount, 'EGP')],
        ['Refunded Cost', formatMoney(tx.costLYD, 'LYD')],
        ['Cancelled By', performedBy || tx.cancelledBy || '-'],
        ['Cancellation Date', formatDate(cancelledAt || tx.cancelledAt)],
        ['Reason', reason || tx.cancellationReason || '-']
    ];

    const rowsSvg = rows.map(([label, value], index) => {
        const y = 370 + index * 52;
        return `
            <text x="72" y="${y}" class="row-label">${escapeXml(label)}</text>
            <text x="548" y="${y}" class="row-value">${escapeXml(value)}</text>
            <line x1="72" y1="${y + 18}" x2="548" y2="${y + 18}" class="hairline" />`;
    }).join('');

    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="620" height="980" viewBox="0 0 620 980">
    <defs>
        <style>
            .paper { fill: #fff; }
            .ink { fill: #0b0b0b; }
            .muted { fill: #5f6368; }
            .hairline { stroke: #d8d8d8; stroke-width: 1; }
            .frame { fill: none; stroke: #0b0b0b; stroke-width: 3; }
            .title { font: 900 36px Arial, sans-serif; letter-spacing: 0; }
            .sub { font: 700 17px Arial, sans-serif; }
            .amount { font: 900 44px Arial, sans-serif; }
            .phone { font: 900 35px Arial, sans-serif; }
            .row-label { font: 700 17px Arial, sans-serif; fill: #5f6368; text-anchor: start; }
            .row-value { font: 800 18px Arial, sans-serif; fill: #0b0b0b; text-anchor: end; }
            .stamp { font: 900 18px Arial, sans-serif; fill: #0b0b0b; }
            .footer { font: 800 16px Arial, sans-serif; fill: #0b0b0b; }
        </style>
    </defs>

    <rect width="620" height="980" class="paper"/>
    <rect x="32" y="32" width="556" height="916" rx="0" class="frame"/>

    <text x="310" y="92" text-anchor="middle" class="title ink">Cancellation Receipt</text>
    <text x="310" y="124" text-anchor="middle" class="sub muted">${escapeXml(statusText)}</text>
    <line x1="86" y1="156" x2="534" y2="156" class="hairline"/>

    <text x="310" y="218" text-anchor="middle" class="amount ink">${escapeXml(formatMoney(tx.amount, 'EGP'))}</text>
    <text x="310" y="270" text-anchor="middle" class="phone ink">${escapeXml(targetNumber)}</text>
    <text x="310" y="304" text-anchor="middle" class="sub muted">Refunded: ${escapeXml(formatMoney(tx.costLYD, 'LYD'))}</text>

    <rect x="202" y="322" width="216" height="34" fill="#fff" stroke="#0b0b0b" stroke-width="2"/>
    <text x="310" y="345" text-anchor="middle" class="stamp">CANCELLED</text>

    ${rowsSvg}

    <line x1="86" y1="914" x2="534" y2="914" class="hairline"/>
    <text x="310" y="940" text-anchor="middle" class="footer">Power Pay AL-Ahram</text>
</svg>`;

    fs.writeFileSync(fullPath, svg, 'utf8');
    return proofId;
};

const attachCancellationReceipt = async (txInput, metadata = {}) => {
    if (!txInput) return null;
    const tx = typeof txInput.save === 'function'
        ? txInput
        : await Transaction.findById(txInput._id || txInput.id);

    if (!tx) return null;

    const cancellationNumber = metadata.cancellationNumber || tx.cancellationNumber || await nextCancellationNumber();
    tx.cancellationNumber = tx.cancellationNumber || cancellationNumber;
    tx.cancellationReason = tx.cancellationReason || metadata.reason || '';
    tx.cancelledBy = tx.cancelledBy || metadata.performedBy || 'System';
    tx.cancelledAt = tx.cancelledAt || metadata.cancelledAt || new Date();

    const existingImages = Array.isArray(tx.proofImages) ? tx.proofImages.filter(Boolean) : [];
    const existingCancellationReceipt = existingImages.find((item) => /_cancellation_receipt\.svg$/i.test(String(item)));
    if (existingCancellationReceipt) {
        tx.resolutionImage = existingCancellationReceipt;
        tx.proofImage = existingCancellationReceipt;
        if (typeof tx.save === 'function') await tx.save();
        return existingCancellationReceipt;
    }

    const proofId = createCancellationReceiptProof({
        tx,
        reason: metadata.reason,
        cancellationNumber,
        performedBy: metadata.performedBy,
        cancelledAt: metadata.cancelledAt
    });

    tx.resolutionImage = proofId;
    tx.proofImage = proofId;
    tx.proofImages = [proofId, ...existingImages.filter((item) => item !== proofId)];
    await tx.save();
    return proofId;
};

module.exports = {
    createCancellationReceiptProof,
    attachCancellationReceipt
};
