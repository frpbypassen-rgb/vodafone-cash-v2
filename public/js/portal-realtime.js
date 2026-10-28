(() => {
    'use strict';
    if (typeof window.getPortalRealtimeSocket === 'function') return;
    let socket = null;
    // Calling io() repeatedly for the same namespace opens separate transports.
    // A single transport keeps long polling from exhausting the browser's HTTP pool.
    window.getPortalRealtimeSocket = () => {
        if (!socket && typeof window.io === 'function') socket = window.io();
        return socket;
    };
    window.addEventListener('pagehide', (event) => {
        if (!event.persisted) socket?.disconnect?.();
    });
})();
