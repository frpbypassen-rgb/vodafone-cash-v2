'use strict';

// mock User and Transaction models
jest.mock('../src/Domain/Entities/User', () => ({
    updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    findOne: jest.fn().mockResolvedValue({
        status: 'active',
        creditLimit: 5000
    })
}));

jest.mock('../src/Domain/Entities/Transaction', () => ({
    countDocuments: jest.fn().mockResolvedValue(5)
}));

const User = require('../src/Domain/Entities/User');
const Transaction = require('../src/Domain/Entities/Transaction');
const { fraudDetectionEngine } = require('../src/Application/Services/FraudDetectionEngine');

describe('Fraud Detection Engine Tests', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('Should evaluate low-risk transaction correctly', async () => {
        const result = await fraudDetectionEngine.evaluateTransaction('user-1', 1000, true);
        expect(result.isFraudulent).toBe(false);
        expect(result.riskScore).toBe(10);
    });

    test('Should evaluate untrusted device and higher amount with elevated risk score', async () => {
        const result = await fraudDetectionEngine.evaluateTransaction('user-2', 15000, false);
        expect(result.isFraudulent).toBe(false);
        expect(result.riskScore).toBe(50); // 10 base + 30 untrusted + 10 amount
    });

    test('Should freeze account and flag fraud if transaction speed (velocity) is exceeded', async () => {
        const userId = 'user-velocity-test';
        let result;
        // submit 51 transactions quickly
        for (let i = 0; i < 52; i++) {
            result = await fraudDetectionEngine.evaluateTransaction(userId, 100, true);
        }

        expect(result.isFraudulent).toBe(true);
        expect(result.reason).toBe('VELOCITY_LIMIT_EXCEEDED');
        expect(result.riskScore).toBe(100);
        expect(User.updateOne).toHaveBeenCalledWith({ phone: userId }, { $set: { status: 'suspended' } });
    });

    test('Should calculate correct user risk score', async () => {
        const score = await fraudDetectionEngine.calculateUserRiskScore('user-1');
        expect(score).toBe(20);
    });
});
