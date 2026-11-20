'use strict';
const PREVIEW = window.APP_CONFIG.preview !== false;
const API_URL = PREVIEW ? '' : window.APP_CONFIG.apiUrl;
const APP_VERSION = PREVIEW ? '3.0.9 · forhåndsvisning' : '3.0.9';
const MAX_PHOTOS = 10;
const MAX_ORDERS = 20;
// Keep the existing database and store: v1.21 pending deliveries remain available.
const DB_NAME = PREVIEW ? 'leveringsapp_preview_queue' : 'leveringsapp_db';
const STORE_PENDING = 'pendingDeliveries';
let stopOrders = [], photos = [], selectedPhotoIndex = -1;
let activeDeliveryId = '', deliveryCreatedAt = '', isSaving = false, photoBusy = false;
let hasSignature = false, signaturePadReady = false, isDrawing = false;
let scanMode = 'single', scanBusy = false, scanGeneration = 0, scanAbort = null;
let scannerStream = null, cameraGeneration = 0;
let candidates = [], queuePromise = null, retryTimer = null, retryDelay = 10000;
// Kun UI-status/logning: den eksisterende IndexedDB-kø er stadig den sikre kilde.
let uploadInProgress = false, lastUploadIssue = '', lastUploadSuccessAt = 0, sentBannerTimer = null;
let waitingWorker = null, refreshPending = false, refreshing = false;
let lastSavedId = '';
let activeDriver = '', draftReady = false, restoringDraft = false;
const $ = id => document.getElementById(id);
const driverSelect = $('driverSelect');
const validOrder = value => /^\d{6}$/.test(value);
function pulseHaptic(ms = 14) { try { navigator.vibrate?.(ms); } catch (_) {} }
function setStatus(id, text, type = '') { $(id).textContent = text; $(id).className = 'status ' + type; }
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(el => el.classList.toggle('active', el.id === id));
  document.body.classList.toggle('at-home', id === 'screen-home');
  updateHomeButtons();
}
function hasDraft() { return !!activeDeliveryId; }
function updateHomeButtons() {
  $('newDeliveryBtn').disabled = (window.DriverAccess&&!DriverAccess.canUse()) || !draftReady || !driverSelect.value || isSaving;
  driverSelect.disabled = !draftReady || hasDraft();
  $('newDeliveryBtn').textContent = hasDraft() ? 'Fortsæt levering' : 'Ny levering';
  $('discardBtn').classList.toggle('hidden', !hasDraft());
  showUpdateBanner();
}
function makeId() {
  return 'delivery_' + (globalThis.crypto?.randomUUID ? crypto.randomUUID() : Date.now() + '_' + Math.random().toString(36).slice(2, 12));
}
function startDelivery() {
  if ((window.DriverAccess&&!DriverAccess.canUse()) || !draftReady || !driverSelect.value || isSaving) return;
  if (!activeDeliveryId) { activeDeliveryId = makeId(); activeDriver = driverSelect.value; deliveryCreatedAt = new Date().toISOString(); }
  goToOrder();
}
function goToHome() {
  if (isSaving || photoBusy) return;
  cancelScan(); closeScanner(); showScreen('screen-home'); updatePendingBanner();
  maybeReload();
}
function goToOrder() {
  if (isSaving || photoBusy) return;
  closeScanner(); showScreen('screen-order'); renderOrderLists();
}
async function discardDelivery() {
  if (isSaving || !confirm('Kassér denne kladde med billeder og kvittering?')) return;
  isSaving = true;
  try { await draftWrites; await draftStore('readwrite', store => store.delete('current')); resetAppState(); }
  catch (_) { draftMessage('Kladden kunne ikke slettes. Prøv igen.', true); }
  finally { isSaving = false; goToHome(); updateHomeButtons(); }
}
function handleManualInput() {
  $('manualOrderInput').value = $('manualOrderInput').value.replace(/\D/g, '').slice(0, 6);
  setStatus('orderStatus', '');
}
function addCurrentOrder() {
  const value = $('manualOrderInput').value.trim();
  if (!validOrder(value)) { setStatus('orderStatus', 'Nummeret skal bestå af præcis 6 cifre.', 'error'); return false; }
  if (stopOrders.includes(value)) { setStatus('orderStatus', 'Nummeret er allerede tilføjet.', 'error'); return false; }
  if (stopOrders.length >= MAX_ORDERS) { setStatus('orderStatus', 'Højst 20 numre pr. levering.', 'error'); return false; }
  stopOrders.push(value); $('manualOrderInput').value = ''; renderOrderLists();
  setStatus('orderStatus', 'Nummer tilføjet.', 'ok'); return true;
}
function clearCurrentOrder() { $('manualOrderInput').value = ''; setStatus('orderStatus', ''); }
function removeOrder(value) { stopOrders = stopOrders.filter(n => n !== value); renderOrderLists(); }
function renderOrderLists() {
  [['multiOrderList', 'multiOrderListCard', true], ['cameraOrderList', 'cameraOrderListCard', false]].forEach(([listId, cardId, editable]) => {
    $(listId).replaceChildren(); $(cardId).classList.toggle('hidden', !stopOrders.length);
    stopOrders.forEach(value => {
      const pill = document.createElement('div'); pill.className = 'order-pill'; pill.textContent = value;
      if (editable) {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = '×';
        button.setAttribute('aria-label', 'Fjern ' + value); button.onclick = () => removeOrder(value); pill.append(button);
      }
      $(listId).append(pill);
    });
  });
}
function goToCamera() {
  if (isSaving || scanBusy) return;
  if (!$('scanCandidates').classList.contains('hidden')) { setStatus('orderStatus', 'Vælg eller afvis først de fundne numre.', 'error'); return; }
  const typed = $('manualOrderInput').value.trim();
  if (typed && !stopOrders.includes(typed) && !addCurrentOrder()) return;
  if (!stopOrders.length) { setStatus('orderStatus', 'Tilføj mindst ét nummer.', 'error'); return; }
  $('manualOrderInput').value = ''; closeScanner(); showScreen('screen-camera'); renderOrderLists(); updatePhotoUI();
  
    document.querySelector(
      '#screen-camera .camera-screen-content'
    ).scrollTop = 0;

}

