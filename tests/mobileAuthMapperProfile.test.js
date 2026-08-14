'use strict';

const { buildContext } = require('../mappers/mobileAuthMapper');

describe('mobile auth profile context', () => {
    test('returns the direct customer identity fields without sensitive data', () => {
        const context = buildContext('client_user', {
            accountCode: 'AHR-2048',
            username: 'mohamed.ali@ahram.com',
            phone: '0940719000',
            address: 'طرابلس - ليبيا',
            status: 'active',
            joinedAt: new Date('2026-08-14T08:00:00.000Z'),
            profilePhotoUpdatedAt: new Date('2026-08-14T09:00:00.000Z')
        });

        expect(context).toMatchObject({
            accountCode: 'AHR-2048',
            profile: {
                username: 'mohamed.ali@ahram.com',
                phone: '0940719000',
                address: 'طرابلس - ليبيا',
                status: 'active',
                joinedAt: '2026-08-14T08:00:00.000Z',
                photoUpdatedAt: '2026-08-14T09:00:00.000Z'
            }
        });
        expect(context.profile).not.toHaveProperty('webPassword');
    });

    test('keeps agent ownership alongside a customer profile', () => {
        const context = buildContext('sub_client', {
            agentId: 'agent-1',
            agentName: 'وكالة النخبة',
            accountCode: 'SUB-2048',
            username: 'customer@ahram.com',
            phone: '0940719000'
        });

        expect(context).toMatchObject({
            agentId: 'agent-1',
            agentName: 'وكالة النخبة',
            accountCode: 'SUB-2048',
            profile: {
                username: 'customer@ahram.com',
                phone: '0940719000'
            }
        });
    });
});
