'use strict';

const { parseVoiceFilter } = require('../utils/opsVoiceFilter');

describe('ops voice filter', () => {
    test('maps Arabic and English phrases onto existing live-ops filters', () => {
        expect(parseVoiceFilter('العمليات الفاشلة في آخر ساعة')).toEqual({
            status: 'failed',
            range: '1h'
        });
        expect(parseVoiceFilter('failed last hour')).toEqual({
            status: 'failed',
            range: '1h'
        });
        expect(parseVoiceFilter('successful vodafone transfers today')).toMatchObject({
            status: 'success',
            type: 'vodafone',
            range: '24h'
        });
        expect(parseVoiceFilter('مبلغ أكبر من 15000')).toEqual({ minAmount: '15000' });
        expect(parseVoiceFilter('large amount pending')).toMatchObject({
            status: 'pending',
            minAmount: '10000'
        });
    });

    test('returns an empty object when nothing maps so the UI can fall back to free text', () => {
        expect(parseVoiceFilter('')).toEqual({});
        expect(parseVoiceFilter('مرحبا')).toEqual({});
    });
});
