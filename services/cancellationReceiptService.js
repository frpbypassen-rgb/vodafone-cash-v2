'use strict';

const fs = require('fs');
const path = require('path');
const Transaction = require('../models/Transaction');
const Counter = require('../models/Counter');
const { proofFilePath } = require('./proofStorageService');

const BRAND = {
    navy: '#101828',
    teal: '#00a6a6',
    gold: '#f5b83d',
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

const formatMoney = (value, currency = '') => {
    const amount = Number(value || 0);
    const formatted = new Intl.NumberFormat('ar-EG-u-nu-latn', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    }).format(Number.isFinite(amount) ? amount : 0);
    const currencyLabel = {
        EGP: 'ج.م',
        LYD: 'د.ل'
    }[currency] || currency;
    return currencyLabel ? `${formatted} ${currencyLabel}` : formatted;
};

const formatDate = (value) => {
    const date = value ? new Date(value) : new Date();
    if (Number.isNaN(date.getTime())) return '-';
    return date.toLocaleString('ar-EG-u-nu-latn', { hour12: true });
};

const compactText = (value, maxLength = 56) => {
    const text = String(value || '-').trim() || '-';
    return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
};

const transferTypeLabels = {
    vodafone: 'فودافون كاش',
    post_account: 'حساب بريد',
    post_card: 'بطاقة بريد',
    bank_transfer: 'تحويل بنكي',
    balance_transfer: 'تحويل داخلي',
    safar: 'السفا - النيجر',
    bankak: 'بنكك - السودان'
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

const detailRow = (label, value, y) => `
    <text x="310" y="${y}" class="row-label rtl">${escapeXml(label)}</text>
    <text x="310" y="${y + 25}" class="row-value rtl">${escapeXml(compactText(value))}</text>
    <line x1="72" y1="${y + 40}" x2="548" y2="${y + 40}" class="soft-line"/>`;

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
    const transferType = transferTypeLabels[tx.transferType] || tx.transferType || '-';
    const statusText = tx.status === 'cancelled_by_admin' ? 'إلغاء بواسطة الإدارة' : 'عملية ملغاة';
    const cancelNo = cancellationNumber || tx.cancellationNumber || '-';

    const rows = [
        ['رقم الإلغاء', cancelNo],
        ['رقم العملية الأصلية', tx.customId || '-'],
        ['رقم الهاتف / الحساب', targetNumber],
        ['اسم العميل', accountName],
        ['نوع العملية', transferType],
        ['قيمة العملية', formatMoney(tx.amount, 'EGP')],
        ['تم الإلغاء بواسطة', performedBy || tx.cancelledBy || '-'],
        ['تاريخ الإلغاء', formatDate(cancelledAt || tx.cancelledAt)],
        ['سبب الإلغاء', reason || tx.cancellationReason || '-']
    ];

    const rowsSvg = rows.map(([label, value], index) => detailRow(label, value, 430 + index * 54)).join('');

    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="620" height="980" viewBox="0 0 620 980" direction="rtl">
    <defs>
        <linearGradient id="paperGradient" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="#fbfdff"/>
            <stop offset="100%" stop-color="#eff8fb"/>
        </linearGradient>
        <linearGradient id="brandGradient" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="${BRAND.navy}"/>
            <stop offset="58%" stop-color="#193a5a"/>
            <stop offset="100%" stop-color="${BRAND.teal}"/>
        </linearGradient>
        <linearGradient id="cancelGradient" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="#fff7ed"/>
            <stop offset="100%" stop-color="#fff1f3"/>
        </linearGradient>
        <filter id="cardShadow" x="-20%" y="-20%" width="140%" height="140%">
            <feDropShadow dx="0" dy="18" stdDeviation="20" flood-color="#101828" flood-opacity="0.18"/>
        </filter>
        <filter id="softShadow" x="-20%" y="-20%" width="140%" height="140%">
            <feDropShadow dx="0" dy="10" stdDeviation="12" flood-color="#101828" flood-opacity="0.14"/>
        </filter>
        <style>
            .title { font: 900 32px Tahoma, Arial, sans-serif; fill: #ffffff; }
            .subtitle { font: 700 15px Tahoma, Arial, sans-serif; fill: #d8fffb; }
            .amount-label { font: 800 15px Tahoma, Arial, sans-serif; fill: ${BRAND.muted}; }
            .amount { font: 900 44px Tahoma, Arial, sans-serif; fill: ${BRAND.red}; }
            .phone { font: 900 30px Tahoma, Arial, sans-serif; fill: ${BRAND.ink}; }
            .chip { font: 900 17px Tahoma, Arial, sans-serif; fill: ${BRAND.red}; }
            .row-label { font: 700 13px Tahoma, Arial, sans-serif; fill: ${BRAND.muted}; text-anchor: middle; }
            .row-value { font: 900 18px Tahoma, Arial, sans-serif; fill: ${BRAND.ink}; text-anchor: middle; }
            .footer { font: 800 15px Arial, sans-serif; fill: ${BRAND.navy}; }
            .soft-line { stroke: ${BRAND.line}; stroke-width: 1.3; }
            .rtl { direction: rtl; unicode-bidi: plaintext; }
            .ltr { direction: ltr; unicode-bidi: plaintext; }
        </style>
    </defs>

    <rect width="620" height="980" rx="28" fill="${BRAND.bg}"/>
    <rect x="34" y="32" width="552" height="916" rx="30" fill="url(#paperGradient)" filter="url(#cardShadow)"/>
    <rect x="54" y="52" width="512" height="154" rx="26" fill="url(#brandGradient)"/>

    <circle cx="106" cy="102" r="30" fill="#ffffff" opacity="0.16"/>
    <circle cx="106" cy="102" r="19" fill="${BRAND.gold}"/>
    <path d="M96 111l20-20M96 91l20 20" stroke="#101828" stroke-width="4" stroke-linecap="round"/>
    <text x="330" y="102" text-anchor="middle" class="title rtl">إيصال إلغاء عملية</text>
    <text x="330" y="133" text-anchor="middle" class="subtitle rtl">${escapeXml(statusText)} - مستند تسوية إلكتروني</text>

    <rect x="86" y="232" width="448" height="144" rx="28" fill="url(#cancelGradient)" stroke="#ffd8cf" filter="url(#softShadow)"/>
    <text x="310" y="270" text-anchor="middle" class="amount-label rtl">قيمة العملية الملغاة</text>
    <text x="310" y="324" text-anchor="middle" class="amount rtl">${escapeXml(formatMoney(tx.amount, 'EGP'))}</text>
    <text x="310" y="358" text-anchor="middle" class="phone ltr">${escapeXml(targetNumber)}</text>

    <rect x="186" y="182" width="248" height="44" rx="22" fill="#ffffff" filter="url(#softShadow)"/>
    <circle cx="410" cy="204" r="13" fill="${BRAND.red}"/>
    <path d="M405 209l10-10M405 199l10 10" stroke="#fff" stroke-width="3.2" stroke-linecap="round"/>
    <text x="310" y="210" text-anchor="middle" class="chip rtl">تم الإلغاء</text>
    <text x="310" y="405" text-anchor="middle" class="amount-label rtl">رقم الإلغاء: ${escapeXml(cancelNo)}</text>

    ${rowsSvg}

    <line x1="82" y1="912" x2="538" y2="912" class="soft-line"/>
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
    tx.cancelledBy = tx.cancelledBy || metadata.performedBy || 'النظام';
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
