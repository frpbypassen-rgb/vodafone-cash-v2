'use strict';

const startupGate = (isReady) => (req, res, next) => {
    if (
        isReady() ||
        (['GET', 'HEAD'].includes(req.method) && ['/health', '/health/ready'].includes(req.path))
    ) {
        return next();
    }
    res.setHeader('Retry-After', '5');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(503).json({ success: false, code: 'APPLICATION_STARTING' });
};

// The listener is the ownership fence: a losing process must never start consumers.
const startBoundHttpServer = async ({ server, port, host, initialize, onReady }) => {
    await new Promise((resolve, reject) => {
        const cleanup = () => {
            server.removeListener('listening', onListening);
            server.removeListener('error', onError);
        };
        const onListening = () => {
            cleanup();
            resolve();
        };
        const onError = (error) => {
            cleanup();
            reject(error);
        };
        server.once('listening', onListening);
        server.once('error', onError);
        try {
            server.listen(host ? { port, host } : { port });
        } catch (error) {
            cleanup();
            reject(error);
        }
    });
    try {
        await initialize();
        onReady();
    } catch (error) {
        // Only startup requests have reached this server, and the gate rejected them.
        const closed = new Promise((resolve) => server.close(resolve));
        server.closeAllConnections?.();
        await closed;
        throw error;
    }
};

module.exports = { startupGate, startBoundHttpServer };
