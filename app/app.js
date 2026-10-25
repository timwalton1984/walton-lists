// Walton Lists - v6
import {
  initializeApp,
  getAuth, onAuthStateChanged, GoogleAuthProvider, signOut,
  signInWithPopup, signInWithRedirect, getRedirectResult,
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, query, where, orderBy, onSnapshot,
  addDoc, setDoc, updateDoc, deleteDoc, getDoc, getDocs, writeBatch, serverTimestamp
} from './lib/firebase.js';

const CFG = window.APP_CONFIG || {};
const $ = (id) => document.getElementById(id);

const K = {
  state: 'fl.state', nonce: 'fl.nonce', token: 'fl.idtoken', from: 'fl.from',
  pending: 'fl.pending', reloaded: 'fl.reloaded', list: 'fl.lastList', share: 'fl.shareWith'
};
const PENDING_MAX_MS = 15 * 60 * 1000;

let auth = null, db = null;
let user = null;
let lists = [];
let items = [];
let currentListId = localStorage.getItem(K.list) || null;
let unsubLists = null, unsubItems = null;
let dialogMode = 'new';
let doneCollapsed = false;

// ---------- helpers ----------
function show(screen) {
  for (const s of ['loading', 'signin', 'app']) $('screen-' + s).hidden = (s !== screen);
}
function msg(text) { $('signin-msg').textContent = text || ''; }
function banner(text) { const b = $('banner'); b.textContent = text || ''; b.hidden = !text; }
function isStandalone() {
  return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
}
function rand() {
  const a = new Uint8Array(16); crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}
function configMissing() {
  const f = CFG.firebase || {};
  const bad = (v) => !v || String(v).startsWith('PASTE');
  return bad(f.apiKey) || bad(f.projectId) || bad(CFG.googleClientId);
}
function currentList() { return lists.find((l) => l.id === currentListId) || null; }
function others(list) { return (list ? list.members : []).filter((m) => m !== user.email); }
function initials(email) {
  const name = String(email || '').split('@')[0].replace(/[^a-zA-Z]/g, '');
  return (name.slice(0, 2) || '?').toUpperCase();
}
function friendlyError(e) {
  const c = (e && e.code) || '';
  if (c === 'permission-denied') return 'That account is not on the list of allowed family members, so this change was not saved.';
  if (c === 'unavailable') return 'No connection right now. Your change is saved here and will sync when you are back on.';
  return (e && (e.message || e.code)) || String(e);
}

function nameFor(email) {
  const fam = CFG.family || [];
  const f = fam.find((x) => (x.email || '').toLowerCase() === (email || '').toLowerCase());
  return f ? f.name : String(email || '').split('@')[0];
}
function meName() { return nameFor(user && user.email); }

// ---------- push notifications ----------
const VAPID_PUBLIC = CFG.vapidPublicKey || '';
const RELAY_URL = CFG.pushRelayUrl || '';
const RELAY_TOKEN = CFG.pushToken || '';

