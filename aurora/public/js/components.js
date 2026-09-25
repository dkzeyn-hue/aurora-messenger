/* ============================================================
   Aurora shared UI components
   ============================================================ */
import { el, $, icon, toast, toastErr, escapeHtml, linkify, fmtBytes, fmtDuration, fmtTime, mediaUrl, mediaUrlSync, uploadFile, POST, GET, State, debounce, avatarEl } from './utils.js';

/* ---------- modal ---------- */
export function modal({ title, text, actions = [], dismissable = true, onMount }) {
  const root = $('#modal-root');
  const close = () => { bd.classList.add('fade-out'); setTimeout(() => bd.remove(), 180); };
  const bd = el('div', { class: 'modal-backdrop' });
  const m = el('div', { class: 'modal' });
  if (title) m.append(el('h3', {}, title));
  if (text) m.append(el('div', { class: 'm-text' }, text));
  const row = el('div', { class: 'modal-actions' });
  for (const a of actions) {
    row.append(el('button', {
      class: `btn ${a.cls || 'btn-ghost'}`,
      onclick: async (e) => {
        if (a.keepOpen) { await a.onClick?.(close, e); return; }
        const r = await a.onClick?.(close, e);
        if (r !== false) close();
      },
    }, a.label));
  }
  m.append(row);
  bd.append(m);
  if (dismissable) bd.addEventListener('click', (e) => { if (e.target === bd) close(); });
  root.append(bd);
  onMount?.(m, close);
  return { close, root: bd };
}

export function confirmModal(title, text, okLabel = 'Confirm', danger = true) {
  return new Promise((resolve) => {
    modal({
      title, text,
      actions: [
        { label: 'Cancel', onClick: () => resolve(false) },
        { label: okLabel, cls: danger ? 'btn-danger' : 'btn-primary', onClick: () => resolve(true) },
      ],
    });
  });
}

export function promptModal({ title, text, placeholder = '', value = '', type = 'text', okLabel = 'Save', validate }) {
  return new Promise((resolve) => {
    let input;
    const { close } = modal({
      title, text,
      actions: [
        { label: 'Cancel', onClick: () => resolve(null) },
        {
          label: okLabel, cls: 'btn-primary', keepOpen: true,
          onClick: async (closeFn) => {
            const v = input.value.trim();
            if (validate) { const err = validate(v); if (err) { toast(err, 'err'); return; } }
            resolve(v); closeFn();
          },
        },
      ],
      onMount: (m) => {
        input = el('input', { class: 'input', type, placeholder, value });
        input.style.cssText = 'width:100%;padding:12px 14px;border-radius:13px;border:1.5px solid var(--line);background:var(--bg-3);outline:none;color:var(--text);margin-top:6px';
        m.insertBefore(input, m.lastChild);
        setTimeout(() => input.focus(), 60);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') m.lastChild.lastChild.click(); });
      },
    });
  });
}

/* ---------- bottom sheet ---------- */
export function sheet({ title, body, onClose }) {
  const root = $('#modal-root');
  const close = () => { bd.classList.add('fade-out'); setTimeout(() => bd.remove(), 200); onClose?.(); };
  const bd = el('div', { class: 'sheet-backdrop' });
  const s = el('div', { class: 'sheet' });
  s.append(el('div', { class: 'sheet-grab' }));
  s.append(el('div', { class: 'sheet-head' }, el('h3', {}, title), el('button', { class: 'icon-btn', onclick: close }, icon('close'))));
  const sbody = el('div', { class: 'sheet-body' });
  if (typeof body === 'function') sbody.append(body(close)); else sbody.append(body);
  s.append(sbody);
  bd.append(s);
  bd.addEventListener('click', (e) => { if (e.target === bd) close(); });
  root.append(bd);
  return { close, body: sbody, root: bd };
}

/* ---------- global Escape closes topmost overlay ---------- */
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const menus = document.querySelectorAll('.ctx-menu');
  if (menus.length) { menus[menus.length - 1].remove(); return; }
  const overlays = document.querySelectorAll('.sheet-backdrop, .modal-backdrop, .story-viewer, .mv-backdrop');
  if (overlays.length) overlays[overlays.length - 1].remove();
});

