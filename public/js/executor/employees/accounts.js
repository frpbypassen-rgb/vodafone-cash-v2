/* exported editEmployee, toggleEmployee, toggleReports, resetPassword, externalTransaction */
async function editEmployee(id, encodedName, encodedPhone) {
    const currentName = decodeURIComponent(encodedName);
    const currentPhone = decodeURIComponent(encodedPhone);
    const result = await Swal.fire({
        title: 'تعديل بيانات الموظف',
        html: `<label class="form-label w-100 text-end">الاسم</label><input id="editEmpName" class="swal2-input m-0 mb-3 w-100" value="${escapeEmployeeHtml(currentName)}"><label class="form-label w-100 text-end">رقم الهاتف</label><input id="editEmpPhone" class="swal2-input m-0 w-100" dir="ltr" value="${escapeEmployeeHtml(currentPhone)}">`,
        showCancelButton: true,
        confirmButtonText: 'حفظ التعديل',
        cancelButtonText: 'إلغاء',
        preConfirm: () => {
            const name = document.getElementById('editEmpName').value.trim();
            const phone = document.getElementById('editEmpPhone').value.trim();
            if (name.length < 3) return Swal.showValidationMessage('الاسم يجب ألا يقل عن 3 أحرف.');
            return { name, phone };
        },
    });
    if (!result.isConfirmed) return;
    try {
        await readExecutorApiResponse(
            await executorApiFetch('/executor-portal/api/employees/' + id, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(result.value),
            })
        );
        Swal.fire({
            icon: 'success',
            title: 'تم تعديل بيانات الموظف',
            timer: 1300,
            showConfirmButton: false,
        });
        loadEmployees();
    } catch (error) {
        Swal.fire('تعذر التعديل', error.message, 'error');
    }
}

async function toggleEmployee(id) {
    const res = await executorApiFetch('/executor-portal/api/employees/toggle/' + id, { method: 'POST' });
    try {
        const data = await readExecutorApiResponse(res);
        if (data.success) {
            Swal.fire({ icon: 'success', title: 'تم التحديث', timer: 1200, showConfirmButton: false });
            loadEmployees();
        }
    } catch (error) {
        Swal.fire('تعذر تحديث الموظف', error.message, 'error');
    }
}

// تفعيل / تعطيل التقارير الشاملة
async function toggleReports(id) {
    try {
        const res = await executorApiFetch('/executor-portal/api/employees/toggle-reports/' + id, {
            method: 'POST',
        });
        const data = await readExecutorApiResponse(res);
        if (data.success) {
            Swal.fire({
                icon: 'success',
                title: 'تم تحديث صلاحية التقارير',
                timer: 1200,
                showConfirmButton: false,
            });
            loadEmployees();
        } else {
            Swal.fire('خطأ', data.error || 'حدث خطأ', 'error');
        }
    } catch (e) {
        Swal.fire('خطأ', e.message || 'تعذر الاتصال بالخادم', 'error');
    }
}

// إعادة تعيين كلمة المرور
async function resetPassword(id, encodedName) {
    const name = decodeURIComponent(encodedName);
    const { value: newPass } = await Swal.fire({
        title: 'إعادة تعيين كلمة المرور',
        html: `<p class="small text-muted">الموظف: <b>${name}</b></p>`,
        input: 'password',
        inputPlaceholder: 'كلمة المرور الجديدة',
        showCancelButton: true,
        confirmButtonText: 'تغيير',
        cancelButtonText: 'إلغاء',
        confirmButtonColor: '#0ea5e9',
        inputValidator: (val) => {
            if (!val || val.length < 8) return 'كلمة المرور يجب أن تكون 8 أحرف على الأقل';
        },
    });
    if (newPass) {
        const res = await executorApiFetch('/executor-portal/api/employees/reset-password/' + id, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ newPassword: newPass }),
        });
        const data = await readExecutorApiResponse(res);
        if (data.success)
            Swal.fire({
                icon: 'success',
                title: 'تم تغيير كلمة المرور',
                timer: 1500,
                showConfirmButton: false,
            });
    }
}

