// Walton Lists - push relay (Cloudflare Worker)
// Receives a request from the app and sends a Web Push notification.
// The app can't send pushes itself (browsers are blocked from doing it),
// so this tiny stateless relay signs and sends them. It holds the VAPID
// private key; it is NOT in the phone app.
//
// Secrets (set in Cloudflare -> Settings -> Variables, or wrangler secret):
//   VAPID_JWK      JSON string: {"kty":"EC","crv":"P-256","x":"..","y":"..","d":".."}
//   VAPID_PUBLIC   base64url of the uncompressed public key (same one the app uses)
//   VAPID_SUBJECT  e.g. "mailto:tjwalton1984@gmail.com"
//   SHARED_TOKEN   any string; the app sends it so randoms can't use the relay
//
// The same code runs in Node 22 (for testing) because Node has global
// crypto.subtle and fetch.

// ---- Settings (already filled in for Walton Lists) ----
// These live here in the relay, never in the phone app. Safe to leave as-is.
// (If you ever prefer, you can instead set these as Worker Variables with the
//  same names and they'll override what's here.)
const INLINE = {
  // NOTE: this is the REDACTED copy kept in the public repo for reference.
  // The real private key 'd' lives only in the deployed Cloudflare Worker,
  // never in this public repo. The deploy file has the real value.
  VAPID_JWK: {
    kty: 'EC', crv: 'P-256',
    x: '74k-eXGLDgm4t5zpmQSPyA0jWXnMVR3LEBgxPPUllLg',
    y: '8kzS3kKNOgkSWMU2gdhHWjbxUL3f--e_PR2m8oYuXb0',
    d: 'SET-IN-CLOUDFLARE-ONLY'
  },
  VAPID_PUBLIC: 'BO-JPnlxiw4JuLec6ZkEj8gNI1l5zFUdyxAYMTz1JZS48kzS3kKNOgkSWMU2gdhHWjbxUL3f--e_PR2m8oYuXb0',
  VAPID_SUBJECT: 'mailto:tjwalton1984@gmail.com',
  SHARED_TOKEN: '1_tOmrLUAbYFWhJwCZSG3ejjWDnrYx9X'
};
function cfg(env) {
  env = env || {};
  return {
    VAPID_JWK: env.VAPID_JWK || INLINE.VAPID_JWK,
    VAPID_PUBLIC: env.VAPID_PUBLIC || INLINE.VAPID_PUBLIC,
    VAPID_SUBJECT: env.VAPID_SUBJECT || INLINE.VAPID_SUBJECT,
    SHARED_TOKEN: env.SHARED_TOKEN || INLINE.SHARED_TOKEN
  };
}

const te = new TextEncoder();

const b64uToBytes = (s) => {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
const bytesToB64u = (bytes) => {
  let bin = '';
  const b = new Uint8Array(bytes);
  for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const concat = (...arrs) => {
  let len = 0;
  for (const a of arrs) len += a.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
};

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    key, length * 8
  );
  return new Uint8Array(bits);
}

