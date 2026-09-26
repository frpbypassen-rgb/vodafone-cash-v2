'use strict';

const { hashOtp, verifyOtp } = require('../utils/otp');

jest.mock('../models/User', () => ({ findOne: jest.fn(), updateOne: jest.fn() }));
jest.mock('../models/SubAccount', () => ({ findOne: jest.fn(), updateOne: jest.fn() }));
jest.mock('../models/PasswordResetRequest', () => ({
    create: jest.fn(),
    findById: jest.fn(),
    findOne: jest.fn(),
    findOneAndUpdate: jest.fn(),
    updateOne: jest.fn(),
    countDocuments: jest.fn()
}));
jest.mock('../models/MobileDeviceSession', () => ({ updateMany: jest.fn() }));
jest.mock('../services/auditService', () => ({ logAction: jest.fn() }));
jest.mock('../services/emailOtpMailer', () => ({ sendPasswordResetEmail: jest.fn() }));
jest.mock('../services/whatsappService', () => ({ sendOtp: jest.fn() }));

const User = require('../models/User');
const SubAccount = require('../models/SubAccount');
const PasswordResetRequest = require('../models/PasswordResetRequest');
const { logAction } = require('../services/auditService');
const { sendPasswordResetEmail } = require('../services/emailOtpMailer');
const { sendOtp } = require('../services/whatsappService');
const { startPasswordReset } = require('../services/passwordResetService');

const lean = (value) => ({ lean: () => Promise.resolve(value) });

const account = {
    _id: 'user-1',
    webUsername: 'owner@example.com',
    name: 'عميل',
    phone: '0911111111',
    role: 'user',
    otpDeliveryChannel: 'email',
    businessProfile: { email: 'owner@example.com' }
};

const savedRequest = (overrides = {}) => ({
    _id: 'req-1',
    accountId: 'user-1',
    accountType: 'user',
    accountModel: 'User',
    name: 'عميل',
    username: 'owner@example.com',
    status: 'otp_sent',
    otpPurpose: 'password_reset',
    otpCode: hashOtp('482913', 'password_reset'),
    otpExpires: new Date(Date.now() + 60 * 1000),
    otpAttempts: 0,
    createdAt: new Date(),
    save: jest.fn().mockResolvedValue({}),
    ...overrides
});

describe('email password reset', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        User.findOne.mockReturnValue(lean(null));
        SubAccount.findOne.mockReturnValue(lean(null));
        User.updateOne.mockResolvedValue({});
        PasswordResetRequest.countDocuments.mockResolvedValue(0);
        PasswordResetRequest.findOne.mockReturnValue({ sort: () => Promise.resolve(null) });
        sendPasswordResetEmail.mockResolvedValue({ success: true, provider: 'smtp', channel: 'email' });
        logAction.mockResolvedValue();
    });

    test('returns one public body when the account is missing, has no email, or the mail is sent', async () => {
        const missing = await startPasswordReset({ username: 'nobody', phone: '0910000000', req: {} });
        User.findOne.mockReturnValue(lean({ ...account, businessProfile: { email: '' } }));
        const noEmail = await startPasswordReset({ username: 'owner@example.com', phone: '0911111111', req: {} });
        User.findOne.mockReturnValue(lean(account));
        PasswordResetRequest.create.mockImplementation(async (doc) => savedRequest({ ...doc, save: jest.fn() }));
        const sent = await startPasswordReset({ username: 'owner@example.com', phone: '0911111111', req: {} });

        expect(missing.code).toBe('PASSWORD_RESET_STARTED');
        expect(missing.success).toBe(true);
        expect(noEmail.message).toBe(missing.message);
        expect(sent.message).toBe(missing.message);
        expect(noEmail.code).toBe(missing.code);
        expect(sent.code).toBe(missing.code);
        expect(missing.message).toContain('بريد مفعّل');
        expect(missing.message).not.toContain('موثّق');
        expect(missing.message).toContain('0913731533');
        expect(missing.message).toContain('support@ahrampay.com');
        expect(missing.message).toContain('\u2066');
        expect(sendPasswordResetEmail).toHaveBeenCalledTimes(1);
        expect(sendOtp).not.toHaveBeenCalled();
        const mailed = sendPasswordResetEmail.mock.calls[0][0];
        const stored = PasswordResetRequest.create.mock.calls[0][0];
        expect(stored.otpPurpose).toBe('password_reset');
        expect(stored.otpCode).toBe(hashOtp(mailed.otp, 'password_reset'));
        expect(verifyOtp(mailed.otp, stored.otpCode, 'login')).toBe(false);
        expect(verifyOtp(mailed.otp, stored.otpCode, 'password_reset')).toBe(true);
        expect(JSON.stringify(logAction.mock.calls)).not.toContain(mailed.otp);
    });

    test('does not email a well-formed address that the admin channel has not approved', async () => {
        User.findOne.mockReturnValue(lean({ ...account, otpDeliveryChannel: 'whatsapp' }));
        const body = await startPasswordReset({ username: 'owner@example.com', phone: '0911111111', req: {} });
        const missing = await startPasswordReset({ username: 'nobody', phone: '090', req: {} });
        expect(body.message).toBe(missing.message);
        expect(body.code).toBe('PASSWORD_RESET_STARTED');
        expect(sendPasswordResetEmail).not.toHaveBeenCalled();
        expect(sendOtp).not.toHaveBeenCalled();
        expect(PasswordResetRequest.create).not.toHaveBeenCalled();
        expect(JSON.stringify(logAction.mock.calls)).toContain('PASSWORD_RESET_EMAIL_NOT_APPROVED');
    });

    test('does not call WhatsApp or change the session when mail fails', async () => {
        User.findOne.mockReturnValue(lean(account));
        const request = savedRequest();
        PasswordResetRequest.create.mockResolvedValue(request);
        PasswordResetRequest.updateOne.mockResolvedValue({ matchedCount: 1 });
        sendPasswordResetEmail.mockResolvedValue({ success: false, code: 'EMAIL_OTP_SEND_FAILED' });
        const missing = await startPasswordReset({ username: 'nobody', phone: '090', req: {} });
        User.findOne.mockReturnValue(lean(account));
        const failed = await startPasswordReset({ username: 'owner@example.com', phone: '0911111111', req: {} });
        expect(failed.message).toBe(missing.message);
        expect(PasswordResetRequest.updateOne).toHaveBeenCalledWith(
            { _id: request._id, status: 'otp_sent' },
            { $set: { status: 'expired' }, $unset: { otpCode: 1 } }
        );
        expect(User.updateOne).not.toHaveBeenCalled();
        expect(sendOtp).not.toHaveBeenCalled();
        expect(JSON.stringify(logAction.mock.calls)).toContain('EMAIL_OTP_SEND_FAILED');
        expect(JSON.stringify(logAction.mock.calls)).not.toContain('482913');
    });

    test('throttles another email for the same account inside the window', async () => {
        User.findOne.mockReturnValue(lean(account));
        PasswordResetRequest.countDocuments.mockResolvedValue(5);
        const body = await startPasswordReset({ username: 'owner@example.com', phone: '0911111111', req: {} });
        expect(body.code).toBe('PASSWORD_RESET_STARTED');
        expect(sendPasswordResetEmail).not.toHaveBeenCalled();
        expect(sendOtp).not.toHaveBeenCalled();
        expect(JSON.stringify(logAction.mock.calls)).toContain('PASSWORD_RESET_RATE_LIMITED');
    });
});
