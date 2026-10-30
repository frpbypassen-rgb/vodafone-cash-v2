'use strict';
const { validate } = require('../scripts/checkEmptyRuntime.cjs');
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
