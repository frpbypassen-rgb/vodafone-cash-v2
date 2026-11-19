'use strict';

const readRetryAfterSeconds = response => {
    const header = String(response?.headers?.['retry-after'] ?? '').trim();
    const date = Date.parse(header);
    let retryAfterSeconds = null;
    if (/^\d{1,9}$/.test(header)) retryAfterSeconds = Number(header);
    else if (Number.isFinite(date) && new Date(date).toUTCString() === header) {
        retryAfterSeconds = Math.max(0, Math.ceil((date - Date.now()) / 1000));
    }
    return retryAfterSeconds;
};

// Keep only enumerated connection categories. Axios errors can include full request headers.
function transportCategory(error) {
    const code = error?.code;
    if (['ECONNABORTED','ETIMEDOUT','ERR_SOCKET_TIMEOUT'].includes(code)) return 'timeout';
    if (['ENOTFOUND','EAI_AGAIN'].includes(code)) return 'dns';
    if (['EHOSTUNREACH','ENETUNREACH','ECONNRESET','ECONNREFUSED','EPIPE'].includes(code)) return 'connection';
    if (/^(?:ERR_(?:TLS|SSL)_|CERT_|DEPTH_ZERO_SELF_SIGNED_CERT$|SELF_SIGNED_CERT_IN_CHAIN$|UNABLE_TO_VERIFY_LEAF_SIGNATURE$)/.test(code || '')) return 'tls';
    return error ? 'unknown' : null;
}

function readDiagnostics(stage, response, error) {
    const status = response?.status ?? error?.providerHttpStatus;
    const code = response?.data?.Code ?? error?.providerCode;
    const headerDelay = readRetryAfterSeconds(response);
    const delay = headerDelay ?? error?.retryAfterSeconds;
    const http = Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
    return {
        providerLastCheckStage: stage,
        providerLastCheckHttpStatus: http,
        providerLastCheckProviderCode: /^\d{1,9}$/.test(String(code ?? '')) ? Number(code) : null,
        providerLastCheckTransport: http || !error ? null
            : ['timeout','dns','connection','tls','unknown'].includes(error.providerTransport) ? error.providerTransport : transportCategory(error),
        providerLastCheckRetryAfterSeconds: Number.isSafeInteger(delay) && delay >= 0 ? delay : null,
        providerLastCheckRetrySource: headerDelay !== null ? 'provider_header'
            : ['provider_header','local_fallback'].includes(error?.retryAfterSource) ? error.retryAfterSource : null
    };
}
module.exports = { readDiagnostics, readRetryAfterSeconds, transportCategory };