/* ---------- context menu ---------- */
export function contextMenu(x, y, items) {
  const existing = $('.ctx-menu'); if (existing) existing.remove();
  const close = () => m.remove();
  const m = el('div', { class: 'ctx-menu' });
  for (const item of items) {
    if (!item) continue;
    if (item.sep) { m.append(el('div', { class: 'ctx-sep' })); continue; }
    m.append(el('button', {
      class: 'ctx-item' + (item.danger ? ' danger' : ''),
      onclick: () => { close(); item.onClick?.(); },
    }, icon(item.icon || 'info', 19), el('span', {}, item.label)));
  }
  document.body.append(m);
  const rect = m.getBoundingClientRect();
  m.style.left = Math.max(8, Math.min(x, innerWidth - rect.width - 8)) + 'px';
  m.style.top = Math.max(8, Math.min(y, innerHeight - rect.height - 8)) + 'px';
  setTimeout(() => {
    document.addEventListener('click', function h(e) { if (!m.contains(e.target)) { close(); document.removeEventListener('click', h); } });
  }, 10);
  return close;
}

/* ---------- emoji picker ---------- */
const EMOJI_SETS = [
  ['😀', '😃', '😄', '😁', '😆', '😅', '😂', '🤣', '😊', '😇', '🙂', '😉', '😍', '🥰', '😘', '😗', '😋', '😜', '🤪', '🤨', '🧐', '🤓', '😎', '🥳', '😏', '😒', '😞', '😔', '😟', '😕', '🙁', '😣', '😖', '😫', '😩', '🥺', '😢', '😭', '😤', '😠', '😡', '🤬', '🤯', '😳', '🥵', '🥶', '😱', '😨', '😰', '😥', '🤗', '🤔', '🤭', '🤫', '🤥', '😶', '😐', '😑', '😬', '🙄', '😯', '😴', '🤤', '😪', '😵', '🤐', '🥴', '🤢', '🤮', '🤧', '😷', '🤒', '🤕'],
  ['👍', '👎', '👌', '🤌', '✌️', '🤞', '🤟', '🤘', '👏', '🙌', '🤝', '🙏', '💪', '🦾', '✍️', '💅', '🤳', '👋', '🤚', '🖐️', '✋', '🖖', '👀', '👁️', '🧠', '🫀', '💅', '👂', '👃', '👅', '👄', '💋', '🩸', '💯', '💢', '💥', '💫', '💦', '💨', '🕳️'],
  ['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔', '❣️', '💕', '💞', '💓', '💗', '💖', '💘', '💝', '💟', '☮️', '✨', '🌟', '⭐', '💫', '⚡', '🔥', '💥', '☄️', '🌈', '☀️', '🌙', '⛅', '❄️', '💧', '🌊', '🎉', '🎊', '🎈', '🎁', '🏆', '🥇', '⚽'],
  ['🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼', '🐨', '🐯', '🦁', '🐮', '🐷', '🐸', '🐵', '🐔', '🐧', '🐦', '🐤', '🦆', '🦉', '🦇', '🐺', '🐗', '🐴', '🦄', '🐝', '🐛', '🦋', '🐌', '🐞', '🐜', '🦂', '🐢', '🐍', '🐙', '🦑', '🦐', '🦀', '🐬', '🐳', '🐋', '🦈'],
  ['🍎', '🍐', '🍊', '🍋', '🍌', '🍉', '🍇', '🍓', '🫐', '🍒', '🍑', '🥭', '🍍', '🥥', '🥝', '🍅', '🥑', '🥦', '🌽', '🥕', '🧄', '🧅', '🥔', '🍠', '🥐', '🍞', '🥖', '🧀', '🥚', '🍳', '🥞', '🧇', '🥓', '🍗', '🍖', '🌮', '🍕', '🍔', '🍟', '🍜', '🍣', '🍩', '🍪', '🎂', '🍰', '🍫', '🍬', '☕', '🍵', '🧃', '🍺'],
];
const STICKERS = ['🌈', '✨', '💫', '🌟', '⚡', '🔥', '💜', '🌌', '🚀', '🛸', '🌙', '☀️', '🦄', '🐳', '🦋', '🌸', '🍀', '🎉', '🎊', '💎', '🏆', '👑', '🎯', '🧩', '🎧', '🎮', '🗺️', '🧭', '🔭', '🪐', '❤️‍🔥', '💯'];
const EMOJI_TABS = ['😀', '👍', '❤️', '🐶', '🍎'];

