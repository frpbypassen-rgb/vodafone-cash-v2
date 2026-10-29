(() => {
    'use strict';
    const form=document.getElementById('loginForm');
    if(!form)return;
    const slots=[...form.querySelectorAll('[data-mfa-digit]')];
    const code=form.querySelector('[name=mfaToken]');
    const button=document.getElementById('submitBtn');
    const normalize=value=>String(value).replace(/[٠-٩]/g,c=>String(c.charCodeAt(0)-1632))
        .replace(/[۰-۹]/g,c=>String(c.charCodeAt(0)-1776)).replace(/\D/g,'');
    let busy=false;
    const sync=()=>{code.value=slots.map(s=>s.value).join('');button.disabled=busy||!/^\d{6}$/.test(code.value);};
    const fill=text=>{const value=normalize(text).slice(0,6);slots.forEach((s,i)=>{s.value=value[i]||'';});slots[Math.min(value.length,5)].focus();sync();};
    slots.forEach((slot,index)=>{
        slot.addEventListener('input',()=>{const value=normalize(slot.value);if(value.length>1){fill(value);return;}slot.value=value;if(value&&index<5)slots[index+1].focus();sync();});
        slot.addEventListener('paste',event=>{event.preventDefault();fill(event.clipboardData.getData('text'));});
        slot.addEventListener('keydown',event=>{if(event.key==='Backspace'&&!slot.value&&index>0)slots[index-1].focus();});
    });
    form.addEventListener('submit',async event=>{
        event.preventDefault();sync();if(busy||button.disabled)return;
        busy=true;sync();button.textContent='جارٍ التحقق…';
        const ok=await window.loginLocation.ensure();
        if(window.loginLocation.required&&!ok){busy=false;sync();button.textContent='تأكيد ومتابعة';document.getElementById('locationRetryButton').focus();return;}
        HTMLFormElement.prototype.submit.call(form);
    });
    document.querySelector('[data-mfa-theme]').addEventListener('click',()=>{
        const theme=document.documentElement.dataset.theme==='light'?'dark':'light';
        document.documentElement.dataset.theme=theme;
        try{localStorage.setItem('ahram_theme',theme);}catch(_){/* No persistent theme. */}
    });
    sync();
})();
