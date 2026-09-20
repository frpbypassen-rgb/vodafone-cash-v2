'use strict';

jest.mock('../models/User', () => ({ updateOne: jest.fn().mockResolvedValue({}) }));
jest.mock('../models/ClientEmployee', () => ({ updateOne: jest.fn().mockResolvedValue({}) }));
jest.mock('../models/AgentEmployee', () => ({ updateOne: jest.fn().mockResolvedValue({}) }));
jest.mock('../models/SubAccount', () => ({ updateOne: jest.fn().mockResolvedValue({}) }));
jest.mock('../models/Employee', () => ({ updateOne: jest.fn().mockResolvedValue({}) }));
jest.mock('../services/whatsappService', () => ({
    sendOtp: jest.fn()
}));

const User = require('../models/User');
const Employee = require('../models/Employee');
const { sendOtp } = require('../services/whatsappService');
const {
    getLoginOtpPortal,
    isLoginOtpRequired,
    issueLoginOtp,
    publicDeliveryMessage
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
    });

    test('covers company, agency, client, and executor portals', () => {
        expect(Object.keys({
            user: getLoginOtpPortal('user'),
            company: getLoginOtpPortal('company'),
            agent_staff: getLoginOtpPortal('agent_staff'),
            sub_client: getLoginOtpPortal('sub_client'),
            executor: getLoginOtpPortal('executor')
        }).every((key) => getLoginOtpPortal(key))).toBe(true);
        expect(getLoginOtpPortal('executor').verifyPath).toBe('/executor-portal/verify');
        expect(getLoginOtpPortal('company').verifyPath).toBe('/client/verify');
        expect(getLoginOtpPortal('agent_staff').sessionTempIdKey).toBe('tempClientId');
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
            accountType: 'الشركة'
        }));
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
    });
});
