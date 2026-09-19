'use strict';

const Transaction = require('../models/Transaction');
const { tenantScope } = require('../utils/tenantScope');
const { SYSTEM_TIME_ZONE } = require('../config/systemTime');
const { STATUS_GROUPS } = require('./liveOperationsService');

const DEFAULT_CLUSTER_THRESHOLD = Math.max(2, Number(process.env.LIVE_OPS_CLUSTER_THRESHOLD) || 10);
const FAN_IN_MIN_SENDERS = Math.max(3, Number(process.env.LIVE_OPS_FANIN_SENDERS) || 5);
const FAN_IN_MIN_COUNT = Math.max(5, Number(process.env.LIVE_OPS_FANIN_COUNT) || 8);
const CONGESTION_RATIO = Number(process.env.LIVE_OPS_CONGESTION_RATIO) || 1.5;
const WINDOW_MS = {
    '15m': 15 * 60 * 1000,
    '1h': 60 * 60 * 1000,
    '24h': 24 * 60 * 60 * 1000
};

const parseWindow = (value, now = new Date()) => {
    const key = WINDOW_MS[String(value || '').trim()] ? String(value).trim() : '15m';
    return { key, from: new Date(now.getTime() - WINDOW_MS[key]), to: now };
};

const minuteKey = (value) => {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return new Date(Math.floor(date.getTime() / 60000) * 60000).toISOString();
};

const parseMinuteFilter = (value) => {
    const raw = String(value || '').trim();
    if (!raw) return null;
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) return null;
    const start = new Date(Math.floor(date.getTime() / 60000) * 60000);
    return { $gte: start, $lt: new Date(start.getTime() + 60000) };
};

const amountBand = (amount) => {
    const value = Number(amount) || 0;
    if (value < 100) return { key: '0-100', min: 0, max: 100 };
    if (value < 500) return { key: '100-500', min: 100, max: 500 };
    if (value < 2000) return { key: '500-2000', min: 500, max: 2000 };
    if (value < 10000) return { key: '2000-10000', min: 2000, max: 10000 };
    return { key: '10000+', min: 10000, max: Number.MAX_SAFE_INTEGER };
};

const clusterLoadedRows = (rows, threshold = DEFAULT_CLUSTER_THRESHOLD) => {
    const groups = new Map();
    for (const row of rows || []) {
        const owner = String(row.userKey || row.companyId || row.customer || '').trim();
        const minute = minuteKey(row.createdAt);
        if (!owner || !minute) continue;
        const key = `${owner}|${minute}`;
        if (!groups.has(key)) {
            groups.set(key, {
                key,
                owner,
                name: row.customer || owner,
                minute,
                count: 0,
                volume: 0,
                ids: []
            });
        }
        const group = groups.get(key);
        group.count += 1;
        group.volume += Number(row.amount || 0);
        group.ids.push(row.id);
    }
    return [...groups.values()]
        .filter((group) => group.count >= threshold)
        .sort((left, right) => right.count - left.count);
};

const attachLiveClusters = (rows, threshold = DEFAULT_CLUSTER_THRESHOLD) => {
    const limit = Math.max(2, Number(threshold) || DEFAULT_CLUSTER_THRESHOLD);
    const clusters = clusterLoadedRows(rows, limit);
    const keyById = new Map();
    clusters.forEach((cluster) => {
        (cluster.ids || []).forEach((id) => keyById.set(String(id), cluster.key));
    });
    return {
        clusterThreshold: limit,
        clusters,
        rows: (rows || []).map((row) => ({
            ...row,
            clusterKey: keyById.get(String(row.id)) || null
        }))
    };
};

const buildTimeFlow = (buckets = []) => {
    const max = Math.max(1, ...buckets.map((row) => Number(row.total || 0)));
    return buckets.map((row) => ({
        minute: row.minute,
        total: Number(row.total || 0),
        success: Number(row.success || 0),
        failed: Number(row.failed || 0),
        pending: Number(row.pending || 0),
        intensity: Number((Number(row.total || 0) / max).toFixed(3))
    }));
};