function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && !!VAPID_PUBLIC;
}
function urlB64ToUint8(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const s = (b64 + pad).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(s);
  const a = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) a[i] = raw.charCodeAt(i);
  return a;
}
async function pushState() {
  if (!pushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    return sub ? 'on' : 'off';
  } catch (e) { return 'off'; }
}
async function saveSub(sub) {
  if (!user || !sub) return;
  const j = sub.toJSON();
  try {
    await setDoc(doc(db, 'pushSubs', user.email.toLowerCase()), {
      email: user.email, endpoint: j.endpoint, keys: j.keys, updated: Date.now()
    });
  } catch (e) { /* best-effort */ }
}
async function enablePush() {
  if (!pushSupported()) { banner('This device or browser cannot show notifications. On iPhone the app must be added to the Home Screen first.'); return; }
  let perm = Notification.permission;
  if (perm === 'default') { try { perm = await Notification.requestPermission(); } catch (e) { perm = 'denied'; } }
  if (perm !== 'granted') { banner('Notifications are turned off. Allow them for this app in your browser settings, then try again.'); await refreshNotifyLabel(); return; }
  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8(VAPID_PUBLIC) });
    await saveSub(sub);
    banner('Notifications are on for this phone.');
    setTimeout(() => banner(''), 2500);
  } catch (e) { banner('Could not turn on notifications: ' + ((e && e.message) || e)); }
  await refreshNotifyLabel();
}
async function refreshSub() {
  try {
    if (!pushSupported() || Notification.permission !== 'granted') return;
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) await saveSub(sub);
  } catch (e) { /* ignore */ }
}
async function refreshNotifyLabel() {
  const el = $('m-notify-label');
  if (!el) return;
  const st = await pushState();
  el.textContent = st === 'on' ? 'Notifications are on'
    : st === 'denied' ? 'Notifications blocked (fix in browser)'
    : st === 'unsupported' ? 'Notifications not available here'
    : 'Turn on notifications';
}
// Fire-and-forget: notify the OTHER members of a list. Never blocks or breaks a save.
function notify(list, body, tag) {
  if (!RELAY_URL || !list || !user) return;
  const recipients = others(list);
  if (!recipients.length) return;
  (async () => {
    try {
      const subs = [];
      for (const email of recipients) {
        try {
          const snap = await getDoc(doc(db, 'pushSubs', String(email).toLowerCase()));
          if (snap.exists()) { const d = snap.data(); if (d.endpoint && d.keys) subs.push({ endpoint: d.endpoint, keys: d.keys }); }
        } catch (e) { /* skip this recipient */ }
      }
      if (!subs.length) return;
      await fetch(RELAY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: RELAY_TOKEN, subscriptions: subs,
          title: list.name || 'Walton Lists', body: body,
          url: './?list=' + list.id, tag: tag || ('list-' + list.id)
        })
      });
    } catch (e) { /* best-effort */ }
  })();
}

// ---------- sign-in (Firebase handles it; no per-URL setup needed) ----------
function startSignIn() {
  if (configMissing()) { msg('The app is not set up yet (config.js).'); return; }
  msg('');
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  signInWithPopup(auth, provider).catch((e) => {
    const c = (e && e.code) || '';
    if (c === 'auth/popup-blocked' || c === 'auth/operation-not-supported-in-environment' || c === 'auth/cancelled-popup-request') {
      signInWithRedirect(auth, provider);
    } else if (c === 'auth/popup-closed-by-user') {
      /* user closed the window; nothing to do */
    } else if (c === 'auth/operation-not-allowed') {
      msg('Google sign-in is not switched on for this app yet.');
    } else {
      msg('Sign-in did not work: ' + (c || (e && e.message) || e));
    }
  });
}

// ---------- app start ----------
function startApp() {
  show('app');
  $('btn-account').textContent = initials(user.email);
  $('who').textContent = 'Signed in as ' + (user.email || '');
  refreshSub();
  if (unsubLists) unsubLists();
  const q = query(collection(db, 'lists'), where('members', 'array-contains', user.email));
  unsubLists = onSnapshot(q, (snap) => {
    lists = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    lists.sort((a, b) => (a.created || 0) - (b.created || 0));
    if (!currentList()) currentListId = lists.length ? lists[0].id : null;
    renderTabs();
    subscribeItems();
  }, (err) => banner(friendlyError(err)));
}

function stopApp() {
  if (unsubLists) unsubLists(); unsubLists = null;
  if (unsubItems) unsubItems(); unsubItems = null;
  lists = []; items = []; currentListId = null;
}

function selectList(id) {
  currentListId = id;
  localStorage.setItem(K.list, id || '');
  renderTabs();
  subscribeItems();
}