async function apiPost(action, payload = {}, timeoutMs = 30000, externalSignal) {
  if (PREVIEW) throw new Error('Forhåndsvisning: scanning og upload er ikke forbundet til driften. Indtast nummeret manuelt.');
  const controller = new AbortController();
  const abort = () => controller.abort();
  externalSignal?.addEventListener('abort', abort, { once:true });
  if (externalSignal?.aborted) controller.abort();
  const timer = setTimeout(abort, timeoutMs);
  try {
    const response = await fetch(API_URL, {
      method:'POST', headers:{ 'Content-Type':'text/plain;charset=utf-8' },
      body:JSON.stringify({ action, ...payload, access:window.DriverAccess?.credentials() }), signal:controller.signal, redirect:'follow'
    });
    if (!response.ok) throw new Error('Serveren svarede med HTTP ' + response.status);
    let json;
    try { json = await response.json(); } catch (_) { throw new Error('Ugyldigt serversvar. Kontroller Apps Script-implementeringen.'); }
    if (!json.ok) { const error=new Error(json.error || 'Serveren kunne ikke behandle forespørgslen.'); error.accessBlocked=json.accessBlocked===true;if(error.accessBlocked)window.DriverAccess?.denied(error.message);throw error; }
    return json.data;
  } finally { clearTimeout(timer); externalSignal?.removeEventListener('abort', abort); }
}

