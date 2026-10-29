(() => {
  'use strict';

  // ==========================================
  // Константи
  // ==========================================
  const TYPING_STOP_DELAY = 1500;    // бездіяльність до stopTyping
  const TYPING_EMIT_INTERVAL = 1000; // typing не частіше ніж раз на секунду
  const TYPING_EXPIRE = 3500;        // страховка, якщо stopTyping загубився
  const PAGE_SIZE = 50;
  const MAX_MSG_LENGTH = 2000;
  const BASE_TITLE = 'Real-Time Chat';

  // Мають збігатися зі списком дозволених реакцій на сервері
  const REACTIONS = ['\u{1F44D}', '❤️', '\u{1F602}', '\u{1F62E}', '\u{1F622}', '\u{1F64F}'];

  const EMOJIS = [
    '😀', '😁', '😂', '🤣', '😊', '😍', '😘', '😎', '🤔', '😅',
    '😉', '🙂', '🙃', '😴', '😢', '😭', '😡', '🤯', '😱', '🥳',
    '🤝', '👍', '👎', '👏', '🙌', '🙏', '💪', '👀', '🔥', '✨',
    '🎉', '❤️', '💔', '💯', '✅', '❌', '☕', '🍕', '🎵', '🚀'
  ];

  // ==========================================
  // Локальні налаштування (localStorage може бути недоступний)
  // ==========================================
  const store = {
    get(key, fallback) {
      try {
        const value = localStorage.getItem(key);
        return value === null ? fallback : value;
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, value);
      } catch {
        /* ігноруємо */
      }
    }
  };

  function applyTheme(theme) {
    if (theme === 'light' || theme === 'dark') {
      document.documentElement.setAttribute('data-theme', theme);
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
  }
  applyTheme(store.get('theme', 'system'));

  // ==========================================
  // Стан
  // ==========================================
  let socket = null;
  let currentUser = null;
  let activeChat = 'general'; // 'general' | 'g:<id>' | 'u:<username>'
  let sessionStarted = false;

  let users = [];  // { username, lastSeen }
  let groups = []; // { id, title, owner, members }
  const onlineSet = new Set();
  const unread = {};            // chatKey -> кількість
  const chats = new Map();      // chatKey -> { items, hasMore, loaded, loading, loadingOlder, pending, gen }
  const peerReadAt = new Map(); // username -> Date | null

  let composer = { mode: null, msg: null }; // mode: 'reply' | 'edit'
  let typingChat = null;
  let typingStopTimer = null;
  let lastTypingEmit = 0;
  let toastTimer = null;
  let markTimer = null;
  let infoGroupId = null;
  let audioCtx = null;

  const typingMap = new Map(); // "chat|sender" -> { chat, sender, timer }

  // ==========================================
  // DOM
  // ==========================================
  const $ = (id) => document.getElementById(id);
  const authForm = $('authForm');
  const authUsername = $('authUsername');
  const authPassword = $('authPassword');
  const authError = $('authError');
  const rememberMe = $('rememberMe');
  const loginBtn = $('loginBtn');
  const registerBtn = $('registerBtn');
  const logoutBtn = $('logoutBtn');
  const settingsBtn = $('settingsBtn');
  const chatContainer = $('chatContainer');
  const userDisplay = $('userDisplay');
  const searchInput = $('searchInput');
  const generalChatBtn = $('generalChatBtn');
  const generalBadge = $('badge-general');
  const newGroupBtn = $('newGroupBtn');
  const groupsList = $('groupsList');
  const usersList = $('usersList');
  const chatTitle = $('chatTitle');
  const chatSubtitle = $('chatSubtitle');
  const chatInfoBtn = $('chatInfoBtn');
  const backBtn = $('backBtn');
  const messages = $('messages');
  const typingIndicator = $('typingIndicator');
  const composerBar = $('composerBar');
  const composerBarTitle = $('composerBarTitle');
  const composerBarText = $('composerBarText');
  const composerCancel = $('composerCancel');
  const emojiPanel = $('emojiPanel');
  const emojiBtn = $('emojiBtn');
  const chatForm = $('chatForm');
  const messageInput = $('messageInput');
  const msgMenu = $('msgMenu');
  const toast = $('toast');

  const groupDialog = $('groupDialog');
  const groupForm = $('groupForm');
  const groupTitleInput = $('groupTitleInput');
  const groupMembersPick = $('groupMembersPick');
  const groupError = $('groupError');

  const groupInfoDialog = $('groupInfoDialog');
  const groupInfoTitle = $('groupInfoTitle');
  const groupInfoMembers = $('groupInfoMembers');
  const groupAddSection = $('groupAddSection');
  const groupAddPick = $('groupAddPick');
  const groupAddBtn = $('groupAddBtn');
  const groupInfoError = $('groupInfoError');
  const groupLeaveBtn = $('groupLeaveBtn');
  const groupDeleteBtn = $('groupDeleteBtn');

  const settingsDialog = $('settingsDialog');
  const themeSelect = $('themeSelect');
  const soundToggle = $('soundToggle');
  const notifyToggle = $('notifyToggle');
  const notifyHint = $('notifyHint');
  const passwordForm = $('passwordForm');
  const oldPassword = $('oldPassword');
  const newPassword = $('newPassword');
  const passwordMsg = $('passwordMsg');
  const deleteForm = $('deleteForm');
  const deletePassword = $('deletePassword');
  const deleteMsg = $('deleteMsg');

  // ==========================================
  // Утиліти
  // ==========================================
  const h = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  async function api(url, options = {}) {
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      ...options
    });
    let data = {};
    try {
      data = await res.json();
    } catch {
      /* порожня або не-JSON відповідь */
    }
    return { ok: res.ok, data };
  }

  function showToast(text) {
    toast.textContent = text;
    toast.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.add('hidden'), 3500);
  }

  function setMsg(node, text, ok = false) {
    node.textContent = text || '';
    node.classList.toggle('hidden', !text);
    node.classList.toggle('ok', Boolean(ok));
  }

  function formatTime(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
  }

  function formatLastSeen(value) {
    if (!value) return 'не в мережі';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'не в мережі';

    const minutes = Math.floor((Date.now() - date.getTime()) / 60000);
    if (minutes < 1) return 'був(ла) щойно';
    if (minutes < 60) return `був(ла) ${minutes} хв тому`;

    const now = new Date();
    if (date.toDateString() === now.toDateString()) return `був(ла) о ${formatTime(date)}`;
    const yesterday = new Date(now.getTime() - 86400000);
    if (date.toDateString() === yesterday.toDateString()) return `був(ла) вчора о ${formatTime(date)}`;
    return `був(ла) ${date.toLocaleDateString('uk-UA', { day: 'numeric', month: 'short' })}`;
  }

  const isMobile = () => window.matchMedia('(max-width: 768px)').matches;
  const isGroupKey = (key) => key.startsWith('g:');
  const isUserKey = (key) => key.startsWith('u:');
  const groupById = (id) => groups.find((g) => g.id === id);
  const lastSeenOf = (name) => (users.find((u) => u.username === name) || {}).lastSeen || null;

  // Ключ чату -> те, що розуміє сервер (general | g:<id> | username)
  const wireChat = (key) => (isUserKey(key) ? key.slice(2) : key);

  function chatKeyOf(msg) {
    if (msg.kind === 'private') {
      const peer = msg.author === currentUser ? msg.recipient : msg.author;
      return `u:${peer}`;
    }
    return msg.room === 'general' ? 'general' : `g:${msg.room}`;
  }

  function chatState(key) {
    let state = chats.get(key);
    if (!state) {
      state = { items: [], hasMore: false, loaded: false, loading: false, loadingOlder: false, pending: [], gen: 0 };
      chats.set(key, state);
    }
    return state;
  }

  function isValidChat(key) {
    if (key === 'general') return true;
    if (isGroupKey(key)) return Boolean(groupById(key.slice(2)));
    return users.some((u) => u.username === key.slice(2));
  }

  // ==========================================
  // Звук і сповіщення
  // ==========================================
  function unlockAudio() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      audioCtx = audioCtx || new Ctx();
      if (audioCtx.state === 'suspended') audioCtx.resume();
    } catch {
      /* ігноруємо */
    }
  }
  document.addEventListener('click', unlockAudio, { once: true });
  document.addEventListener('keydown', unlockAudio, { once: true });

  function beep() {
    try {
      if (!audioCtx) return;
      if (audioCtx.state === 'suspended') audioCtx.resume();
      const now = audioCtx.currentTime;
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.15, now + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.25);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(now);
      osc.stop(now + 0.26);
    } catch {
      /* ігноруємо */
    }
  }

  function showNotification(title, body, chatKey) {
    if (store.get('notify', '0') !== '1') return;
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    try {
      const n = new Notification(title, { body, tag: chatKey });
      n.onclick = () => {
        window.focus();
        if (isValidChat(chatKey)) switchChat(chatKey);
        n.close();
      };
    } catch {
      /* деякі мобільні браузери не підтримують конструктор */
    }
  }

  function alertNewMessage(msg, key) {
    if (store.get('sound', '1') === '1') beep();
    if (!document.hidden) return;

    let title = msg.author;
    if (key === 'general') title = `${msg.author} · Загальний чат`;
    else if (isGroupKey(key)) {
      const g = groupById(key.slice(2));
      title = `${msg.author} · ${g ? g.title : 'Група'}`;
    }
    showNotification(title, msg.text.slice(0, 120), key);
  }

  // ==========================================
  // Авторизація
  // ==========================================
  function showAuthError(text) {
    authError.textContent = text;
    authError.classList.toggle('hidden', !text);
  }

  function setAuthBusy(busy) {
    loginBtn.disabled = busy;
    registerBtn.disabled = busy;
  }

  async function authRequest(kind) {
    const username = authUsername.value.trim();
    const password = authPassword.value; // пароль не обрізаємо
    if (!username || !password) return showAuthError('Заповніть усі поля!');

    showAuthError('');
    setAuthBusy(true);
    try {
      const { ok, data } = await api(`/api/${kind}`, {
        method: 'POST',
        body: JSON.stringify({ username, password, rememberMe: rememberMe.checked })
      });
      if (ok && data.success) {
        authPassword.value = '';
        startChatSession(data.username);
      } else {
        showAuthError(data.error || 'Сталася помилка');
      }
    } catch {
      showAuthError('Немає зв’язку з сервером');
    } finally {
      setAuthBusy(false);
    }
  }

  authForm.addEventListener('submit', (e) => {
    e.preventDefault();
    authRequest('login');
  });
  registerBtn.addEventListener('click', () => authRequest('register'));

  logoutBtn.addEventListener('click', async () => {
    try {
      await api('/api/logout', { method: 'POST' });
    } finally {
      window.location.reload();
    }
  });

  // ==========================================
  // Бокова панель
  // ==========================================
  function makeBadge(count) {
    const badge = h('span', `unread-badge${count > 0 ? '' : ' hidden'}`, count > 99 ? '99+' : String(count));
    return badge;
  }

  function makeChatItem({ key, icon, online, label, sub, count }) {
    const item = h('div', `user-item${activeChat === key ? ' active' : ''}`);
    item.setAttribute('role', 'button');
    item.tabIndex = 0;
    item.dataset.chat = key;

    if (icon) {
      item.appendChild(h('span', 'item-icon', icon));
    } else {
      item.appendChild(h('span', `status-dot${online ? ' online' : ''}`));
    }

    const main = h('div', 'item-main');
    main.appendChild(h('div', 'item-name', label));
    if (sub) main.appendChild(h('div', 'item-sub', sub));
    item.appendChild(main);
    item.appendChild(makeBadge(count));

    item.addEventListener('click', () => switchChat(key));
    item.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        switchChat(key);
      }
    });
    return item;
  }

  function renderSidebar() {
    const query = searchInput.value.trim().toLowerCase();

    generalChatBtn.classList.toggle('active', activeChat === 'general');
    const generalCount = unread.general || 0;
    generalBadge.textContent = generalCount > 99 ? '99+' : String(generalCount);
    generalBadge.classList.toggle('hidden', generalCount === 0);

    // Групи
    const groupNodes = groups
      .filter((g) => !query || g.title.toLowerCase().includes(query))
      .map((g) =>
        makeChatItem({
          key: `g:${g.id}`,
          icon: '👥',
          label: g.title,
          sub: `${g.members.length} учасн.`,
          count: unread[`g:${g.id}`] || 0
        })
      );
    if (!groupNodes.length) {
      groupNodes.push(h('div', 'list-note', groups.length ? 'Нічого не знайдено' : 'Груп ще немає'));
    }
    groupsList.replaceChildren(...groupNodes);

    // Користувачі: онлайн вгорі, далі за алфавітом
    const sorted = users
      .filter((u) => !query || u.username.toLowerCase().includes(query))
      .sort(
        (a, b) =>
          Number(onlineSet.has(b.username)) - Number(onlineSet.has(a.username)) ||
          a.username.localeCompare(b.username, 'uk')
      );

    const userNodes = sorted.map((u) => {
      const online = onlineSet.has(u.username);
      return makeChatItem({
        key: `u:${u.username}`,
        online,
        label: u.username,
        sub: online ? 'в мережі' : formatLastSeen(u.lastSeen),
        count: unread[`u:${u.username}`] || 0
      });
    });
    if (!userNodes.length) {
      userNodes.push(h('div', 'list-note', users.length ? 'Нікого не знайдено' : 'Поки немає інших користувачів'));
    }
    usersList.replaceChildren(...userNodes);
  }

  function updateDocumentTitle() {
    const total = Object.values(unread).reduce((sum, n) => sum + n, 0);
    document.title = total > 0 ? `(${total}) ${BASE_TITLE}` : BASE_TITLE;
  }

  function updateHeader() {
    let title;
    let sub = '';
    let online = false;

    if (activeChat === 'general') {
      title = '📢 Загальний чат';
      sub = 'Усі користувачі';
    } else if (isGroupKey(activeChat)) {
      const g = groupById(activeChat.slice(2));
      title = `👥 ${g ? g.title : 'Група'}`;
      sub = g ? g.members.join(', ') : '';
    } else {
      const name = activeChat.slice(2);
      title = `💬 ${name}`;
      online = onlineSet.has(name);
      sub = online ? 'в мережі' : formatLastSeen(lastSeenOf(name));
    }

    chatTitle.textContent = title;
    chatSubtitle.textContent = sub;
    chatSubtitle.classList.toggle('online', online);
    chatInfoBtn.classList.toggle('hidden', !isGroupKey(activeChat));
  }

  searchInput.addEventListener('input', renderSidebar);

  // ==========================================
  // Користувачі та групи
  // ==========================================
  function ensureUser(name) {
    if (!name || name === currentUser || users.some((u) => u.username === name)) return;
    users.push({ username: name, lastSeen: null });
    renderSidebar();
  }

  async function loadUsers() {
    try {
      const { ok, data } = await api('/api/users');
      if (!ok) return;
      users = data.map((u) => ({ username: u.username, lastSeen: u.lastSeen }));
    } catch (err) {
      console.error('Помилка завантаження користувачів:', err);
    }
  }

  async function loadGroups() {
    try {
      const { ok, data } = await api('/api/groups');
      if (ok) groups = data;
    } catch (err) {
      console.error('Помилка завантаження груп:', err);
    }
  }

  async function loadUnread() {
    try {
      const { ok, data } = await api('/api/unread');
      if (!ok) return;
      Object.keys(unread).forEach((k) => delete unread[k]);
      unread.general = data.general || 0;
      Object.entries(data.groups || {}).forEach(([id, n]) => {
        unread[`g:${id}`] = n;
      });
      Object.entries(data.peers || {}).forEach(([name, n]) => {
        unread[`u:${name}`] = n;
        ensureUser(name);
      });
    } catch (err) {
      console.error('Помилка завантаження непрочитаних:', err);
    }
  }

  function upsertGroup(group) {
    if (!group || !group.members.includes(currentUser)) {
      if (group) removeGroup(group.id);
      return;
    }
    const idx = groups.findIndex((g) => g.id === group.id);
    if (idx >= 0) groups[idx] = group;
    else groups.push(group);

    renderSidebar();
    if (activeChat === `g:${group.id}`) updateHeader();
    if (infoGroupId === group.id && groupInfoDialog.open) fillGroupInfo();
  }

  function removeGroup(id) {
    groups = groups.filter((g) => g.id !== id);
    chats.delete(`g:${id}`);
    delete unread[`g:${id}`];

    if (infoGroupId === id && groupInfoDialog.open) groupInfoDialog.close();
    if (activeChat === `g:${id}`) {
      showToast('Групу видалено, або ви більше не її учасник');
      switchChat('general', { keepMobileList: true });
    } else {
      renderSidebar();
    }
    updateDocumentTitle();
  }

  // ==========================================
  // Повідомлення: відображення
  // ==========================================
  function isNearBottom() {
    return messages.scrollHeight - messages.scrollTop - messages.clientHeight < 120;
  }

  function scrollToBottom() {
    messages.scrollTop = messages.scrollHeight;
  }

  function makeQuote(reply) {
    const quote = h('div', 'reply-quote');
    quote.dataset.replyId = reply.id;
    quote.appendChild(h('strong', '', reply.author));
    quote.appendChild(h('span', '', reply.text || 'Повідомлення видалено'));
    quote.addEventListener('click', () => jumpTo(reply.id));
    return quote;
  }

  function jumpTo(id) {
    const target = messages.querySelector(`.message[data-id="${id}"]`);
    if (!target) {
      showToast('Повідомлення поза завантаженою історією');
      return;
    }
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    target.classList.remove('flash');
    void target.offsetWidth; // перезапуск анімації
    target.classList.add('flash');
    setTimeout(() => target.classList.remove('flash'), 1500);
  }

  function createMessageEl(m) {
    const isSelf = m.author === currentUser;
    const node = h('div', `message ${isSelf ? 'sent' : 'received'}${m.deleted ? ' deleted' : ''}`);
    node.dataset.id = m.id;
    node.dataset.created = m.createdAt;

    if (!isSelf && m.kind === 'room') node.appendChild(h('span', 'author', m.author));
    if (!m.deleted && m.replyTo) node.appendChild(makeQuote(m.replyTo));

    node.appendChild(h('div', 'text', m.deleted ? 'Повідомлення видалено' : m.text));

    const meta = h('div', 'meta');
    if (m.editedAt && !m.deleted) meta.appendChild(h('span', 'edited', 'змінено'));
    meta.appendChild(h('span', 'time', formatTime(m.createdAt)));
    if (isSelf && m.kind === 'private' && !m.deleted) meta.appendChild(h('span', 'ticks'));
    node.appendChild(meta);

    if (!m.deleted) {
      if (m.reactions && m.reactions.length) {
        const row = h('div', 'reactions');
        m.reactions.forEach((r) => {
          const chip = h('button', `reaction${r.users.includes(currentUser) ? ' mine' : ''}`);
          chip.type = 'button';
          chip.title = r.users.join(', ');
          chip.appendChild(h('span', '', r.emoji));
          chip.appendChild(h('span', 'count', String(r.users.length)));
          chip.addEventListener('click', () => react(m, r.emoji));
          row.appendChild(chip);
        });
        node.appendChild(row);
      }

      const more = h('button', 'msg-more', '⋯');
      more.type = 'button';
      more.setAttribute('aria-label', 'Дії з повідомленням');
      more.addEventListener('click', (e) => {
        e.stopPropagation();
        openMenu(m, more);
      });
      node.appendChild(more);
    }
    return node;
  }

  function updateTicks() {
    if (!isUserKey(activeChat)) return;
    const readAt = peerReadAt.get(activeChat.slice(2));
    messages.querySelectorAll('.message.sent').forEach((node) => {
      const ticks = node.querySelector('.ticks');
      if (!ticks) return;
      const read = Boolean(readAt) && new Date(node.dataset.created) <= readAt;
      ticks.textContent = read ? '✓✓' : '✓';
      ticks.classList.toggle('read', read);
      ticks.title = read ? 'Прочитано' : 'Надіслано';
    });
  }

  function makeNote(text) {
    return h('div', 'chat-note', text);
  }

  function makeLoadMore() {
    const btn = h('button', 'load-more', 'Показати старіші повідомлення');
    btn.type = 'button';
    btn.addEventListener('click', loadOlder);
    return btn;
  }

  function renderMessages() {
    const state = chatState(activeChat);
    const fragment = document.createDocumentFragment();

    if (state.hasMore) fragment.appendChild(makeLoadMore());
    state.items.forEach((m) => fragment.appendChild(createMessageEl(m)));
    if (!state.items.length) fragment.appendChild(makeNote('Повідомлень ще немає. Напишіть першим!'));

    messages.replaceChildren(fragment);
    scrollToBottom();
    updateTicks();
  }

  function appendMessage(m) {
    const stick = isNearBottom() || m.author === currentUser;
    const note = messages.querySelector('.chat-note');
    if (note) note.remove();
    messages.appendChild(createMessageEl(m));
    if (stick) scrollToBottom();
    updateTicks();
  }

  // ==========================================
  // Повідомлення: завантаження історії
  // ==========================================
  function historyUrl(key, before) {
    const query = before ? `?before=${encodeURIComponent(before)}&limit=${PAGE_SIZE}` : `?limit=${PAGE_SIZE}`;
    if (isUserKey(key)) return `/api/messages/${encodeURIComponent(key.slice(2))}${query}`;
    const room = key === 'general' ? 'general' : key.slice(2);
    return `/api/rooms/${encodeURIComponent(room)}/messages${query}`;
  }

  async function loadChat(key) {
    const state = chatState(key);
    if (state.loaded) {
      if (activeChat === key) renderMessages();
      return;
    }
    if (activeChat === key) messages.replaceChildren(makeNote('Завантаження...'));
    if (state.loading) return;

    state.loading = true;
    const gen = state.gen;
    try {
      const { ok, data } = await api(historyUrl(key));
      if (gen !== state.gen) return; // сесію скинуто (перепідключення), результат застарів
      if (!ok) throw new Error(data.error || 'history error');

      state.items = data.messages;
      state.hasMore = Boolean(data.hasMore);

      // Додаємо повідомлення, що прийшли під час завантаження
      const ids = new Set(state.items.map((m) => m.id));
      state.pending.forEach((m) => {
        if (!ids.has(m.id)) {
          state.items.push(m);
          ids.add(m.id);
        }
      });
      state.pending = [];

      if (isUserKey(key)) {
        peerReadAt.set(key.slice(2), data.peerRead ? new Date(data.peerRead) : null);
      }
      state.loaded = true;
    } catch (err) {
      if (gen !== state.gen) return;
      console.error('Помилка завантаження історії:', err);
      if (activeChat === key) {
        messages.replaceChildren(makeNote('Не вдалося завантажити історію'));
        showToast('Не вдалося завантажити історію');
      }
      return;
    } finally {
      if (gen === state.gen) state.loading = false;
    }

    if (activeChat === key) renderMessages();
  }

  async function loadOlder() {
    const key = activeChat;
    const state = chatState(key);
    if (!state.loaded || !state.hasMore || state.loadingOlder || !state.items.length) return;

    state.loadingOlder = true;
    const gen = state.gen;
    try {
      const { ok, data } = await api(historyUrl(key, state.items[0].id));
      if (gen !== state.gen) return;
      if (!ok) throw new Error(data.error || 'history error');

      const ids = new Set(state.items.map((m) => m.id));
      const older = data.messages.filter((m) => !ids.has(m.id));
      state.items = [...older, ...state.items];
      state.hasMore = Boolean(data.hasMore);

      if (activeChat === key) {
        const prevHeight = messages.scrollHeight;
        const prevTop = messages.scrollTop;
        const loadMore = messages.querySelector('.load-more');
        const anchor = loadMore ? loadMore.nextSibling : messages.firstChild;

        const fragment = document.createDocumentFragment();
        older.forEach((m) => fragment.appendChild(createMessageEl(m)));
        messages.insertBefore(fragment, anchor);
        if (!state.hasMore && loadMore) loadMore.remove();

        messages.scrollTop = prevTop + (messages.scrollHeight - prevHeight);
        updateTicks();
      }
    } catch (err) {
      console.error('Помилка підвантаження історії:', err);
      showToast('Не вдалося підвантажити старіші повідомлення');
    } finally {
      if (gen === state.gen) state.loadingOlder = false;
    }
  }

  messages.addEventListener('scroll', () => {
    if (messages.scrollTop < 60) loadOlder();
  });

  // ==========================================
  // Повідомлення: події сокета
  // ==========================================
  function handleIncoming(m) {
    const key = chatKeyOf(m);
    const state = chatState(key);
    const mine = m.author === currentUser;

    if (state.items.some((x) => x.id === m.id) || state.pending.some((x) => x.id === m.id)) return;

    if (m.kind === 'private' && !mine) ensureUser(m.author);

    if (state.loaded) state.items.push(m);
    else state.pending.push(m);
    clearTyping(key, m.author);

    const isActive = key === activeChat;
    if (isActive && state.loaded) appendMessage(m);
    if (isActive) updateTypingDisplay();

    if (mine) return;

    if (isActive && !document.hidden) {
      markReadSoon();
    } else {
      unread[key] = (unread[key] || 0) + 1;
      renderSidebar();
      updateDocumentTitle();
      alertNewMessage(m, key);
    }
  }

  function handleUpdated(m) {
    const key = chatKeyOf(m);
    const state = chatState(key);

    const idx = state.items.findIndex((x) => x.id === m.id);
    if (idx >= 0) state.items[idx] = m;
    const pIdx = state.pending.findIndex((x) => x.id === m.id);
    if (pIdx >= 0) state.pending[pIdx] = m;

    if (m.deleted) {
      state.items.forEach((x) => {
        if (x.replyTo && x.replyTo.id === m.id) x.replyTo = { ...x.replyTo, text: '' };
      });
      if (composer.msg && composer.msg.id === m.id) cancelComposer();
    }

    if (key !== activeChat || !state.loaded) return;

    const node = messages.querySelector(`.message[data-id="${m.id}"]`);
    if (node) node.replaceWith(createMessageEl(m));
    if (m.deleted) {
      messages.querySelectorAll(`.reply-quote[data-reply-id="${m.id}"] span`).forEach((s) => {
        s.textContent = 'Повідомлення видалено';
      });
    }
    updateTicks();
  }

  function markReadSoon() {
    clearTimeout(markTimer);
    markTimer = setTimeout(() => {
      if (!socket || document.hidden) return;
      if (unread[activeChat]) {
        unread[activeChat] = 0;
        renderSidebar();
        updateDocumentTitle();
      }
      socket.emit('markRead', { chat: wireChat(activeChat) });
    }, 300);
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && socket) markReadSoon();
  });
  window.addEventListener('focus', () => {
    if (socket) markReadSoon();
  });

  // ==========================================
  // Дії з повідомленнями (меню, реакції, редагування)
  // ==========================================
  function closeMenu() {
    msgMenu.classList.add('hidden');
  }

  function react(m, emoji) {
    if (socket) socket.emit('reactMessage', { id: m.id, kind: m.kind, emoji });
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      showToast('Скопійовано');
    } catch {
      showToast('Не вдалося скопіювати');
    }
  }

  function openMenu(m, anchor) {
    msgMenu.replaceChildren();

    const row = h('div', 'menu-reactions');
    REACTIONS.forEach((emoji) => {
      const btn = h('button', 'menu-emoji', emoji);
      btn.type = 'button';
      btn.addEventListener('click', () => {
        closeMenu();
        react(m, emoji);
      });
      row.appendChild(btn);
    });
    msgMenu.appendChild(row);

    const addAction = (label, handler, danger = false) => {
      const btn = h('button', `menu-action${danger ? ' danger' : ''}`, label);
      btn.type = 'button';
      btn.setAttribute('role', 'menuitem');
      btn.addEventListener('click', () => {
        closeMenu();
        handler();
      });
      msgMenu.appendChild(btn);
    };

    addAction('↩ Відповісти', () => startReply(m));
    addAction('📋 Копіювати', () => copyText(m.text));
    if (m.author === currentUser) {
      addAction('✏️ Редагувати', () => startEdit(m));
      addAction('🗑 Видалити', () => deleteMessage(m), true);
    }

    msgMenu.classList.remove('hidden');
    const rect = anchor.getBoundingClientRect();
    const width = msgMenu.offsetWidth;
    const height = msgMenu.offsetHeight;
    const left = Math.min(Math.max(8, rect.right - width), window.innerWidth - width - 8);
    let top = rect.bottom + 4;
    if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 4);
    msgMenu.style.left = `${left}px`;
    msgMenu.style.top = `${top}px`;
  }

  document.addEventListener('click', (e) => {
    if (!msgMenu.contains(e.target)) closeMenu();
  });
  messages.addEventListener('scroll', closeMenu);
  window.addEventListener('resize', closeMenu);

  function deleteMessage(m) {
    if (!socket) return;
    if (!window.confirm('Видалити повідомлення для всіх?')) return;
    socket.emit('deleteMessage', { id: m.id, kind: m.kind });
  }

  // --- Панель відповіді / редагування ---
  function showComposerBar(title, text) {
    composerBarTitle.textContent = title;
    composerBarText.textContent = text;
    composerBar.classList.remove('hidden');
  }

  function startReply(m) {
    if (composer.mode === 'edit') messageInput.value = '';
    composer = { mode: 'reply', msg: m };
    showComposerBar(`Відповідь для ${m.author}`, m.text);
    messageInput.focus();
  }

  function startEdit(m) {
    composer = { mode: 'edit', msg: m };
    showComposerBar('Редагування повідомлення', m.text);
    messageInput.value = m.text;
    messageInput.focus();
  }

  function cancelComposer() {
    if (composer.mode === 'edit') messageInput.value = '';
    composer = { mode: null, msg: null };
    composerBar.classList.add('hidden');
  }

  composerCancel.addEventListener('click', () => {
    cancelComposer();
    messageInput.focus();
  });

  // --- Емодзі ---
  EMOJIS.forEach((emoji) => {
    const btn = h('button', '', emoji);
    btn.type = 'button';
    btn.addEventListener('click', () => insertAtCursor(emoji));
    emojiPanel.appendChild(btn);
  });

  emojiBtn.addEventListener('click', () => emojiPanel.classList.toggle('hidden'));

  function insertAtCursor(text) {
    const value = messageInput.value;
    const start = messageInput.selectionStart ?? value.length;
    const end = messageInput.selectionEnd ?? start;
    if (value.length - (end - start) + text.length > MAX_MSG_LENGTH) return;

    messageInput.value = value.slice(0, start) + text + value.slice(end);
    const pos = start + text.length;
    messageInput.setSelectionRange(pos, pos);
    messageInput.focus();
  }

  // ==========================================
  // Перемикання чатів
  // ==========================================
  function switchChat(key, options = {}) {
    if (!isValidChat(key)) key = 'general';
    if (typingChat) stopTypingNow();

    activeChat = key;
    unread[key] = 0;

    cancelComposer();
    closeMenu();
    emojiPanel.classList.add('hidden');

    updateHeader();
    renderSidebar();
    updateDocumentTitle();
    updateTypingDisplay();

    if (!options.keepMobileList) chatContainer.classList.add('mobile-chat-open');
    loadChat(key);
    markReadSoon();
    if (!isMobile()) messageInput.focus();
  }

  generalChatBtn.addEventListener('click', () => switchChat('general'));
  generalChatBtn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      switchChat('general');
    }
  });
  backBtn.addEventListener('click', () => chatContainer.classList.remove('mobile-chat-open'));

  // ==========================================
  // Друкування
  // ==========================================
  function setTyping(chat, sender) {
    const key = `${chat}|${sender}`;
    const existing = typingMap.get(key);
    if (existing) clearTimeout(existing.timer);

    const timer = setTimeout(() => {
      typingMap.delete(key);
      updateTypingDisplay();
    }, TYPING_EXPIRE);
    typingMap.set(key, { chat, sender, timer });
  }

  function clearTyping(chat, sender) {
    const key = `${chat}|${sender}`;
    const existing = typingMap.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      typingMap.delete(key);
    }
  }

  function updateTypingDisplay() {
    const names = [...typingMap.values()].filter((t) => t.chat === activeChat).map((t) => t.sender);

    if (!names.length) {
      typingIndicator.classList.add('hidden');
      return;
    }

    let text;
    if (names.length === 1) text = `${names[0]} друкує...`;
    else if (names.length === 2) text = `${names[0]}, ${names[1]} друкують...`;
    else text = 'Кілька людей друкують...';

    typingIndicator.textContent = text;
    typingIndicator.classList.remove('hidden');
  }

  function stopTypingNow() {
    clearTimeout(typingStopTimer);
    lastTypingEmit = 0;
    if (socket && typingChat) socket.emit('stopTyping', { recipient: wireChat(typingChat) });
    typingChat = null;
  }

  messageInput.addEventListener('input', () => {
    if (!socket || composer.mode === 'edit') return;

    const now = Date.now();
    if (now - lastTypingEmit > TYPING_EMIT_INTERVAL) {
      typingChat = activeChat;
      socket.emit('typing', { recipient: wireChat(typingChat) });
      lastTypingEmit = now;
    }

    clearTimeout(typingStopTimer);
    typingStopTimer = setTimeout(stopTypingNow, TYPING_STOP_DELAY);
  });

  messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      cancelComposer();
      emojiPanel.classList.add('hidden');
    }
  });

  // ==========================================
  // Відправка
  // ==========================================
  chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!socket) return;

    const text = messageInput.value.trim();
    if (!text) return;

    if (composer.mode === 'edit') {
      const target = composer.msg;
      if (text !== target.text) {
        socket.emit('editMessage', { id: target.id, kind: target.kind, text });
      }
      composer = { mode: null, msg: null };
      composerBar.classList.add('hidden');
      messageInput.value = '';
      return;
    }

    const replyTo = composer.mode === 'reply' ? composer.msg.id : undefined;

    if (isUserKey(activeChat)) {
      socket.emit('privateMessage', { recipient: activeChat.slice(2), text, replyTo });
    } else {
      const room = activeChat === 'general' ? 'general' : activeChat.slice(2);
      socket.emit('chatMessage', { room, text, replyTo });
    }

    stopTypingNow();
    composer = { mode: null, msg: null };
    composerBar.classList.add('hidden');
    messageInput.value = '';
    messageInput.focus();
  });

  // ==========================================
  // Модальні вікна: загальне
  // ==========================================
  document.addEventListener('click', (e) => {
    const closer = e.target.closest('[data-close]');
    if (closer) {
      const dialog = closer.closest('dialog');
      if (dialog) dialog.close();
    }
  });

  [groupDialog, groupInfoDialog, settingsDialog].forEach((dialog) => {
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) dialog.close(); // клік по затемненню
    });
  });

  function fillPickList(container, names) {
    container.replaceChildren();
    if (!names.length) {
      container.appendChild(h('div', 'pick-note', 'Немає кого додати'));
      return;
    }
    names.forEach((name) => {
      const label = h('label', 'pick-item');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.value = name;
      label.appendChild(box);
      label.appendChild(h('span', '', name));
      container.appendChild(label);
    });
  }

  const checkedValues = (container) =>
    [...container.querySelectorAll('input[type="checkbox"]:checked')].map((box) => box.value);

  // ==========================================
  // Групи: створення та керування
  // ==========================================
  newGroupBtn.addEventListener('click', () => {
    groupTitleInput.value = '';
    setMsg(groupError, '');
    fillPickList(
      groupMembersPick,
      users.map((u) => u.username).sort((a, b) => a.localeCompare(b, 'uk'))
    );
    groupDialog.showModal();
    groupTitleInput.focus();
  });

  groupForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = groupTitleInput.value.trim();
    const members = checkedValues(groupMembersPick);
    if (!title) return setMsg(groupError, 'Введіть назву групи');
    if (!members.length) return setMsg(groupError, 'Оберіть хоча б одного учасника');

    setMsg(groupError, '');
    try {
      const { ok, data } = await api('/api/groups', {
        method: 'POST',
        body: JSON.stringify({ title, members })
      });
      if (!ok) return setMsg(groupError, data.error || 'Не вдалося створити групу');

      groupDialog.close();
      upsertGroup(data);
      switchChat(`g:${data.id}`);
    } catch {
      setMsg(groupError, 'Немає зв’язку з сервером');
    }
  });

  function fillGroupInfo() {
    const group = groupById(infoGroupId);
    if (!group) return;
    const isOwner = group.owner === currentUser;

    groupInfoTitle.textContent = `👥 ${group.title}`;
    groupInfoMembers.replaceChildren(
      ...group.members.map((name) => {
        let label = name;
        if (name === group.owner) label += ' 👑';
        if (name === currentUser) label += ' (ви)';
        return h('li', '', label);
      })
    );

    groupAddSection.classList.toggle('hidden', !isOwner);
    groupDeleteBtn.classList.toggle('hidden', !isOwner);
    if (isOwner) {
      fillPickList(
        groupAddPick,
        users
          .map((u) => u.username)
          .filter((name) => !group.members.includes(name))
          .sort((a, b) => a.localeCompare(b, 'uk'))
      );
    }
  }

  chatInfoBtn.addEventListener('click', () => {
    if (!isGroupKey(activeChat)) return;
    infoGroupId = activeChat.slice(2);
    setMsg(groupInfoError, '');
    fillGroupInfo();
    groupInfoDialog.showModal();
  });

  groupAddBtn.addEventListener('click', async () => {
    const members = checkedValues(groupAddPick);
    if (!members.length) return setMsg(groupInfoError, 'Оберіть, кого додати');

    setMsg(groupInfoError, '');
    try {
      const { ok, data } = await api(`/api/groups/${infoGroupId}/members`, {
        method: 'POST',
        body: JSON.stringify({ members })
      });
      if (!ok) return setMsg(groupInfoError, data.error || 'Не вдалося додати учасників');
      upsertGroup(data);
    } catch {
      setMsg(groupInfoError, 'Немає зв’язку з сервером');
    }
  });

  groupLeaveBtn.addEventListener('click', async () => {
    if (!window.confirm('Вийти з цієї групи?')) return;
    const id = infoGroupId;
    try {
      const { ok, data } = await api(`/api/groups/${id}/leave`, { method: 'POST' });
      if (!ok) return setMsg(groupInfoError, data.error || 'Не вдалося вийти з групи');
      removeGroup(id);
    } catch {
      setMsg(groupInfoError, 'Немає зв’язку з сервером');
    }
  });

  groupDeleteBtn.addEventListener('click', async () => {
    if (!window.confirm('Видалити групу разом з усім листуванням? Це незворотно.')) return;
    const id = infoGroupId;
    try {
      const { ok, data } = await api(`/api/groups/${id}`, { method: 'DELETE' });
      if (!ok) return setMsg(groupInfoError, data.error || 'Не вдалося видалити групу');
      removeGroup(id);
    } catch {
      setMsg(groupInfoError, 'Немає зв’язку з сервером');
    }
  });

  // ==========================================
  // Налаштування
  // ==========================================
  function refreshNotifyUi() {
    const supported = 'Notification' in window;
    const granted = supported && Notification.permission === 'granted';
    notifyToggle.checked = supported && granted && store.get('notify', '0') === '1';

    let hint = '';
    if (!supported) hint = 'Ваш браузер не підтримує сповіщень.';
    else if (Notification.permission === 'denied') hint = 'Сповіщення заблоковані в налаштуваннях браузера для цього сайту.';
    notifyHint.textContent = hint;
    notifyHint.classList.toggle('hidden', !hint);
  }

  settingsBtn.addEventListener('click', () => {
    themeSelect.value = store.get('theme', 'system');
    soundToggle.checked = store.get('sound', '1') === '1';
    refreshNotifyUi();
    setMsg(passwordMsg, '');
    setMsg(deleteMsg, '');
    passwordForm.reset();
    deleteForm.reset();
    settingsDialog.showModal();
  });

  themeSelect.addEventListener('change', () => {
    store.set('theme', themeSelect.value);
    applyTheme(themeSelect.value);
  });

  soundToggle.addEventListener('change', () => {
    store.set('sound', soundToggle.checked ? '1' : '0');
    if (soundToggle.checked) {
      unlockAudio();
      beep();
    }
  });

  notifyToggle.addEventListener('change', async () => {
    if (!notifyToggle.checked) {
      store.set('notify', '0');
      return;
    }
    if (!('Notification' in window)) {
      refreshNotifyUi();
      return;
    }
    try {
      const permission =
        Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
      store.set('notify', permission === 'granted' ? '1' : '0');
    } catch {
      store.set('notify', '0');
    }
    refreshNotifyUi();
  });

  passwordForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    setMsg(passwordMsg, '');
    try {
      const { ok, data } = await api('/api/change-password', {
        method: 'POST',
        body: JSON.stringify({ oldPassword: oldPassword.value, newPassword: newPassword.value })
      });
      if (ok) {
        passwordForm.reset();
        setMsg(passwordMsg, 'Пароль змінено', true);
      } else {
        setMsg(passwordMsg, data.error || 'Не вдалося змінити пароль');
      }
    } catch {
      setMsg(passwordMsg, 'Немає зв’язку з сервером');
    }
  });

  deleteForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    setMsg(deleteMsg, '');
    if (!window.confirm('Видалити акаунт безповоротно?')) return;
    try {
      const { ok, data } = await api('/api/delete-account', {
        method: 'POST',
        body: JSON.stringify({ password: deletePassword.value })
      });
      if (ok) window.location.reload();
      else setMsg(deleteMsg, data.error || 'Не вдалося видалити акаунт');
    } catch {
      setMsg(deleteMsg, 'Немає зв’язку з сервером');
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeMenu();
  });

  // ==========================================
  // Socket.IO
  // ==========================================
  async function onConnect() {
    // Після (пере)підключення дані могли застаріти: скидаємо кеші історії
    chats.forEach((state) => {
      state.gen += 1;
      state.loaded = false;
      state.loading = false;
      state.loadingOlder = false;
      state.pending = [];
    });

    await Promise.all([loadUsers(), loadGroups(), loadUnread()]);

    if (!isValidChat(activeChat)) activeChat = 'general';
    const visible = !document.hidden;
    if (visible) unread[activeChat] = 0;

    updateHeader();
    renderSidebar();
    updateDocumentTitle();
    loadChat(activeChat);
    if (visible) markReadSoon();
  }

  function startChatSession(username) {
    if (sessionStarted) return;
    sessionStarted = true;

    currentUser = username;
    authForm.classList.add('hidden');
    chatContainer.classList.remove('hidden');
    userDisplay.textContent = username;
    updateHeader();
    renderSidebar();

    socket = io();

    socket.on('connect', onConnect);

    socket.on('connect_error', (err) => {
      if (err && err.message === 'Auth error') window.location.reload();
    });

    socket.on('message', handleIncoming);
    socket.on('messageUpdated', handleUpdated);

    socket.on('onlineUsers', (list) => {
      onlineSet.clear();
      list.forEach((name) => onlineSet.add(name));
      renderSidebar();
      updateHeader();
    });

    socket.on('userRegistered', ({ username: name }) => ensureUser(name));

    socket.on('userRemoved', ({ username: name }) => {
      users = users.filter((u) => u.username !== name);
      chats.delete(`u:${name}`);
      delete unread[`u:${name}`];
      if (activeChat === `u:${name}`) {
        showToast(`Користувач ${name} видалив акаунт`);
        switchChat('general', { keepMobileList: true });
      } else {
        renderSidebar();
        updateDocumentTitle();
      }
    });

    socket.on('lastSeen', ({ username: name, at }) => {
      const user = users.find((u) => u.username === name);
      if (user) user.lastSeen = at;
      renderSidebar();
      updateHeader();
    });

    socket.on('groupUpdated', upsertGroup);
    socket.on('groupRemoved', ({ id }) => removeGroup(id));

    socket.on('peerRead', ({ peer, at }) => {
      peerReadAt.set(peer, new Date(at));
      if (activeChat === `u:${peer}`) updateTicks();
    });

    socket.on('unreadCleared', ({ chat }) => {
      const key = chat === 'general' || chat.startsWith('g:') ? chat : `u:${chat}`;
      if (unread[key]) {
        unread[key] = 0;
        renderSidebar();
        updateDocumentTitle();
      }
    });

    socket.on('typing', (data) => {
      const chat =
        data.recipient === 'general' ? 'general' : data.recipient.startsWith('g:') ? data.recipient : `u:${data.sender}`;
      setTyping(chat, data.sender);
      updateTypingDisplay();
    });

    socket.on('stopTyping', (data) => {
      const chat =
        data.recipient === 'general' ? 'general' : data.recipient.startsWith('g:') ? data.recipient : `u:${data.sender}`;
      clearTyping(chat, data.sender);
      updateTypingDisplay();
    });

    socket.on('errorMessage', showToast);

    // Оновлюємо підписи «був(ла) в мережі» раз на хвилину
    setInterval(() => {
      renderSidebar();
      updateHeader();
    }, 60000);
  }

  // ==========================================
  // Перевірка сесії при завантаженні
  // ==========================================
  (async () => {
    try {
      const { ok, data } = await api('/api/me');
      if (ok && data.authenticated) startChatSession(data.username);
    } catch (err) {
      console.error('Помилка перевірки сесії:', err);
    }
  })();
})();