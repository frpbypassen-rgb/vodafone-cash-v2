'use strict';

const Counter = require('../models/Counter');

// Deposit requests are transactions and share their sequence with ATT references.
async function nextDepositRequestId(session = null) {
    const counter = await Counter.findOneAndUpdate(
        { name: 'transaction' },
        { $inc: { value: 1 } },
        { upsert: true, returnDocument: 'after', ...(session ? { session } : {}) }
    );
    const now = new Date();
    const yy = now.getFullYear().toString().slice(-2);
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    return `DQ-${yy}${mm}-${String(counter.value).padStart(4, '0')}`;
}

module.exports = { nextDepositRequestId };
