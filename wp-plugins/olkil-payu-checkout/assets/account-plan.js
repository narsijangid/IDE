/**
 * Profile + Dashboard plan/credits (Firebase email → PayU subscription API).
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
        tok.textContent = 'Free local models · no cloud token cap';
      }
    }
  }

  function paintHeader(sub) {
    var chip = $('#olkil-account-authed');
    if (!chip || !sub) return;
    var existing = chip.querySelector('.olkil-plan-badge--chip');
    if (!existing) {
      existing = document.createElement('span');
      existing.className = 'olkil-plan-badge olkil-plan-badge--chip';
      var nameEl = $('#olkil-account-name');
      if (nameEl && nameEl.parentNode) nameEl.parentNode.appendChild(existing);
      else chip.appendChild(existing);
    }
    existing.textContent = sub.plan_name || 'Free';
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

    var hello = $('#olkil-dash-hello');
    if (hello) {
      var n = user.displayName || (user.email ? user.email.split('@')[0] : 'there');
      hello.textContent = 'Welcome back, ' + n;
    }
    if (!sub) return;

    var badge = $('#olkil-dash-badge');
    if (badge) badge.textContent = sub.plan_name || 'Dazzlone';
    var plan = $('#olkil-dash-plan');
    if (plan) plan.textContent = sub.plan_name || 'Dazzlone';
    var exp = $('#olkil-dash-expiry');
    if (exp) exp.textContent = sub.expires_label || '—';
    var left = $('#olkil-dash-credits-left');
    if (left) {
      left.textContent = sub.is_paid ? (sub.percent_left || 0) + '% remaining' : 'Local · unlimited';
    }
    var fill = $('#olkil-dash-bar-fill');
    if (fill) fill.style.width = (sub.is_paid ? sub.percent_left || 0 : 100) + '%';
    var meta = $('#olkil-dash-credits-meta');
    if (meta) {
      meta.textContent = sub.is_paid
        ? (sub.tokens_used_label || '0') +
          ' used · ' +
          (sub.tokens_left_label || '0') +
          ' left of ' +
          (sub.tokens_total_label || '0')
        : 'Free Dazzlone plan — upgrade anytime for cloud tokens.';
    }
    var tokens = $('#olkil-dash-tokens');
    if (tokens) {
      tokens.textContent = sub.is_paid ? (sub.tokens_left_label || '0') + ' left' : 'Local models';
    }
    var tsub = $('#olkil-dash-tokens-sub');
    if (tsub && sub.is_paid) {
      tsub.textContent = (sub.tokens_used_label || '0') + ' / ' + (sub.tokens_total_label || '0') + ' used';
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
  }

  function bootFirebase() {
    tries += 1;
    if (typeof firebase === 'undefined') {
      if (tries < 50) setTimeout(bootFirebase, 150);
      return;
    }
    try {
      if (!firebase.apps.length) {
        // olkil-account.js usually inits; retry briefly if not ready yet.
        if (tries < 50) setTimeout(bootFirebase, 150);
        return;
      }
    } catch (e) {
      if (tries < 50) setTimeout(bootFirebase, 150);
      return;
    }

    var auth = firebase.auth();
    auth.onAuthStateChanged(function (user) {
      applyUser(user);
    });
  }

  function boot() {
    bootFirebase();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