const detectFanIn = (groups = [], { minSenders = FAN_IN_MIN_SENDERS, minCount = FAN_IN_MIN_COUNT } = {}) => (
    groups
        .map((group) => ({
            recipient: group.recipient,
            count: Number(group.count || 0),
            senders: Number(group.senders || 0),
            volume: Number(group.volume || 0)
        }))
        .filter((group) => group.senders >= minSenders && group.count >= minCount)
        .sort((left, right) => right.senders - left.senders || right.count - left.count)
);

const forecastCongestion = ({ currentHourCount = 0, baselineHourAvg = 0, pending = 0 } = {}) => {
    const baseline = Number(baselineHourAvg || 0);
    const current = Number(currentHourCount || 0);
    const ratio = baseline > 0 ? current / baseline : (current > 0 ? Infinity : 1);
    const flagged = (baseline > 0 && ratio >= CONGESTION_RATIO && current >= 8)
        || (baseline === 0 && current >= 20)
        || Number(pending || 0) >= 25;
    return {
        currentHourCount: current,
        baselineHourAvg: Number(baseline.toFixed(2)),
        ratio: Number.isFinite(ratio) ? Number(ratio.toFixed(2)) : null,
        pending: Number(pending || 0),
        flagged,
        message: flagged
            ? `متوقع ارتفاع في حجم العمليات خلال الساعة القادمة (${current} مقابل متوسط ${baseline.toFixed(1)}).`
            : ''
    };
};

const buildTrustPath = ({ originCountry = '', auditCountry = '', ip = '', deviceType = '' } = {}) => {
    const origin = String(originCountry || '').trim().toUpperCase();
    const audit = String(auditCountry || '').trim().toUpperCase();
    const known = Boolean(origin && audit);
    const mismatch = known && origin !== audit;
    return {
        originCountry: origin || '',
        auditCountry: audit || '',
        ip: ip || '',
        deviceType: deviceType || '',
        consistent: known ? !mismatch : null,
        state: mismatch ? 'mismatch' : (known ? 'consistent' : 'unknown')
    };
};

const scoreDuration = ({ currentMs = 0, baselineMs = 0, sample = 0 } = {}) => {
    const current = Number(currentMs || 0);
    const baseline = Number(baselineMs || 0);
    const slow = baseline > 0 && current >= baseline * 2 && sample >= 5;
    return {
        currentMs: current,
        baselineMs: baseline,
        sample: Number(sample || 0),
        slow,
        ratio: baseline > 0 ? Number((current / baseline).toFixed(2)) : null
    };
};

