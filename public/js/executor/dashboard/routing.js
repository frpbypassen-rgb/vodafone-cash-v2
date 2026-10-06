/* exported copyText, escapeTaskHtml, liveTasksRequestId, manualTaskRoutingEnabled, renderManualRoutingControl, toggleManualRouting, routeTask */
// 📋 النسخ الذكي
function copyText(text, element) {
    if (!text || text === '---') return;
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text);
    else {
        let t = document.createElement('textarea');
        t.value = text;
        t.style.position = 'fixed';
        t.style.left = '-9999px';
        document.body.appendChild(t);
        t.focus();
        t.select();
        try {
            document.execCommand('copy');
        } catch {}
        t.remove();
    }

    const originalHtml = element.innerHTML;
    element.style.borderColor = 'var(--accent-green)';
    element.style.background = 'rgba(16, 185, 129, 0.1)';
    element.innerHTML =
        '<b class="val-phone text-success m-auto"><i class="fa-solid fa-check"></i> نُسخ!</b>';
    setTimeout(() => {
        element.innerHTML = originalHtml;
        element.style.borderColor = '';
        element.style.background = '';
    }, 1000);
}

const escapeTaskHtml = (value) =>
    String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');

// 📡 جلب البيانات وفرز الكروت الديناميكي (Smart Sorting FIFO)
let liveTasksRequestId = 0;
let manualTaskRoutingEnabled = false;

function renderManualRoutingControl() {
    const toggle = document.getElementById('manualRoutingToggle');
    const hint = document.getElementById('manualRoutingHint');
    if (!toggle || !hint) return;
    if (manualTaskRoutingEnabled) {
        toggle.className = 'btn btn-primary fw-bold rounded-3 px-3';
        toggle.innerHTML = '<i class="fa-solid fa-toggle-on me-1"></i> مفعل';
        hint.textContent = 'المهام الجديدة لا تظهر للموظفين قبل توجيهها إلى منفذ محدد.';
    } else {
        toggle.className = 'btn btn-outline-primary fw-bold rounded-3 px-3';
        toggle.innerHTML = '<i class="fa-solid fa-toggle-off me-1"></i> تفعيل';
        hint.textContent = 'عند تفعيله لا تظهر المهام للموظفين قبل توجيهها بالاسم.';
    }
}

async function toggleManualRouting() {
    if (!isExecutorManager) return;
    const toggle = document.getElementById('manualRoutingToggle');
    if (toggle) toggle.disabled = true;
    try {
        const response = await executorApiFetch('/executor-portal/api/task-routing-mode', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: !manualTaskRoutingEnabled }),
        });
        const data = await readExecutorApiResponse(response);
        manualTaskRoutingEnabled = Boolean(data.manualTaskRoutingEnabled);
        renderManualRoutingControl();
        await refreshTasks();
    } catch (error) {
        Swal.fire('تعذر تحديث التوجيه', error.message, 'error');
    } finally {
        if (toggle) toggle.disabled = false;
    }
}

async function routeTask(id) {
    try {
        const candidatesResponse = await executorApiFetch('/executor-portal/api/route-candidates');
        const candidatesData = await readExecutorApiResponse(candidatesResponse);
        const candidates = Array.isArray(candidatesData.employees) ? candidatesData.employees : [];
        if (candidates.length === 0) {
            throw new Error('لا يوجد موظف تنفيذ أو منفّذ خارجي نشط يمكن توجيه العملية إليه.');
        }
        const options = Object.fromEntries(
            candidates.map((employee) => {
                const roleLabel =
                    employee.roleLabel || (employee.role === 'external' ? 'منفّذ خارجي' : 'موظف تنفيذ');
                return [employee._id, `${employee.name} — ${roleLabel}`];
            })
        );
        const { value: employeeId } = await Swal.fire({
            title: 'توجيه العملية',
            text: 'اختر موظف التنفيذ أو المنفّذ الخارجي الذي ستظهر له العملية ليقبلها وينفذها.',
            input: 'select',
            inputOptions: options,
            inputPlaceholder: 'اختر المنفذ',
            showCancelButton: true,
            confirmButtonText: 'توجيه',
            cancelButtonText: 'إلغاء',
            confirmButtonColor: '#0ea5e9',
            inputValidator: (value) => (value ? undefined : 'اختر المنفذ أولاً.'),
        });
        if (!employeeId) return;
        const response = await executorApiFetch('/executor-portal/api/route-task/' + id, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ employeeId }),
        });
        const result = await readExecutorApiResponse(response);
        await Swal.fire(
            'تم التوجيه',
            `أصبحت العملية ظاهرة للمنفذ: ${result.employee?.name || ''}`,
            'success'
        );
        await refreshTasks();
    } catch (error) {
        Swal.fire('تعذر توجيه العملية', error.message, 'error');
    }
}
