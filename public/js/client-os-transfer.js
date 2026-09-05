(function initClientOsTransfer(global) {
    'use strict';

    function els() {
        return {
            steps: document.getElementById('clientOsWizardSteps'),
            review: document.getElementById('clientOsTransferReview'),
            reviewGrid: document.getElementById('clientOsReviewGrid'),
            reviewBack: document.getElementById('clientOsReviewBack'),
            reviewConfirm: document.getElementById('clientOsReviewConfirm'),
            modal: document.getElementById('transferModal'),
            form: document.getElementById('transferForm')
        };
    }

    function setStep(step) {
        const root = els().steps;
        if (!root) return;
        root.querySelectorAll('li').forEach((item) => {
            const n = Number(item.getAttribute('data-step'));
            item.classList.toggle('is-active', n === step);
            item.classList.toggle('is-done', n < step);
        });
    }

    function visibleTransferBlocks() {
        const ids = [
            'desktop-transfer-services-grid',
            'desktop-transfer-form-view',
            'mobile-transfer-services-grid',
            'mobile-transfer-form-view'
        ];
        return ids.map((id) => document.getElementById(id)).filter(Boolean);
    }

    function hideReview() {
        const e = els();
        if (e.review) e.review.hidden = true;
        visibleTransferBlocks().forEach((node) => {
            node.hidden = false;
            if (node.id.includes('form-view')) node.style.display = node.style.display === 'none' ? 'none' : 'block';
            else node.style.display = node.style.display === 'none' ? 'none' : 'block';
        });
        const onForm = ['desktop-transfer-form-view', 'mobile-transfer-form-view'].some((id) => {
            const node = document.getElementById(id);
            return node && node.style.display !== 'none' && !node.hidden;
        });
        setStep(onForm ? 2 : 1);
    }

    function showReview(summary) {
        const e = els();
        if (!e.review || !e.reviewGrid) return false;
        e.reviewGrid.innerHTML = summary.map(([label, value]) => `
            <div class="client-os-review-row"><span>${label}</span><strong dir="auto">${value}</strong></div>
        `).join('');
        visibleTransferBlocks().forEach((node) => { node.hidden = true; });
        e.review.hidden = false;
        setStep(3);
        return true;
    }

    function buildSummary() {
        const esc = (v) => String(v ?? '—').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
        return [
            ['الخدمة', esc(global.currentTransferType)],
            ['المستفيد', esc(document.getElementById('tf_beneficiary')?.value || '—')],
            ['الحساب / الهاتف', esc(document.getElementById('tf_phone')?.value || document.getElementById('tf_governorate')?.value || '—')],
            ['القيمة', `${esc(document.getElementById('tf_amount')?.value || '0')} EGP`],
            ['التكلفة', `${esc(document.getElementById('tf_amount_lyd')?.value || '0')} LYD`],
            ['سعر الصرف', esc(document.getElementById('tf_service_rate')?.textContent || '—')]
        ];
    }

    function wrapNav(name, step) {
        const original = global[name];
        if (typeof original !== 'function') return;
        global[name] = function (...args) {
            const out = original.apply(this, args);
            setStep(step);
            if (step === 1 || step === 2) hideReview();
            return out;
        };
    }

    function bind() {
        const e = els();
        e.reviewBack?.addEventListener('click', hideReview);
        e.reviewConfirm?.addEventListener('click', () => {
            global.transferReviewConfirmed = true;
            setStep(4);
            e.form?.requestSubmit?.();
        });
        e.modal?.addEventListener('hidden.bs.modal', () => {
            global.transferReviewConfirmed = false;
            hideReview();
            setStep(1);
        });
    }

    global.ClientOsTransfer = {
        setStep,
        showReviewFromForm() {
            return showReview(buildSummary());
        },
        onSent() { setStep(4); }
    };

    function init() {
        bind();
        setStep(1);
        wrapNav('selectTransferServiceDesktop', 2);
        wrapNav('selectTransferService', 2);
        wrapNav('goBackToServicesDesktop', 1);
        wrapNav('goBackToServices', 1);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})(window);