export function emojiSheet(onPick, onSticker) {
  sheet({
    title: 'Emoji & Stickers',
    body: (close) => {
      const wrap = el('div');
      const tabs = el('div', { class: 'emoji-tabs' });
      const grid = el('div', { class: 'emoji-grid' });
      const renderSet = (i) => {
        grid.innerHTML = '';
        for (const e of EMOJI_SETS[i]) grid.append(el('button', { onclick: () => { onPick(e); } }, e));
      };
      EMOJI_TABS.forEach((t, i) => tabs.append(el('button', { class: i === 0 ? 'active' : '', onclick: (e) => { $$('.emoji-tabs button', wrap).forEach(b => b.classList.remove('active')); e.currentTarget.classList.add('active'); renderSet(i); } }, t)));
      wrap.append(tabs, grid);
      if (onSticker) {
        wrap.append(el('div', { class: 'section-label' }, 'Stickers'));
        const sg = el('div', { class: 'sticker-grid' });
        for (const s of STICKERS) sg.append(el('button', { class: 'stk', onclick: () => { close(); onSticker(s); } }, s));
        wrap.append(sg);
      }
      renderSet(0);
      return wrap;
    },
  });
}

/* ---------- audio player (voice messages) ---------- */
export function voicePlayer(message, isOut) {
  const url = message.attachment.url;
  const wave = message.attachment.waveform && message.attachment.waveform.length
    ? message.attachment.waveform : Array.from({ length: 34 }, (_, i) => 0.25 + 0.65 * Math.abs(Math.sin(i * 1.7)));
  const wrap = el('div', { class: 'voice-b' });
  const playBtn = el('button', { class: 'vplay' });
  const waveEl = el('div', { class: 'vwave' });
  const bars = wave.slice(0, 40).map((v) => {
    const b = el('i', { style: `height:${Math.max(12, v * 100)}%` });
    waveEl.append(b); return b;
  });
  const timeEl = el('span', { class: 'vtime' }, fmtDuration(message.attachment.duration || 0));
  wrap.append(playBtn, waveEl, timeEl);
  let audio = null; let playing = false; let playedFraction = 0; let dur = message.attachment.duration || 1;
  const setIcon = () => { playBtn.innerHTML = ''; playBtn.append(icon(playing ? 'pause' : 'play', 20)); };
  setIcon();
  const paint = () => {
    const n = Math.round(bars.length * playedFraction);
    bars.forEach((b, i) => b.classList.toggle('played', i < n));
  };
  paint();
  const ensureAudio = async () => {
    if (audio) return audio;
    audio = new Audio(mediaUrlSync(url.split('/').pop()));
    audio.preload = 'metadata';
    audio.addEventListener('timeupdate', () => {
      playedFraction = audio.currentTime / (audio.duration || dur);
      if (audio.duration && isFinite(audio.duration)) { dur = audio.duration; timeEl.textContent = fmtDuration(audio.currentTime); }
      paint();
    });
    audio.addEventListener('ended', () => { playing = false; playedFraction = 0; paint(); setIcon(); timeEl.textContent = fmtDuration(dur); });
    return audio;
  };
  playBtn.addEventListener('click', async () => {
    const a = await ensureAudio();
    if (playing) { a.pause(); playing = false; }
    else { try { await a.play(); playing = true; } catch { toast('Could not play audio', 'err'); } }
    setIcon();
  });
  waveEl.addEventListener('click', async (e) => {
    const a = await ensureAudio();
    const rect = waveEl.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    a.currentTime = frac * (a.duration || dur);
    playedFraction = frac; paint();
  });
  return wrap;
}

