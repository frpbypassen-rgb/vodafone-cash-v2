'use strict';

const fs = require('fs');
const path = require('path');
const source = fs.readFileSync(path.join(__dirname, '../services/externalApiService.js'), 'utf8');

test('Zayn providers retain the documented Inquiry before Payment flow', () => {
    expect(source).toContain('buildInquiryPayload(config, targetNumber, amount)');
    expect(source).toContain('inquiryData.Data.PaymentBillInfo');
    expect(source).toContain('PaymentBillInfo: inquiryData.Data.PaymentBillInfo');
});
