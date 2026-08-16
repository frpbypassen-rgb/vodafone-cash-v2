'use strict';

const {
    buildPersonalizedPayload,
    formatDelay,
    normalizeDelaySeconds,
    withRateChanges
} = require('../services/rateAlerts/rateAlertAudienceService');
const {
    getServiceRatesForTier,
    synchronizeVodafoneLinkedRateFields
} = require('../utils/rateHelper');

const settings = Object.freeze({
    rateLevel1: 4.80,
    rateLevel2: 5.00,
    rateLevel3: 5.20,
    cashRateLevel1: 4.80,
    cashRateLevel2: 5.00,
    cashRateLevel3: 5.20,
    postAccountRateLevel1: 4.75,
    postAccountRateLevel2: 4.95,
    postAccountRateLevel3: 5.15,
    postCardRateLevel1: 4.65,
    postCardRateLevel2: 4.85,
    postCardRateLevel3: 5.05,
    bankAccountRateLevel1: 4.70,
    bankAccountRateLevel2: 4.90,
    bankAccountRateLevel3: 5.10,
    sefaNigerRateLevel1: 15,
    sefaNigerRateLevel2: 15,
    sefaNigerRateLevel3: 15,
    bankakSudanRateLevel1: 6.60,
    bankakSudanRateLevel2: 6.65,
    bankakSudanRateLevel3: 6.70
});

describe('rate alert audience privacy contract', () => {
    test('a change for one pricing group does not create an alert for another group', () => {
        const changes = synchronizeVodafoneLinkedRateFields({ cashRateLevel1: 4.90 });
        const nextSettings = withRateChanges(settings, changes);

        const groupOnePayload = buildPersonalizedPayload({
            currentRates: getServiceRatesForTier(1, settings),
            nextRates: getServiceRatesForTier(1, nextSettings),
            effectiveAt: new Date(Date.now() + 90000),
            delaySeconds: 90
        });
        const groupTwoPayload = buildPersonalizedPayload({
            currentRates: getServiceRatesForTier(2, settings),
            nextRates: getServiceRatesForTier(2, nextSettings),
            effectiveAt: new Date(Date.now() + 90000),
            delaySeconds: 90
        });

        expect(groupOnePayload).not.toBeNull();
        expect(groupTwoPayload).toBeNull();
    });

    test('client payload contains effective prices and directions without tier metadata', () => {
        const payload = buildPersonalizedPayload({
            currentRates: { vodafone: 4.80, post_account: 4.75 },
            nextRates: { vodafone: 4.90, post_account: 4.70 },
            effectiveAt: new Date(Date.now() + 90000),
            delaySeconds: 90,
            campaignReference: 'RATE-TEST'
        });

        expect(payload.countdown).toBe('01:30');
        expect(payload.rateChanges).toEqual(expect.arrayContaining([
            expect.objectContaining({ serviceKey: 'vodafone', direction: 'up' }),
            expect.objectContaining({ serviceKey: 'post_account', direction: 'down' })
        ]));
        expect(JSON.stringify(payload)).not.toMatch(/tier|level|مستوى/i);
    });

    test('countdown duration is normalized and formatted consistently', () => {
        expect(normalizeDelaySeconds(90)).toBe(90);
        expect(formatDelay(90)).toBe('01:30');
        expect(normalizeDelaySeconds(2)).toBe(10);
        expect(normalizeDelaySeconds(5000)).toBe(3600);
    });
});
