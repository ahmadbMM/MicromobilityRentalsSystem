// Signing an Apple Wallet pass without node-forge: the platform's WebCrypto does the RSA and the
// hashing, and this file does the parts it cannot - reading the credentials and writing the
// PKCS#7 (CMS) signature Apple expects over manifest.json.
//
//   • DER, read and written by hand (tiny: a pass signature is a dozen nested sequences).
//   • The credentials, either way they are given:
//       - a certificate PEM and a PKCS#8 (or PKCS#1) key PEM, or
//       - the .p12 Keychain exports, opened here: PBES2 (PBKDF2 + AES/3DES, what OpenSSL 3 writes)
//         and the PKCS#12 ciphers Keychain Access still uses (SHA-1 KDF with 3DES for the key,
//         RC2-40 for the certificates). WebCrypto has no DES or RC2, so both are written out
//         below; they decrypt our own secret at start-up and nothing an outsider sends.
//   • CMS SignedData, detached, SHA-256, with the signer's certificate and Apple's WWDR
//     intermediate, and the three signed attributes (contentType, signingTime, messageDigest)
//     the previous node-forge signature carried.
//
// Every function takes and returns Uint8Array. Nothing here keeps state.

const te = new TextEncoder();

// ── bytes ─────────────────────────────────────────────────────────────────────────────────────
export const concat = (...parts) => {
  let n = 0; for (const p of parts) n += p.length;
  const out = new Uint8Array(n); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
export const b64ToBytes = (b64) => {
  const bin = atob(String(b64).replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
export const bytesToB64 = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
export const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
// Byte-wise order, as DER wants the members of a SET OF.
const cmpBytes = (a, b) => { const n = Math.min(a.length, b.length); for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i]; return a.length - b.length; };

// ── DER, written ──────────────────────────────────────────────────────────────────────────────
const lenBytes = (n) => {
  if (n < 0x80) return Uint8Array.of(n);
  const b = []; while (n > 0) { b.unshift(n & 0xff); n = Math.floor(n / 256); }
  return Uint8Array.of(0x80 | b.length, ...b);
};
export const tlv = (tag, ...content) => { const body = concat(...content); return concat(Uint8Array.of(tag), lenBytes(body.length), body); };
export const SEQ = (...c) => tlv(0x30, ...c);
export const SET = (...c) => tlv(0x31, ...c.slice().sort(cmpBytes));   // DER: SET OF in byte order
export const OCTET = (b) => tlv(0x04, b);
export const NULL = tlv(0x05);
export const INT = (n) => { // a small non-negative integer
  const b = []; do { b.unshift(n & 0xff); n = Math.floor(n / 256); } while (n > 0);
  if (b[0] & 0x80) b.unshift(0);
  return tlv(0x02, Uint8Array.from(b));
};
export const OID = (dotted) => {
  const p = dotted.split('.').map(Number);
  const out = [40 * p[0] + p[1]];
  for (const v0 of p.slice(2)) {
    let v = v0; const stack = [];
    do { stack.unshift(v & 0x7f); v = Math.floor(v / 128); } while (v > 0);
    for (let i = 0; i < stack.length - 1; i++) stack[i] |= 0x80;
    out.push(...stack);
  }
  return tlv(0x06, Uint8Array.from(out));
};
export const UTCTIME = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return tlv(0x17, te.encode(`${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`));
};
const CTX = (n, ...c) => tlv(0xa0 | n, ...c); // [n], constructed: EXPLICIT wraps one value, IMPLICIT SET OF carries the members

// ── DER, read ─────────────────────────────────────────────────────────────────────────────────
// A node is {tag, off, start, end, next}: its tag, where its own bytes begin, where its content
// lies, and where the next sibling begins. BER's indefinite lengths (0x80 ... 00 00) are read too,
// since some PKCS#12 writers use them for the outer wrappers.
export function read(b, off) {
  if (off >= b.length) throw new Error('DER: past the end');
  const tag = b[off]; let i = off + 1; let len = b[i++];
  if (len === 0x80) {
    let j = i;
    while (!(b[j] === 0 && b[j + 1] === 0)) { if (j >= b.length) throw new Error('DER: no end-of-contents'); j = read(b, j).next; }
    return { tag, off, start: i, end: j, next: j + 2 };
  }
  if (len & 0x80) { const n = len & 0x7f; len = 0; for (let k = 0; k < n; k++) len = len * 256 + b[i++]; }
  if (i + len > b.length) throw new Error('DER: length past the end');
  return { tag, off, start: i, end: i + len, next: i + len };
}
export const kids = (b, node) => { const out = []; let j = node.start; while (j < node.end) { const c = read(b, j); out.push(c); j = c.next; } return out; };
export const content = (b, node) => b.subarray(node.start, node.end);
export const whole = (b, node) => b.subarray(node.off, node.next);
// An OCTET STRING's bytes, also when a BER writer split it into a constructed one of pieces.
const octets = (b, node) => (node.tag & 0x20) ? concat(...kids(b, node).map((k) => octets(b, k))) : content(b, node);
export const oidOf = (b, node) => {
  const c = content(b, node); const out = [Math.floor(c[0] / 40), c[0] % 40];
  let v = 0; for (let i = 1; i < c.length; i++) { v = v * 128 + (c[i] & 0x7f); if (!(c[i] & 0x80)) { out.push(v); v = 0; } }
  return out.join('.');
};
const intOf = (b, node) => { let v = 0; for (const x of content(b, node)) v = v * 256 + x; return v; };

// ── PEM ───────────────────────────────────────────────────────────────────────────────────────
export function pemBlocks(pem) {
  const out = [];
  for (const m of String(pem).matchAll(/-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/g)) out.push({ label: m[1], der: b64ToBytes(m[2]) });
  return out;
}
// A key PEM as PKCS#8 DER: PKCS#8 as it is, PKCS#1 ("RSA PRIVATE KEY") wrapped, an encrypted
// PKCS#8 opened with its password.
export async function keyPemToPkcs8(pem, password) {
  for (const { label, der } of pemBlocks(pem)) {
    if (label === 'PRIVATE KEY') return der;
    if (label === 'RSA PRIVATE KEY') return SEQ(INT(0), SEQ(OID(OIDS.rsaEncryption), NULL), OCTET(der));
    if (label === 'ENCRYPTED PRIVATE KEY') return decryptShrouded(der, password || '');
  }
  throw new Error('no private key in the PEM');
}
export const certPemToDer = (pem) => { const b = pemBlocks(pem).find((x) => x.label === 'CERTIFICATE'); if (!b) throw new Error('no certificate in the PEM'); return b.der; };

// ── OIDs ──────────────────────────────────────────────────────────────────────────────────────
const OIDS = {
  data: '1.2.840.113549.1.7.1', signedData: '1.2.840.113549.1.7.2', encryptedData: '1.2.840.113549.1.7.6',
  contentType: '1.2.840.113549.1.9.3', messageDigest: '1.2.840.113549.1.9.4', signingTime: '1.2.840.113549.1.9.5',
  sha256: '2.16.840.1.101.3.4.2.1', rsaEncryption: '1.2.840.113549.1.1.1',
  keyBag: '1.2.840.113549.1.12.10.1.1', shroudedKeyBag: '1.2.840.113549.1.12.10.1.2', certBag: '1.2.840.113549.1.12.10.1.3',
  x509Certificate: '1.2.840.113549.1.9.22.1', localKeyId: '1.2.840.113549.1.9.21',
  pbes2: '1.2.840.113549.1.5.13', pbkdf2: '1.2.840.113549.1.5.12',
  hmacSHA1: '1.2.840.113549.2.7', hmacSHA224: '1.2.840.113549.2.8', hmacSHA256: '1.2.840.113549.2.9', hmacSHA384: '1.2.840.113549.2.10', hmacSHA512: '1.2.840.113549.2.11',
  aes128cbc: '2.16.840.1.101.3.4.1.2', aes192cbc: '2.16.840.1.101.3.4.1.22', aes256cbc: '2.16.840.1.101.3.4.1.42', desEde3cbc: '1.2.840.113549.3.7',
  pbeSHA1RC4_128: '1.2.840.113549.1.12.1.1', pbeSHA1RC4_40: '1.2.840.113549.1.12.1.2',
  pbeSHA1DES3: '1.2.840.113549.1.12.1.3', pbeSHA1DES2: '1.2.840.113549.1.12.1.4', pbeSHA1RC2_128: '1.2.840.113549.1.12.1.5', pbeSHA1RC2_40: '1.2.840.113549.1.12.1.6',
  commonName: '2.5.4.3',
};
const HASH_OF = { [OIDS.hmacSHA1]: 'SHA-1', [OIDS.hmacSHA224]: 'SHA-224', [OIDS.hmacSHA256]: 'SHA-256', [OIDS.hmacSHA384]: 'SHA-384', [OIDS.hmacSHA512]: 'SHA-512' };

// ── the digests ───────────────────────────────────────────────────────────────────────────────
export const digest = async (alg, bytes) => new Uint8Array(await crypto.subtle.digest(alg, bytes));
export const sha1hex = async (bytes) => hex(await digest('SHA-1', bytes));

// ── PKCS#12 ───────────────────────────────────────────────────────────────────────────────────
// Opens a .p12 and answers {keyPkcs8, cert, certs, how}: the private key as PKCS#8 DER, the
// certificate that goes with it (the one sharing its localKeyId, else the first), every
// certificate in the file, and a word on the ciphers met (for a self-test's report).
export async function openP12(der, password) {
  const how = new Set();
  const pfx = read(der, 0);
  const [, authSafe] = kids(der, pfx);
  const asKids = kids(der, authSafe);
  if (oidOf(der, asKids[0]) !== OIDS.data) throw new Error('p12: authenticated safe is not plain data');
  const safeDer = octets(der, kids(der, asKids[1])[0]);
  const bags = [];
  for (const ci of kids(safeDer, read(safeDer, 0))) {
    const k = kids(safeDer, ci); const type = oidOf(safeDer, k[0]);
    if (type === OIDS.data) bags.push(...safeBags(octets(safeDer, kids(safeDer, k[1])[0])));
    else if (type === OIDS.encryptedData) {
      const ed = kids(safeDer, k[1])[0];                       // EncryptedData
      const eci = kids(safeDer, kids(safeDer, ed)[1]);         // EncryptedContentInfo: type, algorithm, [0] content
      const plain = await decryptPBE(safeDer, eci[1], octets(safeDer, eci[2]), password, how);
      bags.push(...safeBags(plain));
    } else throw new Error('p12: unknown content ' + type);
  }
  let key = null, keyId = null; const certs = [];
  for (const bag of bags) {
    if (bag.type === OIDS.keyBag) { key = bag.value; keyId = bag.localKeyId; }
    else if (bag.type === OIDS.shroudedKeyBag) { key = await decryptShrouded(bag.value, password, how); keyId = bag.localKeyId; }
    else if (bag.type === OIDS.certBag) {
      const cb = kids(bag.value, read(bag.value, 0));
      if (oidOf(bag.value, cb[0]) === OIDS.x509Certificate) certs.push({ der: octets(bag.value, kids(bag.value, cb[1])[0]), localKeyId: bag.localKeyId });
    }
  }
  if (!key) throw new Error('p12: no private key');
  if (!certs.length) throw new Error('p12: no certificate');
  read(key, 0); // a wrong password leaves bytes that are not DER
  const own = (keyId && certs.find((c) => c.localKeyId && eq(c.localKeyId, keyId))) || certs[0];
  return { keyPkcs8: key, cert: own.der, certs: certs.map((c) => c.der), how: [...how].join(', ') };
}
// SafeContents: SEQUENCE OF SafeBag { bagId, [0] value, attributes SET OPTIONAL }.
function safeBags(der) {
  const out = [];
  for (const bag of kids(der, read(der, 0))) {
    const k = kids(der, bag);
    const item = { type: oidOf(der, k[0]), value: whole(der, kids(der, k[1])[0]), localKeyId: null };
    if (k[2]) for (const attr of kids(der, k[2])) {
      const a = kids(der, attr);
      if (oidOf(der, a[0]) === OIDS.localKeyId) { const v = kids(der, a[1])[0]; if (v) item.localKeyId = content(der, v); }
    }
    out.push(item);
  }
  return out;
}
// EncryptedPrivateKeyInfo { algorithm, OCTET STRING } → PrivateKeyInfo (PKCS#8) DER.
async function decryptShrouded(der, password, how = new Set()) {
  const k = kids(der, read(der, 0));
  return decryptPBE(der, k[0], octets(der, k[1]), password, how);
}
// Password-based decryption, by the AlgorithmIdentifier a PKCS#12 or PKCS#8 wrapper names.
async function decryptPBE(b, algNode, data, password, how) {
  const [oidNode, params] = kids(b, algNode);
  const alg = oidOf(b, oidNode);
  if (alg === OIDS.pbes2) {
    const [kdf, scheme] = kids(b, params);
    const [kdfOid, kdfParams] = kids(b, kdf);
    if (oidOf(b, kdfOid) !== OIDS.pbkdf2) throw new Error('p12: PBES2 without PBKDF2');
    const kp = kids(b, kdfParams);
    const salt = content(b, kp[0]), iterations = intOf(b, kp[1]);
    let prf = 'SHA-1';
    for (const extra of kp.slice(2)) if (extra.tag === 0x30) prf = HASH_OF[oidOf(b, kids(b, extra)[0])] || prf;
    const [schemeOid, ivNode] = kids(b, scheme);
    const enc = oidOf(b, schemeOid), iv = content(b, ivNode);
    const keyLen = enc === OIDS.aes128cbc ? 16 : enc === OIDS.aes192cbc ? 24 : enc === OIDS.aes256cbc ? 32 : enc === OIDS.desEde3cbc ? 24 : 0;
    if (!keyLen) throw new Error('p12: PBES2 cipher ' + enc);
    const key = await pbkdf2(te.encode(password), salt, iterations, prf, keyLen);
    how.add(`PBES2/${enc === OIDS.desEde3cbc ? '3DES' : 'AES-' + keyLen * 8}/${prf}`);
    if (enc === OIDS.desEde3cbc) return unpad(des3CbcDecrypt(key, iv, data));
    const k = await crypto.subtle.importKey('raw', key, 'AES-CBC', false, ['decrypt']);
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, k, data));
  }
  const legacy = { [OIDS.pbeSHA1DES3]: ['3DES', 24, 8], [OIDS.pbeSHA1DES2]: ['2DES', 16, 8], [OIDS.pbeSHA1RC2_128]: ['RC2-128', 16, 8, 128], [OIDS.pbeSHA1RC2_40]: ['RC2-40', 5, 8, 40], [OIDS.pbeSHA1RC4_128]: ['RC4-128', 16, 0], [OIDS.pbeSHA1RC4_40]: ['RC4-40', 5, 0] }[alg];
  if (!legacy) throw new Error('p12: cipher ' + alg);
  const [name, keyLen, ivLen, bits] = legacy;
  const [saltNode, iterNode] = kids(b, params);
  const salt = content(b, saltNode), iterations = intOf(b, iterNode);
  const pw = bmpString(password);
  const key = await pkcs12kdf(pw, salt, iterations, 1, keyLen);
  const iv = ivLen ? await pkcs12kdf(pw, salt, iterations, 2, ivLen) : null;
  how.add(name);
  if (name === '3DES') return unpad(des3CbcDecrypt(key, iv, data));
  if (name === '2DES') return unpad(des3CbcDecrypt(concat(key, key.subarray(0, 8)), iv, data));
  if (name.startsWith('RC2')) return unpad(rc2CbcDecrypt(key, bits, iv, data));
  return rc4(key, data);
}
const unpad = (b) => { const n = b[b.length - 1]; if (!(n >= 1 && n <= 16 && n <= b.length)) throw new Error('bad padding (wrong password?)'); return b.subarray(0, b.length - n); };
const bmpString = (pw) => { const out = new Uint8Array(pw.length * 2 + 2); for (let i = 0; i < pw.length; i++) { const c = pw.charCodeAt(i); out[2 * i] = c >> 8; out[2 * i + 1] = c & 0xff; } return out; };
async function pbkdf2(pw, salt, iterations, hash, len) {
  const k = await crypto.subtle.importKey('raw', pw, 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash }, k, len * 8));
}
// RFC 7292 appendix B, with SHA-1 (u = 20, v = 64): the key (id 1) and the IV (id 2) a PKCS#12
// cipher takes from the password and the salt. The 2048 hashes a round asks for are done by the
// SHA-1 below rather than crypto.subtle: awaiting the platform 8,000 times per .p12 took most
// of a second on a cold start; in plain JavaScript the whole derivation takes a few milliseconds.
async function pkcs12kdf(pw, salt, iterations, id, n) {
  const u = 20, v = 64;
  const D = new Uint8Array(v).fill(id);
  const fill = (src) => { if (!src.length) return new Uint8Array(0); const len = v * Math.ceil(src.length / v); const out = new Uint8Array(len); for (let i = 0; i < len; i++) out[i] = src[i % src.length]; return out; };
  let I = concat(fill(salt), fill(pw));
  const c = Math.ceil(n / u); const parts = [];
  for (let i = 0; i < c; i++) {
    let A = sha1(concat(D, I));
    for (let r = 1; r < iterations; r++) A = sha1(A);
    parts.push(A);
    if (i === c - 1) break;
    const B = new Uint8Array(v); for (let k = 0; k < v; k++) B[k] = A[k % u];
    for (let j = 0; j < I.length; j += v) {           // I_j = (I_j + B + 1) mod 2^(8v), big-endian
      let carry = 1;
      for (let k = v - 1; k >= 0; k--) { const s = I[j + k] + B[k] + carry; I[j + k] = s & 0xff; carry = s >> 8; }
    }
  }
  return concat(...parts).subarray(0, n);
}

