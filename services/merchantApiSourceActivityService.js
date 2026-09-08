'use strict';

const { normalizeSourceIp } = require('./companyApiServerAccessService');

const recordAsync = (operation) => {
    try {
        Promise.resolve(operation()).catch(() => undefined);
    } catch (_) {}
};

const deviceLabelFromUserAgent = (value) => {
    const userAgent = String(value || '').trim();
    if (!userAgent) return 'جهاز API غير معروف';
    const platform = /windows/i.test(userAgent) ? 'Windows'
        : /android/i.test(userAgent) ? 'Android'
            : /iphone|ipad|ios/i.test(userAgent) ? 'iOS'
                : /linux/i.test(userAgent) ? 'Linux'
                    : 'نظام غير معروف';
    const client = /postman/i.test(userAgent) ? 'Postman'
        : /curl/i.test(userAgent) ? 'cURL'
            : /axios/i.test(userAgent) ? 'Axios'
                : /node/i.test(userAgent) ? 'Node.js'
                    : /chrome/i.test(userAgent) ? 'Chrome'
                        : /firefox/i.test(userAgent) ? 'Firefox'
                            : 'عميل API';
    return `${client} — ${platform}`;
};

const sourceServerForIp = (company = {}, sourceIp = '') => {
    const normalizedIp = normalizeSourceIp(sourceIp);
    return (company.apiAccessPolicy?.servers || []).find((server) => (
        normalizeSourceIp(server?.sourceIp) === normalizedIp
    )) || null;
};

const observeMerchantApiSource = ({ CompanyModel, company, req, sourceIp }) => {
    const normalizedIp = normalizeSourceIp(sourceIp);
    if (!CompanyModel || !company?._id || !normalizedIp) return null;

    const now = new Date();
    const userAgent = String(req.get?.('user-agent') || req.headers?.['user-agent'] || '').slice(0, 1000);
    const deviceLabel = deviceLabelFromUserAgent(userAgent);
    const endpoint = String(req.originalUrl || req.path || '').split('?')[0].slice(0, 180);
    const knownServer = sourceServerForIp(company, normalizedIp);

    if (knownServer?._id) {
        recordAsync(() => CompanyModel.updateOne(
            { _id: company._id, 'apiAccessPolicy.servers._id': knownServer._id },
            {
                $set: {
                    'apiAccessPolicy.servers.$.lastSeenAt': now,
                    'apiAccessPolicy.servers.$.lastSeenEndpoint': endpoint,
                    'apiAccessPolicy.servers.$.lastUserAgent': userAgent,
                    'apiAccessPolicy.servers.$.lastDeviceLabel': deviceLabel
                },
                $inc: { 'apiAccessPolicy.servers.$.requestCount': 1 }
            }
        ));
        return { serverId: knownServer._id, sourceIp: normalizedIp, userAgent, deviceLabel };
    }

    // Discovery is active only while the policy is open. A source seen while
    // locked is logged but never added to the allow-list automatically.
    if (company.apiAccessPolicy?.mode !== 'locked') {
        recordAsync(() => CompanyModel.updateOne(
            {
                _id: company._id,
                'apiAccessPolicy.servers': {
                    $not: { $elemMatch: { sourceIp: normalizedIp } }
                }
            },
            {
                $push: {
                    'apiAccessPolicy.servers': {
                        name: `مصدر API مكتشف — ${normalizedIp}`,
                        sourceIp: normalizedIp,
                        enabled: true,
                        discovered: true,
                        firstSeenAt: now,
                        lastSeenAt: now,
                        lastSeenEndpoint: endpoint,
                        lastUserAgent: userAgent,
                        lastDeviceLabel: deviceLabel,
                        requestCount: 1,
                        createdAt: now,
                        updatedAt: now
                    }
                }
            }
        ));
    }
    return { serverId: null, sourceIp: normalizedIp, userAgent, deviceLabel };
};

const trackMerchantApiRequest = ({ req, res, companyId, source = {} }) => {
    if (!companyId || !source.sourceIp || !res?.once) return;
    let saved = false;
    res.once('finish', () => {
        if (saved) return;
        saved = true;
        // Lazy loading keeps the Merchant API route testable without a
        // database and makes tracking strictly non-blocking for payments.
        recordAsync(() => require('../models/MerchantApiSourceLog').create({
            companyId,
            serverId: source.serverId || null,
            sourceIp: source.sourceIp,
            deviceLabel: source.deviceLabel || '',
            userAgent: source.userAgent || '',
            method: String(req.method || 'GET').slice(0, 12),
            endpoint: String(req.originalUrl || req.path || '').split('?')[0].slice(0, 180),
            statusCode: Number(res.statusCode || 0),
            transactionId: req.merchantApiActivity?.transactionId || null,
            transactionReference: String(req.merchantApiActivity?.transactionReference || '').slice(0, 80)
        }));
    });
};

module.exports = {
    deviceLabelFromUserAgent,
    sourceServerForIp,
    observeMerchantApiSource,
    trackMerchantApiRequest
};
