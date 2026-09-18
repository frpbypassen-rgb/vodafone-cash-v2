'use strict';

const clientPortalRouter = require('../routes/clientPortal');

const jsonResponse = () => {
    const res = {
        status: jest.fn(() => res),
        json: jest.fn(() => res),
        redirect: jest.fn(() => res)
    };
    return res;
};

describe('client portal session isolation', () => {
    test('an unauthorized client poll does not destroy an active admin session', () => {
        const destroy = jest.fn();
        const req = {
            xhr: true,
            headers: { accept: 'application/json' },
            session: { isLoggedIn: true, adminId: 'master_admin', destroy }
        };
        const res = jsonResponse();

        clientPortalRouter.__test.endUnauthorizedClientSession(req, res);

        expect(destroy).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(401);
        expect(res.json).toHaveBeenCalledWith({ error: 'Unauthorized' });
    });

    test('an invalid session owned by the client portal is destroyed', () => {
        const destroy = jest.fn((callback) => callback());
        const req = {
            xhr: true,
            headers: { accept: 'application/json' },
            session: { isClientLoggedIn: true, clientId: 'client-1', destroy }
        };
        const res = jsonResponse();

        clientPortalRouter.__test.endUnauthorizedClientSession(req, res);

        expect(destroy).toHaveBeenCalledTimes(1);
        expect(res.status).toHaveBeenCalledWith(401);
    });
});
