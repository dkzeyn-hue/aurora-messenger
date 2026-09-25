/* ============================================================
   Group / channel info: members, roles, invites, stats, media
   ============================================================ */
import { el, $, $$, icon, toast, toastErr, GET, POST, PATCH, DEL, State, navigate, avatarEl, fmtCount, fmtBytes, mediaUrl } from '../utils.js';
import { appbar, emptyState } from '../app.js';
import { sheet, contextMenu, confirmModal, promptModal, pickUsers } from '../components.js';

export default async function groupInfoView(app, params) {
  const chatId = +params[0];
  const wrap = el('div', { class: 'screen' });
  const content = el('div', { class: 'content' });
  wrap.append(content);

  const r = await GET('/api/chats/' + chatId);
  if (!r.ok) {
    content.append(appbar('Info', { back: '#/chat' }), emptyState('info', 'Chat not found', r.data?.message));
    return wrap;
  }
  let chat = r.data.chat;
  const myRole = chat.myRole;
  const isMod = ['owner', 'admin', 'moderator'].includes(myRole);
  const isAdmin = ['owner', 'admin'].includes(myRole);
  const isOwner = myRole === 'owner' || State.user.role === 'admin';
  wrap.prepend(appbar(chat.type === 'channel' ? 'Channel info' : 'Group info', { back: '#/conversation/' + chatId }));

  function render() {
    content.innerHTML = '';
    // hero
    content.append(el('div', { class: 'profile-hero' },
      avatarEl({ id: chat.id, displayName: chat.name, avatar: chat.avatar }, 'xl', { square: true }),
      el('div', { class: 'profile-name' }, chat.name),
      el('div', { class: 'profile-username' }, chat.username ? '@' + chat.username : (chat.isPublic ? 'public' : 'private ' + chat.type)),
      chat.about ? el('div', { class: 'profile-bio' }, chat.about) : null,
      el('div', { class: 'profile-meta' },
        el('div', {}, el('b', {}, fmtCount(chat.memberCount)), chat.type === 'channel' ? 'subscribers' : 'members'),
        el('div', {}, el('b', {}, chat.isPublic ? 'Public' : 'Private'), 'visibility'),
        el('div', {}, el('b', {}, myRole || '—'), 'your role'))));

    // link share
    const actions = el('div', { class: 'profile-actions' });
    if (chat.isPublic && chat.username) {
      actions.append(el('button', {
        class: 'btn btn-ghost', onclick: () => {
          const link = location.origin + '/c/' + chat.username;
          if (navigator.share) navigator.share({ title: chat.name, url: link }).catch(() => {});
          else { navigator.clipboard?.writeText(link); toast('Link copied', 'ok'); }
        },
      }, icon('link', 17), 'Share link'));
    }
    if (isAdmin) {
      actions.append(el('button', { class: 'btn btn-ghost', onclick: editSheet }, icon('edit', 17), 'Edit'));
      actions.append(el('button', { class: 'btn btn-ghost', onclick: inviteSheet }, icon('plus', 17), 'Invite'));
    }
    if (chat.type === 'channel' && chat.myRole) {
      // subscribe/unsubscribe for non-admins
    }
    if (!chat.myRole && chat.type === 'channel' && chat.isPublic) {
      actions.append(el('button', {
        class: 'btn btn-primary', onclick: async () => {
          const res = await POST(`/api/chats/${chat.id}/join`, {});
          if (res.ok) { toast('Subscribed to ' + chat.name, 'ok'); chat.myRole = 'member'; render(); }
          else toastErr(res);
        },
      }, icon('megaphone', 17), 'Subscribe'));
    }
    if (chat.myRole) {
      actions.append(el('button', {
        class: 'btn btn-danger', onclick: async () => {
          if (!(await confirmModal(`Leave ${chat.type}?`, 'You will stop receiving messages here.'))) return;
          const res = await POST(`/api/chats/${chatId}/leave`);
          if (res.ok) { toast('Left', 'ok'); navigate('#/chat', true); }
          else toastErr(res);
        },
      }, icon('logout', 17), 'Leave'));
    }
    content.append(actions);

    // stats for channel admins
    if (chat.type === 'channel' && isAdmin) {
      content.append(el('div', { class: 'section-label' }, 'Statistics'));
      const g = el('div', { class: 'stat-grid', style: 'padding:0 12px' });
      g.append(el('div', { class: 'skel', style: 'height:100px' }));
      content.append(g);
      GET('/api/chats/' + chatId + '/stats').then((sr) => {
        if (!sr.ok) return;
        const s = sr.data.stats;
        g.innerHTML = '';
        const cards = [
          [fmtCount(s.members), 'members'], [s.posts, 'posts'],
          [fmtCount(s.totalViews), 'total views'], [s.reactions, 'reactions'],
        ];
        for (const [v, label] of cards) g.append(el('div', { class: 'stat-card' }, el('b', {}, String(v)), el('span', {}, label)));
        if (s.last7DaysMembers?.length) {
          const chart = el('div', { class: 'stat-card', style: 'grid-column:1/-1' }, el('span', {}, 'New members · last 7 days'));
          const bars = el('div', { class: 'mini-chart' });
          const max = Math.max(...s.last7DaysMembers.map(x => x.c), 1);
          for (const d of s.last7DaysMembers) bars.append(el('i', { style: `height:${(d.c / max) * 100}%` }));
          chart.append(bars);
          g.append(chart);
        }
      });
    }

    // media grid
    content.append(el('div', { class: 'section-label' }, 'Media, files & voice'));
    const mediaGroup = el('div', { class: 'set-group' });
    mediaGroup.append(el('div', { class: 'skel', style: 'height:90px;margin:10px' }));
    content.append(mediaGroup);
    GET(`/api/chats/${chatId}/media`).then((mr) => {
      mediaGroup.innerHTML = '';
      if (!mr.ok || !mr.data.items.length) {
        mediaGroup.append(el('div', { style: 'padding:18px;text-align:center;color:var(--text-3);font-size:13px' }, 'No shared media yet'));
        return;
      }
      const grid = el('div', { style: 'display:grid;grid-template-columns:repeat(3,1fr);gap:4px;padding:8px' });
      for (const m of mr.data.items.slice(0, 18)) {
        if (!m.attachment) continue;
        if (m.attachment.kind === 'image') {
          grid.append(el('img', { src: m.attachment.url, loading: 'lazy', style: 'width:100%;height:96px;object-fit:cover;border-radius:9px;cursor:pointer', onclick: () => navigate('#/conversation/' + chatId + '?jump=' + m.id) }));
        } else {
          grid.append(el('div', {
            style: 'width:100%;height:96px;border-radius:9px;background:var(--bg-3);display:flex;flex-direction:column;align-items:center;justify-content:center;color:var(--text-3);cursor:pointer;font-size:11px;text-align:center;padding:4px',
            onclick: () => navigate('#/conversation/' + chatId + '?jump=' + m.id),
          }, icon(m.attachment.kind === 'video' ? 'video' : m.attachment.kind === 'voice' ? 'mic' : 'file', 22), (m.attachment.filename || m.attachment.kind).slice(0, 14)));
        }
      }
      mediaGroup.append(grid);
    });

    // members
    if (chat.type !== 'direct') {
      content.append(el('div', { class: 'section-label' }, 'Members'));
      const mg = el('div', { class: 'set-group' });
      mg.append(el('div', { class: 'skel', style: 'height:140px;margin:10px' }));
      content.append(mg);
      GET(`/api/chats/${chatId}/members?limit=100`).then((mres) => {
        mg.innerHTML = '';
        if (!mres.ok) return;
        for (const u of mres.data.members) {
          const row = el('div', {
            class: 'set-row',
            onclick: () => u.id !== State.user.id && navigate('#/user/' + u.username),
            oncontextmenu: (e) => {
              if (!isMod || u.id === State.user.id) return;
              e.preventDefault();
              memberMenu(e, u);
            },
          },
          avatarEl(u, 'sm'),
          el('div', { class: 'set-main' },
            el('div', { class: 'set-title' }, u.displayName + (u.id === chat.ownerId ? ' 👑' : '')),
            el('div', { class: 'set-sub' }, '@' + u.username + (u.mutedUntil && u.mutedUntil > new Date().toISOString().slice(0, 19) ? ' · 🔇 muted' : ''))),
          el('span', { class: 'badge-role' + (u.role === 'owner' ? ' admin' : '') }, u.role));
          mg.append(row);
        }
        if (isAdmin) {
          mg.append(el('button', {
            class: 'ctx-item', style: 'width:100%;justify-content:center;color:var(--accent)',
            onclick: () => pickUsers({
              title: 'Add members', exclude: mres.data.members.map(m => m.id),
              onDone: async (ids) => { if (!ids.length) return; const res = await POST(`/api/chats/${chatId}/members`, { userIds: ids }); toast(res.ok ? 'Added' : res.data?.message, res.ok ? 'ok' : 'err'); render(); },
            }),
          }, icon('plus', 18), 'Add members'));
        }
      });
    }

    // settings: slow mode (groups)
    if (chat.type === 'group' && isAdmin) {
      content.append(el('div', { class: 'section-label' }, 'Admin tools'));
      const sg = el('div', { class: 'set-group' });
      sg.append(el('div', { class: 'set-row', onclick: async () => {
        const v = await promptModal({ title: 'Slow mode', text: 'Members can send one message per interval. 0 disables.', value: String(chat.settings?.slowMode || 0), okLabel: 'Set' });
        if (v === null) return;
        const res = await PATCH('/api/chats/' + chatId, { settings: { slowMode: +v || 0 } });
        if (res.ok) { chat = res.data.chat; toast('Slow mode updated', 'ok'); render(); } else toastErr(res);
      } },
      el('div', { class: 'set-icon' }, icon('clock', 17)),
      el('div', { class: 'set-main' }, el('div', { class: 'set-title' }, 'Slow mode'), el('div', { class: 'set-sub' }, chat.settings?.slowMode ? `every ${chat.settings.slowMode}s` : 'off')),
      el('span', { class: 'set-value' }, 'Change')));

      if (chat.type === 'channel') {
        sg.append(el('div', { class: 'set-row', onclick: async () => {
          const res = await PATCH('/api/chats/' + chatId, { settings: { commentsEnabled: !(chat.settings?.commentsEnabled !== false) } });
          if (res.ok) { chat = res.data.chat; render(); }
        } },
        el('div', { class: 'set-icon' }, icon('chat', 17)),
        el('div', { class: 'set-main' }, el('div', { class: 'set-title' }, 'Comments'), el('div', { class: 'set-sub' }, chat.settings?.commentsEnabled !== false ? 'enabled' : 'disabled'))));
      }
      content.append(sg);
    }

    // invite links
    if (isMod) {
      content.append(el('div', { class: 'section-label' }, 'Invite links'));
      const ig = el('div', { class: 'set-group' });
      ig.append(el('div', { class: 'skel', style: 'height:60px;margin:10px' }));
      content.append(ig);
      GET(`/api/chats/${chatId}/invites`).then((ir) => {
        ig.innerHTML = '';
        if (ir.ok) {
          for (const inv of ir.data.invites) {
            ig.append(el('div', { class: 'set-row' },
              el('div', { class: 'set-icon' }, icon('link', 17)),
              el('div', { class: 'set-main' },
                el('div', { class: 'set-title', style: 'user-select:all' }, location.origin + '/join/' + inv.code),
                el('div', { class: 'set-sub' }, `${inv.uses} uses${inv.maxUses ? ' / ' + inv.maxUses : ''}`)),
              el('button', {
                class: 'icon-btn danger', onclick: async () => {
                  if (!(await confirmModal('Revoke link?', 'Anyone with this link will no longer be able to join.'))) return;
                  const res = await DEL(`/api/chats/${chatId}/invites/${inv.code}`);
                  if (res.ok) { toast('Revoked', 'ok'); render(); }
                },
              }, icon('trash', 17))));
          }
        }
        ig.append(el('button', {
          class: 'ctx-item', style: 'width:100%;justify-content:center;color:var(--accent)',
          onclick: async () => {
            const res = await POST(`/api/chats/${chatId}/invites`, {});
            if (res.ok) { render(); toast('Invite link created', 'ok'); }
          },
        }, icon('plus', 18), 'New invite link'));
      });
    }

    // danger: delete chat (owner)
    if (isOwner) {
      content.append(el('div', { class: 'section-label' }, 'Danger zone'));
      content.append(el('div', { class: 'set-group' },
        el('div', {
          class: 'set-row', onclick: async () => {
            if (!(await confirmModal('Delete ' + chat.type + '?', `This permanently removes "${chat.name}" and all its messages for everyone.`))) return;
            const res = await DEL('/api/chats/' + chatId);
            if (res.ok) { toast('Deleted', 'ok'); navigate('#/chat', true); } else toastErr(res);
          },
        },
        el('div', { class: 'set-icon', style: 'background:rgba(255,93,122,.14);color:var(--danger)' }, icon('trash', 17)),
        el('div', { class: 'set-main' }, el('div', { class: 'set-title', style: 'color:var(--danger)' }, 'Delete ' + chat.type)))));
    }
  }

  function memberMenu(e, u) {
    contextMenu(e.clientX, e.clientY, [
      { label: 'Message', icon: 'chat', onClick: async () => { const r2 = await POST('/api/chats/direct', { userId: u.id }); if (r2.ok) navigate('#/conversation/' + r2.data.chat.id); } },
      { sep: true },
      isAdmin && u.role !== 'owner' ? { label: 'Promote to admin', icon: 'star', onClick: () => setRole(u, 'admin') } : null,
      isAdmin && u.role !== 'owner' ? { label: 'Make moderator', icon: 'shield', onClick: () => setRole(u, 'moderator') } : null,
      isAdmin && u.role !== 'owner' ? { label: 'Demote to member', icon: 'chevron', onClick: () => setRole(u, 'member') } : null,
      u.mutedUntil ? { label: 'Unmute', icon: 'bell', onClick: async () => { const r2 = await PATCH(`/api/chats/${chatId}/members/${u.id}`, { unmute: true }); r2.ok ? render() : toastErr(r2); } }
        : { label: 'Mute 1 hour', icon: 'mute', onClick: async () => { const r2 = await PATCH(`/api/chats/${chatId}/members/${u.id}`, { mutedMinutes: 60 }); r2.ok ? (toast('Muted', 'ok'), render()) : toastErr(r2); } },
      u.banned ? { label: 'Unban', icon: 'check', onClick: async () => { const r2 = await PATCH(`/api/chats/${chatId}/members/${u.id}`, { unban: true }); r2.ok ? render() : toastErr(r2); } }
        : { label: 'Ban from chat', icon: 'block', danger: true, onClick: async () => { const r2 = await DEL(`/api/chats/${chatId}/members/${u.id}?ban=1`); r2.ok ? (toast('Banned', 'ok'), render()) : toastErr(r2); } },
      { label: 'Remove from chat', icon: 'trash', danger: true, onClick: async () => { const r2 = await DEL(`/api/chats/${chatId}/members/${u.id}`); r2.ok ? (toast('Removed', 'ok'), render()) : toastErr(r2); } },
    ].filter(Boolean));
  }
  async function setRole(u, role) {
    const r2 = await PATCH(`/api/chats/${chatId}/members/${u.id}`, { role });
    if (r2.ok) { toast(`${u.displayName} is now ${role}`, 'ok'); render(); } else toastErr(r2);
  }

  function editSheet() {
    sheet({
      title: 'Edit ' + chat.type,
      body: (close) => {
        const w = el('div');
        const nameIn = el('input', { value: chat.name, style: INP });
        const aboutIn = el('input', { value: chat.about, style: INP + ';margin-top:9px' });
        const publicT = el('input', { type: 'checkbox' });
        publicT.checked = !!chat.isPublic;
        const unameIn = el('input', { value: chat.username || '', style: 'flex:1;padding:11px 0;background:none;border:0;outline:none;color:var(--text)' });
        w.append(
          el('div', { class: 'field' }, el('label', {}, 'Name'), nameIn),
          el('div', { class: 'field' }, el('label', {}, 'Description'), aboutIn),
          el('div', { class: 'set-group', style: 'margin:0' },
            el('div', { class: 'set-row', style: 'cursor:default' },
              el('div', { class: 'set-icon' }, icon('globe', 17)),
              el('div', { class: 'set-main' }, el('div', { class: 'set-title' }, 'Public & discoverable'), el('div', { class: 'set-sub' }, 'Appear in search and via link')),
              el('label', { class: 'toggle' }, publicT, el('i'))),
            el('div', { class: 'set-row', style: 'cursor:default' },
              el('div', { class: 'set-main' }, el('div', { class: 'set-title' }, 'Link'), el('div', { class: 'input-wrap', style: 'margin-top:6px' }, el('span', { class: 'prefix' }, '@'), unameIn)))),
          el('button', {
            class: 'btn btn-primary btn-block mt-16', onclick: async () => {
              const res = await PATCH('/api/chats/' + chatId, {
                name: nameIn.value.trim(), about: aboutIn.value.trim(),
                isPublic: publicT.checked, username: publicT.checked ? unameIn.value.trim().toLowerCase() : undefined,
              });
              if (res.ok) { chat = res.data.chat; close(); render(); toast('Saved', 'ok'); } else toastErr(res);
            },
          }, 'Save'));
        return w;
      },
    });
  }
  function inviteSheet() {
    pickUsers({
      title: 'Invite to ' + chat.name,
      onDone: async (ids) => { if (!ids.length) return; const res = await POST(`/api/chats/${chatId}/members`, { userIds: ids }); toast(res.ok ? 'Invited' : res.data?.message, res.ok ? 'ok' : 'err'); render(); },
    });
  }
  const INP = 'width:100%;padding:11px 14px;border-radius:12px;border:1.5px solid var(--line);background:var(--bg-3);outline:none;color:var(--text)';

  render();
  return wrap;
}
