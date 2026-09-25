'use strict';

const fs = require('fs');
const path = require('path');

const read = (relativePath) => fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');

const sliceBetween = (source, start, end) => {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from + start.length);
    expect(from).toBeGreaterThanOrEqual(0);
    expect(to).toBeGreaterThan(from);
    return source.slice(from, to);
};

describe('no-email login OTP skip is wired through every portal login', () => {
    test('client, company, agency, sub-account, and unified executor login complete without OTP', () => {
        const auth = read('routes/auth.js');
        const startClientOtp = sliceBetween(auth, 'const startClientOtp', 'const continueVerifiedPortalLogin');
        expect(startClientOtp).toContain("issued.status === 'skip_no_email'");
        expect(startClientOtp).toContain('auditSkippedLoginOtp');
        expect(startClientOtp).toContain('finishLoginAfterOtpBypass');
        expect(auth).toContain('verifiedLogin: true');
        expect(sliceBetween(auth, 'const finishLoginAfterOtpBypass', 'const auditSkippedLoginOtp'))
            .toContain('loginAsClient');
        expect(sliceBetween(auth, 'const finishLoginAfterOtpBypass', 'const auditSkippedLoginOtp'))
            .toContain('loginAsExecutor');
    });

    test('admin login completes through the same path as the emergency bypass', () => {
        const auth = read('routes/auth.js');
        const startAdminOtp = sliceBetween(auth, 'const startAdminOtp', 'const continueAdminLogin');
        expect(startAdminOtp).toContain("issued.status === 'skip_no_email'");
        expect(startAdminOtp).toContain("auditSkippedLoginOtp(req, adminData, 'admin')");
        expect(startAdminOtp).toContain('return loginAsAdmin(req, res, adminData, options)');
    });

    test('executor portal login completes and enrolls the device after a skipped OTP', () => {
        const executor = read('controllers/executorAuthController.js');
        const startExecutorOtp = sliceBetween(executor, 'const startExecutorOtp', 'const continueExecutorAfterPassword');
        expect(startExecutorOtp).toContain("issued.status === 'skip_no_email'");
        expect(startExecutorOtp).toContain('buildLoginOtpSkippedAudit');
        expect(startExecutorOtp).toContain("accountType: 'executor'");
        expect(startExecutorOtp).toContain('completeExecutorLogin');
        expect(sliceBetween(executor, 'const completeExecutorLogin', 'const startExecutorOtp'))
            .toContain('verifiedLogin: true');
        expect(sliceBetween(executor, 'const completeExecutorLogin', 'const startExecutorOtp'))
            .toContain('allowFirstDevice: true');
    });

    test('audit and security center name the no-email skip so admins can filter it', () => {
        const auditView = read('views/audit_log.ejs');
        const securityCenter = read('services/securityCommandCenterService.js');
        expect(auditView).toContain('value="LOGIN_OTP_SKIPPED"');
        expect(auditView).toContain('دخول بدون رمز — لا يوجد بريد');
        expect(securityCenter).toContain("LOGIN_OTP_SKIPPED: 'دخول بدون رمز تحقق (لا يوجد بريد)'");
    });
});
