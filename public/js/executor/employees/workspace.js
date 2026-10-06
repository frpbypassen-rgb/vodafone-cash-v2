/* exported toggleTheme, employeesCache, poolsCache, solosCache, companyExecutionPolicyCache, companyBalancesCache, escapeEmployeeHtml */
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
    loadEmployees();
});

// إنشاء موظف جديد
document.getElementById('createForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    const name = document.getElementById('empName').value.trim();
    const phone = document.getElementById('empPhone').value.trim();
    const role = document.getElementById('empRole').value;
    const username = document.getElementById('empUsername').value.trim();
    const password = document.getElementById('empPassword').value.trim();
    const balancePoolId = role === 'external' ? document.getElementById('empPoolId')?.value || '' : '';

    if (!name || !phone || !username || !password) {
        return Swal.fire('تنبيه', 'يرجى ملء جميع الحقول المطلوبة', 'warning');
    }

    Swal.fire({ title: 'جاري الإنشاء...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });

    try {
        const res = await executorApiFetch('/executor-portal/api/employees/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name,
                phone,
                role,
                webUsername: username,
                webPassword: password,
                balancePoolId,
            }),
        });
        const data = await readExecutorApiResponse(res);
        if (data.success) {
            const poolWarning = data.poolAttachError
                ? `<p class="small text-warning mt-3 mb-0">الحساب أُنشئ منفردًا: ${String(data.poolAttachError).replace(/[&<>]/g, '')} يمكنك ربطه بمجموعة رصيد من القسم أعلاه.</p>`
                : '';
            Swal.fire({
                icon: data.poolAttachError ? 'warning' : 'success',
                title: 'تم إنشاء الحساب بنجاح!',
                html: `<div class="text-start p-3 mt-2 rounded" style="background: rgba(0,0,0,0.1); border: 1px dashed var(--accent-green);">
                        <div class="mb-2"><span class="small d-block" style="color: var(--text-muted);">اسم المستخدم:</span><span class="fs-5 font-monospace fw-bold" dir="ltr">${data.username}</span></div>
                        <div><span class="small d-block" style="color: var(--text-muted);">كلمة المرور:</span><span class="fs-5 font-monospace fw-bold" dir="ltr">${password}</span></div>
                    </div>${poolWarning}`,
                confirmButtonColor: '#10b981',
            });
            document.getElementById('createForm').reset();
            document.getElementById('externalPoolField')?.setAttribute('hidden', 'hidden');
            loadEmployees();
        } else {
            Swal.fire('خطأ', data.error || 'حدث خطأ أثناء الإنشاء', 'error');
        }
    } catch (e) {
        Swal.fire('خطأ', e.message || 'تعذر الاتصال بالخادم', 'error');
    }
});

let employeesCache = [];
let poolsCache = [];
let solosCache = [];
let companyExecutionPolicyCache = null;
let companyBalancesCache = window.executorEmployeeBalances;
const escapeEmployeeHtml = (value) =>
    String(value ?? '').replace(
        /[&<>"']/g,
        (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[char]
    );

document.getElementById('empRole')?.addEventListener('change', () => {
    const field = document.getElementById('externalPoolField');
    if (!field) return;
    field.toggleAttribute('hidden', document.getElementById('empRole').value !== 'external');
});
