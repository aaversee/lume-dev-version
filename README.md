<p align="center">
  <br>
  <strong>Your messages. Your keys. Your rules.</strong>
  <br>
  <sub>End-to-end encrypted anonymous messenger. The server is a blind relay — zero plaintext, zero metadata, zero trust.</sub>
  <br><br>
  <a href="LICENSE"><img src="https://img.shields.io/badge/AGPL--3.0-000?style=for-the-badge" alt="License"></a>&nbsp;
  <a href="docs/PROTOCOL.md"><img src="https://img.shields.io/badge/PROTOCOL-000?style=for-the-badge" alt="Protocol"></a>&nbsp;
  <a href="CONTRIBUTING.md"><img src="https://img.shields.io/badge/CONTRIBUTE-000?style=for-the-badge" alt="Contribute"></a>&nbsp;
  <a href="SECURITY.md"><img src="https://img.shields.io/badge/SECURITY-000?style=for-the-badge" alt="Security"></a>
</p>

<br>

<p align="center">
  <code>No phone number  ·  No email  ·  No password  ·  No metadata  ·  No trust required</code>
</p>

<br>

> **The server never sees your messages.**
> It stores encrypted blobs and forwards them. No plaintext. No decryption keys. No logs.

<br>

<details>
<summary><strong>Features</strong></summary>
<br>

```
E2E encryption       Messages are encrypted on your device — the server cannot read them
Forward secrecy       Compromise of one key doesn't expose past messages
Anonymous identity    No phone number, no email, no password
Self-destruct         Messages auto-delete after a set time
Panic wipe            Erase all local data in one tap
Hidden chats          Separate PIN to access private conversations
File sharing          Attachments up to 5 MB, end-to-end encrypted
Group chats           Create groups, assign roles and manage members
Seed phrase           Recover your identity on any device
Offline delivery      Messages queue for up to 30 days
```

</details>

<details>
<summary><strong>Stack</strong></summary>
<br>

```
Client     Next.js 16  ·  React 19  ·  Tailwind  ·  Zustand  ·  TweetNaCl
Server     Express  ·  WebSocket  ·  SQLite
Infra      Vercel  ·  Render  ·  GitHub Actions  ·  Docker
```

</details>

<details>
<summary><strong>Quick start</strong></summary>
<br>

```bash
git clone https://github.com/aaversee/lume-dev-version.git && cd lume-dev-version

# server
cd server && cp .env.example .env && npm i && npm run dev

# client (new terminal)
cd client && cp .env.local.example .env.local && npm i && npm run dev
```

**Docker:**

```bash
WS_JWT_SECRET=$(openssl rand -hex 32) docker compose up --build
```

</details>

<br>

<p align="center">
  <sub>Built with cryptography, not trust.</sub>
</p>