/* ---------- media viewer ---------- */
export async function mediaViewer(message) {
  const att = message.attachment;
  const bd = el('div', { class: 'mv-backdrop' });
  const close = () => { vid?.pause?.(); bd.remove(); };
  let vid = null;
  const top = el('div', { class: 'mv-top' },
    el('button', { class: 'icon-btn', style: 'color:#fff', onclick: close }, icon('close')),
    el('div', { class: 'mv-name' }, att.filename || att.kind),
    el('button', {
      class: 'icon-btn', style: 'color:#fff', onclick: async () => {
        try {
          const url = await mediaUrl(att.id);
          if (navigator.canShare) {
            const blob = await (await fetch(url)).blob();
            const ext = (att.mime.split('/')[1] || 'bin').split(';')[0];
            const file = new File([blob], att.filename || `aurora.${ext}`, { type: att.mime });
            if (navigator.canShare({ files: [file] })) return navigator.share({ files: [file] });
          }
          const a = el('a', { href: url, download: att.filename || '' });
          document.body.append(a); a.click(); a.remove();
        } catch { toast('Could not download', 'err'); }
      },
    }, icon('download')),
  );
  const stage = el('div', { class: 'mv-stage' });
  const fullUrl = await mediaUrl(att.id);
  if (att.kind === 'image') {
    stage.append(el('img', { src: fullUrl, alt: '' }));
  } else if (att.kind === 'video') {
    vid = el('video', { src: fullUrl, controls: '', autoplay: '', playsinline: '' });
    stage.append(vid);
  } else {
    const card = el('div', { class: 'mv-audio-card' });
    card.append(el('div', { style: 'font-size:44px; margin-bottom:10px' }, att.kind === 'voice' ? '🎙' : '🎵'));
    card.append(el('div', { style: 'font-weight:800; margin-bottom:14px;word-break:break-all' }, att.filename || (att.kind === 'voice' ? 'Voice message' : 'Audio')));
    if (att.kind === 'voice' && message.text) card.append(el('div', { style: 'color:var(--text-2);font-size:13px;margin-bottom:12px' }, message.text));
    const au = el('audio', { src: fullUrl, controls: '' }); au.style.width = '100%';
    card.append(au);
    stage.append(card);
  }
  bd.append(top, stage);
  bd.addEventListener('click', (e) => { if (e.target === bd) close(); });
  document.body.append(bd);
}

