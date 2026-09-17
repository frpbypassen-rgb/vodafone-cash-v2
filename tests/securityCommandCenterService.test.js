'use strict';

const {
    channelLabel,
    deviceLabel,
    formatActivity,
    mapLinkFor,
    stripSensitive
} = require('../services/securityCommandCenterService');

describe('securityCommandCenterService helpers', () => {
    test('describes combined channels and device types', () => {
        expect(channelLabel(['web', 'app'])).toBe('الموقع والتطبيق');
        expect(deviceLabel(['phone', 'computer'])).toBe('هاتف وكمبيوتر');
    });

    test('creates a Google Maps link only for valid coordinates', () => {
        expect(mapLinkFor({ latitude: 30.0444, longitude: 31.2357 }))
            .toBe('https://www.google.com/maps?q=30.0444,31.2357');
        expect(mapLinkFor({ latitude: 'x', longitude: 31 })).toBe('');
    });

    test('removes sensitive values from activity details', () => {
        expect(stripSensitive({ amount: 120, password: 'secret', metadata: { token: 'x', reference: 'A1' } }))
            .toEqual({ amount: 120, metadata: { reference: 'A1' } });
    });

    test('formats login and transfer events for the dashboard', () => {
        const item = formatActivity({
            _id: 'audit-1', action: 'TRANSFER_CREATED', performedByName: 'عميل تجريبي',
            success: true, result: 'ناجح', initiator: 'تطبيق', deviceType: 'هاتف',
            location: { latitude: 24.7136, longitude: 46.6753 }, createdAt: new Date()
        });
        expect(item.label).toBe('تحويل جديد');
        expect(item.tone).toBe('info');
        expect(item.mapUrl).toContain('24.7136,46.6753');
    });
});
