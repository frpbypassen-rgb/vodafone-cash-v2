(() => {
    const setPushBusy = (busy) => {
        ['enablePush', 'disablePush'].forEach((id) => {
            const button = document.getElementById(id);
            if (button) button.disabled = busy;
        });
    };

    async function refreshPushStatus() {
        try {
            const status = await window.executorBrowserPush.status();
            const ready =
                status.supported && status.configured && status.subscribed && status.permission === 'granted';
            const unavailable = !status.supported || !status.configured;
            document.getElementById('pushStatusTitle').textContent = ready
                ? 'الإشعارات جاهزة على هذا الجهاز'
                : unavailable
                  ? 'خدمة الإشعارات غير متاحة'
                  : 'الإشعارات متوقفة';
            document.getElementById('pushStatusHint').textContent = ready
                ? 'يمكن استقبال تنبيهات المهام.'
                : status.permission === 'denied'
                  ? 'إذن المتصفح مرفوض.'
                  : 'فعّل الإشعارات لاستقبال التنبيهات.';
            document.getElementById('pushStatusPill').textContent = ready
                ? 'تعمل'
                : unavailable
                  ? 'غير متاحة'
                  : 'متوقفة';
            document
                .getElementById('pushStatusPill')
                .style.setProperty('--pill-color', ready ? 'var(--executor-green)' : 'var(--executor-red)');

            document.getElementById('enablePush').hidden = ready;
            document.getElementById('disablePush').hidden = !ready;

            const summaryPill = document.getElementById('pushSummaryPill');
            if (summaryPill) {
                summaryPill.textContent = ready ? 'تعمل' : 'غير مفعّلة';
                summaryPill.style.setProperty(
                    '--pill-color',
                    ready ? 'var(--executor-green)' : 'var(--executor-red)'
                );
            }
        } catch (_) {
            document.getElementById('pushStatusTitle').textContent = 'تعذر فحص الإشعارات';
            document.getElementById('pushStatusPill').textContent = 'غير متصل';
            document
                .getElementById('pushStatusPill')
                .style.setProperty('--pill-color', 'var(--executor-red)');
        }
    }

    const pushAction = async (action, successText) => {
        setPushBusy(true);
        try {
            await action();
            await refreshPushStatus();
            await Swal.fire({ icon: 'success', title: successText, timer: 1700, showConfirmButton: false });
        } catch (error) {
            await Swal.fire({
                icon: 'error',
                title: 'تعذر إكمال الطلب',
                text: error.message || 'حدث خطأ غير متوقع.',
            });
        } finally {
            setPushBusy(false);
        }
    };

    document
        .getElementById('enablePush')
        .addEventListener('click', () =>
            pushAction(() => window.executorBrowserPush.enable(), 'تم تفعيل إشعارات المتصفح')
        );
    document
        .getElementById('disablePush')
        .addEventListener('click', () =>
            pushAction(() => window.executorBrowserPush.disable(), 'تم إيقاف إشعارات هذا المتصفح')
        );
    document.getElementById('refreshOverview').addEventListener('click', () => window.location.reload());

    document.getElementById('manualRoutingSwitch')?.addEventListener('change', async (event) => {
        const input = event.currentTarget;
        input.disabled = true;
        try {
            const response = await executorApiFetch('/executor-portal/api/task-routing-mode', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: input.checked }),
            });
            const data = await readExecutorApiResponse(response);
            input.checked = data.manualTaskRoutingEnabled === true;
            document.getElementById('routingDescription').textContent = input.checked
                ? 'لا تظهر العملية للموظف إلا بعد أن يوجهها المدير إليه بالاسم.'
                : 'تظهر العمليات المتاحة للمدير والموظفين ويمكن لأول منفذ متاح قبولها.';
            Swal.fire({
                icon: 'success',
                title: 'تم تحديث وضع التوجيه',
                timer: 1400,
                showConfirmButton: false,
            });
        } catch (error) {
            input.checked = !input.checked;
            Swal.fire({ icon: 'error', title: 'تعذر تحديث التوجيه', text: error.message });
        } finally {
            input.disabled = false;
        }
    });

    document.getElementById('sessionTtlSwitch')?.addEventListener('change', (event) => {
        const hours = document.getElementById('sessionTtlHours');
        if (hours) hours.disabled = !event.currentTarget.checked;
    });

    document.getElementById('executionPolicyForm')?.addEventListener('submit', async (event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const button = form.querySelector('button[type="submit"]');
        if (button) button.disabled = true;
        try {
            const hours = Number(document.getElementById('sessionTtlHours')?.value || 8);
            const response = await executorApiFetch('/executor-portal/api/execution-policy', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    phoneLengthMode:
                        form.querySelector('input[name="phoneLengthMode"]:checked')?.value || 'all',
                    proofRequired: document.getElementById('proofRequiredSwitch')?.checked === true,
                    quickExecuteEnabled: document.getElementById('quickExecuteSwitch')?.checked === true,
                    maxConcurrentDevices: Number(document.getElementById('maxConcurrentDevices')?.value || 1),
                    sessionTtlEnabled: document.getElementById('sessionTtlSwitch')?.checked === true,
                    sessionTtlHours: hours,
                }),
            });
            await readExecutorApiResponse(response);
            Swal.fire({
                icon: 'success',
                title: 'تم حفظ صلاحيات الشركة',
                timer: 1500,
                showConfirmButton: false,
            });
        } catch (error) {
            Swal.fire({ icon: 'error', title: 'تعذر حفظ الصلاحيات', text: error.message });
        } finally {
            if (button) button.disabled = false;
        }
    });

    const activateSettingsTab = (tabId) => {
        document.querySelectorAll('[data-settings-tab]').forEach((btn) => {
            btn.classList.toggle('active', btn.dataset.settingsTab === tabId);
        });
        document.querySelectorAll('[data-settings-panel]').forEach((panel) => {
            panel.classList.toggle('active', panel.dataset.settingsPanel === tabId);
        });
        document.getElementById('settingsAccountOverview').hidden = tabId !== 'account';
    };

    document.querySelectorAll('[data-settings-tab]').forEach((button) => {
        button.addEventListener('click', () => activateSettingsTab(button.dataset.settingsTab));
    });

    const saveSettingsForm = (id, path, method, successText) => {
        document.getElementById(id)?.addEventListener('submit', async (event) => {
            event.preventDefault();
            const form = event.currentTarget;
            const values = Object.fromEntries(new FormData(form));
            if (id === 'settingsPasswordForm' && values.newPassword !== values.confirmPassword) {
                return Swal.fire({ icon: 'error', title: 'كلمتا المرور غير متطابقتين' });
            }
            const button = form.querySelector('button[type="submit"]');
            button.disabled = true;
            try {
                await readExecutorApiResponse(
                    await executorApiFetch(path, {
                        method,
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(values),
                    })
                );
                if (id === 'settingsPasswordForm') form.reset();
                await Swal.fire({
                    icon: 'success',
                    title: successText,
                    timer: 1600,
                    showConfirmButton: false,
                });
                if (id === 'settingsProfileForm') window.location.reload();
            } catch (error) {
                Swal.fire({ icon: 'error', title: 'تعذر الحفظ', text: error.message });
            } finally {
                button.disabled = false;
            }
        });
    };
    saveSettingsForm(
        'settingsProfileForm',
        '/executor-portal/api/settings/profile',
        'PATCH',
        'تم تحديث الحساب'
    );
    saveSettingsForm(
        'settingsPasswordForm',
        '/executor-portal/api/settings/password',
        'POST',
        'تم تغيير كلمة المرور'
    );

    const pinNetworks = new Set(['etisalat', 'orange', 'we']);
    const selectedUssdNetwork = () =>
        document.querySelector('input[name="ussdNetwork"]:checked')?.value || 'vodafone';
    const syncQuickExecutePinVisibility = () => {
        const wrap = document.getElementById('quickExecutePinWrap');
        const note = document.getElementById('quickExecuteSecurityNote');
        const needsPin = pinNetworks.has(selectedUssdNetwork());
        if (wrap) wrap.hidden = !needsPin;
        if (note) note.hidden = !needsPin;
    };
    document.querySelectorAll('input[name="ussdNetwork"]').forEach((input) => {
        input.addEventListener('change', syncQuickExecutePinVisibility);
    });
    syncQuickExecutePinVisibility();

    document.getElementById('quickExecuteForm')?.addEventListener('submit', async (event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const button = form.querySelector('button[type="submit"]');
        if (button) button.disabled = true;
        try {
            const pin = document.getElementById('quickExecutePin')?.value || '';
            const payload = { network: selectedUssdNetwork() };
            if (pin.trim()) payload.pin = pin.trim();
            await readExecutorApiResponse(
                await executorApiFetch('/executor-portal/api/quick-execute', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                })
            );
            const pinInput = document.getElementById('quickExecutePin');
            if (pinInput) pinInput.value = '';
            Swal.fire({
                icon: 'success',
                title: 'تم حفظ إعداد التنفيذ السريع',
                timer: 1500,
                showConfirmButton: false,
            });
        } catch (error) {
            Swal.fire({ icon: 'error', title: 'تعذر الحفظ', text: error.message });
        } finally {
            if (button) button.disabled = false;
        }
    });

    document.getElementById('quickExecuteClearPin')?.addEventListener('click', async () => {
        const confirmed = await Swal.fire({
            icon: 'warning',
            title: 'حذف رقم السر؟',
            text: 'سيتم حذف رقم سر المحفظة المحفوظ مشفراً من الحساب.',
            showCancelButton: true,
            confirmButtonText: 'حذف',
            cancelButtonText: 'إلغاء',
        });
        if (!confirmed.isConfirmed) return;
        try {
            await readExecutorApiResponse(
                await executorApiFetch('/executor-portal/api/quick-execute', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ clearPin: true, network: selectedUssdNetwork() }),
                })
            );
            document.getElementById('quickExecuteClearPin').hidden = true;
            Swal.fire({ icon: 'success', title: 'تم حذف رقم السر', timer: 1400, showConfirmButton: false });
        } catch (error) {
            Swal.fire({ icon: 'error', title: 'تعذر الحذف', text: error.message });
        }
    });

    refreshPushStatus();
})();
