A throwaway signing identity for tests/pages-functions.spec.ts, made with OpenSSL on 2026-09-27 and
of no use anywhere else: a self-signed "Test Root CA" (test-ca.der, standing in for Apple's WWDR
certificate), a "Pass Type ID: pass.test.wallet" certificate under it, its key, and the two of them
as a .p12 in the encoding Keychain Access exports (3DES key, RC2-40 certificates, SHA-1 MAC), which
is what the pass signer must open in production. Password: secret123.
