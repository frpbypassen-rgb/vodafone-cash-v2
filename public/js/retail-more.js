(() => {
    'use strict';
    const menu = document.getElementById('retailMoreDialog');
    if (!menu) return;
    const triggers = document.querySelectorAll('[data-retail-more-open]');
    menu.addEventListener('toggle', () => {
        const open = menu.matches(':popover-open');
        triggers.forEach((button) => button.setAttribute('aria-expanded', String(open)));
    });
})();