/* ---------- voice recorder ---------- */
export function voiceRecorder(chatId, onSend) {
  const overlay = el('div', { class: 'rec-overlay' });
  let mediaRecorder, chunks = [], startTime = 0, timerInterval, cancelled = false, previewing = false;
  const timeEl = el('div', { class: 'rec-time' }, '0:00');
  const wave = el('div', { class: 'rec-wave' });
  const bars = Array.from({ length: 42 }, () => el('i'));
  bars.forEach((b) => wave.append(b));
  const hint = el('div', { class: 'rec-hint' }, 'Release to send · Slide away to cancel');
  const cancelBtn = el('button', { class: 'icon-btn danger', onclick: () => { cancelled = true; cleanup(); } }, icon('trash', 26));
  const sendBtn = el('button', { class: 'icon-btn', style: 'color:var(--ok)', onclick: () => finish() }, icon('send', 24));
  overlay.append(cancelBtn, timeEl, wave, hint, sendBtn);
  document.body.append(overlay);
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  let analyser, stream, rafId;

  async function start() {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch {
      toast('Microphone permission denied', 'err'); cleanup(); return;
    }
    mediaRecorder = new MediaRecorder(stream, { mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm' });
    mediaRecorder.ondataavailable = (e) => chunks.push(e.data);
    mediaRecorder.start(250);
    startTime = Date.now();
    const src = audioCtx.createMediaStreamSource(stream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    src.connect(analyser);
    const buf = new Uint8Array(analyser.frequencyBinCount);
    const anim = () => {
      analyser.getByteFrequencyData(buf);
      const avg = buf.reduce((a, b) => a + b, 0) / buf.length / 255;
      bars.forEach((b, i) => {
        const target = 8 + avg * 90 * (0.4 + 0.6 * Math.abs(Math.sin(i * .6 + Date.now() / 300)));
        b.style.height = Math.min(34, target) + 'px';
      });
      const s = Math.floor((Date.now() - startTime) / 1000);
      timeEl.textContent = fmtDuration(s);
      rafId = requestAnimationFrame(anim);
    };
    anim();
  }
  function cleanup() {
    cancelAnimationFrame(rafId);
    clearInterval(timerInterval);
    stream?.getTracks?.().forEach((t) => t.stop());
    audioCtx.close().catch(() => {});
    mediaRecorder?.state === 'recording' && mediaRecorder.stop();
    overlay.classList.add('fade-out');
    setTimeout(() => overlay.remove(), 180);
  }
  async function finish() {
    if (cancelled || previewing) return;
    previewing = true;
    const duration = (Date.now() - startTime) / 1000;
    const stopPromise = new Promise((res) => { mediaRecorder.onstop = res; mediaRecorder.stop(); });
    await stopPromise;
    const blob = new Blob(chunks, { type: mediaRecorder.mimeType });
    cleanup();
    if (blob.size < 800 || duration < 0.5) { toast('Recording too short', 'err'); return; }
    onSend(blob, Math.round(duration));
  }
  start();
  return { cancel: () => { cancelled = true; cleanup(); } };
}

/* ---------- message bubble ---------- */
export function messageEl(message, chat, opts = {}) {
  const mine = message.senderId === State.user?.id;
  const row = el('div', {
    class: `msg-row ${mine ? 'out' : ''} ${message.kind === 'system' ? 'system' : ''} ${message.pending ? 'pending' : ''} ${message.failed ? 'failed' : ''}`,
    'data-id': message.id,
  });
  if (message.kind === 'system') {
    const b = el('div', { class: 'bubble' }, el('div', { class: 'system-text' }, message.text));
    row.append(b);
    return row;
  }
  // avatar for group/channel incoming
  if (!mine && !message.anonymous && chat?.type !== 'direct' && chat?.type !== 'channel') {
    row.append(avatarMini(message.sender));
  }
  const b = el('div', { class: `bubble ${['image', 'video', 'sticker'].includes(message.kind) ? 'media-b' : ''}` });

  // header: author
  if (!mine && !message.anonymous && (chat?.type === 'group')) {
    b.append(el('div', { class: 'msg-author' }, message.sender?.displayName || 'Unknown'));
  }
  if (message.fwdFrom) {
    b.append(el('div', { class: 'fwd-label' }, '↪ ', el('b', {}, `From ${message.fwdFrom.name}`)));
  }
  // reply quote
  if (message.replyTo) {
    b.append(el('div', {
      class: 'reply-quote', onclick: (e) => {
        e.stopPropagation();
        document.dispatchEvent(new CustomEvent('aurora:scroll-to-msg', { detail: { id: message.replyTo.id } }));
      },
    },
    el('div', { class: 'rq-name' }, message.replyTo.senderName || ''),
    el('div', { class: 'rq-text' }, message.replyTo.text || kindPreview(message.replyTo.kind))));
  }
  // content
  if (message.kind === 'text') {
    b.append(el('div', { class: 'msg-text', html: linkify(message.text) }));
  } else if (message.kind === 'image' && message.attachment) {
    b.append(imageBubble(message));
  } else if (message.kind === 'video' && message.attachment) {
    b.append(videoBubble(message));
  } else if (message.kind === 'voice' && message.attachment) {
    b.append(voicePlayer(message, mine));
  } else if (message.kind === 'audio' && message.attachment) {
    b.append(docBubble(message, '🎵', 'audio'));
  } else if (message.kind === 'document' && message.attachment) {
    b.append(docBubble(message, extBadge(message.attachment), 'doc'));
  } else if (message.kind === 'sticker') {
    b.append(el('div', { class: 'sticker-emoji', style: 'font-size:56px;line-height:1.2;padding:4px' }, message.text));
  } else {
    b.append(el('div', { class: 'msg-text', html: linkify(message.text) }));
  }
  // caption
  if (['image', 'video', 'document', 'audio'].includes(message.kind) && message.text) {
    b.append(el('div', { class: 'caption-pad' }, el('div', { class: 'msg-text', html: linkify(message.text) })));
  }
  // meta
  const meta = el('div', { class: 'meta' });
  if (message.editedAt) meta.append(el('span', {}, 'edited'));
  if (chat?.type === 'channel' && message.views > 1) meta.append(el('span', {}, `👁 ${fmtCountSh(message.views)}`));
  meta.append(el('span', {}, fmtTime(message.createdAt)));
  if (mine) meta.append(el('span', { class: message.readBy ? 'read' : '' }, icon(message.failed ? 'warn' : message.pending ? 'clock' : message.readBy ? 'doublecheck' : 'check', 14)));
  if (message.pending || message.failed) row.classList.add(message.failed ? 'failed' : 'pending');
  b.append(meta);
  row.append(b);

  // reactions
  if (message.reactions?.length) {
    const rr = el('div', { class: 'reactions-row' });
    const grouped = new Map();
    for (const r of message.reactions) {
      if (!grouped.has(r.emoji)) grouped.set(r.emoji, []);
      grouped.get(r.emoji).push(r);
    }
    for (const [emoji, list] of grouped) {
      const mineR = list.some((r) => r.userId === State.user?.id);
      rr.append(el('button', {
        class: 'reaction-chip' + (mineR ? ' mine' : ''),
        onclick: (e) => { e.stopPropagation(); opts.onReact?.(message, mineR ? 'none' : emoji); },
      }, `${emoji} `, el('span', { class: 'rc-n' }, String(list.length))));
    }
    row.append(el('div', { style: 'display:contents' }), rr);
    rr.style.alignSelf = mine ? 'flex-end' : 'flex-start';
    rr.style.marginRight = mine ? '6px' : '44px';
    rr.style.marginLeft = mine ? '44px' : '6px';
    rr.style.marginBottom = '4px';
  }
  return row;
}
function fmtCountSh(n) { return n >= 1000 ? (n / 1000).toFixed(1).replace('.0', '') + 'K' : String(n); }
function kindPreview(kind) {
  return { image: '📷 Photo', video: '🎬 Video', voice: '🎙 Voice message', audio: '🎵 Audio', document: '📎 File', sticker: '🌈 Sticker' }[kind] || 'Message';
}
function avatarMini(sender) {
  if (!sender) return el('div', { class: 'avatar' });
  const g = el('div', { class: 'avatar' });
  if (sender.avatar) g.append(el('img', { src: mediaUrlSync(String(sender.avatar).split('/').pop()), loading: 'lazy' }));
  else {
    import('./utils.js').then(({ hueFor, initials }) => {
      const [a, bb] = hueFor(sender.id); g.style.background = `linear-gradient(135deg,${a},${bb})`;
      g.append(initials(sender.displayName));
    });
  }
  return g;
}
function imageBubble(message) {
  const wrap = el('div', { class: 'media-wrap' });
  const img = el('img', {
    class: 'photo', loading: 'lazy', alt: '',
    src: mediaUrlSync(message.attachment.id),
  });
  img.addEventListener('click', () => mediaViewer(message));
  if (message.attachment.width && message.attachment.height) {
    const ratio = message.attachment.width / message.attachment.height;
    const h = Math.min(300, 280 / ratio);
    img.style.height = h + 'px';
    img.style.width = Math.min(280, h * ratio) + 'px';
  }
  wrap.append(img);
  return wrap;
}
function videoBubble(message) {
  const wrap = el('div', { class: 'media-wrap' });
  const poster = message.attachment.thumbUrl ? mediaUrlSync(message.attachment.id) + '&thumb=1' : null;
  const play = el('button', {
    style: 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#fff;background:rgba(0,0,0,.28)',
  }, icon('play', 42));
  play.querySelector('svg').style.filter = 'drop-shadow(0 2px 10px rgba(0,0,0,.6))';
  const dur = message.attachment.duration ? el('span', {
    style: 'position:absolute;right:8px;bottom:6px;color:#fff;font-size:11.5px;font-weight:700;background:rgba(0,0,0,.55);border-radius:7px;padding:2px 7px',
  }, fmtDuration(message.attachment.duration)) : null;
  const thumbEl = message.attachment.thumbUrl
    ? el('img', { class: 'photo', loading: 'lazy', src: poster })
    : el('div', { class: 'photo', style: 'width:240px;height:160px;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#232a52,#171b38);color:var(--text-3)' }, icon('video', 34));
  wrap.append(thumbEl, play, dur);
  wrap.addEventListener('click', () => {
    wrap.innerHTML = '';
    const v = el('video', { src: mediaUrlSync(message.attachment.id), controls: '', autoplay: '', playsinline: '', style: 'max-width:280px;width:100%' });
    wrap.append(v);
  });
  return wrap;
}
function extBadge(att) {
  const ext = (att.filename || att.mime || '').split('.').pop().slice(0, 4).toUpperCase() || 'FILE';
  return ext;
}
async function docBubble(message, badge, type) {
  const d = el('div', { class: 'doc-b' });
  const size = fmtBytes(message.attachment.size);
  if (type === 'audio') {
    // inline audio player using voicePlayer UI
    d.append(voicePlayer(message, false));
    return d;
  }
  const dl = el('button', {
    class: 'doc-icon', onclick: (e) => {
      e.stopPropagation();
      const url = mediaUrlSync(message.attachment.id);
      const a = el('a', { href: url, download: message.attachment.filename || '' });
      document.body.append(a); a.click(); a.remove();
      toast('Downloading ' + (message.attachment.filename || 'file'), 'ok');
    },
  }, badge);
  const main = el('div', {}, el('div', { class: 'doc-name' }, message.attachment.filename || 'File'), el('div', { class: 'doc-size' }, size + ' · tap to download'));
  d.append(dl, main);
  return d;
}

/* ---------- image compressor ---------- */
export async function compressImage(file, maxDim = 1600, quality = 0.85) {
  if (!file.type.startsWith('image/') || file.type === 'image/gif') return file;
  try {
    const bitmap = await createImageBitmap(file);
    let { width, height } = bitmap;
    if (Math.max(width, height) > maxDim) {
      const ratio = maxDim / Math.max(width, height);
      width = Math.round(width * ratio); height = Math.round(height * ratio);
    }
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', quality));
    if (blob && blob.size < file.size) return new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' });
    return file;
  } catch { return file; }
}
export async function makeThumb(file, dim = 320) {
  try {
    const bitmap = await createImageBitmap(file, { resizeWidth: dim, resizeQuality: 'low' });
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.6));
    return blob || null;
  } catch { return null; }
}
export async function videoThumb(file) {
  return new Promise((resolve) => {
    try {
      const v = document.createElement('video');
      v.preload = 'metadata'; v.muted = true; v.playsInline = true;
      v.src = URL.createObjectURL(file);
      v.onloadeddata = () => { v.currentTime = Math.min(0.6, (v.duration || 1) / 3); };
      v.onseeked = () => {
        const canvas = document.createElement('canvas');
        const scale = Math.min(1, 320 / (v.videoWidth || 320));
        canvas.width = (v.videoWidth || 320) * scale; canvas.height = (v.videoHeight || 240) * scale;
        canvas.getContext('2d').drawImage(v, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((b) => { URL.revokeObjectURL(v.src); resolve({ thumb: b, duration: v.duration, width: v.videoWidth, height: v.videoHeight }); }, 'image/jpeg', 0.6);
      };
      v.onerror = () => resolve({ thumb: null, duration: null, width: null, height: null });
      setTimeout(() => resolve({ thumb: null, duration: v.duration || null, width: v.videoWidth, height: v.videoHeight }), 4000);
    } catch { resolve({ thumb: null, duration: null, width: null, height: null }); }
  });
}

/* ---------- upload flow helper ---------- */
export async function uploadMediaFlow(file, kind, onProgress) {
  let payload = file;
  let thumbBlob = null;
  let meta = {};
  if (kind === 'image' || kind === 'avatar' || kind === 'story') {
    if (file.type.startsWith('image/')) {
      payload = await compressImage(file, kind === 'avatar' ? 640 : 1600);
      thumbBlob = await makeThumb(payload, kind === 'avatar' ? 128 : 320);
      const bmp = await createImageBitmap(payload).catch(() => null);
      if (bmp) { meta.width = bmp.width; meta.height = bmp.height; bmp.close?.(); }
    }
  } else if (kind === 'video' || kind === 'story') {
    if (file.type.startsWith('video/')) {
      const t = await videoThumb(file);
      thumbBlob = t.thumb; meta.duration = t.duration; meta.width = t.width; meta.height = t.height;
    }
  }
  const att = await uploadFile(payload, kind, meta, onProgress, thumbBlob);
  return att;
}

/* ---------- user picker sheet (multi) ---------- */
export function pickUsers({ title = 'Select people', exclude = [], onDone, single = false, allowEmpty = false }) {
  let selected = new Set();
  sheet({
    title,
    body: (close) => {
      const wrap = el('div');
      const search = el('input', { placeholder: 'Search by @username or name…', style: 'width:100%;padding:12px 14px;border-radius:13px;border:1.5px solid var(--line);background:var(--bg-3);outline:none;color:var(--text);margin-bottom:8px' });
      const listEl = el('div');
      const doneBtn = el('button', { class: 'btn btn-primary btn-block mt-8', onclick: () => { close(); onDone([...selected]); } }, 'Done');
      let allPeople = [];
      async function load() {
        const r = await GET('/api/users/me/full');
        // contacts = people from direct chats + searched
        const chats = State.chats.filter((c) => c.type === 'direct' && c.peer).map((c) => c.peer);
        allPeople = chats;
        render('');
      }
      async function searchPeople(q) {
        if (q.trim().length < 2) return render('');
        const r = await GET('/api/users/search/people?q=' + encodeURIComponent(q));
        if (r.ok) render(r.data.results.map(u => ({ ...u, avatar: u.avatar })), true);
      }
      function render(people, isSearch) {
        const source = isSearch ? people : allPeople.filter(u => !exclude.includes(u.id));
        listEl.innerHTML = '';
        if (!source.length) listEl.append(el('div', { class: 'empty' }, el('h3', {}, 'No people found'), el('p', {}, 'Search by @username or share your profile link.')));
        for (const u of source) {
          if (exclude.includes(u.id)) continue;
          const { avatarEl } = _avatarRef;
          const item = el('div', {
            class: 'row-item' + (selected.has(u.id) ? ' picked' : ''),
            onclick: () => {
              if (single) { close(); onDone([u]); return; }
              selected.has(u.id) ? selected.delete(u.id) : selected.add(u.id);
              item.classList.toggle('picked');
              doneBtn.textContent = selected.size ? `Done (${selected.size})` : 'Done';
            },
          }, avatarEl(u, '', { online: u.online }), el('div', { class: 'row-main' },
            el('div', { class: 'row-title' }, el('span', { class: 'name' }, u.displayName)),
            el('div', { class: 'row-sub' }, '@' + u.username)),
            !single ? el('div', { class: 'row-check' }, selected.has(u.id) ? icon('check', 14) : '') : null);
          listEl.append(item);
        }
      }
      search.addEventListener('input', debounce(searchPeople, 250));
      wrap.append(search, listEl, (!single) ? doneBtn : el('div'));
      load();
      return wrap;
    },
  });
}
