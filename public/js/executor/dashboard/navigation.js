/* exported switchSection, handleHashChange, toggleTheme */
// 🔀 Section Toggling Logic
function switchSection(sectionId) {
    if (activeTaskId) return;
    const radarSec = document.getElementById('radarSection');
    const profileSec = document.getElementById('profileSection');

    // Top nav buttons
    const topNavRadar = document.getElementById('top-nav-radar');
    const topNavProfile = document.getElementById('top-nav-profile');

    // Bottom nav buttons
    const botNavRadar = document.getElementById('nav-dash');
    const botNavProfile = document.getElementById('nav-profile');

    // De-activate all
    topNavRadar?.classList.remove('active');
    topNavProfile?.classList.remove('active');
    botNavRadar?.classList.remove('active');
    botNavProfile?.classList.remove('active');

    if (sectionId === 'profile') {
        if (radarSec) radarSec.style.display = 'none';
        if (profileSec) profileSec.style.display = 'block';

        topNavProfile?.classList.add('active');
        botNavProfile?.classList.add('active');
        if (typeof refreshTasks === 'function') refreshTasks();
    } else {
        if (radarSec) radarSec.style.display = 'block';
        if (profileSec) profileSec.style.display = 'none';

        topNavRadar?.classList.add('active');
        botNavRadar?.classList.add('active');
    }
}

function handleHashChange() {
    if (activeTaskId) return;
    const hash = window.location.hash;
    if (hash === '#profile') {
        switchSection('profile');
    } else {
        switchSection('radar');
    }
}

window.addEventListener('hashchange', handleHashChange);
document.addEventListener('DOMContentLoaded', handleHashChange);
// 🌓 Theme Logic
function toggleTheme() {
    const html = document.documentElement;
    const currentTheme = html.getAttribute('data-theme');
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
    html.setAttribute('data-theme', newTheme);
    html.setAttribute('data-bs-theme', newTheme);
    localStorage.setItem('ahram_theme', newTheme);
    document.getElementById('themeIcon').className =
        newTheme === 'dark' ? 'fa-solid fa-sun text-warning' : 'fa-solid fa-moon text-dark';
}
document.addEventListener('DOMContentLoaded', () => {
    const theme = localStorage.getItem('ahram_theme') || 'light';
    document.getElementById('themeIcon').className =
        theme === 'dark' ? 'fa-solid fa-sun text-warning' : 'fa-solid fa-moon text-dark';
});