// ── SHA-1 (FIPS 180-4), for the PKCS#12 key derivation above ───────────────────────────────
export function sha1(bytes) {
  const len = bytes.length, words = new Int32Array(((len + 8 >> 6) + 1) * 16);
  for (let i = 0; i < len; i++) words[i >> 2] |= bytes[i] << (24 - (i & 3) * 8);
  words[len >> 2] |= 0x80 << (24 - (len & 3) * 8);
  words[words.length - 1] = len * 8;
  let h0 = 0x67452301, h1 = 0xEFCDAB89 | 0, h2 = 0x98BADCFE | 0, h3 = 0x10325476, h4 = 0xC3D2E1F0 | 0;
  const w = new Int32Array(80);
  for (let off = 0; off < words.length; off += 16) {
    for (let t = 0; t < 16; t++) w[t] = words[off + t];
    for (let t = 16; t < 80; t++) { const x = w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16]; w[t] = (x << 1) | (x >>> 31); }
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let t = 0; t < 80; t++) {
      const f = t < 20 ? (b & c) | (~b & d) : t < 40 ? b ^ c ^ d : t < 60 ? (b & c) | (b & d) | (c & d) : b ^ c ^ d;
      const k = t < 20 ? 0x5A827999 : t < 40 ? 0x6ED9EBA1 : t < 60 ? 0x8F1BBCDC | 0 : 0xCA62C1D6 | 0;
      const tmp = (((a << 5) | (a >>> 27)) + f + e + k + w[t]) | 0;
      e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = tmp;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0; h4 = (h4 + e) | 0;
  }
  const out = new Uint8Array(20);
  [h0, h1, h2, h3, h4].forEach((h, i) => { out[i * 4] = h >>> 24; out[i * 4 + 1] = (h >>> 16) & 0xff; out[i * 4 + 2] = (h >>> 8) & 0xff; out[i * 4 + 3] = h & 0xff; });
  return out;
}

