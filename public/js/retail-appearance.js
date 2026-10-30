'use strict';
window.addEventListener('DOMContentLoaded', () => {
    const page = document.querySelector('[data-retail-appearance]');
    const api = window.customerAppearance;
    if (!page || !api) return;
    const find = (selector) => page.querySelector(selector);
    const form = find('[data-ra-form]');
    const radios = [...form.querySelectorAll('[name=appearance]')];
    const names = { day: 'نهاري', night: 'ليلي', system: 'حسب الجهاز' };
    let saved = api.current(),
        selected = saved,
        leaving = false;
    const dirty = () => selected !== saved;
    const render = () => {
        radios.forEach((radio) => {
            radio.checked = radio.value === selected;
        });
        find('[data-ra-preview]').dataset.raPreview = api.resolve(selected) === 'night' ? 'night' : 'day';
        find('[data-ra-preview-label]').textContent = names[selected] || 'المظهر الحالي';
        find('[data-ra-description]').textContent =
            selected === 'system'
                ? 'يتغير تلقائيًا مع إعداد الجهاز، حتى أثناء فتح البوابة.'
                : 'مظهر ثابت لا يتغير مع إعداد الجهاز.';
        find('[data-ra-save]').disabled = !dirty();
        find('[data-ra-status]').textContent = dirty()
            ? 'لديك تغيير غير محفوظ.'
            : 'لا توجد تغييرات غير محفوظة.';
    };
    radios.forEach((radio) =>
        radio.addEventListener('change', () => {
            selected = radio.value;
            render();
        })
    );
    form.addEventListener('submit', (event) => {
        event.preventDefault();
        if (!dirty()) return;
        try {
            api.save(selected);
            saved = selected;
            render();
            find('[data-ra-status]').textContent = 'تم حفظ المظهر بنجاح.';
        } catch (_) {
            find('[data-ra-status]').textContent =
                'تعذر حفظ المظهر. اسمح بتخزين بيانات الموقع وأعد المحاولة.';
        }
    });
    window.addEventListener('customer-appearance-saved', (event) => {
        saved = event.detail;
        selected = saved;
        render();
    });
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', render);
    window.addEventListener('beforeunload', (event) => {
        if (!dirty() || leaving) return;
        event.preventDefault();
        event.returnValue = '';
    });
    document.addEventListener('click', (event) => {
        const link = event.target.closest('a[href]');
        if (
            !link ||
            !dirty() ||
            event.defaultPrevented ||
            event.button !== 0 ||
            event.ctrlKey ||
            event.metaKey ||
            event.shiftKey ||
            event.altKey ||
            link.target === '_blank' ||
            link.getAttribute('href').startsWith('#')
        )
            return;
        if (!window.confirm('لديك تغيير غير محفوظ في المظهر. هل تريد المغادرة دون حفظ؟'))
            event.preventDefault();
        else leaving = true;
    });
    window.addEventListener('pageshow', () => {
        leaving = false;
    });
    render();
});
