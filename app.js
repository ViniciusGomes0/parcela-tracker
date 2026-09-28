(function () {
  'use strict';

  var KEY = 'parcela-tracker:v2';
  var KEY_OLD = 'parcela-tracker:v1';
  var THEME_KEY = 'parcela-tracker:theme';
  var CUSTOM_CAT_KEY = 'parcela-tracker:customCategories';
  var fmtBRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
  var monthNames = ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];
  var monthNamesFull = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
  var weekdayShort = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];

  var CATEGORIES = [
    { id: 'shopping',   label: 'Compras',      icon: '🛍️', color: '#3a6df0' },
    { id: 'electronics',label: 'Eletrônicos',  icon: '📱', color: '#6ea0ff' },
    { id: 'home',       label: 'Casa',         icon: '🏠', color: '#12b981' },
    { id: 'car',        label: 'Veículo',      icon: '🚗', color: '#f5a623' },
    { id: 'health',     label: 'Saúde',        icon: '💊', color: '#ff6369' },
    { id: 'education',  label: 'Educação',     icon: '🎓', color: '#9b6bff' },
    { id: 'travel',     label: 'Viagem',       icon: '✈️', color: '#22b8cf' },
    { id: 'food',       label: 'Alimentação',  icon: '🍽️', color: '#ff8f4d' },
    { id: 'leisure',    label: 'Lazer',        icon: '🎮', color: '#e05fa8' },
    { id: 'other',      label: 'Outros',       icon: '📦', color: '#8a93a3' }
  ];
  var COLOR_PALETTE = [
    '#3a6df0', '#6ea0ff', '#12b981', '#f5a623', '#ff6369',
    '#9b6bff', '#22b8cf', '#ff8f4d', '#e05fa8', '#8a93a3',
    '#2dd4a0', '#ffd43b'
  ];

  function loadCustomCategories() {
    try {
      var raw = localStorage.getItem(CUSTOM_CAT_KEY);
      var data = raw ? JSON.parse(raw) : [];
      return Array.isArray(data) ? data : [];
    } catch (e) {
      return [];
    }
  }
  function saveCustomCategories() {
    try { localStorage.setItem(CUSTOM_CAT_KEY, JSON.stringify(customCategories)); } catch (e) {}
  }
  var customCategories = loadCustomCategories();

  function allCategories() { return CATEGORIES.concat(customCategories); }
  function catById(id) {
    var all = allCategories();
    for (var i = 0; i < all.length; i++) if (all[i].id === id) return all[i];
    return CATEGORIES[CATEGORIES.length - 1];
  }

  // ---- storage: SQLite (sql.js) persisted in IndexedDB, with a localStorage mirror as fallback ----
  var SQL = null;            // sql.js module
  var db = null;             // sql.js Database instance
  var dbReady = false;       // true once SQLite is the active store
  var IDB_NAME = 'financeiro-db';
  var IDB_STORE = 'kv';
  var IDB_BINKEY = 'sqlite-file';
  var SQLJS_BASE = 'https://cdn.jsdelivr.net/npm/sql.js@1.10.3/dist/';
  var persistTimer = null;

  // reads the localStorage mirror — used for migration and as an offline fallback
  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) {
        var old = localStorage.getItem(KEY_OLD);
        if (old) {
          var oldData = JSON.parse(old);
          if (Array.isArray(oldData)) return oldData.map(normalize);
        }
        return [];
      }
      var data = JSON.parse(raw);
      return Array.isArray(data) ? data.map(normalize) : [];
    } catch (e) {
      return [];
    }
  }
  function normalize(e) {
    if (!e.category) e.category = 'other';
    if (!e.dueDay) e.dueDay = 5;
    if (!e.paid) e.paid = e.paid || 0;
    return e;
  }

  // ---- tiny IndexedDB key/value store (holds the SQLite binary) ----
  function idbOpen() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = function () { req.result.createObjectStore(IDB_STORE); };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }
  function idbGet(key) {
    return idbOpen().then(function (dbi) {
      return new Promise(function (resolve, reject) {
        var rq = dbi.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(key);
        rq.onsuccess = function () { resolve(rq.result); };
        rq.onerror = function () { reject(rq.error); };
      });
    });
  }
  function idbPut(key, val) {
    return idbOpen().then(function (dbi) {
      return new Promise(function (resolve, reject) {
        var tx = dbi.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).put(val, key);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  // ---- SQLite table helpers ----
  function ensureSchema() {
    db.run('CREATE TABLE IF NOT EXISTS expenses (id TEXT PRIMARY KEY, pos INTEGER, json TEXT)');
  }
  function readStateFromDb() {
    var out = [];
    var res = db.exec('SELECT json FROM expenses ORDER BY pos ASC');
    if (res.length && res[0].values) {
      res[0].values.forEach(function (row) {
        try { out.push(normalize(JSON.parse(row[0]))); } catch (e) {}
      });
    }
    return out;
  }
  function writeStateToDb() {
    db.run('BEGIN');
    db.run('DELETE FROM expenses');
    var stmt = db.prepare('INSERT INTO expenses (id, pos, json) VALUES (?, ?, ?)');
    for (var i = 0; i < state.length; i++) {
      stmt.run([String(state[i].id), i, JSON.stringify(state[i])]);
    }
    stmt.free();
    db.run('COMMIT');
  }
  function schedulePersist() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(persistNow, 350);
  }
  function persistNow() {
    if (!dbReady || !db) return;
    try { idbPut(IDB_BINKEY, db.export()).catch(function () {}); } catch (e) {}
  }

  // Save: mirror to localStorage (instant + safe) + write to SQLite + persist the DB file
  function save() {
    var ok = false;
    try { localStorage.setItem(KEY, JSON.stringify(state)); ok = true; } catch (e) {}
    if (dbReady && db) {
      try { writeStateToDb(); schedulePersist(); ok = true; } catch (e) {}
    }
    updateStorageStatus();
    return ok;
  }

  function updateStorageStatus() {
    var el = document.getElementById('storageStatus');
    if (!el) return;
    if (dbReady) {
      el.textContent = '✅ Banco SQLite ativo — ' + state.length + ' compra(s) salvas com segurança neste dispositivo.';
    } else {
      el.textContent = '⚠️ SQLite indisponível agora (offline?). Seus dados estão salvos localmente; ao reabrir online o banco volta. Exporte um backup por segurança.';
    }
  }

  // ---- boot the database: load sql.js, migrate localStorage → SQLite, or fall back ----
  function initDB() {
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {}

    if (typeof initSqlJs !== 'function') {
      state = load();
      dbReady = false;
      return Promise.resolve();
    }
    return initSqlJs({ locateFile: function (f) { return SQLJS_BASE + f; } })
      .then(function (mod) { SQL = mod; return idbGet(IDB_BINKEY); })
      .then(function (bin) {
        if (bin) {
          db = new SQL.Database(new Uint8Array(bin));
          ensureSchema();
          dbReady = true;
          state = readStateFromDb();
          if (!state.length) {                 // empty DB but mirror has data → recover
            var ls = load();
            if (ls.length) { state = ls; writeStateToDb(); persistNow(); }
          }
        } else {
          db = new SQL.Database();
          ensureSchema();
          dbReady = true;
          state = load();                       // first run → migrate existing data in
          writeStateToDb();
          persistNow();
        }
      })
      .catch(function () {                       // any failure → never lose data
        state = load();
        dbReady = false;
      });
  }

  var state = [];
  var editingId = null;
  var confirmId = null;
  var currentFilter = 'all';
  var selectedCategory = 'shopping';
  var calCursor = (function () { var d = new Date(); return { y: d.getFullYear(), m: d.getMonth() }; })();

  // ---- helpers ----
  function uid() {
    return 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }
  function nowYM() {
    var d = new Date();
    return { y: d.getFullYear(), m: d.getMonth() }; // m 0-based
  }
  function monthsSince(startYM) {
    var parts = startYM.split('-');
    var sy = parseInt(parts[0], 10), sm = parseInt(parts[1], 10) - 1;
    var n = nowYM();
    return (n.y - sy) * 12 + (n.m - sm);
  }
  function monthDiffTo(startYM, y, m) {
    var parts = startYM.split('-');
    var sy = parseInt(parts[0], 10), sm = parseInt(parts[1], 10) - 1;
    return (y - sy) * 12 + (m - sm);
  }
  function ymLabel(startYM) {
    var parts = startYM.split('-');
    return monthNames[parseInt(parts[1], 10) - 1] + '/' + parts[0].slice(2);
  }
  function currentYM() {
    var n = nowYM();
    return n.y + '-' + String(n.m + 1).padStart(2, '0');
  }
  function parseAmount(str) {
    if (typeof str !== 'string') return NaN;
    str = str.trim().replace(/\s/g, '').replace(/R\$/gi, '');
    if (!str) return NaN;
    if (str.indexOf(',') > -1) {
      str = str.replace(/\./g, '').replace(',', '.');
    }
    var v = parseFloat(str);
    return isNaN(v) ? NaN : v;
  }
  function daysInMonth(y, m) { return new Date(y, m + 1, 0).getDate(); }

  // ---- derived per expense ----
  function derive(e) {
    var per = e.total / e.installments;
    var paid = e.paid || 0;
    var remaining = Math.max(0, e.total - per * paid);
    var pct = e.installments ? Math.round((paid / e.installments) * 100) : 0;
    var idx = monthsSince(e.start);
    var canPay = paid < e.installments && idx >= paid;
    return {
      per: per, paid: paid, remaining: remaining, pct: pct,
      done: paid >= e.installments, canPay: canPay,
      nextIdx: paid
    };
  }

  // ---- dashboard ----
  function renderDash() {
    var monthly = 0, remaining = 0, total = 0, paidSum = 0, active = 0;
    state.forEach(function (e) {
      var d = derive(e);
      total += e.total;
      remaining += d.remaining;
      paidSum += d.per * d.paid;
      if (!d.done) { monthly += d.per; active++; }
    });
    document.getElementById('stMonthly').textContent = fmtBRL.format(monthly);
    document.getElementById('stMonthlyMeta').textContent =
      active ? active + (active === 1 ? ' compra ativa' : ' compras ativas') : 'Nenhuma parcela ativa';
    document.getElementById('stRemaining').textContent = fmtBRL.format(remaining);
    document.getElementById('stRemainingMeta').textContent =
      remaining > 0 ? 'a pagar' : 'Tudo quitado 🎉';
    document.getElementById('stTotal').textContent = fmtBRL.format(total);
    document.getElementById('stTotalMeta').textContent = 'Já pago: ' + fmtBRL.format(paidSum);
  }

  // ---- cards ----
  function el(tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }

  function buildCard(e) {
    var d = derive(e);
    var cat = catById(e.category);
    var card = el('div', 'card' + (d.done ? ' done' : ''));
    card.style.setProperty('--cat-color', cat.color);

    var top = el('div', 'card-top');
    var left = el('div', 'card-name-row');
    left.appendChild(el('div', 'card-cat-ico', escapeHtml(cat.icon)));
    var nameWrap = el('div');
    nameWrap.appendChild(el('div', 'card-name', escapeHtml(e.name)));
    top.appendChild(left);
    left.appendChild(nameWrap);
    var badge = el('div', 'badge' + (d.done ? ' paidoff' : ''),
      d.done ? '✓ Quitado' : (d.paid + '/' + e.installments));
    top.appendChild(badge);
    card.appendChild(top);
    card.appendChild(el('div', 'card-total',
      '<b>' + fmtBRL.format(e.total) + '</b> em ' + e.installments + 'x · início ' + ymLabel(e.start)));

    // progress
    var pr = el('div', 'progress-row');
    var labels = el('div', 'progress-labels');
    labels.innerHTML = '<span>' + d.paid + ' de ' + e.installments + ' parcelas</span>' +
      '<span class="pct">' + d.pct + '%</span>';
    pr.appendChild(labels);
    var track = el('div', 'track');
    var fill = el('div', 'fill' + (d.done ? ' full' : ''));
    track.appendChild(fill);
    pr.appendChild(track);
    card.appendChild(pr);
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { fill.style.width = d.pct + '%'; });
    });

    // mini stats
    var g = el('div', 'grid3');
    g.appendChild(mini('Por mês', fmtBRL.format(d.per)));
    g.appendChild(mini('Restante', fmtBRL.format(d.remaining)));
    g.appendChild(mini('Próxima', d.done ? '—' : ('#' + (d.nextIdx + 1))));
    card.appendChild(g);

    // actions
    var acts = el('div', 'card-actions');
    var payBtn = el('button', 'btn primary');
    if (d.done) {
      payBtn.textContent = 'Concluído';
      payBtn.disabled = true;
    } else if (d.canPay) {
      payBtn.innerHTML = 'Pagar parcela ' + (d.nextIdx + 1);
      payBtn.onclick = function () { payOne(e.id); };
    } else {
      payBtn.textContent = 'Parcela ' + (d.nextIdx + 1) + ' só em ' + ymLabel(addMonths(e.start, d.nextIdx));
      payBtn.disabled = true;
    }
    acts.appendChild(payBtn);

    var editBtn = el('button', 'btn icon');
    editBtn.setAttribute('aria-label', 'Editar');
    editBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
    editBtn.onclick = function () { openEdit(e.id); };
    acts.appendChild(editBtn);

    var delBtn = el('button', 'btn icon danger');
    delBtn.setAttribute('aria-label', 'Excluir');
    delBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>';
    delBtn.onclick = function () { confirmId = e.id; renderAll(); };
    acts.appendChild(delBtn);

    card.appendChild(acts);

    if (confirmId === e.id) {
      var cf = el('div', 'confirm');
      cf.innerHTML = '<p>Excluir "' + escapeHtml(e.name) + '"? Esta ação não pode ser desfeita.</p>';
      var row = el('div', 'row');
      var no = el('button', 'btn', 'Cancelar');
      no.onclick = function () { confirmId = null; renderAll(); };
      var yes = el('button', 'btn yes', 'Excluir');
      yes.onclick = function () { removeExpense(e.id); };
      row.appendChild(no); row.appendChild(yes);
      cf.appendChild(row);
      card.appendChild(cf);
    }

    return card;
  }

  function renderCards() {
    var wrap = document.getElementById('cards');
    wrap.innerHTML = '';

    var list = state.filter(function (e) {
      if (currentFilter === 'all') return true;
      var d = derive(e);
      return currentFilter === 'done' ? d.done : !d.done;
    });
    document.getElementById('count').textContent = list.length;

    if (!state.length) {
      var empty = el('div', 'empty');
      empty.innerHTML = '<div class="ico">🧾</div><h3>Nenhuma parcela ainda</h3><p>Toque em "Adicionar" para cadastrar sua primeira compra parcelada.</p>';
      wrap.appendChild(empty);
      return;
    }
    if (!list.length) {
      var empty2 = el('div', 'empty');
      empty2.innerHTML = '<div class="ico">🔎</div><h3>Nada por aqui</h3><p>Nenhuma compra corresponde a este filtro.</p>';
      wrap.appendChild(empty2);
      return;
    }

    list.forEach(function (e) { wrap.appendChild(buildCard(e)); });
  }

  function mini(k, v) {
    var m = el('div', 'mini');
    m.innerHTML = '<div class="k">' + k + '</div><div class="v live">' + v + '</div>';
    return m;
  }

  function addMonths(startYM, n) {
    var parts = startYM.split('-');
    var y = parseInt(parts[0], 10), m = parseInt(parts[1], 10) - 1 + n;
    y += Math.floor(m / 12);
    m = ((m % 12) + 12) % 12;
    return y + '-' + String(m + 1).padStart(2, '0');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ---- mutations ----
  function payOne(id) {
    var e = find(id);
    if (!e) return;
    if ((e.paid || 0) < e.installments) {
      e.paid = (e.paid || 0) + 1;
      save();
      renderAll();
      showToast('Parcela paga! 🎉');
      if (navigator.vibrate) navigator.vibrate(12);
    }
  }
  function removeExpense(id) {
    state = state.filter(function (e) { return e.id !== id; });
    confirmId = null;
    save();
    renderAll();
    showToast('Compra excluída');
  }
  function find(id) {
    for (var i = 0; i < state.length; i++) if (state[i].id === id) return state[i];
    return null;
  }

  function renderAll() { renderDash(); renderCards(); renderCalendar(); }

  // ---- tabs ----
  var tabButtons = document.querySelectorAll('.tab-btn');
  var tabPanels = document.querySelectorAll('.tab-panel');
  var fab = document.getElementById('fab');
  function switchTab(name) {
    tabButtons.forEach(function (b) { b.classList.toggle('active', b.dataset.tab === name); });
    tabPanels.forEach(function (p) { p.hidden = p.dataset.tab !== name; });
    fab.classList.toggle('hidden-tab', name !== 'home');
    window.scrollTo(0, 0);
  }
  tabButtons.forEach(function (b) { b.onclick = function () { switchTab(b.dataset.tab); }; });
  document.getElementById('openSettingsShortcut').onclick = function () { switchTab('settings'); };

  // ---- filters ----
  document.getElementById('filterRow').addEventListener('click', function (ev) {
    var btn = ev.target.closest('.chip');
    if (!btn) return;
    currentFilter = btn.dataset.filter;
    document.querySelectorAll('#filterRow .chip').forEach(function (c) { c.classList.toggle('active', c === btn); });
    renderCards();
  });

  // ---- calendar ----
  function monthOccurrences(y, m) {
    var out = [];
    state.forEach(function (e) {
      var idx = monthDiffTo(e.start, y, m);
      if (idx >= 0 && idx < e.installments) {
        out.push({ e: e, idx: idx, paid: idx < (e.paid || 0) });
      }
    });
    return out;
  }

  function renderCalendar() {
    var y = calCursor.y, m = calCursor.m;
    document.getElementById('calTitle').textContent = monthNamesFull[m] + ' de ' + y;

    var occ = monthOccurrences(y, m);
    var totalDue = 0, paidCount = 0;
    occ.forEach(function (o) {
      var per = o.e.total / o.e.installments;
      if (!o.paid) totalDue += per;
      else paidCount++;
    });
    document.getElementById('calMonthTotal').textContent = fmtBRL.format(totalDue);

    // grid
    var grid = document.getElementById('calGrid');
    grid.innerHTML = '';
    var first = new Date(y, m, 1).getDay();
    var dim = daysInMonth(y, m);
    var today = new Date();
    var isCurrentMonth = today.getFullYear() === y && today.getMonth() === m;

    for (var i = 0; i < first; i++) grid.appendChild(el('div', 'cal-day empty'));

    for (var day = 1; day <= dim; day++) {
      var dayOcc = occ.filter(function (o) {
        var dd = Math.min(o.e.dueDay || 5, dim);
        return dd === day;
      });
      var cls = 'cal-day';
      if (isCurrentMonth && today.getDate() === day) cls += ' today';
      if (dayOcc.length) {
        cls += ' has-due';
        if (dayOcc.every(function (o) { return o.paid; })) cls += ' paidoff-day';
      }
      var cell = el('div', cls);
      cell.appendChild(el('span', null, String(day)));
      if (dayOcc.length) cell.appendChild(el('div', 'dot'));
      if (dayOcc.length) {
        cell.addEventListener('click', function (dOcc, d) {
          return function () { openDaySheet(y, m, d, dOcc); };
        }(dayOcc, day));
      }
      grid.appendChild(cell);
    }

    // month list
    var listWrap = document.getElementById('calList');
    listWrap.innerHTML = '';
    document.getElementById('calListCount').textContent = occ.length;
    document.getElementById('calListTitle').textContent = 'Vencimentos de ' + monthNames[m] + '/' + String(y).slice(2);
    if (!occ.length) {
      var empty = el('div', 'empty');
      empty.innerHTML = '<div class="ico">📅</div><h3>Nada previsto</h3><p>Nenhuma parcela vence neste mês.</p>';
      listWrap.appendChild(empty);
      return;
    }
    occ.sort(function (a, b) { return (a.e.dueDay || 5) - (b.e.dueDay || 5); });
    occ.forEach(function (o) { listWrap.appendChild(buildCard(o.e)); });
  }

  function openDaySheet(y, m, day, occ) {
    document.getElementById('daySheetTitle').textContent =
      String(day).padStart(2, '0') + ' de ' + monthNamesFull[m] + ' de ' + y;
    var wrap = document.getElementById('dayList');
    wrap.innerHTML = '';
    occ.forEach(function (o) { wrap.appendChild(buildCard(o.e)); });
    dayBackdrop.classList.add('open');
    document.body.style.overflow = 'hidden';
  }

  document.getElementById('calPrev').onclick = function () {
    calCursor.m--; if (calCursor.m < 0) { calCursor.m = 11; calCursor.y--; }
    renderCalendar();
  };
  document.getElementById('calNext').onclick = function () {
    calCursor.m++; if (calCursor.m > 11) { calCursor.m = 0; calCursor.y++; }
    renderCalendar();
  };
  document.getElementById('calToday').onclick = function () {
    var n = nowYM(); calCursor = { y: n.y, m: n.m }; renderCalendar();
  };

  var dayBackdrop = document.getElementById('dayBackdrop');
  function closeDaySheet() { dayBackdrop.classList.remove('open'); document.body.style.overflow = ''; }
  document.getElementById('dayCloseBtn').onclick = closeDaySheet;
  dayBackdrop.addEventListener('click', function (ev) { if (ev.target === dayBackdrop) closeDaySheet(); });

  // ---- sheet / form ----
  var backdrop = document.getElementById('backdrop');
  var fName = document.getElementById('fName');
  var fTotal = document.getElementById('fTotal');
  var fParc = document.getElementById('fParc');
  var fDate = document.getElementById('fDate');
  var fDay = document.getElementById('fDay');
  var hParc = document.getElementById('hParc');
  var catGrid = document.getElementById('catGrid');
  var fTotalLabel = document.getElementById('fTotalLabel');
  var amountModeSeg = document.getElementById('amountModeSeg');
  var amountMode = 'per'; // 'per' = valor da parcela, 'total' = valor total

  amountModeSeg.querySelectorAll('.seg-btn').forEach(function (b) {
    b.onclick = function () { setAmountMode(b.dataset.mode); };
  });
  function setAmountMode(mode) {
    amountMode = mode;
    amountModeSeg.querySelectorAll('.seg-btn').forEach(function (b) { b.classList.toggle('active', b.dataset.mode === mode); });
    fTotalLabel.textContent = mode === 'per' ? 'Valor da parcela (R$)' : 'Valor total (R$)';
    updateHint();
  }

  function renderCatGrid() {
    catGrid.innerHTML = '';
    allCategories().forEach(function (c) {
      var isCustom = !!c.custom;
      var opt = el('button', 'cat-opt');
      opt.type = 'button';
      opt.style.setProperty('--cat-color', c.color);
      opt.setAttribute('aria-label', c.label);
      opt.title = c.label;
      opt.dataset.cat = c.id;
      opt.appendChild(el('div', 'cat-opt-ico', escapeHtml(c.icon)));
      opt.appendChild(el('div', 'cat-opt-label', escapeHtml(c.label)));
      opt.onclick = function () { selectCategory(c.id); };
      if (isCustom) {
        var del = el('span', 'cat-opt-del', '×');
        del.setAttribute('aria-label', 'Remover categoria');
        del.onclick = function (ev) { ev.stopPropagation(); removeCustomCategory(c.id); };
        opt.appendChild(del);
      }
      catGrid.appendChild(opt);
    });
    var addOpt = el('button', 'cat-opt add-cat');
    addOpt.type = 'button';
    addOpt.appendChild(el('div', 'cat-opt-ico', '+'));
    addOpt.appendChild(el('div', 'cat-opt-label', 'Nova categoria'));
    addOpt.onclick = openCatSheet;
    catGrid.appendChild(addOpt);

    catGrid.querySelectorAll('.cat-opt[data-cat]').forEach(function (o) {
      o.classList.toggle('active', o.dataset.cat === selectedCategory);
    });
  }
  function selectCategory(id) {
    selectedCategory = id;
    catGrid.querySelectorAll('.cat-opt[data-cat]').forEach(function (o) { o.classList.toggle('active', o.dataset.cat === id); });
  }
  function removeCustomCategory(id) {
    var c = catById(id);
    if (!confirm('Remover a categoria "' + c.label + '"? Compras que a usam passarão para "Outros".')) return;
    customCategories = customCategories.filter(function (cc) { return cc.id !== id; });
    saveCustomCategories();
    if (selectedCategory === id) selectedCategory = 'shopping';
    renderCatGrid();
    renderAll();
  }

  // ---- new category sheet ----
  var catBackdrop = document.getElementById('catBackdrop');
  var fCatName = document.getElementById('fCatName');
  var fCatIcon = document.getElementById('fCatIcon');
  var colorGrid = document.getElementById('colorGrid');
  var selectedColor = COLOR_PALETTE[0];

  COLOR_PALETTE.forEach(function (color) {
    var sw = el('button', 'color-opt');
    sw.type = 'button';
    sw.style.background = color;
    sw.dataset.color = color;
    sw.onclick = function () { selectColor(color); };
    colorGrid.appendChild(sw);
  });
  function selectColor(color) {
    selectedColor = color;
    colorGrid.querySelectorAll('.color-opt').forEach(function (sw) { sw.classList.toggle('active', sw.dataset.color === color); });
  }

  function openCatSheet() {
    fCatName.value = '';
    fCatIcon.value = '';
    document.getElementById('eCatName').hidden = true;
    fCatName.classList.remove('err');
    selectColor(COLOR_PALETTE[Math.floor(Math.random() * COLOR_PALETTE.length)]);
    catBackdrop.classList.add('open');
    document.body.style.overflow = 'hidden';
    setTimeout(function () { fCatName.focus(); }, 300);
  }
  function closeCatSheet() {
    catBackdrop.classList.remove('open');
    document.body.style.overflow = '';
  }
  document.getElementById('catCancelBtn').onclick = closeCatSheet;
  catBackdrop.addEventListener('click', function (ev) { if (ev.target === catBackdrop) closeCatSheet(); });
  document.getElementById('catSaveBtn').onclick = function () {
    var name = fCatName.value.trim();
    if (!name) {
      document.getElementById('eCatName').hidden = false;
      fCatName.classList.add('err');
      return;
    }
    var icon = fCatIcon.value.trim() || '📁';
    var cat = { id: 'custom_' + uid(), label: name, icon: icon, color: selectedColor, custom: true };
    customCategories.push(cat);
    saveCustomCategories();
    renderCatGrid();
    selectCategory(cat.id);
    closeCatSheet();
    showToast('Categoria adicionada');
  };

  function openSheet() { backdrop.classList.add('open'); document.body.style.overflow = 'hidden'; }
  function closeSheet() {
    backdrop.classList.remove('open');
    document.body.style.overflow = '';
    editingId = null;
  }

  function clearErrors() {
    ['eName','eTotal','eParc'].forEach(function (id) { document.getElementById(id).hidden = true; });
    [fName, fTotal, fParc].forEach(function (n) { n.classList.remove('err'); });
  }

  function openNew() {
    editingId = null;
    document.getElementById('sheetTitle').textContent = 'Nova compra';
    document.getElementById('saveBtn').textContent = 'Salvar';
    fName.value = '';
    fTotal.value = '';
    fParc.value = '';
    fDate.value = currentYM();
    fDay.value = 5;
    selectCategory('shopping');
    setAmountMode('per');
    clearErrors();
    updateHint();
    openSheet();
    setTimeout(function () { fName.focus(); }, 300);
  }

  function openEdit(id) {
    var e = find(id);
    if (!e) return;
    editingId = id;
    confirmId = null;
    document.getElementById('sheetTitle').textContent = 'Editar compra';
    document.getElementById('saveBtn').textContent = 'Salvar alterações';
    fName.value = e.name;
    var perValue = e.total / e.installments;
    fTotal.value = perValue.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    fParc.value = e.installments;
    fDate.value = e.start;
    fDay.value = e.dueDay || 5;
    selectCategory(e.category || 'other');
    setAmountMode('per');
    clearErrors();
    updateHint();
    openSheet();
  }

  function updateHint() {
    var amount = parseAmount(fTotal.value);
    var parc = parseInt(fParc.value, 10);
    if (!isNaN(amount) && amount > 0 && parc >= 1) {
      if (amountMode === 'per') {
        hParc.textContent = 'Valor total: ' + fmtBRL.format(amount * parc);
      } else {
        hParc.textContent = 'Valor por parcela: ' + fmtBRL.format(amount / parc);
      }
      hParc.style.color = 'var(--brand)';
    } else {
      hParc.textContent = 'Valor total aparece aqui.';
      hParc.style.color = '';
    }
  }

  function saveForm() {
    clearErrors();
    var name = fName.value.trim();
    var amount = parseAmount(fTotal.value);
    var parc = parseInt(fParc.value, 10);
    var start = fDate.value || currentYM();
    var dueDay = parseInt(fDay.value, 10);
    if (isNaN(dueDay) || dueDay < 1) dueDay = 5;
    if (dueDay > 28) dueDay = 28;
    var ok = true;

    if (!name) { document.getElementById('eName').hidden = false; fName.classList.add('err'); ok = false; }
    if (isNaN(amount) || amount <= 0) { document.getElementById('eTotal').hidden = false; fTotal.classList.add('err'); ok = false; }
    if (isNaN(parc) || parc < 1) { document.getElementById('eParc').hidden = false; fParc.classList.add('err'); ok = false; }
    if (!ok) return;

    if (parc > 360) parc = 360;

    var total = amountMode === 'per' ? Math.round(amount * parc * 100) / 100 : amount;

    if (editingId) {
      var e = find(editingId);
      if (e) {
        e.name = name;
        e.total = total;
        e.installments = parc;
        e.start = start;
        e.dueDay = dueDay;
        e.category = selectedCategory;
        if ((e.paid || 0) > parc) e.paid = parc;
      }
    } else {
      state.unshift({
        id: uid(), name: name, total: total, installments: parc, start: start,
        dueDay: dueDay, category: selectedCategory, paid: 0
      });
    }
    save();
    closeSheet();
    renderAll();
    showToast(editingId ? 'Alterações salvas' : 'Compra adicionada');
  }

  // ---- toast ----
  var toastEl = document.getElementById('toast');
  var toastTimer = null;
  function showToast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('show'); }, 2200);
  }

  // ---- theme ----
  var themeSeg = document.getElementById('themeSeg');
  function applyTheme(mode) {
    if (mode === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', mode);
    themeSeg.querySelectorAll('.seg-btn').forEach(function (b) { b.classList.toggle('active', b.dataset.theme === mode); });
    localStorage.setItem(THEME_KEY, mode);
  }
  themeSeg.querySelectorAll('.seg-btn').forEach(function (b) {
    b.onclick = function () { applyTheme(b.dataset.theme); };
  });
  applyTheme(localStorage.getItem(THEME_KEY) || 'system');

  // ---- settings: backup / restore / wipe ----
  document.getElementById('exportBtn').onclick = function () {
    var blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    var stamp = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = 'parcelas-backup-' + stamp + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
    showToast('Backup exportado');
  };

  document.getElementById('importFile').addEventListener('change', function (ev) {
    var file = ev.target.files && ev.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var data = JSON.parse(reader.result);
        if (!Array.isArray(data)) throw new Error('formato inválido');
        state = data.map(normalize);
        save();
        renderAll();
        showToast('Backup importado com sucesso');
      } catch (e) {
        showToast('Arquivo inválido');
      }
      ev.target.value = '';
    };
    reader.readAsText(file);
  });

  // export the real SQLite database file
  var exportDbBtn = document.getElementById('exportDbBtn');
  if (exportDbBtn) exportDbBtn.onclick = function () {
    if (!dbReady || !db) { showToast('Banco SQLite indisponível agora'); return; }
    try {
      var bin = db.export();
      var blob = new Blob([bin], { type: 'application/x-sqlite3' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      var stamp = new Date().toISOString().slice(0, 10);
      a.href = url;
      a.download = 'financeiro-' + stamp + '.sqlite';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
      showToast('Banco exportado');
    } catch (e) { showToast('Falha ao exportar banco'); }
  };

  // restore from a SQLite database file
  var importDbFile = document.getElementById('importDbFile');
  if (importDbFile) importDbFile.addEventListener('change', function (ev) {
    var file = ev.target.files && ev.target.files[0];
    if (!file) return;
    if (!SQL) { showToast('SQLite indisponível agora'); ev.target.value = ''; return; }
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var incoming = new SQL.Database(new Uint8Array(reader.result));
        incoming.run('CREATE TABLE IF NOT EXISTS expenses (id TEXT PRIMARY KEY, pos INTEGER, json TEXT)');
        db = incoming;
        dbReady = true;
        state = readStateFromDb();
        try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {}
        persistNow();
        renderAll();
        updateStorageStatus();
        showToast('Banco restaurado (' + state.length + ' compras)');
      } catch (e) { showToast('Arquivo .sqlite inválido'); }
      ev.target.value = '';
    };
    reader.readAsArrayBuffer(file);
  });

  document.getElementById('wipeBtn').onclick = function () {
    if (!state.length) { showToast('Não há dados para apagar'); return; }
    if (confirm('Apagar todas as ' + state.length + ' compras cadastradas? Esta ação não pode ser desfeita.')) {
      state = [];
      confirmId = null;
      save();
      renderAll();
      showToast('Todos os dados foram apagados');
    }
  };

  // ---- install (PWA) ----
  var deferredPrompt = null;
  var isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  var isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  window.addEventListener('beforeinstallprompt', function (ev) {
    ev.preventDefault();
    deferredPrompt = ev;
    document.getElementById('installGroup').hidden = false;
  });
  document.getElementById('installBtn').onclick = function () {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    deferredPrompt.userChoice.finally(function () {
      deferredPrompt = null;
      document.getElementById('installGroup').hidden = true;
    });
  };
  if (isIOS && !isStandalone) {
    document.getElementById('iosHintGroup').hidden = false;
  }

  // ---- service worker ----
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    });
  }

  // ---- events ----
  document.getElementById('fab').onclick = openNew;
  document.getElementById('cancelBtn').onclick = closeSheet;
  document.getElementById('saveBtn').onclick = saveForm;
  fTotal.addEventListener('input', updateHint);
  fParc.addEventListener('input', updateHint);
  backdrop.addEventListener('click', function (ev) { if (ev.target === backdrop) closeSheet(); });
  document.addEventListener('keydown', function (ev) {
    if (ev.key !== 'Escape') return;
    if (backdrop.classList.contains('open')) closeSheet();
    if (dayBackdrop.classList.contains('open')) closeDaySheet();
  });

  // today label
  (function () {
    var d = new Date();
    var s = d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' });
    document.getElementById('today').textContent = s.charAt(0).toUpperCase() + s.slice(1);
  })();

  renderCatGrid();
  initDB().then(function () {
    updateStorageStatus();
    renderAll();
  });

  // persist the DB file when leaving/hiding, as a safety net for the debounced write
  window.addEventListener('pagehide', persistNow);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') persistNow();
  });
})();
