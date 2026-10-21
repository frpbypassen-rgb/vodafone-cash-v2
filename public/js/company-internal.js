(() => {
    'use strict';
    if (document.documentElement.dataset.portal !== 'company') return;
    const form = document.getElementById('businessTransferForm');
    if (form) {
        const recipient = document.getElementById('transferDestination');
        const amount = document.getElementById('transferAmount');
        const currency = document.getElementById('transferAmountCurrency');
        const syncSummary = () => {
            const name = document.getElementById('transferBeneficiary');
            const number = recipient?.value?.trim();
            const recipientOutput = form.querySelector('[data-cm-recipient]');
            const amountOutput = form.querySelector('[data-cm-amount]');
            if (recipientOutput) recipientOutput.textContent = number || name?.value?.trim() || '—';
            if (amountOutput) amountOutput.textContent = Number(amount?.value) > 0 ? Number(amount.value).toLocaleString('en-US', { maximumFractionDigits: 2 }) + ' ' + (currency?.textContent || '') : '—';
            const cost = document.getElementById('costEstimate');
            form.querySelectorAll('[data-cm-cost]').forEach(output => { output.textContent = cost?.textContent || '0.000 LYD'; });
            const amountLabel = document.getElementById('transferAmountLabel');
            if (amountLabel && currency?.textContent?.includes('سوداني')) amountLabel.textContent = 'المبلغ بالجنيه السوداني';
        };
        form.addEventListener('input', syncSummary);
        form.addEventListener('change', syncSummary);
        form.addEventListener('reset', () => window.setTimeout(syncSummary, 0));
        // The existing transfer controller owns conversion and validation.
        const estimate = document.getElementById('costEstimate');
        if (estimate) new MutationObserver(syncSummary).observe(estimate, { childList: true, subtree: true });
        syncSummary();
        ['transferSubtype', 'transferBankMethod'].forEach((id) => {
            const select = document.getElementById(id);
            if (!select) return;
            const options = document.createElement('div');
            options.className = 'cm-mode-options';
            options.setAttribute('role', 'group');
            options.setAttribute('aria-label', id === 'transferSubtype' ? 'نوع خدمة سيفا' : 'طريقة التحويل البنكي');
            [...select.options].filter(option => option.value && !option.disabled).forEach(option => {
                const button = document.createElement('button');
                button.type = 'button';
                button.textContent = option.textContent;
                button.dataset.value = option.value;
                button.addEventListener('click', () => {
                    select.value = option.value;
                    select.dispatchEvent(new Event('change', { bubbles: true }));
                });
                options.append(button);
            });
            // Buttons remain keyboard accessible; retain the select as the controller's value source.
            select.after(options);
            select.hidden = true;
            const validation = document.createElement('small');
            validation.className = 'cm-mode-validation';
            validation.setAttribute('role', 'alert');
            validation.hidden = true;
            options.after(validation);
            select.addEventListener('invalid', event => {
                event.preventDefault();
                validation.textContent = 'اختر طريقة التحويل للمتابعة.';
                validation.hidden = false;
                options.querySelector('button')?.focus();
            });
            const syncSelection = () => {
                options.querySelectorAll('button').forEach(button => button.setAttribute('aria-pressed', String(select.value === button.dataset.value)));
                if (select.value) validation.hidden = true;
            };
            select.addEventListener('change', syncSelection);
            form.addEventListener('reset', () => window.setTimeout(syncSelection, 0));
            syncSelection();
        });
    }
    const smartPreview = document.getElementById('smartTransferPreview');
    const periodSelect = document.querySelector('[name="centralDateType"]');
    if (periodSelect) {
        const syncPeriod = () => {
            const relevant = { centralDay: 'day', centralMonth: 'month', centralFrom: 'range', centralTo: 'range' };
            Object.entries(relevant).forEach(([name, period]) => {
                const input = document.querySelector('[name="' + name + '"]');
                if (input?.closest('label')) input.closest('label').hidden = periodSelect.value !== period;
            });
        };
        periodSelect.addEventListener('change', syncPeriod);
        syncPeriod();
    }
    const smartEmpty = document.querySelector('[data-cm-smart-empty]');
    if (smartPreview && smartEmpty) {
        const syncPreview = () => { smartEmpty.hidden = !smartPreview.hidden; };
        new MutationObserver(syncPreview).observe(smartPreview, { attributes: true, attributeFilter: ['hidden'] });
        syncPreview();
    }
    const settingsCards = document.querySelector('.cm-settings-categories');
    if (settingsCards) {
        const panels = [...document.querySelectorAll('.bw-settings-stack > .bw-settings-panel')];
        const back = document.querySelector('[data-settings-back]');
        const showSettings = () => {
            const panel = panels.find(item => '#' + item.id === window.location.hash);
            panels.forEach(item => { item.hidden = item !== panel; });
            settingsCards.hidden = Boolean(panel);
            if (back) back.hidden = !panel;
        };
        back?.addEventListener('click', () => { window.location.hash = 'settings'; });
        window.addEventListener('hashchange', showSettings);
        showSettings();
    }
    const securityCards = document.querySelector('.cm-security-cards');
    if (securityCards) {
        const section = document.querySelector('.bw-settings-security');
        const targets = [...document.querySelectorAll('#companyPassword,#companyMfa')];
        const showSecurity = () => {
            const active = targets.find(item => '#' + item.id === window.location.hash);
            if (section) section.hidden = !active;
            targets.forEach(item => { item.hidden = item !== active; });
        };
        window.addEventListener('hashchange', showSecurity);
        showSecurity();
    }
    const depositFilters = [...document.querySelectorAll('[data-deposit-filter]')];
    depositFilters.forEach(button => button.addEventListener('click', () => {
        const filter = button.dataset.depositFilter;
        const cards = [...document.querySelectorAll('[data-deposit-status]')];
        depositFilters.forEach(item => item.setAttribute('aria-pressed', String(item === button)));
        cards.forEach(card => { card.hidden = filter !== 'all' && card.dataset.depositStatus !== filter; });
        const empty = document.querySelector('[data-deposit-empty]');
        if (empty) empty.hidden = cards.some(card => !card.hidden);
    }));
})();
