/* exported toggleTheme, TRIPOLI_TZ, tripoliDateParts, tripoliDateValue, tripoliMonthValue, addTripoliDays, setTripoliDateInputs, allReportOperations, phoneReportLayout, toggleDateInput, lastReportData, lastReportRequest, reportLoadInFlight, queuedReportMode, reportSearchTimer, isPersonalExecutorReport, formatEgp, loadEmployeeFilter, fetchReport */
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
document.addEventListener('click', async (event) => {
    const button = event.target.closest('.retry-part-proof');
    if (!button) return;
    button.disabled = true;
    try {
        const response = await executorApiFetch(
            `/executor-portal/api/retry-part-proof/${button.dataset.tx}/${encodeURIComponent(button.dataset.part)}`,
            { method: 'POST' }
        );
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.success === false)
            throw new Error(data.error || 'تعذر إعادة إرسال الإثبات.');
        button.textContent = data.duplicate ? 'الإثبات مُرسل مسبقاً' : 'تمت إعادة الإرسال';
    } catch (error) {
        button.disabled = false;
        button.textContent = error.message || 'تعذر إعادة الإرسال';
    }
});

const TRIPOLI_TZ = 'Africa/Tripoli';

function tripoliDateParts(date = new Date()) {
    return new Intl.DateTimeFormat('en-GB', {
        timeZone: TRIPOLI_TZ,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    })
        .formatToParts(date)
        .reduce((acc, part) => {
            acc[part.type] = part.value;
            return acc;
        }, {});
}

function tripoliDateValue(date = new Date()) {
    const parts = tripoliDateParts(date);
    return `${parts.year}-${parts.month}-${parts.day}`;
}

function tripoliMonthValue(date = new Date()) {
    return tripoliDateValue(date).slice(0, 7);
}

function addTripoliDays(dateStr, delta) {
    const base = new Date(`${dateStr}T12:00:00+02:00`);
    base.setUTCDate(base.getUTCDate() + delta);
    return tripoliDateValue(base);
}

function setTripoliDateInputs() {
    const today = tripoliDateValue();
    document.getElementById('dateValueDay').value = today;
    if (document.getElementById('dateValueMonth')) {
        document.getElementById('dateValueMonth').value = tripoliMonthValue();
    }
    document.getElementById('dateFrom').value = today;
    document.getElementById('dateTo').value = today;
}

function allReportOperations(data) {
    const seen = new Set();
    const merged = [];
    [...(data.operations || []), ...(data.pendingOperations || [])].forEach((tx) => {
        const key = String(tx.id || tx.customId || '');
        if (key && seen.has(key)) return;
        if (key) seen.add(key);
        merged.push(tx);
    });
    merged.sort((left, right) => new Date(right.createdAt || 0) - new Date(left.createdAt || 0));
    return merged;
}

setTripoliDateInputs();
const phoneReportLayout = window.matchMedia('(max-width: 767.98px)').matches;
if (phoneReportLayout) {
    const today = tripoliDateValue();
    document.getElementById('dateType').value = 'range';
    document.getElementById('dateFrom').value = addTripoliDays(today, -6);
    document.getElementById('dateTo').value = today;
}

function toggleDateInput() {
    const type = document.getElementById('dateType').value;
    document.getElementById('dateValueDay').style.display = type === 'day' ? 'block' : 'none';
    if (document.getElementById('dateValueMonth'))
        document.getElementById('dateValueMonth').style.display = type === 'month' ? 'block' : 'none';
    document.getElementById('dateRangeInputs').classList.toggle('d-none', type !== 'range');
}
toggleDateInput();

let lastReportData = null;
let lastReportRequest = null;
let reportLoadInFlight = false;
let queuedReportMode = null;
let reportSearchTimer = null;
let isPersonalExecutorReport = window.executorPersonalReport;
const formatEgp = (value) =>
    `${Number(value || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })} ج.م`;

