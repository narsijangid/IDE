/**
 * Profile + Cursor-style dashboard (Firebase email → plan API).
 */
(function () {
  'use strict';

  var cfg = window.olkilPayuAccount || {};
  var API = cfg.api || '/wp-json/olkil-payu/v1/subscription';
  var tries = 0;

  function $(sel, root) {
    return (root || document).querySelector(sel);
  }

  function setHidden(el, hide) {
    if (!el) return;
    if (hide) {
      el.setAttribute('hidden', '');
      el.hidden = true;
    } else {
      el.removeAttribute('hidden');
      el.hidden = false;
    }
  }

  function fetchSub(email) {
    if (!email) return Promise.resolve(null);
    var url = API + (API.indexOf('?') >= 0 ? '&' : '?') + 'email=' + encodeURIComponent(email);
    return fetch(url, { credentials: 'omit' })
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .catch(function () {
        return null;
      });
  }

  function fetchInvoices(email) {
    if (!email) return Promise.resolve([]);
    var base = (cfg.api || '/wp-json/olkil-payu/v1/subscription').replace(/subscription\/?(\?.*)?$/, 'invoices');
    var url = base + (base.indexOf('?') >= 0 ? '&' : '?') + 'email=' + encodeURIComponent(email);
    return fetch(url, { credentials: 'omit' })
      .then(function (r) {
        return r.ok ? r.json() : { invoices: [] };
      })
      .then(function (data) {
        return (data && data.invoices) || [];
      })
      .catch(function () {
        return [];
      });
  }

  function formatAmount(value) {
    var n = parseFloat(value, 10);
    if (isNaN(n)) return value ? '₹' + value : '—';
    return '₹' + n.toLocaleString('en-IN', { maximumFractionDigits: 0 });
  }

  function statusLabel(status) {
    var s = String(status || '').toLowerCase();
    if (s === 'success' || s === 'captured' || s === 'paid') return 'Paid';
    if (!s) return 'Paid';
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  function showView(name) {
    var views = ['overview', 'usage', 'invoices'];
    if (views.indexOf(name) < 0) name = 'overview';
    views.forEach(function (id) {
      var el = $('#olkil-view-' + id);
      if (el) setHidden(el, id !== name);
    });
    document.querySelectorAll('.olkil-app__nav-links a[data-view], .olkil-app__nav nav a[data-view]').forEach(function (a) {
      a.classList.toggle('is-active', a.getAttribute('data-view') === name);
    });
    if (history.replaceState) {
      history.replaceState(null, '', '#' + name);
    } else {
      window.location.hash = name;
    }
  }

  function bindViews() {
    if (!$('#olkil-dash')) return;
    document.querySelectorAll('#olkil-dash [data-view]').forEach(function (el) {
      el.addEventListener('click', function (e) {
        var name = el.getAttribute('data-view');
        if (!name) return;
        if (el.tagName === 'A' || el.tagName === 'BUTTON') e.preventDefault();
        showView(name);
      });
    });
    var hash = (window.location.hash || '').replace('#', '');
    if (hash) showView(hash);
  }

  function paintInvoices(list) {
    var body = $('#olkil-invoice-body');
    if (!body) return;
    body.innerHTML = '';
    if (!list || !list.length) {
      var empty = document.createElement('tr');
      var td = document.createElement('td');
      td.colSpan = 6;
      td.textContent = 'No invoices yet.';
      empty.appendChild(td);
      body.appendChild(empty);
      return;
    }
    list.forEach(function (inv) {
      var tr = document.createElement('tr');
      var cells = [
        inv.issued_on || '—',
        inv.invoice_no || inv.txnid || '—',
        inv.plan || '—',
        formatAmount(inv.amount),
      ];
      cells.forEach(function (text) {
        var td = document.createElement('td');
        td.textContent = text;
        tr.appendChild(td);
      });
      var statusTd = document.createElement('td');
      var badge = document.createElement('span');
      badge.className = 'olkil-app__status';
      badge.textContent = statusLabel(inv.status);
      statusTd.appendChild(badge);
      tr.appendChild(statusTd);
      var viewTd = document.createElement('td');
      var a = document.createElement('a');
      a.href = inv.url || (cfg.invoice || '/invoice/') + '?txnid=' + encodeURIComponent(inv.txnid || '');
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = 'View';
      viewTd.appendChild(a);
      tr.appendChild(viewTd);
      body.appendChild(tr);
    });
  }

  function paintUsage(sub) {
    if (!sub) return;
    var used = sub.is_paid ? sub.tokens_used_label || '0' : '0';
    var left = sub.is_paid ? sub.tokens_left_label || '0' : 'Unlimited';
    var total = sub.is_paid ? sub.tokens_total_label || '0' : 'Local';
    var set = function (id, val) {
      var el = $(id);
      if (el) el.textContent = val;
    };
    set('#olkil-usage-used', used);
    set('#olkil-usage-left', left);
    set('#olkil-usage-total', total);
    set('#olkil-usage-row-used', used);
    set('#olkil-usage-row-left', left);
    set('#olkil-usage-row-total', total);
    set('#olkil-usage-req-used', sub.is_paid ? String(sub.requests_used || 0) : '0');
    var fill = $('#olkil-usage-fill');
    if (fill) fill.style.width = (sub.is_paid ? sub.percent_left || 0 : 100) + '%';
    var note = $('#olkil-usage-note');
    if (note) {
      note.textContent = sub.is_paid
        ? (sub.plan_name || 'Plan') +
          ' · ' +
          (sub.percent_left || 0) +
          '% remaining · resets ' +
          (sub.expires_on || '—')
        : 'Free Dazzlone — local models have no cloud token cap.';
    }
  }

  function ensureProfilePlanMount() {
    var card = $('#olkil-profile-card');
    if (!card || $('#olkil-profile-plan')) return;

    var name = $('#olkil-profile-name');
    if (name && !name.parentNode.querySelector('.olkil-plan-badge')) {
      var badge = document.createElement('span');
      badge.className = 'olkil-plan-badge';
      badge.id = 'olkil-profile-badge';
      badge.textContent = '…';
      name.insertAdjacentElement('afterend', badge);
    }

    var mount = document.createElement('div');
    mount.id = 'olkil-profile-plan';
    mount.className = 'olkil-profile-plan';
    mount.innerHTML =
      '<div class="olkil-profile-plan__row">' +
      '<div><p class="olkil-profile-plan__label">Current plan</p><p class="olkil-profile-plan__value" id="olkil-profile-plan-name">—</p></div>' +
      '<div><p class="olkil-profile-plan__label">Renews / expires</p><p class="olkil-profile-plan__value" id="olkil-profile-plan-expiry">—</p></div>' +
      '</div>' +
      '<div class="olkil-profile-plan__credits">' +
      '<div class="olkil-profile-plan__credits-top"><span>Credits remaining</span><strong id="olkil-profile-credits-pct">—</strong></div>' +
      '<div class="olkil-dash__bar"><span id="olkil-profile-bar-fill" style="width:0%"></span></div>' +
      '<p class="olkil-profile-plan__hint" id="olkil-profile-tokens">—</p>' +
      '</div>';

    var meta = card.querySelector('.olkil-profile-meta');
    if (meta) meta.insertAdjacentElement('beforebegin', mount);
    else card.appendChild(mount);

    var actions = card.querySelector('.olkil-profile-actions');
    if (actions && !actions.querySelector('[data-olkil-dashboard]')) {
      var a = document.createElement('a');
      a.className = 'olkil-btn olkil-btn--primary';
      a.href = cfg.dashboard || '/dashboard/';
      a.setAttribute('data-olkil-dashboard', '1');
      a.textContent = 'Dashboard';
      actions.insertBefore(a, actions.firstChild);
    }
  }

  function paintProfile(sub) {
    ensureProfilePlanMount();
    var planBox = $('#olkil-profile-plan');
    var badge = $('#olkil-profile-badge');
    if (planBox) setHidden(planBox, false);
    if (badge) setHidden(badge, false);
    if (!sub) return;
    if (badge) badge.textContent = sub.plan_name || 'Dazzlone';
    var pn = $('#olkil-profile-plan-name');
    if (pn) pn.textContent = sub.plan_name || 'Dazzlone';
    var ex = $('#olkil-profile-plan-expiry');
    if (ex) ex.textContent = sub.expires_label || '—';
    var pct = $('#olkil-profile-credits-pct');
    if (pct) pct.textContent = (sub.percent_left != null ? sub.percent_left : 100) + '% left';
    var fill = $('#olkil-profile-bar-fill');
    if (fill) fill.style.width = Math.max(0, Math.min(100, sub.percent_left != null ? sub.percent_left : 100)) + '%';
    var tok = $('#olkil-profile-tokens');
    if (tok) {
      if (sub.is_paid) {
        tok.textContent =
          (sub.tokens_left_label || '0') +
          ' remaining of ' +
          (sub.tokens_total_label || '0') +
          ' · ' +
          (sub.tokens_used_label || '0') +
          ' used';
      } else {
        tok.textContent = sub.is_expired
          ? 'Plan ended — back on free Dazzlone'
          : 'Free local models · no cloud token cap';
      }
    }
  }

  function paintHeader() {
    /* Plan name belongs on dashboard/profile only — never in the site header. */
    document.querySelectorAll('.olkil-account .olkil-plan-badge--chip').forEach(function (el) {
      el.remove();
    });
  }

  function paintPlanCards(sub) {
    var cards = document.querySelectorAll('#olkil-dash-plan-cards [data-plan]');
    var current = (sub && sub.plan) || 'dazzlone';
    var heldSlugs = {};
    (sub && sub.held_plans ? sub.held_plans : []).forEach(function (h) {
      if (h && h.plan) heldSlugs[h.plan] = h;
    });
    var exhausted = Boolean(sub && sub.is_paid && (sub.percent_left === 0 || sub.quota_reason === 'quota_exceeded') && !(sub.spendable_left > 0));
    cards.forEach(function (card) {
      var slug = card.getAttribute('data-plan');
      var isCur = slug === current;
      var held = heldSlugs[slug];
      card.classList.toggle('is-current', isCur);
      card.classList.toggle('is-held', Boolean(held));
      var mark = card.querySelector('.olkil-dash-plan__current');
      var btn = card.querySelector('.olkil-dash-plan__btn');
      if (mark) {
        mark.textContent = isCur ? 'Current plan' : held ? 'On hold' : 'Current plan';
        setHidden(mark, !(isCur || held));
      }
      if (btn) {
        if (isCur && exhausted) {
          setHidden(btn, false);
          btn.textContent = 'Buy ' + (sub.plan_name || 'plan') + ' again';
        } else if (isCur || held) {
          setHidden(btn, true);
        } else {
          setHidden(btn, false);
          var name = card.querySelector('.olkil-dash-plan__name');
          btn.textContent = 'Upgrade to ' + ((name && name.textContent) || slug);
        }
      }
    });
  }

  function paintDashboard(user, sub) {
    var guest = $('#olkil-dash-guest');
    var main = $('#olkil-dash-main');
    if (!guest || !main) return;

    if (!user) {
      setHidden(guest, false);
      setHidden(main, true);
      return;
    }
    setHidden(guest, true);
    setHidden(main, false);

    var n = user.displayName || (user.email ? user.email.split('@')[0] : 'there');
    var hello = $('#olkil-dash-hello');
    if (hello) hello.textContent = 'Welcome back, ' + n;
    var uname = $('#olkil-dash-user-name');
    if (uname) uname.textContent = n;
    if (!sub) return;

    var planName = sub.plan_name || 'Dazzlone';
    var uplan = $('#olkil-dash-user-plan');
    if (uplan) uplan.textContent = planName;
    var plan = $('#olkil-dash-plan');
    if (plan) plan.textContent = planName;
    var note = $('#olkil-dash-plan-note');
    if (note) {
      if (sub.is_paid && sub.drawing_plan && sub.drawing_plan !== sub.plan) {
        note.textContent = (sub.plan_name || 'Plan') + ' tokens used up · using held ' + (sub.drawing_plan_name || 'plan');
      } else if (sub.is_paid) {
        note.textContent = 'Active · ' + (sub.tokens_total_label || '') + ' tokens / month';
      } else if (sub.is_expired) {
        note.textContent = 'Previous plan ended — you are on free Dazzlone';
      } else {
        note.textContent = 'Free local models · upgrade anytime';
      }
    }
    var expDate = $('#olkil-dash-expiry-date');
    if (expDate) expDate.textContent = sub.is_paid ? sub.expires_on || '—' : sub.is_expired ? sub.expires_on || 'Expired' : 'Never';
    var exp = $('#olkil-dash-expiry');
    if (exp) {
      exp.textContent = sub.is_paid
        ? (sub.days_left != null ? sub.days_left + ' days left' : sub.expires_label || '')
        : sub.is_expired
          ? 'Expired ' + (sub.expires_on || '')
          : 'Never on the free plan';
    }
    var left = $('#olkil-dash-credits-left');
    if (left) {
      left.textContent = sub.is_paid ? (sub.percent_left || 0) + '% remaining' : 'Local · unlimited';
    }
    var fill = $('#olkil-dash-bar-fill');
    if (fill) fill.style.width = (sub.is_paid ? sub.percent_left || 0 : 100) + '%';
    var meta = $('#olkil-dash-credits-meta');
    if (meta) {
      if (sub.is_paid) {
        var text =
          (sub.tokens_used_label || '0') +
          ' used · ' +
          (sub.tokens_left_label || '0') +
          ' left of ' +
          (sub.tokens_total_label || '0') +
          (sub.expires_on ? ' · resets ' + sub.expires_on : '');
        if (sub.held_plans && sub.held_plans.length) {
          text +=
            ' · held ' +
            sub.held_plans
              .map(function (h) {
                return (h.plan_name || h.plan) + ' ' + (h.tokens_left_label || '0') + ' left until ' + (h.expires_on || '—');
              })
              .join('; ');
        }
        meta.textContent = text;
      } else {
        meta.textContent = 'Free Dazzlone plan — upgrade anytime for cloud tokens.';
      }
    }
    paintPlanCards(sub);
    paintUsage(sub);
    paintUpgrade(sub);
  }

  function paintUpgrade(sub) {
    var el = $('#olkil-dash-upgrade');
    if (!el) return;
    var reason = sub && sub.quota_reason;
    if (sub && sub.is_paid && reason === 'quota_exceeded' && !(sub.spendable_left > 0)) {
      var name = sub.plan_name || 'Lite';
      var renew = sub.renew_url || (cfg.checkout || '/checkout/') + '?plan=' + encodeURIComponent(sub.plan || 'lite');
      el.innerHTML = '';
      el.appendChild(
        document.createTextNode(
          'You have used your ' + name + ' tokens this period. Buy ' + name + ' again for a fresh allowance and a new 30-day window from today. '
        )
      );
      var a = document.createElement('a');
      a.href = renew;
      a.textContent = 'Buy ' + name + ' again';
      el.appendChild(a);
      if (sub.next_plan && sub.upgrade_url) {
        el.appendChild(document.createTextNode(' Or '));
        var b = document.createElement('a');
        b.href = sub.upgrade_url;
        b.textContent = 'upgrade to ' + (sub.next_plan_name || 'Pro');
        el.appendChild(b);
        el.appendChild(document.createTextNode('.'));
      }
      setHidden(el, false);
    } else {
      el.innerHTML = '';
      setHidden(el, true);
    }
  }

  function applyUser(user) {
    if (!user || !user.email) {
      paintDashboard(null, null);
      return;
    }
    fetchSub(user.email).then(function (sub) {
      paintProfile(sub);
      paintHeader(sub);
      paintDashboard(user, sub);
    });
    fetchInvoices(user.email).then(paintInvoices);
  }

  function bootFirebase() {
    tries += 1;
    if (typeof firebase === 'undefined') {
      if (tries < 50) setTimeout(bootFirebase, 150);
      return;
    }
    try {
      if (!firebase.apps.length) {
        if (tries < 50) setTimeout(bootFirebase, 150);
        return;
      }
    } catch (e) {
      if (tries < 50) setTimeout(bootFirebase, 150);
      return;
    }

    firebase.auth().onAuthStateChanged(function (user) {
      applyUser(user);
      startUsagePoll(user);
    });
  }

  var pollTimer = null;
  function startUsagePoll(user) {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (!user || !user.email || !$('#olkil-dash')) return;
    pollTimer = setInterval(function () {
      fetchSub(user.email).then(function (sub) {
        paintProfile(sub);
        paintDashboard(user, sub);
      });
    }, 20000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      bindViews();
      bootFirebase();
    });
  } else {
    bindViews();
    bootFirebase();
  }
})();
