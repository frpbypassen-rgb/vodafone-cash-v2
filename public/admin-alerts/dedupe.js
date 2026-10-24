/* Shared atomic receipt store: concurrent tabs and workers cannot claim the same sound twice. */
(() => {
    'use strict';
    let database;
    const open = () => database || (database = new Promise((resolve, reject) => {
        const request = indexedDB.open('ahram-admin-alert-receipts', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('receipts', { keyPath: 'id' }).createIndex('expires', 'expires');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    }));
    self.adminAlertClaim = async id => {
        try {
            const db = await open();
            return await new Promise(resolve => {
                const tx = db.transaction('receipts', 'readwrite');
                const store = tx.objectStore('receipts');
                store.add({ id, expires: Date.now() + 7 * 86400000 });
                const expired = store.index('expires').openCursor(IDBKeyRange.upperBound(Date.now()));
                expired.onsuccess = () => { const cursor = expired.result; if (cursor) { cursor.delete(); cursor.continue(); } };
                tx.oncomplete = () => resolve(true);
                tx.onabort = () => resolve(false);
                tx.onerror = () => {}; // Duplicate keys abort this claim atomically.
            });
        } catch (_) { return false; } // Fail quiet if storage is blocked; never repeat alarms in every tab.
    };
})();
