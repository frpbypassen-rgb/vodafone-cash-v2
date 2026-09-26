'use strict';

const fs = require('fs');
const path = require('path');

const rolloutPath = path.join(__dirname, '../docs/operations/password-reset-rollout.md');
const resetPath = path.join(__dirname, '../docs/operations/password-reset.md');

const allowedStagingMention = (line) => (
    line.includes('must never')
    || line.includes("-ieq 'Ahram_Core_API'")
    || line.includes('never use Ahram_Core_API')
);

describe('password reset operator docs', () => {
    test('staging section does not use the production PM2 process name', () => {
        const doc = fs.readFileSync(rolloutPath, 'utf8');
        const marker = '## 8. Production';
        const splitAt = doc.indexOf(marker);
        expect(splitAt).toBeGreaterThan(0);
        const staging = doc.slice(0, splitAt);
        expect(staging).toContain('## 2. Staging');
        expect(staging).toContain('--pm2-name <STAGING_PM2_NAME>');
        expect(staging).toContain("$stagingPm2 = '<STAGING_PM2_NAME>'");
        const offenders = staging.split('\n').filter((line) => (
            line.includes('Ahram_Core_API') && !allowedStagingMention(line)
        ));
        expect(offenders).toEqual([]);
        const production = doc.slice(splitAt);
        expect(production).toContain('## Rollback');
        expect(production).toContain('pm2 restart Ahram_Core_API --update-env');
        expect(doc).not.toMatch(/\$pid\s*=/);
    });

    test('rollout and reset docs do not tell operators to edit reset requests', () => {
        [rolloutPath, resetPath].forEach((file) => {
            const text = fs.readFileSync(file, 'utf8');
            expect(text).not.toMatch(/updateOne/);
            expect(text).not.toMatch(/\bdb\./);
            expect(text).not.toMatch(/set status/i);
            expect(text).toContain('Do not modify the data directly');
            expect(text).toContain('PASSWORD_RESET_EMAIL_ENABLED=false');
            text.split(/\n\s*\n/).forEach((paragraph) => {
                if (!/completing/i.test(paragraph)) return;
                expect(paragraph).not.toMatch(/expired/i);
                expect(paragraph).not.toMatch(/updateOne|\bdb\.|set status|by hand/i);
            });
        });
    });

    test('rollout doc keeps GitHub deploys blocked until a separate PR', () => {
        const doc = fs.readFileSync(rolloutPath, 'utf8');
        expect(doc).toContain('GitHub deploys stay blocked until the pre-existing npm audit vulnerabilities and the two pre-existing failing tests (mobileConsolidation \'Executor login signs executorGroupId…\' and mobileAuthContract \'T014 & T015…\') are fixed in a separate PR; do not fix them in PR #77.');
    });
});
