'use strict';
// A separate database preserves the v1 pending queue schema and allows rollback.
const DRAFT_DB = PREVIEW ? 'leveringsapp_preview_drafts' : 'leveringsapp_drafts_v1';
let draftWrites = Promise.resolve(), draftRevision = 0, lastDraftJSON = '', draftFailure = false, draftPending = 0;
function draftMessage(text, error = false) {
  const el = $('draftStatus'); el.textContent = text; el.classList.toggle('error', error);
}
function draftStore(mode, operation) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DRAFT_DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore('drafts', {keyPath:'key'});
    open.onerror = () => reject(open.error);
    open.onblocked = () => reject(new Error('Luk andre faner med leveringsappen, og prøv igen.'));
    open.onsuccess = () => {
      const db = open.result; let tx, request;
      try { tx = db.transaction('drafts', mode); request = operation(tx.objectStore('drafts')); }
      catch (error) { db.close(); reject(error); return; }
      tx.oncomplete = () => { db.close(); resolve(request.result); };
      tx.onerror = tx.onabort = () => { db.close(); reject(tx.error || new Error('Kladden kunne ikke gemmes.')); };
    };
  });
}
function persistDraft() {
  if (!draftReady || restoringDraft || !hasDraft() || isSaving) return draftWrites;
  const snapshot = {...makeDeliveryPayload(), key:'current', manualOrder:$('manualOrderInput').value};
  const serialized = JSON.stringify(snapshot);
  if (serialized === lastDraftJSON && !draftFailure) return draftWrites;
  const revision = ++draftRevision; lastDraftJSON = serialized; draftPending++;
  draftMessage('Gemmer kladde…');
  draftWrites = draftWrites.then(() => draftStore('readwrite', store => store.put(snapshot))).then(() => {
    if (revision === draftRevision) { draftFailure = false; draftMessage('✓ Kladde gemt på denne enhed · ' + activeDriver); }
  }).catch(() => {
    draftFailure = true; lastDraftJSON = '';
    draftMessage('Kladden kunne ikke gemmes. Hold appen åben, og prøv igen.', true);
  }).finally(() => { draftPending--; });
  return draftWrites;
}
async function acquireDraftLock() {
  if (!navigator.locks) throw new Error('Browseren understøtter ikke sikker kladdegemning i flere faner.');
  return new Promise((resolve, reject) => {
    navigator.locks.request(DRAFT_DB, {mode:'exclusive', ifAvailable:true}, lock => {
      if (!lock) { resolve(false); return; }
      resolve(true);
      // Hold the lock until this document closes; another tab cannot replace its draft.
      return new Promise(() => {});
    }).catch(reject);
  });
}
async function restoreDraft() {
  restoringDraft = true;
  try {
    if (!await acquireDraftLock()) { draftMessage('Leveringsappen er allerede åben i en anden fane. Brug den, eller luk den og genindlæs her.', true); return; }
    const draft = await draftStore('readonly', store => store.get('current'));
    const pending = await getAllPendingDeliveries();
    if (draft && pending.some(item => item.id === draft.id)) {
      await draftStore('readwrite', store => store.delete('current'));
    } else if (draft) {
      activeDeliveryId = draft.id; deliveryCreatedAt = draft.createdAt; activeDriver = draft.driver;
      if (![...driverSelect.options].some(o => o.value === draft.driver)) driverSelect.add(new Option(draft.driver, draft.driver));
      driverSelect.value = draft.driver;
      stopOrders = Array.isArray(draft.allOrders) ? draft.allOrders : [];
      photos = Array.isArray(draft.photos) ? draft.photos : [];
      $('manualOrderInput').value = draft.manualOrder || '';
      $('receiverNameInput').value = draft.recipientName || '';
      if (draft.signature) {
        const img = await new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = reject; i.src = draft.signature; });
        const canvas = $('signatureCanvas'); canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
        canvas.getContext('2d').drawImage(img, 0, 0); hasSignature = true;
      }
      renderOrderLists(); updatePhotoUI(); updateReceiptButton();
      draftMessage('✓ Din kladde er gendannet · ' + activeDriver + ' · ' + photos.length + (photos.length === 1 ? ' billede' : ' billeder'));
    }
    draftReady = true;
  } catch (_) {
    draftMessage('Lokal lagring kunne ikke åbnes. Genindlæs appen for at gendanne kladden.', true);
    // Do not let a new delivery overwrite an unreadable existing draft.
    draftReady = false;
  } finally { restoringDraft = false; }
}
document.addEventListener('input', event => {
  if (event.target.matches('#manualOrderInput, #receiverNameInput')) persistDraft();
});
document.addEventListener('click', () => queueMicrotask(() => persistDraft()));
window.addEventListener('pagehide', () => persistDraft());
