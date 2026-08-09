/**
 * Site-wide OLKIL account (Firebase) — header chip + profile page.
 * Separate from IDE loopback auth (olkil-auth.js).
 */
(function () {
  'use strict';

  var firebaseConfig = {
    apiKey: 'AIzaSyA3z0FDMJrfskddGj4Iair9D2XH3K_IS2k',
    authDomain: 'olkil-2c8ac.firebaseapp.com',
    projectId: 'olkil-2c8ac',
    storageBucket: 'olkil-2c8ac.firebasestorage.app',
    messagingSenderId: '781364120676',
    appId: '1:781364120676:web:b95ff8f1839b3a0b0aa371',
    measurementId: 'G-77ZW0JFXSB',
  };

  function $(sel, root) {
    return (root || document).querySelector(sel);
  }

  function initials(name, email) {
    var src = (name || email || 'U').trim();
    var parts = src.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      return (parts[0][0] + parts[1][0]).toUpperCase();
    }
    return src.slice(0, 2).toUpperCase();
  }

  function providerLabel(user) {
    var data = (user && user.providerData && user.providerData[0]) || null;
    if (!data) return 'Email';
    var id = data.providerId || '';
    if (id.indexOf('google') >= 0) return 'Google';
    if (id.indexOf('github') >= 0) return 'GitHub';
    if (id.indexOf('password') >= 0) return 'Email';
    return id || 'Account';
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

  function renderHeader(user) {
    var guest = $('#olkil-account-guest');
    var authed = $('#olkil-account-authed');
    if (!guest || !authed) return;

    document.body.classList.toggle('olkil-signed-in', !!user);

    if (!user) {
      setHidden(guest, false);
      setHidden(authed, true);
      return;
    }

    setHidden(guest, true);
    setHidden(authed, false);

    var name = user.displayName || (user.email ? user.email.split('@')[0] : 'Account');
    var email = user.email || '';
    var photo = user.photoURL || '';

    var nameEl = $('#olkil-account-name');
    var emailEl = $('#olkil-account-email');
    var avatarImg = $('#olkil-account-avatar-img');
    var avatarFallback = $('#olkil-account-avatar-fallback');

    if (nameEl) nameEl.textContent = name;
    if (emailEl) {
      emailEl.textContent = email;
      setHidden(emailEl, !email);
    }

    if (photo && avatarImg) {
      avatarImg.src = photo;
      avatarImg.alt = name;
      setHidden(avatarImg, false);
      if (avatarFallback) setHidden(avatarFallback, true);
      avatarImg.onerror = function () {
        setHidden(avatarImg, true);
        if (avatarFallback) {
          setHidden(avatarFallback, false);
          avatarFallback.textContent = initials(name, email);
        }
      };
    } else if (avatarFallback) {
      if (avatarImg) setHidden(avatarImg, true);
      setHidden(avatarFallback, false);
      avatarFallback.textContent = initials(name, email);
    }
  }

  function renderProfilePage(user) {
    var root = $('#olkil-profile');
    if (!root) return;

    var empty = $('#olkil-profile-empty');
    var card = $('#olkil-profile-card');

    if (!user) {
      setHidden(empty, false);
      setHidden(card, true);
      return;
    }

    setHidden(empty, true);
    setHidden(card, false);

    var name = user.displayName || 'OLKIL user';
    var email = user.email || '—';
    var photo = user.photoURL || '';
    var uid = user.uid || '';
    var verified = user.emailVerified ? 'Verified' : 'Not verified';
    var provider = providerLabel(user);

    var img = $('#olkil-profile-photo');
    var fallback = $('#olkil-profile-photo-fallback');
    if (photo && img) {
      img.src = photo;
      img.alt = name;
      setHidden(img, false);
      if (fallback) setHidden(fallback, true);
    } else if (fallback) {
      if (img) setHidden(img, true);
      setHidden(fallback, false);
      fallback.textContent = initials(name, email);
    }

    var set = function (id, val) {
      var el = document.getElementById(id);
      if (el) el.textContent = val;
    };
    set('olkil-profile-name', name);
    set('olkil-profile-email', email);
    set('olkil-profile-provider', provider);
    set('olkil-profile-verified', verified);
    set('olkil-profile-uid', uid);
  }

  function wireUi(auth) {
    // Dropdown is CSS hover/focus-within only — no click toggle.

    document.querySelectorAll('[data-olkil-signout]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        auth.signOut().then(function () {
          if (window.location.pathname.indexOf('/profile') >= 0) {
            window.location.href = (window.olkilData && olkilData.homeUrl) || '/';
          }
        });
      });
    });
  }

  function boot() {
    if (typeof firebase === 'undefined') return;

    if (!firebase.apps.length) {
      firebase.initializeApp(firebaseConfig);
    }
    var auth = firebase.auth();
    wireUi(auth);

    // Optimistic: hide guest until auth resolves if a session likely exists
    auth.onAuthStateChanged(function (user) {
      renderHeader(user);
      renderProfilePage(user);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
