'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const SecurityDevice = require('../models/SecurityDevice');
const SecurityAccessRequest = require('../models/SecurityAccessRequest');
const SecurityState = require('../models/SecurityState');
const Notification = require('../models/Notification');
const {
    isSecurityVerificationRequired,
    getEmergencyClientOtpBypassState,
    getEmergencyDeviceBindingBypassState
} = require('../config/securityPolicy');

const DEVICE_COOKIE = 'ahrampay_security_device';
const DEVICE_ID_PATTERN = /^[a-f0-9-]{32,64}$/i;
// The requesting device cannot access the account while pending, so a longer
// window lets the administrator review it without forcing the user to repeat
// the Authenticator flow every few minutes.
const REQUEST_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LOCKDOWN_MINUTES = 60;
const DEFAULT_STATE_CACHE_MS = 15 * 1000;
const DEFAULT_LAST_SEEN_MIN_INTERVAL_MS = 60 * 1000;
const DEFAULT_DEVICE_RECHECK_MS = 30 * 1000;
const DEFAULT_DEVICE_BINDING_CACHE_MS = 30 * 1000;
const stateCache = { value: null, expiresAt: 0 };
const deviceBindingCache = new Map();

const envMs = (name, fallback, { min, max }) => {
    const configured = Number(process.env[name]);
    if (!Number.isFinite(configured)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(configured)));
};

const stateCacheTtlMs = () => envMs('SECURITY_STATE_CACHE_MS', DEFAULT_STATE_CACHE_MS, { min: 3000, max: 60 * 1000 });
const lastSeenMinIntervalMs = () => envMs('SECURITY_DEVICE_LAST_SEEN_MS', DEFAULT_LAST_SEEN_MIN_INTERVAL_MS, {
    min: 15 * 1000,
    max: 5 * 60 * 1000
});
const deviceRecheckMs = () => envMs('SECURITY_DEVICE_RECHECK_MS', DEFAULT_DEVICE_RECHECK_MS, {
    min: 5 * 1000,
    max: 2 * 60 * 1000
});
const deviceBindingCacheMs = () => envMs('SECURITY_DEVICE_BINDING_CACHE_MS', DEFAULT_DEVICE_BINDING_CACHE_MS, {
    min: 5 * 1000,
    max: 2 * 60 * 1000
});

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

const persistDeviceCookie = (res, deviceId, req = null) => {
    if (!res?.cookie || !deviceId) return;
    if (req && readCookie(req, DEVICE_COOKIE).trim() === deviceId) return;
    res.cookie(DEVICE_COOKIE, deviceId, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production' || String(process.env.SECURE_COOKIE || '').toLowerCase() === 'true',
        sameSite: process.env.COOKIE_SAMESITE || 'lax',
        path: '/',
        maxAge: 365 * 24 * 60 * 60 * 1000,
        priority: 'high'
    });
};

const rememberSessionDevice = (req, deviceId) => {
    if (!req?.session || !deviceId) return deviceId;
    const nextHash = hashDeviceId(deviceId);
    if (req.session.securityDeviceId !== deviceId) req.session.securityDeviceId = deviceId;
    if (req.session.securityDeviceHash !== nextHash) req.session.securityDeviceHash = nextHash;
    return deviceId;
};

