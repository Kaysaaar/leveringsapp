'use strict';
const DEMO = false;
const byId = id => document.getElementById(id);
let searchGeneration = 0, lastFocus = null, dialogItems = [], dialogIndex = 0;
const downloadUrls = new Set();
// Share three slots across galleries, retries and overlapping searches.
const imageRequests = [];
let activeImageRequests = 0;
function queueImageRequest(generation, request) {
  return new Promise((resolve,reject)=>{imageRequests.push({generation,request,resolve,reject});drainImageRequests();});
}
function drainImageRequests() {
  while(activeImageRequests < 3 && imageRequests.length) {
    const job=imageRequests.shift();
    if(job.generation !== searchGeneration){job.resolve(null);continue;}
    activeImageRequests++;
    Promise.resolve().then(job.request).then(job.resolve,job.reject).finally(()=>{activeImageRequests--;drainImageRequests();});
  }
}
function downloadUrl(dataUrl) {
  const parts=dataUrl.split(','); const mime=(parts[0].match(/^data:(image\/(?:png|jpeg|webp));base64$/)||[])[1];
  if(!mime) throw new Error('Billedformatet understøttes ikke.');
  const bytes=Uint8Array.from(atob(parts[1]),c=>c.charCodeAt(0));
  const url=URL.createObjectURL(new Blob([bytes],{type:mime})); downloadUrls.add(url); return url;
}
const dateFormat = new Intl.DateTimeFormat('da-DK', {dateStyle:'medium', timeStyle:'short', timeZone:'Europe/Copenhagen'});
function el(tag, cls, text) { const n = document.createElement(tag); if(cls) n.className = cls; if(text !== undefined) n.textContent = text; return n; }
function rpc(method,...args){return window.OfficeAccess.rpc(method,...args);}
function status(text, error = false) { byId('searchStatus').textContent = text; byId('searchStatus').className = error ? 'error' : ''; }
function safeDriveLink(url) { return /^https:\/\/drive\.google\.com\/drive\/folders\/[A-Za-z0-9_-]+$/.test(url); }
function formatDate(value) { const date = new Date(value); return Number.isFinite(date.getTime()) ? dateFormat.format(date) : 'Dato ikke registreret'; }
function emptyState(title, text) {
  const wrap = el('div','empty-state'); wrap.append(el('div','empty-icon','⌕'),el('h3','',title),el('p','',text));
  byId('resultList').replaceChildren(wrap);
}
async function searchOrder(order) {
  for(const url of downloadUrls) URL.revokeObjectURL(url); downloadUrls.clear();
  if(byId('imageDialog').open) byId('imageDialog').close();
  order = order.trim(); const generation = ++searchGeneration;
  byId('orderInput').value = order;
  byId('resultList').replaceChildren(); byId('resultCount').textContent = '';
  if (!/^\d{6}$/.test(order)) {
    byId('searchButton').disabled=false;byId('searchButton').textContent='Søg';
    byId('resultHeading').textContent = 'Kontrollér ordrenummeret';
    status('Ordrenummeret skal bestå af præcis 6 cifre. Foranstillede nuller bevares.',true);
    byId('orderInput').focus(); return;
  }
  byId('searchButton').disabled = true; byId('searchButton').textContent = 'Søger…';
  byId('resultHeading').textContent = 'Ordre ' + order;
  byId('resultEyebrow').textContent = 'SØGERESULTAT'; status('');
  byId('resultList').append(el('div','loading','Finder leveringer…'));
  try {
    const result = await rpc('searchDeliveries', order);
    if(generation !== searchGeneration) return;
    const deliveries = result.deliveries;
    if (!Array.isArray(deliveries)) throw new Error('Svaret kunne ikke læses. Prøv igen.');
    byId('resultList').replaceChildren();
    byId('resultCount').textContent = deliveries.length + (deliveries.length === 1 ? ' levering fundet' : ' leveringer fundet');
    if (!deliveries.length) emptyState('Ingen leveringer fundet', 'Kontrollér nummeret. En levering kan først findes her, når chaufførens upload er gennemført.');
    if (result.truncated) status('Viser de 100 nyeste registreringer. Kontakt administratoren, hvis du mangler en ældre levering.');
    // Load one delivery at a time to avoid flooding Apps Script / Drive.
    for (const delivery of deliveries) {
      const view = deliveryCard(delivery, order);
      byId('resultList').append(view.card);
      view.load = () => loadMedia(view, delivery, order, generation);
    }
    for (const button of byId('resultList').querySelectorAll('[data-load]')) {
      if(generation !== searchGeneration) break;
      await button.loadMedia();
    }
  } catch(error) {
    if(generation !== searchGeneration) return;
    emptyState('Søgningen kunne ikke gennemføres','Prøv igen. Dine leveringer og billeder er ikke ændret.');
    status(error.message,true);
  } finally {
    if(generation === searchGeneration) { byId('searchButton').disabled = false; byId('searchButton').innerHTML = 'Søg <span aria-hidden="true">→</span>'; }
  }
}
function deliveryCard(delivery, searchedOrder) {
  const card = el('article','delivery');
  const header = el('div','delivery-header'), title = el('div','delivery-title');
  title.append(el('h3','',delivery.orders.length > 1 ? 'Samlet levering' : 'Levering'),el('span','badge',delivery.orders.length > 1 ? delivery.orders.length + ' ordrenumre' : 'Registreret'));
  header.append(title); card.append(header);
  const body = el('div','delivery-body'), details = el('aside','details'), list = el('dl');
  [['Dato',formatDate(delivery.date)],['Chauffør',delivery.driver || 'Ikke registreret'],['Modtager',delivery.recipient || 'Ikke registreret']].forEach(([label,value])=>{const field=el('div'); field.append(el('dt','',label),el('dd','',value));list.append(field);});
  const orders = el('div'), tags = el('dd','order-tags');
  delivery.orders.forEach(number => tags.append(el('span','order-tag'+(number === searchedOrder ? ' match':''),number)));
  orders.append(el('dt','','Ordrenumre'),tags); list.append(orders);
  const receipt = el('div'); receipt.append(el('dt','','Kvittering'),el('dd','',delivery.hasSignature ? 'Signatur registreret' : 'Ingen signatur')); list.append(receipt);
  details.append(list);
  const media = el('div','media'), heading = el('div','media-heading');
  heading.append(el('h4','','Leveringens billeder'),el('span','',delivery.photoCount + (delivery.photoCount === 1 ? ' billede' : ' billeder') + ' · fælles dokumentation'));
  const content = el('div'); content.append(el('div','loading','Henter billeder og kvittering…'));
  const marker = el('span'); marker.dataset.load=''; marker.hidden=true;
  const view = {card, content, media, delivery}; marker.loadMedia = () => view.load();
  media.append(heading,content,marker); body.append(details,media);card.append(body);return view;
}
async function loadMedia(view, delivery, order, generation) {
  view.content.replaceChildren(el('div','loading','Henter billeder og kvittering…'));
  try {
    const data = await rpc('listDeliveryMedia', order, delivery.row);
    if(generation !== searchGeneration) return;
    const galleryEntries = [];
    const gallery = el('div','gallery'), selection=photoSelection(delivery,generation,galleryEntries); view.content.replaceChildren(selection.bar,gallery);
    for(const item of data.photos) gallery.append(mediaTile(item, delivery, order, generation, galleryEntries, selection));
    if(!data.photos.length) view.content.append(el('p','media-note','Ingen billedfiler er registreret på leveringen.'));
    if(data.warnings?.length) view.content.append(el('p','media-note media-error',data.warnings.join(' ')));
    const signature = el('div','signature'), signatureText = el('div','signature-text');
    signatureText.append(el('h4','','Modtagers kvittering'),el('p','',delivery.recipient || 'Modtagernavn ikke registreret'),el('p','','Gælder alle ordrenumre på leveringen'));
    signature.append(signatureText);
    if(data.signature) { const wrap=el('div','signature-preview');wrap.append(mediaTile(data.signature,delivery,order,generation,galleryEntries));signature.append(wrap); }
    else signature.append(el('span','media-note',delivery.hasSignature ? 'Signaturfilen mangler' : 'Ingen signatur'));
    view.content.append(signature);
    // Keep gallery order stable; individual images appear as soon as they arrive.
    await Promise.all(Array.from(view.content.querySelectorAll('[data-media]'),tile=>tile.loadImage()));
  } catch(error) {
    if(generation !== searchGeneration) return;
    const retry=el('button','retry','Prøv at hente billeder igen');retry.onclick=()=>loadMedia(view,delivery,order,generation);
    view.content.replaceChildren(el('p','media-note media-error',error.message),retry);
  }
}
// A single ZIP download avoids browser restrictions on multiple simultaneous downloads.
// Stored entries preserve original image bytes; no recompression or external library.
function selectedImagesZip(entries) {
  const encoder=new TextEncoder(),parts=[],directory=[];let offset=0;
  const table=Array.from({length:256},(_,n)=>{for(let i=0;i<8;i++)n=(n&1)?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
  for(const entry of entries){
    const bytes=Uint8Array.from(atob(entry.src.split(',')[1]),c=>c.charCodeAt(0)),name=encoder.encode(entry.name);
    let crc=0xffffffff;for(const b of bytes)crc=table[(crc^b)&255]^(crc>>>8);crc=(crc^0xffffffff)>>>0;
    const header=new Uint8Array(30+name.length),h=new DataView(header.buffer);
    h.setUint32(0,0x04034b50,true);h.setUint16(4,20,true);h.setUint16(6,0x800,true);h.setUint16(12,33,true);
    h.setUint32(14,crc,true);h.setUint32(18,bytes.length,true);h.setUint32(22,bytes.length,true);h.setUint16(26,name.length,true);header.set(name,30);
    const central=new Uint8Array(46+name.length),c=new DataView(central.buffer);
    c.setUint32(0,0x02014b50,true);c.setUint16(4,20,true);c.setUint16(6,20,true);c.setUint16(8,0x800,true);c.setUint16(14,33,true);
    c.setUint32(16,crc,true);c.setUint32(20,bytes.length,true);c.setUint32(24,bytes.length,true);c.setUint16(28,name.length,true);c.setUint32(42,offset,true);central.set(name,46);
    parts.push(header,bytes);directory.push(central);offset+=header.length+bytes.length;
  }
  const end=new Uint8Array(22),v=new DataView(end.buffer),size=directory.reduce((n,b)=>n+b.length,0);
  v.setUint32(0,0x06054b50,true);v.setUint16(8,entries.length,true);v.setUint16(10,entries.length,true);v.setUint32(12,size,true);v.setUint32(16,offset,true);
  return new Blob([...parts,...directory,end],{type:'application/zip'});
}
function photoSelection(delivery,generation,entries) {
  const bar=el('div','selection-bar'),toggle=el('button','button selection-toggle','Vælg'),save=el('button','button','Download valgte (0)'),all=el('button','selection-all','Vælg alle'),note=el('span','selection-note');
  const state={active:false,selected:new Set(),tiles:[],bar};
  for(const b of [toggle,save,all])b.type='button';
  note.setAttribute('role','status');toggle.setAttribute('aria-pressed','false');
  state.refresh=()=>{
    toggle.disabled=!state.tiles.some(t=>t.ready);
    toggle.textContent=state.active?'Annuller valg':'Vælg';toggle.setAttribute('aria-pressed',String(state.active));
    save.hidden=all.hidden=!state.active;save.disabled=!state.selected.size;save.textContent='Download valgte ('+state.selected.size+')';
    const ready=state.tiles.filter(t=>t.ready);all.textContent=ready.length&&ready.every(t=>state.selected.has(t.index))?'Fravælg alle':'Vælg alle';
    note.textContent=state.active?'De valgte billeder hentes i én ZIP-fil i original kvalitet.':'';
    for(const t of state.tiles){t.box.hidden=!state.active;t.tile.classList.toggle('selecting',state.active);t.input.disabled=!t.ready;t.input.checked=state.selected.has(t.index);t.tile.classList.toggle('selected',t.input.checked);t.open.setAttribute('aria-label',(state.active?'Vælg ':'Forstør ')+t.label);}
  };
  state.choose=index=>{if(!entries[index])return;state.selected.has(index)?state.selected.delete(index):state.selected.add(index);state.refresh();};
  toggle.onclick=()=>{state.active=!state.active;if(!state.active)state.selected.clear();state.refresh();};
  all.onclick=()=>{const ready=state.tiles.filter(t=>t.ready),clear=ready.every(t=>state.selected.has(t.index));for(const t of ready)clear?state.selected.delete(t.index):state.selected.add(t.index);state.refresh();};
  save.onclick=()=>{
    if(generation!==searchGeneration)return;
    const chosen=[...state.selected].sort((a,b)=>a-b).map(i=>entries[i]).filter(Boolean);if(!chosen.length)return;
    try{const url=URL.createObjectURL(selectedImagesZip(chosen));downloadUrls.add(url);const link=el('a');link.href=url;link.download=delivery.orders.join('_')+'_billeder.zip';bar.append(link);link.click();link.remove();setTimeout(()=>{URL.revokeObjectURL(url);downloadUrls.delete(url);},60000);}
    catch(_){note.textContent='Billederne kunne ikke pakkes. Prøv færre ad gangen, eller brug Download under hvert billede.';}
  };
  bar.append(toggle,all,save,note);state.refresh();return state;
}

function mediaTile(item, delivery, order, generation, galleryEntries, selection = null) {
  const entryIndex=galleryEntries.length;galleryEntries.push(null);
  const tile=el('div','photo');tile.dataset.media='';
  const open=el('button','photo-open');open.type='button';open.setAttribute('aria-label','Forstør '+item.label);open.disabled=true;
  const placeholder=el('span','media-note','Henter…');open.append(placeholder);
  const foot=el('div','photo-foot'), label=el('span','',item.label), download=el('a','download','Download ↓');
  foot.append(label);tile.append(open,foot);
  let choice=null;
  if(selection){const box=el('label','photo-check'),input=el('input');input.type='checkbox';input.setAttribute('aria-label','Vælg '+item.label);box.append(input);tile.append(box);choice={box,input,tile,open,index:entryIndex,label:item.label,ready:false};selection.tiles.push(choice);input.onchange=()=>selection.choose(entryIndex);selection.refresh();}
  tile.loadImage=async()=>{
    try {
      const data=await queueImageRequest(generation,()=>rpc('getDeliveryImage',order,delivery.row,item.column,item.fileIndex || 0));
      if(generation!==searchGeneration)return;
      // Kun rasterbilleder. SVG kan indeholde scripts og er derfor aldrig tilladt.
      if(!/^data:image\/(png|jpeg|webp);base64,/.test(data.dataUrl))throw new Error('Billedformatet understøttes ikke.');
      const img=el('img');img.alt=item.label+' · levering '+delivery.orders.join(', ');img.src=data.dataUrl;
      img.onerror=()=>{open.replaceChildren(el('span','media-note','Billedet kunne ikke vises'));};
      open.replaceChildren(img);open.disabled=false;
      const fileName=delivery.orders.join('_')+'_'+(delivery.date||'udateret').slice(0,10)+'_'+item.label.toLowerCase().replace(/[^a-zæøå0-9]+/g,'_')+'.'+data.extension;
      const fileUrl=downloadUrl(data.dataUrl);
      download.href=fileUrl;download.download=fileName;download.setAttribute('aria-label','Download '+item.label);foot.append(download);
      galleryEntries[entryIndex]={src:data.dataUrl,label:img.alt,name:fileName,fileUrl};
      if(byId('imageDialog').open && dialogItems===galleryEntries)renderDialogImage();
      if(choice){choice.ready=true;selection.refresh();}
      open.onclick=()=>selection?.active?selection.choose(entryIndex):showImage(galleryEntries,entryIndex);
    }catch(error){if(generation!==searchGeneration)return;open.replaceChildren(el('span','media-note','Kunne ikke hentes'));const retry=el('button','download','Prøv igen');retry.title=error.message;retry.onclick=()=>{retry.remove();tile.loadImage();};foot.append(retry);}
  };
  return tile;
}
function nextImageIndex(direction){let index=dialogIndex+direction;while(index>=0 && index<dialogItems.length){if(dialogItems[index])return index;index+=direction;}return -1;}
function renderDialogImage(){const item=dialogItems[dialogIndex];if(!item)return;byId('dialogImage').src=item.src;byId('dialogImage').alt=item.label;byId('dialogLabel').textContent=item.label;byId('dialogDownload').href=item.fileUrl;byId('dialogDownload').download=item.name;byId('dialogDownload').textContent=item.name.includes('signatur')?'Download signatur ↓':'Download billede ↓';byId('imagePosition').textContent=(dialogIndex+1)+' / '+dialogItems.length;byId('previousImage').disabled=nextImageIndex(-1)<0;byId('nextImage').disabled=nextImageIndex(1)<0;}
function showImage(items,index){lastFocus=document.activeElement;dialogItems=items;dialogIndex=index;renderDialogImage();byId('imageDialog').showModal();}
function navigateImage(direction){const next=nextImageIndex(direction);if(next>=0){dialogIndex=next;renderDialogImage();}}
byId('previousImage').onclick=()=>navigateImage(-1);byId('nextImage').onclick=()=>navigateImage(1);
byId('imageDialog').addEventListener('keydown',event=>{if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();navigateImage(event.key==='ArrowLeft'?-1:1);}});
byId('closeDialog').onclick=()=>byId('imageDialog').close();
byId('imageDialog').addEventListener('close',()=>{byId('dialogImage').removeAttribute('src');byId('dialogDownload').removeAttribute('href');lastFocus?.focus();});
function resetSearch() {
  ++searchGeneration; // Discard pending searches and queued image loads.
  drainImageRequests();
  if(byId('imageDialog').open) byId('imageDialog').close();
  dialogItems=[];dialogIndex=0;lastFocus=null;
  for(const url of downloadUrls) URL.revokeObjectURL(url);
  downloadUrls.clear();
  byId('orderInput').value='';
  byId('searchButton').disabled=false;
  byId('searchButton').innerHTML='Søg <span aria-hidden="true">→</span>';
  byId('resultHeading').textContent='Dokumentationen er lige her';
  byId('resultEyebrow').textContent='DIT OVERBLIK';
  byId('resultCount').textContent='';status('');
  emptyState('Hvilken ordre leder du efter?','Søg ovenfor for at se leveringer, billeder og signatur.');
  window.scrollTo({top:0,behavior:'instant'});
  byId('orderInput').focus({preventScroll:true});
}
byId('searchHome').addEventListener('click',resetSearch);
byId('newSearchButton').addEventListener('click',resetSearch);
byId('searchForm').addEventListener('submit',event=>{event.preventDefault();searchOrder(byId('orderInput').value);});
byId('orderInput').addEventListener('input',()=>{byId('orderInput').value=byId('orderInput').value.replace(/\D/g,'').slice(0,6);});
document.querySelectorAll('[data-order]').forEach(button=>button.onclick=()=>searchOrder(button.dataset.order));
if(!DEMO){byId('demoBanner').hidden=true;byId('privacyNote').textContent='Kun for autoriserede medarbejdere';}



'use strict';
let driverAdminState=null,adminBusy=false;
async function adminRpc(method,args){return DEMO?previewAdminCall(method,args):(args===undefined?rpc(method):rpc(method,args));}
function adminStatus(text,error=false){byId('adminStatus').textContent=text;byId('adminStatus').classList.toggle('error',error);}
function renderDriversAdmin(){
  const list=byId('driverAdminList');list.replaceChildren();
  byId('addDriverForm').hidden=!!driverAdminState.needsSetup;
  if(driverAdminState.needsSetup){const setup=el('button','button','Opret Chauffører-ark');setup.onclick=()=>adminChange('initializeDriversAdmin',{});list.append(setup);return;}
  for(const driver of driverAdminState.drivers){const row=el('div','admin-row'+(driver.active?'':' inactive')),name=el('div','',driver.name);name.append(el('small','',driver.active?'Aktiv':'Inaktiv · historik bevaret'));const button=el('button','',driver.active?'Gør inaktiv':'Genaktivér');button.type='button';button.setAttribute('aria-label',(driver.active?'Gør inaktiv: ':'Genaktivér: ')+driver.name);button.onclick=()=>adminChange('setDriverActiveAdmin',{id:driver.id,active:!driver.active});row.append(name,button);list.append(row);}
}
function adminControls(busy){adminBusy=busy;byId('adminDialog').querySelectorAll('button,input').forEach(control=>{if(control.id!=='closeAdmin')control.disabled=busy;});}
async function adminChange(method,args){if(adminBusy)return;adminControls(true);adminStatus('Gemmer…');try{driverAdminState=await adminRpc(method,{...args,revision:driverAdminState?.revision});byId('newDriverName').value='';renderDriversAdmin();adminStatus(DEMO?'Gemt i forhåndsvisningen. Ingen ændringer i jeres ark.':'Gemt. Chaufførernes liste opdateres i baggrunden — ingen ny appversion.');}catch(error){adminStatus(error.message,true);}finally{adminControls(false);}}
byId('adminButton').onclick=async()=>{byId('adminDialog').showModal();byId('driverAdminList').replaceChildren();adminControls(true);adminStatus('Henter chauffører…');try{driverAdminState=await adminRpc('listDriversAdmin');renderDriversAdmin();adminStatus('');}catch(error){adminStatus(error.message,true);}finally{adminControls(false);}};
byId('closeAdmin').onclick=()=>byId('adminDialog').close();
byId('addDriverForm').onsubmit=event=>{event.preventDefault();adminChange('addDriverAdmin',{name:byId('newDriverName').value});};


