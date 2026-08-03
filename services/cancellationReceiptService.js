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
    const formatted = new Intl.NumberFormat('ar-EG-u-nu-latn', {
        maximumFractionDigits: 3
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

const compactText = (value, maxLength = 54) => {
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

    const rows = [
        ['رقم الإلغاء', cancellationNumber || tx.cancellationNumber || '-'],
        ['رقم العملية الأصلية', tx.customId || '-'],
        ['رقم الهاتف / الحساب', targetNumber],
        ['اسم العميل', accountName],
        ['نوع العملية', transferType],
        ['قيمة التحويل', formatMoney(tx.amount, 'EGP')],
        ['المبلغ المرتجع', formatMoney(tx.costLYD, 'LYD')],
        ['تم الإلغاء بواسطة', performedBy || tx.cancelledBy || '-'],
        ['تاريخ الإلغاء', formatDate(cancelledAt || tx.cancelledAt)],
        ['سبب الإلغاء', reason || tx.cancellationReason || '-']
    ];

    const rowsSvg = rows.map(([label, value], index) => {
        const y = 394 + index * 50;
        return `
            <text x="548" y="${y}" class="row-label rtl">${escapeXml(label)}</text>
            <text x="548" y="${y + 24}" class="row-value rtl">${escapeXml(compactText(value))}</text>
            <line x1="72" y1="${y + 38}" x2="548" y2="${y + 38}" class="hairline" />`;
    }).join('');

    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="620" height="980" viewBox="0 0 620 980" direction="rtl">
    <defs>
        <style>
            .paper { fill: #fff; }
            .ink { fill: #0b0b0b; }
            .muted { fill: #60646c; }
            .soft { fill: #f7f7f7; }
            .hairline { stroke: #d9d9d9; stroke-width: 1; }
            .frame { fill: none; stroke: #0b0b0b; stroke-width: 2.5; }
            .block { fill: none; stroke: #0b0b0b; stroke-width: 1.5; }
            .title { font: 900 34px Tahoma, Arial, sans-serif; letter-spacing: 0; }
            .sub { font: 700 16px Tahoma, Arial, sans-serif; }
            .eyebrow { font: 700 15px Tahoma, Arial, sans-serif; fill: #60646c; }
            .amount { font: 900 46px Tahoma, Arial, sans-serif; }
            .phone { font: 900 31px Tahoma, Arial, sans-serif; }
            .row-label { font: 700 14px Tahoma, Arial, sans-serif; fill: #60646c; text-anchor: end; }
            .row-value { font: 800 18px Tahoma, Arial, sans-serif; fill: #0b0b0b; text-anchor: end; }
            .stamp { font: 900 19px Tahoma, Arial, sans-serif; fill: #0b0b0b; }
            .footer { font: 800 16px Arial, sans-serif; fill: #0b0b0b; }
            .rtl { direction: rtl; unicode-bidi: plaintext; }
            .ltr { direction: ltr; unicode-bidi: plaintext; }
        </style>
    </defs>

    <rect width="620" height="980" class="paper"/>
    <rect x="32" y="32" width="556" height="916" rx="0" class="frame"/>

    <text x="310" y="88" text-anchor="middle" class="title ink rtl">إيصال إلغاء عملية</text>
    <text x="310" y="121" text-anchor="middle" class="sub muted rtl">${escapeXml(statusText)}</text>
    <line x1="82" y1="152" x2="538" y2="152" class="hairline"/>

    <text x="310" y="190" text-anchor="middle" class="eyebrow rtl">المبلغ المرتجع إلى الحساب</text>
    <text x="310" y="244" text-anchor="middle" class="amount ink rtl">${escapeXml(formatMoney(tx.costLYD, 'LYD'))}</text>
    <text x="310" y="294" text-anchor="middle" class="phone ink ltr">${escapeXml(targetNumber)}</text>
    <text x="310" y="329" text-anchor="middle" class="sub muted rtl">رقم الإلغاء: ${escapeXml(cancellationNumber || tx.cancellationNumber || '-')}</text>

    <rect x="214" y="346" width="192" height="34" fill="#fff" stroke="#0b0b0b" stroke-width="2"/>
    <text x="310" y="369" text-anchor="middle" class="stamp rtl">ملغاة</text>

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