let itemsFor;
function subscribeItems() {
  const list = currentList();
  const hasList = !!list;
  $('tabsbar').hidden = lists.length === 0;
  $('empty-lists').hidden = lists.length !== 0;
  $('list-view').hidden = !hasList;
  $('addbar').hidden = !hasList;
  $('btn-list-opts').hidden = !hasList;

  const key = list ? list.id : null;
  if (key === itemsFor && unsubItems) { renderItems(); return; }
  if (unsubItems) { unsubItems(); unsubItems = null; }
  itemsFor = key;
  items = [];
  renderItems();
  if (!list) return;
  const q = query(collection(db, 'lists', list.id, 'items'), orderBy('order'));
  unsubItems = onSnapshot(q, (snap) => {
    items = snap.docs.map((d) => ({ id: d.id, pending: d.metadata.hasPendingWrites, ...d.data() }));
    renderItems();
  }, (err) => banner(friendlyError(err)));
}

function renderTabs() {
  const el = $('tabs');
  el.textContent = '';
  for (const l of lists) {
    const b = document.createElement('button');
    b.className = 'tab' + (l.id === currentListId ? ' active' : '');
    if (others(l).length) {
      const dot = document.createElement('span');
      dot.className = 'dot'; dot.title = 'Shared';
      b.appendChild(dot);
    }
    const lab = document.createElement('span');
    lab.className = 'label'; lab.textContent = l.name || 'Untitled';
    b.appendChild(lab);
    b.addEventListener('click', () => selectList(l.id));
    el.appendChild(b);
  }
  const add = document.createElement('button');
  add.className = 'tab tab-new';
  add.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg><span class="label">New list</span>';
  add.addEventListener('click', () => openDialog('new'));
  el.appendChild(add);
}

function tickSvg() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"/></svg>';
}
function binSvg() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>';
}

function renderItems() {
  const list = currentList();
  const card = document.querySelector('#list-view .card');
  const open = items.filter((i) => !i.done);
  const done = items.filter((i) => i.done);

  const ul = $('items');
  ul.textContent = '';
  for (const it of open) ul.appendChild(itemRow(it));

  const dwrap = $('done-wrap');
  if (done.length) {
    dwrap.hidden = false;
    $('done-count').textContent = 'Done (' + done.length + ')';
    const head = $('done-toggle');
    head.classList.toggle('collapsed', doneCollapsed);
    head.setAttribute('aria-expanded', String(!doneCollapsed));
    const dul = $('done-items');
    dul.hidden = doneCollapsed;
    dul.textContent = '';
    if (!doneCollapsed) for (const it of done) dul.appendChild(itemRow(it));
  } else {
    dwrap.hidden = true;
  }

  const isEmpty = list && items.length === 0;
  if (card) card.hidden = !list || items.length === 0;
  $('empty-items').hidden = !isEmpty;
}

function itemRow(it) {
  const li = document.createElement('li');
  li.className = 'item' + (it.done ? ' done' : '') + (it.pending ? ' pending' : '');

  const check = document.createElement('label');
  check.className = 'check';
  const cb = document.createElement('input');
  cb.type = 'checkbox'; cb.checked = !!it.done;
  cb.setAttribute('aria-label', (it.done ? 'Mark not done: ' : 'Mark done: ') + (it.text || ''));
  cb.addEventListener('change', () => toggleItem(it, cb.checked));
  const box = document.createElement('span');
  box.className = 'box'; box.innerHTML = tickSvg();
  check.append(cb, box);

  const t = document.createElement('div');
  t.className = 'text'; t.textContent = it.text || '';
  t.addEventListener('click', () => editItem(it));

  const del = document.createElement('button');
  del.className = 'del'; del.setAttribute('aria-label', 'Remove ' + (it.text || '')); del.innerHTML = binSvg();
  del.addEventListener('click', () => deleteItem(it));

  li.append(check, t, del);
  return li;
}

// ---------- item actions ----------
function itemRef(it) { return doc(db, 'lists', currentListId, 'items', it.id); }

