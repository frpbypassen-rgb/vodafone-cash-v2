'use strict';
const { getClientReceiptProofIds } = require('../services/clientReceiptService');
const { getExecutorProofIds } = require('./executorProofIds');
// Preserve the server extension's interface using the canonical proof policies.
function transactionImageCatalog(tx = {}) {
    const official = getClientReceiptProofIds(tx);
    return { official, executor: getExecutorProofIds(tx, official) };
}
module.exports = { transactionImageCatalog };