function setScanBusy(value) {
  scanBusy = value;
  $('scanSingleBtn').disabled = value; $('scanMultiBtn').disabled = value;
  $('manualOrderInput').disabled = value;
}
function cancelScan() {
  scanGeneration++; scanAbort?.abort(); scanAbort = null; setScanBusy(false);
}
async function openOrderScanner(mode = 'single') {
  if (scanBusy || isSaving) return;
  if (!navigator.onLine) { setStatus('orderStatus', 'Ingen forbindelse. Indtast nummeret manuelt.', 'error'); return; }
  scanMode = mode; dismissCandidates();
  $('scannerTitle').textContent = mode === 'multi' ? 'Multi-levering' : 'Scan nummer';
  $('scannerHelp').textContent = mode === 'multi'
    ? 'Læg følgesedlerne forskudt med nummerfelterne under hinanden. Hold alle numre inden for rammen.'
    : 'Hold følgeseddelsnummeret og gerne teksten “Følgeseddel” inden for rammen.';
  $('scanFrame').classList.toggle('multi', mode === 'multi');
  $('captureScanBtn').textContent = mode === 'multi' ? 'Aflæs numrene' : 'Aflæs nummer';
  $('captureScanBtn').disabled = true; $('scannerModal').classList.remove('hidden');
  $('scannerStatus').textContent = 'Starter kamera…';
  const generation = ++cameraGeneration;
  if (!navigator.mediaDevices?.getUserMedia) {
    $('scannerStatus').textContent = 'Brug telefonens kamera med knappen nedenfor.'; return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio:false, video:{ facingMode:{ ideal:'environment' }, width:{ ideal:1920 }, height:{ ideal:1080 } } });
    if (generation !== cameraGeneration) { stream.getTracks().forEach(track => track.stop()); return; }
    scannerStream = stream; const video = $('scannerVideo'); video.srcObject = stream;
    await video.play();
    if (generation !== cameraGeneration) return;
    $('captureScanBtn').disabled = !video.videoWidth;
    $('scannerStatus').textContent = 'Hold stille, og tryk på Aflæs.';
  } catch (_) {
    if (generation !== cameraGeneration) return;
    scannerStream?.getTracks().forEach(track => track.stop()); scannerStream = null;
    $('scannerStatus').textContent = 'Kameraet kunne ikke åbnes her. Brug telefonens kamera nedenfor.';
  }
}
function closeScanner() {
  cameraGeneration++; scannerStream?.getTracks().forEach(track => track.stop()); scannerStream = null;
  $('scannerVideo').srcObject = null; $('scannerModal').classList.add('hidden');
}
function useNativeScanner() {
  closeScanner();
  setStatus('orderStatus', scanMode === 'multi' ? 'Tag et tæt foto af alle nummerfelter. Hele fotoet aflæses.' : 'Tag et tæt foto af nummerfeltet. Hele fotoet aflæses.');
  $('barcodeInput').click();
}
// Map the visible frame to video coordinates, including object-fit:cover cropping.
function scanRectangle(videoWidth, videoHeight, viewport, frame) {
  const scale = Math.max(viewport.width / videoWidth, viewport.height / videoHeight);
  const offsetX = (videoWidth * scale - viewport.width) / 2;
  const offsetY = (videoHeight * scale - viewport.height) / 2;
  return { x:(frame.left - viewport.left + offsetX) / scale, y:(frame.top - viewport.top + offsetY) / scale, width:frame.width / scale, height:frame.height / scale };
}
function imageRegionToDataUrl(source, region, maxEdge, quality = .84) {
  const scale = Math.min(1, maxEdge / Math.max(region.width, region.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(region.width * scale)); canvas.height = Math.max(1, Math.round(region.height * scale));
  canvas.getContext('2d').drawImage(source, region.x, region.y, region.width, region.height, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', quality);
}
async function captureOrderScan() {
  const video = $('scannerVideo'); if (!video.videoWidth || scanBusy) return;
  const started = performance.now(); const mode = scanMode;
  const region = scanRectangle(video.videoWidth, video.videoHeight, $('scannerViewport').getBoundingClientRect(), $('scanFrame').getBoundingClientRect());
  const dataUrl = imageRegionToDataUrl(video, region, mode === 'multi' ? 1800 : 1200);
  closeScanner(); await runScan(dataUrl, mode, performance.now() - started);
}
async function loadImageFile(file) {
  const url = URL.createObjectURL(file);
  try {
    return await new Promise((resolve, reject) => {
      const img = new Image(); img.onload = () => resolve(img); img.onerror = () => reject(new Error('Billedet kunne ikke læses. Prøv at tage et nyt foto.')); img.src = url;
    });
  } finally { URL.revokeObjectURL(url); }
}
async function prepareOrderScanImage(file, mode = 'single') {
  const img = await loadImageFile(file);
  // Native camera has no matching frame: do not silently crop away any numbers.
  return imageRegionToDataUrl(img, { x:0, y:0, width:img.naturalWidth, height:img.naturalHeight }, mode === 'multi' ? 2000 : 1600);
}
async function handleOrderScanImage(event) {
  const file = event.target.files?.[0]; event.target.value = ''; if (!file || scanBusy) return;
  const started = performance.now(), mode = scanMode, generation = scanGeneration;
  setScanBusy(true); setStatus('orderStatus', 'Forbereder billedet…');
  try {
    const data = await prepareOrderScanImage(file, mode);
    if (generation !== scanGeneration) return;
    await runScan(data, mode, performance.now() - started);
  } catch (error) { if (generation === scanGeneration) { setScanBusy(false); setStatus('orderStatus', error.message, 'error'); } }
}
async function runScan(imageDataUrl, mode, prepareMs = 0) {
  const generation = ++scanGeneration; scanAbort = new AbortController(); setScanBusy(true);
  setStatus('orderStatus', mode === 'multi' ? 'Aflæser numrene…' : 'Aflæser nummer…');
  const started = performance.now();
  try {
    const result = await apiPost('scanOrderNumberFromImage', { imageDataUrl, mode }, 30000, scanAbort.signal);
    if (generation !== scanGeneration) return;
    const numbers = [...new Set((result.orderNos || (result.orderNo ? [result.orderNo] : [])).filter(validOrder))];
    if (mode === 'multi' && !Array.isArray(result.orderNos)) throw new Error('Multi-scan kræver den nye Apps Script-version. Opdater backend først.');
    // Log timings only: never photos, signatures or OCR text.
    console.info('Scan timing', { mode, prepareMs:Math.round(prepareMs), requestMs:Math.round(performance.now() - started), visionMs:result.timings?.visionMs, bytesApprox:Math.round(imageDataUrl.length * .75) });
    if (!numbers.length) { setStatus('orderStatus', 'Intet nummer fundet. Prøv tættere på eller indtast manuelt.', 'error'); return; }
    if (mode === 'single' && numbers.length === 1) {
      $('manualOrderInput').value = numbers[0]; persistDraft();
      setStatus('orderStatus', 'Nummer fundet — kontrollér og ret feltet om nødvendigt.', 'ok');
    } else {
      showCandidates(numbers, mode);
      setStatus('orderStatus', mode === 'multi' ? 'Kontrollér numrene og antallet mod følgesedlerne.' : 'Flere mulige numre. Vælg det rigtige.');
    }
    pulseHaptic(30);
  } catch (error) {
    if (generation === scanGeneration) setStatus('orderStatus', error.name === 'AbortError' ? 'Scanningen tog for lang tid. Prøv igen eller indtast manuelt.' : error.message, 'error');
  } finally { if (generation === scanGeneration) { scanAbort = null; setScanBusy(false); } }
}
function dismissCandidates() { candidates = []; $('scanCandidates').replaceChildren(); $('scanCandidates').classList.add('hidden'); }
function showCandidates(numbers, mode) {
  candidates = numbers; const panel = $('scanCandidates'); panel.replaceChildren(); panel.classList.remove('hidden');
  const title = document.createElement('p'); title.textContent = numbers.length + ' mulige numre — kontrollér alle'; panel.append(title);
  numbers.forEach((value, index) => {
    const label = document.createElement('label'); label.className = 'candidate-choice';
    const input = document.createElement('input'); input.type = mode === 'multi' ? 'checkbox' : 'radio'; input.name = 'candidate'; input.value = value;
    input.checked = mode === 'multi'; input.id = 'candidate-' + index;
    label.append(input, document.createTextNode(value)); panel.append(label);
  });
  const use = document.createElement('button'); use.className = 'btn primary'; use.textContent = mode === 'multi' ? 'Tilføj valgte numre' : 'Brug valgt nummer';
  use.onclick = () => {
    const selected = [...panel.querySelectorAll('input:checked')].map(el => el.value);
    if (!selected.length) { setStatus('orderStatus', 'Vælg mindst ét nummer.', 'error'); return; }
    if (mode === 'single') $('manualOrderInput').value = selected[0];
    else {
      const merged = [...new Set([...stopOrders, ...selected])];
      if (merged.length > MAX_ORDERS) { setStatus('orderStatus', 'Højst 20 numre pr. levering.', 'error'); return; }
      stopOrders = merged; renderOrderLists();
    }
    dismissCandidates(); setStatus('orderStatus', 'Numrene er klar. Du kan rette eller fjerne dem.', 'ok');
  };
  const cancel = document.createElement('button'); cancel.className = 'text-button'; cancel.textContent = 'Afvis fund'; cancel.onclick = dismissCandidates;
  panel.append(use, cancel);
}

// Optimize delivery documentation independently of OCR scanner resolution.
// Preserve labels and damage detail: target 400 KiB, retain at least a 1600px edge
// for large sources, and never reduce JPEG quality below .70. No upscaling.
function compressDeliveryPhoto(img) {
  const maxEdge = Math.max(img.naturalWidth, img.naturalHeight);
  const options = [
    [1920, .82], [1920, .75], [1600, .78], [1600, .70]
  ];
  const targetBytes = 400 * 1024;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  let best = '', bestBytes = Infinity, lastWidth = 0, lastHeight = 0;
  for (const [edge, quality] of options) {
    const scale = Math.min(1, edge / maxEdge);
    const width = Math.max(1, Math.round(img.naturalWidth * scale));
    const height = Math.max(1, Math.round(img.naturalHeight * scale));
    if (width !== lastWidth || height !== lastHeight) {
      canvas.width = width; canvas.height = height;
      ctx.drawImage(img, 0, 0, width, height);
      lastWidth = width; lastHeight = height;
    }
    const dataUrl = canvas.toDataURL('image/jpeg', quality);
    const bytes = Math.ceil((dataUrl.length - 'data:image/jpeg;base64,'.length) * .75);
    if (bytes < bestBytes) { best = dataUrl; bestBytes = bytes; }
    if (bytes <= targetBytes) break;
  }
  // Ten images plus signature remain below the existing 22M-character API limit.
  // Reject an exceptional image rather than silently destroy its detail.
  if (bestBytes > 1200 * 1024) throw new Error('Billedet er for stort til sikker upload. Tag et tættere billede af det vigtige område.');
  return best;
}

async function handlePhotoSelect(event) {
  const file = event.target.files?.[0]; event.target.value = '';
  if (!file || photoBusy || isSaving) return;
  if (photos.length >= MAX_PHOTOS) { setStatus('cameraStatus', 'Du kan højst tage 10 billeder.', 'error'); return; }
  photoBusy = true; $('saveBtn').disabled = true; setStatus('cameraStatus', 'Klargør billede…');
  try {
    const img = await loadImageFile(file);
    photos.push(compressDeliveryPhoto(img));
    selectedPhotoIndex = photos.length - 1;
    updatePhotoUI(true); persistDraft();
    setStatus('cameraStatus', 'Billede tilføjet (' + photos.length + '/' + MAX_PHOTOS + ').', 'ok');
  } catch (error) { setStatus('cameraStatus', error.message, 'error'); }
  finally { photoBusy = false; $('saveBtn').disabled = false; }
}
function deletePhoto(index) {
  if (isSaving || photoBusy || index < 0 || index >= photos.length) return;
  if (!confirm('Slet billede ' + (index + 1) + '?')) return;
  photos.splice(index, 1); // Subsequent images are renumbered automatically.
  selectedPhotoIndex = photos.length ? Math.min(index, photos.length - 1) : -1;
  closePhotoModal();
  // Efter sletning: vis billede lige før det slettede og det næste.
  updatePhotoUI(false, Math.max(0, index - 1));
  setStatus('cameraStatus', 'Billedet er slettet. Rækkefølgen er opdateret.', 'ok');
}
function openPhotoModal(index) {
  if (index < 0 || index >= photos.length) return;
  selectedPhotoIndex = index;
  $('photoModalImage').src = photos[index];
  $('photoModalCounter').textContent = 'Billede ' + (index + 1) + ' af ' + photos.length;
  $('photoModal').classList.remove('hidden');
  $('photoModalClose').focus();
}
function closePhotoModal() {
  $('photoModal').classList.add('hidden');
  $('photoModalImage').removeAttribute('src');
}
function updatePhotoUI(scrollToNew = false, focusStartIndex = null) {
  const row = $('photoThumbRow');
  const beforeScrollLeft = row.scrollLeft;
  row.replaceChildren();
  $('photoCount').textContent = photos.length + '/' + MAX_PHOTOS + ' billeder';
  $('photoScrollHelp').classList.toggle('hidden', photos.length <= 2);
  // Vis kun to tomme felter til at begynde med. Derefter vises de optagne billeder.
  const slots = Math.min(MAX_PHOTOS, Math.max(2, photos.length));
  for (let i = 0; i < slots; i++) {
    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    if (photos[i]) {
      const open = document.createElement('button');
      open.type = 'button'; open.className = 'thumb-open';
      open.setAttribute('aria-label', 'Vis billede ' + (i + 1) + ' stort');
      open.onclick = () => openPhotoModal(i);
      const img = document.createElement('img');
      img.src = photos[i]; img.alt = 'Billede ' + (i + 1);
      open.append(img);
      const number = document.createElement('span');
      number.className = 'thumb-index'; number.textContent = String(i + 1);
      const remove = document.createElement('button');
      remove.type = 'button'; remove.className = 'thumb-remove'; remove.textContent = '×';
      remove.setAttribute('aria-label', 'Slet billede ' + (i + 1));
      remove.onclick = () => deletePhoto(i);
      thumb.append(open, number, remove);
    } else {
      const placeholder = document.createElement('span');
      placeholder.className = 'thumb-placeholder';
      placeholder.textContent = 'Billede ' + (i + 1);
      thumb.append(placeholder);
    }
    row.append(thumb);
  }

  // Automatisk til nyeste to, HVER gang et billede tilføjes (fra nr. 3).
  // Når chaufføren blot swiper eller åbner popup'en, rykker rækken sig ikke.
  if (scrollToNew) {
    requestAnimationFrame(() => {
      const target = Math.max(0, row.scrollWidth - row.clientWidth);
      row.scrollTo({ left:target, behavior:'smooth' });
    });
  } else if (focusStartIndex !== null) {
    requestAnimationFrame(() => {
      const first = row.children[Math.min(focusStartIndex, row.children.length - 1)];
      row.scrollLeft = first ? first.offsetLeft - row.children[0].offsetLeft : 0;
    });
  } else {
    row.scrollLeft = beforeScrollLeft;
  }
}

document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !$('photoModal').classList.contains('hidden')) closePhotoModal();
});

