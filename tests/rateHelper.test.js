'use strict';

const {
    getRateForTier,
    normalizeTier,
    normalizeRate,
    normalizeBaseRate,
    getServiceRatesForBaseRate,
    buildMobileRateContract
} = require('../utils/rateHelper');
const {
    getEnabledMobileTransferServiceKeys
} = require('../utils/mobileTransferServiceCatalog');

const roundRate = (value) => Number(Number(value).toFixed(2));
const expectedServiceRates = (base) => ({
    vodafone: roundRate(base),
    post_account: roundRate(base - 0.05),
    post_card: roundRate(base - 0.15),
    bank_account: roundRate(base),
    sefa_niger: roundRate(base + 0.10),
    bankak_sudan: roundRate(base + 0.20)
});

describe('rateHelper mobile service rate contract', () => {
    const mockSettings = {
        rateLevel1: 6.40,
        rateLevel2: 6.45,
        rateLevel3: 6.50,
        isManualClosed: false
    };

    test('normalizeTier only returns 1, 2, or 3 and falls back to 1', () => {
        expect(normalizeTier(1)).toBe(1);
        expect(normalizeTier(2)).toBe(2);
        expect(normalizeTier(3)).toBe(3);
        expect(normalizeTier(0)).toBe(1);
        expect(normalizeTier(4)).toBe(1);
        expect(normalizeTier('2')).toBe(2);
        expect(normalizeTier('invalid')).toBe(1);
        expect(normalizeTier(null)).toBe(1);
    });

    test('normalizeRate falls back to DEFAULT_RATE on invalid values', () => {
        expect(normalizeRate(6.456)).toBe(6.46);
        expect(normalizeRate(0)).toBe(6.40);
        expect(normalizeRate(-1.50)).toBe(6.40);
        expect(normalizeRate(NaN)).toBe(6.40);
        expect(normalizeRate(Infinity)).toBe(6.40);
        expect(normalizeRate(null)).toBe(6.40);
        expect(normalizeRate(undefined)).toBe(6.40);
    });

    test('normalizeBaseRate rejects tiny rates that cannot support service offsets', () => {
        expect(normalizeBaseRate(0.16)).toBe(0.16);
        expect(normalizeBaseRate(0.15)).toBe(6.40);
        expect(normalizeBaseRate(0.10)).toBe(6.40);
        expect(normalizeBaseRate(-1)).toBe(6.40);
    });

    test('getRateForTier selects validated tier rates', () => {
        expect(getRateForTier('1', mockSettings)).toBe(6.40);
        expect(getRateForTier('2', mockSettings)).toBe(6.45);
        expect(getRateForTier('3', mockSettings)).toBe(6.50);
        expect(getRateForTier('bad', mockSettings)).toBe(6.40);
        expect(getRateForTier(2, { rateLevel2: -5 })).toBe(6.40);
        expect(getRateForTier(2, { rateLevel2: 0 })).toBe(6.40);
        expect(getRateForTier(2, { rateLevel2: NaN })).toBe(6.40);
    });

    test('getServiceRatesForBaseRate returns every enabled mobile transfer service', () => {
        const base = 6.45;
        const rates = getServiceRatesForBaseRate(base);
        expect(Object.keys(rates).sort()).toEqual(getEnabledMobileTransferServiceKeys().sort());
        expect(rates).toEqual(expectedServiceRates(base));
    });

    test('getServiceRatesForBaseRate applies fallback before service offsets', () => {
        expect(getServiceRatesForBaseRate(0.10)).toEqual(expectedServiceRates(6.40));
    });

    test('buildMobileRateContract builds complete contract for all tiers', () => {
        for (const [tier, base] of [[1, 6.40], [2, 6.45], [3, 6.50]]) {
            const contract = buildMobileRateContract(tier, mockSettings);
            expect(contract).toMatchObject({
                tier,
                baseExchangeRate: base,
                exchangeRate: base,
                serviceRates: expectedServiceRates(base)
            });
            expect(contract.tierLabel).toBe(`مستوى ${tier}`);
            expect(contract.serviceCatalog.map(service => service.key).sort())
                .toEqual(getEnabledMobileTransferServiceKeys().sort());
        }
    });

    test('buildMobileRateContract falls back safely for invalid tier or settings', () => {
        const invalidTier = buildMobileRateContract(99, mockSettings);
        expect(invalidTier.tier).toBe(1);
        expect(invalidTier.baseExchangeRate).toBe(6.40);

        const nullSettings = buildMobileRateContract(2, null);
        expect(nullSettings.baseExchangeRate).toBe(6.40);
        expect(nullSettings.serviceRates).toEqual(expectedServiceRates(6.40));
    });
});
