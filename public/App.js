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

  let users = [];  // { username, lastSeen, contact } — contact: є листування (показується в списку)
  let searchHits = new Set(); // імена, знайдені пошуком (показуються лише під час пошуку)
  let searchToken = 0;
  let searchTimer = null;
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
  let isAdmin = false;
  let myMutedUntil = null; // Date | null
  let muteTimer = null;
  const avatars = new Map(); // username -> id файлу аватара
  let myBio = '';
  let profileOf = null;     // чий профіль відкрито
  let profileAvatarDraft;   // undefined — без змін, null — прибрати, string — нове фото
  let profileUploading = false;
  let pendingAttachment = null; // завантажений, але ще не надісланий файл
  let uploading = false;
  let uploadXhr = null;

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
  const adminBtn = $('adminBtn');
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
  const groupFindInput = $('groupFindInput');
  const groupAddFindInput = $('groupAddFindInput');
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

  const adminDialog = $('adminDialog');
  const muteDuration = $('muteDuration');
  const adminSearch = $('adminSearch');
  const adminUsers = $('adminUsers');
  const adminMsg = $('adminMsg');

  const chatWindow = document.querySelector('.chat-window');
  const myProfileBtn = $('myProfileBtn');
  const chatProfileBtn = $('chatProfileBtn');
  const profileDialog = $('profileDialog');
  const profileAvatar = $('profileAvatar');
  const profileName = $('profileName');
  const profileStatus = $('profileStatus');
  const profileSince = $('profileSince');
  const profileBio = $('profileBio');
  const profileForm = $('profileForm');
  const profileBioInput = $('profileBioInput');
  const profileCounter = $('profileCounter');
  const profilePhotoBtn = $('profilePhotoBtn');
  const profilePhotoRemove = $('profilePhotoRemove');
  const profileFile = $('profileFile');
  const profileMsg = $('profileMsg');
  const profileSave = $('profileSave');
  const profileWriteBtn = $('profileWriteBtn');
  const profileEditBtn = $('profileEditBtn');
  const attachBtn = $('attachBtn');
  const fileInput = $('fileInput');
  const attachBar = $('attachBar');
  const attachIcon = $('attachIcon');
  const attachName = $('attachName');
  const attachSub = $('attachSub');
  const attachProgress = $('attachProgress');
  const attachCancel = $('attachCancel');
  const imageDialog = $('imageDialog');
  const imageDialogImg = $('imageDialogImg');
  const imageDialogDownload = $('imageDialogDownload');

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

  // Аватар: фото або літера імені
  function setAvatarContent(el, name, fileId, srcOverride) {
    el.replaceChildren();
    const src = srcOverride || (fileId ? `/api/files/${fileId}` : null);
    if (src) {
      const img = document.createElement('img');
      img.alt = name;
      img.src = src;
      img.addEventListener('error', () => el.replaceChildren(document.createTextNode(name.charAt(0))));
      el.appendChild(img);
    } else {
      el.textContent = name.charAt(0);
    }
  }

  function makeAvatar(name, fileId, extraClass) {
    const el = h('span', `avatar${extraClass ? ' ' + extraClass : ''}`);
    setAvatarContent(el, name, fileId);
    return el;
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
    showNotification(title, msg.text ? msg.text.slice(0, 120) : attachmentLabel(msg), key);
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
        startChatSession(data.username, data.isAdmin, data);
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

  function makeChatItem({ key, icon, online, label, sub, count, avatarOf }) {
    const item = h('div', `user-item${activeChat === key ? ' active' : ''}`);
    item.setAttribute('role', 'button');
    item.tabIndex = 0;
    item.dataset.chat = key;

    if (icon) {
      item.appendChild(h('span', 'item-icon', icon));
    } else {
      item.appendChild(h('span', `status-dot${online ? ' online' : ''}`));
      if (avatarOf) item.appendChild(makeAvatar(label, avatars.get(label) || null));
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
      .filter((u) => {
        const active = activeChat === `u:${u.username}`;
        const visible = u.contact || active || (query && searchHits.has(u.username));
        return visible && (!query || u.username.toLowerCase().includes(query) || active);
      })
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
        avatarOf: true,
        label: u.username,
        sub: (isAdmin && isMutedUser(u) ? '🔇 мут · ' : '') + (online ? 'в мережі' : formatLastSeen(u.lastSeen)),
        count: unread[`u:${u.username}`] || 0
      });
    });
    if (!userNodes.length) {
      userNodes.push(
        h(
          'div',
          'list-note',
          query
            ? query.length < 2
              ? 'Введіть щонайменше 2 символи для пошуку людей'
              : 'Нікого не знайдено'
            : 'Тут з\u2019являться люди, з якими ви листуєтесь. Знайдіть когось через пошук або в загальному чаті.'
        )
      );
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
    chatProfileBtn.classList.toggle('hidden', !isUserKey(activeChat));
  }

  searchInput.addEventListener('input', () => {
    searchHits = new Set();
    renderSidebar();
    clearTimeout(searchTimer);
    const q = searchInput.value.trim();
    if (q.length < 2) return;
    const token = ++searchToken;
    searchTimer = setTimeout(async () => {
      try {
        const names = await searchPeople(q);
        if (token !== searchToken) return;
        searchHits = new Set(names);
        renderSidebar();
      } catch (err) {
        console.error('Помилка пошуку:', err);
      }
    }, 250);
  });

  // ==========================================
  // Користувачі та групи
  // ==========================================
  // Додає користувача до відомих; contact=true — з'являється в списку (є листування)
  function ensureUser(name, contact = false) {
    if (!name || name === currentUser) return;
    const existing = users.find((u) => u.username === name);
    if (existing) {
      if (contact && !existing.contact) {
        existing.contact = true;
        renderSidebar();
      }
      return;
    }
    users.push({ username: name, lastSeen: null, mutedUntil: null, isAdmin: false, contact });
    if (contact) loadProfileInfo(name);
    renderSidebar();
    if (adminDialog.open) renderAdminList();
  }

  // Дані користувача, якого ми знаємо лише за іменем (аватар, остання активність)
  async function loadProfileInfo(name) {
    try {
      const { ok, data } = await api(`/api/profile/${encodeURIComponent(name)}`);
      if (!ok) return;
      const user = users.find((u) => u.username === name);
      if (user) user.lastSeen = data.lastSeen;
      if (data.avatar) avatars.set(name, data.avatar);
      renderSidebar();
    } catch {
      /* не критично */
    }
  }

  // Пошук людей на сервері; знайдені додаються до відомих (без показу в списку)
  async function searchPeople(query) {
    const { ok, data } = await api(`/api/users/search?q=${encodeURIComponent(query)}`);
    if (!ok || !Array.isArray(data)) return [];
    data.forEach((u) => {
      if (u.username === currentUser) return;
      const existing = users.find((x) => x.username === u.username);
      if (existing) {
        existing.lastSeen = u.lastSeen;
      } else {
        users.push({ username: u.username, lastSeen: u.lastSeen, mutedUntil: null, isAdmin: false, contact: false });
      }
      if (u.avatar) avatars.set(u.username, u.avatar);
    });
    return data.map((u) => u.username).filter((n) => n !== currentUser);
  }

  async function loadUsers() {
    try {
      const { ok, data } = await api('/api/users');
      if (!ok) return;
      const fresh = data.map((u) => ({
        username: u.username,
        lastSeen: u.lastSeen,
        mutedUntil: u.mutedUntil || null, // приходить лише адміністраторам
        isAdmin: Boolean(u.isAdmin),
        contact: u.contact !== false // звичайним користувачам сервер віддає лише контакти
      }));
      // Знайдені пошуком (не контакти) лишаємо, щоб не втратити відкритий чат
      const kept = users.filter((u) => !u.contact && !fresh.some((f) => f.username === u.username));
      users = [...fresh, ...kept];
      data.forEach((u) => {
        if (u.avatar) avatars.set(u.username, u.avatar);
        else avatars.delete(u.username);
      });
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

    if (!isSelf && m.kind === 'room') {
      const author = h('span', 'author clickable', m.author);
      author.title = 'Відкрити профіль';
      author.addEventListener('click', () => openProfile(m.author));
      node.appendChild(author);
    }
    if (!m.deleted && m.replyTo) node.appendChild(makeQuote(m.replyTo));
    if (!m.deleted && m.attachment) node.appendChild(makeAttachment(m.attachment));

    if (m.deleted || m.text) node.appendChild(h('div', 'text', m.deleted ? 'Повідомлення видалено' : m.text));

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

    if (m.kind === 'private') ensureUser(mine ? m.recipient : m.author, true);

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
    if (m.text) addAction('📋 Копіювати', () => copyText(m.text));
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
    showComposerBar(`Відповідь для ${m.author}`, m.text || attachmentLabel(m));
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
    clearAttachment();
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
    if (isMuted()) {
      showToast('Вас вимкнено (мут): надсилати повідомлення не можна');
      return;
    }

    if (uploading) {
      showToast('Дочекайтесь завершення завантаження файлу');
      return;
    }

    const text = messageInput.value.trim();
    const attachment = composer.mode === 'edit' ? null : pendingAttachment;
    if (!text && !attachment) return;

    if (composer.mode === 'edit') {
      if (!text) return;
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
      socket.emit('privateMessage', {
        recipient: activeChat.slice(2),
        text,
        replyTo,
        attachment: attachment ? attachment.id : undefined
      });
    } else {
      const room = activeChat === 'general' ? 'general' : activeChat.slice(2);
      socket.emit('chatMessage', { room, text, replyTo, attachment: attachment ? attachment.id : undefined });
    }

    stopTypingNow();
    resetAttachment();
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

  [groupDialog, groupInfoDialog, settingsDialog, adminDialog, imageDialog, profileDialog].forEach((dialog) => {
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

  // Пошук людей прямо у вікні групи: нові знайдені додаються до списку, вибір зберігається
  function bindPickSearch(input, container, namesFn) {
    let timer = null;
    input.addEventListener('input', () => {
      clearTimeout(timer);
      const q = input.value.trim();
      if (q.length < 2) return;
      timer = setTimeout(async () => {
        try {
          const found = await searchPeople(q);
          const checked = new Set(checkedValues(container));
          const names = [...new Set([...namesFn(), ...checked, ...found])].sort((a, b) => a.localeCompare(b, 'uk'));
          fillPickList(container, names);
          container.querySelectorAll('input[type="checkbox"]').forEach((box) => {
            if (checked.has(box.value)) box.checked = true;
          });
        } catch (err) {
          console.error('Помилка пошуку:', err);
        }
      }, 250);
    });
  }

  const checkedValues = (container) =>
    [...container.querySelectorAll('input[type="checkbox"]:checked')].map((box) => box.value);

  // ==========================================
  // Групи: створення та керування
  // ==========================================
  newGroupBtn.addEventListener('click', () => {
    groupTitleInput.value = '';
    groupFindInput.value = '';
    setMsg(groupError, '');
    fillPickList(
      groupMembersPick,
      knownNames().sort((a, b) => a.localeCompare(b, 'uk'))
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

  const knownNames = () => users.filter((u) => u.contact).map((u) => u.username);
  bindPickSearch(groupFindInput, groupMembersPick, knownNames);
  bindPickSearch(groupAddFindInput, groupAddPick, () =>
    knownNames().filter((name) => {
      const g = groupById(infoGroupId);
      return !(g && g.members.includes(name));
    })
  );

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

    groupAddFindInput.value = '';
    groupAddSection.classList.toggle('hidden', !isOwner);
    groupDeleteBtn.classList.toggle('hidden', !isOwner);
    if (isOwner) {
      fillPickList(
        groupAddPick,
        knownNames()
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
  // Файли та фото
  // ==========================================
  const MAX_FILE_BYTES = 10 * 1024 * 1024; // має збігатися з сервером
  const IMAGE_MAX_SIDE = 1600;
  const JPEG_QUALITY = 0.85;
  const BLOCKED_EXTENSIONS = new Set([
    'exe', 'bat', 'cmd', 'com', 'scr', 'msi', 'msp', 'dll', 'lnk', 'pif', 'cpl',
    'js', 'jse', 'mjs', 'vbs', 'vbe', 'wsf', 'wsh', 'ps1', 'psm1', 'sh', 'bash',
    'jar', 'apk', 'app', 'hta', 'reg', 'iso', 'dmg'
  ]);

  function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} Б`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
    return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
  }

  function attachmentLabel(m) {
    if (!m.attachment) return '';
    return m.attachment.isImage ? '📷 Фото' : `📎 ${m.attachment.name}`;
  }

  function fileIcon(name) {
    const ext = (name.split('.').pop() || '').toLowerCase();
    if (ext === 'pdf') return '📕';
    if (['doc', 'docx', 'odt', 'rtf', 'txt', 'md'].includes(ext)) return '📝';
    if (['xls', 'xlsx', 'csv', 'ods'].includes(ext)) return '📊';
    if (['ppt', 'pptx', 'odp'].includes(ext)) return '📽';
    if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return '🗜';
    if (['mp3', 'wav', 'ogg', 'flac', 'm4a'].includes(ext)) return '🎵';
    if (['mp4', 'mov', 'avi', 'mkv', 'webm'].includes(ext)) return '🎬';
    return '📎';
  }

  function openImage(a) {
    imageDialogImg.src = `/api/files/${a.id}`;
    imageDialogImg.alt = a.name;
    imageDialogDownload.href = `/api/files/${a.id}?download=1`;
    imageDialogDownload.setAttribute('download', a.name);
    imageDialog.showModal();
  }
  imageDialogImg.addEventListener('click', () => imageDialog.close());
  imageDialog.addEventListener('close', () => imageDialogImg.removeAttribute('src'));

  // Вкладення в повідомленні: фото з прев'ю або «плашка» файлу
  function makeAttachment(a) {
    const url = `/api/files/${a.id}`;

    if (a.isImage) {
      const img = document.createElement('img');
      img.className = 'msg-image';
      img.src = url;
      img.alt = a.name;
      img.title = a.name;
      img.loading = 'lazy';
      if (a.w && a.h) {
        img.width = a.w; // розміри лише для резервування місця (стиль обмежує ширину)
        img.height = a.h;
      }
      img.addEventListener('click', () => openImage(a));
      img.addEventListener('error', () => img.replaceWith(h('div', 'file-missing', 'Фото недоступне')));
      return img;
    }

    const chip = h('a', 'file-chip');
    chip.href = `${url}?download=1`;
    chip.setAttribute('download', a.name);
    chip.title = 'Завантажити';
    chip.appendChild(h('span', 'file-icon', fileIcon(a.name)));
    const info = h('span', 'file-info');
    info.appendChild(h('span', 'file-name', a.name));
    info.appendChild(h('span', 'file-size', formatSize(a.size)));
    chip.appendChild(info);
    return chip;
  }

  // --- Панель вкладення над полем вводу ---
  function showAttachBar(name, sub, progress, isImage) {
    attachIcon.textContent = isImage ? '📷' : fileIcon(name);
    attachName.textContent = name;
    attachSub.textContent = sub;
    attachProgress.classList.toggle('hidden', progress === null);
    if (progress !== null) attachProgress.value = progress;
    attachBar.classList.remove('hidden');
  }

  function hideAttachBar() {
    attachBar.classList.add('hidden');
  }

  // Після надсилання: просто забуваємо вкладення (сервер уже прив'язав файл)
  function resetAttachment() {
    pendingAttachment = null;
    hideAttachBar();
  }

  // Скасування користувачем / перемикання чату: перериваємо завантаження
  function clearAttachment() {
    if (uploading && uploadXhr) uploadXhr.abort();
    pendingAttachment = null;
    hideAttachBar();
    fileInput.value = '';
  }

  // --- Підготовка зображення: зменшення та стиснення ---
  async function decodeImage(file) {
    if (window.createImageBitmap) {
      try {
        const bitmap = await createImageBitmap(file);
        return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
      } catch {
        /* пробуємо запасний шлях */
      }
    }
    // Запасний шлях: data: URL (blob: заборонений політикою безпеки сторінки)
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    const img = await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('decode'));
      image.src = dataUrl;
    });
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => {} };
  }

  async function prepareImage(file) {
    const decoded = await decodeImage(file);
    try {
      const { width, height } = decoded;
      const original = { blob: file, name: file.name, w: width, h: height };
      const scale = Math.min(1, IMAGE_MAX_SIDE / Math.max(width, height));
      const resized = scale < 1;
      const keepLimit = file.type === 'image/png' ? 2 * 1024 * 1024 : 1.5 * 1024 * 1024;

      // GIF не чіпаємо (анімація); невеликі фото теж лишаємо як є
      if (file.type === 'image/gif' || (!resized && file.size <= keepLimit)) return original;

      const w = Math.max(1, Math.round(width * scale));
      const hgt = Math.max(1, Math.round(height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = hgt;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff'; // прозорість PNG → білий фон під JPEG
      ctx.fillRect(0, 0, w, hgt);
      ctx.drawImage(decoded.source, 0, 0, w, hgt);

      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY));
      if (!blob || (!resized && blob.size >= file.size)) return original;

      return { blob, name: `${file.name.replace(/\.[^.]+$/, '') || 'photo'}.jpg`, w, h: hgt };
    } finally {
      decoded.close();
    }
  }

  function uploadBlob(blob, name, dims, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      uploadXhr = xhr;

      const params = new URLSearchParams({ name });
      if (dims) {
        params.set('w', String(dims.w));
        params.set('h', String(dims.h));
      }

      xhr.open('POST', `/api/upload?${params}`);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
      };
      xhr.onload = () => {
        let data = {};
        try {
          data = JSON.parse(xhr.responseText);
        } catch {
          /* не JSON */
        }
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else reject(new Error(data.error || 'Не вдалося завантажити файл'));
      };
      xhr.onerror = () => reject(new Error('Немає зв’язку з сервером'));
      xhr.onabort = () => reject(Object.assign(new Error('cancelled'), { cancelled: true }));
      xhr.send(blob);
    });
  }

  async function selectFile(file) {
    if (!file || !socket) return;
    if (isMuted()) return showToast('Вас вимкнено (мут): надсилати файли не можна');
    if (uploading) return showToast('Дочекайтесь завершення попереднього завантаження');

    const ext = (file.name.split('.').pop() || '').toLowerCase();
    if (BLOCKED_EXTENSIONS.has(ext)) {
      fileInput.value = '';
      return showToast('Цей тип файлів заборонено з міркувань безпеки');
    }

    pendingAttachment = null;
    uploading = true;
    showAttachBar(file.name, 'Підготовка…', null, false);

    try {
      let prepared = { blob: file, name: file.name, w: null, h: null };
      if (/^image\/(jpeg|png|webp|gif)$/.test(file.type)) {
        try {
          prepared = await prepareImage(file);
        } catch {
          /* не вдалося обробити: завантажимо як є */
        }
      }
      if (prepared.blob.size > MAX_FILE_BYTES) {
        throw new Error(`Файл завеликий (максимум ${MAX_FILE_BYTES / 1024 / 1024} МБ)`);
      }

      const isImg = prepared.w !== null;
      showAttachBar(prepared.name, `${formatSize(prepared.blob.size)} · завантаження…`, 0, isImg);
      const dims = prepared.w && prepared.h ? { w: prepared.w, h: prepared.h } : null;
      const data = await uploadBlob(prepared.blob, prepared.name, dims, (p) => {
        attachProgress.value = p;
      });

      pendingAttachment = data;
      showAttachBar(data.name, `${formatSize(data.size)} · готово, натисніть «Надіслати»`, null, data.isImage);
      messageInput.focus();
    } catch (err) {
      pendingAttachment = null;
      hideAttachBar();
      if (!err.cancelled) showToast(err.message || 'Не вдалося завантажити файл');
    } finally {
      uploading = false;
      uploadXhr = null;
      fileInput.value = '';
    }
  }

  attachBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => selectFile(fileInput.files[0]));
  attachCancel.addEventListener('click', clearAttachment);

  // Вставка зображення з буфера обміну (Ctrl+V)
  messageInput.addEventListener('paste', (e) => {
    const files = e.clipboardData ? [...e.clipboardData.files] : [];
    if (files.length) {
      e.preventDefault();
      selectFile(files[0]);
    }
  });

  // Перетягування файлу у вікно чату
  const hasFiles = (e) => Boolean(e.dataTransfer) && [...e.dataTransfer.types].includes('Files');
  ['dragenter', 'dragover'].forEach((type) => {
    chatWindow.addEventListener(type, (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      chatWindow.classList.add('drop-active');
    });
  });
  chatWindow.addEventListener('dragleave', (e) => {
    if (!chatWindow.contains(e.relatedTarget)) chatWindow.classList.remove('drop-active');
  });
  chatWindow.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    chatWindow.classList.remove('drop-active');
    selectFile(e.dataTransfer.files[0]);
  });

  // ==========================================
  // Профіль
  // ==========================================
  const AVATAR_SIDE = 256;

  // Квадратна обрізка по центру + стиснення до JPEG
  async function makeAvatarBlob(file) {
    const decoded = await decodeImage(file);
    try {
      const side = Math.min(decoded.width, decoded.height);
      const sx = Math.floor((decoded.width - side) / 2);
      const sy = Math.floor((decoded.height - side) / 2);
      const out = Math.min(AVATAR_SIDE, side);
      const canvas = document.createElement('canvas');
      canvas.width = out;
      canvas.height = out;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, out, out);
      ctx.drawImage(decoded.source, sx, sy, side, side, 0, 0, out, out);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.88));
      if (!blob) throw new Error('encode');
      return { blob, dataUrl: canvas.toDataURL('image/jpeg', 0.88), size: out };
    } finally {
      decoded.close();
    }
  }

  function setEditMode(on) {
    profileForm.classList.toggle('hidden', !on);
    profileBio.classList.toggle('hidden', on);
    profileEditBtn.classList.toggle('hidden', on || profileOf !== currentUser);
  }

  async function openProfile(name) {
    if (!name) return;
    profileOf = name;
    profileAvatarDraft = undefined;
    setMsg(profileMsg, '');
    setEditMode(false);

    const self = name === currentUser;
    profileName.textContent = name;
    profileStatus.textContent = '';
    profileStatus.classList.remove('online');
    profileSince.textContent = '';
    setAvatarContent(profileAvatar, name, avatars.get(name) || null);
    profileBio.textContent = self ? myBio || 'Розкажіть про себе' : '…';
    profileBio.classList.toggle('empty', self ? !myBio : true);
    profileWriteBtn.classList.toggle('hidden', self);
    profileEditBtn.classList.toggle('hidden', !self);
    if (!profileDialog.open) profileDialog.showModal();

    try {
      const { ok, data } = await api(`/api/profile/${encodeURIComponent(name)}`);
      if (profileOf !== name) return; // користувач уже відкрив інший профіль
      if (!ok || !data.username) {
        profileBio.textContent = data.error || 'Не вдалося завантажити профіль';
        return;
      }
      if (data.avatar) avatars.set(data.username, data.avatar);
      else avatars.delete(data.username);
      if (self) myBio = data.bio;
      profileName.textContent = data.username;
      setAvatarContent(profileAvatar, data.username, data.avatar);
      const online = self || onlineSet.has(data.username) || data.isOnline;
      profileStatus.textContent = (online ? 'в мережі' : formatLastSeen(data.lastSeen)) + (data.isAdmin ? ' · 👑 адміністратор' : '');
      profileStatus.classList.toggle('online', Boolean(online));
      if (data.createdAt) {
        profileSince.textContent = `З нами з ${new Date(data.createdAt).toLocaleDateString('uk-UA', { year: 'numeric', month: 'long', day: 'numeric' })}`;
      }
      profileBio.textContent = data.bio || (self ? 'Розкажіть про себе' : 'Користувач ще нічого не написав про себе');
      profileBio.classList.toggle('empty', !data.bio);
    } catch (err) {
      console.error('Помилка профілю:', err);
      if (profileOf === name) profileBio.textContent = 'Не вдалося завантажити профіль';
    }
  }

  myProfileBtn.addEventListener('click', () => openProfile(currentUser));
  chatProfileBtn.addEventListener('click', () => {
    if (isUserKey(activeChat)) openProfile(activeChat.slice(2));
  });
  profileAvatar.addEventListener('click', () => {
    const id = avatars.get(profileOf);
    if (id && profileForm.classList.contains('hidden')) {
      openImage({ id, name: `Фото ${profileOf}` });
    }
  });
  profileDialog.addEventListener('close', () => {
    profileOf = null;
  });

  profileWriteBtn.addEventListener('click', () => {
    const name = profileOf;
    profileDialog.close();
    if (!name || name === currentUser) return;
    ensureUser(name, false); // людина може бути ще не в списку: відкриваємо чат, у списку з'явиться після листування
    switchChat(`u:${name}`);
  });

  profileEditBtn.addEventListener('click', () => {
    profileAvatarDraft = undefined;
    profileBioInput.value = myBio;
    profileCounter.textContent = `${myBio.length}/300`;
    setMsg(profileMsg, '');
    setEditMode(true);
    profileBioInput.focus();
  });
  profileBioInput.addEventListener('input', () => {
    profileCounter.textContent = `${profileBioInput.value.length}/300`;
  });

  profilePhotoBtn.addEventListener('click', () => profileFile.click());
  profileFile.addEventListener('change', async () => {
    const file = profileFile.files[0];
    profileFile.value = '';
    if (!file) return;
    if (isMuted()) return setMsg(profileMsg, 'Вас вимкнено (мут): змінювати фото не можна');
    if (!/^image\/(jpeg|png|webp|gif)$/.test(file.type)) {
      return setMsg(profileMsg, 'Оберіть зображення (JPG, PNG, WebP або GIF)');
    }
    profileUploading = true;
    profileSave.disabled = true;
    setMsg(profileMsg, 'Завантаження фото…', true);
    try {
      const prepared = await makeAvatarBlob(file);
      const data = await uploadBlob(prepared.blob, 'avatar.jpg', { w: prepared.size, h: prepared.size }, () => {});
      profileAvatarDraft = data.id;
      setAvatarContent(profileAvatar, profileOf, null, prepared.dataUrl);
      setMsg(profileMsg, 'Фото готове — натисніть «Зберегти»', true);
    } catch (err) {
      setMsg(profileMsg, err.message || 'Не вдалося завантажити фото');
    } finally {
      profileUploading = false;
      profileSave.disabled = false;
    }
  });

  profilePhotoRemove.addEventListener('click', () => {
    profileAvatarDraft = null;
    setAvatarContent(profileAvatar, currentUser, null);
    setMsg(profileMsg, 'Фото буде прибрано після збереження', true);
  });

  profileForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (profileUploading) return;
    const body = { bio: profileBioInput.value };
    if (profileAvatarDraft !== undefined) body.avatar = profileAvatarDraft;
    profileSave.disabled = true;
    try {
      const { ok, data } = await api('/api/profile', { method: 'PUT', body: JSON.stringify(body) });
      if (!ok) return setMsg(profileMsg, data.error || 'Не вдалося зберегти');
      myBio = data.bio;
      if (data.avatar) avatars.set(currentUser, data.avatar);
      else avatars.delete(currentUser);
      profileAvatarDraft = undefined;
      renderSidebar();
      showToast('Профіль збережено');
      openProfile(currentUser);
    } catch {
      setMsg(profileMsg, 'Немає зв\u2019язку з сервером');
    } finally {
      profileSave.disabled = false;
    }
  });

  // ==========================================
  // Мут та адміністрування
  // ==========================================
  const FOREVER_YEAR = 9000;

  function formatUntil(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    if (date.getFullYear() >= FOREVER_YEAR) return 'назавжди';
    if (date.toDateString() === new Date().toDateString()) return `до ${formatTime(date)}`;
    return `до ${date.toLocaleDateString('uk-UA', { day: 'numeric', month: 'short' })}, ${formatTime(date)}`;
  }

  const isMutedUser = (u) => Boolean(u.mutedUntil) && new Date(u.mutedUntil) > new Date();
  const isMuted = () => Boolean(myMutedUntil) && myMutedUntil > new Date();

  // Блокує або розблоковує поле вводу для замученого користувача
  function applyMuteState(value) {
    clearTimeout(muteTimer);
    const wasMuted = isMuted();
    myMutedUntil = value ? new Date(value) : null;
    const muted = isMuted();

    messageInput.disabled = muted;
    emojiBtn.disabled = muted;
    attachBtn.disabled = muted;
    if (muted) clearAttachment();
    messageInput.placeholder = muted
      ? `Вас вимкнено (мут) ${formatUntil(myMutedUntil)}`
      : 'Введіть повідомлення...';

    if (muted) {
      cancelComposer();
      emojiPanel.classList.add('hidden');
      if (!wasMuted) showToast(`Адміністратор вимкнув вам можливість писати (${formatUntil(myMutedUntil)})`);
      const ms = myMutedUntil.getTime() - Date.now();
      if (ms < 2147483000) muteTimer = setTimeout(() => applyMuteState(myMutedUntil), ms + 500);
    } else if (wasMuted) {
      showToast('Мут знято, ви знову можете писати');
    }
  }

  function setUserMute(name, until) {
    const user = users.find((u) => u.username === name);
    if (user) user.mutedUntil = until || null;
    renderSidebar();
    if (adminDialog.open) renderAdminList();
  }

  function removeUser(name) {
    users = users.filter((u) => u.username !== name);
    chats.delete(`u:${name}`);
    delete unread[`u:${name}`];
    if (adminDialog.open) renderAdminList();

    if (activeChat === `u:${name}`) {
      showToast(`Користувача ${name} видалено`);
      switchChat('general', { keepMobileList: true });
    } else {
      renderSidebar();
      updateDocumentTitle();
    }
  }

  function makeAdminRow(u) {
    const row = h('div', 'admin-row');
    const online = onlineSet.has(u.username);
    const muted = isMutedUser(u);

    const info = h('div', 'admin-info');
    info.appendChild(h('div', 'admin-name', u.isAdmin ? `${u.username} 👑` : u.username));
    let sub = online ? '🟢 в мережі' : formatLastSeen(u.lastSeen);
    if (muted) sub += ` · 🔇 мут ${formatUntil(u.mutedUntil)}`;
    info.appendChild(h('div', 'admin-sub', sub));
    row.appendChild(info);

    if (!u.isAdmin) {
      const actions = h('div', 'admin-actions');

      const muteBtn = h('button', 'btn btn-small btn-secondary', muted ? '🔊 Зняти мут' : '🔇 Мут');
      muteBtn.type = 'button';
      muteBtn.addEventListener('click', () => (muted ? adminUnmute(u.username) : adminMute(u.username)));

      const deleteBtn = h('button', 'btn btn-small btn-danger', '🗑');
      deleteBtn.type = 'button';
      deleteBtn.title = 'Видалити користувача';
      deleteBtn.setAttribute('aria-label', `Видалити користувача ${u.username}`);
      deleteBtn.addEventListener('click', () => adminDelete(u.username));

      actions.append(muteBtn, deleteBtn);
      row.appendChild(actions);
    }
    return row;
  }

  function renderAdminList() {
    const query = adminSearch.value.trim().toLowerCase();
    const list = users
      .filter((u) => !query || u.username.toLowerCase().includes(query))
      .sort(
        (a, b) =>
          Number(onlineSet.has(b.username)) - Number(onlineSet.has(a.username)) ||
          a.username.localeCompare(b.username, 'uk')
      );

    if (!list.length) {
      adminUsers.replaceChildren(h('div', 'pick-note', users.length ? 'Нікого не знайдено' : 'Користувачів немає'));
      return;
    }
    adminUsers.replaceChildren(...list.map(makeAdminRow));
  }

  async function adminAction(url, body, okText) {
    setMsg(adminMsg, '');
    try {
      const { ok, data } = await api(url, { method: 'POST', body: JSON.stringify(body) });
      if (!ok) {
        setMsg(adminMsg, data.error || 'Не вдалося виконати дію');
        return null;
      }
      setMsg(adminMsg, okText, true);
      return data;
    } catch {
      setMsg(adminMsg, 'Немає зв’язку з сервером');
      return null;
    }
  }

  async function adminMute(name) {
    const choice = muteDuration.value;
    const body = choice === 'forever' ? { username: name, forever: true } : { username: name, minutes: Number(choice) };
    const data = await adminAction('/api/admin/mute', body, `${name}: мут встановлено`);
    if (data) setUserMute(data.username, data.mutedUntil);
  }

  async function adminUnmute(name) {
    const data = await adminAction('/api/admin/unmute', { username: name }, `${name}: мут знято`);
    if (data) setUserMute(data.username, null);
  }

  async function adminDelete(name) {
    const sure = window.confirm(
      `Видалити користувача ${name}?\n\nЙого приватні листування буде стерто, а повідомлення в чатах стануть «видаленими». Дію не можна скасувати.`
    );
    if (!sure) return;
    const data = await adminAction('/api/admin/delete-user', { username: name }, `Користувача ${name} видалено`);
    if (data) removeUser(data.username);
  }

  adminBtn.addEventListener('click', async () => {
    adminSearch.value = '';
    setMsg(adminMsg, '');
    renderAdminList();
    adminDialog.showModal();
    // Підтягуємо свіжі дані (статуси мутів)
    await loadUsers();
    renderSidebar();
    if (adminDialog.open) renderAdminList();
  });

  adminSearch.addEventListener('input', renderAdminList);

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

  function startChatSession(username, admin, me) {
    if (sessionStarted) return;
    sessionStarted = true;

    myBio = (me && me.bio) || '';
    if (me && me.avatar) avatars.set(username, me.avatar);

    currentUser = username;
    isAdmin = Boolean(admin);
    adminBtn.classList.toggle('hidden', !isAdmin);
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
      if (adminDialog.open) renderAdminList();
      renderSidebar();
      updateHeader();
    });

    socket.on('profileUpdated', ({ username: name, avatar }) => {
      if (avatar) avatars.set(name, avatar);
      else avatars.delete(name);
      renderSidebar();
      if (profileDialog.open && profileOf === name && profileForm.classList.contains('hidden')) {
        setAvatarContent(profileAvatar, name, avatars.get(name) || null);
      }
    });

    socket.on('userRegistered', ({ username: name }) => ensureUser(name));

    socket.on('userRemoved', ({ username: name }) => removeUser(name));

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

    // Мут: власний стан та оновлення для адміністраторів
    socket.on('muteState', ({ mutedUntil }) => applyMuteState(mutedUntil));
    socket.on('muteUpdated', ({ username: name, mutedUntil }) => setUserMute(name, mutedUntil));

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
      if (ok && data.authenticated) startChatSession(data.username, data.isAdmin, data);
    } catch (err) {
      console.error('Помилка перевірки сесії:', err);
    }
  })();
})();