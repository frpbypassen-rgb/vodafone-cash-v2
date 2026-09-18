(() => {
    const bootstrap = window.corporatePortal || {};

    const api = async (url, options = {}) => {
        const headers = {
            Accept: 'application/json',
            'x-csrf-token': bootstrap.csrfToken || '',
            ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
            ...(options.headers || {})
        };
        const response = await fetch(url, { credentials: 'same-origin', ...options, headers });
        const isCsv = String(response.headers.get('content-type') || '').includes('text/csv');
        if (isCsv) return response;
        const payload = await response.json().catch(() => ({ success: false, error: 'تعذر قراءة الرد' }));
        if (!response.ok || payload.success === false) {
            throw new Error(payload.error || 'فشلت العملية');
        }
        return payload;
    };

    document.addEventListener('alpine:init', () => {
        Alpine.data('corporateDesktop', () => ({
            tab: bootstrap.activeTab || 'home',
            role: bootstrap.role,
            permissions: bootstrap.permissions || {},
            requests: bootstrap.requests || [],
            pending: bootstrap.pending || [],
            beneficiaries: bootstrap.beneficiaries || [],
            staff: bootstrap.staff || [],
            invoices: bootstrap.invoices || [],
            insights: bootstrap.insights || {},
            kpis: bootstrap.kpis || {},
            reviewModals: [],
            form: { beneficiaryId: '', amount: '', notes: '', serviceType: 'vodafone', name: '', accountNumber: '' },
            staffForm: { id: '', corporateRole: 'employee', approvalLimit: 0 },
            noteBody: '',
            rejectReason: '',
            message: '',
            offline: !navigator.onLine,
            shortcuts: [
                'Ctrl/Cmd+1 الرئيسية',
                'Ctrl/Cmd+2 التحويلات',
                'Ctrl/Cmd+3 الاعتمادات',
                'Ctrl/Cmd+4 التقارير'
            ],

            init() {
                window.addEventListener('online', () => { this.offline = false; });
                window.addEventListener('offline', () => { this.offline = true; });
                window.addEventListener('keydown', (event) => this.onShortcut(event));
                this.persistSnapshot();
            },

            persistSnapshot() {
                try {
                    localStorage.setItem('corporate-cache', JSON.stringify({
                        at: Date.now(),
                        kpis: this.kpis,
                        requests: this.requests.slice(0, 20)
                    }));
                } catch (_error) {}
            },

            onShortcut(event) {
                if (!(event.ctrlKey || event.metaKey)) return;
                const map = { 1: 'home', 2: 'transfers', 3: 'approvals', 4: 'reports' };
                const next = map[event.key];
                if (!next) return;
                if (next === 'transfers' && !this.permissions.canTransfer) return;
                if (next === 'approvals' && !this.permissions.canApprove) return;
                event.preventDefault();
                this.tab = next;
            },

            openReview(item) {
                if (this.reviewModals.find((entry) => entry.id === item.id)) return;
                this.reviewModals.push(item);
            },

            closeReview(id) {
                this.reviewModals = this.reviewModals.filter((item) => item.id !== id);
            },

            async refresh() {
                const data = await api('/api/corporate/dashboard');
                this.requests = data.requests || [];
                this.pending = data.pending || [];
                this.beneficiaries = data.beneficiaries || [];
                this.staff = data.staff || [];
                this.invoices = data.invoices || [];
                this.insights = data.insights || {};
                this.kpis = data.kpis || {};
                this.persistSnapshot();
            },

            async createTransfer() {
                const payload = await api('/api/corporate/requests', {
                    method: 'POST',
                    body: JSON.stringify({
                        beneficiaryId: this.form.beneficiaryId,
                        amount: Number(this.form.amount),
                        notes: this.form.notes,
                        idempotencyKey: `desk-${Date.now()}-${this.form.amount}`
                    })
                });
                this.message = payload.request?.status === 'pending_approval'
                    ? 'أُرسل الطلب لاعتماد المدير'
                    : 'تم إنشاء التحويل';
                await this.refresh();
            },

            async approve(id) {
                await api(`/api/corporate/requests/${id}/approve`, { method: 'POST', body: '{}' });
                this.closeReview(id);
                await this.refresh();
            },

            async reject(id) {
                await api(`/api/corporate/requests/${id}/reject`, {
                    method: 'POST',
                    body: JSON.stringify({ reason: this.rejectReason || 'مرفوض من مركز القيادة' })
                });
                this.closeReview(id);
                await this.refresh();
            },

            async addBeneficiary() {
                await api('/api/corporate/beneficiaries', {
                    method: 'POST',
                    body: JSON.stringify({
                        name: this.form.name,
                        accountNumber: this.form.accountNumber,
                        serviceType: this.form.serviceType
                    })
                });
                this.form.name = '';
                this.form.accountNumber = '';
                await this.refresh();
            },

            async assignStaff() {
                await api(`/api/corporate/staff/${this.staffForm.id}/permissions`, {
                    method: 'POST',
                    body: JSON.stringify(this.staffForm)
                });
                await this.refresh();
            },

            async addNote(id) {
                await api(`/api/corporate/requests/${id}/notes`, {
                    method: 'POST',
                    body: JSON.stringify({ body: this.noteBody })
                });
                this.noteBody = '';
                await this.refresh();
            },

            async reconcile(id) {
                await api(`/api/corporate/requests/${id}/reconcile`, { method: 'POST', body: '{}' });
                await this.refresh();
            },

            exportReport() {
                window.location.href = '/api/corporate/reports/export';
            },

            onDragOver(event) {
                event.preventDefault();
                event.currentTarget.classList.add('over');
            },

            onDragLeave(event) {
                event.currentTarget.classList.remove('over');
            },

            async onDrop(event) {
                event.preventDefault();
                event.currentTarget.classList.remove('over');
                const file = event.dataTransfer?.files?.[0];
                if (!file) return;
                const body = new FormData();
                body.append('file', file);
                body.append('vendorName', file.name.replace(/\.[^.]+$/, ''));
                await fetch('/api/corporate/invoices', {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: { 'x-csrf-token': bootstrap.csrfToken || '' },
                    body
                });
                await this.refresh();
            }
        }));
    });
})();
