'use strict';

const restrictClientRawUploads = require('../middlewares/restrictClientRawUploads');

describe('Raw upload access for client sessions', () => {
    test('blocks a client session before static storage is reached', () => {
        const next = jest.fn();
        const send = jest.fn();
        const status = jest.fn(() => ({ send }));
        restrictClientRawUploads({ session: { isClientLoggedIn: true } }, { status }, next);
        expect(status).toHaveBeenCalledWith(403);
        expect(send).toHaveBeenCalledWith('Forbidden');
        expect(next).not.toHaveBeenCalled();
    });

    test('allows non-client sessions to continue to their own access policy', () => {
        const next = jest.fn();
        restrictClientRawUploads({ session: { isLoggedIn: true } }, { status: jest.fn() }, next);
        expect(next).toHaveBeenCalledTimes(1);
    });
});