// ── DES / 3DES (FIPS 46-3), decryption only ─────────────────────────────────────────────────
const IP = [58, 50, 42, 34, 26, 18, 10, 2, 60, 52, 44, 36, 28, 20, 12, 4, 62, 54, 46, 38, 30, 22, 14, 6, 64, 56, 48, 40, 32, 24, 16, 8, 57, 49, 41, 33, 25, 17, 9, 1, 59, 51, 43, 35, 27, 19, 11, 3, 61, 53, 45, 37, 29, 21, 13, 5, 63, 55, 47, 39, 31, 23, 15, 7];
const FP = [40, 8, 48, 16, 56, 24, 64, 32, 39, 7, 47, 15, 55, 23, 63, 31, 38, 6, 46, 14, 54, 22, 62, 30, 37, 5, 45, 13, 53, 21, 61, 29, 36, 4, 44, 12, 52, 20, 60, 28, 35, 3, 43, 11, 51, 19, 59, 27, 34, 2, 42, 10, 50, 18, 58, 26, 33, 1, 41, 9, 49, 17, 57, 25];
const E = [32, 1, 2, 3, 4, 5, 4, 5, 6, 7, 8, 9, 8, 9, 10, 11, 12, 13, 12, 13, 14, 15, 16, 17, 16, 17, 18, 19, 20, 21, 20, 21, 22, 23, 24, 25, 24, 25, 26, 27, 28, 29, 28, 29, 30, 31, 32, 1];
const P = [16, 7, 20, 21, 29, 12, 28, 17, 1, 15, 23, 26, 5, 18, 31, 10, 2, 8, 24, 14, 32, 27, 3, 9, 19, 13, 30, 6, 22, 11, 4, 25];
const PC1 = [57, 49, 41, 33, 25, 17, 9, 1, 58, 50, 42, 34, 26, 18, 10, 2, 59, 51, 43, 35, 27, 19, 11, 3, 60, 52, 44, 36, 63, 55, 47, 39, 31, 23, 15, 7, 62, 54, 46, 38, 30, 22, 14, 6, 61, 53, 45, 37, 29, 21, 13, 5, 28, 20, 12, 4];
const PC2 = [14, 17, 11, 24, 1, 5, 3, 28, 15, 6, 21, 10, 23, 19, 12, 4, 26, 8, 16, 7, 27, 20, 13, 2, 41, 52, 31, 37, 47, 55, 30, 40, 51, 45, 33, 48, 44, 49, 39, 56, 34, 53, 46, 42, 50, 36, 29, 32];
const SHIFTS = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1];
const SBOX = [
  [14, 4, 13, 1, 2, 15, 11, 8, 3, 10, 6, 12, 5, 9, 0, 7, 0, 15, 7, 4, 14, 2, 13, 1, 10, 6, 12, 11, 9, 5, 3, 8, 4, 1, 14, 8, 13, 6, 2, 11, 15, 12, 9, 7, 3, 10, 5, 0, 15, 12, 8, 2, 4, 9, 1, 7, 5, 11, 3, 14, 10, 0, 6, 13],
  [15, 1, 8, 14, 6, 11, 3, 4, 9, 7, 2, 13, 12, 0, 5, 10, 3, 13, 4, 7, 15, 2, 8, 14, 12, 0, 1, 10, 6, 9, 11, 5, 0, 14, 7, 11, 10, 4, 13, 1, 5, 8, 12, 6, 9, 3, 2, 15, 13, 8, 10, 1, 3, 15, 4, 2, 11, 6, 7, 12, 0, 5, 14, 9],
  [10, 0, 9, 14, 6, 3, 15, 5, 1, 13, 12, 7, 11, 4, 2, 8, 13, 7, 0, 9, 3, 4, 6, 10, 2, 8, 5, 14, 12, 11, 15, 1, 13, 6, 4, 9, 8, 15, 3, 0, 11, 1, 2, 12, 5, 10, 14, 7, 1, 10, 13, 0, 6, 9, 8, 7, 4, 15, 14, 3, 11, 5, 2, 12],
  [7, 13, 14, 3, 0, 6, 9, 10, 1, 2, 8, 5, 11, 12, 4, 15, 13, 8, 11, 5, 6, 15, 0, 3, 4, 7, 2, 12, 1, 10, 14, 9, 10, 6, 9, 0, 12, 11, 7, 13, 15, 1, 3, 14, 5, 2, 8, 4, 3, 15, 0, 6, 10, 1, 13, 8, 9, 4, 5, 11, 12, 7, 2, 14],
  [2, 12, 4, 1, 7, 10, 11, 6, 8, 5, 3, 15, 13, 0, 14, 9, 14, 11, 2, 12, 4, 7, 13, 1, 5, 0, 15, 10, 3, 9, 8, 6, 4, 2, 1, 11, 10, 13, 7, 8, 15, 9, 12, 5, 6, 3, 0, 14, 11, 8, 12, 7, 1, 14, 2, 13, 6, 15, 0, 9, 10, 4, 5, 3],
  [12, 1, 10, 15, 9, 2, 6, 8, 0, 13, 3, 4, 14, 7, 5, 11, 10, 15, 4, 2, 7, 12, 9, 5, 6, 1, 13, 14, 0, 11, 3, 8, 9, 14, 15, 5, 2, 8, 12, 3, 7, 0, 4, 10, 1, 13, 11, 6, 4, 3, 2, 12, 9, 5, 15, 10, 11, 14, 1, 7, 6, 0, 8, 13],
  [4, 11, 2, 14, 15, 0, 8, 13, 3, 12, 9, 7, 5, 10, 6, 1, 13, 0, 11, 7, 4, 9, 1, 10, 14, 3, 5, 12, 2, 15, 8, 6, 1, 4, 11, 13, 12, 3, 7, 14, 10, 15, 6, 8, 0, 5, 9, 2, 6, 11, 13, 8, 1, 4, 10, 7, 9, 5, 0, 15, 14, 2, 3, 12],
  [13, 2, 8, 4, 6, 15, 11, 1, 10, 9, 3, 14, 5, 0, 12, 7, 1, 15, 13, 8, 10, 3, 7, 4, 12, 5, 6, 11, 0, 14, 9, 2, 7, 11, 4, 1, 9, 12, 14, 2, 0, 6, 10, 13, 15, 3, 5, 8, 2, 1, 14, 7, 4, 10, 8, 13, 15, 12, 9, 0, 3, 5, 6, 11],
];
// Bits as arrays of 0/1, most significant first: slow and plain, and the data is a few KB.
const toBits = (bytes) => { const out = new Array(bytes.length * 8); for (let i = 0; i < bytes.length; i++) for (let j = 0; j < 8; j++) out[i * 8 + j] = (bytes[i] >> (7 - j)) & 1; return out; };
const fromBits = (bits) => { const out = new Uint8Array(bits.length / 8); for (let i = 0; i < out.length; i++) { let v = 0; for (let j = 0; j < 8; j++) v = (v << 1) | bits[i * 8 + j]; out[i] = v; } return out; };
const permute = (bits, table) => table.map((p) => bits[p - 1]);
function desSubkeys(key8) {
  const k = permute(toBits(key8), PC1);
  let c = k.slice(0, 28), d = k.slice(28);
  const out = [];
  for (const s of SHIFTS) { c = c.slice(s).concat(c.slice(0, s)); d = d.slice(s).concat(d.slice(0, s)); out.push(permute(c.concat(d), PC2)); }
  return out;
}
function desBlock(block8, subkeys) { // subkeys in the order they are applied
  const b = permute(toBits(block8), IP);
  let l = b.slice(0, 32), r = b.slice(32);
  for (const k of subkeys) {
    const e = permute(r, E).map((x, i) => x ^ k[i]);
    const s = [];
    for (let i = 0; i < 8; i++) { const c = e.slice(i * 6, i * 6 + 6); const row = (c[0] << 1) | c[5], col = (c[1] << 3) | (c[2] << 2) | (c[3] << 1) | c[4]; const v = SBOX[i][row * 16 + col]; s.push((v >> 3) & 1, (v >> 2) & 1, (v >> 1) & 1, v & 1); }
    const f = permute(s, P);
    [l, r] = [r, l.map((x, i) => x ^ f[i])];
  }
  return fromBits(permute(r.concat(l), FP));
}
// 3DES-EDE decryption of CBC data: D(k1) · E(k2) · D(k3) per block, from the last round key first.
export function des3CbcDecrypt(key24, iv, data) {
  if (data.length % 8) throw new Error('3DES: data is not whole blocks');
  const k1 = desSubkeys(key24.subarray(0, 8)), k2 = desSubkeys(key24.subarray(8, 16)), k3 = desSubkeys(key24.subarray(16, 24));
  const d1 = k1.slice().reverse(), d3 = k3.slice().reverse();
  const out = new Uint8Array(data.length); let prev = iv;
  for (let o = 0; o < data.length; o += 8) {
    const c = data.subarray(o, o + 8);
    const p = desBlock(desBlock(desBlock(c, d3), k2), d1);
    for (let i = 0; i < 8; i++) out[o + i] = p[i] ^ prev[i];
    prev = c;
  }
  return out;
}