const ensureDeviceId = (req, res, { mint = true } = {}) => {
    const supplied = String(req.headers?.['x-device-id'] || '').trim().slice(0, 200);
    if (supplied) {
        persistDeviceCookie(res, supplied, req);
        rememberSessionDevice(req, supplied);
        return supplied;
    }
    const existing = readCookie(req, DEVICE_COOKIE).trim();
    if (existing && DEVICE_ID_PATTERN.test(existing)) {
        rememberSessionDevice(req, existing);
        return existing;
    }
    const fromSession = String(req.session?.securityDeviceId || '').trim();
    if (fromSession && DEVICE_ID_PATTERN.test(fromSession)) {
        persistDeviceCookie(res, fromSession, req);
        rememberSessionDevice(req, fromSession);
        return fromSession;
    }
    if (!mint) return '';
    const deviceId = crypto.randomUUID();
    persistDeviceCookie(res, deviceId, req);
    rememberSessionDevice(req, deviceId);
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

const presentLockdown = (state) => {
    if (!state) return state;
    if (state.lockdownActive && state.lockdownEndsAt && new Date(state.lockdownEndsAt) <= new Date()) {
        state.lockdownActive = false;
        state.lockdownReason = '';
        state.lockdownEndsAt = null;
    }
    return state;
};

const toCacheableState = (state) => {
    if (!state) return state;
    const raw = typeof state.toObject === 'function' ? state.toObject() : { ...state };
    return presentLockdown(raw);
};

const loadSecurityState = async ({ includeSecret = false } = {}) => {
    const query = SecurityState.findOne({ key: 'global' });
    if (includeSecret) query.select('+emergencyCodeHash');
    let state = await query.exec();
    if (state) return state;
    const upsert = SecurityState.findOneAndUpdate(
        { key: 'global' },
        { $setOnInsert: { key: 'global' } },
        { returnDocument: 'after', upsert: true, setDefaultsOnInsert: true }
    );
    if (includeSecret) upsert.select('+emergencyCodeHash');
    return upsert.exec();
};

const getState = async ({ fresh = false, includeSecret = false } = {}) => {
    if (!fresh && !includeSecret && stateCache.value && stateCache.expiresAt > Date.now()) {
        return presentLockdown({ ...stateCache.value });
    }
    const state = await loadSecurityState({ includeSecret });
    presentLockdown(state);
    if (!includeSecret) {
        stateCache.value = toCacheableState(state);
        stateCache.expiresAt = Date.now() + stateCacheTtlMs();
        if (!fresh) return presentLockdown({ ...stateCache.value });
    }
    return state;
};

const invalidateStateCache = () => {
    stateCache.value = null;
    stateCache.expiresAt = 0;
    deviceBindingCache.clear();
};

const cachedDeviceBinding = (key) => {
    const item = deviceBindingCache.get(String(key || ''));
    if (!item) return undefined;
    if (item.expiresAt <= Date.now()) {
        deviceBindingCache.delete(String(key || ''));
        return undefined;
    }
    return item.value;
};

const rememberDeviceBinding = (key, value) => {
    const cacheKey = String(key || '');
    if (!cacheKey) return;
    if (deviceBindingCache.size > 5000) {
        const oldest = deviceBindingCache.keys().next().value;
        deviceBindingCache.delete(oldest);
    }
    deviceBindingCache.set(cacheKey, {
        value: Boolean(value),
        expiresAt: Date.now() + deviceBindingCacheMs()
    });
};

const shouldTouchLastSeen = (device, { ip, now = Date.now() } = {}) => {
    if (!device) return false;
    if (ip && device.lastIp && ip !== device.lastIp) return true;
    const last = device.lastSeenAt ? new Date(device.lastSeenAt).getTime() : 0;
    return !Number.isFinite(last) || last <= 0 || (now - last) >= lastSeenMinIntervalMs();
};

const touchDeviceLastSeen = async (device, { ip, location } = {}) => {
    if (!device?._id || !shouldTouchLastSeen(device, { ip })) return false;
    const update = { lastSeenAt: new Date() };
    if (ip) update.lastIp = ip;
    if (location) update.lastLocation = location;
    await SecurityDevice.updateOne({ _id: device._id }, { $set: update });
    device.lastSeenAt = update.lastSeenAt;
    if (ip) device.lastIp = ip;
    if (location) device.lastLocation = location;
    return true;
};

const markSessionDeviceVerified = (req, { deviceId, device, now = Date.now() } = {}) => {
    if (!req?.session) return;
    if (deviceId) rememberSessionDevice(req, deviceId);
    req.session.securityDeviceCheckedAt = now;
    if (device) req.session.securityHasPasskey = Boolean(device.credentialId);
};

const sessionDeviceRecentlyVerified = (session, deviceHash, now = Date.now()) => {
    const sessionHash = session?.securityDeviceHash;
    const checkedAt = Number(session?.securityDeviceCheckedAt || 0);
    return Boolean(
        sessionHash
        && deviceHash
        && hashesEqual(sessionHash, deviceHash)
        && checkedAt > 0
        && (now - checkedAt) < deviceRecheckMs()
    );
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

const createAccessRequest = async ({ req, principal, deviceIdHash, purpose = 'first_login', authenticatorVerified = false }) => {
    const device = detectDevice(req);
    const channel = requestChannel(req);
    const risk = assessNetworkRisk(req);
    const location = parseLocation(req) || req.session?.securityLocation || null;
    const existing = await SecurityAccessRequest.findOne({
        principalType: principal.principalType,
        principalId: principal.principalId,
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
        purpose,
        authenticatorVerifiedAt: authenticatorVerified ? new Date() : null,
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

const notifyDeviceTransfer = async ({ req, principal, purpose, previousDevice = null }) => {
    const device = detectDevice(req);
    const channel = requestChannel(req);
    await Notification.create({
        userId: 'admin',
        audience: 'admin',
        type: 'security_device_transfer',
        title: 'تم ربط جهاز بعد تحقق ناجح',
        message: `${principal.principalName || principal.principalId} ربط ${channel === 'app' ? 'تطبيقاً' : 'متصفحاً'} بعد تسجيل دخول متحقَّق. يمكن مراجعة الجهاز أو إلغاؤه من مركز الأمان.`,
        metadata: {
            principalType: principal.principalType,
            principalId: principal.principalId,
            purpose,
            previousDeviceId: previousDevice ? String(previousDevice._id) : null,
            channel,
            displayName: device.displayName
        }
    }).catch((error) => console.error('[SecurityControl] device transfer notice failed:', error.message));
};

const supersedePendingAccessRequests = async ({ principal, reviewedBy, reviewNote }) => {
    await SecurityAccessRequest.updateMany(
        {
            principalType: principal.principalType,
            principalId: principal.principalId,
            status: 'pending'
        },
        {
            $set: {
                status: 'rejected',
                reviewedBy,
                reviewedAt: new Date(),
                reviewNote
            }
        }
    );
};

const activateDevice = async ({ req, res, principal, credential = null, approvedBy = '' }) => {
    const deviceId = ensureDeviceId(req, res);
    const deviceIdHash = hashDeviceId(deviceId);
    const device = detectDevice(req);
    const location = parseLocation(req) || req.session?.securityLocation || null;
    const ipAddress = requestIp(req);
    const channel = requestChannel(req);
    // One active device per channel: replacing the web browser must not
    // revoke the mobile-app binding (and the reverse).
    await SecurityDevice.updateMany(
        {
            principalType: principal.principalType,
            principalId: principal.principalId,
            channel,
            status: 'active'
        },
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

const authorizeLogin = async ({
    req,
    res,
    principal,
    accountClass = 'account',
    allowFirstDevice = false,
    authenticatorVerified = false,
    verifiedLogin = false
}) => {
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
    // Keep login binding aligned with the session guard. Admin-approval and
    // single-device flags control *how* a new device is handled, not whether
    // the current browser is enrolled at all.
    const enforcementEnabled = accountClass === 'admin'
        ? state.adminDeviceEnforcementEnabled !== false
        : state.accountDeviceEnforcementEnabled !== false;
    if (!enforcementEnabled) return { allowed: true, enforcementEnabled: false };

    const risk = assessNetworkRisk(req);
    if (state.highConfidenceVpnBlockEnabled && risk.highRisk) {
        return { allowed: false, code: 'NETWORK_RISK_BLOCKED', message: 'تعذر إكمال الدخول من هذه الشبكة.' };
    }
    const location = parseLocation(req);
    const emergencyOtpBypass = getEmergencyClientOtpBypassState();
    const emergencyDeviceBypass = getEmergencyDeviceBindingBypassState();
    if (state.locationRequired && !location && !emergencyOtpBypass.active && !emergencyDeviceBypass.active) {
        return {
            allowed: false,
            code: 'LOCATION_REQUIRED',
            message: 'يجب السماح بالوصول إلى الموقع لإكمال الدخول الآمن. فعّل الموقع في المتصفح ثم أعد المحاولة.'
        };
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
    const canRebindMismatch = allowFirstDevice && (
        verifiedLogin
        || authenticatorVerified
        || emergencyDeviceBypass.active
        || emergencyOtpBypass.active
        || state.adminApprovalRequired === false
    );

    if (!active && allowFirstDevice) {
        const device = await activateDevice({ req, res, principal, approvedBy: 'first_verified_login' });
        await supersedePendingAccessRequests({
            principal,
            reviewedBy: 'first_verified_login',
            reviewNote: 'Superseded by the first verified device enrollment.'
        });
        markSessionDeviceVerified(req, { deviceId, device });
        return { allowed: true, enforcementEnabled: true, device, enrolled: true };
    }
    if (active && hashesEqual(active.deviceIdHash, deviceIdHash)) {
        await touchDeviceLastSeen(active, { ip: requestIp(req), location: location || undefined });
        markSessionDeviceVerified(req, { deviceId, device: active });
        return { allowed: true, enforcementEnabled: true, device: active };
    }
    if (active && canRebindMismatch) {
        const approvedBy = emergencyDeviceBypass.active
            ? 'emergency_device_binding_bypass'
            : 'verified_login_rebind';
        const device = await activateDevice({ req, res, principal, approvedBy });
        await supersedePendingAccessRequests({
            principal,
            reviewedBy: approvedBy,
            reviewNote: 'Superseded by a verified login that rebound the current device.'
        });
        await notifyDeviceTransfer({
            req,
            principal,
            purpose: 'device_transfer',
            previousDevice: active
        });
        markSessionDeviceVerified(req, { deviceId, device });
        return { allowed: true, enforcementEnabled: true, device, rebound: true };
    }
    if (active && !authenticatorVerified && !verifiedLogin) {
        return {
            allowed: false,
            code: 'AUTHENTICATOR_REQUIRED_FOR_DEVICE_TRANSFER',
            message: 'أدخل رمز Authenticator أولاً لطلب نقل الحساب إلى الجهاز الجديد.'
        };
    }
    const request = await createAccessRequest({
        req,
        principal,
        deviceIdHash,
        purpose: active ? 'device_transfer' : 'first_login',
        authenticatorVerified
    });
    return {
        allowed: false,
        code: 'DEVICE_APPROVAL_REQUIRED',
        message: `هذا ${channel === 'app' ? 'تطبيق' : 'متصفح'} جديد ولم يُعتمد بعد. طلب الموافقة ${request.requestCode} أُرسل إلى الإدارة. انتظر الاعتماد أو سجّل الدخول من الجهاز المعتمد.`,
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
        policy: { maxDevices: 1 },
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
    const state = await getState();
    if (approve && state.adminApprovalRequired !== false) {
        const error = new Error('SECURITY_ADMIN_APPROVAL_REQUIRED');
        error.code = 'SECURITY_ADMIN_APPROVAL_REQUIRED';
        throw error;
    }
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

    const requestChannelName = request.channel || 'web';
    await SecurityDevice.updateMany(
        {
            principalType: principal.principalType,
            principalId: principal.principalId,
            channel: requestChannelName,
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
        channel: requestChannelName,
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

const backfillMissingSecurityChannels = async () => {
    const TrustedDevice = require('../models/TrustedDevice');
    const [deviceMissing, requestMissing, trustedMissing] = await Promise.all([
        SecurityDevice.exists({ channel: { $exists: false } }),
        SecurityAccessRequest.exists({ channel: { $exists: false } }),
        TrustedDevice.exists({ channel: { $exists: false } })
    ]);
    if (!deviceMissing && !requestMissing && !trustedMissing) return false;
    await Promise.all([
        SecurityDevice.updateMany(
            { channel: { $exists: false }, userAgent: /dart|flutter|okhttp/i },
            { $set: { channel: 'app' } }
        ),
        SecurityAccessRequest.updateMany(
            { channel: { $exists: false }, userAgent: /dart|flutter|okhttp/i },
            { $set: { channel: 'app' } }
        ),
        TrustedDevice.updateMany(
            { channel: { $exists: false }, sessionId: { $ne: null } },
            { $set: { channel: 'app' } }
        )
    ]);
    await Promise.all([
        SecurityDevice.updateMany({ channel: { $exists: false } }, { $set: { channel: 'web' } }),
        SecurityAccessRequest.updateMany({ channel: { $exists: false } }, { $set: { channel: 'web' } }),
        TrustedDevice.updateMany({ channel: { $exists: false } }, { $set: { channel: 'web' } })
    ]);
    return true;
};

const ensureSecurityDeviceIndexes = async () => {
    await SecurityDevice.createCollection().catch((error) => {
        if (!/already exists|NamespaceExists/i.test(error.message)) throw error;
    });
    await backfillMissingSecurityChannels();

    const indexes = await SecurityDevice.collection.indexes();
    const indexNames = new Set(indexes.map((index) => index.name));
    // Restore channel-aware uniqueness. A prior emergency migration collapsed
    // web+app into one active device per account and caused portal lockouts
    // whenever the mobile app rebound the same principal.
    if (indexNames.has('uniq_active_security_device_per_account')) {
        await SecurityDevice.collection.dropIndex('uniq_active_security_device_per_account');
        indexNames.delete('uniq_active_security_device_per_account');
    }
    if (!indexNames.has('uniq_active_security_device_per_channel')) {
        const duplicateGroups = await SecurityDevice.aggregate([
            { $match: { status: 'active' } },
            { $sort: { lastSeenAt: -1, updatedAt: -1 } },
            {
                $group: {
                    _id: {
                        principalType: '$principalType',
                        principalId: '$principalId',
                        channel: '$channel'
                    },
                    ids: { $push: '$_id' },
                    count: { $sum: 1 }
                }
            },
            { $match: { count: { $gt: 1 } } }
        ]);
        for (const group of duplicateGroups) {
            await SecurityDevice.updateMany(
                { _id: { $in: group.ids.slice(1) } },
                { $set: { status: 'revoked', revokedAt: new Date(), revokedReason: 'per_channel_device_policy_migration' } }
            );
        }
        await SecurityDevice.collection.createIndex(
            { principalType: 1, principalId: 1, channel: 1, status: 1 },
            {
                name: 'uniq_active_security_device_per_channel',
                unique: true,
                partialFilterExpression: { status: 'active' }
            }
        );
    }
    if (!indexNames.has('security_device_lastSeenAt')) {
        await SecurityDevice.collection.createIndex(
            { status: 1, lastSeenAt: -1 },
            { name: 'security_device_lastSeenAt' }
        );
    }
};

const applySessionSecurity = async (req, principal, accountClass = 'account', res = null) => {
    const state = await getState();
    const hours = accountClass === 'admin' ? state.adminSessionHours : state.accountSessionHours;
    const deviceId = ensureDeviceId(req, res);
    req.session.securityPrincipalType = principal.principalType;
    req.session.securityPrincipalId = principal.principalId;
    req.session.securityExpiresAt = Date.now() + (hours * 60 * 60 * 1000);
    req.session.securityLocation = parseLocation(req);
    req.session.securityLoginIp = requestIp(req);
    markSessionDeviceVerified(req, { deviceId });
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
    DEVICE_ID_PATTERN,
    DEFAULT_STATE_CACHE_MS,
    DEFAULT_LAST_SEEN_MIN_INTERVAL_MS,
    DEFAULT_DEVICE_RECHECK_MS,
    ensureDeviceId,
    persistDeviceCookie,
    rememberSessionDevice,
    markSessionDeviceVerified,
    sessionDeviceRecentlyVerified,
    shouldTouchLastSeen,
    touchDeviceLastSeen,
    cachedDeviceBinding,
    rememberDeviceBinding,
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
