(() => {
    'use strict';
    const menu = document.getElementById('agentMoreMenu');
    const button = document.getElementById('agentMoreButton');
    if (!menu || !button) return;

    const phoneLayout = window.matchMedia('(max-width: 960px)');
    const closeMobileSidebar = () => {
        if (!phoneLayout.matches) return;
        document.body.classList.remove('bw-sidebar-open');
        document.querySelectorAll('[data-sidebar-toggle]').forEach((toggle) => {
            toggle.setAttribute('aria-expanded', 'false');
        });
    };
    closeMobileSidebar();
    phoneLayout.addEventListener('change', closeMobileSidebar);

    menu.addEventListener('toggle', (event) => {
        const open = event.newState === 'open';
        button.setAttribute('aria-expanded', String(open));
        if (open) {
            closeMobileSidebar();
        }
    });
    menu.querySelectorAll('a').forEach((link) => {
        link.addEventListener('click', () => menu.hidePopover());
    });
    window.matchMedia('(min-width: 961px)').addEventListener('change', (event) => {
        if (event.matches && menu.matches(':popover-open')) menu.hidePopover();
    });
})();