async function addItem(text) {
  const list = currentList();
  if (!list || !text) return;
  try {
    await addDoc(collection(db, 'lists', list.id, 'items'), {
      text, done: false, order: Date.now(), by: user.email, created: serverTimestamp()
    });
    notify(list, meName() + ' added ' + text, 'change-' + list.id);
  } catch (e) { banner(friendlyError(e)); }
}
async function toggleItem(it, done) {
  const list = currentList();
  try {
    await updateDoc(itemRef(it), { done, doneAt: done ? Date.now() : null });
    if (done) notify(list, meName() + ' ticked off ' + (it.text || 'an item'), 'change-' + (list && list.id));
  } catch (e) { banner(friendlyError(e)); }
}
async function editItem(it) {
  const list = currentList();
  const text = prompt('Edit item', it.text || '');
  if (text === null) return;
  const t = text.trim();
  try {
    if (!t) { await deleteDoc(itemRef(it)); notify(list, meName() + ' removed ' + (it.text || 'an item'), 'change-' + (list && list.id)); }
    else { await updateDoc(itemRef(it), { text: t }); notify(list, meName() + ' changed an item to ' + t, 'change-' + (list && list.id)); }
  } catch (e) { banner(friendlyError(e)); }
}
async function deleteItem(it) {
  const list = currentList();
  try {
    await deleteDoc(itemRef(it));
    notify(list, meName() + ' removed ' + (it.text || 'an item'), 'change-' + (list && list.id));
  } catch (e) { banner(friendlyError(e)); }
}
async function clearDone() {
  const list = currentList();
  const done = items.filter((i) => i.done);
  if (!done.length) return;
  try {
    const batch = writeBatch(db);
    for (const it of done) batch.delete(itemRef(it));
    await batch.commit();
    notify(list, meName() + ' cleared the ticked-off items', 'change-' + (list && list.id));
  } catch (e) { banner(friendlyError(e)); }
}

// ---------- list actions ----------
let selectedWho = 'me';
function otherPerson() {
  const fam = CFG.family || [];
  const me = (user.email || '').toLowerCase();
  return fam.find((f) => (f.email || '').toLowerCase() !== me) || null;
}
function setWho(who) {
  const other = otherPerson();
  selectedWho = (who === 'both' && other) ? 'both' : 'me';
  for (const b of document.querySelectorAll('#dlg-who .seg-btn')) {
    b.classList.toggle('is-on', b.getAttribute('data-who') === selectedWho);
  }
}

function openDialog(mode) {
  dialogMode = mode;
  const list = currentList();
  const isNew = mode === 'new';
  $('dlg-title').textContent = isNew ? 'New list' : (mode === 'rename' ? 'Rename list' : 'Share list');
  $('dlg-name').value = isNew ? '' : (list ? list.name : '');
  const other = otherPerson();
  $('seg-both').textContent = other ? ('Me and ' + other.name) : 'Me and family';
  $('seg-both').disabled = !other;
  const sharedNow = !isNew && list && others(list).length > 0;
  setWho(sharedNow ? 'both' : 'me');
  $('dlg-who-field').hidden = (mode === 'rename') || !other;
  $('dlg-save').textContent = isNew ? 'Create list' : 'Save';
  $('dlg-list').showModal();
  setTimeout(() => $('dlg-name').focus(), 50);
}

function saveDialog() {
  const name = $('dlg-name').value.trim();
  if (!name) return;
  const other = otherPerson();
  const members = (selectedWho === 'both' && other && dialogMode !== 'rename')
    ? [user.email, other.email]
    : [user.email];
  const fail = (e) => banner(friendlyError(e));
  if (dialogMode === 'new') {
    const ref = doc(collection(db, 'lists'));
    const listObj = { id: ref.id, name, members };
    setDoc(ref, { name, members, owner: user.email, created: Date.now() })
      .then(() => { if (selectedWho === 'both' && other) notify(listObj, meName() + ' shared a new list: ' + name, 'share-' + ref.id); })
      .catch(fail);
    selectList(ref.id);
  } else if (dialogMode === 'rename') {
    updateDoc(doc(db, 'lists', currentListId), { name }).catch(fail);
  } else {
    const id = currentListId;
    const wasShared = others(currentList()).length > 0;
    const listObj = { id, name, members };
    updateDoc(doc(db, 'lists', id), { name, members })
      .then(() => { if (!wasShared && members.length > 1 && other) notify(listObj, meName() + ' shared “' + name + '” with you', 'share-' + id); })
      .catch(fail);
  }
  $('dlg-list').close();
}

