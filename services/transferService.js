// services/transferService.js
// ===============================================
// 💸 Bridge to the new TypeScript TransferService
// ===============================================
'use strict';

const { transferService } = require('../src/Application/Services/TransferService.ts');

module.exports = {
    createTransfer: (params) => transferService.createTransfer(params),
    cancelTransfer: (params) => transferService.cancelTransfer(params)
};
