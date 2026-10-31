'use strict';
const { readState, toQuery } = require('../public/js/retail-reports');
const now = new Date('2026-10-31T23:15:00Z');
test('explicit deep links override saved preferences; plain reports link restores them', () => {
    const stored = JSON.stringify({
        dateType: 'month',
        dateValue: '2026-10',
        search: 'SAVED',
        status: 'completed',
        service: 'bank_account',
    });
    expect(readState('?tab=operations', stored, now)).toMatchObject({ search: 'SAVED', status: 'completed' });
    expect(readState('?search=ATT-1&dateType=month&dateValue=2026-09', stored, now)).toMatchObject({
        search: 'ATT-1',
        dateValue: '2026-09',
        status: '',
        service: '',
    });
});
test('only applied filters are serialized, not private data or pagination cursors', () => {
    const state = readState('?search=أحمد&dateType=range&dateFrom=2026-10-01&dateTo=2026-10-31', null, now);
    const query = toQuery({ ...state, cursor: 'private', token: 'secret' });
    expect(query.get('search')).toBe('أحمد');
    expect(query.has('token')).toBe(false);
    expect(query.has('cursor')).toBe(false);
    expect(readState('?' + query.toString(), null, now)).toEqual(state);
});
test('missing or corrupt storage uses the current Libya month', () => {
    expect(readState('', 'bad-json', now).dateValue).toBe('2026-11');
});
