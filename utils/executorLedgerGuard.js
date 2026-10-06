'use strict';

const ExecutorGroup = require('../models/ExecutorGroup');

const queryWithSession = (query, session) => (session ? query.session(session) : query);

// Membership changes and ledger reconciliation write the same group document
// so concurrent allocations cannot commit against an obsolete membership.
const lockExecutorLedger = (groupId, session) => session
    ? ExecutorGroup.findByIdAndUpdate(groupId, { $inc: { __v: 1 } }, { session, returnDocument: 'after' })
    : ExecutorGroup.findById(groupId);

module.exports = { lockExecutorLedger, queryWithSession };
