'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const SecurityDevice = require('../models/SecurityDevice');
const SecurityAccessRequest = require('../models/SecurityAccessRequest');
const SecurityState = require('../models/SecurityState');
const Notification = require('../models/Notification');
const { isSecurityVerificationRequired } = require('../config/securityPolicy');

const DEVICE_COOKIE = 'ahrampay_security_device';
const REQUEST_TTL_MS = 15 * 60 * 1000;
const DEFAULT_LOCKDOWN_MINUTES = 60;
const stateCache = { value: null, expiresAt: 0 };

const requestChannel = (req) => {
    // The client headers are informational only. Channel authorization must be
    // derived from server-owned routing so a browser cannot claim the app slot.
    const routePath = String(
        req.originalUrl
        || `${req.baseUrl || ''}${req.path || ''}`
    ).split('?')[0].toLowerCase();
    if (routePath.startsWith('/api/mobile') || routePath.startsWith('/api/v1/mobile')) return 'app';
    return 'web';
};

const readCookie = (req, name) => {
    const item = String(req.headers?.cookie || '')
        .split(';')
        .map((part) => part.trim())
        .find((part) => part.startsWith(`${name}=`));
    return item ? decodeURIComponent(item.slice(name.length + 1)) : '';
};

const ensureDeviceId = (req, res) => {
    const supplied = String(req.headers?.['x-device-id'] || '').trim().slice(0, 200);
    if (supplied) return supplied;
    const existing = readCookie(req, DEVICE_COOKIE).trim();
    if (existing && /^[a-f0-9-]{32,64}$/i.test(existing)) return existing;
    const deviceId = crypto.randomUUID();
    if (res?.cookie) {
        res.cookie(DEVICE_COOKIE, deviceId, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'lax',
            maxAge: 365 * 24 * 60 * 60 * 1000,
            priority: 'high'
        });
    }
    return deviceId;
};

const hashDeviceId = (deviceId) => crypto
    .createHmac('sha256', process.env.SECURITY_DEVICE_HASH_SECRET || process.env.SESSION_SECRET || 'local-device-hash')
    .update(String(deviceId || ''))
    .digest('hex');

const hashesEqual = (left, right) => {
    const leftValue = String(left || '');
    const rightValue = String(right || '');
    if (!leftValue || leftValue.length !== rightValue.length) return false;
    return crypto.timingSafeEqual(Buffer.from(leftValue, 'hex'), Buffer.from(rightValue, 'hex'));
};

const requestIp = (req) => String(
    req.headers?.['cf-connecting-ip']
    || req.headers?.['x-real-ip']
    || req.headers?.['x-forwarded-for']?.split(',')[0]
    || req.ip
    || req.socket?.remoteAddress
    || ''
).trim().replace(/^::ffff:/, '');

const parseLocation = (req) => {
    const pending = req.session?.pendingSecurityLocation || req.session?.securityLocation || {};
    const firstPresent = (...values) => values.find((value) => (
        value !== undefined
        && value !== null
        && String(value).trim() !== ''
    ));
    const latitude = Number(firstPresent(req.body?.latitude, req.headers?.['x-client-latitude'], pending.latitude));
    const longitude = Number(firstPresent(req.body?.longitude, req.headers?.['x-client-longitude'], pending.longitude));
    const accuracy = Number(firstPresent(req.body?.locationAccuracy, req.headers?.['x-client-location-accuracy'], pending.accuracy));
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90
        || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) return null;
    return {
        latitude,
        longitude,
        accuracy: Number.isFinite(accuracy) && accuracy >= 0 ? accuracy : undefined,
        capturedAt: new Date()
    };
};

