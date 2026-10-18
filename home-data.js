'use strict';
const HOME_CACHE = PREVIEW ? 'wallmann_preview_home_v1' : 'wallmann_home_v1';
let homeData = null, homeRequest = null, lastHomeAttempt = 0, pendingDirectory = null;
function homeMonth() { const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Copenhagen',year:'numeric',month:'2-digit'}).formatToParts(new Date());return parts.find(p=>p.type==='year').value+'-'+parts.find(p=>p.type==='month').value; }
function validDirectory(items) { return Array.isArray(items) && items.length<=200 && items.every(d=>d && typeof d.name==='string' && d.name.trim() && d.name.length<=120 && typeof d.id==='string'); }
function applyDriverDirectory(items) {
  if(!validDirectory(items))return;
  if(hasDraft() || isSaving || photoBusy || scanBusy || document.activeElement===driverSelect) {pendingDirectory=items;return;}
  let selected=driverSelect.value;try{selected=selected||localStorage.getItem('leveringsapp_driver')||'';}catch(_){}
  driverSelect.replaceChildren(new Option('Vælg chauffør',''));
  driverSelect.options[0].disabled=true;driverSelect.options[0].hidden=true;
  for(const driver of items)driverSelect.add(new Option(driver.name,driver.name));
  driverSelect.value=items.some(d=>d.name===selected)?selected:'';
  $('driverDirectoryNote').textContent=items.length?'':'Ingen aktive chauffører. Kontakt administratoren.';
  pendingDirectory=null;updateHomeButtons();
}
function renderHomeData() {
  const summary=homeData?.summary, value=$('monthTotal'), note=$('monthNote');
  if(!summary || summary.month!==homeMonth() || !Number.isInteger(summary.total) || summary.total<0 || !Number.isFinite(Date.parse(summary.asOf))) {value.textContent='—';$('yearTotal').textContent='—';note.textContent=navigator.onLine?'Henter i baggrunden':'Opdateres, når der er forbindelse';return;}
  value.textContent=new Intl.NumberFormat('da-DK').format(summary.total);
  $('yearTotal').textContent=Number.isInteger(summary.yearTotal)?new Intl.NumberFormat('da-DK').format(summary.yearTotal):'—';
  note.textContent=PREVIEW?'Eksempeltal · alle chauffører':'';
}
async function refreshHomeData(force=false) {
  if(homeRequest || document.hidden || !navigator.onLine || isSaving || photoBusy || scanBusy || uploadInProgress)return;
  if(!force && Date.now()-lastHomeAttempt<60000)return;
  lastHomeAttempt=Date.now();
  homeRequest=(async()=>{
    try {
      const data=PREVIEW?previewHomeData():await apiPost('getAppHomeData',{},20000);
      if(!data || typeof data!=='object')return;
      homeData={...(homeData||{}),...data};
      if(validDirectory(data.drivers))applyDriverDirectory(data.drivers);
      try{localStorage.setItem(HOME_CACHE,JSON.stringify(homeData));}catch(_){}
      renderHomeData();
    }catch(_){renderHomeData();if(!homeData?.summary)$('monthNote').textContent='Tal midlertidigt utilgængeligt';}
  })().finally(()=>{homeRequest=null;});
  return homeRequest;
}
// A stored directory is ready before load/restoreDraft. Network is never on the start path.
try {homeData=JSON.parse(localStorage.getItem(HOME_CACHE)||'null');if(validDirectory(homeData?.drivers))applyDriverDirectory(homeData.drivers);}catch(_){}
window.addEventListener('load',()=>{renderHomeData();setTimeout(()=>refreshHomeData(),1200);});
window.addEventListener('online',()=>refreshHomeData(true));
window.addEventListener('offline',renderHomeData);
document.addEventListener('visibilitychange',()=>{if(!document.hidden){renderHomeData();refreshHomeData();}});
driverSelect.addEventListener('blur',()=>{if(pendingDirectory)applyDriverDirectory(pendingDirectory);});
document.addEventListener('click',()=>queueMicrotask(()=>{if(pendingDirectory)applyDriverDirectory(pendingDirectory);}));
window.addEventListener('storage',event=>{if(PREVIEW && event.key==='wallmann_preview_driver_directory'){refreshHomeData(true);}});
setInterval(()=>{renderHomeData();if(pendingDirectory)applyDriverDirectory(pendingDirectory);if($('screen-home').classList.contains('active'))refreshHomeData();},60000);