function goToSignature() {
  if (isSaving || photoBusy) return;
  showScreen('screen-signature'); requestAnimationFrame(initSignatureCanvas);
}
function resizeSignature() {
  const canvas = $('signatureCanvas'), rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return; // Never shrink a hidden signature to 1×1.
  const ratio = Math.min(window.devicePixelRatio || 1, 3);
  const width = Math.round(rect.width * ratio), height = Math.round(rect.height * ratio);
  if (canvas.width === width && canvas.height === height) return;
  const snapshot = document.createElement('canvas'); snapshot.width = canvas.width; snapshot.height = canvas.height;
  if (hasSignature) snapshot.getContext('2d').drawImage(canvas, 0, 0);
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d'); ctx.fillStyle = '#efefef'; ctx.fillRect(0, 0, width, height);
  if (hasSignature) ctx.drawImage(snapshot, 0, 0, width, height);
}
function initSignatureCanvas() {
  resizeSignature(); if (signaturePadReady) return;
  const canvas = $('signatureCanvas'); let last = null;
  const pos = e => { const rect = canvas.getBoundingClientRect(); return { x:(e.clientX - rect.left) * canvas.width / rect.width, y:(e.clientY - rect.top) * canvas.height / rect.height }; };
  canvas.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    e.preventDefault(); canvas.setPointerCapture(e.pointerId); isDrawing = true; last = pos(e);
    const ctx = canvas.getContext('2d'), scale = canvas.width / canvas.getBoundingClientRect().width;
    ctx.fillStyle = '#111'; ctx.beginPath(); ctx.arc(last.x, last.y, 1.5 * scale, 0, Math.PI * 2); ctx.fill(); hasSignature = true; updateReceiptButton();
  });
  canvas.addEventListener('pointermove', e => {
    if (!isDrawing) return; const next = pos(e), ctx = canvas.getContext('2d');
    ctx.strokeStyle = '#111'; ctx.lineWidth = 3 * canvas.width / canvas.getBoundingClientRect().width; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(next.x, next.y); ctx.stroke(); last = next;
  });
  ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(name => canvas.addEventListener(name, () => { isDrawing = false; persistDraft(); }));
  signaturePadReady = true;
}
function clearSignature() {
  const canvas = $('signatureCanvas'), ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.fillStyle = '#efefef'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  hasSignature = false; isDrawing = false; updateReceiptButton();
}
function clearReceiptData() { clearSignature(); $('receiverNameInput').value = ''; updateReceiptButton(); }
function updateReceiptButton() { $('receiptBtn').textContent = hasSignature || $('receiverNameInput').value.trim() ? 'Kvittering ✓' : 'Kvittering'; }

function getDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(STORE_PENDING)) request.result.createObjectStore(STORE_PENDING, { keyPath:'id' }); };
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
}
async function dbOperation(mode, operation) {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PENDING, mode); let request;
    try { request = operation(tx.objectStore(STORE_PENDING)); } catch (error) { db.close(); reject(error); return; }
    tx.oncomplete = () => { const result = request?.result; db.close(); resolve(result); };
    tx.onerror = tx.onabort = () => { db.close(); reject(tx.error || new Error('Lokal lagring blev afbrudt.')); };
  });
}
function getAllPendingDeliveries() { return dbOperation('readonly', store => store.getAll()); }
function addPendingDelivery(payload) { return dbOperation('readwrite', store => store.put(payload)); }
function deletePendingDelivery(id) { return dbOperation('readwrite', store => store.delete(id)); }
// Vis en stabil status. Antallet kommer altid fra den faktiske, lokale offlinekø.
async function updatePendingBanner() {
  const banner = $('pendingBanner');
  try {
    const items = await getAllPendingDeliveries();
    const n = items.length;
    banner.classList.toggle('sent', !n && Date.now() - lastUploadSuccessAt < 8000);
    if (!n) {
      const justSent = Date.now() - lastUploadSuccessAt < 8000;
      banner.classList.toggle('hidden', !justSent);
      banner.textContent = justSent ? 'Leveringen er sendt ✓ · Modtaget hos Wallmann' : '';
      return;
    }
    banner.classList.remove('sent', 'hidden');
    if (PREVIEW) { banner.textContent = n + ' testlevering' + (n === 1 ? '' : 'er') + ' gemt lokalt · sendes ikke'; return; }
    const amount = n + ' levering' + (n === 1 ? '' : 'er');
    if (uploadInProgress) {
      banner.textContent = 'Sender ' + amount + '… Hold appen åben.';
    } else if (!navigator.onLine) {
      banner.textContent = amount + ' på telefonen. Sendes, når der er forbindelse. Hold appen åben.';
    } else if (lastUploadIssue) {
      banner.textContent = amount + ' mangler at blive sendt. Vi prøver igen. Hold appen åben — eller tryk her for at prøve nu.';
    } else {
      banner.textContent = amount + ' klar til at blive sendt. Tryk her for at sende.';
    }
  } catch (_) {
    banner.classList.remove('hidden', 'sent');
    banner.textContent = 'Appen kan ikke læse de gemte leveringer. Luk og åbn appen igen. Kontakt kontoret, hvis det fortsætter.';
  }
}
function showRecentUploadSuccess() {
  lastUploadSuccessAt = Date.now();
  clearTimeout(sentBannerTimer);
  sentBannerTimer = setTimeout(() => {
    lastUploadSuccessAt = 0;
    updatePendingBanner();
  }, 8000);
}
function scheduleQueueRetry() {
  if (retryTimer) return;
  retryTimer = setTimeout(() => { retryTimer = null; processPendingQueue(); }, retryDelay);
  retryDelay = Math.min(120000, retryDelay * 2);
}
function processPendingQueue() {
  if (PREVIEW || window.DriverAccess?.busy()) return Promise.resolve();
  // Et nyt online-event eller tryk på banneret starter aldrig en parallel upload.
  if (queuePromise) return queuePromise;
  queuePromise = (async () => {
    if (!navigator.onLine) return;
    const items = await getAllPendingDeliveries();
    items.sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
    for (const item of items) {
      if (!navigator.onLine) break;
      const started = performance.now();
      uploadInProgress = true;
      showUpdateBanner();
      lastUploadIssue = '';
      await updatePendingBanner();
      try {
        const result = await apiPost('saveDelivery', { payload:item }, 90000);
        if (!result?.ok || !result.folderUrl) throw new Error('Serveren bekræftede ikke lagringen.');
        await deletePendingDelivery(item.id); // Slet ALDRIG en levering uden serverbekræftelse.
        retryDelay = 10000;
        showRecentUploadSuccess();
        // Log kun tidsforbrug, ikke billeder, kvittering, ordrenummer eller persondata.
        console.info('Upload bekræftet', { ms:Math.round(performance.now() - started), alleredeGemt:!!result.alreadySaved });
        if (lastSavedId === item.id) {
          document.querySelector('.registered').textContent = 'Leveringen er sendt ✓';
          $('registeredDetail').textContent = 'Wallmann har modtaget leveringen. Du kan fortsætte.';
        }
      } catch (error) {
        const ms = Math.round(performance.now() - started);
        lastUploadIssue = error?.name === 'AbortError' || ms >= 89500 ? 'timeout' : 'netværk/server';
        console.warn('Upload afventer genforsøg', { ms, type:lastUploadIssue });
        if (lastSavedId === item.id) {
          document.querySelector('.registered').textContent = 'Gemt på telefonen';
          $('registeredDetail').textContent = 'Leveringen er ikke sendt endnu. Dine billeder er gemt på telefonen. Vi prøver igen automatisk — hold appen åben.';
        }
        // Fortsæt med evt. andre leveringer; denne bliver i offlinekøen.
        scheduleQueueRetry();
      } finally {
        uploadInProgress = false;
        showUpdateBanner();
        await updatePendingBanner();
      }
    }
  })().catch(error => {
    console.warn('Offlinekø afventer genforsøg', { type:error?.name || 'ukendt' });
    scheduleQueueRetry();
  }).finally(async () => {
    uploadInProgress = false;
    queuePromise = null;
    await updatePendingBanner();
    // En ny levering kan være tilføjet, mens en ældre blev uploadet.
    try { if ((await getAllPendingDeliveries()).length && navigator.onLine) scheduleQueueRetry(); } catch (_) {}
  });
  return queuePromise;
}
function retryPendingDeliveries() {
  if (uploadInProgress || queuePromise) return;
  if (!navigator.onLine) { updatePendingBanner(); return; }
  clearTimeout(retryTimer); retryTimer = null; retryDelay = 10000;
  lastUploadIssue = '';
  processPendingQueue();
}
function makeDeliveryPayload() {
  return { id:activeDeliveryId, orderNo:stopOrders[0], allOrders:[...stopOrders], driver:activeDriver || driverSelect.value,
    photos:[...photos], signature:hasSignature ? $('signatureCanvas').toDataURL('image/png') : '',
    recipientName:$('receiverNameInput').value.trim(), createdAt:deliveryCreatedAt };
}
async function goToRegistered() {
  if (isSaving || photoBusy) return;
  if (!driverSelect.value || !stopOrders.length || !stopOrders.every(validOrder) || !photos.length) { setStatus('cameraStatus', 'Vælg chauffør, gyldige numre og mindst ét billede.', 'error'); return; }
  isSaving = true; $('saveBtn').disabled = true; $('saveOverlay').classList.add('active');
  try {
    const payload = makeDeliveryPayload();
    await draftWrites;
    await addPendingDelivery(payload); // The transaction must commit before showing success.
    try { await draftStore('readwrite', store => store.delete('current')); } catch (_) { /* Recovery ignores a draft already present in the pending queue. */ }
    lastSavedId = payload.id; resetAppState();
    document.querySelector('.registered').textContent = 'Gemt på telefonen';
    $('registeredDetail').textContent = navigator.onLine
      ? 'Sender til Wallmann. Hold appen åben. Du kan godt starte næste levering.'
      : 'Ingen forbindelse lige nu. Leveringen er gemt på telefonen og sendes automatisk, når der er forbindelse. Hold appen åben.';
    if (PREVIEW) { document.querySelector('.registered').textContent = 'Testlevering gemt'; $('registeredDetail').textContent = 'Kun gemt i denne forhåndsvisning. Intet er sendt til Wallmanns ark eller Drev.'; }
    showScreen('screen-registered'); await updatePendingBanner(); processPendingQueue();
  } catch (_) { setStatus('cameraStatus', 'Kunne ikke gemme på telefonen. Leveringen er stadig her — prøv igen.', 'error'); }
  finally { isSaving = false; $('saveBtn').disabled = false; $('saveOverlay').classList.remove('active'); updateHomeButtons(); }
}
function resetAppState() {
  cancelScan(); closeScanner(); closePhotoModal(); activeDeliveryId = ''; activeDriver = ''; draftMessage(''); deliveryCreatedAt = ''; stopOrders = []; photos = []; selectedPhotoIndex = -1;
  $('manualOrderInput').value = ''; clearReceiptData(); dismissCandidates(); renderOrderLists(); updatePhotoUI();
  setStatus('orderStatus', ''); setStatus('cameraStatus', ''); updateHomeButtons();
}

