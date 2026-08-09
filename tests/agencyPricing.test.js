'use strict';

const {
    buildMarginStorage,
    resolveMarginPiasters,
    applyCustomerRateMargins,
    calculateAgencyPricing,
    pricingFromTransaction
} = require('../utils/agencyPricing');

describe('agency pricing contract', () => {
    const masterRates = {
        vodafone: 5.98,
        post_account: 5.93,
        post_card: 5.83,
        bank_account: 5.88,
        sefa_niger: 6.08,
        bankak_sudan: 6.18
    };

    test('treats 3 piasters as a 0.03 rate delta', () => {
        const pricing = calculateAgencyPricing({
            amountEGP: 1000,
            masterRates,
            serviceKey: 'vodafone',
            subAccount: { marginPiasters: 3, pricingVersion: 2 }
        });

        expect(pricing.agentRate).toBe(5.98);
        expect(pricing.customerRate).toBe(5.95);
        expect(pricing.marginPiasters).toBe(3);
        expect(pricing.agentCostLYD).toBe(167.224);
        expect(pricing.customerChargeLYD).toBe(168.067);
        expect(pricing.profitLYD).toBe(0.843);
    });

    test('keeps legacy decimal margins compatible', () => {
        const legacy = { customMargin: 0.1 };
        expect(resolveMarginPiasters(legacy, 'vodafone')).toBe(10);
        expect(applyCustomerRateMargins(masterRates, legacy).vodafone).toBe(5.88);
    });

    test('uses a service override without changing the customer default', () => {
        const customer = {
            marginPiasters: 3,
            serviceMarginPiasters: { post_card: 12 }
        };
        const rates = applyCustomerRateMargins(masterRates, customer);
        expect(rates.vodafone).toBe(5.95);
        expect(rates.post_card).toBe(5.71);
    });

    test('charges Sefa as source currency multiplied by the LYD rate and preserves agent margin', () => {
        const pricing = calculateAgencyPricing({
            amountEGP: 5,
            masterRates: { ...masterRates, sefa_niger: 15 },
            serviceKey: 'sefa_niger',
            subAccount: { marginPiasters: 3, pricingVersion: 2 }
        });

        expect(pricing.amountCurrency).toBe('XOF');
        expect(pricing.agentRate).toBe(15);
        expect(pricing.customerRate).toBe(15.03);
        expect(pricing.agentCostLYD).toBe(75);
        expect(pricing.customerChargeLYD).toBe(75.15);
        expect(pricing.profitLYD).toBe(0.15);
    });

    test('stores new piaster input while synchronizing the legacy field', () => {
        expect(buildMarginStorage({ marginPiasters: 3 })).toEqual({
            marginPiasters: 3,
            customMargin: 0.03,
            serviceMarginPiasters: undefined,
            pricingVersion: 2
        });
    });

    test('reads immutable pricing snapshots before legacy flat fields', () => {
        const pricing = pricingFromTransaction({
            amount: 1000,
            costLYD: 160,
            subAccountCostLYD: 170,
            exchangeRate: 6,
            subClientRate: 5.9,
            agencyPricing: {
                agentCostLYD: 167.224,
                customerChargeLYD: 168.067,
                profitLYD: 0.843,
                agentRate: 5.98,
                customerRate: 5.95,
                marginPiasters: 3
            }
        });
        expect(pricing.profitLYD).toBe(0.843);
        expect(pricing.agentRate).toBe(5.98);
        expect(pricing.customerRate).toBe(5.95);
    });
});