// Encrypt a payload for Web Push using aes128gcm (RFC 8188 / RFC 8291).
async function encryptPayload(plaintext, uaPublicB64u, authSecretB64u) {
  const uaPublic = b64uToBytes(uaPublicB64u);       // recipient public key, 65 bytes
  const authSecret = b64uToBytes(authSecretB64u);   // recipient auth, 16 bytes

  // Our ephemeral ECDH keypair (the "application server" keys for this message)
  const asKeys = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']
  );
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', asKeys.publicKey)); // 65 bytes

  const uaPubKey = await crypto.subtle.importKey(
    'raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []
  );
  const ecdhBits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: uaPubKey }, asKeys.privateKey, 256
  );
  const ecdhSecret = new Uint8Array(ecdhBits);

  // IKM = HKDF(salt=auth, ikm=ecdhSecret, info="WebPush: info\0"||uaPublic||asPublic)
  const keyInfo = concat(te.encode('WebPush: info'), new Uint8Array([0]), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, concat(te.encode('Content-Encoding: aes128gcm'), new Uint8Array([0])), 16);
  const nonce = await hkdf(salt, ikm, concat(te.encode('Content-Encoding: nonce'), new Uint8Array([0])), 12);

  // One record: plaintext || 0x02 (last-record delimiter), no extra padding
  const record = concat(te.encode(plaintext), new Uint8Array([2]));

  const aesKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, record
  ));

  // Header: salt(16) || rs(4, big-endian) || idlen(1) || keyid(asPublic, 65) || ciphertext
  const rs = 4096;
  const rsBytes = new Uint8Array([(rs >>> 24) & 255, (rs >>> 16) & 255, (rs >>> 8) & 255, rs & 255]);
  return concat(salt, rsBytes, new Uint8Array([asPublic.length]), asPublic, ct);
}

async function vapidAuth(endpoint, jwk, subject) {
  const aud = new URL(endpoint).origin;
  const header = bytesToB64u(te.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = bytesToB64u(te.encode(JSON.stringify({
    aud, exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60, sub: subject
  })));
  const signingInput = header + '.' + payload;

  const key = await crypto.subtle.importKey(
    'jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d, ext: true },
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']
  );
  const sig = new Uint8Array(await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, key, te.encode(signingInput)
  ));
  const jwt = signingInput + '.' + bytesToB64u(sig);
  return 'vapid t=' + jwt + ', k=' + '__VAPID_PUBLIC__';
}

// Send one push. Returns the push service's HTTP status.
export async function sendPush(subscription, payloadString, env) {
  const jwk = typeof env.VAPID_JWK === 'string' ? JSON.parse(env.VAPID_JWK) : env.VAPID_JWK;
  const body = await encryptPayload(payloadString, subscription.keys.p256dh, subscription.keys.auth);
  let auth = await vapidAuth(subscription.endpoint, jwk, env.VAPID_SUBJECT);
  auth = auth.replace('__VAPID_PUBLIC__', env.VAPID_PUBLIC);

  const res = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      'TTL': '86400',
      'Urgency': 'high',
      'Authorization': auth
    },
    body
  });
  return res.status;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (request.method !== 'POST') return new Response('Walton Lists push relay is running.', { status: 200, headers: CORS });

    env = cfg(env);

    let data;
    try { data = await request.json(); }
    catch { return new Response(JSON.stringify({ ok: false, error: 'bad json' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } }); }

    if (!env.SHARED_TOKEN || data.token !== env.SHARED_TOKEN) {
      return new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), { status: 401, headers: { ...CORS, 'Content-Type': 'application/json' } });
    }

    const subs = Array.isArray(data.subscriptions) ? data.subscriptions : (data.subscription ? [data.subscription] : []);
    if (!subs.length) return new Response(JSON.stringify({ ok: false, error: 'no subscriptions' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } });

    const payload = JSON.stringify({
      title: String(data.title || 'Walton Lists'),
      body: String(data.body || ''),
      url: String(data.url || '/walton-lists/'),
      tag: String(data.tag || '')
    });

    const results = [];
    for (const sub of subs) {
      try {
        if (!sub || !sub.endpoint || !sub.keys) { results.push({ ok: false, error: 'bad sub' }); continue; }
        const status = await sendPush(sub, payload, env);
        // 201 = delivered to push service; 404/410 = subscription gone
        results.push({ ok: status >= 200 && status < 300, status, gone: status === 404 || status === 410 });
      } catch (e) {
        results.push({ ok: false, error: String((e && e.message) || e) });
      }
    }
    return new Response(JSON.stringify({ ok: true, results }), { headers: { ...CORS, 'Content-Type': 'application/json' } });
  }
};

// Exported for local testing in Node.
export { encryptPayload, vapidAuth };
