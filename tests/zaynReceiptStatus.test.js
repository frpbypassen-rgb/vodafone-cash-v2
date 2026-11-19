'use strict';

const { zaynReceiptObservation, matchedZaynReceiptFields } = require('../utils/zaynReceiptStatus');

const tx = {vodafoneNumber:'01000000000', amount:100, apiResultData:{providerTransactionId:'Z-471'}};
const receipt = (status, rawData = {}) => ({success:true, reportedTransactionId:'Z-471', providerTransactionId:'Z-471',
    phone:tx.vodafoneNumber, amount:tx.amount, providerStatus:status, rawData});

test.each([
    ['تم إلغاء العملية وردها', {}, 'returned'],
    ['العملية ملغاة', {}, 'returned'],
    ['Cancelled', {IsPaid:true}, 'mismatch'],
    ['ملغي', {IsPaid:false}, 'returned'],
    ['عملية ناجحة', {TransactionStatus:'عملية ناجحة', Status:'cancelled'}, 'mismatch'],
    ['cancelled', {TransactionStatus:'cancelled', Status:'refund pending'}, 'mismatch'],
    ['refund pending', {}, 'pending'],
    ['لم يتم إلغاء العملية', {}, 'pending']
])('a matched Zayn receipt with status %s and flags %j gives %s', (status, fields, expected) => {
    expect(zaynReceiptObservation(tx, receipt(status, fields))).toBe(expected);
});

test('plain cancellation cannot authorize reversal of a previously paid order', () => {
    const at = new Date();
    expect(matchedZaynReceiptFields(receipt('تم إلغاء العملية'), 'returned', at).providerMatchedReversal).toBe(false);
});
