'use strict';

(() => {
    const body = document.body;
    const banner = document.createElement('div');
    banner.className = 'client-network-guard';
    banner.hidden = true;
    banner.innerHTML = '<i class="fa-solid fa-wifi"></i><strong>لا يوجد اتصال — تم إيقاف إرسال التحويلات حتى عودة الشبكة.</strong>';
    body.appendChild(banner);

    const sensitiveCover = document.createElement('div');
    sensitiveCover.className = 'client-visual-shield';
    sensitiveCover.hidden = true;
    sensitiveCover.innerHTML = '<i class="fa-solid fa-eye-slash"></i><strong>البيانات الحساسة مخفية</strong><button type="button">إظهار البيانات</button>';
    body.appendChild(sensitiveCover);
    sensitiveCover.querySelector('button').addEventListener('click', () => { sensitiveCover.hidden = true; });

    const updateNetwork = () => {
        const offline = !navigator.onLine;
        banner.hidden = !offline;
        document.querySelectorAll('#transferModal button[type="submit"], form[action*="transfer"] button[type="submit"]').forEach((button) => {
            button.disabled = offline;
        });
    };
    window.addEventListener('online', updateNetwork);
    window.addEventListener('offline', updateNetwork);
    updateNetwork();

    let lastShakeAt = 0;
    window.addEventListener('devicemotion', (event) => {
        const acceleration = event.accelerationIncludingGravity;
        const strength = Math.abs(acceleration?.x || 0) + Math.abs(acceleration?.y || 0) + Math.abs(acceleration?.z || 0);
        if (strength > 34 && Date.now() - lastShakeAt > 2500) {
            lastShakeAt = Date.now();
            sensitiveCover.hidden = false;
        }
    });
})();