// ── RC2 (RFC 2268), decryption only ──────────────────────────────────────────────────────────
const PITABLE = [217, 120, 249, 196, 25, 221, 181, 237, 40, 233, 253, 121, 74, 160, 216, 157, 198, 126, 55, 131, 43, 118, 83, 142, 98, 76, 100, 136, 68, 139, 251, 162, 23, 154, 89, 245, 135, 179, 79, 19, 97, 69, 109, 141, 9, 129, 125, 50, 189, 143, 64, 235, 134, 183, 123, 11, 240, 149, 33, 34, 92, 107, 78, 130, 84, 214, 101, 147, 206, 96, 178, 28, 115, 86, 192, 20, 167, 140, 241, 220, 18, 117, 202, 31, 59, 190, 228, 209, 66, 61, 212, 48, 163, 60, 182, 38, 111, 191, 14, 218, 70, 105, 7, 87, 39, 242, 29, 155, 188, 148, 67, 3, 248, 17, 199, 246, 144, 239, 62, 231, 6, 195, 213, 47, 200, 102, 30, 215, 8, 232, 234, 222, 128, 82, 238, 247, 132, 170, 114, 172, 53, 77, 106, 42, 150, 26, 210, 113, 90, 21, 73, 116, 75, 159, 208, 94, 4, 24, 164, 236, 194, 224, 65, 110, 15, 81, 203, 204, 36, 145, 175, 80, 161, 244, 112, 57, 153, 124, 58, 133, 35, 184, 180, 122, 252, 2, 54, 91, 37, 85, 151, 49, 45, 93, 250, 152, 227, 138, 146, 174, 5, 223, 41, 16, 103, 108, 186, 201, 211, 0, 230, 207, 225, 158, 168, 44, 99, 22, 1, 63, 88, 226, 137, 169, 13, 56, 52, 27, 171, 51, 255, 176, 187, 72, 12, 95, 185, 177, 205, 46, 197, 243, 219, 71, 229, 165, 156, 119, 10, 166, 32, 104, 254, 127, 193, 173];
function rc2Keys(key, effectiveBits) {
  const L = new Uint8Array(128); L.set(key);
  const T = key.length, T8 = Math.ceil(effectiveBits / 8), TM = 255 % (1 << (8 + effectiveBits - 8 * T8));
  for (let i = T; i < 128; i++) L[i] = PITABLE[(L[i - 1] + L[i - T]) & 0xff];
  L[128 - T8] = PITABLE[L[128 - T8] & TM];
  for (let i = 127 - T8; i >= 0; i--) L[i] = PITABLE[L[i + 1] ^ L[i + T8]];
  const K = new Uint16Array(64); for (let i = 0; i < 64; i++) K[i] = L[2 * i] | (L[2 * i + 1] << 8);
  return K;
}
function rc2DecryptBlock(K, block) {
  const R = [block[0] | (block[1] << 8), block[2] | (block[3] << 8), block[4] | (block[5] << 8), block[6] | (block[7] << 8)];
  const s = [1, 2, 3, 5];
  let j = 63;
  const rmix = () => { for (let i = 3; i >= 0; i--) { const r = R[i], ror = ((r >>> s[i]) | (r << (16 - s[i]))) & 0xffff; R[i] = (ror - K[j] - (R[(i + 3) & 3] & R[(i + 2) & 3]) - (~R[(i + 3) & 3] & R[(i + 1) & 3])) & 0xffff; j--; } };
  const rmash = () => { for (let i = 3; i >= 0; i--) R[i] = (R[i] - K[R[(i + 3) & 3] & 63]) & 0xffff; };
  for (let r = 0; r < 5; r++) rmix();
  rmash();
  for (let r = 0; r < 6; r++) rmix();
  rmash();
  for (let r = 0; r < 5; r++) rmix();
  return Uint8Array.of(R[0] & 0xff, R[0] >> 8, R[1] & 0xff, R[1] >> 8, R[2] & 0xff, R[2] >> 8, R[3] & 0xff, R[3] >> 8);
}
export function rc2CbcDecrypt(key, effectiveBits, iv, data) {
  if (data.length % 8) throw new Error('RC2: data is not whole blocks');
  const K = rc2Keys(key, effectiveBits);
  const out = new Uint8Array(data.length); let prev = iv;
  for (let o = 0; o < data.length; o += 8) {
    const c = data.subarray(o, o + 8), p = rc2DecryptBlock(K, c);
    for (let i = 0; i < 8; i++) out[o + i] = p[i] ^ prev[i];
    prev = c;
  }
  return out;
}
export function rc4(key, data) {
  const S = new Uint8Array(256); for (let i = 0; i < 256; i++) S[i] = i;
  for (let i = 0, j = 0; i < 256; i++) { j = (j + S[i] + key[i % key.length]) & 0xff; [S[i], S[j]] = [S[j], S[i]]; }
  const out = new Uint8Array(data.length);
  for (let k = 0, i = 0, j = 0; k < data.length; k++) { i = (i + 1) & 0xff; j = (j + S[i]) & 0xff; [S[i], S[j]] = [S[j], S[i]]; out[k] = data[k] ^ S[(S[i] + S[j]) & 0xff]; }
  return out;
}

