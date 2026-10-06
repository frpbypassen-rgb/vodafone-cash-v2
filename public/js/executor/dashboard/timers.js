/* exported STUCK_ASSIGNEE_SLA_SECONDS */
// ⏱️ تحديث العدادات الزمنية بشكل حي في الشاشة
const STUCK_ASSIGNEE_SLA_SECONDS = 90;
setInterval(() => {
    document.querySelectorAll('.live-timer').forEach((el) => {
        const createdTime = new Date(el.getAttribute('data-time')).getTime();
        const diffMs = Date.now() - createdTime;
        const diffSec = Math.floor(diffMs / 1000);

        if (diffSec >= 0) {
            let text = '';
            if (diffSec < 60) text = `${diffSec} ثانية`;
            else {
                const m = Math.floor(diffSec / 60);
                const s = diffSec % 60;
                text = `${m} دقيقة و ${s} ث`;
            }
            el.innerText = text;

            if (diffSec >= 120) {
                el.style.color = 'var(--accent-red)';
                el.classList.add('is-overdue');
                el.classList.remove('fa-fade');
            } else if (diffSec >= 60) {
                el.style.color = 'var(--accent-gold)';
                el.classList.remove('is-overdue', 'fa-fade');
            } else {
                el.style.color = 'var(--text-main)';
                el.classList.remove('is-overdue', 'fa-fade');
            }
        }
    });
    document.querySelectorAll('.executor-sla-hint[data-assigned-at]').forEach((el) => {
        const assignedMs = new Date(el.getAttribute('data-assigned-at')).getTime();
        if (!Number.isFinite(assignedMs)) {
            el.hidden = true;
            return;
        }
        const waited = Math.floor((Date.now() - assignedMs) / 1000);
        if (waited < STUCK_ASSIGNEE_SLA_SECONDS) {
            el.hidden = true;
            return;
        }
        const minutes = Math.max(1, Math.round(waited / 60));
        const label = el.querySelector('span');
        if (label) label.textContent = `معلّقة عنده منذ ${minutes} د — قد تحتاج إعادة توجيه`;
        el.hidden = false;
    });
}, 1000);
