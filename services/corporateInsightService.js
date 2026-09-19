'use strict';

const CorporatePaymentRequest = require('../models/CorporatePaymentRequest');
const CorporateBeneficiary = require('../models/CorporateBeneficiary');
const CorporateInvoice = require('../models/CorporateInvoice');
const Ledger = require('../models/Ledger');

const RULE_DISCLAIMER = 'قواعد/تقديرات إحصائية من السجل — ليست نموذجاً لغوياً ولا توصية تنفيذ تلقائي.';

const average = (values) => {
    if (!values.length) return 0;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
};

const buildManagerInsights = async (context, requests) => {
    const executed = requests.filter((item) => item.status === 'executed');
    const amounts = executed.map((item) => Number(item.amount || 0));
    const mean = average(amounts);
    const multiplier = Number(context.profile?.settings?.anomalyMultiplier || 3);
    const anomalies = requests
        .filter((item) => Number(item.amount || 0) > Math.max(mean * multiplier, 1) && mean > 0)
        .slice(0, 8)
        .map((item) => ({
            reference: item.reference,
            amount: item.amount,
            reason: `المبلغ أعلى من ${multiplier}× متوسط العمليات المنفذة`
        }));

    const last30 = executed.filter((item) => {
        const created = new Date(item.createdAt);
        return Date.now() - created.getTime() <= 30 * 24 * 60 * 60 * 1000;
    });
    const daily = last30.length ? average(last30.map((item) => Number(item.amount || 0))) : 0;
    const projection7 = Math.round(daily * 7 * 100) / 100;
    const balance = Number(context.company.balance || 0);
    const tips = [];
    if (balance < projection7) {
        tips.push('السيولة الحالية قد لا تغطي متوسط أسبوع قادم — راجع حدّ الاعتماد أو طلب إيداع.');
    } else {
        tips.push('السيولة الحالية تغطي تقدير أسبوع بناءً على متوسط آخر 30 يوماً.');
    }
    if (anomalies.length) tips.push('راجع العمليات المعلّمة — نمط المبلغ شاذ مقارنة بتاريخ الشركة.');

    return {
        kind: 'rules',
        disclaimer: RULE_DISCLAIMER,
        anomalies,
        cashFlowProjection: { windowDays: 7, estimatedOutflow: projection7, method: 'متوسط يومي لآخر 30 يوماً' },
        liquidityTips: tips
    };
};

const buildEmployeeInsights = async (context) => {
    const history = await CorporatePaymentRequest.find({
        companyId: context.companyId,
        requesterId: context.actor._id,
        status: { $in: ['executed', 'approved', 'pending_approval'] }
    }).sort({ createdAt: -1 }).limit(50).lean();

    const counts = new Map();
    history.forEach((item) => {
        const key = String(item.beneficiaryId);
        counts.set(key, (counts.get(key) || 0) + 1);
    });
    const ranked = [...counts.entries()].sort((left, right) => right[1] - left[1]);
    const suggestedId = ranked[0]?.[0] || null;
    const last = history[0] || null;
    let suggestedBeneficiary = null;
    if (suggestedId) {
        const beneficiary = await CorporateBeneficiary.findOne({ _id: suggestedId, companyId: context.companyId, status: 'approved' }).lean();
        if (beneficiary) {
            suggestedBeneficiary = {
                id: String(beneficiary._id),
                name: beneficiary.name,
                serviceType: beneficiary.serviceType,
                accountNumberLast4: beneficiary.accountNumberLast4,
                uses: ranked[0][1]
            };
        }
    }

    return {
        kind: 'rules',
        disclaimer: RULE_DISCLAIMER,
        suggestedBeneficiary,
        autofill: last ? {
            beneficiaryId: String(last.beneficiaryId),
            amount: last.amount,
            notes: last.notes || ''
        } : null
    };
};

