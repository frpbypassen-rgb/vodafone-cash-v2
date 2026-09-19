'use strict';

const mongoose = require('mongoose');
const Transaction = require('../models/Transaction');
const User = require('../models/User');
const ClientCompany = require('../models/ClientCompany');
const { tenantScope } = require('../utils/tenantScope');
const { SYSTEM_TIME_ZONE } = require('../config/systemTime');

const CURRENT_MS = 24 * 60 * 60 * 1000;
const BASELINE_MS = 30 * 24 * 60 * 60 * 1000;
const ANOMALY_RATIO = 2;

const METRIC_META = [
    { key: 'transferCount', label: 'عدد التحويلات', format: 'count' },
    { key: 'totalVolume', label: 'إجمالي المبالغ (ج.م)', format: 'money' },
    { key: 'avgAmount', label: 'متوسط المبلغ', format: 'money' },
    { key: 'distinctRecipients', label: 'مستلمون مختلفون', format: 'count' },
    { key: 'failureRate', label: 'نسبة الفشل', format: 'percent' },
    { key: 'nightShare', label: 'نصيب ساعات الليل', format: 'percent' }
];

const emptyBucket = () => ({
    transferCount: 0,
    totalVolume: 0,
    avgAmount: 0,
    distinctRecipients: 0,
    failureRate: 0,
    nightShare: 0
});

const ratio = (current, baseline) => {
    if (!Number.isFinite(current) || !Number.isFinite(baseline)) return 0;
    if (baseline <= 0) return current > 0 ? Infinity : 1;
    return current / baseline;
};

const scoreMetric = (current, baseline) => {
    const comparison = ratio(current, baseline);
    const elevated = baseline > 0 && comparison >= ANOMALY_RATIO;
    const suddenBurst = baseline === 0 && current >= 5;
    return {
        current,
        baseline,
        ratio: Number.isFinite(comparison) ? Number(comparison.toFixed(2)) : null,
        flagged: elevated || suddenBurst
    };
};

const scoreFailureOrNight = (current, baseline) => {
    const comparison = ratio(current, baseline);
    const jump = current - baseline;
    const flagged = (baseline > 0 && comparison >= ANOMALY_RATIO && current >= 0.2)
        || jump >= 0.25;
    return {
        current,
        baseline,
        ratio: Number.isFinite(comparison) ? Number(comparison.toFixed(2)) : null,
        flagged
    };
};

const toMetrics = (bucket = {}) => {
    const count = Number(bucket.count || 0);
    const failed = Number(bucket.failed || 0);
    const night = Number(bucket.nightCount || 0);
    return {
        transferCount: count,
        totalVolume: Number(bucket.volume || 0),
        avgAmount: Number(bucket.avgAmount || 0),
        distinctRecipients: Array.isArray(bucket.recipients)
            ? bucket.recipients.filter(Boolean).length
            : Number(bucket.distinctRecipients || 0),
        failureRate: count ? failed / count : 0,
        nightShare: count ? night / count : 0
    };
};

const normalizeBaseline = (metrics, baselineDays = 30) => {
    if (baselineDays <= 0) return metrics;
    return {
        transferCount: metrics.transferCount / baselineDays,
        totalVolume: metrics.totalVolume / baselineDays,
        avgAmount: metrics.avgAmount,
        distinctRecipients: metrics.distinctRecipients / baselineDays,
        failureRate: metrics.failureRate,
        nightShare: metrics.nightShare
    };
};

const buildComparison = (currentBucket, baselineBucket, baselineDays = 30) => {
    const current = toMetrics(currentBucket);
    const baselineRaw = toMetrics(baselineBucket);
    const baseline = normalizeBaseline(baselineRaw, baselineDays);
    const metrics = {
        transferCount: scoreMetric(current.transferCount, baseline.transferCount),
        totalVolume: scoreMetric(current.totalVolume, baseline.totalVolume),
        avgAmount: scoreMetric(current.avgAmount, baseline.avgAmount),
        distinctRecipients: scoreMetric(current.distinctRecipients, baseline.distinctRecipients),
        failureRate: scoreFailureOrNight(current.failureRate, baseline.failureRate),
        nightShare: scoreFailureOrNight(current.nightShare, baseline.nightShare)
    };
    const flags = METRIC_META.filter((item) => metrics[item.key].flagged).map((item) => item.key);
    const anomalyScore = Math.min(100, Math.round(
        flags.length * 18
        + Math.max(0, (metrics.transferCount.ratio || 0) - 1) * 8
        + Math.max(0, (metrics.totalVolume.ratio || 0) - 1) * 6
    ));
    return {
        current,
        baseline,
        metrics,
        flags,
        anomalyScore,
        unusual: flags.length > 0 || anomalyScore >= 40
    };
};

