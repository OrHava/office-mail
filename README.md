# Mail

A Gmail-style webmail client for **any mailbox** (Gmail, Outlook/Hotmail, Yahoo, iCloud, Walla, Zoho, or your own IMAP server). It reads mail over IMAP and sends over SMTP, so your email keeps living on your provider — this is the client, replacing the Gmail web interface.

Runs on Windows, Linux and macOS (needs Node.js 18+). The UI works in any browser, including your phone on the same network.

## Quick start

```bash
git clone https://github.com/OrHava/office-mail.git
cd office-mail
npm install
npm start
```

Open http://localhost:3300, click **+ Account**, enter your email and an **app password**:

- **Gmail:** enable 2-step verification → Google Account → Security → *App passwords* → create one for "Mail". Make sure IMAP is enabled in Gmail settings.
- **Outlook / Hotmail:** account.microsoft.com → Security → Advanced security options → *App passwords*.
- **Yahoo:** Account security → *Generate app password*.

Hosts and ports are auto-detected for common providers; anything else goes under *Advanced*.

## Features
- Inbox, Starred, Sent, Drafts, Archive, Spam, Trash and all your custom folders with unread counts; create/delete folders
- Message list with paging, multi-select, star, mark read/unread, archive, spam, delete, move to folder — with optimistic UI and Undo
- Search with Gmail-style operators: `from:`, `to:`, `subject:`, `is:unread`, `is:starred`, `has:attachment`
- Safe HTML rendering (sanitized, sandboxed iframe, inline images), attachment download, unsubscribe link, print, download `.eml`
- Compose with rich text (bold/italic/lists/links/RTL), To/Cc/Bcc with contact autocomplete (harvested from your mail), attachments (pick, drag-drop, paste images), signature
- Reply, Reply all, Forward (with original attachments), proper threading headers
- Drafts auto-saved every 30 s, multiple accounts, dark mode, mobile layout
- Keyboard shortcuts: `C` compose, `R` refresh, `E` archive, `#` delete, `S` star, `U` unread, `J`/`K` next/prev, `A` reply all, `F` forward, `/` search, `Ctrl+Enter` send, `Esc` close
- New-mail desktop notifications (polls every minute)
- **AI assistant** (your own Anthropic/OpenAI key): summarize, draft a reply, 3 quick replies, extract action items, fix/professionalize your draft, translate
- Conversation threading, snooze, scheduled send, undo send (8 s), templates, filters/rules, vacation auto-reply, unified inbox across accounts, swipe left/right on mobile (archive / snooze)

## Run it somewhere permanent
- **Always on at home:** `npm install -g pm2 && pm2 start server.js --name mail && pm2 save`
- **From anywhere:** put it behind a password by setting `APP_PASSWORD=...` in a `.env` file (`PORT` is also supported) and expose it with Tailscale, Cloudflare Tunnel or a VPS (Render, Fly.io, Railway all work with `npm start`).

Credentials are stored on your own machine in `data/accounts.json` (git-ignored). Never commit that folder.

## Why not a true Gmail replacement?
Receiving email on your own domain needs a mail server with public MX/SPF/DKIM/DMARC records and a reputation that big providers trust. That's infrastructure, not a web app. This project gives you the Gmail *experience* on top of any mailbox you already have.

Part of the office suite: [office-writer](https://github.com/OrHava/office-writer) · [office-slides](https://github.com/OrHava/office-slides) · [office-sheets](https://github.com/OrHava/office-sheets) · [office-mail](https://github.com/OrHava/office-mail)