const buildWatchdogSuggestions = ({
    geo = [],
    fanIn = [],
    congestion = {},
    failureRate5m = 0,
    clusters = [],
    recentTotal = 0
} = {}) => {
    const suggestions = [];
    const hottest = geo[0];
    if (hottest && recentTotal >= 8 && hottest.count / recentTotal >= 0.7) {
        suggestions.push({
            id: `geo-${hottest.country}`,
            kind: 'geo_burst',
            source: 'rules',
            severity: 'high',
            title: `تركّز جغرافي من ${hottest.label || hottest.country}`,
            prompt: 'لاحظنا نمطاً غير اعتيادي في مصدر العمليات. هل تريد تفعيل فلتر المراقبة؟',
            body: `لاحظنا نمطاً غير اعتيادي: ${hottest.count} عملية من ${hottest.label || hottest.country} خلال النافذة الحالية. هل تريد تفعيل فلتر المراقبة؟`,
            cta: 'تفعيل فلتر المراقبة',
            action: { type: 'filter', q: hottest.country, extra: { country: hottest.country } }
        });
    }
    if (Number(failureRate5m || 0) > 8) {
        suggestions.push({
            id: 'fail-spike',
            kind: 'failure_spike',
            source: 'rules',
            severity: 'high',
            title: 'ارتفاع مفاجئ في الفشل',
            prompt: 'لاحظنا نمطاً غير اعتيادي في نسبة الفشل. هل تريد تفعيل فلتر المراقبة؟',
            body: `لاحظنا نمطاً غير اعتيادي: نسبة الفشل خلال 5 دقائق بلغت ${Number(failureRate5m).toFixed(1)}%. هل تريد تفعيل فلتر المراقبة على العمليات الفاشلة؟`,
            cta: 'تفعيل فلتر المراقبة',
            action: { type: 'filter', status: 'failed', range: '1h' }
        });
    }
    fanIn.slice(0, 3).forEach((item) => {
        suggestions.push({
            id: `fanin-${item.recipient}`,
            kind: 'fan_in',
            source: 'rules',
            severity: 'medium',
            title: `تجميع على مستلم واحد (${item.recipient})`,
            prompt: 'لاحظنا نمطاً غير اعتيادي نحو مستفيد واحد. هل تريد تفعيل فلتر المراقبة؟',
            body: `لاحظنا نمطاً غير اعتيادي: ${item.senders} مرسلين مختلفين و${item.count} عمليات نحو ${item.recipient}. هل تريد تفعيل فلتر المراقبة؟`,
            cta: 'تفعيل فلتر المراقبة',
            action: { type: 'filter', q: item.recipient, range: '1h' }
        });
    });
    if (congestion?.flagged) {
        suggestions.push({
            id: 'congestion',
            kind: 'congestion',
            source: 'rules',
            severity: 'medium',
            title: 'ازدحام متوقع',
            prompt: 'لاحظنا نمطاً غير اعتيادي في حجم العمليات. هل تريد تفعيل فلتر المراقبة؟',
            body: `${congestion.message} هل تريد تفعيل فلتر المراقبة على المعلّق؟`,
            cta: 'تفعيل فلتر المراقبة',
            action: { type: 'filter', status: 'pending', range: '1h' }
        });
    }
    clusters.slice(0, 3).forEach((cluster) => {
        suggestions.push({
            id: `cluster-${cluster.key}`,
            kind: 'burst',
            source: 'rules',
            severity: 'medium',
            title: `Burst من ${cluster.name}`,
            prompt: 'لاحظنا نمطاً غير اعتيادي من نفس الحساب. هل تريد تفعيل فلتر المراقبة؟',
            body: `لاحظنا نمطاً غير اعتيادي: ${cluster.count} عملية من ${cluster.name} في نفس الدقيقة. هل تريد تفعيل فلتر المراقبة؟`,
            cta: 'تفعيل فلتر المراقبة',
            action: { type: 'filter', q: cluster.owner, range: '1h' }
        });
    });
    return suggestions;
};

const recipientExpr = { $ifNull: ['$vodafoneNumber', { $ifNull: ['$accountNumber', '$serviceDetails.clientPhone'] }] };
const ownerExpr = { $ifNull: ['$userId', { $ifNull: ['$companyName', '$accountName'] }] };

const getTimeFlow = async (req, now = new Date()) => {
    const window = parseWindow(req.query?.window || req.query?.range, now);
    const rows = await Transaction.aggregate([
        { $match: { ...tenantScope(req), createdAt: { $gte: window.from, $lte: window.to } } },
        {
            $group: {
                _id: { $dateToString: { format: '%Y-%m-%dT%H:%M:00.000Z', date: '$createdAt', timezone: 'UTC' } },
                total: { $sum: 1 },
                success: { $sum: { $cond: [{ $in: ['$status', STATUS_GROUPS.success] }, 1, 0] } },
                failed: { $sum: { $cond: [{ $eq: ['$status', 'rejected'] }, 1, 0] } },
                pending: { $sum: { $cond: [{ $in: ['$status', STATUS_GROUPS.pending] }, 1, 0] } }
            }
        },
        { $sort: { _id: 1 } },
        { $limit: 120 }
    ]).option({ maxTimeMS: 4000 });
    return buildTimeFlow(rows.map((row) => ({
        minute: row._id,
        total: row.total,
        success: row.success,
        failed: row.failed,
        pending: row.pending
    })));
};

