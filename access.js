'use strict';
window.DriverAccess=(()=>{
 const key='wallmann.delivery.device.v1',pendingKey=key+'.activation',modeKey=key+'.mode';
 let device=null,blocked=false,busy=false,refreshing=null,lastCheck=0,stream=null,timer=null,generation=0,initialLink='';
 try{device=JSON.parse(localStorage.getItem(key)||'null');if(device&&(!device.id||!device.secret||!device.name))device=null;}catch(_){}
 try{blocked=!device&&localStorage.getItem(modeKey)==='private';}catch(_){}
 const el=id=>document.getElementById(id),normalize=s=>String(s||'').trim().toLocaleLowerCase('da');
 const random=()=>btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
 function parseLink(value){let url;try{url=new URL(value);}catch(_){throw Error('Indsæt hele privatlinket fra lageret.');}const base=new URL('./',location.href);if(url.origin!==base.origin||![base.pathname,base.pathname+'index.html'].includes(url.pathname)||url.username||url.password||url.search)throw Error('QR-koden er ikke et privatlink til LeveringsApp.');const params=new URLSearchParams(url.hash.slice(1)),token=params.get('activate');if([...params.keys()].length!==1||!/^[A-Za-z0-9_-]{43}$/.test(token||''))throw Error('Linket mangler en gyldig aktivering.');return token;}
 function credentials(){return device?{id:device.id,secret:device.secret}:undefined;}
 function canUse(){return !blocked&&!busy;}
 function render(){
  const badge=el('driverIdentity'),select=el('driverSelect'),status=el('accessStatus');if(!badge)return;
  select.hidden=!!device;
  badge.hidden=!device;badge.textContent=device?device.name:'';
  if(device){if(![...select.options].some(o=>o.value===device.name))select.add(new Option(device.name,device.name));select.value=device.name;}
  el('activateAccess').textContent=device?'Min privatadgang':'Aktivér privatadgang';
  if(blocked)status.textContent=device?'Denne enheds adgang er stoppet. Kontakt lageret. Ventende leveringer bliver på telefonen.':'Aktivér appen med privatlinket fra lageret. Ventende leveringer bliver på telefonen.';
  else status.textContent='';
  updateHomeButtons();
 }
 function denied(message){blocked=true;render();if(message)el('accessStatus').textContent=message;}
 async function refresh(){if(PREVIEW||!navigator.onLine||refreshing||busy||Date.now()-lastCheck<60000)return;lastCheck=Date.now();refreshing=(async()=>{
  try{const result=await apiPost('driverAccessStatus',{},15000);try{localStorage.setItem(modeKey,result.mode);}catch(_){}if(device&&result.identity){device={...device,...result.identity};try{localStorage.setItem(key,JSON.stringify(device));}catch(_){}}blocked=false;render();}
  catch(e){if(e.accessBlocked)denied(e.message);}
 })().finally(()=>refreshing=null);return refreshing;}
 function stopCamera(){generation++;clearTimeout(timer);stream?.getTracks().forEach(t=>t.stop());stream=null;const video=el('accessVideo');if(video){video.srcObject=null;video.hidden=true;}}
 function close(){if(busy)return;stopCamera();el('accessDialog').close();}
 async function submit(value){
  if(busy)return;let token;try{token=parseLink(value);}catch(e){el('activationMessage').textContent=e.message;return;}
  stopCamera();busy=true;render();el('activationMessage').textContent='Kontrollerer chauffør og enhed…';el('accessForm').inert=true;el('scanAccess').disabled=true;
  try{
   if(queuePromise)await queuePromise;
   const preview=await apiPost('previewDriverInvite',{token},20000);
   const pending=await getAllPendingDeliveries();
   if((hasDraft()&&normalize(activeDriver||driverSelect.value)!==normalize(preview.name))||pending.some(p=>normalize(p.driver)!==normalize(preview.name)))throw Error('Der ligger en levering til en anden chauffør på telefonen. Send den først, eller kontakt lageret. Den er ikke ændret.');
   if(device&&!blocked&&device.driverId!==preview.driverId)throw Error('Telefonen er allerede knyttet til '+device.name+'. Kontakt lageret før den skifter chauffør.');
   if(!confirm('Aktivér denne enhed som '+preview.name+' · '+preview.label+'?')){el('activationMessage').textContent='Aktiveringen er annulleret.';return;}
   let enrollment;try{enrollment=JSON.parse(localStorage.getItem(pendingKey)||'null');}catch(_){}
   if(!enrollment||enrollment.token!==token)enrollment={token,secret:random()};
   localStorage.setItem(pendingKey,JSON.stringify(enrollment));
   el('activationMessage').textContent='Aktiverer privatadgang…';
   const result=await apiPost('enrollDriver',enrollment,30000);
   const next={...result.identity,secret:enrollment.secret};localStorage.setItem(key,JSON.stringify(next));device=next;localStorage.removeItem(pendingKey);blocked=false;
   el('activationMessage').textContent='Aktiveret. Velkommen, '+device.name+'.';render();el('accessDialog').close();initialLink='';
  }catch(e){el('activationMessage').textContent=e.message||'Aktiveringen kunne ikke fuldføres. Prøv igen med samme link.';}
  finally{busy=false;el('accessForm').inert=false;el('scanAccess').disabled=false;render();processPendingQueue();}
 }
 function show(){
  const installed=navigator.standalone===true||matchMedia('(display-mode: standalone)').matches;
  const mobile=/iPhone|iPad|iPod|Android/i.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
  el('accessDialog').showModal();el('activationMessage').textContent='';el('accessIdentity').textContent=device?device.name+' · '+device.label:'';
  const needsInstall=mobile&&!installed&&!device;
  el('accessInstall').hidden=!needsInstall;el('accessControls').hidden=needsInstall;
  if(initialLink){el('privateLink').value=initialLink;el('pasteAccess').open=true;}
  else{try{const p=JSON.parse(localStorage.getItem(pendingKey)||'null');if(p){el('privateLink').value=new URL('./',location.href).href+'#activate='+p.token;el('pasteAccess').open=true;el('activationMessage').textContent='En aktivering afventer. Tryk Aktivér for at fortsætte med samme link.';}}catch(_){}}
 }
 async function scan(){
  stopCamera();el('activationMessage').textContent='Hold kameraet mod din personlige QR-kode på lager-PC’en.';const own=++generation;
  try{if(typeof jsQR!=='function')throw Error('QR-scanneren kunne ikke indlæses.');
   const acquired=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'},width:{ideal:1280},height:{ideal:720}},audio:false});if(own!==generation){acquired.getTracks().forEach(t=>t.stop());return;}stream=acquired;const video=el('accessVideo');video.hidden=false;video.srcObject=stream;await video.play();const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d',{willReadFrequently:true});
   function frame(){if(own!==generation)return;if(video.readyState>=2&&video.videoWidth){const scale=Math.min(1,960/video.videoWidth);canvas.width=Math.round(video.videoWidth*scale);canvas.height=Math.round(video.videoHeight*scale);ctx.drawImage(video,0,0,canvas.width,canvas.height);const pixels=ctx.getImageData(0,0,canvas.width,canvas.height),code=jsQR(pixels.data,pixels.width,pixels.height,{inversionAttempts:'dontInvert'});if(code){try{parseLink(code.data);submit(code.data);return;}catch(e){el('activationMessage').textContent=e.message;}}}timer=setTimeout(frame,180);}frame();
  }catch(_){stopCamera();el('activationMessage').textContent='Kameraet kunne ikke åbnes. Tillad kamera, eller indsæt privatlinket nedenfor.';el('pasteAccess').open=true;}
 }
 function init(){
  const dialog=document.createElement('dialog');dialog.id='accessDialog';dialog.className='access-dialog';dialog.setAttribute('aria-label','Privatadgang');
  dialog.innerHTML='<div class="access-top"><h2>Privatadgang</h2><button id="closeAccess" type="button" aria-label="Luk privatadgang">×</button></div><p id="accessIdentity"></p><div id="accessInstall"><p>Åbn først LeveringsApp fra ikonet på hjemmeskærmen. Vælg derefter Aktivér privatadgang.</p><p>Har du ikke appen endnu? Vælg Del → Føj til hjemmeskærm på iPhone, eller Installér app på Android.</p><p>Scan din personlige QR fra lager-PC’en inde i appen.</p></div><div id="accessControls"><p>Scan den personlige QR-kode fra lageret. Din chauffør vælges automatisk fremover.</p><button type="button" id="scanAccess" class="btn primary">Scan personlig QR</button><video id="accessVideo" autoplay muted playsinline hidden></video><details id="pasteAccess"><summary>Indsæt privatlink</summary><form id="accessForm"><label for="privateLink">Personligt aktiveringslink</label><textarea id="privateLink" rows="3" required autocomplete="off" autocapitalize="off" spellcheck="false"></textarea><button type="submit" class="btn primary">Aktivér</button></form></details></div><p id="activationMessage" role="status" aria-live="polite"></p>';
  document.body.append(dialog);el('activateAccess').onclick=show;el('closeAccess').onclick=close;dialog.addEventListener('cancel',e=>{if(busy)e.preventDefault();else stopCamera();});el('scanAccess').onclick=scan;el('accessForm').onsubmit=e=>{e.preventDefault();submit(el('privateLink').value);};
  if(new URLSearchParams(location.hash.slice(1)).has('activate')){initialLink=location.href;history.replaceState(null,'',location.pathname+location.search);show();}
  render();refresh();
 }
 document.addEventListener('visibilitychange',()=>{if(document.hidden){stopCamera();if(el('accessDialog')?.open&&!busy)el('accessDialog').close();}else refresh();});window.addEventListener('online',()=>{lastCheck=0;refresh();});window.addEventListener('pagehide',stopCamera);
 window.addEventListener('storage',e=>{if(e.key===key&&e.newValue!==JSON.stringify(device)){denied('Adgangen er ændret i en anden fane. Luk og åbn appen igen. Dine leveringer er bevaret.');}});
 return {init,credentials,canUse,denied,parseLink,refresh,identity:()=>device,busy:()=>busy};
})();