const buildAccountantInsights = async (context) => {
    const invoices = await CorporateInvoice.find({ companyId: context.companyId }).sort({ createdAt: -1 }).limit(80).lean();
    const requests = await CorporatePaymentRequest.find({
        companyId: context.companyId,
        status: { $in: ['executed', 'approved', 'pending_approval'] }
    }).sort({ createdAt: -1 }).limit(200).lean();
    const ledger = await Ledger.find({
        entityId: context.companyId,
        entityModel: 'ClientCompany',
        type: 'TRANSFER'
    }).sort({ createdAt: -1 }).limit(200).lean();

    const duplicates = [];
    invoices.forEach((invoice, index) => {
        const twin = invoices.find((other, otherIndex) => (
            otherIndex > index
            && Number(other.amount) === Number(invoice.amount)
            && String(other.vendorName || '').trim().toLowerCase() === String(invoice.vendorName || '').trim().toLowerCase()
            && other.amount
            && other.vendorName
        ));
        if (twin) {
            duplicates.push({
                invoiceId: String(invoice._id),
                otherInvoiceId: String(twin._id),
                amount: invoice.amount,
                vendorName: invoice.vendorName
            });
        }
    });

    const matches = invoices.map((invoice) => {
        const amount = Number(invoice.amount);
        const vendor = String(invoice.vendorName || '').trim().toLowerCase();
        const requestHit = requests.find((item) => (
            Number(item.amount) === amount
            && String(item.beneficiarySnapshot?.name || '').trim().toLowerCase() === vendor
        ));
        const ledgerHit = ledger.find((entry) => Math.abs(Number(entry.amount)) === amount);
        return {
            invoiceId: String(invoice._id),
            vendorName: invoice.vendorName,
            amount: invoice.amount,
            requestId: requestHit ? String(requestHit._id) : null,
            ledgerTransactionId: ledgerHit ? ledgerHit.transactionId : null,
            confidence: requestHit && ledgerHit ? 'high' : (requestHit || ledgerHit ? 'medium' : 'none')
        };
    });

    return {
        kind: 'rules',
        disclaimer: RULE_DISCLAIMER,
        duplicateInvoices: duplicates.slice(0, 20),
        suggestedMatches: matches.filter((item) => item.confidence !== 'none').slice(0, 20)
    };
};

const buildInsights = async (context, requests = []) => {
    if (context.role === 'manager') return buildManagerInsights(context, requests);
    if (context.role === 'accountant') return buildAccountantInsights(context);
    return buildEmployeeInsights(context);
};

const demoParseOcr = (payload = {}) => {
    const hintedAmount = Number(payload.hintAmount);
    return {
        provider: 'DEMO',
        label: 'تحليل تجريبي — أكّد الحقول يدوياً',
        amount: Number.isFinite(hintedAmount) && hintedAmount > 0 ? hintedAmount : 250,
        vendorName: payload.hintVendor || 'مستفيد تجريبي',
        note: 'لا يوجد مزوّد OCR مفعّل. هذه قيم تجريبية للتأكيد اليدوي.'
    };
};

const parseInvoiceOcr = async (payload = {}) => {
    const endpoint = String(process.env.CORPORATE_OCR_ENDPOINT || '').trim();
    if (!endpoint) return demoParseOcr(payload);
    try {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                imageBase64: payload.imageBase64,
                mimeType: payload.mimeType,
                fileName: payload.fileName
            })
        });
        if (!response.ok) return { ...demoParseOcr(payload), fallback: true };
        const parsed = await response.json();
        return {
            provider: 'external',
            label: 'نتيجة مزوّد OCR — راجع قبل التنفيذ',
            amount: Number(parsed.amount) || null,
            vendorName: parsed.vendorName || '',
            note: parsed.note || ''
        };
    } catch (_error) {
        return { ...demoParseOcr(payload), fallback: true };
    }
};

module.exports = {
    RULE_DISCLAIMER,
    buildInsights,
    buildManagerInsights,
    buildEmployeeInsights,
    buildAccountantInsights,
    parseInvoiceOcr,
    demoParseOcr
};
