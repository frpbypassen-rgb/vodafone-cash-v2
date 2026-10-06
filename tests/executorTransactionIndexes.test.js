'use strict';

const Transaction = require('../models/Transaction');

test('transaction schema defines each dashboard index once', () => {
    const indexes = Transaction.schema.indexes();
    for (const [key, name] of [
        [{ status: 1, createdAt: -1 }, 'adminDashboard_status_createdAt'],
        [{ status: 1, completedAt: -1 }, 'adminDashboard_status_completedAt']
    ]) {
        const matches = indexes.filter(([fields]) => JSON.stringify(fields) === JSON.stringify(key));
        expect(matches).toHaveLength(1);
        expect(matches[0][1].name).toBe(name);
    }
});
