'use strict';
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const validate = (report) => {
    if (
        report.mongo?.connected !== true ||
        report.transactions?.truncated !== false ||
        !Number.isInteger(report.transactions?.sampled)
    )
        throw new Error('INSPECTION_INCOMPLETE');
    if (report.transactions.sampled !== 0) throw new Error('OPEN_TRANSACTIONS');
    for (const queue of [
        'api-transfers-queue',
        'notifications-queue',
        'reports-queue',
        'backups-queue',
        'reconciliations-queue',
    ]) {
        for (const state of ['active', 'wait', 'delayed', 'prioritized', 'waiting-children']) {
            const count = report.queues?.[queue]?.[state];
            if (!Number.isInteger(count) || count < 0) throw new Error('INSPECTION_INCOMPLETE');
            if (count !== 0) throw new Error('QUEUES_NOT_EMPTY');
        }
    }
};
module.exports = { validate };
if (require.main === module) {
    try {
        const result = spawnSync(
            process.execPath,
            [path.join(__dirname, 'inspectProductionQueues.cjs'), '--project', process.cwd()],
            { encoding: 'utf8', windowsHide: true, timeout: 30000 }
        );
        if (result.status !== 0) throw new Error('INSPECTION_FAILED');
        validate(JSON.parse(result.stdout));
        console.log('EMPTY_RUNTIME_PASS');
    } catch (error) {
        const busy = ['OPEN_TRANSACTIONS', 'QUEUES_NOT_EMPTY'].includes(error.message);
        console.error(busy ? error.message : 'INSPECTION_INCOMPLETE');
        process.exitCode = busy ? 2 : 1;
    }
}
