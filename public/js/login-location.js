(() => {
    'use strict';
    const form=document.getElementById('loginForm');
    if(!form)return;
    const required=form.dataset.locationRequired==='true';
    const status=document.getElementById('locationStatus');
    const retry=document.getElementById('locationRetryButton');
    const latitude=document.getElementById('latitudeInput');
    const longitude=document.getElementById('longitudeInput');
    const accuracy=document.getElementById('locationAccuracyInput');
    const challenge=form.querySelector('.auth-control-room');
    if(challenge){
        challenge.append(status,retry);
        if(required){
            status.style.setProperty('display','block','important');
            status.style.setProperty('color','#c4d4e8','important');
        }
    }
    const hasLocation=()=>latitude.value!=='' && longitude.value!=='' && Number.isFinite(Number(latitude.value)) && Math.abs(Number(latitude.value))<=90 && Number.isFinite(Number(longitude.value)) && Math.abs(Number(longitude.value))<=180;
    let inFlight=null,generation=0;
    const message=(text,failed=false)=>{status.textContent=text;retry.hidden=!failed;};
    const requestLocation=()=>{
        if(hasLocation())return Promise.resolve(true);
        if(inFlight)return inFlight;
        if(!window.isSecureContext){message('الموقع يحتاج رابط HTTPS آمنًا. افتح الموقع من رابطه الرسمي.',true);return Promise.resolve(false);}
        if(!navigator.geolocation){message('تعذر استخدام موقع الجهاز في هذا المتصفح. افتح الموقع في متصفح يدعم تحديد الموقع.',true);return Promise.resolve(false);}
        message('جارٍ تحديد موقع الجهاز. انتظر السماح من المتصفح…');
        retry.disabled=true;
        const token=++generation;
        const wait=required?20000:3500;
        inFlight=Promise.resolve().then(()=>new Promise(resolve=>{
            let settled=false;
            const finish=(ok,error)=>{
                if(token!==generation){resolve(false);return;}
                if(ok)message('تم تحديد الموقع. يمكنك متابعة الدخول.');
                else message(error || 'انتهت مهلة تحديد موقع الجهاز. تأكد من تشغيل الموقع ثم أعد المحاولة.',true);
                if(!settled){settled=true;clearTimeout(timer);retry.disabled=false;inFlight=null;resolve(ok);}
            };
            const timer=setTimeout(()=>finish(false),wait+250);
            try{
                navigator.geolocation.getCurrentPosition(position=>{
                    if(token!==generation)return;
                    const lat=position.coords.latitude,lon=position.coords.longitude;
                    if(!Number.isFinite(lat)||Math.abs(lat)>90||!Number.isFinite(lon)||Math.abs(lon)>180){finish(false,'تعذر تحديد موقع الجهاز. أعد المحاولة.');return;}
                    latitude.value=lat;longitude.value=lon;accuracy.value=Number.isFinite(position.coords.accuracy)?position.coords.accuracy:'';
                    finish(true);
                },error=>finish(false,error.code===1?'تم رفض إذن موقع الجهاز. اسمح بالموقع في إعدادات الموقع والمتصفح، ثم أعد المحاولة.':error.code===2?'تعذر تحديد موقع الجهاز. شغّل خدمات الموقع في الهاتف ثم أعد المحاولة.':'انتهت مهلة تحديد موقع الجهاز. تأكد من تشغيل الموقع ثم أعد المحاولة.'),{enableHighAccuracy:false,timeout:wait,maximumAge:300000});
            }catch(_error){finish(false,'تعذر طلب موقع الجهاز. أعد المحاولة من المتصفح مباشرة.');}
        }));
        return inFlight;
    };
    retry.addEventListener('click',()=>{requestLocation();});
    window.loginLocation={required,ensure:requestLocation,ready:requestLocation()};
    let submitting=false;
    form.addEventListener('submit',async event=>{
        if(form.querySelector('[data-auth-code-input]'))return;
        event.preventDefault();
        if(submitting)return;
        submitting=true;
        const button=document.getElementById('submitBtn');
        const original=button?.innerHTML;
        if(button){button.disabled=true;button.textContent='جارٍ تأكيد الموقع…';}
        const ok=await requestLocation();
        if(required&&!ok){
            submitting=false;
            if(button){button.disabled=false;button.innerHTML=original;}
            retry.focus();
            return;
        }
        HTMLFormElement.prototype.submit.call(form);
    });
})();
