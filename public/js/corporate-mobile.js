(() => {
    const bootstrap = window.corporatePortal || {};

    const api = async (url, options = {}) => {
        const headers = {
            Accept: 'application/json',
            'x-csrf-token': bootstrap.csrfToken || '',
            ...(options.headers || {})
        };
        if (options.body && !(options.body instanceof FormData) && !headers['Content-Type']) {
            headers['Content-Type'] = 'application/json';
        }
        const response = await fetch(url, { credentials: 'same-origin', ...options, headers });
        const payload = await response.json().catch(() => ({ success: false, error: 'تعذر قراءة الرد' }));
        if (!response.ok || payload.success === false) throw new Error(payload.error || 'فشلت العملية');
        return payload;
    };

    const confirmSensitive = async () => {
        if (window.PublicKeyCredential) {
            try {
                const challenge = await api('/api/corporate/confirm/webauthn/options');
                if (challenge.available && challenge.options) {
                    const credential = await navigator.credentials.get({
                        publicKey: {
                            ...challenge.options,
                            challenge: Uint8Array.from(atob(challenge.options.challenge.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
                        }
                    });
                    if (credential) {
                        await api('/api/corporate/confirm/webauthn/verify', {
                            method: 'POST',
                            body: JSON.stringify(credential)
                        });
                        return 'webauthn';
                    }
                }
            } catch (_error) {
                // fall through to password
            }
        }
        const password = window.prompt('أكّد العملية بكلمة المرور أو الرمز');
        if (!password) throw new Error('تم إلغاء التأكيد');
        await api('/api/corporate/confirm/password', {
            method: 'POST',
            body: JSON.stringify({ password })
        });
        return 'password';
    };

    document.addEventListener('alpine:init', () => {
        Alpine.data('corporateMobile', () => ({
            tab: bootstrap.activeTab || 'home',
            role: bootstrap.role,
            permissions: bootstrap.permissions || {},
            requests: bootstrap.requests || [],
            pending: bootstrap.pending || [],
            beneficiaries: bootstrap.beneficiaries || [],
            insights: bootstrap.insights || {},
            kpis: bootstrap.kpis || {},
            step: 1,
            confirmOpen: false,
            form: {
                beneficiaryId: bootstrap.insights?.autofill?.beneficiaryId || bootstrap.insights?.suggestedBeneficiary?.id || '',
                amount: bootstrap.insights?.autofill?.amount || '',
                notes: ''
            },
            ocrLabel: '',
            message: '',
            offline: !navigator.onLine,
            cachedBanner: false,

            init() {
                window.addEventListener('online', () => { this.offline = false; this.cachedBanner = false; });
                window.addEventListener('offline', () => {
                    this.offline = true;
                    this.cachedBanner = true;
                    this.restoreCache();
                });
                if (!navigator.onLine) this.restoreCache();
                this.persist();
                if ('serviceWorker' in navigator) {
                    navigator.serviceWorker.register('/corporate/sw.js', { scope: '/corporate/' }).catch(() => {});
                }
            },

            persist() {
                try {
                    localStorage.setItem('corporate-mobile-cache', JSON.stringify({
                        at: Date.now(),
                        kpis: this.kpis,
                        requests: this.requests.slice(0, 12),
                        balance: bootstrap.balance
                    }));
                } catch (_error) {}
            },

            restoreCache() {
                try {
                    const cached = JSON.parse(localStorage.getItem('corporate-mobile-cache') || 'null');
                    if (!cached) return;
                    this.kpis = cached.kpis || this.kpis;
                    this.requests = cached.requests || this.requests;
                    this.cachedBanner = true;
                } catch (_error) {}
            },

            homeCta() {
                if (this.role === 'manager') return { tab: 'approvals', label: 'اعتماد المعلق' };
                if (this.role === 'accountant') return { tab: 'reports', label: 'مراجعة اليوم' };
                return { tab: 'transfers', label: 'تحويل سريع' };
            },

            async refresh() {
                const data = await api('/api/corporate/dashboard');
                this.requests = data.requests || [];
                this.pending = data.pending || [];
                this.beneficiaries = data.beneficiaries || [];
                this.insights = data.insights || {};
                this.kpis = data.kpis || {};
                this.persist();
            },

            async captureOcr() {
                const input = document.getElementById('cm-ocr-input');
                if (!input) return;
                input.click();
            },

            async onOcrFile(event) {
                const file = event.target.files?.[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = async () => {
                    const parsed = await api('/api/corporate/insights/ocr', {
                        method: 'POST',
                        body: JSON.stringify({
                            imageBase64: reader.result,
                            mimeType: file.type,
                            fileName: file.name
                        })
                    });
                    this.ocrLabel = parsed.ocr?.label || 'DEMO';
                    if (parsed.ocr?.amount) this.form.amount = parsed.ocr.amount;
                    if (parsed.ocr?.vendorName) {
                        const match = this.beneficiaries.find((item) => item.name === parsed.ocr.vendorName);
                        if (match) this.form.beneficiaryId = match.id;
                    }
                };
                reader.readAsDataURL(file);
            },

            async submitTransfer() {
                await confirmSensitive();
                const payload = await api('/api/corporate/requests', {
                    method: 'POST',
                    body: JSON.stringify({
                        beneficiaryId: this.form.beneficiaryId,
                        amount: Number(this.form.amount),
                        notes: this.form.notes,
                        idempotencyKey: `mob-${Date.now()}-${this.form.amount}`
                    })
                });
                this.message = payload.request?.status === 'pending_approval'
                    ? 'بانتظار اعتماد المدير'
                    : 'تم تنفيذ التحويل';
                this.confirmOpen = false;
                this.step = 1;
                await this.refresh();
            },

            async approve(id) {
                await confirmSensitive();
                await api(`/api/corporate/requests/${id}/approve`, { method: 'POST', body: '{}' });
                await this.refresh();
            },

            async reject(id) {
                await api(`/api/corporate/requests/${id}/reject`, {
                    method: 'POST',
                    body: JSON.stringify({ reason: 'مرفوض من الجوال' })
                });
                await this.refresh();
            },

            exportReport() {
                window.location.href = '/api/corporate/reports/export';
            }
        }));
    });
})();