async function loadEmployeeFilter() {
    const select = document.getElementById('employeeFilter');
    if (!select) return;
    try {
        const response = await executorApiFetch('/executor-portal/reports/employees');
        const data = await readExecutorApiResponse(response);
        const requestedId = new URLSearchParams(window.location.search).get('employeeId') || '';
        (data.employees || [])
            .filter((employee) => employee.role !== 'manager')
            .forEach((employee) => {
                const option = document.createElement('option');
                option.value = employee.id;
                option.textContent = `${employee.name} - ${employee.role === 'accountant' ? 'محاسب' : 'موظف'}`;
                select.appendChild(option);
            });
        if ([...select.options].some((option) => option.value === requestedId)) select.value = requestedId;
    } catch {
        select.innerHTML = '<option value="">كل شركة التنفيذ</option>';
    }
}

async function fetchReport(searchOnly = false) {
    // يمنع تداخل طلب التحميل التلقائي مع ضغطة المستخدم، والذي قد يترك
    // الزر في حالة "جاري التحميل" رغم وصول البيانات.
    if (reportLoadInFlight) {
        queuedReportMode = searchOnly;
        return;
    }
    if (!searchOnly) {
        clearTimeout(reportSearchTimer);
        document.getElementById('reportSearch').value = '';
    }
    const dateType = document.getElementById('dateType').value;
    const dateValue =
        dateType === 'day'
            ? document.getElementById('dateValueDay').value
            : document.getElementById('dateValueMonth').value;
    const dateFrom = dateType === 'range' ? document.getElementById('dateFrom').value : '';
    const dateTo = dateType === 'range' ? document.getElementById('dateTo').value : '';
    const employeeId = document.getElementById('employeeFilter')?.value || '';
    const search = searchOnly ? document.getElementById('reportSearch')?.value.trim() || '' : '';

    if (
        !search &&
        ((dateType !== 'all' && dateType !== 'range' && !dateValue) ||
            (dateType === 'range' && (!dateFrom || !dateTo)))
    ) {
        return Swal.fire({ icon: 'warning', title: 'تنبيه', text: 'يرجى اختيار التاريخ.' });
    }
    if (!search && dateType === 'range' && dateFrom > dateTo)
        return Swal.fire({
            icon: 'warning',
            title: 'تنبيه',
            text: 'تاريخ البداية يجب أن يسبق تاريخ النهاية.',
        });

    const btn = document.getElementById('btnLoadReport');
    const originalBtnHtml = btn.innerHTML;
    reportLoadInFlight = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> جاري التحميل...';
    btn.disabled = true;

    try {
        const reportRequest = {
            dateType,
            dateValue,
            dateFrom,
            dateTo,
            employeeId: employeeId || null,
            search: search || null,
        };
        const res = await executorApiFetch('/executor-portal/reports/filter', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(reportRequest),
        });
        const data = await res.json();
        if (
            data.code === 'DEVICE_BINDING_MISMATCH' ||
            data.code === 'SECURITY_SESSION_EXPIRED' ||
            data.code === 'ADMIN_SESSION_REVOKED'
        ) {
            window.location.assign(`/login?security=${encodeURIComponent(data.code)}`);
            return;
        }
        if (!data.success) throw new Error(data.error);

        isPersonalExecutorReport = data.data.scope === 'employee';
        lastReportRequest = reportRequest;
        lastReportData = data.data;
        const searchHint = document.getElementById('reportSearchHint');
        if (searchHint)
            searchHint.textContent = search
                ? `نتائج البحث عن: ${search}`
                : 'تظهر النتائج المشابهة أثناء الكتابة.';
        document.getElementById('executorColumnHeader')?.classList.toggle('d-none', isPersonalExecutorReport);
        renderStats(data.data);
        renderOperations(data.data);
        // لا تجعل فشل الرسم البياني الخارجي يحجب نتائج التقرير وعملياته.
        document.getElementById('statsSection').classList.remove('d-none');
        document.getElementById('tableSection').classList.remove('d-none');
        document.getElementById('reportDownloadContainer').classList.toggle('d-none', Boolean(search));
        renderReportChart(data.data);
    } catch (e) {
        Swal.fire({ icon: 'error', title: 'خطأ', text: e.message || 'فشل جلب التقرير' });
    } finally {
        btn.innerHTML = originalBtnHtml;
        btn.disabled = false;
        reportLoadInFlight = false;
        if (queuedReportMode !== null) {
            const nextMode = queuedReportMode;
            queuedReportMode = null;
            fetchReport(nextMode);
        }
    }
}