// ── X.509, the little a signature needs ──────────────────────────────────────────────────────
// {issuer, serial}: the DER of the issuer Name and of the serialNumber, as SignerInfo carries them;
// {subject, notAfter}: for a self-test's report.
export function certInfo(der) {
  const cert = read(der, 0);
  const tbs = kids(der, cert)[0];
  const k = kids(der, tbs);
  const i = k[0].tag === 0xa0 ? 1 : 0;                        // [0] version, when present
  const [serial, , issuer, validity, subject] = k.slice(i);
  const cn = (nameNode) => {
    for (const rdn of kids(der, nameNode)) for (const atv of kids(der, rdn)) {
      const [oid, val] = kids(der, atv);
      if (oidOf(der, oid) === OIDS.commonName) return new TextDecoder().decode(content(der, val));
    }
    return '';
  };
  const time = (node) => { const s = new TextDecoder().decode(content(der, node)); const m = node.tag === 0x17 ? s.match(/^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?Z$/) : s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?Z$/); if (!m) return s; const y = node.tag === 0x17 ? (+m[1] < 50 ? 2000 : 1900) + +m[1] : +m[1]; return new Date(Date.UTC(y, +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0))).toISOString(); };
  return { issuer: whole(der, issuer), serial: whole(der, serial), subject: cn(subject), issuerName: cn(issuer), notAfter: time(kids(der, validity)[1]), serialHex: hex(content(der, serial)) };
}

