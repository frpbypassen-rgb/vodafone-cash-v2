'use strict';
const { validate } = require('../scripts/checkEmptyRuntime.cjs');
const restartSource = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '../scripts/restartAhramAfterDrain.ps1'),
    'utf8'
);
test('dependency updates are explicit, offline, hook-free and between verified stop and start', () => {
    expect(restartSource).toContain('[switch]$UpdateDependencies');
    const install = restartSource.indexOf(
        '& $npmCommand install --offline --ignore-scripts --no-audit --no-fund --no-save'
    );
    expect(install).toBeGreaterThan(restartSource.indexOf('& pm2 stop ahram-pay'));
    expect(install).toBeGreaterThan(restartSource.indexOf("throw 'Port 3000 is still occupied."));
    expect(install).toBeLessThan(restartSource.indexOf('& pm2 restart ahram-pay --update-env'));
    expect(restartSource).toContain('if ($UpdateDependencies)');
    expect(restartSource).toContain('Dependency install failed. Admission remains closed.');
    expect(restartSource).toContain('Dependency manifests changed during installation.');
});
const fixture = () => ({
    mongo: { connected: true },
    transactions: { sampled: 0, truncated: false },
    queues: Object.fromEntries(
        [
            'api-transfers-queue',
            'notifications-queue',
            'reports-queue',
            'backups-queue',
            'reconciliations-queue',
        ].map((key) => [key, { active: 0, wait: 0, delayed: 0, prioritized: 0, 'waiting-children': 0 }])
    ),
});

test('source-only deployment retains the guarded installer and rejects dependency or local source changes', () => {
    expect(restartSource).toContain('[switch]$SourceOnly');
    expect(restartSource).toContain('& git diff --quiet --ignore-submodules=all HEAD --');
    expect(restartSource).toContain('SourceOnly refuses dependency changes. No runtime or source was changed.');
    expect(restartSource).toContain('SourceOnly requires an explicit release and clean-source review manifest, without dependency updates.');
    const install = restartSource.indexOf('$installOutput = & node $releaseHelper');
    expect(install).toBeGreaterThan(restartSource.indexOf('& pm2 stop ahram-pay'));
    expect(install).toBeLessThan(restartSource.indexOf('& pm2 restart ahram-pay --update-env'));
});
test('only complete empty observations permit restart', () => {
    expect(() => validate(fixture())).not.toThrow();
});
test.each(['pending', 'processing', 'accepted', 'deposit_pending'])(
    'open %s transactions prevent restart',
    (status) => {
        const r = fixture();
        r.transactions = { sampled: 1, truncated: false, statuses: { [status]: 1 } };
        expect(() => validate(r)).toThrow('OPEN_TRANSACTIONS');
    }
);
test.each(['active', 'wait', 'delayed', 'prioritized', 'waiting-children'])(
    'queue state %s prevents restart',
    (state) => {
        const r = fixture();
        r.queues['api-transfers-queue'][state] = 1;
        expect(() => validate(r)).toThrow('QUEUES_NOT_EMPTY');
    }
);
test('missing database or queue data fails closed', () => {
    const r = fixture();
    delete r.queues['reports-queue'];
    expect(() => validate(r)).toThrow('INSPECTION_INCOMPLETE');
    r.mongo.connected = false;
    expect(() => validate(r)).toThrow('INSPECTION_INCOMPLETE');
});
