'use strict';

jest.mock('../src/Domain/Entities/FxRate', () => ({
    find: jest.fn().mockResolvedValue([]),
    findOneAndUpdate: jest.fn().mockResolvedValue({})
}));

const { fxEngine } = require('../src/Application/Services/FxEngine');

describe('FX Engine Tests', () => {
    test('Should convert same currency with 1.0 rate', () => {
        const result = fxEngine.convert(100, 'EGP', 'EGP');
        expect(result).toBe(100);
    });

    test('Should fetch rate for EGP to USD and vice versa', () => {
        const usdToEgp = fxEngine.getRate('USD', 'EGP');
        expect(usdToEgp).toBe(47.50);

        const egpToUsd = fxEngine.getRate('EGP', 'USD');
        expect(egpToUsd).toBeCloseTo(1 / 47.50, 4);
    });

    test('Should convert USD to EGP correctly', () => {
        const result = fxEngine.convert(10, 'USD', 'EGP');
        expect(result).toBe(475);
    });

    test('Should allow updating exchange rate', () => {
        fxEngine.updateRate('USD', 'EGP', 50.00);
        const result = fxEngine.convert(10, 'USD', 'EGP');
        expect(result).toBe(500);

        // restore original rate
        fxEngine.updateRate('USD', 'EGP', 47.50);
    });

    test('Should throw error when updating to negative rate', () => {
        expect(() => {
            fxEngine.updateRate('USD', 'EGP', -10);
        }).toThrow('Exchange rate must be positive');
    });
});
