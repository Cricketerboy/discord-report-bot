// Dashboard behaviour. No framework; all dynamic text goes through textContent (never innerHTML).
(function () {
  'use strict';

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'text') node.textContent = attrs[k];
        else if (k === 'className') node.className = attrs[k];
        else node.setAttribute(k, attrs[k]);
      });
    }
    (children || []).forEach(function (c) {
      if (c) node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }

  function badge(text, tone) {
    return el('span', { className: 'badge badge-' + (tone || 'muted'), text: text });
  }

  function localTime(iso) {
    var d = new Date(iso);
    var secs = Math.round((Date.now() - d.getTime()) / 1000);
    if (secs < 60) return secs + 's ago';
    if (secs < 3600) return Math.floor(secs / 60) + 'm ago';
    if (secs < 86400) return Math.floor(secs / 3600) + 'h ago';
    return d.toLocaleString();
  }

  // Server-rendered <time> elements -> viewer's local time.
  document.querySelectorAll('time[datetime]').forEach(function (t) {
    t.textContent = new Date(t.getAttribute('datetime')).toLocaleString();
  });

  // Confirmation for destructive forms.
  document.querySelectorAll('form[data-confirm]').forEach(function (f) {
    f.addEventListener('submit', function (e) {
      if (!window.confirm(f.getAttribute('data-confirm'))) e.preventDefault();
    });
  });

  // Rule form: show only the value input that matches the chosen condition / action.
  var ruleForm = document.getElementById('rule-form');
  if (ruleForm) {
    var sync = function () {
      var cond = ruleForm.querySelector('[data-cond]').value;
      var act = ruleForm.querySelector('[data-act]').value;
      ruleForm.querySelectorAll('.cond-value [data-for]').forEach(function (i) {
        i.disabled = i.getAttribute('data-for') !== cond;
      });
      ruleForm.querySelectorAll('.act-value [data-for]').forEach(function (i) {
        i.disabled = i.getAttribute('data-for') !== act;
      });
      ruleForm.querySelector('.cond-value').style.display = cond === 'always' ? 'none' : '';
      ruleForm.querySelector('.act-value').style.display = act === 'mirror' || act === 'suppress_mirror' ? 'none' : '';
    };
    ruleForm.querySelector('[data-cond]').addEventListener('change', sync);
    ruleForm.querySelector('[data-act]').addEventListener('change', sync);
    sync();
  }

  // ---------------- live activity log ----------------
  var activity = document.getElementById('activity');
  if (!activity) return;
  var guildId = activity.getAttribute('data-guild');
  var tbody = document.querySelector('#activity-table tbody');
  var eventsList = document.getElementById('events-list');
  var live = document.getElementById('live');
  var known = null;

  var RESPONSE = { 1: 'pong', 4: 'message', 5: 'deferred', 6: 'deferred update', 7: 'updated message', 9: 'opened form' };
  var JOB_LABEL = {
    'report.process': 'triage',
    'discord.reply': 'reply',
    'discord.post_report': 'channel post',
    'mirror.send': 'mirror',
    'status.reply': 'status reply',
    'component.apply': 'button update',
  };
  var OUTCOME_TONE = { completed: 'ok', processing: 'info', received: 'info', partial: 'warn', failed: 'err', rejected: 'muted' };

  function jobBadge(j) {
    var label = JOB_LABEL[j.kind] || j.kind;
    var b;
    if (j.status === 'succeeded') b = badge('✓ ' + label, 'ok');
    else if (j.status === 'dead') b = badge('✗ ' + label, 'err');
    else if (j.attempts > 0 && j.status === 'pending') b = badge('↻ ' + label + ' (' + j.attempts + '/' + j.maxAttempts + ')', 'warn');
    else b = badge('… ' + label, 'info');
    if (j.lastError) b.title = j.lastError;
    return b;
  }

  function renderActivity(items) {
    tbody.textContent = '';
    if (!items.length) {
      tbody.appendChild(el('tr', null, [el('td', { colspan: '7', className: 'muted', text: 'No commands yet. Run /report or /status in your Discord server.' })]));
      return;
    }
    var fresh = known ? items.filter(function (i) { return !known[i.id]; }) : [];
    known = {};
    items.forEach(function (i) {
      known[i.id] = true;
      var reply = i.responseType ? RESPONSE[i.responseType] || String(i.responseType) : '—';
      var replyCell = el('td', null, [reply, i.responseMs != null ? el('div', { className: 'muted small', text: i.responseMs + ' ms' }) : null]);
      var inputCell = el('td', null, [el('div', { className: 'clamp', text: i.input || '' })]);
      if (i.report) {
        inputCell.appendChild(el('div', { className: 'chips' }, [
          badge('#' + i.report.id, 'muted'),
          badge(i.report.severity, { low: 'ok', medium: 'info', high: 'warn', critical: 'err' }[i.report.severity]),
          badge(i.report.category, 'muted'),
          badge(i.report.status, { open: 'warn', acknowledged: 'info', resolved: 'ok' }[i.report.status]),
        ]));
        if (i.report.summary) inputCell.appendChild(el('div', { className: 'muted small', text: 'AI: ' + i.report.summary }));
      }
      var actions = el('td', null, [el('div', { className: 'chips' }, i.jobs.map(jobBadge))]);
      if (!i.jobs.length) actions.firstChild.appendChild(el('span', { className: 'muted small', text: 'inline' }));
      var outcome = el('td', null, [badge(i.outcome, OUTCOME_TONE[i.outcome])]);
      if (i.spooled) outcome.appendChild(el('div', null, [badge('spooled', 'warn')]));

      var row = el('tr', { className: 'clickable' + (fresh.indexOf(i) >= 0 ? ' flash-new' : '') }, [
        el('td', { className: 'nowrap', title: new Date(i.receivedAt).toLocaleString(), text: localTime(i.receivedAt) }),
        el('td', { text: i.userName || '—' }),
        el('td', null, [el('code', { text: i.command || 'type ' + i.type })]),
        inputCell,
        replyCell,
        actions,
        outcome,
      ]);
      row.addEventListener('click', function () {
        window.location.href = '/dashboard/g/' + guildId + '/i/' + i.id;
      });
      tbody.appendChild(row);
    });
  }

  function renderEvents(items) {
    eventsList.textContent = '';
    if (!items.length) {
      eventsList.appendChild(el('li', { className: 'muted', text: 'No events yet.' }));
      return;
    }
    items.forEach(function (e) {
      eventsList.appendChild(el('li', { className: 'ev ev-' + e.level }, [
        el('span', { className: 'ev-time', title: new Date(e.created_at).toLocaleString(), text: localTime(e.created_at) }),
        badge(e.kind, e.level === 'error' ? 'err' : e.level === 'warn' ? 'warn' : 'info'),
        ' ' + e.message,
      ]));
    });
  }

  function getJSON(url) {
    return fetch(url, { credentials: 'same-origin', headers: { accept: 'application/json' } }).then(function (r) {
      if (r.status === 401) { window.location.href = '/login'; throw new Error('signed out'); }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  var loading = false, again = false;
  function refresh() {
    if (loading) { again = true; return; }
    loading = true;
    Promise.all([getJSON('/api/g/' + guildId + '/activity'), getJSON('/api/g/' + guildId + '/events')])
      .then(function (res) { renderActivity(res[0].items); renderEvents(res[1].items); })
      .catch(function () { /* next tick will retry */ })
      .then(function () {
        loading = false;
        if (again) { again = false; refresh(); }
      });
  }

  var timer = null;
  function scheduleRefresh() {
    clearTimeout(timer);
    timer = setTimeout(refresh, 250);
  }

  refresh();
  setInterval(refresh, 15000); // fallback if the stream drops

  if (window.EventSource) {
    var es = new EventSource('/api/stream');
    es.addEventListener('open', function () { live.classList.add('on'); });
    es.addEventListener('error', function () { live.classList.remove('on'); });
    es.addEventListener('change', function (msg) {
      try {
        var data = JSON.parse(msg.data);
        if (data.guildId === guildId) scheduleRefresh();
      } catch (e) { /* ignore */ }
    });
  }
})();
