# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| latest (main) | ✅ Yes |
| older branches | ❌ No |

---

## Reporting a Vulnerability

**Do NOT open a public GitHub issue for security vulnerabilities.**
Public disclosure before a fix is available puts all users at risk.

### How to Report

1. **GitHub Private Advisory** (preferred): [Report privately via GitHub](https://github.com/aaversee/lume-dev-version/security/advisories/new)
2. **Email**: Contact the maintainer directly via GitHub profile

### What to Include

- Description of the vulnerability
- Steps to reproduce or proof of concept
- Affected component (client, server, crypto, WebSocket, DB, auth)
- Potential impact and severity (Critical / High / Medium / Low)
- Suggested fix if you have one

### Response Timeline

| Stage | Timeline |
|---|---|
| Acknowledgment | Within 48 hours |
| Initial assessment | Within 5 business days |
| Fix and coordinated disclosure | Within 30 days of report |

If the issue is severe, we will push a fix faster. We will keep you updated throughout the process.

---

## Scope

### In Scope

- Authentication bypass or signature forgery (Ed25519)
- Cryptographic weaknesses (X3DH, Double Ratchet, key derivation, key storage)
- SQL injection, XSS, path traversal
- Unauthorized access to messages, files, or user data
- WebSocket authentication or authorization bypass
- Private key or plaintext message exposure on server
- Denial of service vulnerabilities with meaningful impact
- Timing attacks on sensitive comparisons
- Replay attack vulnerabilities
- CSRF or origin bypass vulnerabilities

### Out of Scope

- Attacks requiring physical access to a user's device
- Social engineering
- Vulnerabilities in third-party dependencies (report upstream, but notify us too)
- Rate limiting bypass that doesn't lead to meaningful impact
- Issues in forks or unofficial deployments

---

## Security Architecture

LUME is designed so that a compromised server cannot compromise user privacy.

### Core Properties

| Property | Implementation |
|---|---|
| Server is a blind relay | Server never sees plaintext — only encrypted blobs |
| No passwords | Ed25519 signature-based auth |
| Forward secrecy | X3DH + Double Ratchet — new key per message |
| Client-side encryption | All crypto runs in the browser via TweetNaCl |
| Keys encrypted at rest | IndexedDB + PBKDF2-derived master key (600K iterations) |
| Anonymity | No phone, no email — username only, or fully anonymous via rotating invite links |
| Panic Wipe | One action destroys all local data and server account |

### Threat Model

**LUME protects against:**
- Mass surveillance (ISPs, government bulk collection)
- Server breach — attacker gets only encrypted blobs
- Network interception — E2E encryption with forward secrecy
- Metadata collection — minimal server-side data retention

**LUME does NOT protect against:**
- Compromised client device (malware, physical access)
- Compromised browser or OS
- Endpoint attacks (keyloggers, screen capture)
- Targeted attacks on the user's device

### Key Security Decisions

**No server-side message storage after delivery:**
Messages are deleted from the server as soon as delivered. Undelivered messages are retained up to 30 days with a hard per-user cap.

**No phone number or email required:**
Registration requires only a username. The server stores public keys, encrypted blobs, and minimal auth data — nothing that identifies the real person.

**Constant-time comparisons:**
All sensitive comparisons (signatures, tokens, hashes) use `crypto.timingSafeEqual()` to prevent timing attacks.

**Replay protection:**
Every signed request includes a nonce. The server caches used nonces for their validity window (60 seconds) to prevent replay of intercepted valid requests.

---

## Responsible Disclosure

We follow coordinated disclosure:

1. Reporter submits vulnerability privately
2. We acknowledge within 48 hours
3. We develop and test a fix
4. We coordinate a disclosure timeline with the reporter
5. Fix is released
6. Public disclosure after fix is available (typically same day as release)

We will credit reporters in the release notes and Hall of Fame below, with their permission.

---

## Hall of Fame

Security researchers who have responsibly disclosed vulnerabilities will be listed here with their consent.

*No entries yet — be the first.*

---

## Bug Bounty

There is no paid bug bounty program at this time. However, significant findings will be publicly credited in release notes and this document.

If this changes, it will be announced here.

---

## Security Checklist for Contributors

Before submitting a PR that touches security-sensitive code:

- [ ] No plaintext message content logged or stored on server
- [ ] All external input validated with Zod before use
- [ ] No string concatenation in SQL queries
- [ ] Sensitive comparisons use `crypto.timingSafeEqual()`
- [ ] Key material zeroed after use (`buf.fill(0)`)
- [ ] No private keys or secrets in `localStorage` / `sessionStorage`
- [ ] No new API endpoints without rate limiting
- [ ] No `eval()`, `Function()`, or dynamic code execution
- [ ] New crypto changes maintain forward secrecy and backward compatibility

For implementation details, see `CLAUDE.md`.
