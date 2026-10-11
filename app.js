// Walton Lists - v2
import {
  initializeApp,
  getAuth, onAuthStateChanged, signInWithCredential, GoogleAuthProvider, signOut,
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, query, where, orderBy, onSnapshot,
  addDoc, setDoc, updateDoc, deleteDoc, getDocs, writeBatch, serverTimestamp
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

// ---------- sign-in ----------
function startSignIn() {
  if (configMissing()) { msg('The app is not set up yet (config.js).'); return; }
  const state = rand(), nonce = rand();
  localStorage.setItem(K.state, state);
  localStorage.setItem(K.nonce, nonce);
  localStorage.setItem(K.from, isStandalone() ? 'app' : 'browser');
  localStorage.setItem(K.pending, String(Date.now()));
  localStorage.removeItem(K.reloaded);
  localStorage.removeItem(K.token);
  const base = location.href.split(/[?#]/)[0].replace(/[^/]*$/, '');
  const redirectUri = base + 'redirect.html';
  const p = new URLSearchParams({
    client_id: CFG.googleClientId,
    redirect_uri: redirectUri,
    response_type: 'id_token',
    scope: 'openid email profile',
    nonce, state,
    prompt: 'select_account'
  });
  location.assign('https://accounts.google.com/o/oauth2/v2/auth?' + p.toString());
}

let inflight = null;
async function consumeToken() {
  if (inflight) return inflight;
  const idToken = localStorage.getItem(K.token);
  if (!idToken) return false;
  localStorage.removeItem(K.token);
  show('loading');
  inflight = (async () => {
    try {
      await signInWithCredential(auth, GoogleAuthProvider.credential(idToken));
      localStorage.removeItem(K.pending);
      localStorage.removeItem(K.reloaded);
      return true;
    } catch (e) {
      localStorage.removeItem(K.pending);
      const c = (e && e.code) || '';
      if (c === 'auth/invalid-credential' || c === 'auth/user-token-expired') msg('That sign-in expired. Tap Sign in with Google again.');
      else if (c === 'auth/operation-not-allowed') msg('Google sign-in is not switched on for this app yet.');
      else msg('Sign-in did not work: ' + (c || (e && e.message) || e));
      show('signin');
      return false;
    }
  })();
  try { return await inflight; } finally { inflight = null; }
}

async function checkReturn() {
  if (!auth || auth.currentUser) return;
  if (await consumeToken()) return;
  const pending = Number(localStorage.getItem(K.pending) || 0);
  if (pending && Date.now() - pending < PENDING_MAX_MS && !localStorage.getItem(K.reloaded)) {
    localStorage.setItem(K.reloaded, '1');
    location.reload();
  }
}

// ---------- app start ----------
function startApp() {
  show('app');
  $('btn-account').textContent = initials(user.email);
  $('who').textContent = 'Signed in as ' + (user.email || '');
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
  } catch (e) { banner(friendlyError(e)); }
}
async function toggleItem(it, done) {
  try { await updateDoc(itemRef(it), { done, doneAt: done ? Date.now() : null }); }
  catch (e) { banner(friendlyError(e)); }
}
async function editItem(it) {
  const text = prompt('Edit item', it.text || '');
  if (text === null) return;
  const t = text.trim();
  try {
    if (!t) await deleteDoc(itemRef(it));
    else await updateDoc(itemRef(it), { text: t });
  } catch (e) { banner(friendlyError(e)); }
}
async function deleteItem(it) {
  try { await deleteDoc(itemRef(it)); } catch (e) { banner(friendlyError(e)); }
}
async function clearDone() {
  const done = items.filter((i) => i.done);
  if (!done.length) return;
  try {
    const batch = writeBatch(db);
    for (const it of done) batch.delete(itemRef(it));
    await batch.commit();
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
    setDoc(ref, { name, members, owner: user.email, created: Date.now() }).catch(fail);
    selectList(ref.id);
  } else if (dialogMode === 'rename') {
    updateDoc(doc(db, 'lists', currentListId), { name }).catch(fail);
  } else {
    updateDoc(doc(db, 'lists', currentListId), { name, members }).catch(fail);
  }
  $('dlg-list').close();
}

async function deleteList() {
  const list = currentList();
  if (!list) return;
  if (!confirm('Delete "' + list.name + '" and everything on it? This cannot be undone.')) return;
  try {
    const snap = await getDocs(collection(db, 'lists', list.id, 'items'));
    const batch = writeBatch(db);
    snap.forEach((d) => batch.delete(d.ref));
    batch.delete(doc(db, 'lists', list.id));
    batch.commit().catch((e) => banner(friendlyError(e)));
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

  window.addEventListener('storage', (ev) => { if (ev.key === K.token && ev.newValue) consumeToken(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkReturn(); });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => {}); });
  }
}

function main() {
  wire();
  if (configMissing()) { show('signin'); msg('The app is not set up yet (config.js).'); return; }

  const app = initializeApp(CFG.firebase);
  auth = getAuth(app);
  db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });

  const hadToken = !!localStorage.getItem(K.token);
  const consuming = hadToken ? consumeToken() : Promise.resolve(false);

  onAuthStateChanged(auth, async (u) => {
    if (u) {
      user = u;
      localStorage.removeItem(K.pending);
      localStorage.removeItem(K.reloaded);
      startApp();
      return;
    }
    user = null;
    stopApp();
    await consuming;
    if (auth.currentUser) return;
    show('signin');
    if (localStorage.getItem(K.pending)) msg('That sign-in did not finish. Tap Sign in with Google to try again.');
  });
}

main();
