'use strict';

const { spawnSync } = require('child_process');
const path = require('path');
const { maskText, parseArgs } = require('../scripts/financialSafetyReadOnlyCheck');

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
});
