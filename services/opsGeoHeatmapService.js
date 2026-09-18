'use strict';

const Transaction = require('../models/Transaction');
const AuditLog = require('../models/AuditLog');
const { tenantScope } = require('../utils/tenantScope');
const { isLocalRuntime } = require('../utils/runtimeEnv');

const WINDOW_MS = {
    '15m': 15 * 60 * 1000,
    '1h': 60 * 60 * 1000,
    '24h': 24 * 60 * 60 * 1000
};

const COUNTRY_LABELS = {
    LY: 'ليبيا', EG: 'مصر', TN: 'تونس', DZ: 'الجزائر', MA: 'المغرب', SD: 'السودان',
    SA: 'السعودية', AE: 'الإمارات', QA: 'قطر', KW: 'الكويت', BH: 'البحرين', OM: 'عُمان',
    IQ: 'العراق', JO: 'الأردن', LB: 'لبنان', SY: 'سوريا', YE: 'اليمن', PS: 'فلسطين',
    TR: 'تركيا', IR: 'إيران', PK: 'باكستان', IN: 'الهند', BD: 'بنغلاديش', CN: 'الصين',
    RU: 'روسيا', DE: 'ألمانيا', FR: 'فرنسا', IT: 'إيطاليا', ES: 'إسبانيا', GB: 'بريطانيا',
    US: 'الولايات المتحدة', CA: 'كندا', BR: 'البرازيل', NG: 'نيجيريا', KE: 'كينيا',
    ZA: 'جنوب أفريقيا', ET: 'إثيوبيا', SO: 'الصومال', TD: 'تشاد', NE: 'النيجر'
};

const COUNTRY_CENTROIDS = {
    LY: [17.2, 26.3], EG: [30.8, 26.8], TN: [9.5, 34.0], DZ: [2.6, 28.0], MA: [-6.4, 31.8],
    SD: [30.2, 15.6], SA: [45.1, 24.0], AE: [54.4, 24.3], QA: [51.2, 25.3], KW: [47.5, 29.3],
    BH: [50.5, 26.0], OM: [56.0, 21.5], IQ: [44.0, 33.2], JO: [36.2, 31.0], LB: [35.8, 33.8],
    SY: [38.0, 35.0], YE: [47.6, 15.6], PS: [35.2, 31.9], TR: [35.2, 39.0], IR: [53.7, 32.4],
    PK: [69.3, 30.4], IN: [78.9, 21.8], BD: [90.3, 23.7], CN: [104.2, 35.9], RU: [90.0, 60.0],
    DE: [10.4, 51.2], FR: [2.2, 46.2], IT: [12.6, 42.8], ES: [-3.7, 40.4], GB: [-1.5, 52.4],
    US: [-98.6, 39.8], CA: [-106.3, 56.1], BR: [-51.9, -14.2], NG: [8.7, 9.1], KE: [37.9, 0.0],
    ZA: [25.0, -29.0], ET: [40.5, 9.1], SO: [46.2, 5.2], TD: [18.7, 15.5], NE: [8.1, 17.6]
};

const parseHeatmapWindow = (value, now = new Date()) => {
    const key = WINDOW_MS[String(value || '').trim()] ? String(value).trim() : '15m';
    const ms = WINDOW_MS[key];
    return { key, from: new Date(now.getTime() - ms), to: now };
};

const normalizeCountryCode = (value) => {
    const code = String(value || '').trim().toUpperCase();
    return /^[A-Z]{2}$/.test(code) && code !== 'XX' ? code : '';
};

const mergeCountryCounts = (buckets) => {
    const counts = new Map();
    for (const bucket of buckets) {
        const code = normalizeCountryCode(bucket?._id);
        if (!code) continue;
        counts.set(code, (counts.get(code) || 0) + Number(bucket.count || 0));
    }
    const max = Math.max(1, ...counts.values());
    return [...counts.entries()]
        .map(([country, count]) => ({
            country,
            label: COUNTRY_LABELS[country] || country,
            count,
            intensity: Number((count / max).toFixed(3)),
            lat: COUNTRY_CENTROIDS[country] ? COUNTRY_CENTROIDS[country][1] : null,
            lng: COUNTRY_CENTROIDS[country] ? COUNTRY_CENTROIDS[country][0] : null
        }))
        .sort((left, right) => right.count - left.count || left.country.localeCompare(right.country));
};

const demoHeatmapCountries = () => mergeCountryCounts([
    { _id: 'LY', count: 14 },
    { _id: 'EG', count: 9 },
    { _id: 'TN', count: 4 },
    { _id: 'DE', count: 3 },
    { _id: 'TR', count: 2 }
]);

const geoPointForCountry = (value, extra = {}) => {
    const country = normalizeCountryCode(value);
    const centroid = country ? COUNTRY_CENTROIDS[country] : null;
    return {
        country: country || '',
        label: country ? (COUNTRY_LABELS[country] || country) : '',
        lng: centroid ? centroid[0] : null,
        lat: centroid ? centroid[1] : null,
        ip: extra.ip || '',
        deviceType: extra.deviceType || ''
    };
};

const allowDemoHeatmap = (req, env = process.env) => {
    const flagged = ['1', 'true', 'yes', 'on'].includes(String(env.OPS_GEO_DEMO || '').trim().toLowerCase());
    const queryFlag = ['1', 'true', 'yes'].includes(String(req?.query?.demo || '').trim().toLowerCase());
    return isLocalRuntime(env) && (flagged || queryFlag);
};

const getGeoHeatmap = async (req, now = new Date()) => {
    const window = parseHeatmapWindow(req.query?.window, now);
    const scope = tenantScope(req);
    const createdAt = { $gte: window.from, $lte: window.to };

    const [fromTransactions, fromAudits] = await Promise.all([
        Transaction.aggregate([
            { $match: { ...scope, createdAt, originCountry: { $exists: true, $nin: [null, ''] } } },
            { $group: { _id: '$originCountry', count: { $sum: 1 } } }
        ]).option({ maxTimeMS: 4000 }),
        AuditLog.aggregate([
            {
                $match: {
                    action: 'TRANSFER_CREATED',
                    createdAt,
                    countryCode: { $exists: true, $nin: [null, '', 'XX'] },
                    ...(scope.tenantId ? { tenantId: scope.tenantId } : {})
                }
            },
            { $group: { _id: '$countryCode', count: { $sum: 1 } } }
        ]).option({ maxTimeMS: 4000 })
    ]);

    const countries = mergeCountryCounts([...fromTransactions, ...fromAudits]);
    if (countries.length) {
        return {
            window: window.key,
            from: window.from.toISOString(),
            to: window.to.toISOString(),
            demo: false,
            total: countries.reduce((sum, row) => sum + row.count, 0),
            countries
        };
    }

    if (allowDemoHeatmap(req)) {
        const demoCountries = demoHeatmapCountries();
        return {
            window: window.key,
            from: window.from.toISOString(),
            to: window.to.toISOString(),
            demo: true,
            label: 'بيانات تجريبية للتطوير فقط — ليست حركة حية',
            total: demoCountries.reduce((sum, row) => sum + row.count, 0),
            countries: demoCountries
        };
    }

    return {
        window: window.key,
        from: window.from.toISOString(),
        to: window.to.toISOString(),
        demo: false,
        total: 0,
        countries: [],
        emptyReason: 'no_geo_signal'
    };
};

module.exports = {
    COUNTRY_CENTROIDS,
    COUNTRY_LABELS,
    allowDemoHeatmap,
    geoPointForCountry,
    demoHeatmapCountries,
    getGeoHeatmap,
    mergeCountryCounts,
    parseHeatmapWindow
};