function showUpdateBanner() {
  $('updateBanner').classList.toggle('hidden', !waitingWorker && !refreshPending);
  const button = $('updateBanner').querySelector('button'); button.disabled = hasDraft() || isSaving || photoBusy || scanBusy || uploadInProgress;
  button.textContent = button.disabled ? 'Gem eller kassér kladden først' : 'Opdater app';
}
function applyAppUpdate() {
  if (hasDraft() || isSaving || photoBusy || scanBusy || uploadInProgress) { showUpdateBanner(); return; }
  if (waitingWorker) waitingWorker.postMessage({ type:'SKIP_WAITING' }); else if (refreshPending) maybeReload();
}
function maybeReload() {
  showUpdateBanner();
  if (refreshPending && !hasDraft() && !isSaving && !photoBusy && !scanBusy && !uploadInProgress && !refreshing) { refreshing = true; location.reload(); }
}
try { const driver = localStorage.getItem('leveringsapp_driver'); if (driver) driverSelect.value = driver; } catch (_) {}
driverSelect.addEventListener('change', () => { try { localStorage.setItem('leveringsapp_driver', driverSelect.value); } catch (_) {} updateHomeButtons(); });
$('receiverNameInput').addEventListener('input', updateReceiptButton);
window.addEventListener('resize', () => { if ($('screen-signature').classList.contains('active')) resizeSignature(); });
window.addEventListener('online', retryPendingDeliveries);
window.addEventListener('pagehide', closeScanner);
document.addEventListener('visibilitychange', () => { if (document.hidden) closeScanner(); else processPendingQueue(); });
window.addEventListener('beforeunload', e => { if (hasDraft() && (draftPending || draftFailure || photoBusy)) { e.preventDefault(); e.returnValue = ''; } });
window.addEventListener('load', async () => {
  $('appVersionText').textContent = APP_VERSION;
  $('previewRibbon').hidden = !PREVIEW;
  document.body.classList.add('at-home');
  await restoreDraft();
  DriverAccess.init();
  updateHomeButtons(); await updatePendingBanner(); processPendingQueue();
  if (PREVIEW || !('serviceWorker' in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.register('./service-worker.js');
    if (registration.waiting) { waitingWorker = registration.waiting; showUpdateBanner(); }
    registration.addEventListener('updatefound', () => {
      const worker = registration.installing;
      worker?.addEventListener('statechange', () => { if (worker.state === 'installed' && navigator.serviceWorker.controller) { waitingWorker = worker; showUpdateBanner(); } });
    });
    navigator.serviceWorker.addEventListener('controllerchange', () => { refreshPending = true; waitingWorker = null; maybeReload(); });
  } catch (_) { console.warn('Offline-app kunne ikke registreres.'); }
});


// Knapper og felter kobles til her i stedet for inline onclick/onchange/oninput,
// så siden kan køre med en streng Content-Security-Policy (3.0.9).
['click','change','input'].forEach(type => {
  document.addEventListener(type, event => {
    const el = event.target instanceof Element ? event.target.closest('[data-' + type + ']') : null;
    if (!el) return;
    const fn = window[el.dataset[type]];
    if (typeof fn !== 'function') return;
    const arg = el.dataset.arg;
    fn(arg === '$event' ? event : arg);
  });
});
