import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';
import multer from 'multer';
import sanitizeHtml from 'sanitize-html';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, 'data');
const ACCOUNTS = path.join(DATA, 'accounts.json');
fs.mkdirSync(DATA, { recursive: true });
try { fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n').forEach(l => { const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim(); }); } catch {}
const PORT = process.env.PORT || 3300;
const APP_PASSWORD = process.env.APP_PASSWORD || '';

const app = express();
app.use(express.json({ limit: '2mb' }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

/* ---------- optional password gate ---------- */
app.use((req, res, next) => {
  if (!APP_PASSWORD || !req.path.startsWith('/api')) return next();
  if (req.headers['x-app-password'] === APP_PASSWORD) return next();
  res.status(401).json({ error: 'Password required' });
});
app.use(express.static(path.join(__dirname, 'public')));

/* ---------- accounts ---------- */
const loadAccounts = () => (fs.existsSync(ACCOUNTS) ? JSON.parse(fs.readFileSync(ACCOUNTS, 'utf8')) : []);
const saveAccounts = a => fs.writeFileSync(ACCOUNTS, JSON.stringify(a, null, 2));
const pub = a => ({ id: a.id, name: a.name, email: a.email, imapHost: a.imapHost, smtpHost: a.smtpHost, signature: a.signature || '' });
const PRESETS = {
  'gmail.com': { imapHost: 'imap.gmail.com', imapPort: 993, smtpHost: 'smtp.gmail.com', smtpPort: 465 },
  'googlemail.com': { imapHost: 'imap.gmail.com', imapPort: 993, smtpHost: 'smtp.gmail.com', smtpPort: 465 },
  'outlook.com': { imapHost: 'outlook.office365.com', imapPort: 993, smtpHost: 'smtp.office365.com', smtpPort: 587 },
  'hotmail.com': { imapHost: 'outlook.office365.com', imapPort: 993, smtpHost: 'smtp.office365.com', smtpPort: 587 },
  'live.com': { imapHost: 'outlook.office365.com', imapPort: 993, smtpHost: 'smtp.office365.com', smtpPort: 587 },
  'yahoo.com': { imapHost: 'imap.mail.yahoo.com', imapPort: 993, smtpHost: 'smtp.mail.yahoo.com', smtpPort: 465 },
  'icloud.com': { imapHost: 'imap.mail.me.com', imapPort: 993, smtpHost: 'smtp.mail.me.com', smtpPort: 587 },
  'walla.co.il': { imapHost: 'imap.walla.co.il', imapPort: 993, smtpHost: 'smtp.walla.co.il', smtpPort: 465 },
  'zoho.com': { imapHost: 'imap.zoho.com', imapPort: 993, smtpHost: 'smtp.zoho.com', smtpPort: 465 },
};
app.get('/api/presets', (req, res) => res.json(PRESETS));
app.get('/api/accounts', (req, res) => res.json(loadAccounts().map(pub)));
app.post('/api/accounts', async (req, res) => {
  const b = req.body || {};
  if (!b.email || !b.password) return res.status(400).json({ error: 'Email and password are required' });
  const domain = b.email.split('@')[1]?.toLowerCase();
  const preset = PRESETS[domain] || {};
  const acc = {
    id: b.id || Math.random().toString(36).slice(2, 10),
    name: b.name || b.email, email: b.email, user: b.user || b.email, password: b.password,
    imapHost: b.imapHost || preset.imapHost, imapPort: +(b.imapPort || preset.imapPort || 993),
    smtpHost: b.smtpHost || preset.smtpHost, smtpPort: +(b.smtpPort || preset.smtpPort || 465),
    signature: b.signature || '',
  };
  if (!acc.imapHost || !acc.smtpHost) return res.status(400).json({ error: 'Unknown provider — fill in IMAP and SMTP host' });
  try { const c = await connect(acc); await c.logout(); }
  catch (e) { return res.status(400).json({ error: 'IMAP login failed: ' + (e.responseText || e.message) }); }
  const all = loadAccounts().filter(a => a.id !== acc.id);
  all.push(acc); saveAccounts(all); clients.delete(acc.id);
  res.json(pub(acc));
});
app.delete('/api/accounts/:id', (req, res) => { saveAccounts(loadAccounts().filter(a => a.id !== req.params.id)); clients.delete(req.params.id); res.json({ ok: true }); });

/* ---------- IMAP connection pool ---------- */
const clients = new Map();
async function connect(acc) {
  const c = new ImapFlow({ host: acc.imapHost, port: acc.imapPort, secure: acc.imapPort === 993, auth: { user: acc.user, pass: acc.password }, logger: false, emitLogs: false });
  await c.connect();
  return c;
}
async function client(id) {
  const acc = loadAccounts().find(a => a.id === id);
  if (!acc) throw new Error('Account not found');
  let c = clients.get(id);
  if (c && c.usable) return { c, acc };
  c = await connect(acc);
  c.on('error', () => clients.delete(id));
  c.on('close', () => clients.delete(id));
  clients.set(id, c);
  return { c, acc };
}
const withLock = async (id, mailbox, fn) => {
  const { c, acc } = await client(id);
  const lock = await c.getMailboxLock(mailbox);
  try { return await fn(c, acc); } finally { lock.release(); }
};
const wrap = fn => async (req, res) => { try { await fn(req, res); } catch (e) { console.error(e); res.status(500).json({ error: e.responseText || e.message || String(e) }); } };

/* ---------- folders ---------- */
const SPECIAL = { INBOX: 'inbox', '\\Sent': 'sent', '\\Drafts': 'drafts', '\\Trash': 'trash', '\\Junk': 'spam', '\\Archive': 'archive', '\\Flagged': 'starred', '\\All': 'all' };
app.get('/api/:acc/folders', wrap(async (req, res) => {
  const { c } = await client(req.params.acc);
  const list = await c.list({ statusQuery: { unseen: true, messages: true } });
  res.json(list.map(f => ({ path: f.path, name: f.name, special: f.path === 'INBOX' ? 'inbox' : SPECIAL[f.specialUse] || null, unseen: f.status?.unseen ?? 0, total: f.status?.messages ?? 0, delimiter: f.delimiter })));
}));
app.post('/api/:acc/folders', wrap(async (req, res) => { const { c } = await client(req.params.acc); await c.mailboxCreate(req.body.path); res.json({ ok: true }); }));
app.delete('/api/:acc/folders/:path', wrap(async (req, res) => { const { c } = await client(req.params.acc); await c.mailboxDelete(decodeURIComponent(req.params.path)); res.json({ ok: true }); }));

/* ---------- message list ---------- */
const addr = a => (a?.value || a || []).map(x => ({ name: x.name || '', address: x.address || '' }));
app.get('/api/:acc/messages', wrap(async (req, res) => {
  const mailbox = req.query.folder || 'INBOX';
  const page = +(req.query.page || 0), size = Math.min(100, +(req.query.size || 50));
  const q = req.query.q || '';
  const out = await withLock(req.params.acc, mailbox, async c => {
    let uids;
    if (q) {
      const or = ['subject', 'from', 'to', 'body'].map(k => ({ [k]: q }));
      const search = q.startsWith('from:') ? { from: q.slice(5) } : q.startsWith('to:') ? { to: q.slice(3) } : q.startsWith('subject:') ? { subject: q.slice(8) } : q === 'is:unread' ? { seen: false } : q === 'is:starred' ? { flagged: true } : q === 'has:attachment' ? { header: { 'content-type': 'multipart/mixed' } } : { or: [or[0], { or: [or[1], { or: [or[2], or[3]] }] }] };
      uids = await c.search(search, { uid: true });
    } else uids = await c.search({ all: true }, { uid: true });
    uids = (uids || []).sort((a, b) => b - a);
    const total = uids.length;
    const slice = uids.slice(page * size, page * size + size);
    if (!slice.length) return { total, messages: [] };
    const messages = [];
    for await (const m of c.fetch(slice, { uid: true, envelope: true, flags: true, bodyStructure: true, size: true, internalDate: true }, { uid: true })) {
      messages.push({
        uid: m.uid, subject: m.envelope.subject || '(no subject)', from: addr(m.envelope.from), to: addr(m.envelope.to), date: m.envelope.date || m.internalDate,
        seen: m.flags.has('\\Seen'), flagged: m.flags.has('\\Flagged'), answered: m.flags.has('\\Answered'), size: m.size,
        hasAttachment: hasAttachment(m.bodyStructure), messageId: m.envelope.messageId,
      });
    }
    messages.sort((a, b) => b.uid - a.uid);
    return { total, messages };
  });
  res.json(out);
}));
function hasAttachment(bs) { if (!bs) return false; if (bs.disposition === 'attachment') return true; return (bs.childNodes || []).some(hasAttachment); }

/* ---------- single message ---------- */
app.get('/api/:acc/messages/:uid', wrap(async (req, res) => {
  const mailbox = req.query.folder || 'INBOX';
  const out = await withLock(req.params.acc, mailbox, async c => {
    const dl = await c.download(req.params.uid, undefined, { uid: true });
    const parsed = await simpleParser(dl.content);
    if (req.query.markRead !== '0') await c.messageFlagsAdd(req.params.uid, ['\\Seen'], { uid: true });
    const cidMap = {};
    const attachments = (parsed.attachments || []).map((a, i) => { if (a.cid) cidMap[a.cid] = `data:${a.contentType};base64,${a.content.toString('base64')}`; return { index: i, filename: a.filename || 'attachment', contentType: a.contentType, size: a.size, cid: a.cid || null, inline: a.contentDisposition === 'inline' && !!a.cid }; });
    let html = parsed.html || (parsed.textAsHtml || '');
    html = sanitizeHtml(html, {
      allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img', 'style', 'center', 'font', 'u', 'span', 'html', 'body', 'head', 'title']),
      allowedAttributes: { '*': ['style', 'class', 'align', 'valign', 'width', 'height', 'bgcolor', 'color', 'dir', 'border', 'cellpadding', 'cellspacing', 'colspan', 'rowspan'], a: ['href', 'name', 'target'], img: ['src', 'alt', 'width', 'height'] },
      allowedSchemes: ['http', 'https', 'mailto', 'data', 'cid'],
      transformTags: { a: (tag, attribs) => ({ tagName: 'a', attribs: { ...attribs, target: '_blank', rel: 'noopener' } }), img: (tag, attribs) => { if (attribs.src?.startsWith('cid:')) { const d = cidMap[attribs.src.slice(4)]; if (d) attribs.src = d; } return { tagName: 'img', attribs }; } },
    });
    return {
      uid: +req.params.uid, subject: parsed.subject || '(no subject)', from: addr(parsed.from), to: addr(parsed.to), cc: addr(parsed.cc), replyTo: addr(parsed.replyTo), date: parsed.date, messageId: parsed.messageId, inReplyTo: parsed.inReplyTo, references: parsed.references,
      html, text: parsed.text || '', attachments: attachments.filter(a => !a.inline), headers: Object.fromEntries([...parsed.headers].filter(([k]) => ['list-unsubscribe', 'x-priority', 'importance'].includes(k)).map(([k, v]) => [k, String(v?.text || v)])),
    };
  });
  res.json(out);
}));
app.get('/api/:acc/messages/:uid/attachments/:idx', wrap(async (req, res) => {
  const mailbox = req.query.folder || 'INBOX';
  await withLock(req.params.acc, mailbox, async c => {
    const dl = await c.download(req.params.uid, undefined, { uid: true });
    const parsed = await simpleParser(dl.content);
    const a = parsed.attachments[+req.params.idx];
    if (!a) return res.status(404).end();
    res.setHeader('Content-Type', a.contentType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `${req.query.inline ? 'inline' : 'attachment'}; filename="${encodeURIComponent(a.filename || 'attachment')}"`);
    res.send(a.content);
  });
}));
app.get('/api/:acc/messages/:uid/raw', wrap(async (req, res) => {
  const mailbox = req.query.folder || 'INBOX';
  await withLock(req.params.acc, mailbox, async c => { const dl = await c.download(req.params.uid, undefined, { uid: true }); res.setHeader('Content-Type', 'message/rfc822'); res.setHeader('Content-Disposition', `attachment; filename="message-${req.params.uid}.eml"`); dl.content.pipe(res); });
}));

/* ---------- actions: flags, move, delete ---------- */
app.post('/api/:acc/action', wrap(async (req, res) => {
  const { folder = 'INBOX', uids, action, target } = req.body;
  const { c } = await client(req.params.acc);
  const list = await c.list();
  const special = s => list.find(f => f.specialUse === s)?.path;
  const result = await withLock(req.params.acc, folder, async c => {
    const range = uids.join(',');
    switch (action) {
      case 'read': return c.messageFlagsAdd(range, ['\\Seen'], { uid: true });
      case 'unread': return c.messageFlagsRemove(range, ['\\Seen'], { uid: true });
      case 'star': return c.messageFlagsAdd(range, ['\\Flagged'], { uid: true });
      case 'unstar': return c.messageFlagsRemove(range, ['\\Flagged'], { uid: true });
      case 'move': return c.messageMove(range, target, { uid: true });
      case 'archive': { const t = special('\\Archive') || special('\\All') || 'Archive'; if (!list.find(f => f.path === t)) await c.mailboxCreate(t); return c.messageMove(range, t, { uid: true }); }
      case 'spam': { const t = special('\\Junk') || 'Junk'; if (!list.find(f => f.path === t)) await c.mailboxCreate(t); return c.messageMove(range, t, { uid: true }); }
      case 'trash': { const t = special('\\Trash') || 'Trash'; if (folder === t) return c.messageDelete(range, { uid: true }); if (!list.find(f => f.path === t)) await c.mailboxCreate(t); return c.messageMove(range, t, { uid: true }); }
      case 'delete': return c.messageDelete(range, { uid: true });
      default: throw new Error('Unknown action');
    }
  });
  res.json({ ok: true, result });
}));

/* ---------- send ---------- */
app.post('/api/:acc/send', upload.array('attachments'), wrap(async (req, res) => {
  const acc = loadAccounts().find(a => a.id === req.params.acc);
  if (!acc) return res.status(404).json({ error: 'Account not found' });
  const b = req.body;
  const transport = nodemailer.createTransport({ host: acc.smtpHost, port: acc.smtpPort, secure: acc.smtpPort === 465, auth: { user: acc.user, pass: acc.password } });
  const mail = {
    from: { name: acc.name, address: acc.email }, to: b.to, cc: b.cc || undefined, bcc: b.bcc || undefined, subject: b.subject || '',
    html: b.html || '', text: b.text || undefined, inReplyTo: b.inReplyTo || undefined, references: b.references || undefined,
    attachments: (req.files || []).map(f => ({ filename: f.originalname, content: f.buffer, contentType: f.mimetype })),
  };
  if (b.forwardUid && b.forwardFolder) {
    await withLock(req.params.acc, b.forwardFolder, async c => { const dl = await c.download(b.forwardUid, undefined, { uid: true }); const p = await simpleParser(dl.content); (p.attachments || []).forEach(a => mail.attachments.push({ filename: a.filename, content: a.content, contentType: a.contentType })); });
  }
  const info = await transport.sendMail(mail);
  // append to Sent (Gmail does this automatically; other servers don't)
  try {
    const { c } = await client(req.params.acc);
    const list = await c.list();
    const sent = list.find(f => f.specialUse === '\\Sent');
    if (sent && !/gmail|googlemail/i.test(acc.imapHost)) { const raw = await nodemailer.createTransport({ streamTransport: true, buffer: true }).sendMail(mail); await c.append(sent.path, raw.message, ['\\Seen']); }
    if (b.inReplyToUid && b.inReplyToFolder) await withLock(req.params.acc, b.inReplyToFolder, c => c.messageFlagsAdd(b.inReplyToUid, ['\\Answered'], { uid: true }));
  } catch (e) { console.warn('post-send bookkeeping failed:', e.message); }
  res.json({ ok: true, messageId: info.messageId });
}));

/* ---------- drafts (stored server-side, per account) ---------- */
const draftsFile = id => path.join(DATA, `drafts-${id}.json`);
app.get('/api/:acc/drafts', (req, res) => res.json(fs.existsSync(draftsFile(req.params.acc)) ? JSON.parse(fs.readFileSync(draftsFile(req.params.acc), 'utf8')) : []));
app.put('/api/:acc/drafts', (req, res) => { fs.writeFileSync(draftsFile(req.params.acc), JSON.stringify(req.body || [])); res.json({ ok: true }); });

/* ---------- contacts (harvested from Sent + Inbox) ---------- */
app.get('/api/:acc/contacts', wrap(async (req, res) => {
  const { c } = await client(req.params.acc);
  const list = await c.list();
  const seen = new Map();
  for (const f of list.filter(f => f.path === 'INBOX' || f.specialUse === '\\Sent')) {
    await withLock(req.params.acc, f.path, async c => {
      const uids = (await c.search({ all: true }, { uid: true })) || [];
      const recent = uids.sort((a, b) => b - a).slice(0, 300);
      if (!recent.length) return;
      for await (const m of c.fetch(recent, { uid: true, envelope: true }, { uid: true })) {
        [...(m.envelope.from || []), ...(m.envelope.to || []), ...(m.envelope.cc || [])].forEach(a => { if (a.address && !seen.has(a.address.toLowerCase())) seen.set(a.address.toLowerCase(), { name: a.name || '', address: a.address }); });
      }
    });
  }
  res.json([...seen.values()].sort((a, b) => (a.name || a.address).localeCompare(b.name || b.address)));
}));

app.get('/api/health', (req, res) => res.json({ ok: true, accounts: loadAccounts().length, protected: !!APP_PASSWORD }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(PORT, () => console.log(`Mail is running at http://localhost:${PORT}`));
