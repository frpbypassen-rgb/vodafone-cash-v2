'use strict';

const fs = require('fs');
const path = require('path');
const source = fs.readFileSync(path.join(__dirname, '../services/externalApiService.js'), 'utf8');

test('Zayn External Aggregator uses an explicit direct-payment branch', () => {
    expect(source).toContain("preset.key === 'zayn_external_aggregator'");
    expect(source).toContain('PAYMENT_DIRECT');
    expect(source).toContain('if (!directPayment) paymentPayload.PaymentBillInfo');
});

test('Legacy providers retain Inquiry before Payment', () => {
    expect(source).toContain('buildInquiryPayload(config, targetNumber, amount)');
    expect(source).toContain('inquiryData.Data.PaymentBillInfo');
});
