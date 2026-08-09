'use strict';

const {
    getTransferPricingDefinition,
    calculateTransferCostLYD,
    calculateSourceAmount
} = require('../utils/transferPricing');

describe('transfer pricing', () => {
    test('keeps Egyptian services as LYD-to-source pricing', () => {
        expect(calculateTransferCostLYD({
            serviceKey: 'vodafone',
            amount: 1500,
            exchangeRate: 6
        })).toBe(250);
        expect(calculateSourceAmount({
            serviceKey: 'vodafone',
            costLYD: 250,
            exchangeRate: 6
        })).toBe(1500);
    });

    test('prices Niger Sefa as source-to-LYD with one Sefa equal to its LYD rate', () => {
        expect(getTransferPricingDefinition('sefa_niger')).toMatchObject({
            amountCurrencyCode: 'XOF',
            amountCurrencyLabel: 'سيفا',
            rateDirection: 'source_to_lyd'
        });
        expect(calculateTransferCostLYD({
            serviceKey: 'sefa_niger',
            amount: 5,
            exchangeRate: 15
        })).toBe(75);
        expect(calculateSourceAmount({
            serviceKey: 'sefa_niger',
            costLYD: 75,
            exchangeRate: 15
        })).toBe(5);
    });
});
