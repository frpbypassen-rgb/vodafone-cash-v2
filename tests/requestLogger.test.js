'use strict';

const { EventEmitter } = require('events');

jest.mock('../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
}));

const logger = require('../utils/logger');
const requestLogger = require('../middlewares/requestLogger');

const createResponse = () => {
    const response = new EventEmitter();
    response.statusCode = 200;
    response.setHeader = jest.fn();
    response.getHeader = jest.fn().mockReturnValue(0);
    response.end = jest.fn().mockReturnValue(response);
    return response;
};

describe('requestLogger', () => {
    beforeEach(() => jest.clearAllMocks());

    test('skips static assets without wrapping the response', () => {
        const req = { originalUrl: '/css/app.css', url: '/css/app.css', headers: {} };
        const res = createResponse();
        const originalEnd = res.end;
        const next = jest.fn();

        requestLogger(req, res, next);

        expect(next).toHaveBeenCalledTimes(1);
        expect(res.end).toBe(originalEnd);
        expect(res.setHeader).not.toHaveBeenCalled();
    });

    test('writes dynamic request logs after the response is ended', async () => {
        const req = { originalUrl: '/login', url: '/login', headers: {}, ip: '127.0.0.1' };
        const res = createResponse();
        const next = jest.fn();

        requestLogger(req, res, next);
        res.end('ok');

        expect(logger.info).not.toHaveBeenCalled();
        await new Promise((resolve) => setImmediate(resolve));
        expect(logger.info).toHaveBeenCalledWith('HTTP Request', expect.objectContaining({
            method: undefined,
            statusCode: 200
        }));
    });
});