// ── the signer ────────────────────────────────────────────────────────────────────────────────
// The credentials as the signing needs them: {key: CryptoKey, cert: DER, info, source, how}.
export async function importSigner(certDer, keyPkcs8Der) {
  const key = await crypto.subtle.importKey('pkcs8', keyPkcs8Der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  return { key, cert: certDer, info: certInfo(certDer) };
}
// CMS SignedData, detached, over `data`: what a pass carries as its "signature" file.
export async function signDetached(signer, data, extraCerts = [], now = new Date()) {
  const digestBytes = await digest('SHA-256', data);
  const attr = (oid, value) => SEQ(OID(oid), SET(value));
  const attrs = [attr(OIDS.contentType, OID(OIDS.data)), attr(OIDS.signingTime, UTCTIME(now)), attr(OIDS.messageDigest, OCTET(digestBytes))];
  const signedAttrs = SET(...attrs);                          // signed as a SET, carried as [0] IMPLICIT
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'RSASSA-PKCS1-v1_5' }, signer.key, signedAttrs));
  const signerInfo = SEQ(
    INT(1),
    SEQ(signer.info.issuer, signer.info.serial),
    SEQ(OID(OIDS.sha256), NULL),
    CTX(0, ...attrs.slice().sort(cmpBytes)),
    SEQ(OID(OIDS.rsaEncryption), NULL),
    OCTET(signature),
  );
  const certs = [signer.cert, ...extraCerts].sort(cmpBytes);
  const signedData = SEQ(INT(1), SET(SEQ(OID(OIDS.sha256), NULL)), SEQ(OID(OIDS.data)), CTX(0, ...certs), SET(signerInfo));
  return SEQ(OID(OIDS.signedData), CTX(0, signedData));
}
