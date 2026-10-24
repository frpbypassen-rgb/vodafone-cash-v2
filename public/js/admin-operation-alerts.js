(() => {
    'use strict';
    if (window.__adminOperationAlerts) return;
    window.__adminOperationAlerts = true;
    const base = '/api/admin-operation-alerts';
    let context, config, busy = false, stopped = false, timer, previousFocus;
    const read = key => { try { return localStorage.getItem(key); } catch (_) { return null; } };
    const write = (key, value) => { try { localStorage.setItem(key, value); } catch (_) {} };
    const key = suffix => `admin-alert:${config?.adminId}:${suffix}`;
    const launch = document.createElement('button');
    launch.className = 'ao-launch'; launch.type = 'button'; launch.hidden = true;
    launch.setAttribute('aria-label', 'تنبيهات العمليات'); launch.setAttribute('aria-expanded', 'false');
    launch.textContent = 'تنبيهات العمليات';
    const panel = document.createElement('section'); panel.className = 'ao-panel'; panel.hidden = true;
    panel.innerHTML = `<div class="ao-sheet" role="dialog" aria-modal="true" aria-labelledby="ao-title">
        <header class="ao-header"><h2 id="ao-title">تنبيهات العمليات</h2><button type="button" data-action="close" aria-label="إغلاق التنبيهات">✕</button></header>
        <div class="ao-scroll"><div class="ao-status" role="status" aria-live="polite"></div>
        <div class="ao-controls"><button type="button" class="ao-primary" data-action="enable">تفعيل تنبيهات هذا الجهاز</button>
        <button type="button" data-action="mute">كتم الصوت</button><button type="button" data-action="new-test">اختبار صوت عملية جديدة</button>
        <button type="button" data-action="pending-test">اختبار صوت التعليق</button><button type="button" data-action="push-test">اختبار إشعار الجهاز</button></div>
        <p class="ao-help">الصوتان يعملان داخل الموقع بعد تفعيله. إشعارات الخلفية تعتمد على إذن النظام وإعداداته. على الآيفون أضف الموقع إلى الشاشة الرئيسية. استلام المتابعة يسجل اسمك فقط ولا يغير العملية أو الرصيد.</p>
        <p class="ao-help ao-delivery" aria-live="polite"></p>
        <div class="ao-items" aria-live="polite"></div><details class="ao-devices"><summary>الأجهزة المفعّلة</summary><div class="ao-device-list"></div></details></div></div>`;
    document.body.append(launch, panel);
    const status = text => { panel.querySelector('.ao-status').textContent = text; };
    const api = async (path, body) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        let response;
        try {
            response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST',
                headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'x-csrf-token': window.__csrfToken || '' },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: controller.signal });
        } finally { clearTimeout(timeout); }
        if ([401, 403].includes(response.status)) { stopped = true; launch.hidden = true; close(); }
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || 'تعذر الاتصال بنظام التنبيهات.');
        return data;
    };
    const unlockAudio = async () => {
        const Audio = window.AudioContext || window.webkitAudioContext;
        if (!Audio) throw new Error('هذا المتصفح لا يدعم تشغيل صوت التنبيه.');
        context = context || new Audio();
        await context.resume();
        if (context.state !== 'running') throw new Error('اضغط تفعيل الصوت للسماح بتشغيله.');
    };
    const tone = kind => {
        if (!context || context.state !== 'running') return;
        const notes = kind === 'api_pending' ? [880, 580, 880] : [523, 784];
        notes.forEach((frequency, index) => {
            const oscillator = context.createOscillator(), gain = context.createGain();
            const start = context.currentTime + index * .22;
            oscillator.frequency.value = frequency; oscillator.type = 'sine';
            gain.gain.setValueAtTime(0, start); gain.gain.linearRampToValueAtTime(.18, start + .02);
            gain.gain.exponentialRampToValueAtTime(.001, start + .19);
            oscillator.connect(gain); gain.connect(context.destination); oscillator.start(start); oscillator.stop(start + .21);
            oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
        });
    };
    function close() { panel.hidden = true; launch.setAttribute('aria-expanded', 'false'); previousFocus?.focus(); }
    const date = value => new Date(value).toLocaleString('ar-LY', { timeZone: 'Africa/Tripoli' });
    function render(rows) {
        const container = panel.querySelector('.ao-items'); container.replaceChildren();
        if (!rows.length) { container.textContent = 'لا توجد تنبيهات حديثة.'; return; }
        for (const row of rows) {
            const item = document.createElement('article'); item.className = 'ao-item'; item.dataset.kind = row.kind;
            const title = document.createElement('strong'); title.textContent = row.kind === 'api_pending' ? 'عملية API تحتاج متابعة' : 'عملية جديدة';
            const reference = document.createElement('p'); reference.textContent = row.reference || '';
            const time = document.createElement('small'); time.textContent = date(row.createdAt);
            const link = document.createElement('a'); link.textContent = 'فتح العملية'; link.href = row.url;
            item.append(title, reference, time, link);
            if (row.kind === 'api_pending') {
                const note = document.createElement('p');
                if (row.resolvedAt) note.textContent = 'لم تعد العملية معلقة.';
                else if (row.acknowledgedAt) note.textContent = `استلم المتابعة: ${row.acknowledgedName} · ${date(row.acknowledgedAt)}`;
                else {
                    const button = document.createElement('button'); button.type = 'button'; button.className = 'ao-primary';
                    button.textContent = 'استلمت المتابعة';
                    button.onclick = async () => {
                        button.disabled = true;
                        try { await api(`/acknowledge/${row.id.split(':')[1]}`, {}); await poll(); }
                        catch (error) { status(error.message); button.disabled = false; }
                    };
                    note.append(button);
                }
                item.append(note);
            }
            container.append(item);
        }
    }
    async function devices() {
        const data = await api('/devices'); const container = panel.querySelector('.ao-device-list'); container.replaceChildren();
        for (const device of data.devices) {
            const line = document.createElement('p'), button = document.createElement('button'); button.type = 'button';
            line.textContent = `${device._id === read(key('device')) ? 'هذا الجهاز' : 'جهاز آخر'} · ${date(device.createdAt)} `;
            button.textContent = 'تعطيل'; button.onclick = async () => {
                try { await api('/unsubscribe', { deviceId: device._id }); if (device._id === read(key('device'))) write(key('device'), ''); await devices(); status('تم تعطيل إشعارات الجهاز.'); }
                catch (error) { status(error.message); }
            };
            line.append(button); container.append(line);
        }
        if (!data.devices.length) container.textContent = 'لا توجد أجهزة مفعّلة.';
    }
    async function poll() {
        if (busy || stopped || document.hidden) return;
        busy = true;
        try {
            const first = !config; config = await api('');
            launch.hidden = !config.enabled;
            if (!config.enabled) return;
            const rows = config.alerts || [];
            const unclaimed = rows.filter(row => row.kind === 'api_pending' && !row.acknowledgedAt && !row.resolvedAt).length;
            launch.textContent = `تنبيهات العمليات${unclaimed ? ` · ${unclaimed} تحتاج متابعة` : ''}`;
            if (!panel.hidden) render(rows);
            if (first) status(config.configured ? 'فعّل هذا الجهاز لاستقبال إشعارات الخلفية والصوت.' : 'الصوت متاح. إشعارات الخلفية تحتاج إعداد مفاتيح Web Push على السيرفر.');
            const floor = Math.max(Number(read(key('soundSince')) || Date.now()), Date.now() - 120000);
            const fresh = rows.filter(row => new Date(row.createdAt).getTime() >= floor && !row.acknowledgedAt && !row.resolvedAt);
            if (read(key('sound')) === 'on' && context?.state === 'running') {
                const claimed = [];
                for (const row of fresh) if (await window.adminAlertClaim(`sound:${config.adminId}:${row.id}`)) claimed.push(row);
                if (claimed.length) {
                    const kind = claimed.some(row => row.kind === 'api_pending') ? 'api_pending' : 'new_operation';
                    tone(kind); status(`${kind === 'api_pending' ? 'تنبيه تعليق عملية API' : 'تنبيه عملية جديدة'} · ${date(new Date())}`);
                }
            }
            // Background-enabled accounts still need one gesture to unlock audio after a new page load.
        } catch (error) { if (!panel.hidden) status(error.message); }
        finally { busy = false; }
    }
    launch.onclick = () => {
        previousFocus = document.activeElement; panel.hidden = false; launch.setAttribute('aria-expanded', 'true');
        panel.querySelector('[data-action=mute]').textContent = read(key('sound')) === 'on' ? 'كتم الصوت' : 'تشغيل الصوت';
        panel.querySelector('[data-action=close]').focus(); render(config?.alerts || []); void devices().catch(error => status(error.message));
        if (read(key('sound')) === 'on') void unlockAudio().catch(error => status(error.message));
    };
    panel.addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.preventDefault(); close(); }
        if (event.key !== 'Tab') return;
        const focusable = [...panel.querySelectorAll('button:not(:disabled),a,summary')].filter(el => el.getClientRects().length);
        const first = focusable[0], last = focusable.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });
    panel.addEventListener('click', async event => {
        const action = event.target.closest('[data-action]')?.dataset.action;
        if (event.target === panel || action === 'close') return close();
        if (!action) return;
        try {
            if (action === 'new-test' || action === 'pending-test') { await unlockAudio(); tone(action === 'new-test' ? 'new_operation' : 'api_pending'); status('صوت اختباري فقط — لا توجد عملية مالية.'); }
            if (action === 'mute') {
                const on = read(key('sound')) !== 'on';
                if (on) { await unlockAudio(); write(key('soundSince'), String(Date.now())); }
                write(key('sound'), on ? 'on' : 'off'); event.target.textContent = on ? 'كتم الصوت' : 'تشغيل الصوت';
                status(on ? 'الصوت مفعّل في هذا المتصفح.' : 'تم كتم صوت الموقع. إشعارات النظام تُضبط من إعدادات الجهاز.');
            }
            if (action === 'enable') {
                // Invoke both permission requests in the original user gesture.
                status('جاري التفعيل؛ وافق على إذن الإشعارات إذا ظهر.');
                const audioReady = unlockAudio();
                const permission = config.configured && 'Notification' in window ? Notification.requestPermission().catch(() => 'denied') : Promise.resolve('unavailable');
                await audioReady; write(key('sound'), 'on'); write(key('soundSince'), String(Date.now()));
                panel.querySelector('[data-action=mute]').textContent = 'كتم الصوت';
                if (!config.configured) { status('تم تفعيل الصوت. يلزم إعداد مفاتيح Web Push على السيرفر لتفعيل الخلفية.'); return; }
                if (await permission !== 'granted') { status('تم تفعيل الصوت. اسمح بإشعارات الموقع من إعدادات المتصفح لاستقبال الخلفية.'); return; }
                if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error('إشعارات الخلفية غير مدعومة هنا. على الآيفون افتح الموقع من الشاشة الرئيسية.');
                const registration = await navigator.serviceWorker.register('/admin-alerts/sw.js', { scope: '/admin-alerts/' });
                const worker = registration.installing || registration.waiting;
                if (!registration.active && worker) await new Promise(resolve => worker.addEventListener('statechange', () => { if (worker.state === 'activated') resolve(); }));
                const raw = atob(config.publicKey.replace(/-/g, '+').replace(/_/g, '/'));
                const publicKey = Uint8Array.from(raw, char => char.charCodeAt(0));
                const subscription = await registration.pushManager.getSubscription() || await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: publicKey });
                const result = await api('/subscribe', { subscription: subscription.toJSON() }); write(key('device'), result.deviceId);
                status('تم تفعيل الصوت وإشعارات هذا الجهاز. جرّب إشعار الجهاز للتأكد من إعدادات النظام.'); await devices();
            }
            if (action === 'push-test') { await api('/test', { deviceId: read(key('device')) }); status('تم قبول الإشعار لدى خدمة الإرسال؛ تأكد من ظهوره على جهازك.'); }
        } catch (error) { status(error.message || 'تعذر تفعيل التنبيه.'); }
    });
    // Any interaction in an admin page can restore an already opted-in audio context.
    document.addEventListener('pointerdown', () => { if (config && read(key('sound')) === 'on') void unlockAudio().catch(() => {}); }, { passive: true });
    navigator.serviceWorker?.addEventListener('message', async event => {
        const data = event.data;
        if (data?.type === 'admin-operation-sound') {
            let handled = false;
            if (data.adminId === config?.adminId && !document.hidden && read(key('sound')) === 'on'
                && context?.state === 'running' && ['new_operation', 'api_pending'].includes(data.kind)) {
                if (await window.adminAlertClaim(`sound:${config.adminId}:${data.id}`)) tone(data.kind);
                handled = true;
            }
            event.ports?.[0]?.postMessage({ handled });
        }
        if (data?.type === 'admin-operation-push' && data.adminId === config?.adminId) {
            panel.querySelector('.ao-delivery').textContent = `آخر إشعار مستلم على هذا الجهاز: ${date(new Date())}`;
            void poll();
        }
    });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) void poll(); });
    window.addEventListener('pagehide', () => clearInterval(timer), { once: true });
    window.addEventListener('pageshow', event => { if (event.persisted) { clearInterval(timer); void poll(); timer = setInterval(() => void poll(), 10000); } });
    void poll(); timer = setInterval(() => void poll(), 10000);
})();
