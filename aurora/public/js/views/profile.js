/* ============================================================
   User profile view: #/user/:username (also for own profile)
   ============================================================ */
import { el, $, icon, toast, toastErr, GET, POST, PATCH, DEL, State, navigate, avatarEl, fmtRelative, fmtCount } from '../utils.js';
import { appbar, emptyState } from '../app.js';
import { contextMenu, confirmModal, sheet, pickUsers } from '../components.js';

export default async function profileView(app, params) {
  const usernameOrId = params[0];
  const wrap = el('div', { class: 'screen' });
  const content = el('div', { class: 'content' });
  wrap.append(content);

  const r = await GET('/api/users/' + encodeURIComponent(usernameOrId));
  if (!r.ok) {
    content.append(appbar('Profile', { back: '#/chat' }), emptyState('info', 'User not found', r.data?.message || 'This account may have been deleted.'));
    return wrap;
  }
  const { user, mutualChats } = r.data;
  const isMe = user.id === State.user.id;

  wrap.prepend(appbar(isMe ? 'My profile' : user.displayName, {
    back: '#/chat',
    actions: [el('button', {
      class: 'icon-btn', onclick: (e) => contextMenu(e.clientX, e.clientY, [
        { label: 'Share profile link', icon: 'link', onClick: () => shareProfile() },
        !isMe ? { label: user.blockedByMe ? 'Unblock' : 'Block', icon: 'block', danger: !user.blockedByMe, onClick: toggleBlock } : null,
        !isMe ? { label: 'Report user', icon: 'report', danger: true, onClick: reportUser } : null,
        !isMe ? { label: 'Mute / restrict', icon: 'mute', onClick: muteSheet } : null,
      ].filter(Boolean)),
    }, icon('more'))],
  }));

  function shareProfile() {
    const link = location.origin + '/u/' + user.username;
    if (navigator.share) navigator.share({ title: user.displayName + ' on Aurora', url: link }).catch(() => {});
    else { navigator.clipboard?.writeText(link); toast('Link copied', 'ok'); }
  }
  async function toggleBlock() {
    const doBlock = !user.blockedByMe;
    if (doBlock && !(await confirmModal('Block ' + user.displayName + '?', 'They will not be able to message you or add you to groups.'))) return;
    const res = doBlock ? await POST(`/api/users/${user.id}/block`) : await DEL(`/api/users/${user.id}/block`);
    toast(res.ok ? (doBlock ? 'Blocked' : 'Unblocked') : res.data?.message, res.ok ? 'ok' : 'err');
    if (res.ok) user.blockedByMe = doBlock;
    render();
  }
  function reportUser() {
    const reasons = ['spam', 'abuse', 'harassment', 'pornography', 'violence', 'scam', 'other'];
    sheet({
      title: 'Report @' + user.username,
      body: (close) => {
        const w = el('div');
        for (const rs of reasons) {
          w.append(el('button', {
            class: 'ctx-item', style: 'width:100%', onclick: async () => {
              const res = await POST('/api/users/report', { targetType: 'user', targetId: user.id, reason: rs });
              close(); toast(res.ok ? 'Report submitted — thank you' : res.data?.message, res.ok ? 'ok' : 'err');
            },
          }, rs[0].toUpperCase() + rs.slice(1)));
        }
        return w;
      },
    });
  }
  function muteSheet() {
    // "restrict" = mute notifications of chats with this user (per-chat mute handled in chat menu); direct restrict in group handled in group info
    sheet({
      title: 'Mute or restrict',
      body: (close) => {
        const w = el('div');
        w.append(el('div', { style: 'color:var(--text-2);font-size:13px;padding:2px 8px 10px' }, 'Choose how to limit interactions with this user.'));
        const opts = [
          ['Mute their DM notifications', async () => {
            const dm = await POST('/api/chats/direct', { userId: user.id });
            if (dm.ok) {
              await POST(`/api/chats/${dm.data.chat.id}/membership`, { notificationsEnabled: false });
              toast('Notifications muted for this chat', 'ok'); close();
            }
          }],
          [user.blockedByMe ? 'Unblock user' : 'Block user', toggleBlock],
        ];
        for (const [label, fn] of opts) {
          w.append(el('button', { class: 'ctx-item', style: 'width:100%', onclick: () => { close(); fn(); } }, label));
        }
        return w;
      },
    });
  }

  function render() {
    content.innerHTML = '';
    // hero
    const av = avatarEl(user, 'xl', { online: user.online && !user.lastSeenHidden });
    if (isMe) {
      av.append(el('button', {
        class: 'avatar-cam', title: 'Upload profile photo', 'aria-label': 'Upload profile photo',
        onclick: (e) => { e.stopPropagation(); changePhoto(); },
      }, icon('camera', 16)));
      av.style.cursor = 'pointer';
      av.addEventListener('click', changePhoto);
    }
    const hero = el('div', { class: 'profile-hero' },
      av,
      el('div', { class: 'profile-name' }, user.displayName, user.role === 'admin' ? el('span', { class: 'badge-role admin' }, 'Admin') : null),
      el('div', { class: 'profile-username' }, '@' + user.username),
      user.bio ? el('div', { class: 'profile-bio' }, user.bio) : null,
      el('div', { class: 'profile-meta' },
        el('div', {}, el('b', {}, user.online && !user.lastSeenHidden ? 'Online' : (user.lastSeenHidden ? 'Hidden' : 'Offline')), 'status'),
        el('div', {}, el('b', {}, user.lastSeen && !user.lastSeenHidden ? fmtRelative(user.lastSeen) : '—'), 'last seen'),
        el('div', {}, el('b', {}, new Date(user.createdAt.replace(' ', 'T') + 'Z').toLocaleDateString([], { month: 'short', year: 'numeric' })), 'joined')));
    content.append(hero);

    // actions
    const actions = el('div', { class: 'profile-actions' });
    if (isMe) {
      actions.append(el('button', { class: 'btn btn-ghost', onclick: editProfileSheet }, icon('edit', 18), 'Edit'));
      actions.append(el('button', { class: 'btn btn-ghost', onclick: () => navigate('#/settings') }, icon('settings', 18), 'Settings'));
    } else if (!user.blockedByMe) {
      actions.append(el('button', {
        class: 'btn btn-primary', onclick: async () => {
          const r2 = await POST('/api/chats/direct', { userId: user.id });
          if (r2.ok) navigate('#/conversation/' + r2.data.chat.id);
          else toastErr(r2);
        },
      }, icon('chat', 18), 'Message'));
      actions.append(el('button', { class: 'btn btn-ghost', onclick: shareProfile }, icon('share', 18), 'Share'));
    } else {
      actions.append(el('button', { class: 'btn btn-danger', onclick: toggleBlock }, icon('block', 18), 'Unblock'));
    }
    content.append(actions);

    // mutual chats
    if (mutualChats?.length) {
      content.append(el('div', { class: 'section-label' }, 'Mutual groups & channels'));
      const g = el('div', { class: 'set-group' });
      for (const c of mutualChats) {
        g.append(el('div', { class: 'set-row', onclick: () => navigate('#/conversation/' + c.id) },
          avatarEl({ id: c.id, displayName: c.name, avatar: c.avatar }, 'sm', { square: true }),
          el('div', { class: 'set-main' }, el('div', { class: 'set-title' }, c.name), el('div', { class: 'set-sub' }, c.type)),
          icon('chevron', 16)));
      }
      content.append(g);
    }

    // stories of this user
    if (!isMe) {
      GET('/api/stories/user/' + user.id).then((sr) => {
        if (sr.ok && sr.data.stories.length) {
          content.append(el('div', { class: 'section-label' }, 'Active stories'));
          const g = el('div', { class: 'set-group' });
          g.append(el('div', {
            class: 'set-row', onclick: () => navigate('#/stories?user=' + user.id),
          }, avatarEl(user, 'sm'), el('div', { class: 'set-main' }, el('div', { class: 'set-title' }, sr.data.stories.length + ' active stor' + (sr.data.stories.length === 1 ? 'y' : 'ies')), el('div', { class: 'set-sub' }, 'tap to view')), icon('chevron', 16)));
          content.append(g);
        }
      });
    }
  }

  /** Tap-avatar shortcut: pick an image, upload it, set it as profile photo. */
  function changePhoto() {
    const inp = el('input', { type: 'file', accept: 'image/*' });
    inp.addEventListener('change', async () => {
      const file = inp.files?.[0];
      if (!file) return;
      try {
        toast('Uploading photo…');
        const { uploadMediaFlow } = await import('../components.js');
        const att = await uploadMediaFlow(file, 'avatar');
        const res = await PATCH('/api/users/me', { avatarAttachmentId: att.id });
        if (res.ok) {
          Object.assign(user, res.data.user);
          State.user = { ...State.user, ...res.data.user };
          render();
          toast('Profile photo updated', 'ok');
        } else toast(res.data?.message || 'Could not update photo', 'err');
      } catch (e) { toast(e.message || 'Upload failed', 'err'); }
    });
    inp.click();
  }

  function editProfileSheet() {
    import('../components.js').then(async ({ sheet, uploadMediaFlow }) => {
      sheet({
        title: 'Edit profile',
        body: (close) => {
          const w = el('div');
          const nameIn = inputRow('Display name', user.displayName);
          const bioIn = inputRow('Bio', user.bio, 'Max 280 characters');
          let avatarFile = null;
          const avWrap = el('div', { style: 'display:flex;align-items:center;gap:14px;margin-bottom:14px' });
          const avPrev = avatarEl(user, 'lg');
          const avBtn = el('button', { class: 'btn btn-sm btn-soft' }, 'Change photo');
          avBtn.addEventListener('click', () => {
            const inp = el('input', { type: 'file', accept: 'image/*' });
            inp.addEventListener('change', async () => {
              avatarFile = inp.files?.[0];
              if (avatarFile) {
                const url = URL.createObjectURL(avatarFile);
                avPrev.innerHTML = ''; avPrev.append(el('img', { src: url }));
              }
            });
            inp.click();
          });
          avWrap.append(avPrev, el('div', {}, avBtn, user.avatar ? el('button', {
            class: 'btn btn-sm btn-ghost', style: 'color:var(--danger);margin-top:6px',
            onclick: async () => {
              const res = await PATCH('/api/users/me', { avatarAttachmentId: null });
              if (res.ok) {
                Object.assign(user, res.data.user);
                State.user = { ...State.user, ...res.data.user };
                close(); render(); toast('Photo removed', 'ok');
              } else toast(res.data?.message, 'err');
            },
          }, 'Remove photo') : null));
          w.append(avWrap, nameIn, bioIn);
          w.append(el('button', {
            class: 'btn btn-primary btn-block mt-16', onclick: async () => {
              const body = {};
              if (nameIn.value.trim() && nameIn.value.trim() !== user.displayName) body.displayName = nameIn.value.trim();
              if (bioIn.value !== user.bio) body.bio = bioIn.value.slice(0, 280);
              try {
                if (avatarFile) {
                  const att = await uploadMediaFlow(avatarFile, 'avatar');
                  body.avatarAttachmentId = att.id;
                }
                if (!Object.keys(body).length) { close(); return; }
                const res = await PATCH('/api/users/me', body);
                if (res.ok) { Object.assign(user, res.data.user); State.user = { ...State.user, ...res.data.user }; close(); render(); toast('Profile updated', 'ok'); }
                else toast(res.data?.message, 'err');
              } catch (e) { toast(e.message || 'Update failed', 'err'); }
            },
          }, 'Save changes'));
          return w;
        },
      });
    });
  }
  function inputRow(label, value, hint) {
    const i = el('input', { value: value || '', style: 'width:100%;padding:11px 14px;border-radius:12px;border:1.5px solid var(--line);background:var(--bg-3);outline:none;color:var(--text)' });
    const f = el('div', { class: 'field' }, el('label', {}, label), i, hint ? el('div', { class: 'hint' }, hint) : null);
    i.value = value || '';
    f.value = '';
    Object.defineProperty(f, 'value', { get: () => i.value });
    return f;
  }

  render();
  return wrap;
}
