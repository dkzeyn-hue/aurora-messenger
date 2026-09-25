/* ============================================================
   Conversation: message thread + composer + actions
   ============================================================ */
import { el, $, $$, icon, toast, toastErr, GET, POST, PATCH, DEL, State, navigate, avatarEl,
  fmtTime, fmtDay, fmtCount, escapeHtml, linkify, mediaUrl, saveMsgCache, cache, outboxCount, LS } from '../utils.js';
import { appbar, tabbar, emptyState } from '../app.js';
import { contextMenu, messageEl, modal, confirmModal, promptModal, sheet, emojiSheet,
  voiceRecorder, mediaViewer, uploadMediaFlow, pickUsers } from '../components.js';

export default async function conversationView(app, params) {
  const chatId = +params[0];
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  const jumpId = +q.get('jump') || null;
  const commentsFor = +q.get('comments') || null; // channel post comments

  const wrap = el('div', { class: 'screen' });
  let chat = null;
  let messages = [];
  let oldestLoaded = null;
  let replyTo = null;
  let editing = null;
  let typingUsers = new Map();
  let loading = true;
  let connectionLost = false;

  /* ---------- header ---------- */
  const subLabel = el('span');
  const header = appbar('', { back: '#/chat' });
  const headerTitle = $('h1', header);
  function renderHeader() {
    headerTitle.textContent = chat.type === 'direct' ? (chat.peer?.displayName || 'Chat') : chat.name;
    subLabel.textContent = headerSub();
    if (!chat.isPublic && chat.type !== 'direct') header.append();
  }
  function headerSub() {
    if (chat.type === 'direct') {
      if (chat.peer?.lastSeenHidden) return 'last seen hidden';
      if (chat.peer?.online) return 'online';
      return chat.peer?.lastSeen ? 'last seen ' + relTime(chat.peer.lastSeen) : 'offline';
    }
    if (chat.type === 'channel') return fmtCount(chat.subscriberCount || chat.memberCount) + ' subscribers';
    return fmtCount(chat.memberCount) + ' members' + (typingUsers.size ? ' · ' + [...typingUsers.values()].join(', ') + ' typing…' : '');
  }
  const relTime = (t) => {
    const d = new Date(t.replace(' ', 'T') + (t.includes('Z') ? '' : 'Z'));
    const s = (Date.now() - d.getTime()) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return 'on ' + d.toLocaleDateString();
  };
  const infoBtn = el('button', {
    class: 'icon-btn', onclick: () => {
      if (chat.type === 'direct' && chat.peer) navigate('#/user/' + chat.peer.username);
      else if (chat.type !== 'direct') navigate('#/groupinfo/' + chat.id);
    },
  }, icon('info'));
  header.append(infoBtn);

  /* ---------- pin bar ---------- */
  let pinBar = null;
  function renderPinBar() {
    pinBar?.remove();
    const pinned = chat.pinnedMessages || [];
    if (!pinned.length || commentsFor) return;
    const last = messages.find(m => m.id === pinned[0]);
    if (!last) return;
    pinBar = el('div', {
      class: 'pin-bar',
      onclick: () => scrollToMsg(last.id),
    },
    icon('pin', 17),
    el('div', { class: 'pb-main' },
      el('div', { class: 'pb-label' }, 'Pinned'),
      el('div', { class: 'pb-text' }, last.text || '📎 ' + (last.attachment?.filename || 'Media'))),
    chat.myRole && ['owner', 'admin', 'moderator'].includes(chat.myRole) ? el('button', {
      class: 'icon-btn', onclick: async (e) => {
        e.stopPropagation();
        const r = await DEL(`/api/chats/${chat.id}/pin/${last.id}`);
        if (r.ok) { chat.pinnedMessages = chat.pinnedMessages.filter(p => p !== last.id); renderPinBar(); }
      },
    }, icon('close', 16)) : null);
    header.after(pinBar);
  }

  /* ---------- scroll area ---------- */
  const scroll = el('div', { class: 'chat-scroll', id: 'chat-scroll' });
  const typingBar = el('div', { class: 'typing-bar hidden' });

  function renderTyping() {
    const names = [...typingUsers.keys()].map(id => typingUsers.get(id));
    if (typingUsers.size) {
      typingBar.classList.remove('hidden');
      typingBar.innerHTML = '';
      typingBar.append(el('span', { class: 'typing-dots' }, el('i'), el('i'), el('i')), el('span', { class: 'typing-text' }, names.join(', ') + (typingUsers.size > 1 ? ' are' : ' is') + ' typing…'));
    } else typingBar.classList.add('hidden');
    if (chat.type !== 'direct' && !typingUsers.size) subLabel.textContent = headerSub();
  }

  function appendMessage(m, { prepend = false } = {}) {
    const elx = messageEl(m, chat, { onReact: react });
    if (prepend) scroll.prepend(elx); else scroll.append(elx);
  }
  function renderMessages(list, { append = false } = {}) {
    if (!append) { scroll.innerHTML = ''; }
    let lastDay = '', lastSender = null;
    for (const m of list) {
      const day = fmtDay(m.createdAt);
      if (day !== lastDay) {
        scroll.append(el('div', { class: 'chat-day' }, day));
        lastDay = day; lastSender = null;
      }
      const isGrouped = lastSender === (m.senderId || 'sys') && m.kind !== 'system';
      const row = messageEl(m, chat, { onReact: react });
      if (isGrouped) row.classList.remove('first'); else row.classList.add('first');
      lastSender = m.senderId || 'sys';
      scroll.append(row);
    }
  }
  function scrollToMsg(id) {
    const target = scroll.querySelector(`[data-id="${id}"]`);
    if (target) {
      target.scrollIntoView({ block: 'center', behavior: 'smooth' });
      target.style.transition = 'background .8s';
      target.style.borderRadius = '16px';
      target.style.background = 'var(--accent-soft)';
      setTimeout(() => target.style.background = '', 900);
    }
  }

  async function loadMessages({ before } = {}) {
    const url = `/api/messages/chat/${chatId}?limit=40${before ? '&before=' + before : ''}${commentsFor ? '&parentPostId=' + commentsFor : ''}`;
    const r = await GET(url);
    if (!r.ok) {
      if (!messages.length) { scroll.append(emptyState('warn', 'Could not load messages', r.data?.message || 'Check your connection and try again.', 'Retry', () => loadMessages())); }
      return;
    }
    loading = false;
    const incoming = r.data.messages;
    if (before) {
      messages = [...incoming, ...messages];
      renderMessages(messages);
      // keep scroll position
    } else {
      messages = incoming;
      renderMessages(messages);
      if (jumpId) setTimeout(() => scrollToMsg(jumpId), 120);
      else requestAnimationFrame(() => { scroll.scrollTop = scroll.scrollHeight; });
    }
    saveMsgCache(chatId, messages);
    oldestLoaded = messages[0]?.id || null;
    // mark read
    const maxId = messages.length ? messages[messages.length - 1].id : 0;
    if (maxId) POST(`/api/chats/${chatId}/read`, { messageId: maxId });
    const c = State.chats.find(c => c.id === chatId);
    if (c) { c.unreadCount = 0; }
  }

  // infinite scroll up (pagination)
  scroll.addEventListener('scroll', () => {
    if (scroll.scrollTop < 60 && oldestLoaded && !loadingOlder && hasMore) {
      loadOlder();
    }
  });
  let loadingOlder = false, hasMore = true;
  async function loadOlder() {
    loadingOlder = true;
    const prevHeight = scroll.scrollHeight;
    await loadMessages({ before: oldestLoaded });
    scroll.scrollTop = scroll.scrollHeight - prevHeight + scroll.scrollTop;
    if (messages.length < 40) hasMore = false;
    loadingOlder = false;
  }

  /* ---------- composer ---------- */
  const composerWrap = el('div');
  const canPost = () => {
    if (chat.type === 'channel' && !commentsFor) return ['owner', 'admin'].includes(chat.myRole);
    return true;
  };
  function buildComposer() {
    composerWrap.innerHTML = '';
    if (!canPost()) {
      composerWrap.append(el('div', { class: 'composer', style: 'justify-content:center' },
        el('span', { style: 'color:var(--text-3);font-size:13px' }, 'Only admins can post in this channel')));
      return;
    }
    const input = el('textarea', { placeholder: commentsFor ? 'Comment…' : 'Message', rows: '1' });
    const sendBtn = el('button', { class: 'send-btn' }, icon('send', 21));
    const inner = el('div', { class: 'composer-inner' }, input);
    const attachBtn = el('button', { class: 'icon-btn', style: 'flex-shrink:0' }, icon('attach', 21));
    const emojiBtn = el('button', { class: 'icon-btn', style: 'flex-shrink:0' }, icon('emoji', 22));
    inner.append(emojiBtn, attachBtn);

    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(120, input.scrollHeight) + 'px';
      emitTyping(input.value.length > 0);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); trySend(); }
    });
    sendBtn.addEventListener('click', trySend);
    emojiBtn.addEventListener('click', () => emojiSheet(
      (e) => { input.value += e; input.focus(); },
      (s) => sendMessage({ kind: 'sticker', text: s })
    ));
    attachBtn.addEventListener('click', (e) => contextMenu(e.clientX, e.clientY - 200, [
      { label: 'Photo', icon: 'image', onClick: () => filePick('image', 'image/*') },
      { label: 'Video', icon: 'video', onClick: () => filePick('video', 'video/*') },
      { label: 'Document', icon: 'file', onClick: () => filePick('document', '*/*') },
      { label: 'Audio', icon: 'play', onClick: () => filePick('audio', 'audio/*') },
    ]));
    const micBtn = el('button', { class: 'send-btn', onclick: startVoice }, icon('mic', 21));
    const toggleSendMode = () => {
      sendBtn.style.display = input.value.trim() || editing ? '' : 'none';
      micBtn.style.display = input.value.trim() || editing ? 'none' : '';
    };
    input.addEventListener('input', toggleSendMode);
    toggleSendMode();

    composerWrap.append(el('div', { class: 'composer' }, inner, micBtn, sendBtn));
    const comp = $('.composer', composerWrap);
    comp.insertBefore(micBtn, sendBtn);
    // mic before send
    composerWrap._input = input;
  }
  function filePick(kind, accept) {
    const inp = el('input', { type: 'file', accept });
    inp.addEventListener('change', async () => {
      const file = inp.files?.[0];
      if (!file) return;
      await sendFileMessage(file, kind);
    });
    inp.click();
  }

  let typingThrottle = 0;
  function emitTyping(active) {
    const now = Date.now();
    if (active && now - typingThrottle > 2200) {
      typingThrottle = now;
      State.socket?.emit('typing', { chatId, isTyping: true });
    }
    if (!active) State.socket?.emit('typing', { chatId, isTyping: false });
  }

  function replyPreviewBar() {
    const bar = el('div', { class: 'reply-preview' });
    if (editing) {
      bar.append(el('div', { class: 'rp-main' }, el('div', { class: 'rp-name' }, '✏️ Editing message'), el('div', { class: 'rp-text' }, editing.text || 'Media message')));
      bar.append(el('button', { class: 'icon-btn', onclick: clearComposeState }, icon('close')));
      composerWrap.prepend(bar);
    } else if (replyTo) {
      bar.append(avatarEl({ id: replyTo.senderId, displayName: replyTo.senderName || '' }, 'sm'),
        el('div', { class: 'rp-main' }, el('div', { class: 'rp-name' }, replyTo.senderName || 'Reply'),
          el('div', { class: 'rp-text' }, replyTo.text || 'Media message')));
      bar.append(el('button', { class: 'icon-btn', onclick: clearComposeState }, icon('close')));
      composerWrap.prepend(bar);
    }
  }
  function clearComposeState() {
    replyTo = null; editing = null;
    rebuildComposer();
  }
  function rebuildComposer() {
    buildComposer();
    replyPreviewBar();
    if (composerWrap._input) composerWrap._input.focus();
  }

  async function trySend() {
    const input = composerWrap._input;
    const text = input.value.trim();
    if (!text) return;
    if (editing) {
      const r = await PATCH(`/api/messages/${editing.id}`, { text });
      if (r.ok) { clearComposeState(); } else toastErr(r);
      return;
    }
    input.value = ''; input.style.height = 'auto';
    await sendMessage({ kind: 'text', text });
  }

  async function sendMessage(payload) {
    const tmpId = 'tmp-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    const optimistic = {
      id: tmpId, chatId, senderId: State.user.id, sender: { id: State.user.id, displayName: State.user.displayName, avatar: State.user.avatar },
      kind: payload.kind, text: payload.text || '', attachment: payload.attachment || null,
      replyToId: replyTo?.id || null, replyTo: replyTo ? { id: replyTo.id, text: replyTo.text?.slice(0, 120), senderName: replyTo.senderName } : null,
      parentPostId: commentsFor, createdAt: new Date().toISOString().replace('T', ' ').slice(0, 19),
      reactions: [], pending: true, fwdFrom: payload.fwdFrom || null, views: 0,
    };
    appendMessage(optimistic);
    scroll.scrollTop = scroll.scrollHeight;
    const myReply = replyTo; replyTo = null;
    rebuildComposer();

    const body = {
      kind: payload.kind, text: payload.text || '',
      replyToId: myReply?.id || null, attachmentId: payload.attachment?.id || null,
      parentPostId: commentsFor || undefined, fwdFrom: payload.fwdFrom,
    };
    const r = await POST(`/api/messages/chat/${chatId}`, body, {
      queue: payload.kind === 'text',
      meta: { tmpId },
    });
    const row = scroll.querySelector(`[data-id="${tmpId}"]`);
    if (r.queued) {
      if (row) { row.classList.add('pending'); }
      toast('Offline — message queued and will send automatically', '', 3200);
      return;
    }
    if (!r.ok) {
      if (row) { row.classList.remove('pending'); row.classList.add('failed'); }
      toastErr(r, 'Could not send message');
      // retry affordance
      const retry = el('button', { class: 'reaction-chip', style: 'margin:4px 44px' }, '↻ Retry');
      retry.addEventListener('click', () => { retry.remove(); row?.remove(); sendMessage({ ...payload }); });
      row?.after(retry);
      return;
    }
    if (row) {
      const fresh = r.data.message;
      // the socket may have already rendered this message (race) — drop the optimistic row only
      if (messages.find(x => x.id === fresh.id) || scroll.querySelector(`[data-id="${fresh.id}"]`)) {
        row.remove();
      } else {
        const newRow = messageEl(fresh, chat, { onReact: react });
        newRow.classList.add('first');
        row.replaceWith(newRow);
        messages.push(fresh);
        saveMsgCache(chatId, messages);
      }
      const chat2 = State.chats.find(c => c.id === chatId);
      if (chat2) chat2.lastMessage = fresh;
    }
  }

  async function sendFileMessage(file, kind) {
    const tmpId = 'tmp-' + Date.now();
    const pill = el('div', { class: 'up-pill' },
      icon(kind === 'video' ? 'video' : kind === 'image' ? 'image' : 'file', 20),
      el('div', { style: 'flex:1;min-width:0' },
        el('div', { class: 'up-name' }, file.name || kind),
        el('div', { class: 'up-status' }, 'Uploading… 0%')),
      el('button', { class: 'icon-btn' }, icon('close', 16)));
    const bar = el('div', { class: 'bar', style: 'width:0%' });
    pill.append(bar);
    scroll.append(pill);
    scroll.scrollTop = scroll.scrollHeight;
    const status = $('.up-status', pill);
    try {
      const att = await uploadMediaFlow(file, kind, (pct) => {
        status.textContent = `Uploading… ${pct}%`;
        bar.style.width = pct + '%';
      });
      pill.remove();
      await sendMessage({ kind, text: '', attachment: att });
    } catch (err) {
      status.textContent = err.message || 'Upload failed';
      pill.style.border = '1px solid var(--danger)';
      pill.append(el('button', { class: 'btn btn-sm btn-soft', onclick: () => { pill.remove(); sendFileMessage(file, kind); } }, 'Retry'));
      toast(err.message || 'Upload failed', 'err');
    }
  }

  function startVoice() {
    State.socket?.emit('recording', { chatId, isRecording: true });
    voiceRecorder(chatId, async (blob, duration) => {
      State.socket?.emit('recording', { chatId, isRecording: false });
      // quick waveform client-side
      const wave = await computeWaveform(blob).catch(() => null);
      try {
        const file = new File([blob], 'voice.webm', { type: blob.type || 'audio/webm' });
        const att = await uploadMediaFlow(file, 'voice', (p) => {}, null);
        if (wave) { att.waveform = wave; }
        att.duration = duration || att.duration;
        await sendMessage({ kind: 'voice', text: '', attachment: att });
      } catch (e) {
        toast(e.message || 'Could not send voice message', 'err');
      }
    });
  }
  async function computeWaveform(blob) {
    try {
      const ctx = new AudioContext();
      const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
      const data = buf.getChannelData(0);
      const buckets = 40, size = Math.floor(data.length / buckets);
      const peaks = [];
      for (let i = 0; i < buckets; i++) {
        let max = 0;
        for (let j = 0; j < size; j += 16) max = Math.max(max, Math.abs(data[i * size + j] || 0));
        peaks.push(Math.min(1, max * 1.4));
      }
      ctx.close();
      return peaks;
    } catch { return null; }
  }

  /* ---------- message actions ---------- */
  function onMessageMenu(e, m) {
    e.preventDefault(); e.stopPropagation();
    const mine = m.senderId === State.user.id;
    const items = [];
    if (m.kind !== 'system') {
      items.push({ label: 'Reply', icon: 'reply', onClick: () => { replyTo = m; rebuildComposer(); } });
      if (m.text && m.kind !== 'sticker') items.push({ label: 'Copy text', icon: 'copy', onClick: () => { navigator.clipboard?.writeText(m.text); toast('Copied', 'ok'); } });
      items.push({ label: 'Forward', icon: 'forward', onClick: () => forwardSheet(m) });
      items.push({ label: 'React', icon: 'heart', onClick: () => reactSheet(m) });
      items.push({ label: 'Save to Saved', icon: 'bookmark', onClick: async () => { const r = await POST(`/api/messages/${m.id}/save`); toast(r.ok ? 'Saved' : r.data?.message, r.ok ? 'ok' : 'err'); } });
      const isMod = ['owner', 'admin', 'moderator'].includes(chat.myRole);
      const pinned = (chat.pinnedMessages || []).includes(m.id);
      if (isMod || (chat.type === 'direct' && mine)) {
        items.push({ label: pinned ? 'Unpin' : 'Pin', icon: 'pin', onClick: async () => {
          const r = pinned ? await DEL(`/api/chats/${chatId}/pin/${m.id}`) : await POST(`/api/chats/${chatId}/pin/${m.id}`);
          if (r.ok) { chat.pinnedMessages = pinned ? chat.pinnedMessages.filter(x => x !== m.id) : [m.id, ...chat.pinnedMessages]; renderPinBar(); toast(pinned ? 'Unpinned' : 'Pinned', 'ok'); }
          else toastErr(r);
        } });
      }
      if (mine && m.kind !== 'system') items.push({ label: 'Edit', icon: 'edit', onClick: () => { editing = m; rebuildComposer(); composerWrap._input.value = m.text; } });
      items.push({ sep: true });
      items.push({ label: 'Delete for me', icon: 'trash', danger: true, onClick: () => deleteMessage(m, 'me') });
      if (mine || ['owner', 'admin', 'moderator'].includes(chat.myRole)) {
        items.push({ label: 'Delete for everyone', icon: 'trash', danger: true, onClick: () => deleteMessage(m, 'all') });
      }
      items.push({ sep: true });
      items.push({ label: 'Report', icon: 'report', danger: true, onClick: () => reportSheet('message', m.id) });
    }
    contextMenu(e.clientX, e.clientY, items);
  }

  async function react(m, emoji) {
    const r = await POST(`/api/messages/${m.id}/react`, { emoji });
    if (r.ok) updateOneMessage(r.data.message);
    else toastErr(r);
  }
  function reactSheet(m) {
    sheet({
      title: 'React',
      body: (close) => {
        const wrap2 = el('div', { style: 'display:flex;gap:6px;justify-content:center;flex-wrap:wrap;padding:10px' });
        const allowed = chat.settings?.allowedReactions || ['👍', '❤️', '🔥', '🎉', '😂', '😮', '😢', '🙏'];
        for (const e of allowed) {
          wrap2.append(el('button', { style: 'font-size:30px;padding:10px 14px;border-radius:14px', onclick: () => { close(); react(m, e); } }, e));
        }
        return wrap2;
      },
    });
  }

  function forwardSheet(m) {
    pickUsers({
      title: 'Forward to chat',
      single: false,
      onDone: async (ids) => { if (!ids.length) return; const r = await POST(`/api/messages/${m.id}/forward`, { chatIds: ids }); toast(r.ok ? 'Forwarded' : r.data?.message, r.ok ? 'ok' : 'err'); },
    });
  }
  // NOTE: forwarding should target chats; we also allow forwarding to a user by opening their DM first — handled via chats below
  function reportSheet(type, id) {
    const reasons = ['spam', 'abuse', 'harassment', 'pornography', 'violence', 'scam', 'other'];
    sheet({
      title: 'Report',
      body: (close) => {
        const w = el('div');
        w.append(el('div', { style: 'color:var(--text-2);font-size:13px;margin:4px 4px 10px' }, 'Why are you reporting this? Your report is anonymous to the reported user.'));
        for (const r of reasons) {
          w.append(el('button', {
            class: 'ctx-item', style: 'width:100%',
            onclick: async () => {
              const res = await POST('/api/users/report', { targetType: type, targetId: id, reason: r });
              close();
              toast(res.ok ? res.data.message : res.data?.message, res.ok ? 'ok' : 'err');
            },
          }, r[0].toUpperCase() + r.slice(1)));
        }
        return w;
      },
    });
  }

  async function deleteMessage(m, scope) {
    if (scope === 'all' && !(await confirmModal('Delete for everyone?', 'This message will be removed for all members.', 'Delete'))) return;
    const r = await DEL(`/api/messages/${m.id}?scope=${scope}`);
    if (r.ok) {
      if (scope === 'me') { scroll.querySelector(`[data-id="${m.id}"]`)?.remove(); }
      messages = messages.filter(x => x.id !== m.id);
      saveMsgCache(chatId, messages);
      toast('Deleted', 'ok');
    } else toastErr(r);
  }

  function updateOneMessage(fresh) {
    messages = messages.map(m => m.id === fresh.id ? fresh : m);
    const row = scroll.querySelector(`[data-id="${fresh.id}"]`);
    if (row) {
      const nr = messageEl(fresh, chat, { onReact: react });
      nr.classList.add('first');
      row.replaceWith(nr);
    }
    saveMsgCache(chatId, messages);
  }

  /* ---------- realtime handlers ---------- */
  const onNewMessage = (e) => {
    const m = e.detail.message;
    if (m.chatId !== chatId || commentsFor) return;
    if (m.parentPostId) return; // comment inside main thread
    if (messages.find(x => x.id === m.id)) return;
    if (scroll.querySelector(`[data-id="${m.id}"]`)) return;
    const isMine = m.senderId === State.user.id;
    m.readBy = isMine;
    appendMessage(m);
    messages.push(m);
    saveMsgCache(chatId, messages);
    const nearBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 240;
    if (isMine || nearBottom) scroll.scrollTop = scroll.scrollHeight;
    POST(`/api/chats/${chatId}/read`, { messageId: m.id });
  };
  const onEdited = (e) => { if (e.detail.message.chatId === chatId) updateOneMessage(e.detail.message); };
  const onDeleted = (e) => {
    if (e.detail.chatId !== chatId) return;
    scroll.querySelector(`[data-id="${e.detail.messageId}"]`)?.remove();
    messages = messages.filter(m => m.id !== e.detail.messageId);
    saveMsgCache(chatId, messages);
  };
  const onReaction = (e) => { if (e.detail.message.chatId === chatId) updateOneMessage(e.detail.message); };
  const onTyping = (e) => {
    if (e.detail.chatId !== chatId || e.detail.userId === State.user.id) return;
    if (e.detail.isTyping) typingUsers.set(e.detail.userId, e.detail.name);
    else typingUsers.delete(e.detail.userId);
    renderTyping();
    if (typingUsers.size) setTimeout(() => { typingUsers.delete(e.detail.userId); renderTyping(); }, 4000);
  };
  const onRecording = (e) => {
    if (e.detail.chatId !== chatId || e.detail.userId === State.user.id) return;
    if (e.detail.isRecording) typingUsers.set(e.detail.userId, '🎙 recording audio');
    else typingUsers.delete(e.detail.userId);
    renderTyping();
  };
  const onRead = (e) => {
    if (e.detail.chatId !== chatId || e.detail.userId === State.user.id) return;
    // mark my messages as read
    $$('.msg-row.out .meta', scroll).forEach(meta => { meta.innerHTML = ''; meta.append(icon('doublecheck', 14)); meta.classList.add('readcheck'); });
    State.chats.find(c => c.id === chatId)?.lastMessage;
  };
  const onPresence = (e) => {
    if (chat.type === 'direct' && chat.peer && e.detail.userId === chat.peer.id) {
      chat.peer.online = e.detail.online;
      if (!e.detail.online) chat.peer.lastSeen = e.detail.lastSeen;
      subLabel.textContent = headerSub();
    }
  };
  const onPinned = (e) => { if (e.detail.chatId === chatId) { loadChatMeta(); } };
  async function loadChatMeta() {
    const r = await GET('/api/chats/' + chatId);
    if (r.ok) { chat = r.data.chat; renderHeader(); renderPinBar(); }
  }

  const EVT = [
    ['aurora:message:new', onNewMessage], ['aurora:message:edited', onEdited], ['aurora:message:deleted', onDeleted],
    ['aurora:message:reaction', onReaction], ['aurora:typing', onTyping], ['aurora:recording', onRecording],
    ['aurora:messages:read', onRead], ['aurora:presence', onPresence], ['aurora:message:pinned', onPinned],
    ['aurora:message:unpinned', onPinned],
  ];
  for (const [ev, fn] of EVT) document.addEventListener(ev, fn);
  const onScrollTo = (e) => scrollToMsg(e.detail.id);
  document.addEventListener('aurora:scroll-to-msg', onScrollTo);

  /* ---------- connection banner ---------- */
  const connBanner = el('div', { class: 'conn-banner hidden' }, '⚠ Connecting…');
  const onConnect = () => { connectionLost = false; connBanner.classList.add('hidden'); };
  const onDisconnect = () => { connectionLost = true; connBanner.classList.remove('hidden'); };
  document.addEventListener('aurora:connect', onConnect);
  document.addEventListener('aurora:disconnect', onDisconnect);

  /* ---------- assemble ---------- */
  wrap.append(header, connBanner, scroll, typingBar, composerWrap);

  // click delegation for message menu + media
  scroll.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.msg-row');
    if (!row) return;
    const m = messages.find(x => String(x.id) === row.dataset.id);
    if (m && m.kind !== 'system') onMessageMenu(e, m);
  });
  scroll.addEventListener('click', (e) => {
    const row = e.target.closest('.msg-row');
    if (!row || e.target.closest('button, img, video, a, .vwave, .vplay, .doc-icon')) return;
    const m = messages.find(x => String(x.id) === row.dataset.id);
    if (m && m.kind !== 'system') onMessageMenu(e, m);
  });

  // load chat meta + messages (with offline cache)
  const r = await GET('/api/chats/' + chatId);
  if (r.ok) {
    chat = r.data.chat;
    renderHeader();
  } else {
    chat = { id: chatId, type: 'direct', name: 'Chat', settings: {}, pinnedMessages: [] };
    toast('Could not load chat details', 'err');
  }
  buildComposer();
  replyPreviewBar();
  // cached messages instantly, then network
  const cached = cache.messages[chatId];
  if (cached?.length) { messages = cached; renderMessages(messages); scroll.scrollTop = scroll.scrollHeight; }
  await loadMessages({});
  renderPinBar();
  if (commentsFor) headerTitle.textContent = 'Comments';

  wrap._cleanup = () => {
    for (const [ev, fn] of EVT) document.removeEventListener(ev, fn);
    document.removeEventListener('aurora:scroll-to-msg', onScrollTo);
    document.removeEventListener('aurora:connect', onConnect);
    document.removeEventListener('aurora:disconnect', onDisconnect);
  };
  return wrap;
}