const ownerMatch = ({ companyId, userKeys }) => {
    if (companyId) return { companyId };
    const keys = (userKeys || []).map((value) => String(value || '').trim()).filter(Boolean);
    if (!keys.length) return null;
    return { companyId: null, userId: { $in: keys } };
};

const resolveBehaviorSubject = async (req, { id, type }) => {
    const scope = tenantScope(req);
    const rawId = String(id || '').trim();
    if (String(type || '').toLowerCase() === 'company') {
        if (!mongoose.isValidObjectId(rawId)) return null;
        const company = await ClientCompany.findOne({ _id: rawId, ...scope }).select('name phone').lean();
        if (!company) return null;
        return { kind: 'company', id: String(company._id), name: company.name, match: ownerMatch({ companyId: company._id }) };
    }
    const userQuery = mongoose.isValidObjectId(rawId)
        ? { _id: rawId, ...scope }
        : { ...scope, $or: [{ phone: rawId }, { webUsername: rawId }] };
    const user = await User.findOne(userQuery).select('name phone webUsername role').lean();
    if (!user) return null;
    return {
        kind: user.role === 'agent' ? 'agent' : 'user',
        id: String(user._id),
        name: user.name,
        match: ownerMatch({ userKeys: [user.phone, user.webUsername, String(user._id)] })
    };
};

const compareClientBehavior = async (req, { id, type } = {}, now = new Date()) => {
    const subject = await resolveBehaviorSubject(req, { id, type });
    if (!subject?.match) return null;

    const currentStart = new Date(now.getTime() - CURRENT_MS);
    const baselineStart = new Date(now.getTime() - CURRENT_MS - BASELINE_MS);
    const match = { ...tenantScope(req), ...subject.match, createdAt: { $gte: baselineStart, $lte: now } };

    const rows = await Transaction.aggregate([
        { $match: match },
        {
            $project: {
                amount: 1,
                status: 1,
                recipient: { $ifNull: ['$vodafoneNumber', '$accountNumber'] },
                bucket: { $cond: [{ $gte: ['$createdAt', currentStart] }, 'current', 'baseline'] },
                hour: { $hour: { date: '$createdAt', timezone: SYSTEM_TIME_ZONE } }
            }
        },
        {
            $group: {
                _id: '$bucket',
                count: { $sum: 1 },
                volume: { $sum: { $ifNull: ['$amount', 0] } },
                avgAmount: { $avg: { $ifNull: ['$amount', 0] } },
                recipients: { $addToSet: '$recipient' },
                failed: { $sum: { $cond: [{ $eq: ['$status', 'rejected'] }, 1, 0] } },
                nightCount: {
                    $sum: {
                        $cond: [{ $or: [{ $gte: ['$hour', 22] }, { $lt: ['$hour', 6] }] }, 1, 0]
                    }
                }
            }
        }
    ]).option({ maxTimeMS: 5000 });

    const currentRow = rows.find((row) => row._id === 'current');
    const baselineRow = rows.find((row) => row._id === 'baseline');
    const comparison = buildComparison(currentRow, baselineRow, 30);

    return {
        subject: { kind: subject.kind, id: subject.id, name: subject.name },
        window: {
            current: '24h',
            baseline: '30d_daily_avg',
            timezone: SYSTEM_TIME_ZONE,
            currentFrom: currentStart.toISOString(),
            baselineFrom: baselineStart.toISOString(),
            to: now.toISOString()
        },
        meta: METRIC_META,
        ...comparison
    };
};

module.exports = {
    ANOMALY_RATIO,
    METRIC_META,
    buildComparison,
    compareClientBehavior,
    emptyBucket,
    normalizeBaseline,
    ownerMatch,
    resolveBehaviorSubject,
    scoreMetric
};
