'use strict';
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const validateHeld = (tx, expectedHash, allowSettled = false) => {
    const data = tx?.apiResultData || {};
    const settled = allowSettled && tx && ['completed','rejected','cancelled_by_admin'].includes(tx.status);
    if (!settled && (!tx || tx.status !== 'processing' || data.providerDispatchResult !== 'pending_reference'
        || data.providerResultUnresolved !== true || !data.providerDispatchStartedAt
        || data.waitingApiAutoCompletion === true)) throw new Error('HELD_STATE_CHANGED');
    const heldHash = createHash('sha256').update(JSON.stringify(tx)).digest('hex');
    if (expectedHash && heldHash !== expectedHash) throw new Error('HELD_DOCUMENT_CHANGED');
    return heldHash;
};
const validateQueues = (report, allowSettled = false) => {
    const empty = allowSettled && report.transactions?.sampled === 0;
    if (report.mongo?.connected !== true || report.transactions?.truncated !== false || !Number.isInteger(report.transactions.sampled))
        throw new Error('TRANSACTION_INSPECTION_NOT_CLEAR');
    if (!empty && (report.transactions.sampled !== 1 || report.transactions.statuses?.processing !== 1)) {
        const error = new Error('OTHER_OPEN_TRANSACTION');
        error.summary = {sampled:report.transactions.sampled,statuses:Object.fromEntries(
            ['pending','processing','accepted','deposit_pending'].map(key=>[key,Number(report.transactions.statuses?.[key] || 0)]))};
        throw error;
    }
    for (const queue of ['api-transfers-queue','notifications-queue','reports-queue','backups-queue','reconciliations-queue'])
        for (const field of ['active','wait','delayed','prioritized','waiting-children'])
            if (!Number.isInteger(report.queues?.[queue]?.[field])) throw new Error('QUEUE_INSPECTION_INCOMPLETE');
            else if (report.queues[queue][field] !== 0) throw new Error('QUEUES_NOT_EMPTY');
};
const main = async () => {
    require('dotenv').config({ quiet: true });
    const { MongoClient, ObjectId } = require('mongodb');
    const args = process.argv.slice(2);
    const allowSettled = args.includes('--allow-settled');
    const positional = args.filter(arg => arg !== '--allow-settled');
    const [id, expectedHash] = positional;
    if (positional.length > 2) throw new Error('INVALID_ARGUMENT');
    if (!/^[a-f\d]{24}$/i.test(id || '') || (expectedHash && !/^[a-f\d]{64}$/.test(expectedHash)))
        throw new Error('INVALID_ARGUMENT');
    const result = spawnSync(process.execPath, [path.join(__dirname,'inspectProductionQueues.cjs'), '--project', process.cwd()],
        { encoding:'utf8', windowsHide:true, timeout:30000 });
    if (result.status !== 0) throw new Error('QUEUE_INSPECTION_FAILED');
    validateQueues(JSON.parse(result.stdout),allowSettled);
    const client = new MongoClient(process.env.MONGO_URI, {
        maxPoolSize:1, serverSelectionTimeoutMS:5000, socketTimeoutMS:5000, retryWrites:false
    });
    try {
        await client.connect();
        const collection = client.db().collection('transactions');
        const heldId = new ObjectId(id);
        const other = await collection.findOne({status:{$in:['pending','processing','accepted','deposit_pending']},_id:{$ne:heldId}},
            {projection:{_id:1},maxTimeMS:2000});
        if (other) throw new Error('OTHER_OPEN_TRANSACTION');
        const tx = await collection.findOne({_id:heldId},{maxTimeMS:2000});
        const heldHash = validateHeld(tx,expectedHash,allowSettled);
        console.log(JSON.stringify({ok:true,readOnly:true,protectedStatus:tx.status,heldHash,unchanged:expectedHash ? true : null}));
    } finally { await client.close(); }
};
module.exports = {validateHeld,validateQueues};
if (require.main === module) main().catch(error=>{
    const known = ['HELD_STATE_CHANGED','HELD_DOCUMENT_CHANGED','INVALID_ARGUMENT','QUEUE_INSPECTION_FAILED',
        'TRANSACTION_INSPECTION_NOT_CLEAR','QUEUES_NOT_EMPTY','OTHER_OPEN_TRANSACTION','QUEUE_INSPECTION_INCOMPLETE'];
    console.error(known.includes(error.message) ? error.message : 'READ_ONLY_CHECK_FAILED');
    if (error.summary) console.error(JSON.stringify(error.summary));
    process.exitCode=['OTHER_OPEN_TRANSACTION','QUEUES_NOT_EMPTY'].includes(error.message) ? 2 : 1;
});
