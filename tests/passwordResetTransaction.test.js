'use strict';

jest.mock('../services/emailOtpMailer', () => ({
    sendPasswordResetEmail: jest.fn()
}));
jest.mock('../services/whatsappService', () => ({
    sendOtp: jest.fn(),
    sendLegacyWhatsAppMessage: jest.fn(),
    sendWhatChimpText: jest.fn()
}));
jest.mock('axios', () => ({
    post: jest.fn(),
    get: jest.fn(),
    create: jest.fn(() => ({ post: jest.fn(), get: jest.fn() }))
}));

const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const axios = require('axios');
const AuditLog = require('../models/AuditLog');
const User = require('../models/User');
const PasswordResetRequest = require('../models/PasswordResetRequest');
const MobileDeviceSession = require('../models/MobileDeviceSession');
const { hashOtp, verifyOtp } = require('../utils/otp');
const { sendPasswordResetEmail } = require('../services/emailOtpMailer');
const { sendOtp, sendLegacyWhatsAppMessage } = require('../services/whatsappService');
const {
    completePasswordReset,
    startPasswordReset,
    verifyPasswordReset
} = require('../services/passwordResetService');

jest.setTimeout(180000);

const CODE = '482913';
const requestStub = {
    headers: {},
    method: 'POST',
    originalUrl: '/api/password-reset/start',
    ip: '127.0.0.1'
};
const expectAuditOmits = async (...secrets) => {
    const logs = await AuditLog.find({}).lean();
    expect(logs.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(logs);
    secrets.filter(Boolean).forEach((secret) => {
        expect(serialized).not.toContain(secret);
    });
};

const publicShape = (body) => ({
    success: body.success,
    code: body.code,
    message: body.message,
    error: body.error,
    supportPhone: body.supportPhone,
    supportEmail: body.supportEmail
});

let replSet;
let sequence = 0;

const nextIdentity = () => {
    sequence += 1;
    return {
        phone: `0912${String(sequence).padStart(6, '0')}`,
        username: `owner${sequence}@example.com`,
        email: `owner${sequence}@example.com`
    };
};

const createUser = async ({ channel = 'email', email = '' } = {}) => {
    const identity = nextIdentity();
    const webPassword = await bcrypt.hash('old-password', 4);
    return User.create({
        name: 'عميل',
        phone: identity.phone,
        webUsername: identity.username,
        webPassword,
        role: 'user',
        status: 'active',
        otpDeliveryChannel: channel,
        businessProfile: { email: email || (channel === 'email' ? identity.email : '') },
        refreshToken: 'keep-me',
        sessionVersion: 0
    });
};

const createResetRequest = async (user, overrides = {}) => PasswordResetRequest.create({
    accountType: 'user',
    accountModel: 'User',
    accountId: user._id,
    username: user.webUsername,
    phone: user.phone,
    name: user.name,
    status: 'otp_sent',
    otpPurpose: 'password_reset',
    otpCode: hashOtp(CODE, 'password_reset'),
    otpExpires: new Date(Date.now() + 10 * 60 * 1000),
    otpAttempts: 0,
    ...overrides
});

const addSessions = async (user) => {
    await MobileDeviceSession.create({
        accountId: user._id,
        accountType: 'client_user',
        sessionId: `device-${user._id}`,
        refreshTokenHash: 'device-refresh',
        active: true
    });
    await mongoose.connection.collection('sessions').insertOne({
        _id: `web-${user._id}`,
        expires: new Date(Date.now() + 60 * 60 * 1000),
        session: JSON.stringify({
            clientId: String(user._id),
            clientSessionVersion: 0,
            isClientLoggedIn: true
        })
    });
};

beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({
        replSet: { count: 1, storageEngine: 'wiredTiger' }
    });
    await mongoose.connect(replSet.getUri(), { serverSelectionTimeoutMS: 20000 });
    const hello = await mongoose.connection.db.admin().command({ hello: 1 });
    if (!hello.setName) throw new Error('MongoDB transactions require a replica set');
});

afterAll(async () => {
    await mongoose.disconnect();
    if (replSet) await replSet.stop();
});

afterEach(async () => {
    jest.restoreAllMocks();
    sendPasswordResetEmail.mockReset();
    sendOtp.mockReset();
    sendLegacyWhatsAppMessage.mockReset();
    axios.post.mockReset();
    const collections = await mongoose.connection.db.collections();
    await Promise.all(collections.map((collection) => collection.deleteMany({})));
});

