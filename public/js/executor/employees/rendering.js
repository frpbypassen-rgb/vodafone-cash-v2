/* exported formatEgp, setChipAmount, applyBalanceSummary, soloExternals, eligibleExternalsForPool, fillCreatePoolSelect, renderPools, employeeDuration, employeeLastSeen, renderEmployees, loadEmployees */
function formatEgp(value) {
    return Number(value || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function setChipAmount(elementId, value) {
    const strong = document.getElementById(elementId)?.querySelector('strong');
    if (strong) strong.textContent = `${formatEgp(value)} ج.م`;
}

function applyBalanceSummary(summary) {
    if (!summary) return;
    if (summary.totalBalance != null) companyBalancesCache.totalBalance = Number(summary.totalBalance);
    if (summary.privateBalance != null) companyBalancesCache.privateBalance = Number(summary.privateBalance);
    if (summary.totalBalance != null && document.getElementById('summaryTotalBalance')) {
        document.getElementById('summaryTotalBalance').textContent = formatEgp(summary.totalBalance);
    }
    if (summary.privateBalance != null && document.getElementById('summaryPrivateBalance')) {
        document.getElementById('summaryPrivateBalance').textContent = formatEgp(summary.privateBalance);
    }
    if (summary.totalBalance != null) setChipAmount('executorTotalBalance', summary.totalBalance);
    if (summary.privateBalance != null) setChipAmount('executorManagerBalance', summary.privateBalance);
}

function soloExternals() {
    if (Array.isArray(solosCache) && solosCache.length) {
        return solosCache.filter((employee) => employee.status !== 'suspended');
    }
    return employeesCache.filter((employee) => employee.role === 'external' && !employee.balancePool);
}

function eligibleExternalsForPool(poolId) {
    return employeesCache.filter((employee) => {
        if (employee.role !== 'external' || employee.status !== 'active') return false;
        const currentPoolId = employee.balancePool?.id || '';
        return !currentPoolId || currentPoolId === poolId;
    });
}

function fillCreatePoolSelect() {
    const select = document.getElementById('empPoolId');
    if (!select) return;
    const current = select.value;
    select.innerHTML =
        '<option value="">منفرد — بدون مجموعة رصيد</option>' +
        poolsCache
            .map((pool) => `<option value="${pool.id}">${escapeEmployeeHtml(pool.name)}</option>`)
            .join('');
    if (current && [...select.options].some((option) => option.value === current)) select.value = current;
}

function renderPools() {
    const list = document.getElementById('poolList');
    const empty = document.getElementById('poolEmpty');
    const soloList = document.getElementById('soloList');
    const soloEmpty = document.getElementById('soloEmpty');
    if (!list) return;
    list.innerHTML = '';
    empty?.classList.toggle('d-none', poolsCache.length > 0);
    poolsCache.forEach((pool) => {
        const members = pool.members || [];
        const canAttach = eligibleExternalsForPool(pool.id).some(
            (employee) => (employee.balancePool?.id || '') !== pool.id
        );
        const canArchive = members.length === 0 && Number(pool.balance || 0) <= 0;
        const memberRows = members.length
            ? `<ul class="pool-members">${members
                  .map(
                      (member) => `<li class="pool-member">
                    <span class="pool-member-name">${escapeEmployeeHtml(member.name)}</span>
                    <button type="button" class="btn-action btn-delete" onclick="detachPoolMember('${pool.id}', '${member.id}', '${encodeURIComponent(member.name)}', ${members.length})"><i class="fa-solid fa-link-slash"></i> فصل</button>
                </li>`
                  )
                  .join('')}</ul>`
            : '<p class="pool-empty-members">بدون أعضاء بعد — أضف منفّذًا خارجيًا منفردًا ليشارك هذا الرصيد.</p>';
        list.innerHTML += `<article class="pool-card" data-pool-id="${pool.id}">
                <div class="pool-card-head">
                    <div>
                        <span class="pool-kicker">مجموعة رصيد</span>
                        <h3>${escapeEmployeeHtml(pool.name)}</h3>
                    </div>
                    <div class="pool-balance">
                        <small>رصيد المجموعة</small>
                        <strong class="${Number(pool.balance || 0) < 0 ? 'balance-negative' : 'balance-positive'}" dir="ltr">${formatEgp(pool.balance)} ج.م</strong>
                    </div>
                </div>
                ${memberRows}
                <div class="pool-card-actions">
                    <button type="button" class="btn-action" onclick="attachPoolMember('${pool.id}')" ${canAttach ? '' : 'disabled'} title="${canAttach ? 'إضافة منفّذ خارجي منفرد' : 'لا يوجد منفّذ خارجي منفرد يمكن إضافته. افصل المنفّذ من مجموعته أولاً.'}"><i class="fa-solid fa-user-plus"></i> إضافة منفّذ خارجي</button>
                    <button type="button" class="btn-action" onclick="renameBalancePool('${pool.id}', '${encodeURIComponent(pool.name)}')"><i class="fa-solid fa-pen"></i> إعادة تسمية</button>
                    <button type="button" class="btn-action btn-delete" onclick="archiveBalancePool('${pool.id}', '${encodeURIComponent(pool.name)}')" ${canArchive ? '' : 'disabled'} title="${canArchive ? 'أرشفة المجموعة الفارغة' : 'ارشف فقط مجموعة بلا أعضاء وبلا رصيد. افصل آخر عضو لنقل الرصيد المتبقي إليه.'}"><i class="fa-solid fa-box-archive"></i> أرشفة</button>
                </div>
            </article>`;
    });
    if (soloList) {
        const solos = soloExternals();
        soloList.innerHTML = '';
        soloEmpty?.classList.toggle('d-none', solos.length > 0);
        solos.forEach((employee) => {
            const employeeId = employee.id || employee._id;
            const encodedName = encodeURIComponent(employee.name || '');
            const balanceValue = Number(
                employee.workingBalance != null ? employee.workingBalance : employee.balance || 0
            );
            soloList.innerHTML += `<article class="solo-card" data-solo-id="${employeeId}">
                    <div class="solo-card-head">
                        <div>
                            <span class="solo-kicker">منفّذ خارجي · منفرد</span>
                            <div class="solo-card-name">${escapeEmployeeHtml(employee.name)}</div>
                        </div>
                        <div class="solo-balance">
                            <small>رصيده المنفرد</small>
                            <strong class="${balanceValue < 0 ? 'balance-negative' : 'balance-positive'}" dir="ltr">${formatEgp(balanceValue)} ج.م</strong>
                        </div>
                    </div>
                    <div class="solo-card-actions">
                        <button type="button" class="btn-action" style="color:var(--executor-green)" onclick="externalTransaction('${employeeId}', '${encodedName}', 'deposit')"><i class="fa-solid fa-arrow-down"></i> تمويل</button>
                        <button type="button" class="btn-action" style="color:var(--executor-red)" onclick="externalTransaction('${employeeId}', '${encodedName}', 'deduction')"><i class="fa-solid fa-arrow-up"></i> خصم</button>
                    </div>
                </article>`;
        });
    }
    fillCreatePoolSelect();
}
const employeeDuration = (seconds) => {
    if (!Number.isFinite(Number(seconds))) return '---';
    const value = Number(seconds);
    return value >= 60 ? `${Math.floor(value / 60)}د ${value % 60}ث` : `${value}ث`;
};
const employeeLastSeen = (value) =>
    value
        ? new Date(value).toLocaleString('ar-LY', {
              timeZone: 'Africa/Tripoli',
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
          })
        : 'لم يسجل حضورًا';

function renderEmployees() {
    const query = document.getElementById('employeeSearch').value.trim().toLowerCase();
    const roleFilter = document.getElementById('employeeRoleFilter').value;
    const employees = employeesCache.filter((employee) => {
        const haystack =
            `${employee.name || ''} ${employee.webUsername || ''} ${employee.phone || ''}`.toLowerCase();
        return (!query || haystack.includes(query)) && (!roleFilter || employee.role === roleFilter);
    });
    const tbody = document.getElementById('empTableBody');
    const mobileList = document.getElementById('mobileEmpList');
    const emptyState = document.getElementById('emptyState');
    document.getElementById('empCount').textContent = employees.length;
    tbody.innerHTML = '';
    if (mobileList) mobileList.innerHTML = '';
    emptyState.classList.toggle('d-none', employees.length > 0);

    employees.forEach((employee) => {
        const employeeId = employee.id || employee._id;
        const roleLabel =
            employee.role === 'operator'
                ? 'موظف تنفيذ'
                : employee.role === 'accountant'
                  ? 'محاسب'
                  : employee.role === 'external'
                    ? 'منفّذ خارجي'
                    : 'مدير';
        const roleClass =
            employee.role === 'operator'
                ? 'role-operator'
                : employee.role === 'accountant'
                  ? 'role-accountant'
                  : employee.role === 'external'
                    ? 'role-external'
                    : 'role-manager';
        const statusIcon =
            employee.status === 'active'
                ? '<i class="fa-solid fa-circle-check status-active"></i> فعّال'
                : '<i class="fa-solid fa-circle-xmark status-suspended"></i> معلق';
        const toggleClass = employee.status === 'active' ? 'btn-toggle-active' : 'btn-toggle-suspended';
        const toggleIcon = employee.status === 'active' ? 'fa-ban' : 'fa-check';
        const toggleTitle = employee.status === 'active' ? 'تعليق' : 'تفعيل';
        const presence = employee.presence || {};
        const metrics = employee.metrics || {};
        const presenceHtml = presence.isOnline
            ? '<span class="executor-status-pill" style="--pill-color:var(--executor-green)"><i class="fa-solid fa-circle"></i> متصل</span>'
            : `<span class="small text-muted">${employeeLastSeen(presence.lastSeenAt)}</span>`;
        const currentTaskHtml = employee.currentTask
            ? `<span class="executor-status-pill" style="--pill-color:var(--executor-gold)"><i class="fa-solid fa-bolt"></i> ${escapeEmployeeHtml(employee.currentTask.customId || 'مهمة جارية')}</span>`
            : '<span class="small text-muted">متاح</span>';
        const performanceHtml = `<div class="d-grid gap-1"><strong>${Number(metrics.completedCount || 0)} عملية</strong><small class="text-muted">${Number(metrics.totalEGP || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })} ج.م · متوسط ${employeeDuration(metrics.averageDurationSeconds)}</small></div>`;
        const pool = employee.balancePool;
        const membershipLabel =
            employee.role === 'external' ? (pool ? `مجموعة رصيد «${pool.name}»` : 'منفّذ خارجي منفرد') : '';
        const balanceValue = Number(
            employee.workingBalance != null ? employee.workingBalance : employee.balance || 0
        );
        const membershipPill =
            employee.role === 'external'
                ? `<span class="membership-pill ${pool ? 'is-pool' : 'is-solo'}">${escapeEmployeeHtml(membershipLabel)}</span>`
                : '';
        const balanceHtml =
            employee.role === 'external'
                ? `<span class="${balanceValue < 0 ? 'balance-negative' : 'balance-positive'}" dir="ltr">${balanceValue.toLocaleString('en-US', { maximumFractionDigits: 2 })} ج.م</span><div class="small mt-1">${membershipPill}</div>`
                : '<span class="balance-muted">—</span>';
        const encodedName = encodeURIComponent(employee.name || '');
        const encodedPhone = encodeURIComponent(employee.phone || '');
        const externalActions =
            employee.role === 'external'
                ? `
                <button onclick="externalTransaction('${employeeId}', '${encodedName}', 'deposit')" class="btn-action" style="color:var(--executor-green)" title="تمويل منفّذ خارجي من الرصيد الخاص"><i class="fa-solid fa-arrow-down"></i></button>
                <button onclick="externalTransaction('${employeeId}', '${encodedName}', 'deduction')" class="btn-action" style="color:var(--executor-red)" title="خصم من المنفّذ الخارجي"><i class="fa-solid fa-arrow-up"></i></button>`
                : '';
        const actions =
            employee.role !== 'manager'
                ? `
                <button onclick="editEmployee('${employeeId}', '${encodedName}', '${encodedPhone}')" class="btn-action" title="تعديل البيانات"><i class="fa-solid fa-pen"></i></button>
                <button onclick="toggleEmployee('${employeeId}')" class="btn-action ${toggleClass}" title="${toggleTitle}"><i class="fa-solid ${toggleIcon}"></i></button>
                <a href="/executor-portal/reports?employeeId=${employeeId}" class="btn-action" title="تقرير الموظف"><i class="fa-solid fa-chart-line"></i></a>
                ${externalActions}
                <button onclick="resetPassword('${employeeId}', '${encodedName}')" class="btn-action btn-reset" title="إعادة تعيين كلمة المرور"><i class="fa-solid fa-key"></i></button>
                <button onclick="deleteEmployee('${employeeId}', '${encodedName}')" class="btn-action btn-delete" title="أرشفة"><i class="fa-solid fa-box-archive"></i></button>`
                : '<span class="small text-muted">حساب المدير</span>';

        tbody.innerHTML += `<tr>
                <td class="fw-bold">${escapeEmployeeHtml(employee.name)}</td>
                <td dir="ltr" class="font-monospace small">${escapeEmployeeHtml(employee.webUsername || '---')}</td>
                <td dir="ltr">${escapeEmployeeHtml(employee.phone || '---')}</td>
                <td><span class="role-badge ${roleClass}">${roleLabel}</span></td>
                <td>${balanceHtml}</td>
                <td><div class="d-grid gap-1">${statusIcon}${presenceHtml}${currentTaskHtml}</div></td>
                <td>${performanceHtml}</td>
                <td><div class="emp-actions">${actions}</div></td>
            </tr>`;

        if (mobileList) {
            mobileList.innerHTML += `<article class="mobile-emp-card">
                    <div class="mobile-emp-header"><div><span class="emp-card-name">${escapeEmployeeHtml(employee.name)}</span><div class="emp-card-username text-muted">${escapeEmployeeHtml(employee.webUsername || '---')}</div></div><span class="role-badge ${roleClass}">${roleLabel}</span></div>
                    <div class="mobile-emp-body">
                        <div class="emp-info-item"><span class="info-label"><i class="fa-solid fa-phone"></i> الهاتف</span><span class="info-value" dir="ltr">${escapeEmployeeHtml(employee.phone || '---')}</span></div>
                        ${employee.role === 'external' ? `<div class="emp-info-item"><span class="info-label"><i class="fa-solid fa-wallet"></i> ${pool ? 'رصيد المجموعة' : 'رصيده المنفرد'}</span><span class="info-value">${balanceHtml}</span></div>` : ''}
                        <div class="emp-info-item"><span class="info-label"><i class="fa-solid fa-circle-info"></i> الحالة</span><span class="info-value">${statusIcon}</span></div>
                        <div class="emp-info-item"><span class="info-label"><i class="fa-solid fa-signal"></i> التوفر</span><span class="info-value">${presenceHtml}</span></div>
                        <div class="emp-info-item"><span class="info-label"><i class="fa-solid fa-list-check"></i> المهمة الحالية</span><span class="info-value">${currentTaskHtml}</span></div>
                        <div class="emp-info-item"><span class="info-label"><i class="fa-solid fa-chart-simple"></i> أداء اليوم</span><span class="info-value">${performanceHtml}</span></div>
                    </div>
                    <div class="mobile-emp-actions mt-3 pt-2">${actions}</div>
                </article>`;
        }
    });
}

async function loadEmployees() {
    try {
        const data = await readExecutorApiResponse(await executorApiFetch('/executor-portal/api/employees'));
        employeesCache = Array.isArray(data.employees) ? data.employees : [];
        poolsCache = Array.isArray(data.pools) ? data.pools : [];
        solosCache = Array.isArray(data.soloExternals) ? data.soloExternals : [];
        companyExecutionPolicyCache = data.companyExecutionPolicy || companyExecutionPolicyCache;
        document.getElementById('summaryTotal').textContent =
            data.summary?.totalEmployees || employeesCache.length;
        document.getElementById('summaryOnline').textContent = data.summary?.onlineEmployees || 0;
        document.getElementById('summaryBusy').textContent = data.summary?.busyEmployees || 0;
        document.getElementById('summaryCompleted').textContent = data.summary?.completedCount || 0;
        applyBalanceSummary(data.summary);
        renderEmployees();
        renderPools();
    } catch (error) {
        console.error(error);
        Swal.fire('تعذر تحميل الفريق', error.message || 'حدث خطأ أثناء جلب بيانات الموظفين.', 'error');
    }
}

document.getElementById('employeeSearch').addEventListener('input', renderEmployees);
document.getElementById('employeeRoleFilter').addEventListener('change', renderEmployees);
