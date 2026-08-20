'use strict';

const { establishAuthenticatedSession } = require('../utils/sessionSecurity');

describe('Session security', () => {
    test('regenerates the session before assigning authenticated identity', async () => {
        const req = { session: null };
        const regenerate = jest.fn((callback) => {
            req.session = { regenerate, save: jest.fn() };
            callback();
        });
        req.session = { attackerControlled: true, regenerate };

        await establishAuthenticatedSession(req, { isLoggedIn: true, adminId: 'admin-1' });

        expect(regenerate).toHaveBeenCalledTimes(1);
        expect(req.session.attackerControlled).toBeUndefined();
        expect(req.session).toEqual(expect.objectContaining({ isLoggedIn: true, adminId: 'admin-1' }));
    });

    test('fails closed when session regeneration fails', async () => {
        const req = {
            session: {
                regenerate: (callback) => callback(new Error('store unavailable'))
            }
        };

        await expect(establishAuthenticatedSession(req, { isLoggedIn: true }))
            .rejects.toThrow('store unavailable');
        expect(req.session.isLoggedIn).toBeUndefined();
    });
});
