'use strict';

const mongoose = require('mongoose');
const Transaction = require('../models/Transaction');
const ClientEmployee = require('../models/ClientEmployee');
const { getClientReceiptProofIds } = require('./clientReceiptService');

const forbidden = (message = 'غير مصرح لك بعرض هذه الصورة أو الإيصال') => {
    const error = new Error(message);
    error.statusCode = 403;
    error.code = 'FORBIDDEN';
    return error;
};

const notFound = (message = 'لا توجد صورة إثبات') => {
    const error = new Error(message);
    error.statusCode = 404;
    error.code = 'NOT_FOUND';
    return error;
};

const assertCompanyOwnsProofTransaction = (employee, transaction) => {
    if (!employee || employee.status !== 'active' || !employee.companyId) {
        throw forbidden();
    }
    if (!transaction?.companyId || String(transaction.companyId) !== String(employee.companyId)) {
        throw forbidden();
    }
};

const resolveClientProofImage = async ({ session = {}, transactionId, index, ownershipFilter }) => {
    if (!mongoose.isValidObjectId(transactionId)) throw notFound();
    if (!ownershipFilter) throw forbidden();

    const tx = await Transaction.findOne({ $and: [{ _id: transactionId }, ownershipFilter] });
    if (!tx) throw forbidden();

    if (session.accountType === 'company') {
        const employee = await ClientEmployee.findById(session.clientId).select('companyId status').lean();
        assertCompanyOwnsProofTransaction(employee, tx);
    }

    const photoIndex = index === undefined || index === null || index === ''
        ? 0
        : Number.parseInt(index, 10);
    if (!Number.isInteger(photoIndex) || photoIndex < 0) {
        const error = new Error('رقم صورة الإيصال غير صالح');
        error.statusCode = 400;
        error.code = 'BAD_INDEX';
        throw error;
    }

    const photoId = getClientReceiptProofIds(tx)[photoIndex];
    if (!photoId) throw notFound();

    return { transaction: tx, photoId, index: photoIndex };
};

module.exports = {
    assertCompanyOwnsProofTransaction,
    resolveClientProofImage
};