describe('password reset on a replica set', () => {
    test('returns one public body for a missing account, an unapproved address, a sent code, and a throttled account', async () => {
        sendPasswordResetEmail.mockResolvedValue({ success: true, channel: 'email' });
        const missing = await startPasswordReset({ username: 'nobody', phone: '0910000000', req: requestStub });
        const unapproved = await createUser({ channel: 'whatsapp', email: 'plain@example.com' });
        const unapprovedBody = await startPasswordReset({
            username: unapproved.webUsername,
            phone: unapproved.phone,
            req: requestStub
        });
        const approved = await createUser({ channel: 'email' });
        const sent = await startPasswordReset({
            username: approved.webUsername,
            phone: approved.phone,
            req: requestStub
        });
        await PasswordResetRequest.create(Array.from({ length: 5 }, () => ({
            accountType: 'user',
            accountModel: 'User',
            accountId: approved._id,
            username: approved.webUsername,
            phone: approved.phone,
            name: approved.name,
            status: 'expired',
            otpPurpose: 'password_reset'
        })));
        const throttled = await startPasswordReset({
            username: approved.webUsername,
            phone: approved.phone,
            req: requestStub
        });

        expect(publicShape(unapprovedBody)).toEqual(publicShape(missing));
        expect(publicShape(sent)).toEqual(publicShape(missing));
        expect(publicShape(throttled)).toEqual(publicShape(missing));
        [missing, unapprovedBody, sent, throttled].forEach((body) => {
            expect(body.requestId).toMatch(/^[a-f0-9]{24}$/i);
            expect(body.message).toContain('0913731533');
            expect(body.message).toContain('support@ahrampay.com');
            expect(body.message).not.toContain('موثّق');
        });
        expect(sendPasswordResetEmail).toHaveBeenCalledTimes(1);
        expect(sendPasswordResetEmail.mock.calls[0][0].to).toBe(approved.businessProfile.email);
        expect(sendOtp).not.toHaveBeenCalled();
        expect(axios.post).not.toHaveBeenCalled();
    });

    test('does not call WhatsApp or change the account when email delivery fails', async () => {
        const user = await createUser({ channel: 'email' });
        const before = await User.findById(user._id).lean();
        sendPasswordResetEmail.mockResolvedValue({ success: false, code: 'EMAIL_OTP_SEND_FAILED' });
        const missing = await startPasswordReset({ username: 'nobody', phone: '090', req: requestStub });
        const failed = await startPasswordReset({
            username: user.webUsername,
            phone: user.phone,
            req: requestStub
        });
        const after = await User.findById(user._id).lean();
        const stored = await PasswordResetRequest.find({ accountId: user._id }).lean();
        expect(publicShape(failed)).toEqual(publicShape(missing));
        expect(after.webPassword).toBe(before.webPassword);
        expect(after.sessionVersion).toBe(0);
        expect(after.refreshToken).toBe('keep-me');
        expect(stored).toHaveLength(1);
        expect(stored[0].status).toBe('expired');
        expect(stored[0].otpCode).toBeUndefined();
        expect(sendOtp).not.toHaveBeenCalled();
        expect(sendLegacyWhatsAppMessage).not.toHaveBeenCalled();
        expect(axios.post).not.toHaveBeenCalled();
        await expectAuditOmits(sendPasswordResetEmail.mock.calls[0][0].otp);
    });

    test('locks the request after five concurrent wrong attempts and rejects the correct code afterwards', async () => {
        const user = await createUser();
        const request = await createResetRequest(user);
        const results = await Promise.all(Array.from({ length: 5 }, () => verifyPasswordReset({
            requestId: String(request._id),
            otp: '111111',
            req: requestStub
        })));
        expect(results.every((result) => result.success === false)).toBe(true);
        const locked = await PasswordResetRequest.findById(request._id).lean();
        expect(locked.otpAttempts).toBe(5);
        expect(locked.status).toBe('expired');
        expect(locked.otpCode).toBeUndefined();
        const correct = await verifyPasswordReset({
            requestId: String(request._id),
            otp: CODE,
            req: requestStub
        });
        expect(correct.success).toBe(false);
        expect(['PASSWORD_RESET_ATTEMPTS', 'PASSWORD_RESET_EXPIRED']).toContain(correct.code);
        expect(await User.findById(user._id)).toMatchObject({ sessionVersion: 0, refreshToken: 'keep-me' });
    });

    test('accepts a correct code on the fifth attempt, then rejects reuse', async () => {
        const user = await createUser();
        const request = await createResetRequest(user);
        for (let attempt = 0; attempt < 4; attempt += 1) {
            const wrong = await verifyPasswordReset({
                requestId: String(request._id),
                otp: '111111',
                req: requestStub
            });
            expect(wrong.code).toBe('PASSWORD_RESET_CODE_INVALID');
        }
        const accepted = await verifyPasswordReset({
            requestId: String(request._id),
            otp: CODE,
            req: requestStub
        });
        expect(accepted.success).toBe(true);
        const again = await verifyPasswordReset({
            requestId: String(request._id),
            otp: CODE,
            req: requestStub
        });
        expect(again.code).toBe('PASSWORD_RESET_REUSED');
        const stored = await PasswordResetRequest.findById(request._id).lean();
        expect(stored.status).toBe('otp_verified');
        expect(stored.otpCode).toBeUndefined();
        expect(stored.otpVerifiedAt).toBeInstanceOf(Date);
        await expectAuditOmits(CODE);
    });

    test('does not accept a login OTP as a reset code or a reset code as a login OTP', async () => {
        const user = await createUser();
        const loginHashed = await createResetRequest(user, { otpCode: hashOtp(CODE, 'login') });
        const rejected = await verifyPasswordReset({
            requestId: String(loginHashed._id),
            otp: CODE,
            req: requestStub
        });
        expect(rejected.code).toBe('PASSWORD_RESET_CODE_INVALID');
        expect((await PasswordResetRequest.findById(loginHashed._id)).status).toBe('otp_sent');
        expect(verifyOtp(CODE, hashOtp(CODE, 'password_reset'), 'login')).toBe(false);
        expect(verifyOtp(CODE, hashOtp(CODE, 'login'), 'password_reset')).toBe(false);
        expect(verifyOtp(CODE, hashOtp(CODE, 'password_reset'), 'password_reset')).toBe(true);
    });

    test('rejects completion after the verification window and leaves the password unchanged', async () => {
        process.env.PASSWORD_RESET_COMPLETE_WINDOW_SECONDS = '60';
        const user = await createUser();
        const request = await createResetRequest(user, {
            status: 'otp_verified',
            otpCode: undefined,
            otpVerifiedAt: new Date(Date.now() - 90 * 1000)
        });
        const before = await User.findById(user._id).lean();
        const result = await completePasswordReset({
            requestId: String(request._id),
            newPassword: 'new-password-1',
            req: requestStub
        });
        delete process.env.PASSWORD_RESET_COMPLETE_WINDOW_SECONDS;
        const after = await User.findById(user._id).lean();
        const stored = await PasswordResetRequest.findById(request._id).lean();
        expect(result.code).toBe('PASSWORD_RESET_EXPIRED');
        expect(stored.status).toBe('expired');
        expect(after.webPassword).toBe(before.webPassword);
        expect(after.sessionVersion).toBe(0);
    });

    test('lets exactly one of two concurrent completions change the password and invalidate sessions', async () => {
        const user = await createUser();
        await addSessions(user);
        const request = await createResetRequest(user, {
            status: 'otp_verified',
            otpCode: undefined,
            otpVerifiedAt: new Date()
        });
        const passwords = ['password-one-1', 'password-two-2'];
        const results = await Promise.all(passwords.map((newPassword) => completePasswordReset({
            requestId: String(request._id),
            newPassword,
            req: requestStub
        })));
        expect(results.filter((result) => result.success)).toHaveLength(1);
        expect(results.filter((result) => result.code === 'PASSWORD_RESET_REUSED')).toHaveLength(1);
        const after = await User.findById(user._id).lean();
        const matches = await Promise.all(passwords.map((password) => bcrypt.compare(password, after.webPassword)));
        expect(matches.filter(Boolean)).toHaveLength(1);
        expect(after.sessionVersion).toBe(1);
        expect(after.refreshToken).toBeUndefined();
        expect(Number(after.sessionVersion)).not.toBe(0);
        const device = await MobileDeviceSession.findOne({ accountId: user._id }).lean();
        expect(device.active).toBe(false);
        expect(device.revokeReason).toBe('password_reset');
        const webSession = await mongoose.connection.collection('sessions').findOne({ _id: `web-${user._id}` });
        expect(webSession).toBeNull();
        expect((await PasswordResetRequest.findById(request._id)).status).toBe('completed');
        const successLog = await AuditLog.findOne({ action: 'PASSWORD_RESET_SUCCESS' }).lean();
        expect(successLog).toBeTruthy();
        await expectAuditOmits(...passwords);
    });

    test('rolls back the password, sessions, and request when a step inside the transaction fails', async () => {
        const user = await createUser();
        await addSessions(user);
        const request = await createResetRequest(user, {
            status: 'otp_verified',
            otpCode: undefined,
            otpVerifiedAt: new Date()
        });
        const before = await User.findById(user._id).lean();
        jest.spyOn(MobileDeviceSession, 'updateMany').mockRejectedValue(new Error('revoke failed'));
        const result = await completePasswordReset({
            requestId: String(request._id),
            newPassword: 'should-not-stick',
            req: requestStub
        });
        const after = await User.findById(user._id).lean();
        const stored = await PasswordResetRequest.findById(request._id).lean();
        const device = await MobileDeviceSession.findOne({ accountId: user._id }).lean();
        const webSession = await mongoose.connection.collection('sessions').findOne({ _id: `web-${user._id}` });
        expect(result.success).toBe(false);
        expect(result.code).toBe('PASSWORD_RESET_COMPLETE_FAILED');
        expect(after.webPassword).toBe(before.webPassword);
        expect(after.sessionVersion).toBe(0);
        expect(after.refreshToken).toBe('keep-me');
        expect(stored.status).toBe('otp_verified');
        expect(device.active).toBe(true);
        expect(webSession).toBeTruthy();
        expect(await bcrypt.compare('should-not-stick', after.webPassword)).toBe(false);
    });
});
