(() => {
    'use strict';
    // Phone analytics are hidden: do not download a chart library on the navigation path.
    const desktop = window.matchMedia('(min-width: 601px)');
    let requested = false;
    const load = () => {
        if (!desktop.matches || requested || !document.getElementById('commandCenterWeekChart')) return;
        requested = true;
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js';
        script.async = true;
        script.onload = () => window.dispatchEvent(new Event('company-chart-ready'));
        script.onerror = () => {
            requested = false;
        };
        document.head.append(script);
    };
    desktop.addEventListener('change', load);
    load();
})();
