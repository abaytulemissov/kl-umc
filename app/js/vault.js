// PIN-protected stamp: the stamp image is published only encrypted (AES-GCM 256,
// key from the PIN via PBKDF2-SHA256). Without the PIN the file is useless.
(function (global) {
  'use strict';
  const ITER = 600000;
  const enc = new TextEncoder();
  const b64 = (buf) => {
    let s = '';
    const a = new Uint8Array(buf);
    for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode.apply(null, a.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

  async function key(pin, salt, iter) {
    const base = await crypto.subtle.importKey('raw', enc.encode(pin.normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  // bytes (Uint8Array of a PNG) -> JSON-able object
  async function lock(bytes, pin, type) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const k = await key(pin, salt, ITER);
    const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, bytes);
    return { v: 1, kdf: 'PBKDF2-SHA256', iter: ITER, type: type || 'image/png', salt: b64(salt), iv: b64(iv), data: b64(data) };
  }

  // -> data: URL, or throws if the PIN is wrong
  async function unlock(box, pin) {
    const k = await key(pin, unb64(box.salt), box.iter || ITER);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(box.iv) }, k, unb64(box.data));
    return 'data:' + (box.type || 'image/png') + ';base64,' + b64(plain);
  }

  global.Vault = { lock, unlock };
})(typeof window !== 'undefined' ? window : globalThis);
