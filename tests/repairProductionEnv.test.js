'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const dotenv = require('dotenv');

const scriptPath = path.resolve(__dirname, '..', 'scripts', 'repairProductionEnv.js');

const runRepair = (envPath, ...args) => execFileSync(
    process.execPath,
    [scriptPath, envPath, ...args],
    { encoding: 'utf8' }
);

describe('repairProductionEnv', () => {
    let tempDirectory;
    let envPath;

    beforeEach(() => {
        tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ahram-env-repair-'));
        envPath = path.join(tempDirectory, '.env');
    });

    afterEach(() => {
        fs.rmSync(tempDirectory, { recursive: true, force: true });
    });

    test('repairs reused secrets and production security requirements without printing values', () => {
        const reusedSecret = 'a'.repeat(64);
        fs.writeFileSync(envPath, [
            'NODE_ENV=development',
            `JWT_SECRET=${reusedSecret}`,
            `JWT_REFRESH_SECRET=${reusedSecret}`,
            `SESSION_SECRET=${reusedSecret}`,
            `OTP_SECRET=${reusedSecret}`,
            'BYPASS_OTP=true',
            'BYPASS_CLIENT_OTP=true',
            'DISABLE_OTP=true',
            'MASTER_OTP=200104',
            'FORCE_CLIENT_OTP=false',
            'SESSION_STORE=memory',
            'MONGO_TRANSACTIONS_REQUIRED=false',
            'TENANT_ISOLATION_REQUIRED=false',
            'ALLOW_LEGACY_TENANTLESS_RECORDS=true',
            'ALLOW_LEGACY_TENANT_TOKENS=true'
        ].join('\n'));

        const output = runRepair(envPath, '--apply');
        const repaired = dotenv.parse(fs.readFileSync(envPath, 'utf8'));
        const authenticationSecrets = [
            repaired.JWT_SECRET,
            repaired.JWT_REFRESH_SECRET,
            repaired.SESSION_SECRET,
            repaired.OTP_SECRET
        ];

        expect(new Set(authenticationSecrets).size).toBe(4);
        expect(authenticationSecrets.every((value) => value.length >= 64)).toBe(true);
        expect(repaired.NODE_ENV).toBe('production');
        expect(repaired.SECURITY_VERIFICATION_ENFORCEMENT_ENABLED).toBe('false');
        expect(repaired.SECURITY_VERIFICATION_MODE).toBe('optional');
        expect(repaired.PASSKEY_REQUIRED).toBe('false');
        expect(repaired.FORCE_CLIENT_OTP).toBe('false');
        expect(repaired.BYPASS_OTP).toBe('false');
        expect(repaired.BYPASS_CLIENT_OTP).toBe('false');
        expect(repaired.DISABLE_OTP).toBe('false');
        expect(repaired.MASTER_OTP).toBe('');
        expect(repaired.SESSION_STORE).toBe('mongo');
        expect(repaired.MONGO_TRANSACTIONS_REQUIRED).toBe('true');
        expect(repaired.TENANT_ISOLATION_REQUIRED).toBe('true');
        expect(repaired.TENANT_MODE).toBe('single');
        expect(repaired.DEFAULT_TENANT_SLUG).toBe('ahram');
        expect(repaired.ALLOW_LEGACY_TENANTLESS_RECORDS).toBe('false');
        expect(repaired.ALLOW_LEGACY_TENANT_TOKENS).toBe('false');
        expect(repaired.RECEIPT_SHARE_SECRET).toHaveLength(128);
        expect(repaired.TENANT_ROUTING_SECRET).toHaveLength(128);
        expect(output).not.toContain(reusedSecret);
        for (const secret of authenticationSecrets) expect(output).not.toContain(secret);
    });

    test('preview reports changes without writing the environment file', () => {
        const original = 'NODE_ENV=development\nJWT_SECRET=short\n';
        fs.writeFileSync(envPath, original);

        const output = runRepair(envPath);

        expect(fs.readFileSync(envPath, 'utf8')).toBe(original);
        expect(output).toContain('RESULT: PREVIEW ONLY');
    });

    test('preserves valid unique secrets and an existing multi-tenant configuration', () => {
        const secrets = {
            JWT_SECRET: '1'.repeat(64),
            JWT_REFRESH_SECRET: '2'.repeat(64),
            SESSION_SECRET: '3'.repeat(64),
            OTP_SECRET: '4'.repeat(64)
        };
        fs.writeFileSync(envPath, [
            ...Object.entries(secrets).map(([key, value]) => `${key}=${value}`),
            'TENANT_MODE=multi',
            'DEFAULT_TENANT_ID=507f1f77bcf86cd799439011',
            'TENANT_ROOT_DOMAIN=ahrampay.com'
        ].join('\n'));

        runRepair(envPath, '--apply');
        const repaired = dotenv.parse(fs.readFileSync(envPath, 'utf8'));

        for (const [key, value] of Object.entries(secrets)) expect(repaired[key]).toBe(value);
        expect(repaired.TENANT_MODE).toBe('multi');
        expect(repaired.DEFAULT_TENANT_ID).toBe('507f1f77bcf86cd799439011');
    });
});
