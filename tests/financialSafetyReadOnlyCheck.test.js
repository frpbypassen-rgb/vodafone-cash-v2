'use strict';

const { spawnSync } = require('child_process');
const path = require('path');
const {
    maskText,
    parseArgs,
    assessNodeVersion,
    gitRevParseArgs,
    classifyBalanceGap,
    summarizeTenantCounts,
    tenantCountsFail,
    evidenceInsideApp
} = require('../scripts/financialSafetyReadOnlyCheck');

describe('financial safety read-only check', () => {
    test('masks credentials inside connection strings', () => {
        expect(maskText('mongodb://user:secret@db.internal:27017/ahr')).toBe('mongodb://***@db.internal:27017/ahr');
        expect(maskText('redis://:password@127.0.0.1:6379')).toBe('redis://***@127.0.0.1:6379');
        expect(maskText('token=abc123')).toBe('token=***');
    });

    test('refuses --apply before any database work', () => {
        const script = path.join(__dirname, '..', 'scripts', 'financialSafetyReadOnlyCheck.js');
        const result = spawnSync(process.execPath, [script, '--apply', '--env', 'production'], { encoding: 'utf8' });
        expect(result.status).toBe(2);
        expect(result.stdout).toContain('CHECK readonly FAIL');
        expect(result.stdout).not.toContain('mongodb://');
    });

    test('requires a staging or production label and a full SHA', () => {
        expect(parseArgs(['--env', 'staging', '--required-sha', 'a'.repeat(40)]).env).toBe('staging');
        const script = path.join(__dirname, '..', 'scripts', 'financialSafetyReadOnlyCheck.js');
        const result = spawnSync(process.execPath, [script, '--env', 'production'], { encoding: 'utf8' });
        expect(result.status).toBe(2);
        expect(result.stdout).toContain('CHECK arguments FAIL');
    });

    test('defaults to a read-only Redis check and reads git from --app-dir', () => {
        const args = parseArgs(['--env', 'production', '--app-dir', 'C:\\app', '--required-sha', 'a'.repeat(40)]);
        expect(args.redisLockProbe).toBe(false);
        expect(args.appDir).toBe('C:\\app');
        expect(parseArgs(['--redis-lock-probe']).redisLockProbe).toBe(true);
        expect(gitRevParseArgs('C:\\Users\\Administrator\\Desktop\\vodafone-cash-v2')).toEqual([
            '-C',
            'C:\\Users\\Administrator\\Desktop\\vodafone-cash-v2',
            'rev-parse',
            'HEAD'
        ]);
        expect(evidenceInsideApp('evidence\\financial-safety', 'C:\\app')).toBe(false);
    });

    test('accepts Node 18, 20, and 22 and names any other major NODE_VERSION', () => {
        expect(assessNodeVersion('v18.20.4').pass).toBe(true);
        expect(assessNodeVersion('v20.11.0').pass).toBe(true);
        expect(assessNodeVersion('v22.14.0').pass).toBe(true);
        expect(assessNodeVersion('v16.20.2').pass).toBe(false);
        expect(assessNodeVersion('v16.20.2').reason).toMatch(/^NODE_VERSION/);
    });

    test('classifies opening balances separately and keeps single-tenant legacy off the stop rule', () => {
        expect(classifyBalanceGap(40, 0, 0)).toEqual({ className: 'opening_balance_no_ledger', amount: 40 });
        expect(classifyBalanceGap(40, 2, 10)).toEqual({ className: 'other', amount: 30 });
        expect(classifyBalanceGap(10, 1, 10)).toBeNull();
        const single = summarizeTenantCounts({ confident: 2, ambiguous: 0, unresolvable: 5, modified: 0 }, 'single');
        expect(single.legacy_single_tenant_assignable).toBe(5);
        expect(single.legacy).toBe(0);
        expect(tenantCountsFail(single, 'single')).toBe(false);
        const ambiguous = summarizeTenantCounts({ confident: 0, ambiguous: 1, unresolvable: 0, modified: 0 }, 'single');
        expect(tenantCountsFail(ambiguous, 'single')).toBe(true);
        const multi = summarizeTenantCounts({ confident: 0, ambiguous: 0, unresolvable: 3, modified: 0 }, 'multi');
        expect(multi.legacy).toBe(3);
        expect(tenantCountsFail(multi, 'multi')).toBe(true);
    });

    test('refuses to run without --app-dir so the check clone SHA is not used', () => {
        const script = path.join(__dirname, '..', 'scripts', 'financialSafetyReadOnlyCheck.js');
        const result = spawnSync(process.execPath, [
            script,
            '--env',
            'production',
            '--required-sha',
            'a'.repeat(40)
        ], { encoding: 'utf8' });
        expect(result.status).toBe(2);
        expect(result.stdout).toContain('--app-dir is required');
    });
});
