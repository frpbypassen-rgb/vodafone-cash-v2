/**
 * Al-Ahram Pay - Modern Client UI Controller
 * Handles interactions, data rendering, and navigation
 */

class ClientUI {
    constructor() {
        this.balance = 0;
        this.transactions = [];
        this.beneficiaries = [];
        this.init();
    }

    init() {
        this.bindEvents();
        this.fetchInitialData();
        this.setupAnimations();
    }

    bindEvents() {
        // Quick Actions
        document.querySelectorAll('.action-item').forEach(item => {
            item.addEventListener('click', (e) => {
                const action = item.dataset.action;
                this.handleQuickAction(action);
            });
        });

        // Navigation
        document.querySelectorAll('.nav-btn, .nav-item').forEach(nav => {
            nav.addEventListener('click', (e) => {
                e.preventDefault();
                const target = nav.dataset.target || nav.getAttribute('href');
                this.navigate(target);
            });
        });

        // Search Input (if exists)
        const searchInput = document.getElementById('search-transactions');
        if (searchInput) {
            searchInput.addEventListener('input', (e) => {
                this.filterTransactions(e.target.value);
            });
        }

        // Refresh Balance on Click
        const balanceCard = document.querySelector('.balance-card');
        if (balanceCard) {
            balanceCard.addEventListener('dblclick', () => {
                this.refreshBalance();
            });
        }
    }

    async fetchInitialData() {
        try {
            // Fetch Balance
            const balanceRes = await fetch('/api/v1/client/balance');
            if (balanceRes.ok) {
                const data = await balanceRes.json();
                this.updateBalanceDisplay(data.balance || 0);
            }

            // Fetch Transactions
            const transRes = await fetch('/api/v1/client/transactions?limit=10');
            if (transRes.ok) {
                const data = await transRes.json();
                this.renderTransactions(data.transactions || []);
            }
        } catch (error) {
            console.error('Failed to load initial data:', error);
            // Show fallback or error message
        }
    }

    updateBalanceDisplay(amount) {
        const amountEl = document.getElementById('balance-amount');
        if (!amountEl) return;

        // Animate number counting
        this.animateValue(amountEl, parseFloat(amountEl.textContent.replace(/,/g, '')) || 0, amount, 1000);
    }

    animateValue(obj, start, end, duration) {
        let startTimestamp = null;
        const step = (timestamp) => {
            if (!startTimestamp) startTimestamp = timestamp;
            const progress = Math.min((timestamp - startTimestamp) / duration, 1);
            const value = Math.floor(progress * (end - start) + start);
            obj.textContent = value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
            if (progress < 1) {
                window.requestAnimationFrame(step);
            }
        };
        window.requestAnimationFrame(step);
    }

    renderTransactions(transactions) {
        const container = document.getElementById('transactions-list');
        if (!container) return;

        container.innerHTML = '';

        if (transactions.length === 0) {
            container.innerHTML = `
                <div class="card" style="text-align:center; padding: 40px;">
                    <div style="font-size: 3rem; color: var(--text-light); margin-bottom: 10px;">📭</div>
                    <p style="color: var(--text-muted);">لا توجد عمليات حديثة</p>
                </div>
            `;
            return;
        }

        transactions.forEach((tx, index) => {
            const isCredit = tx.type === 'credit' || tx.amount > 0;
            const html = `
                <div class="transaction-item animate-in" style="animation-delay: ${index * 50}ms">
                    <div class="t-icon ${isCredit ? 'in' : 'out'}">
                        ${isCredit ? '↓' : '↑'}
                    </div>
                    <div class="t-details">
                        <div class="t-title">${tx.title || tx.beneficiaryName || 'تحويل نقدي'}</div>
                        <div class="t-date">${this.formatDate(tx.createdAt)}</div>
                    </div>
                    <div class="t-amount ${isCredit ? 'in' : 'out'}">
                        ${isCredit ? '+' : '-'}${Math.abs(tx.amount).toLocaleString()} ج.م
                    </div>
                </div>
            `;
            container.insertAdjacentHTML('beforeend', html);
        });
    }

    handleQuickAction(action) {
        switch(action) {
            case 'transfer':
                window.location.href = '/client/transfer';
                break;
            case 'beneficiaries':
                window.location.href = '/client/beneficiaries';
                break;
            case 'deposit':
                this.showModal('deposit');
                break;
            case 'withdraw':
                this.showModal('withdraw');
                break;
            case 'statements':
                window.location.href = '/client/statements';
                break;
            default:
                console.log('Action not implemented:', action);
        }
    }

    navigate(target) {
        // Update Active State in Nav
        document.querySelectorAll('.nav-btn, .nav-item').forEach(el => {
            el.classList.remove('active');
            if ((el.dataset.target === target) || (el.getAttribute('href') === target)) {
                el.classList.add('active');
            }
        });

        // If it's a hash link, scroll smoothly
        if (target.startsWith('#')) {
            const element = document.querySelector(target);
            if (element) {
                element.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
        } else if (target && !target.startsWith('#')) {
            // Full page navigation handled by browser default unless intercepted
            // window.location.href = target; 
        }
    }

    filterTransactions(query) {
        const items = document.querySelectorAll('.transaction-item');
        const lowerQuery = query.toLowerCase();

        items.forEach(item => {
            const title = item.querySelector('.t-title').textContent.toLowerCase();
            const date = item.querySelector('.t-date').textContent.toLowerCase();
            
            if (title.includes(lowerQuery) || date.includes(lowerQuery)) {
                item.style.display = 'flex';
            } else {
                item.style.display = 'none';
            }
        });
    }

    refreshBalance() {
        const btn = document.querySelector('.balance-card');
        if(btn) {
            btn.style.opacity = '0.7';
            setTimeout(() => {
                this.fetchInitialData();
                btn.style.opacity = '1';
            }, 500);
        }
    }

    showModal(type) {
        // Placeholder for modal logic (Deposit/Withdraw)
        alert(`سيتم فتح نافذة ${type === 'deposit' ? 'الإيداع' : 'السحب'} قريباً`);
    }

    formatDate(dateString) {
        const date = new Date(dateString);
        return new Intl.DateTimeFormat('ar-EG', {
            day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'
        }).format(date);
    }

    setupAnimations() {
        // Add fade-in to main content on load
        const mainContent = document.querySelector('.container-app');
        if(mainContent) {
            mainContent.style.opacity = '0';
            mainContent.style.transition = 'opacity 0.5s ease-out';
            setTimeout(() => {
                mainContent.style.opacity = '1';
            }, 100);
        }
    }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    window.clientUI = new ClientUI();
});
