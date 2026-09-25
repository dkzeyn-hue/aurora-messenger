/* ============================================================
   Stories: feed grid, composer, full-screen viewer
   ============================================================ */
import { el, $, $$, icon, toast, toastErr, GET, POST, DEL, State, navigate, avatarEl,
  fmtRelative, fmtDuration } from '../utils.js';
import { mediaUrlSync } from '../utils.js';
import { tabbar, appbar, emptyState } from '../app.js';
import { sheet, modal, confirmModal, uploadMediaFlow, contextMenu } from '../components.js';

export default async function storiesView(app) {
  const wrap = el('div', { class: 'screen' });
  wrap.append(appbar('Stories', {
    actions: [el('button', { class: 'icon-btn', onclick: composeStory }, icon('plus'))],
  }));
  const content = el('div', { class: 'content' });
  wrap.append(content, tabbar('stories'));

  async function load() {
    content.innerHTML = '';
    content.append(el('div', { class: 'list' }, ...Array(4).fill(0).map(() =>
      el('div', { class: 'skel-row' }, el('div', { class: 'skel skel-circle' }), el('div', { class: 'skel-lines' }, el('div', { class: 'skel skel-line', style: 'width:55%' }), el('div', { class: 'skel skel-line', style: 'width:35%' }))))));
    const r = await GET('/api/stories/feed');
    content.innerHTML = '';
    if (!r.ok) { content.append(emptyState('story', 'Could not load stories', r.data?.message || 'Try again.', 'Retry', load)); return; }
    const { mine, groups } = r.data;
    State.storyFeed = r.data;

    if (!mine.length && !groups.length) {
      content.append(emptyState('story', 'No active stories', 'Stories shared by you and people you chat with appear here and disappear after 24 hours.', 'Share a story', composeStory));
      return;
    }
    // my story
    if (mine.length) {
      content.append(el('div', { class: 'section-label' }, 'My story'));
      for (const s of mine) {
        content.append(storyRow(s, true));
      }
    } else {
      content.append(el('div', { class: 'section-label' }, 'My story'),
        el('div', { class: 'row-item', onclick: composeStory },
          avatarEl(State.user, '', {}),
          el('div', { class: 'row-main' },
            el('div', { class: 'row-title' }, el('span', { class: 'name' }, 'Add to your story')),
            el('div', { class: 'row-sub' }, 'Photos & videos · disappears in 24h'))));
    }
    content.append(el('div', { class: 'section-label' }, 'Recent'));
    for (const g of groups) {
      const latest = g.stories[0];
      const row = el('div', { class: 'row-item', onclick: () => openViewer(g) },
        avatarEl(g.user, '', { ring: true, seen: g.stories.every(s => s.viewedByMe) }),
        el('div', { class: 'row-main' },
          el('div', { class: 'row-title' }, el('span', { class: 'name' }, g.user.displayName)),
          el('div', { class: 'row-sub' }, fmtRelative(latest.createdAt) + ' · ' + g.stories.length + ' new')));
      content.append(row);
    }
  }

  function storyRow(s, isMine) {
    return el('div', {
      class: 'row-item',
      onclick: () => isMine ? openViewer({ user: State.user, stories: [s], mineOnly: s }) : openViewer({ user: s.user, stories: [s] }),
      oncontextmenu: (e) => {
        e.preventDefault();
        if (!isMine) return;
        contextMenu(e.clientX, e.clientY, [
          { label: 'Delete story', icon: 'trash', danger: true, onClick: async () => {
            if (!(await confirmModal('Delete story?', 'It will disappear for everyone.'))) return;
            const r = await DEL('/api/stories/' + s.id);
            toast(r.ok ? 'Story deleted' : r.data?.message, r.ok ? 'ok' : 'err');
            load();
          } },
        ]);
      },
    },
    avatarEl(s.user, '', { ring: true, seen: s.viewedByMe }),
    el('div', { class: 'row-main' },
      el('div', { class: 'row-title' }, el('span', { class: 'name' }, 'Your story' + (s.viewCount ? ` · 👁 ${s.viewCount}` : ''))),
      el('div', { class: 'row-sub' }, (s.caption || 'Story') + ' · expires ' + new Date(s.expiresAt.replace(' ', 'T') + 'Z').toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))));
  }

  /* ---------- composer ---------- */
  function composeStory() {
    const inp = el('input', { type: 'file', accept: 'image/*,video/*' });
    inp.addEventListener('change', async () => {
      const file = inp.files?.[0];
      if (!file) return;
      // upload with progress
      const prog = modal({
        title: 'Uploading story…', text: 'Compressing and uploading your media.',
        actions: [], dismissable: false,
      });
      try {
        const att = await uploadMediaFlow(file, 'story', (p) => { prog.root.querySelector('.m-text').textContent = `Uploading… ${p}%`; });
        prog.close();
        storyDetailsSheet(att);
      } catch (e) {
        prog.close();
        toast(e.message || 'Upload failed', 'err');
      }
    });
    inp.click();
  }

  function storyDetailsSheet(att) {
    let caption = '', privacy = 'everyone', selected = [], expires = 24;
    sheet({
      title: 'New story',
      body: (close) => {
        const w = el('div');
        const preview = el('div', { style: 'border-radius:16px;overflow:hidden;margin-bottom:12px;background:#000;display:flex;justify-content:center' });
        if (att.mime.startsWith('video')) preview.append(el('video', { src: mediaUrlSync(att.id), style: 'max-height:280px;width:100%', controls: '' }));
        else preview.append(el('img', { src: mediaUrlSync(att.id), style: 'max-height:280px;width:100%;object-fit:contain' }));
        const capIn = el('input', {
          placeholder: 'Add a caption…', style: 'width:100%;padding:12px 14px;border-radius:13px;border:1.5px solid var(--line);background:var(--bg-3);outline:none;color:var(--text)',
        });
        capIn.addEventListener('input', () => caption = capIn.value);
        // emoji quick add
        const emojiRow = el('div', { style: 'display:flex;gap:4px;margin:8px 0' });
        for (const e of ['💜', '✨', '😂', '🔥', '🎉', '🌈']) {
          emojiRow.append(el('button', { style: 'font-size:20px;padding:4px 8px', onclick: () => { capIn.value += e; caption = capIn.value; } }, e));
        }
        w.append(preview, capIn, emojiRow);
        // privacy
        w.append(el('div', { class: 'section-label', style: 'padding-left:0' }, 'Who can view'));
        const priv = el('div', { class: 'set-group', style: 'margin:0' });
        const opts = [['everyone', 'Everyone', 'Anyone on Aurora can see this story'], ['contacts', 'My contacts', 'People you have chatted with'], ['selected', 'Selected people', 'Pick specific viewers'], ['nobody', 'Nobody', 'Only visible to you']];
        for (const [k, label, sub] of opts) {
          const row = el('div', { class: 'choice-row' + (privacy === k ? ' on' : ''), onclick: async () => {
            if (k === 'selected') {
              const { pickUsers } = await import('../components.js');
              pickUsers({ title: 'Who can view?', onDone: (ids) => {
                selected = ids;
                if (ids.length) { privacy = 'selected'; $$('.choice-row', priv).forEach(r => r.classList.remove('on')); row.classList.add('on'); }
              } });
              return;
            }
            privacy = k;
            $$('.choice-row', priv).forEach(r => r.classList.remove('on'));
            row.classList.add('on');
          } }, el('div', { class: 'radio-dot' }), el('div', {}, el('div', { style: 'font-weight:600' }, label), el('div', { style: 'font-size:12px;color:var(--text-2)' }, sub)));
          priv.append(row);
        }
        w.append(priv);
        // expiry
        w.append(el('div', { class: 'section-label', style: 'padding-left:0' }, 'Expires after'));
        const seg = el('div', { class: 'seg' });
        for (const [h, label] of [[1, '1h'], [6, '6h'], [24, '24h'], [48, '48h']]) {
          seg.append(el('button', { class: expires === h ? 'active' : '', onclick: () => { expires = h; $$('button', seg).forEach(b => b.classList.remove('active')); seg.children[[1, 6, 24, 48].indexOf(h)].classList.add('active'); } }, label));
        }
        w.append(seg, el('button', {
          class: 'btn btn-primary btn-block mt-16', onclick: async () => {
            const r = await POST('/api/stories', {
              attachmentId: att.id, caption, privacy, selectedUsers: selected, expiresInHours: expires,
              overlay: [],
            });
            close();
            if (r.ok) { toast('Story shared ✨', 'ok'); load(); }
            else toastErr(r);
          },
        }, 'Share story'));
        return w;
      },
    });
  }

  /* ---------- viewer ---------- */
  function openViewer(group) {
    const stories = group.stories;
    let idx = 0;
    const bd = el('div', { class: 'story-viewer' });
    const bars = el('div', { class: 'story-bars' });
    const top = el('div', { class: 'story-top' });
    const stage = el('div', { class: 'story-stage' });
    const captionEl = el('div', { class: 'story-caption' });
    const bottom = el('div', { class: 'story-bottom' });
    const viewersBtn = el('button', { class: 'icon-btn', style: 'color:#fff' }, icon('eye', 20));
    const closeBtn = el('button', { class: 'icon-btn', style: 'color:#fff', onclick: () => close() }, icon('close'));
    const delBtn = el('button', { class: 'icon-btn', style: 'color:#ff5d7a' }, icon('trash', 19));
    let timer = null, rafStart = 0, paused = false, videoEl = null;

    function close() { cancelAnimationFrame(raf); clearTimeout(timer); bd.remove(); load(); }
    let raf;

    function show(i) {
      idx = (i + stories.length) % stories.length;
      const s = stories[idx];
      clearTimeout(timer); cancelAnimationFrame(raf);
      bars.innerHTML = ''; stage.innerHTML = ''; videoEl = null;
      const storyDur = s.attachment?.mime?.startsWith('video') ? null : 5200;

      // progress bars
      for (let k = 0; k < stories.length; k++) {
        const b = el('i');
        if (k < idx) b.append(el('b', { style: 'transform:scaleX(1)' }));
        bars.append(b);
      }
      const cur = el('b'); bars.children[idx].append(cur);

      // top bar
      top.innerHTML = '';
      const user = s.isMine ? State.user : s.user;
      top.append(avatarEl(user, 'sm'), el('div', { style: 'flex:1' },
        el('div', { style: 'font-weight:700;color:#fff;font-size:14px' }, user.displayName),
        el('span', { class: 'story-expiry', style: 'color:#fff' }, fmtRelative(s.createdAt) + ' · expires ' + new Date(s.expiresAt.replace(' ', 'T') + 'Z').toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))),
        s.isMine ? viewersBtn : null, s.isMine ? delBtn : null, closeBtn);
      viewersBtn.onclick = () => showViewers(s);
      delBtn.onclick = async () => {
        if (!(await confirmModal('Delete story?', 'It will disappear for everyone.'))) return;
        const r = await DEL('/api/stories/' + s.id);
        if (r.ok) { toast('Deleted', 'ok'); close(); } else toastErr(r);
      };

      // stage
      const url = mediaUrlSync(s.attachment.id);
      if (s.attachment.mime.startsWith('video')) {
        videoEl = el('video', { src: url, autoplay: '', playsinline: '' });
        videoEl.addEventListener('pause', () => { paused = true; });
        videoEl.addEventListener('play', () => { paused = false; });
        videoEl.addEventListener('ended', () => show(idx + 1));
        stage.append(videoEl);
      } else {
        stage.append(el('img', { src: url, alt: '' }));
      }
      captionEl.textContent = s.caption || '';

      // mark viewed
      if (!s.isMine) POST('/api/stories/' + s.id + '/view');

      // progress animation
      const DUR = storyDur || 15000;
      rafStart = performance.now();
      const tick = (t) => {
        if (paused) { rafStart = t - (rafStart ? (t - rafStart) : 0); raf = requestAnimationFrame(tick); return; }
        const frac = Math.min(1, (t - rafStart) / DUR);
        cur.style.transform = `scaleX(${frac})`;
        if (frac >= 1) show(idx + 1);
        else raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    }

    function showViewers(s) {
      sheet({
        title: 'Story viewers',
        body: async (close) => {
          const w = el('div');
          const r = await GET('/api/stories/' + s.id + '/viewers');
          w.append(el('div', { style: 'color:var(--text-2);font-size:13px;padding:2px 8px 8px' }, (r.ok ? r.data.viewers.length : 0) + ' view' + ((r.ok ? r.data.viewers.length : 0) === 1 ? '' : 's')));
          if (r.ok) for (const v of r.data.viewers) {
            w.append(el('div', { class: 'row-item' },
              avatarEl(v, 'sm'),
              el('div', { class: 'row-main' }, el('div', { class: 'row-title' }, el('span', { class: 'name' }, v.displayName)), el('div', { class: 'row-sub' }, '@' + v.username)),
              v.reaction ? el('span', { style: 'font-size:20px' }, v.reaction) : null));
          }
          return w;
        },
      });
    }

    // bottom: reply + reactions
    const reply = el('input', { class: 'story-reply', placeholder: 'Reply to story…' });
    reply.addEventListener('keydown', async (e) => {
      if (e.key !== 'Enter' || !reply.value.trim()) return;
      const s = stories[idx];
      // open DM with story owner and send message referencing the story
      const r = await POST('/api/chats/direct', { userId: s.user.id });
      if (r.ok) {
        const chatId = r.data.chat.id;
        await POST(`/api/messages/chat/${chatId}`, {
          kind: 'text', text: '↪️ ' + reply.value.trim(),
          replyToId: null, fwdFrom: { name: s.user.displayName + ' · Story', messageId: s.id },
        });
        toast('Reply sent', 'ok');
        reply.value = '';
      } else toastErr(r);
    });
    const emojis = el('div', { class: 'story-emoji-row' });
    for (const em of ['❤️', '🔥', '😂', '😮', '🙏']) {
      emojis.append(el('button', {
        onclick: async () => {
          const s = stories[idx];
          if (s.isMine) return;
          const r = await POST(`/api/stories/${s.id}/react`, { emoji: em });
          if (r.ok) toast('Sent ' + em, 'ok', 1200);
        },
      }, em));
    }
    bottom.append(reply, emojis);

    // nav
    const prev = el('div', { class: 'story-nav prev', onclick: () => show(idx - 1) });
    const next = el('div', { class: 'story-nav next', onclick: () => show(idx + 1) });
    const pauseLayer = el('div', { style: 'position:absolute;left:34%;right:34%;top:60px;bottom:60px;z-index:1', onclick: () => { paused = !paused; if (videoEl) paused ? videoEl.pause() : videoEl.play(); } });

    bd.append(bars, top, stage, prev, next, pauseLayer, captionEl, bottom);
    document.body.append(bd);
    show(0);
  }

  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  const userParam = q.get('user');
  await load();
  if (userParam) {
    const r = await GET('/api/stories/user/' + userParam);
    if (r.ok && r.data.stories.length) openViewer({ user: r.data.user, stories: r.data.stories });
  }
  return wrap;
}
