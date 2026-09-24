'use strict';

jest.mock('../models/User', () => ({ updateOne: jest.fn().mockResolvedValue({}) }));
jest.mock('../models/ClientEmployee', () => ({ updateOne: jest.fn().mockResolvedValue({}) }));
jest.mock('../models/AgentEmployee', () => ({ updateOne: jest.fn().mockResolvedValue({}) }));
jest.mock('../models/SubAccount', () => ({ updateOne: jest.fn().mockResolvedValue({}) }));
jest.mock('../models/Employee', () => ({ updateOne: jest.fn().mockResolvedValue({}) }));
jest.mock('../models/Admin', () => ({ updateOne: jest.fn().mockResolvedValue({}) }));
jest.mock('../services/whatsappService', () => ({
    sendOtp: jest.fn()
}));
jest.mock('../services/emailOtpMailer', () => ({
    sendLoginOtpEmail: jest.fn()
}));

const User = require('../models/User');
const Employee = require('../models/Employee');
const Admin = require('../models/Admin');
const { sendOtp } = require('../services/whatsappService');
const { sendLoginOtpEmail } = require('../services/emailOtpMailer');
const {
    getLoginOtpPortal,
    isLoginOtpRequired,
    issueLoginOtp,
    publicDeliveryMessage,
    selectLoginOtpChannel
} = require('../services/loginOtpService');

const productionOtpEnv = {
    NODE_ENV: 'production',
    PASSWORD_ONLY_LOGIN_MODE: 'false',
    SECURITY_VERIFICATION_ENFORCEMENT_ENABLED: 'true',
    SECURITY_VERIFICATION_MODE: 'required',
    FORCE_CLIENT_OTP: 'true'
};