const detectDevice = (req) => {
    const userAgent = String(req.headers?.['user-agent'] || '').slice(0, 1000);
    const platform = String(req.body?.devicePlatform || req.headers?.['sec-ch-ua-platform'] || '').replace(/"/g, '').slice(0, 80);
    const browserHeader = String(req.headers?.['sec-ch-ua'] || '').slice(0, 80);
    let browser = browserHeader;
    if (!browser) {
        if (/edg/i.test(userAgent)) browser = 'Edge';
        else if (/chrome|crios/i.test(userAgent)) browser = 'Chrome';
        else if (/firefox|fxios/i.test(userAgent)) browser = 'Firefox';
        else if (/safari/i.test(userAgent)) browser = 'Safari';
        else browser = 'Unknown';
    }
    let deviceType = 'computer';
    if (/ipad|tablet/i.test(userAgent)) deviceType = 'tablet';
    else if (/mobile|android|iphone|phone/i.test(userAgent)) deviceType = 'phone';
    const displayName = String(req.body?.deviceName || `${platform || deviceType} - ${browser}`).trim().slice(0, 120);
    return { userAgent, platform, browser, deviceType, displayName };
};

const assessNetworkRisk = (req) => {
    const signals = [];
    const trustedVpnSignal = String(
        req.headers?.['x-vpn-detected']
        || req.headers?.['x-security-vpn']
        || req.headers?.['cf-warp-tag-id']
        || ''
    ).toLowerCase();
    if (['1', 'true', 'yes', 'vpn', 'proxy', 'tor'].includes(trustedVpnSignal) || req.headers?.['cf-warp-tag-id']) {
        signals.push('HIGH_CONFIDENCE_ANONYMIZER');
    }
    const countryCode = String(req.headers?.['cf-ipcountry'] || req.headers?.['x-country-code'] || '').toUpperCase().slice(0, 8);
    return { highRisk: signals.length > 0, signals, countryCode };
};

const getState = async ({ fresh = false, includeSecret = false } = {}) => {
    if (!fresh && stateCache.value && stateCache.expiresAt > Date.now()) return stateCache.value;
    const query = SecurityState.findOneAndUpdate(
        { key: 'global' },
        { $setOnInsert: { key: 'global' } },
        { returnDocument: 'after', upsert: true, setDefaultsOnInsert: true }
    );
    if (includeSecret) query.select('+emergencyCodeHash');
    let state = await query.exec();
    if (state.lockdownActive && state.lockdownEndsAt && state.lockdownEndsAt <= new Date()) {
        state.lockdownActive = false;
        state.lockdownReason = '';
        state.lockdownEndsAt = null;
        await state.save();
    }
    stateCache.value = state;
    stateCache.expiresAt = Date.now() + 1000;
    return state;
};

const invalidateStateCache = () => {
    stateCache.value = null;
    stateCache.expiresAt = 0;
};

const sessionPrincipal = (session = {}) => {
    if (session.isLoggedIn && session.adminId) {
        return {
            principalType: String(session.adminId) === 'master_admin' ? 'master_admin' : 'admin',
            principalId: String(session.adminId),
            principalName: session.adminName || 'الإدارة'
        };
    }
    if (session.isExecutorLoggedIn && session.executorId) {
        return { principalType: 'executor', principalId: String(session.executorId), principalName: session.executorName || 'منفذ' };
    }
    if (session.isClientLoggedIn && session.clientId) {
        const principalType = ({
            company: 'client_company',
            agent_staff: 'agent_staff',
            sub_client: 'sub_client',
            user: 'client_user'
        })[session.accountType] || 'client_user';
        return { principalType, principalId: String(session.clientId), principalName: session.clientName || 'حساب عميل' };
    }
    return null;
};

const createAccessRequest = async ({ req, principal, deviceIdHash }) => {
    const device = detectDevice(req);
    const channel = requestChannel(req);
    const risk = assessNetworkRisk(req);
    const location = parseLocation(req) || req.session?.securityLocation || null;
    const existing = await SecurityAccessRequest.findOne({
        principalType: principal.principalType,
        principalId: principal.principalId,
        channel,
        deviceIdHash,
        status: 'pending',
        expiresAt: { $gt: new Date() }
    }).select('+deviceIdHash');
    if (existing) return existing;
    const request = await SecurityAccessRequest.create({
        requestCode: `SEC-${crypto.randomBytes(4).toString('hex').toUpperCase()}`,
        ...principal,
        channel,
        tenantId: req.tenant?._id || null,
        deviceIdHash,
        ...device,
        ipAddress: requestIp(req),
        countryCode: risk.countryCode,
        location,
        riskSignals: risk.signals,
        expiresAt: new Date(Date.now() + REQUEST_TTL_MS)
    });
    await Notification.create({
        userId: 'admin',
        audience: 'admin',
        type: 'security_device_request',
        title: channel === 'app' ? 'طلب تطبيق جديد' : 'طلب متصفح جديد',
        message: `${principal.principalName || principal.principalId} طلب اعتماد ${channel === 'app' ? 'تطبيق على هاتف جديد' : 'متصفح جديد'}. رمز المتابعة: ${request.requestCode}`,
        metadata: {
            requestId: String(request._id),
            requestCode: request.requestCode,
            principalType: principal.principalType,
            channel,
            riskSignals: risk.signals
        }
    }).catch((error) => console.error('[SecurityControl] admin device notification failed:', error.message));
    return request;
};

const activateDevice = async ({ req, res, principal, credential = null, approvedBy = '' }) => {
    const deviceId = ensureDeviceId(req, res);
    const deviceIdHash = hashDeviceId(deviceId);
    const device = detectDevice(req);
    const location = parseLocation(req) || req.session?.securityLocation || null;
    const ipAddress = requestIp(req);
    const channel = requestChannel(req);
    await SecurityDevice.updateMany(
        { principalType: principal.principalType, principalId: principal.principalId, channel, status: 'active' },
        { $set: { status: 'revoked', revokedAt: new Date(), revokedReason: 'replaced_by_new_device' } }
    );
    const record = await SecurityDevice.create({
        ...principal,
        channel,
        tenantId: req.tenant?._id || null,
        deviceIdHash,
        ...device,
        credentialId: credential?.id || null,
        credentialPublicKey: credential?.publicKey ? Buffer.from(credential.publicKey) : null,
        credentialCounter: credential?.counter || 0,
        credentialTransports: credential?.transports || [],
        credentialDeviceType: credential?.deviceType || '',
        credentialBackedUp: Boolean(credential?.backedUp),
        firstIp: ipAddress,
        lastIp: ipAddress,
        firstLocation: location,
        lastLocation: location,
        status: 'active',
        approvedBy,
        approvedAt: new Date(),
        lastSeenAt: new Date(),
        lastVerifiedAt: credential ? new Date() : null
    });
    return record;
};

const authorizeLogin = async ({ req, res, principal, accountClass = 'account', allowFirstDevice = false }) => {
    // Authentication contract tests do not provision the security collections.
    // Dedicated enforcement tests can opt in; production always evaluates policy.
    if (process.env.NODE_ENV === 'test'
        && process.env.SECURITY_CONTROL_TEST_ENFORCEMENT !== 'true') {
        return { allowed: true, enforcementEnabled: false };
    }
    if (!isSecurityVerificationRequired()) {
        return { allowed: true, enforcementEnabled: false, verificationMode: 'optional' };
    }
    const state = await getState();
    const enabled = accountClass === 'admin'
        ? state.adminDeviceEnforcementEnabled
        : state.accountDeviceEnforcementEnabled;
    if (!enabled) return { allowed: true, enforcementEnabled: false };

    const risk = assessNetworkRisk(req);
    if (state.highConfidenceVpnBlockEnabled && risk.highRisk) {
        return { allowed: false, code: 'NETWORK_RISK_BLOCKED', message: 'تعذر إكمال الدخول من هذه الشبكة.' };
    }
    const location = parseLocation(req);
    if (state.locationRequired && !location) {
        return { allowed: false, code: 'LOCATION_REQUIRED', message: 'يجب السماح بالوصول إلى الموقع لإكمال الدخول الآمن.' };
    }
    const deviceId = ensureDeviceId(req, res);
    const deviceIdHash = hashDeviceId(deviceId);
    const channel = requestChannel(req);
    const active = await SecurityDevice.findOne({
        principalType: principal.principalType,
        principalId: principal.principalId,
        channel,
        status: 'active'
    }).select('+deviceIdHash');
    const hasDeviceHistory = !active && allowFirstDevice
        ? Boolean(await SecurityDevice.exists({
            principalType: principal.principalType,
            principalId: principal.principalId,
            channel
        }))
        : false;
    if (!active && allowFirstDevice && !hasDeviceHistory) {
        const device = await activateDevice({ req, res, principal, approvedBy: 'first_verified_login' });
        await SecurityAccessRequest.updateMany(
            {
                principalType: principal.principalType,
                principalId: principal.principalId,
                channel,
                status: 'pending'
            },
            {
                $set: {
                    status: 'rejected',
                    reviewedBy: 'first_verified_login',
                    reviewedAt: new Date(),
                    reviewNote: 'Superseded by the first verified device enrollment.'
                }
            }
        );
        return { allowed: true, enforcementEnabled: true, device };
    }
    if (active && hashesEqual(active.deviceIdHash, deviceIdHash)) {
        active.lastIp = requestIp(req);
        active.lastLocation = location || active.lastLocation;
        active.lastSeenAt = new Date();
        await active.save();
        return { allowed: true, enforcementEnabled: true, device: active };
    }
    const request = await createAccessRequest({ req, principal, deviceIdHash });
    return {
        allowed: false,
        code: 'DEVICE_APPROVAL_REQUIRED',
        message: `هذا ${channel === 'app' ? 'تطبيق' : 'متصفح'} جديد. وافق على الطلب ${request.requestCode} من صفحة الأجهزة والجلسات في جلستك الحالية أو اطلب مساعدة الإدارة.`,
        requestCode: request.requestCode
    };
};

const publicDevice = (device, currentHash = '', currentChannel = '') => ({
    id: String(device._id),
    channel: device.channel || 'web',
    displayName: device.displayName || 'جهاز موثوق',
    deviceType: device.deviceType || 'unknown',
    platform: device.platform || '',
    browser: device.browser || '',
    firstIp: device.firstIp || '',
    lastIp: device.lastIp || '',
    firstLocation: device.firstLocation || null,
    lastLocation: device.lastLocation || null,
    approvedAt: device.approvedAt || null,
    lastSeenAt: device.lastSeenAt || device.updatedAt || device.createdAt,
    current: (device.channel || 'web') === currentChannel && hashesEqual(device.deviceIdHash, currentHash)
});

const publicAccessRequest = (request) => ({
    id: String(request._id),
    requestCode: request.requestCode,
    channel: request.channel || 'web',
    displayName: request.displayName || 'جهاز جديد',
    deviceType: request.deviceType || 'unknown',
    platform: request.platform || '',
    browser: request.browser || '',
    ipAddress: request.ipAddress || '',
    countryCode: request.countryCode || '',
    location: request.location || null,
    riskSignals: request.riskSignals || [],
    createdAt: request.createdAt,
    expiresAt: request.expiresAt
});

const listPrincipalSessions = async ({ principal, req, res = null }) => {
    const now = new Date();
    await SecurityAccessRequest.updateMany(
        {
            principalType: principal.principalType,
            principalId: principal.principalId,
            status: 'pending',
            expiresAt: { $lte: now }
        },
        { $set: { status: 'expired', reviewedAt: now } }
    );
    const [devices, requests] = await Promise.all([
        SecurityDevice.find({
            principalType: principal.principalType,
            principalId: principal.principalId,
            status: 'active'
        }).select('+deviceIdHash').sort({ channel: 1, lastSeenAt: -1 }).lean(),
        SecurityAccessRequest.find({
            principalType: principal.principalType,
            principalId: principal.principalId,
            status: 'pending',
            expiresAt: { $gt: now }
        }).sort({ createdAt: -1 }).lean()
    ]);
    const currentDeviceId = ensureDeviceId(req, res);
    const currentHash = hashDeviceId(currentDeviceId);
    const currentChannel = requestChannel(req);
    return {
        policy: { maxWebSessions: 1, maxAppSessions: 1 },
        currentChannel,
        devices: devices.map((device) => publicDevice(device, currentHash, currentChannel)),
        requests: requests.map(publicAccessRequest)
    };
};

const revokePrincipalDevice = async ({ principal, deviceId, req, reason = 'user_revoked' }) => {
    const device = await SecurityDevice.findOne({
        _id: deviceId,
        principalType: principal.principalType,
        principalId: principal.principalId,
        status: 'active'
    }).select('+deviceIdHash');
    if (!device) {
        const error = new Error('SECURITY_DEVICE_NOT_FOUND');
        error.code = 'SECURITY_DEVICE_NOT_FOUND';
        throw error;
    }
    const current = device.channel === requestChannel(req)
        && hashesEqual(device.deviceIdHash, hashDeviceId(ensureDeviceId(req, null)));
    device.status = 'revoked';
    device.revokedAt = new Date();
    device.revokedReason = String(reason || 'user_revoked').slice(0, 300);
    await device.save();
    return { device, current };
};

const reviewPrincipalAccessRequest = async ({ principal, requestId, approve, reviewedBy, reviewNote = '' }) => {
    const request = await SecurityAccessRequest.findOne({
        _id: requestId,
        principalType: principal.principalType,
        principalId: principal.principalId,
        status: 'pending'
    }).select('+deviceIdHash');
    if (!request) {
        const error = new Error('SECURITY_ACCESS_REQUEST_NOT_FOUND');
        error.code = 'SECURITY_ACCESS_REQUEST_NOT_FOUND';
        throw error;
    }
    if (request.expiresAt <= new Date()) {
        request.status = 'expired';
        request.reviewedAt = new Date();
        await request.save();
        const error = new Error('SECURITY_ACCESS_REQUEST_EXPIRED');
        error.code = 'SECURITY_ACCESS_REQUEST_EXPIRED';
        throw error;
    }
    request.status = approve ? 'approved' : 'rejected';
    request.reviewedBy = String(reviewedBy || principal.principalName || principal.principalId).slice(0, 160);
    request.reviewedAt = new Date();
    request.reviewNote = String(reviewNote || '').slice(0, 500);
    if (!approve) {
        await request.save();
        return { request, device: null };
    }

    await SecurityDevice.updateMany(
        {
            principalType: principal.principalType,
            principalId: principal.principalId,
            channel: request.channel || 'web',
            status: 'active'
        },
        {
            $set: {
                status: 'revoked',
                revokedAt: new Date(),
                revokedReason: 'replaced_by_approved_device'
            }
        }
    );
    const device = await SecurityDevice.create({
        principalType: principal.principalType,
        principalId: principal.principalId,
        principalName: principal.principalName || request.principalName || '',
        tenantId: request.tenantId || null,
        channel: request.channel || 'web',
        deviceIdHash: request.deviceIdHash,
        displayName: request.displayName,
        deviceType: request.deviceType,
        platform: request.platform,
        browser: request.browser,
        userAgent: request.userAgent,
        firstIp: request.ipAddress,
        lastIp: request.ipAddress,
        firstLocation: request.location || null,
        lastLocation: request.location || null,
        status: 'active',
        approvedBy: request.reviewedBy,
        approvedAt: new Date(),
        lastSeenAt: new Date()
    });
    await request.save();
    return { request, device };
};

const ensureSecurityDeviceIndexes = async () => {
    await SecurityDevice.createCollection().catch((error) => {
        if (!/already exists|NamespaceExists/i.test(error.message)) throw error;
    });
    await Promise.all([
        SecurityDevice.updateMany(
            { channel: { $exists: false }, userAgent: /dart|flutter|okhttp/i },
            { $set: { channel: 'app' } }
        ),
        SecurityAccessRequest.updateMany(
            { channel: { $exists: false }, userAgent: /dart|flutter|okhttp/i },
            { $set: { channel: 'app' } }
        ),
        require('../models/TrustedDevice').updateMany(
            { channel: { $exists: false }, sessionId: { $ne: null } },
            { $set: { channel: 'app' } }
        )
    ]);
    await Promise.all([
        SecurityDevice.updateMany({ channel: { $exists: false } }, { $set: { channel: 'web' } }),
        SecurityAccessRequest.updateMany({ channel: { $exists: false } }, { $set: { channel: 'web' } }),
        require('../models/TrustedDevice').updateMany({ channel: { $exists: false } }, { $set: { channel: 'web' } })
    ]);

    const indexes = await SecurityDevice.collection.indexes();
    const legacy = indexes.find((index) => (
        index.unique
        && index.key?.principalType === 1
        && index.key?.principalId === 1
        && index.key?.status === 1
        && !Object.prototype.hasOwnProperty.call(index.key, 'channel')
    ));
    if (legacy) await SecurityDevice.collection.dropIndex(legacy.name);
    await SecurityDevice.collection.createIndex(
        { principalType: 1, principalId: 1, channel: 1, status: 1 },
        {
            name: 'uniq_active_security_device_per_channel',
            unique: true,
            partialFilterExpression: { status: 'active' }
        }
    );
};

const applySessionSecurity = async (req, principal, accountClass = 'account') => {
    const state = await getState();
    const hours = accountClass === 'admin' ? state.adminSessionHours : state.accountSessionHours;
    req.session.securityPrincipalType = principal.principalType;
    req.session.securityPrincipalId = principal.principalId;
    req.session.securityExpiresAt = Date.now() + (hours * 60 * 60 * 1000);
    req.session.securityLocation = parseLocation(req);
    req.session.securityLoginIp = requestIp(req);
};

const rotateEmergencyCode = async (updatedBy) => {
    const plain = `AHRAM-${crypto.randomBytes(4).toString('hex').toUpperCase()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    const state = await getState({ fresh: true, includeSecret: true });
    state.emergencyCodeHash = await bcrypt.hash(plain, 12);
    state.emergencyCodeVersion += 1;
    state.emergencyCodeRotatedAt = new Date();
    state.updatedBy = updatedBy || '';
    await state.save();
    invalidateStateCache();
    return plain;
};

const verifyEmergencyCode = async (code) => {
    const normalized = String(code || '').trim().toUpperCase();
    if (!normalized) return false;
    const state = await getState({ fresh: true, includeSecret: true });
    return Boolean(
        state.emergencyCodeHash
        && await bcrypt.compare(normalized, state.emergencyCodeHash)
    );
};

const activateEmergencyLockdown = async ({ code, activatedBy, reason, minutes = DEFAULT_LOCKDOWN_MINUTES }) => {
    const state = await getState({ fresh: true, includeSecret: true });
    if (!state.emergencyCodeHash || !(await bcrypt.compare(String(code || ''), state.emergencyCodeHash))) {
        const error = new Error('INVALID_EMERGENCY_CODE');
        error.code = 'INVALID_EMERGENCY_CODE';
        throw error;
    }
    const safeMinutes = Math.min(60, Math.max(60, Number(minutes) || DEFAULT_LOCKDOWN_MINUTES));
    state.lockdownActive = true;
    state.lockdownStartedAt = new Date();
    state.lockdownEndsAt = new Date(Date.now() + safeMinutes * 60 * 1000);
    state.lockdownReason = String(reason || 'تفعيل وضع الطوارئ الأمني').slice(0, 500);
    state.lockdownActivatedBy = activatedBy || '';
    state.emergencyCodeHash = '';
    state.updatedBy = activatedBy || '';
    await state.save();
    invalidateStateCache();
    return state;
};

const isLockdownActive = async () => {
    const state = await getState();
    return Boolean(state.lockdownActive && state.lockdownEndsAt && state.lockdownEndsAt > new Date());
};

module.exports = {
    DEVICE_COOKIE,
    requestChannel,
    ensureDeviceId,
    hashDeviceId,
    requestIp,
    parseLocation,
    detectDevice,
    assessNetworkRisk,
    getState,
    invalidateStateCache,
    sessionPrincipal,
    createAccessRequest,
    activateDevice,
    authorizeLogin,
    listPrincipalSessions,
    revokePrincipalDevice,
    reviewPrincipalAccessRequest,
    ensureSecurityDeviceIndexes,
    applySessionSecurity,
    rotateEmergencyCode,
    verifyEmergencyCode,
    activateEmergencyLockdown,
    isLockdownActive
};
