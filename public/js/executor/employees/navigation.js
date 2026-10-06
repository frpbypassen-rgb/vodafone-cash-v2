document.addEventListener('DOMContentLoaded', () => {
    const path = window.location.pathname;
    if (path.includes('/dashboard')) {
        document.getElementById('nav-dash')?.classList.add('active');
    } else if (path.includes('/reports')) {
        document.getElementById('nav-rep')?.classList.add('active');
    } else if (path.includes('/employees')) {
        document.getElementById('nav-emp')?.classList.add('active');
    }
});
