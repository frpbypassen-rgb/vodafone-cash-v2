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
const fs = require('fs');
const path = require('path');
const {
    buildLoginOtpSkippedAudit,
    getLoginOtpPortal,
    isLoginOtpRequired,
    issueLoginOtp,
    publicDeliveryMessage,
    readLoginOtpAttempt,
    selectLoginOtpChannel,
    shouldSkipLoginOtpWithoutEmail
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
        delete process.env.LOGIN_OTP_SKIP_WITHOUT_EMAIL;
        delete process.env.WHATSAPP_OTP_ENABLED;
        delete process.env.OTP_DELIVERY_CHANNEL;
        delete process.env.EMAIL_OTP_ENABLED;
        delete process.env.WHATSAPP_LOGIN_OTP_ENABLED;
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
        const account = {
            _id: 'company-1',
            phone: '0912345678',
            name: 'شركة الأهرام',
            email: 'company@example.com'
        };
        const result = await issueLoginOtp({ account, accountType: 'company', session: {} });
        expect(result.status).toBe('sent');
        expect(result.portal.verifyPath).toBe('/client/verify');
        expect(result.delivery.channel).toBe('email');
        expect(User.updateOne).not.toHaveBeenCalled();
        expect(require('../models/ClientEmployee').updateOne).toHaveBeenCalled();
        expect(sendLoginOtpEmail).toHaveBeenCalledWith(expect.objectContaining({
            to: 'company@example.com',
            accountName: 'شركة الأهرام',
            expiresMinutes: 5
        }));
        expect(sendOtp).not.toHaveBeenCalled();
        const sentOtp = sendLoginOtpEmail.mock.calls[0][0].otp;
        expect(JSON.stringify(result)).not.toContain(sentOtp);
    });

    test('issues executor OTP to the executor verify page', async () => {
        const result = await issueLoginOtp({
            account: {
                _id: 'exec-1',
                phone: '0922222222',
                name: 'منفذ',
                email: 'executor@example.com'
            },
            accountType: 'executor',
            session: {}
        });
        expect(result.status).toBe('sent');
        expect(result.delivery.channel).toBe('email');
        expect(result.portal.verifyPath).toBe('/executor-portal/verify');
        expect(Employee.updateOne).toHaveBeenCalled();
        expect(sendOtp).not.toHaveBeenCalled();
    });

    test('returns a clear failure when WhatsApp delivery fails and emergency bypass is off', async () => {
        process.env.WHATSAPP_OTP_ENABLED = 'true';
        process.env.WHATSAPP_LOGIN_OTP_ENABLED = 'true';
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

        try {
            const result = await issueLoginOtp({
                account: { _id: 'exec-2', phone: '0933333333', name: 'منفذ' },
                accountType: 'executor',
                session: {}
            });
            expect(result.status).toBe('emergency_bypass');
            expect(result.code).toBe('WHATSAPP_OTP_DISABLED');
            expect(result.portal.accountType).toBe('executor');
            expect(sendOtp).not.toHaveBeenCalled();
            expect(JSON.stringify(result)).not.toMatch(/\d{6}/);
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
        expect(publicDeliveryMessage('WHATSAPP_LOGIN_OTP_DISABLED')).toContain('واتساب متوقف مؤقتاً');
        expect(publicDeliveryMessage('WHATSAPP_LOGIN_OTP_DISABLED')).toContain('بريداً إلكترونياً');
        expect(publicDeliveryMessage('WHATSAPP_LOGIN_OTP_DISABLED')).toContain('الإدارة');
        expect(publicDeliveryMessage('WHATSAPP_OTP_DISABLED')).toContain('واتساب متوقف');
        expect(publicDeliveryMessage('EMAIL_OTP_DISABLED')).toContain('البريد متوقف');
        expect(publicDeliveryMessage('WHATSAPP_OTP_DISABLED')).not.toMatch(/\d{6}/);
        expect(publicDeliveryMessage('EMAIL_OTP_DISABLED')).not.toMatch(/\d{6}/);
        expect(publicDeliveryMessage('SMTP_CONFIG_MISSING')).not.toMatch(/\d{6}/);
    });

    test('reads the login attempt from the request and forwards it to email OTP', async () => {
        const attemptAt = new Date('2026-09-22T12:22:00.000Z');
        const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
        const fromRequest = readLoginOtpAttempt({
            get: (header) => (header === 'user-agent' ? userAgent : ''),
            body: { username: ' tizari@ahram.com ' }
        });
        expect(fromRequest.userAgent).toBe(userAgent);
        expect(fromRequest.loginAccount).toBe('tizari@ahram.com');
        expect(fromRequest.at).toBeInstanceOf(Date);

        const account = {
            _id: 'user-mail',
            name: 'عميل تجريبي',
            email: 'owner@example.com',
            otpDeliveryChannel: 'email'
        };
        const result = await issueLoginOtp({
            account,
            accountType: 'user',
            session: {},
            attempt: {
                at: attemptAt,
                userAgent,
                loginAccount: 'tizari@ahram.com'
            }
        });
        expect(result.status).toBe('sent');
        expect(sendLoginOtpEmail).toHaveBeenCalledWith(expect.objectContaining({
            to: 'owner@example.com',
            accountName: 'عميل تجريبي',
            attemptAt,
            userAgent,
            loginAccount: 'tizari@ahram.com'
        }));
        expect(sendOtp).not.toHaveBeenCalled();

        const auth = fs.readFileSync(path.join(__dirname, '../routes/auth.js'), 'utf8');
        const executor = fs.readFileSync(path.join(__dirname, '../controllers/executorAuthController.js'), 'utf8');
        expect(auth.match(/attempt: readLoginOtpAttempt\(req\)/g)).toHaveLength(2);
        expect(executor).toContain('attempt: readLoginOtpAttempt(req)');
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

    test('does not send WhatsApp OTP for an admin account that has no email', async () => {
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
        expect(result.status).toBe('failed');
        expect(result.code).toBe('WHATSAPP_OTP_DISABLED');
        expect(result.message).not.toMatch(/\d{6}/);
        expect(sendOtp).not.toHaveBeenCalled();
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

    test('still emails a valid address when WhatsApp login OTP is disabled', async () => {
        const previous = process.env.WHATSAPP_LOGIN_OTP_ENABLED;
        process.env.WHATSAPP_LOGIN_OTP_ENABLED = 'false';
        try {
            const account = {
                _id: 'user-mail-killswitch',
                phone: '0912345678',
                name: 'عميل البريد',
                email: 'owner@example.com'
            };
            expect(selectLoginOtpChannel(account)).toEqual({ channel: 'email', email: 'owner@example.com' });
            const result = await issueLoginOtp({ account, accountType: 'user', session: {} });
            expect(result.status).toBe('sent');
            expect(result.delivery.channel).toBe('email');
            expect(sendLoginOtpEmail).toHaveBeenCalledWith(expect.objectContaining({ to: 'owner@example.com' }));
            expect(sendOtp).not.toHaveBeenCalled();
        } finally {
            if (previous === undefined) delete process.env.WHATSAPP_LOGIN_OTP_ENABLED;
            else process.env.WHATSAPP_LOGIN_OTP_ENABLED = previous;
        }
    });

    test('does not send WhatsApp login OTP when the flag is explicitly off and no email exists', async () => {
        const previous = process.env.WHATSAPP_LOGIN_OTP_ENABLED;
        process.env.WHATSAPP_LOGIN_OTP_ENABLED = 'off';
        try {
            const result = await issueLoginOtp({
                account: { _id: 'user-no-mail', phone: '0911111111', name: 'عميل قديم' },
                accountType: 'user',
                session: {}
            });
            expect(result.status).toBe('failed');
            expect(result.code).toBe('WHATSAPP_LOGIN_OTP_DISABLED');
            expect(result.message).toContain('واتساب متوقف مؤقتاً');
            expect(result.message).not.toMatch(/مزوّد|WhatChimp|WHATCHIMP/i);
            expect(sendOtp).not.toHaveBeenCalled();
            expect(sendLoginOtpEmail).not.toHaveBeenCalled();
            expect(User.updateOne).toHaveBeenCalledWith(
                { _id: 'user-no-mail' },
                { $unset: expect.objectContaining({ otpCode: 1 }) },
                { strict: false }
            );
        } finally {
            if (previous === undefined) delete process.env.WHATSAPP_LOGIN_OTP_ENABLED;
            else process.env.WHATSAPP_LOGIN_OTP_ENABLED = previous;
        }
    });

    test('does not send WhatsApp login OTP when the OTP flag is unset, even if the older flag is on', async () => {
        delete process.env.WHATSAPP_LOGIN_OTP_ENABLED;
        delete process.env.WHATSAPP_OTP_ENABLED;
        const unset = await issueLoginOtp({
            account: { _id: 'user-wa-default', phone: '0910000001', name: 'عميل' },
            accountType: 'user',
            session: {}
        });
        expect(selectLoginOtpChannel({ phone: '0910000001' })).toEqual({
            channel: 'whatsapp',
            code: 'WHATSAPP_OTP_DISABLED'
        });
        expect(unset.status).toBe('failed');
        expect(unset.code).toBe('WHATSAPP_OTP_DISABLED');
        expect(sendOtp).not.toHaveBeenCalled();

        process.env.WHATSAPP_LOGIN_OTP_ENABLED = 'yes';
        process.env.WHATSAPP_OTP_ENABLED = 'true';
        const enabled = await issueLoginOtp({
            account: { _id: 'user-wa-on', phone: '0910000002', name: 'عميل' },
            accountType: 'user',
            session: {}
        });
        expect(enabled.status).toBe('sent');
        expect(enabled.delivery.channel).toBe('whatsapp');
        expect(sendOtp).toHaveBeenCalledWith(expect.objectContaining({ phone: '0910000002' }));
        const sentOtp = sendOtp.mock.calls[0][0].otp;
        expect(JSON.stringify(enabled)).not.toContain(sentOtp);
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

    test('still sends email OTP when skip-without-email is on and the account has a valid address', async () => {
        process.env.LOGIN_OTP_SKIP_WITHOUT_EMAIL = 'true';
        process.env.WHATSAPP_LOGIN_OTP_ENABLED = 'false';
        const account = {
            _id: 'user-mail-skip-flag',
            phone: '0912345678',
            name: 'عميل البريد',
            businessProfile: { email: 'Owner@Example.com' },
            otpDeliveryChannel: 'whatsapp'
        };
        const result = await issueLoginOtp({ account, accountType: 'user', session: {} });
        expect(shouldSkipLoginOtpWithoutEmail(account)).toBe(false);
        expect(result.status).toBe('sent');
        expect(result.delivery.channel).toBe('email');
        expect(sendLoginOtpEmail).toHaveBeenCalledWith(expect.objectContaining({ to: 'owner@example.com' }));
        expect(sendOtp).not.toHaveBeenCalled();
        delete process.env.WHATSAPP_LOGIN_OTP_ENABLED;
    });

    test('logs in without OTP for every portal when the account has no usable email and the flag is on', async () => {
        process.env.LOGIN_OTP_SKIP_WITHOUT_EMAIL = 'true';
        process.env.WHATSAPP_LOGIN_OTP_ENABLED = 'false';
        const portals = [
            ['user', require('../models/User'), 'User'],
            ['company', require('../models/ClientEmployee'), 'ClientEmployee'],
            ['agent_staff', require('../models/AgentEmployee'), 'AgentEmployee'],
            ['sub_client', require('../models/SubAccount'), 'SubAccount'],
            ['executor', require('../models/Employee'), 'Employee'],
            ['admin', require('../models/Admin'), 'Admin']
        ];
        for (const [accountType, Model, performedByModel] of portals) {
            const account = {
                _id: `${accountType}-no-mail`,
                phone: '0911111111',
                name: 'حساب بلا بريد',
                email: '   ',
                businessProfile: { email: 'not-an-email' }
            };
            const result = await issueLoginOtp({
                account,
                accountType,
                session: {
                    tempClientId: account._id,
                    tempAccountType: accountType,
                    otpChallengeId: 'pending-challenge',
                    [getLoginOtpPortal(accountType).sessionTempIdKey]: account._id
                }
            });
            expect(result.status).toBe('skip_no_email');
            expect(result.reason).toBe('no_email');
            expect(result.portal.accountType).toBe(accountType);
            expect(buildLoginOtpSkippedAudit({ account, accountType })).toEqual({
                action: 'LOGIN_OTP_SKIPPED',
                performedById: account._id,
                performedByModel,
                performedByName: 'حساب بلا بريد',
                success: true,
                severity: 'warning',
                metadata: {
                    accountId: account._id,
                    portal: accountType,
                    reason: 'no_email'
                }
            });
            expect(Model.updateOne).toHaveBeenCalledWith(
                { _id: account._id },
                { $unset: expect.objectContaining({ otpCode: 1, otpChallengeId: 1 }) },
                { strict: false }
            );
            expect(Model.updateOne.mock.calls.some((call) => call[1] && call[1].$set)).toBe(false);
        }
        expect(sendOtp).not.toHaveBeenCalled();
        expect(sendLoginOtpEmail).not.toHaveBeenCalled();
        expect(isLoginOtpRequired(productionOtpEnv)).toBe(true);
        delete process.env.WHATSAPP_LOGIN_OTP_ENABLED;
    });

    test('keeps the current no-email failure when skip-without-email is off', async () => {
        process.env.LOGIN_OTP_SKIP_WITHOUT_EMAIL = 'false';
        process.env.WHATSAPP_LOGIN_OTP_ENABLED = 'false';
        const result = await issueLoginOtp({
            account: { _id: 'user-locked', phone: '0911111111', name: 'عميل قديم' },
            accountType: 'user',
            session: {}
        });
        expect(shouldSkipLoginOtpWithoutEmail({ phone: '0911111111' })).toBe(false);
        expect(result.status).toBe('failed');
        expect(result.code).toBe('WHATSAPP_LOGIN_OTP_DISABLED');
        expect(sendOtp).not.toHaveBeenCalled();
        expect(sendLoginOtpEmail).not.toHaveBeenCalled();
        delete process.env.WHATSAPP_LOGIN_OTP_ENABLED;
    });

    test('does not skip OTP when an account has an email and delivery fails', async () => {
        process.env.LOGIN_OTP_SKIP_WITHOUT_EMAIL = 'true';
        sendLoginOtpEmail.mockResolvedValue({
            success: false,
            provider: 'smtp',
            channel: 'email',
            code: 'EMAIL_OTP_SEND_FAILED'
        });
        const invalid = await issueLoginOtp({
            account: {
                _id: 'user-explicit-bad',
                phone: '0911111111',
                name: 'عميل',
                otpDeliveryChannel: 'email',
                email: 'not-an-email'
            },
            accountType: 'company',
            session: {}
        });
        expect(invalid.status).toBe('failed');
        expect(invalid.code).toBe('EMAIL_OTP_ADDRESS_INVALID');
        expect(invalid.status).not.toBe('skip_no_email');

        const failedSend = await issueLoginOtp({
            account: {
                _id: 'user-smtp-fail',
                phone: '0911111111',
                name: 'عميل',
                email: 'owner@example.com'
            },
            accountType: 'user',
            session: {}
        });
        expect(failedSend.status).toBe('failed');
        expect(failedSend.code).toBe('EMAIL_OTP_SEND_FAILED');
        expect(failedSend.status).not.toBe('sent');
        expect(failedSend.status).not.toBe('skip_no_email');
        expect(failedSend.message).toBe(publicDeliveryMessage('EMAIL_OTP_SEND_FAILED'));
        expect(failedSend.message).not.toContain('owner@example.com');
        expect(failedSend.message).not.toContain('0911111111');
        expect(sendOtp).not.toHaveBeenCalled();
        expect(sendLoginOtpEmail).toHaveBeenCalledTimes(1);
        const cleared = User.updateOne.mock.calls.some((call) => call[1] && call[1].$unset && call[1].$unset.otpCode === 1);
        expect(cleared).toBe(true);
    });

    test('the new email template flag does not change WhatsApp or skip-without-email', async () => {
        const previous = {
            template: process.env.LOGIN_OTP_EMAIL_TEMPLATE_V2,
            whatsapp: process.env.WHATSAPP_LOGIN_OTP_ENABLED,
            skip: process.env.LOGIN_OTP_SKIP_WITHOUT_EMAIL
        };
        process.env.LOGIN_OTP_EMAIL_TEMPLATE_V2 = 'true';
        process.env.WHATSAPP_LOGIN_OTP_ENABLED = 'true';
        process.env.WHATSAPP_OTP_ENABLED = 'true';
        process.env.LOGIN_OTP_SKIP_WITHOUT_EMAIL = 'false';
        try {
            const whatsapp = await issueLoginOtp({
                account: { _id: 'user-flag', phone: '0910000099', name: 'عميل' },
                accountType: 'user',
                session: {}
            });
            expect(whatsapp.status).toBe('sent');
            expect(whatsapp.delivery.channel).toBe('whatsapp');
            expect(sendLoginOtpEmail).not.toHaveBeenCalled();
            expect(sendOtp).toHaveBeenCalledWith(expect.objectContaining({ phone: '0910000099' }));

            process.env.LOGIN_OTP_SKIP_WITHOUT_EMAIL = 'true';
            process.env.WHATSAPP_LOGIN_OTP_ENABLED = 'false';
            sendOtp.mockClear();
            const skipped = await issueLoginOtp({
                account: { _id: 'user-flag-skip', phone: '0910000098', name: 'عميل' },
                accountType: 'user',
                session: {}
            });
            expect(skipped.status).toBe('skip_no_email');
            expect(sendOtp).not.toHaveBeenCalled();
            expect(sendLoginOtpEmail).not.toHaveBeenCalled();
        } finally {
            if (previous.template === undefined) delete process.env.LOGIN_OTP_EMAIL_TEMPLATE_V2;
            else process.env.LOGIN_OTP_EMAIL_TEMPLATE_V2 = previous.template;
            if (previous.whatsapp === undefined) delete process.env.WHATSAPP_LOGIN_OTP_ENABLED;
            else process.env.WHATSAPP_LOGIN_OTP_ENABLED = previous.whatsapp;
            if (previous.skip === undefined) delete process.env.LOGIN_OTP_SKIP_WITHOUT_EMAIL;
            else process.env.LOGIN_OTP_SKIP_WITHOUT_EMAIL = previous.skip;
            delete process.env.WHATSAPP_OTP_ENABLED;
        }
    });

    test('uses email directly when OTP_DELIVERY_CHANNEL is email, even if WhatsApp flags are on', async () => {
        process.env.OTP_DELIVERY_CHANNEL = 'email';
        process.env.EMAIL_OTP_ENABLED = 'true';
        process.env.WHATSAPP_OTP_ENABLED = 'true';
        process.env.WHATSAPP_LOGIN_OTP_ENABLED = 'true';
        const result = await issueLoginOtp({
            account: {
                _id: 'user-channel-email',
                phone: '0912345678',
                name: 'عميل',
                email: 'owner@example.com'
            },
            accountType: 'user',
            session: {}
        });
        expect(result.status).toBe('sent');
        expect(result.delivery.channel).toBe('email');
        expect(sendLoginOtpEmail).toHaveBeenCalledWith(expect.objectContaining({ to: 'owner@example.com' }));
        expect(sendOtp).not.toHaveBeenCalled();
    });

    test('does not fall back to WhatsApp when email OTP is disabled or the email send fails', async () => {
        process.env.EMAIL_OTP_ENABLED = 'false';
        process.env.WHATSAPP_OTP_ENABLED = 'true';
        process.env.WHATSAPP_LOGIN_OTP_ENABLED = 'true';
        process.env.OTP_DELIVERY_CHANNEL = 'whatsapp';
        const disabled = await issueLoginOtp({
            account: {
                _id: 'user-email-off',
                phone: '0912345678',
                name: 'عميل',
                email: 'owner@example.com'
            },
            accountType: 'user',
            session: {}
        });
        expect(disabled.status).toBe('failed');
        expect(disabled.code).toBe('EMAIL_OTP_DISABLED');
        expect(disabled.message).not.toMatch(/\d{6}/);
        expect(sendOtp).not.toHaveBeenCalled();
        expect(sendLoginOtpEmail).not.toHaveBeenCalled();

        process.env.EMAIL_OTP_ENABLED = 'true';
        sendLoginOtpEmail.mockResolvedValue({
            success: false,
            provider: 'smtp',
            channel: 'email',
            code: 'EMAIL_OTP_SEND_FAILED'
        });
        const failed = await issueLoginOtp({
            account: {
                _id: 'user-email-fail-no-wa',
                phone: '0912345678',
                name: 'عميل',
                email: 'owner@example.com'
            },
            accountType: 'user',
            session: {}
        });
        expect(failed.status).toBe('failed');
        expect(failed.code).toBe('EMAIL_OTP_SEND_FAILED');
        expect(sendOtp).not.toHaveBeenCalled();
        expect(sendLoginOtpEmail).toHaveBeenCalledTimes(1);
    });
});