const getClusters = async (req, now = new Date()) => {
    const window = parseWindow(req.query?.window || req.query?.range, now);
    const threshold = Math.max(2, Number(req.query?.threshold) || DEFAULT_CLUSTER_THRESHOLD);
    const rows = await Transaction.aggregate([
        { $match: { ...tenantScope(req), createdAt: { $gte: window.from, $lte: window.to } } },
        {
            $group: {
                _id: {
                    owner: ownerExpr,
                    minute: { $dateToString: { format: '%Y-%m-%dT%H:%M:00.000Z', date: '$createdAt', timezone: 'UTC' } }
                },
                count: { $sum: 1 },
                volume: { $sum: { $ifNull: ['$amount', 0] } },
                name: { $last: { $ifNull: ['$companyName', { $ifNull: ['$accountName', '$employeeName'] }] } }
            }
        },
        { $match: { count: { $gte: threshold } } },
        { $sort: { count: -1 } },
        { $limit: 20 }
    ]).option({ maxTimeMS: 4000 });
    return {
        threshold,
        clusters: rows.map((row) => ({
            key: `${row._id.owner}|${row._id.minute}`,
            owner: row._id.owner,
            minute: row._id.minute,
            name: row.name || row._id.owner,
            count: row.count,
            volume: row.volume
        }))
    };
};

const getFanInPatterns = async (req, now = new Date()) => {
    const window = parseWindow(req.query?.window || req.query?.range, now);
    const rows = await Transaction.aggregate([
        { $match: { ...tenantScope(req), createdAt: { $gte: window.from, $lte: window.to } } },
        {
            $group: {
                _id: recipientExpr,
                count: { $sum: 1 },
                senders: { $addToSet: ownerExpr },
                volume: { $sum: { $ifNull: ['$amount', 0] } }
            }
        },
        { $project: { recipient: '$_id', count: 1, volume: 1, senders: { $size: '$senders' } } },
        { $match: { recipient: { $nin: [null, '', '---'] }, senders: { $gte: FAN_IN_MIN_SENDERS }, count: { $gte: FAN_IN_MIN_COUNT } } },
        { $sort: { senders: -1, count: -1 } },
        { $limit: 8 }
    ]).option({ maxTimeMS: 4000 });
    return detectFanIn(rows);
};

const getCongestionForecast = async (req, now = new Date()) => {
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const currentHourStart = new Date(now);
    currentHourStart.setMinutes(0, 0, 0);
    const [hourly, pending] = await Promise.all([
        Transaction.aggregate([
            { $match: { ...tenantScope(req), createdAt: { $gte: sevenDaysAgo, $lte: now } } },
            {
                $project: {
                    hour: { $hour: { date: '$createdAt', timezone: SYSTEM_TIME_ZONE } },
                    day: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: SYSTEM_TIME_ZONE } }
                }
            },
            { $group: { _id: { day: '$day', hour: '$hour' }, count: { $sum: 1 } } }
        ]).option({ maxTimeMS: 5000 }),
        Transaction.countDocuments({
            ...tenantScope(req),
            status: { $in: STATUS_GROUPS.pending }
        }).maxTimeMS(3000)
    ]);
    const currentHour = Number(new Intl.DateTimeFormat('en-GB', {
        timeZone: SYSTEM_TIME_ZONE, hour: '2-digit', hourCycle: 'h23'
    }).format(now));
    const todayKey = new Intl.DateTimeFormat('en-CA', { timeZone: SYSTEM_TIME_ZONE }).format(now);
    const current = hourly.find((row) => row._id.hour === currentHour && row._id.day === todayKey);
    const baselineRows = hourly.filter((row) => row._id.hour === currentHour && row._id.day !== todayKey);
    const baselineAvg = baselineRows.length
        ? baselineRows.reduce((sum, row) => sum + row.count, 0) / baselineRows.length
        : 0;
    return forecastCongestion({
        currentHourCount: current?.count || 0,
        baselineHourAvg: baselineAvg,
        pending
    });
};

