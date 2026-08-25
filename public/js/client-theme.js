(function initClientTheme() {
    function applyThemeIcon(theme) {
        const iconClass = theme === 'dark' ? 'fa-solid fa-moon' : 'fa-solid fa-sun';
        document.querySelectorAll('#themeIcon, #mobileThemeIcon').forEach((icon) => {
            icon.className = iconClass;
        });
    }

    window.toggleTheme = function toggleTheme() {
        const current = document.documentElement.getAttribute('data-theme') || 'dark';
        const next = current === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', next);
        document.documentElement.setAttribute('data-bs-theme', next);
        localStorage.setItem('ahram_theme', next);
        applyThemeIcon(next);
    };

    applyThemeIcon(document.documentElement.getAttribute('data-theme') || localStorage.getItem('ahram_theme') || 'dark');
})();
