// Walton Lists - v1
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
function friendlyError(e) {
  const c = (e && e.code) || '';
  if (c === 'permission-denied') return 'Not allowed. Check that this Google account and the share email are both listed in the Firestore rules.';
  if (c === 'unavailable') return 'No connection. The change will sync when you are back online.';
  return (e && (e.message || e.code)) || String(e);
}

function startSignIn() {
  if (configMissing()) { msg('config.js has not been filled in yet.'); return; }
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
      if (c === 'auth/invalid-credential' || c === 'auth/user-token-expired') msg('That sign-in has expired. Tap Sign in again.');
      else if (c === 'auth/operation-not-allowed') msg('Google is not enabled as a sign-in method in the Firebase project.');
      else msg('Sign-in failed: ' + (c || (e && e.message) || e));
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

function startApp() {
  show('app');
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
  const key = list ? list.id : null;
  if (key === itemsFor && unsubItems) { renderItems(); return; }
  if (unsubItems) { unsubItems(); unsubItems = null; }
  itemsFor = key;
  items = [];
  $('add-form').hidden = !list;
  if (!list) {
    renderItems();
    $('empty').hidden = false;
    $('empty').textContent = lists.length ? 'Pick a list above.' : 'No lists yet. Tap ⋯ and choose New list.';
    return;
  }
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
    b.textContent = l.name || '(no name)';
    if (others(l).length) {
      const s = document.createElement('span');
      s.className = 'shared';
      s.textContent = '· shared';
      b.appendChild(s);
    }
    b.addEventListener('click', () => selectList(l.id));
    el.appendChild(b);
  }
}

function renderItems() {
  const ul = $('items');
  ul.textContent = '';
  const list = currentList();
  const open = items.filter((i) => !i.done);
  const done = items.filter((i) => i.done);
  for (const it of [...open, ...done]) ul.appendChild(itemRow(it));
  $('empty').hidden = !(list && items.length === 0);
  if (list && items.length === 0) $('empty').textContent = 'Nothing on this list yet.';
}

function itemRow(it) {
  const li = document.createElement('li');
  li.className = 'item' + (it.done ? ' done' : '') + (it.pending ? ' pending' : '');
  const cb = document.createElement('input');
  cb.type = 'checkbox'; cb.checked = !!it.done;
  cb.addEventListener('change', () => toggleItem(it, cb.checked));
  const t = document.createElement('div');
  t.className = 'text'; t.textContent = it.text || '';
  t.addEventListener('click', () => editItem(it));
  const del = document.createElement('button');
  del.className = 'del'; del.textContent = '×'; del.setAttribute('aria-label', 'Remove');
  del.addEventListener('click', () => deleteItem(it));
  li.append(cb, t, del);
  return li;
}

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

function parseEmails(s) {
  return [...new Set(String(s || '').split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter((x) => x.includes('@')))];
}

function openDialog(mode) {
  dialogMode = mode;
  const list = currentList();
  const isNew = mode === 'new';
  $('dlg-title').textContent = isNew ? 'New list' : (mode === 'rename' ? 'Rename list' : 'Share list');
  $('dlg-name').value = isNew ? '' : (list ? list.name : '');
  const shareWith = isNew ? [] : (list ? others(list) : []);
  $('dlg-share').checked = shareWith.length > 0;
  $('dlg-email').value = shareWith.length ? shareWith.join(', ') : (localStorage.getItem(K.share) || '');
  $('dlg-share-row').hidden = mode === 'rename';
  $('dlg-email-label').hidden = mode === 'rename' || !$('dlg-share').checked;
  $('dlg-list').showModal();
  setTimeout(() => (mode === 'share' ? $('dlg-email') : $('dlg-name')).focus(), 50);
}

async function saveDialog() {
  const name = $('dlg-name').value.trim();
  if (!name) return;
  const shared = $('dlg-share').checked && dialogMode !== 'rename';
  const emails = shared ? parseEmails($('dlg-email').value).filter((e) => e !== user.email) : [];
  if (shared && !emails.length) { alert('Enter the email of the person to share with.'); return; }
  if (emails.length) localStorage.setItem(K.share, emails.join(', '));
  const members = [user.email, ...emails];
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
  if (!confirm('Delete "' + list.name + '" and everything on it?')) return;
  try {
    const snap = await getDocs(collection(db, 'lists', list.id, 'items'));
    const batch = writeBatch(db);
    snap.forEach((d) => batch.delete(d.ref));
    batch.delete(doc(db, 'lists', list.id));
    batch.commit().catch((e) => banner(friendlyError(e)));
  } catch (e) { banner(friendlyError(e)); }
}

function openMenu(open) {
  const list = currentList();
  for (const id of ['m-rename', 'm-share', 'm-clear', 'm-delete']) $(id).disabled = !list;
  $('m-share').textContent = list && others(list).length ? 'Sharing: ' + others(list).join(', ') : 'Share this list';
  $('menu').hidden = !open;
  $('menu-shade').hidden = !open;
}

function wire() {
  $('btn-signin').addEventListener('click', startSignIn);
  $('btn-menu').addEventListener('click', () => openMenu(true));
  $('menu-shade').addEventListener('click', () => openMenu(false));
  $('m-close').addEventListener('click', () => openMenu(false));
  $('m-newlist').addEventListener('click', () => { openMenu(false); openDialog('new'); });
  $('m-rename').addEventListener('click', () => { openMenu(false); openDialog('rename'); });
  $('m-share').addEventListener('click', () => { openMenu(false); openDialog('share'); });
  $('m-clear').addEventListener('click', () => { openMenu(false); clearDone(); });
  $('m-delete').addEventListener('click', () => { openMenu(false); deleteList(); });
  $('m-signout').addEventListener('click', async () => { openMenu(false); await signOut(auth); });
  $('add-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const inp = $('add-input');
    const text = inp.value.trim();
    inp.value = '';
    inp.focus();
    addItem(text);
  });
  $('dlg-share').addEventListener('change', () => { $('dlg-email-label').hidden = !$('dlg-share').checked; });
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
  if (CFG.appName) { document.title = CFG.appName; $('signin-title').textContent = CFG.appName; }
  if (configMissing()) { show('signin'); msg('config.js has not been filled in yet.'); return; }

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
    if (localStorage.getItem(K.pending)) msg('Sign-in did not finish. Tap Sign in again.');
  });
}

main();