async function externalTransaction(id, encodedName, type) {
    const name = decodeURIComponent(encodedName);
    const employee = employeesCache.find((item) => String(item.id || item._id) === String(id));
    const pool = employee?.balancePool || null;
    const isDeposit = type === 'deposit';
    const title = isDeposit ? 'تمويل منفّذ خارجي' : 'خصم من منفّذ خارجي';
    const membershipLine = pool
        ? `منفّذ خارجي في مجموعة رصيد «${escapeEmployeeHtml(pool.name)}»`
        : 'منفّذ خارجي منفرد';
    const creditLine = pool ? `رصيد مجموعة «${escapeEmployeeHtml(pool.name)}»` : 'رصيده المنفرد';
    const privateNow = formatEgp(companyBalancesCache.privateBalance);
    const workingNow = formatEgp(
        employee?.workingBalance != null ? employee.workingBalance : employee?.balance || pool?.balance || 0
    );
    const noteHtml = isDeposit
        ? `<div class="pool-fund-note text-end">
                <div>يُخصم من: <b>الرصيد الخاص</b> للشركة (المتاح الآن ${privateNow} ج.م)</div>
                <div>يُضاف إلى: <b>${creditLine}</b> (الآن ${workingNow} ج.م)</div>
                <div>الإيصال والتنبيه: <b>للمستلم فقط</b> (${escapeEmployeeHtml(name)}) — باقي أعضاء المجموعة لا يرونه.</div>
            </div>`
        : `<div class="pool-fund-note text-end">
                <div>يُخصم من: <b>${creditLine}</b> (الآن ${workingNow} ج.م)</div>
                <div>يُعاد إلى: <b>الرصيد الخاص</b> للشركة</div>
                <div>الإيصال والتنبيه: <b>للمستلم فقط</b>.</div>
            </div>`;
    const result = await Swal.fire({
        title,
        html: `<p class="small mb-2 text-end">المستلم: <b>${escapeEmployeeHtml(name)}</b><br><span class="text-muted">${membershipLine}</span></p>${noteHtml}<label class="form-label w-100 text-end mt-3">المبلغ (ج.م)</label><input id="extAmount" type="number" class="swal2-input m-0 mb-3 w-100" placeholder="0.00"><label class="form-label w-100 text-end">ملاحظة (اختياري)</label><input id="extNote" class="swal2-input m-0 w-100">`,
        showCancelButton: true,
        confirmButtonText: isDeposit ? 'تأكيد التمويل من الرصيد الخاص' : 'تأكيد الخصم',
        cancelButtonText: 'إلغاء',
        confirmButtonColor: isDeposit ? '#10b981' : '#ef4444',
        preConfirm: () => {
            const amount = Number(document.getElementById('extAmount').value);
            if (!amount || amount <= 0) return Swal.showValidationMessage('أدخل مبلغًا صحيحًا أكبر من صفر.');
            if (isDeposit && amount > Number(companyBalancesCache.privateBalance || 0)) {
                return Swal.showValidationMessage('الرصيد الخاص غير كافٍ لهذا المبلغ.');
            }
            return { amount, note: document.getElementById('extNote').value.trim() };
        },
    });
    if (!result.isConfirmed) return;
    const requestKey = `executor-fund:${id}:${type}:${result.value.amount}:${result.value.note}`;
    let requestId = null;
    try {
        requestId = sessionStorage.getItem(requestKey);
    } catch (_) {
        /* Storage may be disabled. */
    }
    if (!requestId) {
        requestId =
            window.crypto?.randomUUID?.() ||
            Array.from(window.crypto.getRandomValues(new Uint8Array(16)), (byte) =>
                byte.toString(16).padStart(2, '0')
            ).join('');
        try {
            sessionStorage.setItem(requestKey, requestId);
        } catch (_) {
            /* Keep this attempt in memory. */
        }
    }
    try {
        const res = await executorApiFetch('/executor-portal/api/employees/external-transaction/' + id, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type, amount: result.value.amount, note: result.value.note, requestId }),
        });
        const data = await readExecutorApiResponse(res);
        try {
            sessionStorage.removeItem(requestKey);
        } catch (_) {
            /* Storage may be disabled. */
        }
        applyBalanceSummary({
            totalBalance: data.companyTotalBalance,
            privateBalance: data.companyPrivateBalance,
        });
        if (data.success) {
            const receiptNote = data.recipientOnly === false ? '' : ' الإيصال ظهر للمستلم فقط.';
            Swal.fire({
                icon: 'success',
                title: 'تم تسجيل العملية',
                text: `رقم العملية: ${data.customId}.${receiptNote}`,
                timer: 2200,
                showConfirmButton: false,
            });
        }
        loadEmployees();
    } catch (error) {
        Swal.fire('خطأ', error.message || 'تعذر تسجيل العملية', 'error');
    }
}
