(function () {
  'use strict';

  var KEY = 'parcela-tracker:v2';
  var KEY_OLD = 'parcela-tracker:v1';
  var REV_KEY = 'parcela-tracker:v2:rev';   // "quando" o dado local foi salvo pela última vez
  var THEME_KEY = 'parcela-tracker:theme';
  var CUSTOM_CAT_KEY = 'parcela-tracker:customCategories';
  var SALARY_KEY = 'parcela-tracker:salary';   // salário mensal — por aparelho
  var SPEND_KEY = 'parcela-tracker:spending';        // espelho dos gastos do dia a dia
  var SPEND_REV_KEY = 'parcela-tracker:spending:rev';
  var NOTES_KEY = 'parcela-tracker:notes';           // lembretes livres do calendário
  var NOTES_REV_KEY = 'parcela-tracker:notes:rev';
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
    e.fixed = !!e.fixed;                 // gasto fixo mensal (repete todo mês)
    if (e.fixed && (!e.installments || e.installments < 1)) e.installments = 1;
    return e;
  }

  // "rev" = carimbo de tempo da última gravação. Serve para decidir, na abertura,
  // qual cópia (localStorage ou SQLite) é a MAIS RECENTE e nunca deixar o banco
  // antigo sobrescrever uma edição mais nova (evita o "reset").
  function readLsRev() {
    try { return parseInt(localStorage.getItem(REV_KEY), 10) || 0; } catch (e) { return 0; }
  }
  function writeLsRev(rev) {
    try { localStorage.setItem(REV_KEY, String(rev)); } catch (e) {}
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
    db.run('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)');
    // aba "Gastos": lançamentos do dia a dia + anexos (extratos/comprovantes)
    db.run('CREATE TABLE IF NOT EXISTS spending (id TEXT PRIMARY KEY, pos INTEGER, json TEXT)');
    db.run('CREATE TABLE IF NOT EXISTS attachments (id TEXT PRIMARY KEY, name TEXT, type TEXT, data BLOB)');
    // lembretes livres marcados no calendário (não ligados a nenhuma compra)
    db.run('CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, pos INTEGER, json TEXT)');
  }
  function readMeta(k) {
    try {
      var res = db.exec("SELECT v FROM meta WHERE k=?", [k]);
      if (res.length && res[0].values && res[0].values.length) return res[0].values[0][0];
    } catch (e) {}
    return null;
  }
  function writeMeta(k, v) {
    try { db.run('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)', [k, String(v)]); } catch (e) {}
  }
  function readDbRev() {
    try {
      var res = db.exec("SELECT v FROM meta WHERE k='rev'");
      if (res.length && res[0].values && res[0].values.length) {
        return parseInt(res[0].values[0][0], 10) || 0;
      }
    } catch (e) {}
    return 0;
  }
  function writeDbRev(rev) {
    try { db.run("INSERT OR REPLACE INTO meta (k, v) VALUES ('rev', ?)", [String(rev)]); } catch (e) {}
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
  function writeStateToDb(rev) {
    db.run('BEGIN');
    db.run('DELETE FROM expenses');
    var stmt = db.prepare('INSERT INTO expenses (id, pos, json) VALUES (?, ?, ?)');
    for (var i = 0; i < state.length; i++) {
      stmt.run([String(state[i].id), i, JSON.stringify(state[i])]);
    }
    stmt.free();
    if (rev != null) writeDbRev(rev);
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

  // Save: mirror to localStorage (instant + safe) + write to SQLite + persist the DB file.
  // Um único "rev" (agora) é gravado nos dois lugares para que a próxima abertura
  // saiba qual cópia é a mais recente.
  function save() {
    var ok = false;
    var rev = Date.now();
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
      writeLsRev(rev);
      ok = true;
    } catch (e) {}
    if (dbReady && db) {
      try { writeStateToDb(rev); schedulePersist(); ok = true; } catch (e) {}
    }
    updateStorageStatus();
    return ok;
  }

  // ---- storage dos GASTOS (dia a dia) ----
  // Estrutura: { entries: [ {id,name,amount,date,method,note,attachments:[{id,name,type}]} ], docs: { 'YYYY-MM': [{id,name,type}] } }
  // Metadados vão pro localStorage (offline) + tabela SQLite; os arquivos (fotos/PDF)
  // ficam na tabela attachments (BLOB), então entram no backup .sqlite.
  var spend = { entries: [], docs: {} };

  function normalizeSpend(d) {
    if (!d || typeof d !== 'object') d = {};
    if (!Array.isArray(d.entries)) d.entries = [];
    if (!d.docs || typeof d.docs !== 'object') d.docs = {};
    d.entries.forEach(function (e) {
      if (!Array.isArray(e.attachments)) e.attachments = [];
      if (typeof e.amount !== 'number') e.amount = parseFloat(e.amount) || 0;
      if (!e.method) e.method = 'pix';
    });
    return d;
  }
  function loadSpendLS() {
    try {
      var raw = localStorage.getItem(SPEND_KEY);
      return normalizeSpend(raw ? JSON.parse(raw) : null);
    } catch (e) { return { entries: [], docs: {} }; }
  }
  function readSpendingFromDb() {
    try {
      var res = db.exec("SELECT json FROM spending WHERE id='__data__'");
      if (res.length && res[0].values && res[0].values.length) {
        return normalizeSpend(JSON.parse(res[0].values[0][0]));
      }
    } catch (e) {}
    return { entries: [], docs: {} };
  }
  function writeSpendingToDb(rev) {
    try {
      db.run("INSERT OR REPLACE INTO spending (id, pos, json) VALUES ('__data__', 0, ?)", [JSON.stringify(spend)]);
      if (rev != null) writeMeta('spendrev', rev);
    } catch (e) {}
  }
  function saveSpend() {
    var rev = Date.now();
    try { localStorage.setItem(SPEND_KEY, JSON.stringify(spend)); localStorage.setItem(SPEND_REV_KEY, String(rev)); } catch (e) {}
    if (dbReady && db) { try { writeSpendingToDb(rev); schedulePersist(); } catch (e) {} }
  }
  function reconcileSpending() {
    var lsData = loadSpendLS();
    var lsRev = parseInt(localStorage.getItem(SPEND_REV_KEY), 10) || 0;
    if (dbReady && db) {
      var dbData = readSpendingFromDb();
      var dbRev = parseInt(readMeta('spendrev'), 10) || 0;
      var lsHas = lsData.entries.length || Object.keys(lsData.docs).length;
      var dbHas = dbData.entries.length || Object.keys(dbData.docs).length;
      if (lsRev > dbRev) {
        spend = lsData; writeSpendingToDb(lsRev); persistNow();
      } else if (dbRev > lsRev) {
        spend = dbData;
        try { localStorage.setItem(SPEND_KEY, JSON.stringify(spend)); localStorage.setItem(SPEND_REV_KEY, String(dbRev)); } catch (e) {}
      } else {
        spend = dbHas ? dbData : lsData;
        if (!dbHas && lsHas) { writeSpendingToDb(lsRev || Date.now()); persistNow(); }
      }
    } else {
      spend = lsData;
    }
  }

  // ---- storage dos LEMBRETES livres do calendário ----
  // Estrutura: [ {id, text, y, m, day} ] — mesmo padrão de espelho da "spending".
  var notes = [];

  function normalizeNotes(arr) {
    if (!Array.isArray(arr)) arr = [];
    arr.forEach(function (n) {
      if (!n.id) n.id = uid();
      if (!n.text) n.text = '';
      if (typeof n.y !== 'number') n.y = new Date().getFullYear();
      if (typeof n.m !== 'number') n.m = new Date().getMonth();
      if (typeof n.day !== 'number') n.day = 1;
    });
    return arr;
  }
  function loadNotesLS() {
    try {
      var raw = localStorage.getItem(NOTES_KEY);
      return normalizeNotes(raw ? JSON.parse(raw) : []);
    } catch (e) { return []; }
  }
  function readNotesFromDb() {
    try {
      var res = db.exec("SELECT json FROM notes WHERE id='__data__'");
      if (res.length && res[0].values && res[0].values.length) {
        return normalizeNotes(JSON.parse(res[0].values[0][0]));
      }
    } catch (e) {}
    return [];
  }
  function writeNotesToDb(rev) {
    try {
      db.run("INSERT OR REPLACE INTO notes (id, pos, json) VALUES ('__data__', 0, ?)", [JSON.stringify(notes)]);
      if (rev != null) writeMeta('notesrev', rev);
    } catch (e) {}
  }
  function saveNotes() {
    var rev = Date.now();
    try { localStorage.setItem(NOTES_KEY, JSON.stringify(notes)); localStorage.setItem(NOTES_REV_KEY, String(rev)); } catch (e) {}
    if (dbReady && db) { try { writeNotesToDb(rev); schedulePersist(); } catch (e) {} }
  }
  function reconcileNotes() {
    var lsData = loadNotesLS();
    var lsRev = parseInt(localStorage.getItem(NOTES_REV_KEY), 10) || 0;
    if (dbReady && db) {
      var dbData = readNotesFromDb();
      var dbRev = parseInt(readMeta('notesrev'), 10) || 0;
      if (lsRev > dbRev) {
        notes = lsData; writeNotesToDb(lsRev); persistNow();
      } else if (dbRev > lsRev) {
        notes = dbData;
        try { localStorage.setItem(NOTES_KEY, JSON.stringify(notes)); localStorage.setItem(NOTES_REV_KEY, String(dbRev)); } catch (e) {}
      } else {
        notes = dbData.length ? dbData : lsData;
        if (!dbData.length && lsData.length) { writeNotesToDb(lsRev || Date.now()); persistNow(); }
      }
    } else {
      notes = lsData;
    }
  }

  // anexos (BLOB) na tabela attachments
  function putAttachment(id, name, type, uint8) {
    if (!dbReady || !db) return false;
    try { db.run('INSERT OR REPLACE INTO attachments (id, name, type, data) VALUES (?, ?, ?, ?)', [id, name || '', type || '', uint8]); schedulePersist(); return true; }
    catch (e) { return false; }
  }
  function getAttachmentBlob(id) {
    if (!dbReady || !db) return null;
    try {
      var st = db.prepare('SELECT type, data FROM attachments WHERE id=?');
      st.bind([id]);
      var blob = null;
      if (st.step()) { var row = st.get(); blob = new Blob([row[1]], { type: row[0] || 'application/octet-stream' }); }
      st.free();
      return blob;
    } catch (e) { return null; }
  }
  function delAttachment(id) {
    if (!dbReady || !db) return;
    try { db.run('DELETE FROM attachments WHERE id=?', [id]); schedulePersist(); } catch (e) {}
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

          // Reconciliação por revisão: escolhe a cópia MAIS RECENTE entre o banco
          // SQLite e o espelho no localStorage. Assim uma edição feita enquanto o
          // banco estava indisponível (offline/CDN) nunca é apagada por um banco
          // mais antigo — a causa do "reset" anterior.
          var dbState = readStateFromDb();
          var dbRev = readDbRev();
          var lsState = load();
          var lsRev = readLsRev();

          if (lsRev > dbRev) {
            // localStorage é mais novo → ele manda; sincroniza o banco.
            state = lsState;
            writeStateToDb(lsRev);
            persistNow();
          } else if (dbRev > lsRev) {
            // banco é mais novo → ele manda; sincroniza o localStorage.
            state = dbState;
            try { localStorage.setItem(KEY, JSON.stringify(state)); writeLsRev(dbRev); } catch (e) {}
          } else {
            // mesma revisão (ou ambos sem rev, ex.: dados antigos) → usa o que tiver dados,
            // preferindo o banco quando os dois têm.
            state = dbState.length ? dbState : lsState;
            if (!dbState.length && lsState.length) { writeStateToDb(lsRev || Date.now()); persistNow(); }
          }
        } else {
          db = new SQL.Database();
          ensureSchema();
          dbReady = true;
          state = load();                       // first run → migrate existing data in
          writeStateToDb(readLsRev() || Date.now());
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
    if (e.fixed) {
      // gasto fixo: o valor é o mensal; não há parcelas, dívida nem progresso
      return {
        per: e.total, paid: 0, remaining: 0, pct: 0,
        done: false, canPay: false, nextIdx: 0, fixed: true
      };
    }
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

  // ---- salário (guardado por aparelho, como o tema) ----
  function getSalary() {
    try { var v = parseFloat(localStorage.getItem(SALARY_KEY)); return isNaN(v) ? 0 : v; }
    catch (e) { return 0; }
  }
  function setSalary(v) {
    try {
      if (v > 0) localStorage.setItem(SALARY_KEY, String(v));
      else localStorage.removeItem(SALARY_KEY);
    } catch (e) {}
  }

  // atualiza só o card "Sobra do salário" (salário − compromisso mensal)
  function renderSalary(monthly) {
    var salary = getSalary();
    var leftEl = document.getElementById('stLeft');
    var metaEl = document.getElementById('stLeftMeta');
    if (!leftEl || !metaEl) return;

    if (salary <= 0) {
      leftEl.textContent = '—';
      leftEl.className = 'value live';
      metaEl.textContent = 'Informe seu salário para ver o quanto sobra';
      return;
    }
    var left = salary - monthly;
    leftEl.textContent = fmtBRL.format(left);
    leftEl.className = 'value live ' + (left < 0 ? 'danger' : 'ok');
    var pct = Math.round((monthly / salary) * 100);
    if (left < 0) {
      metaEl.textContent = 'Passou ' + fmtBRL.format(-left) + ' do salário (' + pct + '% comprometido)';
    } else {
      metaEl.textContent = 'de ' + fmtBRL.format(salary) + ' · ' + pct + '% comprometido';
    }
  }

  // ---- dashboard ----
  function renderDash() {
    var monthly = 0, remaining = 0, total = 0, paidSum = 0, active = 0;
    state.forEach(function (e) {
      var d = derive(e);
      if (e.fixed) {
        // gasto fixo: soma no compromisso do mês, mas não é dívida/total parcelado
        monthly += d.per; active++;
        return;
      }
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
    renderSalary(monthly);
  }

  // ---- cards ----
  function el(tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }

  // botões editar/excluir (+ confirmação) reutilizados pelos dois tipos de card
  function appendCardActions(card, e, extraBtns) {
    var acts = el('div', 'card-actions');
    if (extraBtns) extraBtns.forEach(function (b) { acts.appendChild(b); });

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
  }

  // card do gasto fixo: sem barra de progresso nem "pagar parcela"
  function buildFixedCard(e) {
    var cat = catById(e.category);
    var card = el('div', 'card fixed-card');
    card.style.setProperty('--cat-color', cat.color);

    var top = el('div', 'card-top');
    var left = el('div', 'card-name-row');
    left.appendChild(el('div', 'card-cat-ico', escapeHtml(cat.icon)));
    var nameWrap = el('div');
    nameWrap.appendChild(el('div', 'card-name', escapeHtml(e.name)));
    left.appendChild(nameWrap);
    top.appendChild(left);
    top.appendChild(el('div', 'badge fixed-badge', '↻ Todo mês'));
    card.appendChild(top);

    card.appendChild(el('div', 'card-total',
      '<b>' + fmtBRL.format(e.total) + '</b> por mês · vence dia ' + (e.dueDay || 5)));

    var g = el('div', 'grid3');
    g.appendChild(mini('Por mês', fmtBRL.format(e.total)));
    g.appendChild(mini('Vencimento', 'dia ' + (e.dueDay || 5)));
    g.appendChild(mini('Desde', ymLabel(e.start)));
    card.appendChild(g);

    appendCardActions(card, e, null);
    return card;
  }

  function buildCard(e) {
    if (e.fixed) return buildFixedCard(e);
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
  var currentTab = 'home';
  function switchTab(name) {
    currentTab = name;
    tabButtons.forEach(function (b) { b.classList.toggle('active', b.dataset.tab === name); });
    tabPanels.forEach(function (p) { p.hidden = p.dataset.tab !== name; });
    // FAB aparece nas abas que têm "Adicionar" (Início e Gastos)
    fab.classList.toggle('hidden-tab', name !== 'home' && name !== 'spending');
    if (name === 'spending') renderSpending();
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
      if (e.fixed) {
        if (idx >= 0) out.push({ e: e, idx: idx, paid: false });
        return;
      }
      if (idx >= 0 && idx < e.installments) {
        out.push({ e: e, idx: idx, paid: idx < (e.paid || 0) });
      }
    });
    return out;
  }

  function notesForDay(y, m, day) {
    return notes.filter(function (n) { return n.y === y && n.m === m && n.day === day; });
  }

  function renderCalendar() {
    var y = calCursor.y, m = calCursor.m;
    document.getElementById('calTitle').textContent = monthNamesFull[m] + ' de ' + y;

    var occ = monthOccurrences(y, m);
    var totalDue = 0, paidCount = 0;
    occ.forEach(function (o) {
      var per = o.e.fixed ? o.e.total : o.e.total / o.e.installments;
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

    for (var day = 1; day <= dim; day++) {
      var dayOcc = occ.filter(function (o) {
        var dd = Math.min(o.e.dueDay || 5, dim);
        return dd === day;
      });
      var dNotes = notesForDay(y, m, day);
      var cls = 'cal-day';
      if (isCurrentMonth && today.getDate() === day) cls += ' today';
      if (dayOcc.length) {
        cls += ' has-due';
        if (dayOcc.every(function (o) { return o.paid; })) cls += ' paidoff-day';
      }
      var cell = el('div', cls);
      // dia 1 vai direto para a coluna do seu dia da semana (sem células vazias no grid)
      if (day === 1 && first > 0) cell.style.gridColumnStart = first + 1;
      cell.appendChild(el('span', null, String(day)));
      if (dayOcc.length || dNotes.length) {
        var dots = el('div', 'cal-dots');
        if (dayOcc.length) dots.appendChild(el('span', 'dot'));
        if (dNotes.length) dots.appendChild(el('span', 'dot dot-note'));
        cell.appendChild(dots);
      }
      // qualquer dia é clicável: dá pra marcar um lembrete mesmo sem nenhuma parcela vencendo
      cell.addEventListener('click', function (dOcc, dNts, d) {
        return function () { openDaySheet(y, m, d, dOcc, dNts); };
      }(dayOcc, dNotes, day));
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

  var dayNoteCtx = null; // { y, m, day } do dia atualmente aberto na sheet

  function buildNoteRow(n) {
    var row = el('div', 'note-row');
    row.appendChild(el('span', 'note-text', escapeHtml(n.text)));
    var del = el('button', 'btn icon danger sm');
    del.setAttribute('aria-label', 'Excluir lembrete');
    del.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>';
    del.onclick = function () { removeNote(n.id); };
    row.appendChild(del);
    return row;
  }

  function renderDayNoteList() {
    var noteWrap = document.getElementById('dayNoteList');
    noteWrap.innerHTML = '';
    if (!dayNoteCtx) return;
    var dNotes = notesForDay(dayNoteCtx.y, dayNoteCtx.m, dayNoteCtx.day);
    if (!dNotes.length) {
      noteWrap.appendChild(el('div', 'note-empty', 'Nenhum lembrete neste dia.'));
      return;
    }
    dNotes.forEach(function (n) { noteWrap.appendChild(buildNoteRow(n)); });
  }

  function addNote() {
    var input = document.getElementById('dayNoteInput');
    var text = input.value.trim();
    if (!text || !dayNoteCtx) return;
    notes.push({ id: uid(), text: text, y: dayNoteCtx.y, m: dayNoteCtx.m, day: dayNoteCtx.day });
    saveNotes();
    input.value = '';
    renderDayNoteList();
    renderCalendar();
    showToast('Lembrete adicionado');
  }

  function removeNote(id) {
    notes = notes.filter(function (n) { return n.id !== id; });
    saveNotes();
    renderDayNoteList();
    renderCalendar();
  }

  function openDaySheet(y, m, day, occ, dNotes) {
    document.getElementById('daySheetTitle').textContent =
      String(day).padStart(2, '0') + ' de ' + monthNamesFull[m] + ' de ' + y;
    var wrap = document.getElementById('dayList');
    wrap.innerHTML = '';
    (occ || []).forEach(function (o) { wrap.appendChild(buildCard(o.e)); });
    dayNoteCtx = { y: y, m: m, day: day };
    document.getElementById('dayNoteInput').value = '';
    renderDayNoteList();
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
  function closeDaySheet() { dayBackdrop.classList.remove('open'); document.body.style.overflow = ''; dayNoteCtx = null; }
  document.getElementById('dayCloseBtn').onclick = closeDaySheet;
  document.getElementById('dayNoteAddBtn').onclick = addNote;
  document.getElementById('dayNoteInput').addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') { ev.preventDefault(); addNote(); }
  });
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

  // ---- gasto fixo mensal ----
  var fFixed = document.getElementById('fFixed');
  var amountModeField = document.getElementById('amountModeField');
  var parcField = document.getElementById('parcField');
  var fDateLabel = document.getElementById('fDateLabel');
  var fixedMode = false;

  function setFixedMode(on) {
    fixedMode = !!on;
    fFixed.checked = fixedMode;
    fFixed.closest('.fixed-toggle').classList.toggle('on', fixedMode);
    // esconde parcelas e o modo de valor (não fazem sentido pra gasto fixo)
    amountModeField.hidden = fixedMode;
    parcField.hidden = fixedMode;
    if (fixedMode) {
      amountMode = 'per';
      fTotalLabel.textContent = 'Valor mensal (R$)';
      fDateLabel.textContent = 'A partir de (mês)';
    } else {
      fTotalLabel.textContent = amountMode === 'per' ? 'Valor da parcela (R$)' : 'Valor total (R$)';
      fDateLabel.textContent = 'Início (1ª parcela)';
    }
    updateHint();
  }
  fFixed.closest('.fixed-toggle').addEventListener('click', function (ev) {
    ev.preventDefault();
    setFixedMode(!fixedMode);
  });

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
    setFixedMode(false);
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
    var perValue = e.fixed ? e.total : e.total / e.installments;
    fTotal.value = perValue.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    fParc.value = e.fixed ? '' : e.installments;
    fDate.value = e.start;
    fDay.value = e.dueDay || 5;
    selectCategory(e.category || 'other');
    setAmountMode('per');
    setFixedMode(!!e.fixed);
    clearErrors();
    updateHint();
    openSheet();
  }

  function updateHint() {
    var amount = parseAmount(fTotal.value);
    if (fixedMode) {
      if (!isNaN(amount) && amount > 0) {
        hParc.textContent = 'Todo mês: ' + fmtBRL.format(amount);
        hParc.style.color = 'var(--brand)';
      } else {
        hParc.textContent = 'Este valor será cobrado todo mês.';
        hParc.style.color = '';
      }
      return;
    }
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
    if (!fixedMode && (isNaN(parc) || parc < 1)) { document.getElementById('eParc').hidden = false; fParc.classList.add('err'); ok = false; }
    if (!ok) return;

    if (fixedMode) {
      // gasto fixo: 1 valor mensal, sem parcelas
      var totalF = Math.round(amount * 100) / 100;
      if (editingId) {
        var ef = find(editingId);
        if (ef) {
          ef.name = name; ef.total = totalF; ef.installments = 1;
          ef.start = start; ef.dueDay = dueDay; ef.category = selectedCategory;
          ef.fixed = true; ef.paid = 0;
        }
      } else {
        state.unshift({
          id: uid(), name: name, total: totalF, installments: 1, start: start,
          dueDay: dueDay, category: selectedCategory, paid: 0, fixed: true
        });
      }
      save();
      closeSheet();
      renderAll();
      showToast(editingId ? 'Alterações salvas' : 'Gasto fixo adicionado');
      return;
    }

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
        e.fixed = false;
        if ((e.paid || 0) > parc) e.paid = parc;
      }
    } else {
      state.unshift({
        id: uid(), name: name, total: total, installments: parc, start: start,
        dueDay: dueDay, category: selectedCategory, paid: 0, fixed: false
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
    // formato novo: objeto com parcelas + gastos (metadados). As fotos/PDF ficam no
    // backup .sqlite. Import antigo (array puro) continua funcionando.
    var payload = { version: 2, installments: state, spending: spend };
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
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
        if (Array.isArray(data)) {
          state = data.map(normalize);           // backup antigo (só parcelas)
        } else if (data && typeof data === 'object') {
          if (Array.isArray(data.installments)) state = data.installments.map(normalize);
          if (data.spending) { spend = normalizeSpend(data.spending); saveSpend(); }
        } else {
          throw new Error('formato inválido');
        }
        save();
        renderAll();
        renderSpending();
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
        db = new SQL.Database(new Uint8Array(reader.result));
        dbReady = true;
        ensureSchema();                       // garante todas as tabelas (parcelas + gastos + anexos)
        state = readStateFromDb();
        var rev = Date.now();                 // restauração é a versão mais recente
        writeDbRev(rev);
        try { localStorage.setItem(KEY, JSON.stringify(state)); writeLsRev(rev); } catch (e) {}
        // recarrega os gastos do banco restaurado
        spend = readSpendingFromDb();
        writeMeta('spendrev', rev);
        try { localStorage.setItem(SPEND_KEY, JSON.stringify(spend)); localStorage.setItem(SPEND_REV_KEY, String(rev)); } catch (e) {}
        persistNow();
        renderAll();
        renderSpending();
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
      navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' })
        .then(function (reg) {
          // Quando detectar um novo SW instalado, recarrega a página automaticamente
          reg.addEventListener('updatefound', function () {
            var newWorker = reg.installing;
            newWorker.addEventListener('statechange', function () {
              if (newWorker.state === 'activated' && navigator.serviceWorker.controller) {
                window.location.reload();
              }
            });
          });
        })
        .catch(function () {});
    });
  }

  // ---- events ----
  document.getElementById('fab').onclick = function () {
    if (currentTab === 'spending') openSpendNew();
    else openNew();
  };
  document.getElementById('cancelBtn').onclick = closeSheet;
  document.getElementById('saveBtn').onclick = saveForm;
  fTotal.addEventListener('input', updateHint);
  fParc.addEventListener('input', updateHint);
  backdrop.addEventListener('click', function (ev) { if (ev.target === backdrop) closeSheet(); });
  document.addEventListener('keydown', function (ev) {
    if (ev.key !== 'Escape') return;
    if (backdrop.classList.contains('open')) closeSheet();
    if (dayBackdrop.classList.contains('open')) closeDaySheet();
    if (spendBackdrop.classList.contains('open')) closeSpendSheet();
    if (viewer.classList.contains('open')) closeViewer();
  });

  // today label
  (function () {
    var d = new Date();
    var s = d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' });
    document.getElementById('today').textContent = s.charAt(0).toUpperCase() + s.slice(1);
  })();

  // frase do dia — lista embutida (offline, sem depender de API), troca a cada dia
  (function dailyQuote() {
    var el = document.getElementById('dailyQuote');
    if (!el) return;
    var QUOTES = [
      'Cuidar do dinheiro hoje é comprar tranquilidade para amanhã.',
      'Cada parcela quitada é um passo a mais de liberdade.',
      'Não é sobre ganhar muito, é sobre saber para onde vai cada real.',
      'O orçamento não te prende — ele te mostra o caminho.',
      'Pequenos cortes hoje viram grandes conquistas depois.',
      'Quem controla as parcelas controla o próprio futuro.',
      'Dívida planejada é ferramenta; dívida esquecida é armadilha.',
      'O melhor investimento é o gasto que você evitou por consciência.',
      'Saber quanto sobra é o primeiro passo para fazer sobrar mais.',
      'Riqueza é gastar menos do que se ganha, com constância.',
      'Antes de comprar, pergunte: cabe no que sobra?',
      'Organização financeira é liberdade disfarçada de planilha.',
      'Um real guardado hoje trabalha por você amanhã.',
      'O futuro agradece cada decisão consciente do presente.',
      'Não compare seu bolso com o dos outros — compare com o seu de ontem.',
      'Metas claras transformam sonhos em contas pagas.',
      'Gastar bem é uma habilidade; e habilidade se treina.',
      'A paz financeira começa quando os números param de ser surpresa.',
      'Cada mês fechado no azul é uma vitória silenciosa.',
      'Controle é liberdade: você decide, não o boleto.',
      'O dinheiro rende mais quando tem um destino definido.',
      'Consistência vence intensidade quando o assunto é finança.',
      'Quitar é bom; não precisar parcelar é ainda melhor.',
      'Você não precisa de mais dinheiro, precisa de mais clareza.',
      'Todo grande objetivo cabe em pequenas economias diárias.',
      'O segredo não é o quanto entra, é o quanto fica.',
      'Anotar o gasto tira o poder que ele tinha sobre você.',
      'Disciplina de hoje é o conforto que você vai sentir amanhã.'
    ];
    var d = new Date();
    var dayNum = Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 86400000);
    el.textContent = QUOTES[((dayNum % QUOTES.length) + QUOTES.length) % QUOTES.length];
  })();

  // ---- campo de salário ----
  (function setupSalary() {
    var input = document.getElementById('salaryInput');
    if (!input) return;
    var saved = getSalary();
    if (saved > 0) input.value = fmtBRL.format(saved);
    // enquanto digita: interpreta, salva e atualiza a "sobra" ao vivo (sem reformatar)
    input.addEventListener('input', function () {
      var v = parseAmount(input.value);
      setSalary(isNaN(v) ? 0 : v);
      renderDash();
    });
    // ao sair do campo: formata bonitinho (ou limpa se vazio)
    input.addEventListener('blur', function () {
      var v = getSalary();
      input.value = v > 0 ? fmtBRL.format(v) : '';
    });
  })();

  // ============================================================
  //  ABA GASTOS (dia a dia) — UI
  // ============================================================
  var PAY_METHODS = [
    { id: 'pix',      label: 'Pix',      icon: '⚡' },
    { id: 'debito',   label: 'Débito',   icon: '💳' },
    { id: 'credito',  label: 'Crédito',  icon: '🪙' },
    { id: 'dinheiro', label: 'Dinheiro', icon: '💵' }
  ];
  function methodById(id) {
    for (var i = 0; i < PAY_METHODS.length; i++) if (PAY_METHODS[i].id === id) return PAY_METHODS[i];
    return PAY_METHODS[0];
  }
  function localISODate(d) {
    d = d || new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function spendMonthKey() { return spendCursor.y + '-' + String(spendCursor.m + 1).padStart(2, '0'); }

  var spendCursor = (function () { var d = new Date(); return { y: d.getFullYear(), m: d.getMonth() }; })();
  var spendUrls = [];                 // object URLs a revogar entre renders
  function revokeSpendUrls() { spendUrls.forEach(function (u) { try { URL.revokeObjectURL(u); } catch (e) {} }); spendUrls = []; }

  // cria um <img> de miniatura (ou tile de PDF) que abre o visualizador ao tocar
  function attThumb(att) {
    var isImg = (att.type || '').indexOf('image') === 0;
    var tile = el('button', 'att-tile' + (isImg ? '' : ' pdf'));
    tile.type = 'button';
    if (isImg) {
      var img = document.createElement('img');
      var blob = getAttachmentBlob(att.id);
      if (blob) { var u = URL.createObjectURL(blob); spendUrls.push(u); img.src = u; }
      img.alt = att.name || 'Comprovante';
      tile.appendChild(img);
      tile.onclick = function () { openViewerBlob(att.id, true); };
    } else {
      tile.innerHTML = '<span class="att-pdf-ico">📄</span><span class="att-pdf-name">' + escapeHtml((att.name || 'arquivo').slice(0, 14)) + '</span>';
      tile.onclick = function () { openViewerBlob(att.id, false); };
    }
    return tile;
  }

  function renderSpending() {
    var listWrap = document.getElementById('spendList');
    if (!listWrap) return;
    revokeSpendUrls();

    var y = spendCursor.y, m = spendCursor.m, key = spendMonthKey();
    document.getElementById('spendTitle').textContent = monthNamesFull[m] + ' de ' + y;

    var items = spend.entries.filter(function (e) { return e.date && e.date.slice(0, 7) === key; });
    items.sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;      // dia mais recente primeiro
      return (b.createdAt || 0) - (a.createdAt || 0);
    });

    var total = 0, byMethod = {};
    items.forEach(function (e) {
      total += e.amount;
      byMethod[e.method] = (byMethod[e.method] || 0) + e.amount;
    });

    document.getElementById('spendTotal').textContent = fmtBRL.format(total);
    document.getElementById('spendTotalMeta').textContent =
      items.length ? (items.length === 1 ? '1 lançamento' : items.length + ' lançamentos') : 'Nenhum gasto lançado';

    // resumo por forma de pagamento
    var ms = document.getElementById('methodSummary');
    ms.innerHTML = '';
    PAY_METHODS.forEach(function (pm) {
      if (!byMethod[pm.id]) return;
      var chip = el('div', 'method-card m-' + pm.id);
      chip.innerHTML = '<div class="mc-top">' + pm.icon + ' ' + pm.label + '</div>' +
        '<div class="mc-val live">' + fmtBRL.format(byMethod[pm.id]) + '</div>';
      ms.appendChild(chip);
    });

    // extratos/comprovantes do mês
    var docs = (spend.docs && spend.docs[key]) || [];
    document.getElementById('docCount').textContent = docs.length;
    var docStrip = document.getElementById('docStrip');
    docStrip.innerHTML = '';
    if (!docs.length) {
      docStrip.appendChild(el('div', 'doc-empty', 'Nenhum documento neste mês ainda.'));
    } else {
      docs.forEach(function (att) {
        var wrap = el('div', 'doc-tile-wrap');
        wrap.appendChild(attThumb(att));
        var rm = el('button', 'att-remove', '×');
        rm.setAttribute('aria-label', 'Remover');
        rm.onclick = function (ev) { ev.stopPropagation(); removeMonthDoc(key, att.id); };
        wrap.appendChild(rm);
        docStrip.appendChild(wrap);
      });
    }

    // lista de lançamentos agrupada por dia
    listWrap.innerHTML = '';
    document.getElementById('spendCount').textContent = items.length;
    if (!items.length) {
      var empty = el('div', 'empty');
      empty.innerHTML = '<div class="ico">🧾</div><h3>Nenhum gasto no mês</h3><p>Toque em "Adicionar" para lançar seus gastos do dia a dia.</p>';
      listWrap.appendChild(empty);
      return;
    }
    var lastDay = null;
    items.forEach(function (e) {
      if (e.date !== lastDay) {
        lastDay = e.date;
        var p = e.date.split('-');
        var head = el('div', 'spend-day', parseInt(p[2], 10) + ' de ' + monthNamesFull[parseInt(p[1], 10) - 1]);
        listWrap.appendChild(head);
      }
      listWrap.appendChild(buildSpendItem(e));
    });
  }

  function buildSpendItem(e) {
    var pm = methodById(e.method);
    var row = el('div', 'spend-item');
    row.onclick = function () { openSpendEdit(e.id); };

    var main = el('div', 'spend-main');
    var nameRow = el('div', 'spend-name-row');
    nameRow.appendChild(el('span', 'spend-name', escapeHtml(e.name)));
    nameRow.appendChild(el('span', 'pay-chip m-' + pm.id, pm.icon + ' ' + pm.label));
    main.appendChild(nameRow);
    if (e.note) main.appendChild(el('div', 'spend-note', escapeHtml(e.note)));
    if (e.attachments && e.attachments.length) {
      var strip = el('div', 'att-strip mini');
      e.attachments.forEach(function (att) { strip.appendChild(attThumb(att)); });
      main.appendChild(strip);
    }
    row.appendChild(main);
    row.appendChild(el('div', 'spend-amount live', fmtBRL.format(e.amount)));
    return row;
  }

  // ---- visualizador ----
  var viewer = document.getElementById('viewer');
  function openViewerBlob(id, isImg) {
    var blob = getAttachmentBlob(id);
    if (!blob) { showToast('Arquivo indisponível'); return; }
    var url = URL.createObjectURL(blob);
    if (isImg) {
      document.getElementById('viewerImg').src = url;
      viewer.classList.add('open');
      viewer._url = url;
    } else {
      window.open(url, '_blank');
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    }
  }
  function closeViewer() {
    viewer.classList.remove('open');
    if (viewer._url) { try { URL.revokeObjectURL(viewer._url); } catch (e) {} viewer._url = null; }
  }
  document.getElementById('viewerClose').onclick = closeViewer;
  viewer.addEventListener('click', function (ev) { if (ev.target === viewer) closeViewer(); });

  // ---- upload de extratos/comprovantes do mês ----
  function fileToUint8(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(new Uint8Array(r.result)); };
      r.onerror = function () { reject(r.error); };
      r.readAsArrayBuffer(file);
    });
  }
  var docInput = document.getElementById('docInput');
  docInput.addEventListener('change', function (ev) {
    var files = ev.target.files;
    if (!files || !files.length) return;
    if (!dbReady || !db) { showToast('Aguarde o banco carregar para anexar'); ev.target.value = ''; return; }
    var key = spendMonthKey();
    if (!spend.docs[key]) spend.docs[key] = [];
    var chain = Promise.resolve();
    Array.prototype.slice.call(files).forEach(function (file) {
      chain = chain.then(function () {
        return fileToUint8(file).then(function (u8) {
          var id = 'att' + uid();
          putAttachment(id, file.name, file.type, u8);
          spend.docs[key].push({ id: id, name: file.name, type: file.type });
        });
      });
    });
    chain.then(function () {
      saveSpend();
      renderSpending();
      showToast('Documento anexado');
    }).catch(function () { showToast('Falha ao anexar'); });
    ev.target.value = '';
  });
  function removeMonthDoc(key, attId) {
    if (!confirm('Remover este documento?')) return;
    spend.docs[key] = (spend.docs[key] || []).filter(function (a) { return a.id !== attId; });
    delAttachment(attId);
    saveSpend();
    renderSpending();
    showToast('Documento removido');
  }

  // ---- sheet de gasto ----
  var spendBackdrop = document.getElementById('spendBackdrop');
  var sName = document.getElementById('sName');
  var sAmount = document.getElementById('sAmount');
  var sDate = document.getElementById('sDate');
  var sNote = document.getElementById('sNote');
  var paySeg = document.getElementById('paySeg');
  var attStrip = document.getElementById('attStrip');
  var attInput = document.getElementById('attInput');
  var editingSpendId = null;
  var selectedMethod = 'pix';
  var draftAtt = [];                 // {file,name,type}(novo) | {id,name,type,existing:true}

  PAY_METHODS.forEach(function (pm) {
    var b = el('button', 'seg-btn', pm.icon + ' ' + pm.label);
    b.type = 'button';
    b.dataset.method = pm.id;
    b.onclick = function () { selectMethod(pm.id); };
    paySeg.appendChild(b);
  });
  function selectMethod(id) {
    selectedMethod = id;
    paySeg.querySelectorAll('.seg-btn').forEach(function (b) { b.classList.toggle('active', b.dataset.method === id); });
  }

  function renderDraftAtt() {
    attStrip.innerHTML = '';
    draftAtt.forEach(function (a, i) {
      var isImg = (a.type || '').indexOf('image') === 0;
      var wrap = el('div', 'doc-tile-wrap');
      var tile = el('button', 'att-tile' + (isImg ? '' : ' pdf'));
      tile.type = 'button';
      if (isImg) {
        var img = document.createElement('img');
        var u;
        if (a.file) { u = URL.createObjectURL(a.file); }
        else { var blob = getAttachmentBlob(a.id); u = blob ? URL.createObjectURL(blob) : ''; }
        if (u) { spendUrls.push(u); img.src = u; }
        tile.appendChild(img);
      } else {
        tile.innerHTML = '<span class="att-pdf-ico">📄</span><span class="att-pdf-name">' + escapeHtml((a.name || 'arquivo').slice(0, 14)) + '</span>';
      }
      tile.onclick = function () { if (!a.file) openViewerBlob(a.id, isImg); };
      wrap.appendChild(tile);
      var rm = el('button', 'att-remove', '×');
      rm.setAttribute('aria-label', 'Remover');
      rm.onclick = function (ev) { ev.stopPropagation(); draftAtt.splice(i, 1); renderDraftAtt(); };
      wrap.appendChild(rm);
      attStrip.appendChild(wrap);
    });
  }
  attInput.addEventListener('change', function (ev) {
    var files = ev.target.files;
    if (!files) return;
    Array.prototype.slice.call(files).forEach(function (file) {
      draftAtt.push({ file: file, name: file.name, type: file.type });
    });
    renderDraftAtt();
    ev.target.value = '';
  });

  function openSpendSheet() { spendBackdrop.classList.add('open'); document.body.style.overflow = 'hidden'; }
  function closeSpendSheet() { spendBackdrop.classList.remove('open'); document.body.style.overflow = ''; editingSpendId = null; }

  function clearSpendErrors() {
    document.getElementById('esName').hidden = true; sName.classList.remove('err');
    document.getElementById('esAmount').hidden = true; sAmount.classList.remove('err');
  }

  function openSpendNew() {
    editingSpendId = null;
    document.getElementById('spendSheetTitle').textContent = 'Novo gasto';
    document.getElementById('spendDeleteBtn').hidden = true;
    sName.value = '';
    sAmount.value = '';
    // se estiver vendo o mês atual usa hoje; se for um mês passado, usa o dia 1 daquele mês
    var now = new Date();
    if (now.getFullYear() === spendCursor.y && now.getMonth() === spendCursor.m) sDate.value = localISODate(now);
    else sDate.value = spendMonthKey() + '-01';
    sNote.value = '';
    selectMethod('pix');
    draftAtt = [];
    renderDraftAtt();
    clearSpendErrors();
    openSpendSheet();
    setTimeout(function () { sName.focus(); }, 300);
  }
  function openSpendEdit(id) {
    var e = null;
    for (var i = 0; i < spend.entries.length; i++) if (spend.entries[i].id === id) { e = spend.entries[i]; break; }
    if (!e) return;
    editingSpendId = id;
    document.getElementById('spendSheetTitle').textContent = 'Editar gasto';
    document.getElementById('spendDeleteBtn').hidden = false;
    sName.value = e.name;
    sAmount.value = e.amount.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    sDate.value = e.date;
    sNote.value = e.note || '';
    selectMethod(e.method || 'pix');
    draftAtt = (e.attachments || []).map(function (a) { return { id: a.id, name: a.name, type: a.type, existing: true }; });
    renderDraftAtt();
    clearSpendErrors();
    openSpendSheet();
  }

  function saveSpendForm() {
    clearSpendErrors();
    var name = sName.value.trim();
    var amount = parseAmount(sAmount.value);
    var date = sDate.value || localISODate();
    var ok = true;
    if (!name) { document.getElementById('esName').hidden = false; sName.classList.add('err'); ok = false; }
    if (isNaN(amount) || amount <= 0) { document.getElementById('esAmount').hidden = false; sAmount.classList.add('err'); ok = false; }
    if (!ok) return;
    amount = Math.round(amount * 100) / 100;

    // grava anexos novos no banco; mantém os já existentes
    var chain = Promise.resolve();
    var finalAtt = [];
    draftAtt.forEach(function (a) {
      if (a.existing) { finalAtt.push({ id: a.id, name: a.name, type: a.type }); return; }
      chain = chain.then(function () {
        return fileToUint8(a.file).then(function (u8) {
          var id = 'att' + uid();
          if (putAttachment(id, a.name, a.type, u8)) finalAtt.push({ id: id, name: a.name, type: a.type });
        });
      });
    });

    chain.then(function () {
      if (editingSpendId) {
        for (var i = 0; i < spend.entries.length; i++) {
          if (spend.entries[i].id === editingSpendId) {
            var e = spend.entries[i];
            // remove do banco os anexos que foram tirados na edição
            (e.attachments || []).forEach(function (old) {
              if (!finalAtt.some(function (n) { return n.id === old.id; })) delAttachment(old.id);
            });
            e.name = name; e.amount = amount; e.date = date;
            e.method = selectedMethod; e.note = sNote.value.trim(); e.attachments = finalAtt;
            break;
          }
        }
      } else {
        spend.entries.push({
          id: 's' + uid(), name: name, amount: amount, date: date,
          method: selectedMethod, note: sNote.value.trim(), attachments: finalAtt,
          createdAt: Date.now()
        });
      }
      saveSpend();
      closeSpendSheet();
      renderSpending();
      showToast(editingSpendId ? 'Gasto atualizado' : 'Gasto lançado');
    }).catch(function () { showToast('Falha ao salvar'); });
  }

  function deleteSpendEntry() {
    if (!editingSpendId) return;
    if (!confirm('Excluir este gasto?')) return;
    for (var i = 0; i < spend.entries.length; i++) {
      if (spend.entries[i].id === editingSpendId) {
        (spend.entries[i].attachments || []).forEach(function (a) { delAttachment(a.id); });
        spend.entries.splice(i, 1);
        break;
      }
    }
    saveSpend();
    closeSpendSheet();
    renderSpending();
    showToast('Gasto excluído');
  }

  document.getElementById('spendCancelBtn').onclick = closeSpendSheet;
  document.getElementById('spendSaveBtn').onclick = saveSpendForm;
  document.getElementById('spendDeleteBtn').onclick = deleteSpendEntry;
  spendBackdrop.addEventListener('click', function (ev) { if (ev.target === spendBackdrop) closeSpendSheet(); });
  document.getElementById('spendPrev').onclick = function () {
    spendCursor.m--; if (spendCursor.m < 0) { spendCursor.m = 11; spendCursor.y--; } renderSpending();
  };
  document.getElementById('spendNext').onclick = function () {
    spendCursor.m++; if (spendCursor.m > 11) { spendCursor.m = 0; spendCursor.y++; } renderSpending();
  };
  document.getElementById('spendTodayBtn').onclick = function () {
    var d = new Date(); spendCursor = { y: d.getFullYear(), m: d.getMonth() }; renderSpending();
  };

  renderCatGrid();
  initDB().then(function () {
    reconcileSpending();
    reconcileNotes();
    updateStorageStatus();
    renderAll();
    renderSpending();
  });

  // persist the DB file when leaving/hiding, as a safety net for the debounced write
  window.addEventListener('pagehide', persistNow);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') persistNow();
  });
})();
