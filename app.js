(function () {
  'use strict';

  var KEY = 'parcela-tracker:v1';
  var fmtBRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
  var monthNames = ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];

  // ---- storage ----
  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return [];
      var data = JSON.parse(raw);
      return Array.isArray(data) ? data : [];
    } catch (e) {
      return [];
    }
  }
  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
      return true;
    } catch (e) {
      return false;
    }
  }

  var state = load();
  var editingId = null;
  var confirmId = null;

  // ---- helpers ----
  function uid() {
    return 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }
  function nowYM() {
    var d = new Date();
    return { y: d.getFullYear(), m: d.getMonth() }; // m 0-based
  }
  // months elapsed since start (0-based index of current installment). start = "YYYY-MM"
  function monthsSince(startYM) {
    var parts = startYM.split('-');
    var sy = parseInt(parts[0], 10), sm = parseInt(parts[1], 10) - 1;
    var n = nowYM();
    return (n.y - sy) * 12 + (n.m - sm);
  }
  function ymLabel(startYM) {
    var parts = startYM.split('-');
    return monthNames[parseInt(parts[1], 10) - 1] + '/' + parts[0].slice(2);
  }
  function currentYM() {
    var n = nowYM();
    return n.y + '-' + String(n.m + 1).padStart(2, '0');
  }
  // parse a pt-BR-ish number string ("1.000,50" or "1000.50" or "1000,50")
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

  function renderCards() {
    var wrap = document.getElementById('cards');
    wrap.innerHTML = '';
    document.getElementById('count').textContent = state.length;

    if (!state.length) {
      var empty = el('div', 'empty');
      empty.innerHTML = '<div class="ico">🧾</div><h3>Nenhuma parcela ainda</h3><p>Toque em “Adicionar” para cadastrar sua primeira compra parcelada.</p>';
      wrap.appendChild(empty);
      return;
    }

    state.forEach(function (e) {
      var d = derive(e);
      var card = el('div', 'card' + (d.done ? ' done' : ''));

      var top = el('div', 'card-top');
      var left = el('div');
      left.appendChild(el('div', 'card-name', escapeHtml(e.name)));
      left.appendChild(el('div', 'card-total',
        '<b>' + fmtBRL.format(e.total) + '</b> em ' + e.installments + 'x · início ' + ymLabel(e.start)));
      top.appendChild(left);
      var badge = el('div', 'badge' + (d.done ? ' paidoff' : ''),
        d.done ? '✓ Quitado' : (d.paid + '/' + e.installments));
      top.appendChild(badge);
      card.appendChild(top);

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
      delBtn.onclick = function () { confirmId = e.id; renderCards(); };
      acts.appendChild(delBtn);

      card.appendChild(acts);

      // inline delete confirm
      if (confirmId === e.id) {
        var cf = el('div', 'confirm');
        cf.innerHTML = '<p>Excluir “' + escapeHtml(e.name) + '”? Esta ação não pode ser desfeita.</p>';
        var row = el('div', 'row');
        var no = el('button', 'btn', 'Cancelar');
        no.onclick = function () { confirmId = null; renderCards(); };
        var yes = el('button', 'btn yes', 'Excluir');
        yes.onclick = function () { removeExpense(e.id); };
        row.appendChild(no); row.appendChild(yes);
        cf.appendChild(row);
        card.appendChild(cf);
      }

      wrap.appendChild(card);
    });
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
    }
  }
  function removeExpense(id) {
    state = state.filter(function (e) { return e.id !== id; });
    confirmId = null;
    save();
    renderAll();
  }
  function find(id) {
    for (var i = 0; i < state.length; i++) if (state[i].id === id) return state[i];
    return null;
  }

  function renderAll() { renderDash(); renderCards(); }

  // ---- sheet / form ----
  var backdrop = document.getElementById('backdrop');
  var fName = document.getElementById('fName');
  var fTotal = document.getElementById('fTotal');
  var fParc = document.getElementById('fParc');
  var fDate = document.getElementById('fDate');
  var hParc = document.getElementById('hParc');

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
    fTotal.value = e.total.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    fParc.value = e.installments;
    fDate.value = e.start;
    clearErrors();
    updateHint();
    openSheet();
  }

  function updateHint() {
    var total = parseAmount(fTotal.value);
    var parc = parseInt(fParc.value, 10);
    if (!isNaN(total) && total > 0 && parc >= 1) {
      hParc.textContent = 'Valor por parcela: ' + fmtBRL.format(total / parc);
      hParc.style.color = 'var(--brand)';
    } else {
      hParc.textContent = 'Valor por parcela aparece aqui.';
      hParc.style.color = '';
    }
  }

  function saveForm() {
    clearErrors();
    var name = fName.value.trim();
    var total = parseAmount(fTotal.value);
    var parc = parseInt(fParc.value, 10);
    var start = fDate.value || currentYM();
    var ok = true;

    if (!name) { document.getElementById('eName').hidden = false; fName.classList.add('err'); ok = false; }
    if (isNaN(total) || total <= 0) { document.getElementById('eTotal').hidden = false; fTotal.classList.add('err'); ok = false; }
    if (isNaN(parc) || parc < 1) { document.getElementById('eParc').hidden = false; fParc.classList.add('err'); ok = false; }
    if (!ok) return;

    if (parc > 360) parc = 360;

    if (editingId) {
      var e = find(editingId);
      if (e) {
        e.name = name;
        e.total = total;
        e.installments = parc;
        e.start = start;
        if ((e.paid || 0) > parc) e.paid = parc;
      }
    } else {
      state.unshift({ id: uid(), name: name, total: total, installments: parc, start: start, paid: 0 });
    }
    save();
    closeSheet();
    renderAll();
  }

  // ---- events ----
  document.getElementById('fab').onclick = openNew;
  document.getElementById('cancelBtn').onclick = closeSheet;
  document.getElementById('saveBtn').onclick = saveForm;
  fTotal.addEventListener('input', updateHint);
  fParc.addEventListener('input', updateHint);
  backdrop.addEventListener('click', function (ev) { if (ev.target === backdrop) closeSheet(); });
  document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape' && backdrop.classList.contains('open')) closeSheet(); });

  // today label
  (function () {
    var d = new Date();
    var s = d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' });
    document.getElementById('today').textContent = s.charAt(0).toUpperCase() + s.slice(1);
  })();

  renderAll();
})();
