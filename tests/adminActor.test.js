'use strict';

const { requireAdminActor, isAdminActorError, routingFields, performedFields } = require('../utils/adminActor');

describe('admin actor identity', () => {
    test('reads the signed-in admin id and display name', () => {
        const actor = requireAdminActor({
            session: { adminId: 'admin-7', adminName: 'نورا', adminRole: 'admin' }
        });
        expect(actor).toMatchObject({ id: 'admin-7', name: 'نورا', role: 'admin' });
        expect(routingFields(actor)).toMatchObject({
            routedByAdminId: 'admin-7',
            routedByAdminName: 'نورا'
        });
        expect(performedFields(actor)).toMatchObject({
            performedByAdminId: 'admin-7',
            performedByAdminName: 'نورا'
        });
    });

    test('refuses a write when the session has no admin identity', () => {
        expect(() => requireAdminActor({ session: { isLoggedIn: true } })).toThrow('ADMIN_ACTOR_REQUIRED');
        expect(() => requireAdminActor({ session: { adminId: 'admin-1', adminName: '   ' } })).toThrow('ADMIN_ACTOR_REQUIRED');
        try {
            requireAdminActor({ session: { adminName: 'مدير' } });
        } catch (error) {
            expect(isAdminActorError(error)).toBe(true);
            expect(error.status).toBe(401);
            expect(error.publicMessage).toContain('المدير');
        }
    });
});
