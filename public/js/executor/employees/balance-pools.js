/* exported createBalancePool, renameBalancePool, attachPoolMember, detachPoolMember, archiveBalancePool, deleteEmployee */
async function createBalancePool() {
    const externals = soloExternals().filter((employee) => employee.status === 'active');
    const memberChecks =
        externals
            .map(
                (employee) => `
            <label class="d-flex align-items-center justify-content-between gap-2 py-1">
                <span>${escapeEmployeeHtml(employee.name)} <small class="text-muted">(منفرد)</small></span>
                <input type="checkbox" class="pool-member-check" value="${employee.id || employee._id}">
            </label>`
            )
            .join('') ||
        '<p class="small text-muted">لا يوجد منفّذون خارجيون منفردون حالياً. يمكنك إنشاء المجموعة فارغة ثم إضافة الأعضاء لاحقاً.</p>';
    const result = await Swal.fire({
        title: 'مجموعة رصيد',
        html: `<p class="small text-muted text-end">المنفّذ يرتبط بمجموعة واحدة أو يبقى منفردًا — ليس الاثنين.</p><label class="form-label w-100 text-end">اسم المجموعة</label><input id="poolName" class="swal2-input m-0 mb-3 w-100" placeholder="مثال: شركة النور"><div class="text-end small fw-bold mb-2">ربط منفذين خارجيين (اختياري)</div><div class="text-end">${memberChecks}</div>`,
        showCancelButton: true,
        confirmButtonText: 'إنشاء المجموعة',
        cancelButtonText: 'إلغاء',
        preConfirm: () => {
            const name = document.getElementById('poolName').value.trim();
            if (name.length < 2) return Swal.showValidationMessage('أدخل اسماً واضحاً للمجموعة.');
            return {
                name,
                memberIds: [...document.querySelectorAll('.pool-member-check:checked')].map(
                    (input) => input.value
                ),
            };
        },
    });
    if (!result.isConfirmed) return;
    try {
        await readExecutorApiResponse(
            await executorApiFetch('/executor-portal/api/balance-pools', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(result.value),
            })
        );
        Swal.fire({
            icon: 'success',
            title: 'تم إنشاء مجموعة الرصيد',
            timer: 1300,
            showConfirmButton: false,
        });
        loadEmployees();
    } catch (error) {
        Swal.fire('تعذر الإنشاء', error.message, 'error');
    }
}

async function renameBalancePool(id, encodedName) {
    const currentName = decodeURIComponent(encodedName);
    const result = await Swal.fire({
        title: 'إعادة تسمية المجموعة',
        input: 'text',
        inputValue: currentName,
        showCancelButton: true,
        confirmButtonText: 'حفظ',
        cancelButtonText: 'إلغاء',
        inputValidator: (value) => {
            if (!value || value.trim().length < 2) return 'أدخل اسماً واضحاً.';
        },
    });
    if (!result.isConfirmed) return;
    try {
        await readExecutorApiResponse(
            await executorApiFetch('/executor-portal/api/balance-pools/' + id + '/rename', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: result.value.trim() }),
            })
        );
        loadEmployees();
    } catch (error) {
        Swal.fire('تعذر التعديل', error.message, 'error');
    }
}

async function attachPoolMember(poolId) {
    const pool = poolsCache.find((item) => item.id === poolId);
    const options = eligibleExternalsForPool(poolId).filter(
        (employee) => (employee.balancePool?.id || '') !== poolId
    );
    if (!options.length)
        return Swal.fire(
            'تنبيه',
            'لا يوجد منفّذ خارجي منفرد يمكن إضافته. افصل المنفّذ من مجموعته الحالية أولاً (عضوية واحدة فقط).',
            'info'
        );
    const result = await Swal.fire({
        title: 'إضافة منفّذ خارجي للمجموعة',
        html: `<p class="small text-end">رصيده المنفرد سيُضاف إلى رصيد مجموعة «${escapeEmployeeHtml(pool?.name || '')}».</p>`,
        input: 'select',
        inputOptions: Object.fromEntries(
            options.map((employee) => [employee.id || employee._id, employee.name])
        ),
        showCancelButton: true,
        confirmButtonText: 'إضافة',
        cancelButtonText: 'إلغاء',
    });
    if (!result.isConfirmed) return;
    try {
        await readExecutorApiResponse(
            await executorApiFetch('/executor-portal/api/balance-pools/' + poolId + '/members', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ memberIds: [result.value] }),
            })
        );
        loadEmployees();
    } catch (error) {
        Swal.fire('تعذر الإضافة', error.message, 'error');
    }
}

async function detachPoolMember(poolId, employeeId, encodedName, memberCount) {
    const name = decodeURIComponent(encodedName);
    const isLast = Number(memberCount) === 1;
    const result = await Swal.fire({
        title: 'فصل من مجموعة الرصيد',
        html: isLast
            ? `<p>فصل <b>${escapeEmployeeHtml(name)}</b> وهو آخر عضو؟ رصيد المجموعة المتبقي سيُنقل معه كرصيد منفرد.</p>`
            : `<p>فصل <b>${escapeEmployeeHtml(name)}</b> من المجموعة؟ سيصبح منفّذًا خارجيًا منفردًا، ورصيد المجموعة يبقى للأعضاء الآخرين.</p>`,
        showCancelButton: true,
        confirmButtonText: 'فصل',
        cancelButtonText: 'إلغاء',
    });
    if (!result.isConfirmed) return;
    try {
        await readExecutorApiResponse(
            await executorApiFetch(
                `/executor-portal/api/balance-pools/${poolId}/members/${employeeId}/detach`,
                { method: 'POST' }
            )
        );
        loadEmployees();
    } catch (error) {
        Swal.fire('تعذر الفصل', error.message, 'error');
    }
}

async function archiveBalancePool(id, encodedName) {
    const name = decodeURIComponent(encodedName);
    const result = await Swal.fire({
        title: 'أرشفة المجموعة',
        html: `<p>أرشفة مجموعة رصيد <b>${escapeEmployeeHtml(name)}</b>؟ يجب أن تكون فارغة: بلا أعضاء وبلا رصيد.</p>`,
        showCancelButton: true,
        confirmButtonText: 'أرشفة',
        cancelButtonText: 'إلغاء',
        confirmButtonColor: '#ef4444',
    });
    if (!result.isConfirmed) return;
    try {
        await readExecutorApiResponse(
            await executorApiFetch('/executor-portal/api/balance-pools/' + id + '/archive', {
                method: 'POST',
            })
        );
        loadEmployees();
    } catch (error) {
        Swal.fire('تعذر الأرشفة', error.message, 'error');
    }
}

// حذف موظف
async function deleteEmployee(id, encodedName) {
    const name = decodeURIComponent(encodedName);
    const result = await Swal.fire({
        title: 'أرشفة حساب الموظف',
        html: `<p>هل تريد إيقاف وأرشفة حساب <b>${escapeEmployeeHtml(name)}</b>؟</p><p class="small text-muted">تظل العمليات والتقارير السابقة محفوظة للمراجعة.</p>`,
        icon: 'warning',
        showCancelButton: true,
        confirmButtonText: 'أرشفة الحساب',
        cancelButtonText: 'إلغاء',
        confirmButtonColor: '#ef4444',
    });
    if (result.isConfirmed) {
        const res = await executorApiFetch('/executor-portal/api/employees/delete/' + id, { method: 'POST' });
        const data = await readExecutorApiResponse(res);
        if (data.success) {
            Swal.fire({ icon: 'success', title: 'تمت أرشفة الحساب', timer: 1200, showConfirmButton: false });
            loadEmployees();
        }
    }
}
