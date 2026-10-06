/* exported downloadReportPdf, setQuickPeriod, scheduleExecutorOperationSearch, searchExecutorOperations */
async function downloadReportPdf() {
    if (!lastReportRequest) return;
    const button = document.getElementById('btnDownloadPdf');
    const original = button.innerHTML;
    button.disabled = true;
    button.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> جاري تجهيز PDF...';
    try {
        const response = await executorApiFetch('/executor-portal/reports/download.pdf', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(lastReportRequest),
        });
        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error.error || 'تعذر تجهيز ملف التقرير.');
        }
        const blob = await response.blob();
        const period = lastReportData?.reportPeriod?.value || new Date().toISOString().slice(0, 10);
        const owner = lastReportData?.targetEmployee?.name || lastReportData?.company?.name || 'executor';
        const safeOwner = String(owner).replace(/[\\/:*?"<>|]/g, '-');
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `executor-report-${safeOwner}-${String(period).replace(/[^0-9-]/g, '')}.pdf`;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(url);
        Swal.fire({ icon: 'success', title: 'تم تنزيل التقرير', timer: 1500, showConfirmButton: false });
    } catch (error) {
        Swal.fire({
            icon: 'error',
            title: 'فشل تحميل التقرير',
            text: error.message || 'تعذر تجهيز ملف PDF.',
        });
    } finally {
        button.disabled = false;
        button.innerHTML = original;
    }
}

function setQuickPeriod(kind) {
    const searchInput = document.getElementById('reportSearch');
    if (searchInput) searchInput.value = '';
    clearTimeout(reportSearchTimer);
    const today = tripoliDateValue();
    if (phoneReportLayout) {
        const from =
            kind === 'yesterday'
                ? addTripoliDays(today, -1)
                : kind === 'last7'
                  ? addTripoliDays(today, -6)
                  : kind === 'thisMonth'
                    ? `${tripoliMonthValue()}-01`
                    : today;
        document.getElementById('dateType').value = 'range';
        document.getElementById('dateFrom').value = from;
        document.getElementById('dateTo').value = kind === 'yesterday' ? from : today;
        toggleDateInput();
        fetchReport();
        return;
    }
    if (kind === 'today') {
        document.getElementById('dateType').value = 'day';
        document.getElementById('dateValueDay').value = today;
    } else if (kind === 'yesterday') {
        document.getElementById('dateType').value = 'day';
        document.getElementById('dateValueDay').value = addTripoliDays(today, -1);
    } else if (kind === 'last7') {
        document.getElementById('dateType').value = 'range';
        document.getElementById('dateFrom').value = addTripoliDays(today, -6);
        document.getElementById('dateTo').value = today;
    } else if (kind === 'thisMonth') {
        document.getElementById('dateType').value = 'month';
        document.getElementById('dateValueMonth').value = tripoliMonthValue();
    }
    toggleDateInput();
    fetchReport();
}

function scheduleExecutorOperationSearch() {
    clearTimeout(reportSearchTimer);
    reportSearchTimer = setTimeout(searchExecutorOperations, 450);
}

function searchExecutorOperations() {
    clearTimeout(reportSearchTimer);
    if (!document.getElementById('reportSearch')?.value.trim()) return fetchReport();
    return fetchReport(true);
}

// Load the full operational ledger immediately; no manual date filter
// is needed to see work from previous days or newly arriving tasks.
loadEmployeeFilter().finally(fetchReport);

// التقرير يحمل عند فتحه أو عند تغيير الفلاتر فقط. إعادة تحميل سجل كامل
// العمليات كل ثوانٍ كانت تثقل الخادم بلا حاجة.
