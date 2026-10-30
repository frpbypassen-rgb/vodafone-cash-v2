(() => {
    'use strict';
    const dialog = document.getElementById('retailMoreDialog');
    const search = document.getElementById('retailMoreSearch');
    const triggers = [...document.querySelectorAll('[data-retail-more-open]')];
    if (!dialog || !search || !triggers.length) return;
    let originalOverflow = '';
    const filterPages = () => {
        const term = search.value.trim().toLocaleLowerCase('ar');
        let count = 0;
        dialog.querySelectorAll('.retail-directory-group').forEach((group) => {
            let matches = 0;
            group.querySelectorAll('a').forEach((link) => {
                const visible = link.textContent.toLocaleLowerCase('ar').includes(term);
                link.hidden = !visible;
                if (visible) matches++;
            });
            group.hidden = matches === 0;
            count += matches;
        });
        dialog.querySelector('.retail-more-empty').hidden = count !== 0;
    };
    triggers.forEach((button) =>
        button.addEventListener('click', () => {
            if (dialog.open) return;
            originalOverflow = document.body.style.overflow;
            dialog.showModal();
            document.body.style.overflow = 'hidden';
            triggers.forEach((trigger) => trigger.setAttribute('aria-expanded', 'true'));
            search.focus({ preventScroll: true });
        })
    );
    dialog.querySelector('[data-retail-more-close]').addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => {
        document.body.style.overflow = originalOverflow;
        triggers.forEach((trigger) => trigger.setAttribute('aria-expanded', 'false'));
    });
    dialog.addEventListener('click', (event) => {
        if (event.target !== dialog) return;
        const box = dialog.getBoundingClientRect();
        if (
            event.clientX < box.left ||
            event.clientX > box.right ||
            event.clientY < box.top ||
            event.clientY > box.bottom
        )
            dialog.close();
    });
    search.addEventListener('input', filterPages);
})();