const getSimilarBenchmark = async (req, { type, amount, durationMs } = {}, now = new Date()) => {
    const band = amountBand(amount);
    const transferType = String(type || '').trim();
    const match = {
        ...tenantScope(req),
        status: 'completed',
        createdAt: { $gte: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000), $lte: now },
        completedAt: { $ne: null },
        amount: { $gte: band.min, $lte: band.max === Number.MAX_SAFE_INTEGER ? amount * 2 || 20000 : band.max }
    };
    if (transferType) match.transferType = transferType;
    const [row] = await Transaction.aggregate([
        { $match: match },
        {
            $group: {
                _id: null,
                sample: { $sum: 1 },
                baselineMs: { $avg: { $subtract: ['$completedAt', '$createdAt'] } }
            }
        }
    ]).option({ maxTimeMS: 4000 });
    return {
        band: band.key,
        type: transferType || 'any',
        ...scoreDuration({
            currentMs: durationMs,
            baselineMs: row?.baselineMs || 0,
            sample: row?.sample || 0
        })
    };
};

const listLiveChanges = async (req, now = new Date()) => {
    const since = new Date(req.query?.since || now.getTime() - 20000);
    if (Number.isNaN(since.getTime())) return { changes: [], serverTime: now.toISOString() };
    const rows = await Transaction.find({
        ...tenantScope(req),
        updatedAt: { $gt: since, $lte: now }
    }).select('customId status updatedAt executorName assignedExecutorName').sort({ updatedAt: -1 }).limit(40).maxTimeMS(3000).lean();
    return {
        serverTime: now.toISOString(),
        changes: rows.map((row) => ({
            id: String(row._id),
            reference: row.customId,
            status: row.status,
            updatedAt: row.updatedAt,
            actor: row.assignedExecutorName || row.executorName || ''
        }))
    };
};

const getOpsIntelligence = async (req, now = new Date()) => {
    const window = parseWindow(req.query?.window, now);
    const query = { ...req, query: { ...req.query, window: window.key, range: window.key } };
    const [timeFlow, clusterPack, fanIn, congestion, geo] = await Promise.all([
        getTimeFlow(query, now),
        getClusters(query, now),
        getFanInPatterns(query, now),
        getCongestionForecast(query, now),
        require('./opsGeoHeatmapService').getGeoHeatmap({ ...req, query: { window: window.key } }, now)
            .catch(() => ({ countries: [], total: 0 }))
    ]);
    const watchdog = buildWatchdogSuggestions({
        geo: geo.countries || [],
        fanIn,
        congestion,
        failureRate5m: Number(req.metrics?.failureRate5m || 0),
        clusters: clusterPack.clusters,
        recentTotal: geo.total || timeFlow.reduce((sum, row) => sum + row.total, 0)
    });
    return {
        window: window.key,
        threshold: clusterPack.threshold,
        timeFlow,
        clusters: clusterPack.clusters,
        fanIn,
        congestion,
        watchdog,
        source: 'rules',
        disclaimer: 'اقتراحات قواعد تشغيلية محددة مسبقاً — ليست نموذجاً لغوياً.'
    };
};

module.exports = {
    CONGESTION_RATIO,
    DEFAULT_CLUSTER_THRESHOLD,
    FAN_IN_MIN_COUNT,
    FAN_IN_MIN_SENDERS,
    amountBand,
    attachLiveClusters,
    buildTimeFlow,
    buildTrustPath,
    buildWatchdogSuggestions,
    clusterLoadedRows,
    detectFanIn,
    forecastCongestion,
    getClusters,
    getCongestionForecast,
    getFanInPatterns,
    getOpsIntelligence,
    getSimilarBenchmark,
    getTimeFlow,
    listLiveChanges,
    minuteKey,
    parseMinuteFilter,
    parseWindow,
    scoreDuration
};