async function deleteList() {
  const list = currentList();
  if (!list) return;
  if (!confirm('Delete "' + list.name + '" and everything on it? This cannot be undone.')) return;
  const listSnapshot = { id: list.id, name: list.name, members: (list.members || []).slice() };
  try {
    const snap = await getDocs(collection(db, 'lists', list.id, 'items'));
    const batch = writeBatch(db);
    snap.forEach((d) => batch.delete(d.ref));
    batch.delete(doc(db, 'lists', list.id));
    batch.commit().catch((e) => banner(friendlyError(e)));
    notify(listSnapshot, meName() + ' deleted the list ' + list.name, 'dellist-' + list.id);
    currentListId = null;
  } catch (e) { banner(friendlyError(e)); }
}

// ---------- menus ----------
function closeMenus() {
  $('sheet-shade').hidden = true;
  $('account-sheet').hidden = true;
  $('opts-sheet').hidden = true;
}
function openAccount() {
  closeMenus();
  $('sheet-shade').hidden = false;
  $('account-sheet').hidden = false;
  refreshNotifyLabel();
}
function openOpts() {
  const list = currentList();
  if (!list) return;
  closeMenus();
  $('opts-title').textContent = list.name + (others(list).length ? ' · shared with ' + others(list).join(', ') : '');
  $('m-share-label').textContent = others(list).length ? 'Sharing settings' : 'Share list';
  $('sheet-shade').hidden = false;
  $('opts-sheet').hidden = false;
}

// ---------- wiring ----------
function wire() {
  $('btn-signin').addEventListener('click', startSignIn);
  $('empty-new').addEventListener('click', () => openDialog('new'));
  $('btn-account').addEventListener('click', openAccount);
  $('btn-list-opts').addEventListener('click', openOpts);
  $('sheet-shade').addEventListener('click', closeMenus);
  $('m-notify').addEventListener('click', () => { closeMenus(); enablePush(); });
  $('m-signout').addEventListener('click', async () => { closeMenus(); await signOut(auth); });
  $('m-rename').addEventListener('click', () => { closeMenus(); openDialog('rename'); });
  $('m-share').addEventListener('click', () => { closeMenus(); openDialog('share'); });
  $('m-clear').addEventListener('click', () => { closeMenus(); clearDone(); });
  $('m-delete').addEventListener('click', () => { closeMenus(); deleteList(); });

  $('done-toggle').addEventListener('click', () => { doneCollapsed = !doneCollapsed; renderItems(); });

  $('add-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const inp = $('add-input');
    const text = inp.value.trim();
    inp.value = '';
    inp.focus();
    addItem(text);
  });

  for (const b of document.querySelectorAll('#dlg-who .seg-btn')) {
    b.addEventListener('click', () => setWho(b.getAttribute('data-who')));
  }
  $('dlg-cancel').addEventListener('click', () => $('dlg-list').close());
  $('dlg-form').addEventListener('submit', (ev) => { ev.preventDefault(); saveDialog(); });

  const setOnline = () => { $('offline').hidden = navigator.onLine; };
  window.addEventListener('online', setOnline);
  window.addEventListener('offline', setOnline);
  setOnline();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => {}); });
  }
}

function main() {
  wire();
  try {
    const lid = new URLSearchParams(location.search).get('list');
    if (lid) { currentListId = lid; localStorage.setItem(K.list, lid); }
  } catch (e) { /* ignore */ }
  if (configMissing()) { show('signin'); msg('The app is not set up yet (config.js).'); return; }

  const app = initializeApp(CFG.firebase);
  auth = getAuth(app);
  db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });

  getRedirectResult(auth).catch(() => {});

  onAuthStateChanged(auth, (u) => {
    if (u) { user = u; startApp(); return; }
    user = null;
    stopApp();
    show('signin');
  });
}

main();
