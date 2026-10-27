'use strict';
const readRuntimeRole = (env = process.env) => {
    const role = String(env.RUNTIME_ROLE || 'full')
        .trim()
        .toLowerCase();
    if (!['full', 'probe'].includes(role))
        throw new Error('RUNTIME_ROLE must be full or probe.');
    return role;
};
const allowsBackgroundWork = (env = process.env) =>
    readRuntimeRole(env) === 'full';
const runtimeBindHost = (env = process.env) => {
    const host = String(env.HTTP_BIND_HOST || '').trim();
    if (readRuntimeRole(env) === 'probe') {
        if (host && !['127.0.0.1', '::1'].includes(host))
            throw new Error('Probe runtime must bind to loopback.');
        return host || '127.0.0.1';
    }
    return host || undefined;
};
const runtimeRoleGate = (env = process.env) => {
    const probe = readRuntimeRole(env) === 'probe';
    return (req, res, next) => {
        if (
            !probe ||
            (['GET', 'HEAD'].includes(req.method) &&
                ['/health', '/health/ready'].includes(req.path))
        )
            return next();
        res.setHeader('Cache-Control', 'no-store');
        return res
            .status(503)
            .json({
                success: false,
                code: 'RUNTIME_PROBE_ONLY',
                error: 'نسخة فحص داخلي، غير مخصصة لاستقبال العمليات.',
            });
    };
};
module.exports = {
    readRuntimeRole,
    allowsBackgroundWork,
    runtimeBindHost,
    runtimeRoleGate,
};