describe('login OTP service', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        sendOtp.mockResolvedValue({ success: true, provider: 'whatchimp', messageId: 'wamid-1' });
        sendLoginOtpEmail.mockResolvedValue({ success: true, provider: 'smtp', channel: 'email', messageId: 'mail-1' });
    });

    test('covers company, agency, client, executor, and admin portals', () => {
        expect(Object.keys({
            user: getLoginOtpPortal('user'),
            company: getLoginOtpPortal('company'),
            agent_staff: getLoginOtpPortal('agent_staff'),
            sub_client: getLoginOtpPortal('sub_client'),
            executor: getLoginOtpPortal('executor'),
            admin: getLoginOtpPortal('admin')
        }).every((key) => getLoginOtpPortal(key))).toBe(true);
        expect(getLoginOtpPortal('executor').verifyPath).toBe('/executor-portal/verify');
        expect(getLoginOtpPortal('company').verifyPath).toBe('/client/verify');
        expect(getLoginOtpPortal('agent_staff').sessionTempIdKey).toBe('tempClientId');
        expect(getLoginOtpPortal('admin').verifyPath).toBe('/admin/verify');
        expect(getLoginOtpPortal('admin').sessionTempIdKey).toBe('tempAdminId');
        expect(getLoginOtpPortal('admin').label).toBe('الإدارة');
    });

    test('requires WhatsApp OTP in production unless the emergency window is active', () => {
        expect(isLoginOtpRequired(productionOtpEnv)).toBe(true);
        expect(isLoginOtpRequired({
            ...productionOtpEnv,
            EMERGENCY_CLIENT_OTP_BYPASS: 'true',
            EMERGENCY_CLIENT_OTP_BYPASS_EXPIRES_AT: '2026-09-21T12:00:00Z',
            EMERGENCY_CLIENT_OTP_BYPASS_REASON: 'WhatChimp outage'
        }, Date.parse('2026-09-20T12:00:00Z'))).toBe(false);
        expect(isLoginOtpRequired({
            ...productionOtpEnv,
            EMERGENCY_CLIENT_OTP_BYPASS: 'true',
            EMERGENCY_CLIENT_OTP_BYPASS_EXPIRES_AT: '2026-09-20T12:00:00Z',
            EMERGENCY_CLIENT_OTP_BYPASS_REASON: 'WhatChimp outage'
        }, Date.parse('2026-09-20T12:00:01Z'))).toBe(true);
    });

    test('issues a hashed OTP for a company and redirects to the client verify page', async () => {
        const account = { _id: 'company-1', phone: '0912345678', name: 'شركة الأهرام' };
        const result = await issueLoginOtp({ account, accountType: 'company', session: {} });
        expect(result.status).toBe('sent');
        expect(result.portal.verifyPath).toBe('/client/verify');
        expect(User.updateOne).not.toHaveBeenCalled();
        expect(require('../models/ClientEmployee').updateOne).toHaveBeenCalled();
        expect(sendOtp).toHaveBeenCalledWith(expect.objectContaining({
            phone: '0912345678',
            accountType: 'الشركة',
            expiresMinutes: 5,
            accountName: 'شركة الأهرام'
        }));
        expect(sendOtp.mock.calls[0][0]).not.toHaveProperty('expiresAt');
        expect(sendOtp.mock.calls[0][0]).not.toHaveProperty('html');
    });

    test('issues executor OTP to the executor verify page', async () => {
        const result = await issueLoginOtp({
            account: { _id: 'exec-1', phone: '0922222222', name: 'منفذ' },
            accountType: 'executor',
            session: {}
        });
        expect(result.status).toBe('sent');
        expect(result.portal.verifyPath).toBe('/executor-portal/verify');
        expect(Employee.updateOne).toHaveBeenCalled();
    });

    test('returns a clear failure when WhatsApp delivery fails and emergency bypass is off', async () => {
        sendOtp.mockResolvedValue({ success: false, code: 'WHATCHIMP_TIMEOUT', provider: 'whatchimp' });
        const result = await issueLoginOtp({
            account: { _id: 'user-1', phone: '0911111111', name: 'عميل' },
            accountType: 'user',
            session: {}
        });
        expect(result.status).toBe('failed');
        expect(result.message).toContain('WHATCHIMP_TIMEOUT');
        expect(User.updateOne).toHaveBeenCalledWith(
            { _id: 'user-1' },
            { $unset: expect.objectContaining({ otpCode: 1 }) },
            { strict: false }
        );
    });

    test('emergency bypass covers executor delivery failure, not only retail clients', async () => {
        const previous = {
            NODE_ENV: process.env.NODE_ENV,
            PASSWORD_ONLY: process.env.PASSWORD_ONLY_LOGIN_MODE,
            ENFORCE: process.env.SECURITY_VERIFICATION_ENFORCEMENT_ENABLED,
            MODE: process.env.SECURITY_VERIFICATION_MODE,
            FORCE: process.env.FORCE_CLIENT_OTP,
            BYPASS: process.env.EMERGENCY_CLIENT_OTP_BYPASS,
            EXPIRES: process.env.EMERGENCY_CLIENT_OTP_BYPASS_EXPIRES_AT,
            REASON: process.env.EMERGENCY_CLIENT_OTP_BYPASS_REASON
        };
        process.env.NODE_ENV = 'production';
        process.env.PASSWORD_ONLY_LOGIN_MODE = 'false';
        process.env.SECURITY_VERIFICATION_ENFORCEMENT_ENABLED = 'true';
        process.env.SECURITY_VERIFICATION_MODE = 'required';
        process.env.FORCE_CLIENT_OTP = 'true';
        process.env.EMERGENCY_CLIENT_OTP_BYPASS = 'true';
        process.env.EMERGENCY_CLIENT_OTP_BYPASS_EXPIRES_AT = new Date(Date.now() + 60 * 60 * 1000).toISOString();
        process.env.EMERGENCY_CLIENT_OTP_BYPASS_REASON = 'WhatChimp outage';
        sendOtp.mockResolvedValue({ success: false, code: 'WHATCHIMP_REQUEST_FAILED', provider: 'whatchimp' });

        try {
            const result = await issueLoginOtp({
                account: { _id: 'exec-2', phone: '0933333333', name: 'منفذ' },
                accountType: 'executor',
                session: {}
            });
            expect(result.status).toBe('emergency_bypass');
            expect(result.portal.accountType).toBe('executor');
        } finally {
            process.env.NODE_ENV = previous.NODE_ENV;
            process.env.PASSWORD_ONLY_LOGIN_MODE = previous.PASSWORD_ONLY;
            process.env.SECURITY_VERIFICATION_ENFORCEMENT_ENABLED = previous.ENFORCE;
            process.env.SECURITY_VERIFICATION_MODE = previous.MODE;
            process.env.FORCE_CLIENT_OTP = previous.FORCE;
            if (previous.BYPASS === undefined) delete process.env.EMERGENCY_CLIENT_OTP_BYPASS;
            else process.env.EMERGENCY_CLIENT_OTP_BYPASS = previous.BYPASS;
            if (previous.EXPIRES === undefined) delete process.env.EMERGENCY_CLIENT_OTP_BYPASS_EXPIRES_AT;
            else process.env.EMERGENCY_CLIENT_OTP_BYPASS_EXPIRES_AT = previous.EXPIRES;
            if (previous.REASON === undefined) delete process.env.EMERGENCY_CLIENT_OTP_BYPASS_REASON;
            else process.env.EMERGENCY_CLIENT_OTP_BYPASS_REASON = previous.REASON;
        }
    });

    test('explains a missing WhatsApp phone without leaking an OTP', () => {
        expect(publicDeliveryMessage('WHATSAPP_PHONE_REQUIRED')).toContain('لا يوجد رقم واتساب');
        expect(publicDeliveryMessage('WHATSAPP_PHONE_REQUIRED')).not.toMatch(/\d{6}/);
        expect(publicDeliveryMessage('SMTP_CONFIG_MISSING')).toContain('إعداد البريد');
        expect(publicDeliveryMessage('EMAIL_OTP_ADDRESS_INVALID')).toContain('البريد الإلكتروني');
        expect(publicDeliveryMessage('SMTP_CONFIG_MISSING')).not.toMatch(/\d{6}/);
    });

    test('sends admin login OTP by email when the account has a valid address', async () => {
        const account = {
            _id: 'admin-mail',
            name: 'مدير النظام',
            webUsername: 'master.admin',
            email: 'Admin@Example.com',
            otpDeliveryChannel: 'email'
        };
        const result = await issueLoginOtp({ account, accountType: 'admin', session: {} });
        expect(result.status).toBe('sent');
        expect(result.portal.verifyPath).toBe('/admin/verify');
        expect(result.delivery.channel).toBe('email');
        expect(sendLoginOtpEmail).toHaveBeenCalledWith(expect.objectContaining({
            to: 'admin@example.com',
            accountName: 'مدير النظام'
        }));
        expect(sendOtp).not.toHaveBeenCalled();
        expect(Admin.updateOne).toHaveBeenCalled();
    });

    test('keeps WhatsApp for an admin account that has no email yet', async () => {
        const result = await issueLoginOtp({
            account: {
                _id: 'admin-legacy',
                name: 'مدير قديم',
                webUsername: 'legacy.admin',
                phone: '0910000000'
            },
            accountType: 'admin',
            session: {}
        });
        expect(result.status).toBe('sent');
        expect(result.delivery.channel).toBe('whatsapp');
        expect(sendOtp).toHaveBeenCalledWith(expect.objectContaining({
            phone: '0910000000',
            accountType: 'الإدارة'
        }));
        expect(sendLoginOtpEmail).not.toHaveBeenCalled();
    });

    test('sends email OTP when a valid address is stored even if the saved flag is WhatsApp', async () => {
        const account = {
            _id: 'user-mail',
            phone: '0912345678',
            name: 'عميل',
            email: 'owner@example.com',
            businessProfile: { email: 'owner@example.com' },
            otpDeliveryChannel: 'whatsapp'
        };
        expect(selectLoginOtpChannel(account)).toEqual({ channel: 'email', email: 'owner@example.com' });
        const result = await issueLoginOtp({ account, accountType: 'user', session: {} });
        expect(result.status).toBe('sent');
        expect(result.delivery.channel).toBe('email');
        expect(sendLoginOtpEmail).toHaveBeenCalledWith(expect.objectContaining({ to: 'owner@example.com' }));
        expect(sendOtp).not.toHaveBeenCalled();
    });

    test('sends login OTP by email when the account flag and address are valid', async () => {
        const account = {
            _id: 'company-mail',
            phone: '0912345678',
            name: 'موظف الشركة',
            email: 'staff@example.com',
            otpDeliveryChannel: 'email'
        };
        const result = await issueLoginOtp({ account, accountType: 'company', session: {} });
        expect(result.status).toBe('sent');
        expect(result.delivery.provider).toBe('smtp');
        expect(sendOtp).not.toHaveBeenCalled();
        expect(sendLoginOtpEmail).toHaveBeenCalledWith(expect.objectContaining({
            to: 'staff@example.com',
            accountName: 'موظف الشركة',
            expiresMinutes: 5,
            expiresAt: expect.any(Date)
        }));
        const sentOtp = sendLoginOtpEmail.mock.calls[0][0].otp;
        const storedUpdate = require('../models/ClientEmployee').updateOne.mock.calls[0][1];
        expect(storedUpdate.$set.otpExpires).toBe(sendLoginOtpEmail.mock.calls[0][0].expiresAt);
        expect(sentOtp).toMatch(/^\d{6}$/);
        expect(JSON.stringify(result)).not.toContain(sentOtp);
        expect(require('../models/ClientEmployee').updateOne).toHaveBeenCalledTimes(1);
    });

    test('uses the commercial profile email for a client user on the email channel', async () => {
        const account = {
            _id: 'user-profile-mail',
            phone: '0944444444',
            name: 'عميل البريد',
            businessProfile: { email: 'Owner@Example.com' },
            otpDeliveryChannel: 'email'
        };
        expect(selectLoginOtpChannel(account)).toEqual({ channel: 'email', email: 'owner@example.com' });
        const result = await issueLoginOtp({ account, accountType: 'user', session: {} });
        expect(result.status).toBe('sent');
        expect(sendLoginOtpEmail).toHaveBeenCalledWith(expect.objectContaining({ to: 'owner@example.com' }));
        expect(sendOtp).not.toHaveBeenCalled();
    });

    test('does not fall back to WhatsApp when email OTP is enabled but the address is invalid', async () => {
        const result = await issueLoginOtp({
            account: {
                _id: 'user-bad-mail',
                phone: '0911111111',
                name: 'عميل',
                businessProfile: { email: 'not-an-email' },
                otpDeliveryChannel: 'email'
            },
            accountType: 'user',
            session: {}
        });
        expect(result.status).toBe('failed');
        expect(result.code).toBe('EMAIL_OTP_ADDRESS_INVALID');
        expect(result.message).toContain('البريد الإلكتروني');
        expect(sendOtp).not.toHaveBeenCalled();
        expect(sendLoginOtpEmail).not.toHaveBeenCalled();
    });

    test('reports missing SMTP config and still allows the emergency bypass', async () => {
        sendLoginOtpEmail.mockResolvedValue({ success: false, provider: 'smtp', channel: 'email', code: 'SMTP_CONFIG_MISSING' });
        const failed = await issueLoginOtp({
            account: {
                _id: 'exec-mail',
                phone: '0922222222',
                name: 'منفذ',
                email: 'executor@example.com',
                otpDeliveryChannel: 'email'
            },
            accountType: 'executor',
            session: {}
        });
        expect(failed.status).toBe('failed');
        expect(failed.code).toBe('SMTP_CONFIG_MISSING');
        expect(failed.message).toContain('SMTP_CONFIG_MISSING');
        expect(sendOtp).not.toHaveBeenCalled();

        const previous = {
            BYPASS: process.env.EMERGENCY_CLIENT_OTP_BYPASS,
            EXPIRES: process.env.EMERGENCY_CLIENT_OTP_BYPASS_EXPIRES_AT,
            REASON: process.env.EMERGENCY_CLIENT_OTP_BYPASS_REASON
        };
        process.env.EMERGENCY_CLIENT_OTP_BYPASS = 'true';
        process.env.EMERGENCY_CLIENT_OTP_BYPASS_EXPIRES_AT = new Date(Date.now() + 60 * 60 * 1000).toISOString();
        process.env.EMERGENCY_CLIENT_OTP_BYPASS_REASON = 'SMTP outage';
        try {
            const bypassed = await issueLoginOtp({
                account: {
                    _id: 'exec-mail-2',
                    phone: '0922222222',
                    name: 'منفذ',
                    email: 'executor@example.com',
                    otpDeliveryChannel: 'email'
                },
                accountType: 'executor',
                session: {}
            });
            expect(bypassed.status).toBe('emergency_bypass');
            expect(bypassed.code).toBe('SMTP_CONFIG_MISSING');
            expect(sendOtp).not.toHaveBeenCalled();
        } finally {
            if (previous.BYPASS === undefined) delete process.env.EMERGENCY_CLIENT_OTP_BYPASS;
            else process.env.EMERGENCY_CLIENT_OTP_BYPASS = previous.BYPASS;
            if (previous.EXPIRES === undefined) delete process.env.EMERGENCY_CLIENT_OTP_BYPASS_EXPIRES_AT;
            else process.env.EMERGENCY_CLIENT_OTP_BYPASS_EXPIRES_AT = previous.EXPIRES;
            if (previous.REASON === undefined) delete process.env.EMERGENCY_CLIENT_OTP_BYPASS_REASON;
            else process.env.EMERGENCY_CLIENT_OTP_BYPASS_REASON = previous.REASON;
        }
    });
});
