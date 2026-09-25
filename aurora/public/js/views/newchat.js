/* ============================================================
   New chat / group / channel (#/new, #/new/group, #/new/channel)
   ============================================================ */
import { el, $, icon, toast, toastErr, GET, POST, State, navigate, avatarEl, debounce } from '../utils.js';
import { appbar, emptyState } from '../app.js';
import { pickUsers, uploadMediaFlow, compressImage } from '../components.js';

export default async function newChatView(app, params) {
  const mode = params[0] || 'chat'; // chat | group | channel
  const wrap = el('div', { class: 'screen' });

  if (mode === 'chat') {
    // people picker → DM
    wrap.append(appbar('New chat', { back: '#/chat' }));
    const search = el('input', { placeholder: 'Search by @username or name…', autofocus: '' });
    wrap.append(el('div', { class: 'searchbar' }, icon('search', 18), search));
    const content = el('div', { class: 'content list' });
    wrap.append(content);

    function renderPeople(list, isSearch) {
      content.innerHTML = '';
      if (!list.length) {
        content.append(emptyState('search', isSearch ? 'No people found' : 'Find someone', 'Search by @username — e.g. @admin (the official account) or @nova.', null));
        return;
      }
      for (const u of list) {
        content.append(el('div', {
          class: 'row-item', onclick: async () => {
            const r = await POST('/api/chats/direct', { userId: u.id });
            if (r.ok) navigate('#/conversation/' + r.data.chat.id, true);
            else toastErr(r);
          },
        },
        avatarEl(u, '', { online: u.online && !u.lastSeenHidden }),
        el('div', { class: 'row-main' },
          el('div', { class: 'row-title' }, el('span', { class: 'name' }, u.displayName)),
          el('div', { class: 'row-sub' }, '@' + u.username))));
      }
    }
    async function initial() {
      const r = await GET('/api/chats');
      if (r.ok) {
        State.chats = r.data.chats;
        renderPeople(State.chats.filter(c => c.type === 'direct' && c.peer).map(c => c.peer), false);
      } else renderPeople([], false);
    }
    search.addEventListener('input', debounce(async () => {
      if (search.value.trim().length < 2) return initial();
      const r = await GET('/api/users/search/people?q=' + encodeURIComponent(search.value.trim()));
      if (r.ok) renderPeople(r.data.results, true);
    }, 300));
    initial();
    return wrap;
  }

  /* ---- group / channel creation wizard ---- */
  const isChannel = mode === 'channel';
  wrap.append(appbar(isChannel ? 'New channel' : 'New group', { back: '#/new' }));
  const content = el('div', { class: 'content', style: 'padding:16px' });
  wrap.append(content);

  let avatarFile = null, avatarPrev = null;
  const nameIn = el('input', { placeholder: isChannel ? 'Channel name' : 'Group name', style: 'width:100%;padding:13px 15px;border-radius:13px;border:1.5px solid var(--line);background:var(--bg-3);outline:none;font-size:16px;font-weight:600;color:var(--text)' });
  const aboutIn = el('input', { placeholder: 'Description (optional)', style: 'width:100%;padding:12px 15px;border-radius:13px;border:1.5px solid var(--line);background:var(--bg-3);outline:none;color:var(--text);margin-top:10px' });

  const avBtn = el('button', { class: 'btn btn-sm btn-soft' }, icon('camera', 16), 'Add photo');
  avBtn.addEventListener('click', () => {
    const inp = el('input', { type: 'file', accept: 'image/*' });
    inp.addEventListener('change', async () => {
      avatarFile = inp.files?.[0];
      if (avatarFile) {
        const att = await uploadMediaFlow(avatarFile, 'avatar');
        avatarFile = att; // reuse attachment id
        avatarPrev.innerHTML = '';
        avatarPrev.append(el('img', { src: att.url }));
      }
    });
    inp.click();
  });

  const publicToggle = el('input', { type: 'checkbox' });
  const usernameIn = el('input', { placeholder: isChannel ? 'channelname' : 'groupname', spellcheck: 'false' });
  usernameIn.style.cssText = 'flex:1;padding:11px 0;background:none;border:0;outline:none;color:var(--text);min-width:0';
  const unameHint = el('div', { class: 'hint' }, 'Public links let anyone find and join via aurora://' + (isChannel ? 'channel' : 'group') + '/name');

  let memberIds = [];
  const memberStrip = el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-top:8px' });

  content.append(
    el('div', { style: 'display:flex;flex-direction:column;align-items:center;gap:10px;margin-bottom:18px' },
      (() => { avatarPrev = avatarEl({ id: 'new' + (isChannel ? 'c' : 'g'), displayName: nameIn.value || '?' }, 'lg', { square: true }); return avatarPrev; })(),
      avBtn),
    nameIn, aboutIn,
    el('div', { class: 'set-group', style: 'margin:14px 0 0' },
      el('div', { class: 'set-row' },
        el('div', { class: 'set-icon' }, icon('globe', 17)),
        el('div', { class: 'set-main' },
          el('div', { class: 'set-title' }, isChannel ? 'Public channel' : 'Public group'),
          el('div', { class: 'set-sub' }, 'Discoverable in search & via link')),
        el('label', { class: 'toggle' }, publicToggle, el('i')))),
    el('div', { id: 'pub-opts', class: 'set-group hidden', style: 'margin:10px 12px 0;margin-left:0;margin-right:0' },
      el('div', { class: 'set-row', style: 'cursor:default' },
        el('div', { class: 'set-main' },
          el('div', { class: 'set-title' }, 'Public link'),
          el('div', { class: 'input-wrap', style: 'margin-top:6px' }, el('span', { class: 'prefix' }, 'aurora://' + (isChannel ? 'channel/' : 'group/')), usernameIn)),
        null)),
    unameHint,
    el('div', { class: 'section-label', style: 'padding-left:0' }, 'Members'),
    el('button', { class: 'btn btn-ghost btn-block', onclick: () => pickUsers({ title: 'Add members', onDone: (ids) => { memberIds = ids; renderMembers(); } }) }, icon('users', 18), 'Choose people'),
    memberStrip,
  );

  function renderMembers() {
    memberStrip.innerHTML = '';
    for (const uid of memberIds) {
      const chat = State.chats.find(c => c.peer?.id === uid);
      const u = chat?.peer;
      if (u) memberStrip.append(avatarEl(u, 'sm'));
    }
  }

  const submit = el('button', { class: 'btn btn-primary btn-block mt-16' }, icon(isChannel ? 'megaphone' : 'users', 18), isChannel ? 'Create channel' : 'Create group');
  submit.addEventListener('click', async () => {
    const name = nameIn.value.trim();
    if (name.length < 2) return toast('Enter a name (2+ characters)', 'err');
    const isPublic = publicToggle.checked;
    const r = await POST(isChannel ? '/api/chats/channel' : '/api/chats/group', {
      name, about: aboutIn.value.trim(),
      avatarAttachmentId: avatarFile?.id || undefined,
      memberIds,
      isPublic,
      username: isPublic ? usernameIn.value.trim().toLowerCase() : undefined,
    });
    if (r.ok) {
      toast(isChannel ? 'Channel created 🎙' : 'Group created 👥', 'ok');
      navigate('#/conversation/' + r.data.chat.id, true);
    } else toastErr(r);
  });
  content.append(submit);

  publicToggle.addEventListener('change', () => {
    $('#pub-opts', content).classList.toggle('hidden', !publicToggle.checked);
  });

  return wrap;
}
