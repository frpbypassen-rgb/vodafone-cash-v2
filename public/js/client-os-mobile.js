(function (global) {
    'use strict';

    function openWalletHubMore() {
        const drawer = document.getElementById('walletHubMoreDrawer');
        if (drawer && typeof drawer.showModal === 'function') {
            drawer.showModal();
            return;
        }
        global.location.assign('/client/dashboard?tab=more');
    }

    function closeWalletHubMore() {
        document.getElementById('walletHubMoreDrawer')?.close();
    }

    function bindDashboardNavOverrides() {
        if (!document.body.classList.contains('wallet-hub-dashboard')) return;

        document.querySelectorAll('.bottom-nav-mobile [data-nav="home"]').forEach((el) => {
            el.addEventListener('click', (event) => {
                event.preventDefault();
                global.switchMobileTab?.('account');
            });
        });

        document.querySelectorAll('.bottom-nav-mobile [data-nav="operations"]').forEach((el) => {
            el.addEventListener('click', (event) => {
                event.preventDefault();
                if (typeof global.openMobileOperations === 'function') {
                    global.openMobileOperations();
                } else {
                    global.switchMobileTab?.('operations');
                }
            });
        });

        document.querySelectorAll('.bottom-nav-mobile [data-nav="transfer"]').forEach((el) => {
            el.addEventListener('click', (event) => {
                event.preventDefault();
                if (typeof global.openQuickTransfer === 'function') {
                    global.openQuickTransfer();
                } else {
                    global.switchMobileTab?.('transfers');
                }
            });
        });
    }

    global.openWalletHubMore = openWalletHubMore;
    global.closeWalletHubMore = closeWalletHubMore;

    document.addEventListener('DOMContentLoaded', () => {
        document.getElementById('walletHubMoreDrawer')
            ?.querySelector('[data-wh-more-close]')
            ?.addEventListener('click', closeWalletHubMore);
        bindDashboardNavOverrides();
    });
}(window));
