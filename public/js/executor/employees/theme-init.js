/* exported savedTheme */
const savedTheme = localStorage.getItem('ahram_theme') || 'light';
document.documentElement.setAttribute('data-theme', savedTheme);
document.documentElement.setAttribute('data-bs-theme', savedTheme);
