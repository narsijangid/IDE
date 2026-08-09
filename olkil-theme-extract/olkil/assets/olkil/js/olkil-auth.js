/**
 * OLKIL website ↔ IDE auth bridge (Firebase).
 *
 * Primary (Cursor/Trae style): POST tokens to http://127.0.0.1:<port>/callback
 * Fallback: olkil:// deep link (only if loopback fails)
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

  function qs(name) {
    return new URLSearchParams(window.location.search).get(name);
  }

  function isLoopbackRedirect(uri) {
    if (!uri) return false;
    try {
      var u = new URL(uri);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
      if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') return false;
      return u.pathname.indexOf('/callback') === 0;
    } catch (e) {
      return false;
    }
  }

  function setStatus(msg, isError) {
    var el = document.getElementById('olkil-auth-status');
    if (!el) return;
    el.hidden = !msg;
    el.textContent = msg || '';
    el.classList.toggle('is-error', !!isError);
  }

  function setBusy(busy) {
    document.querySelectorAll('.olkil-auth-btn, #olkil-auth-email-form button').forEach(function (btn) {
      btn.disabled = !!busy;
    });
  }

  function hideActions() {
    var actions = document.getElementById('olkil-auth-actions');
    if (actions) actions.hidden = true;
    var email = document.querySelector('.olkil-auth-email');
    if (email) email.hidden = true;
  }

  function showSuccessStayOnPage() {
    setStatus('Signed in! Return to the OLKIL app — you can close this tab.', false);
    var lead = document.getElementById('olkil-auth-lead');
    if (lead) {
      lead.textContent = 'Authentication complete. This tab can be closed.';
    }
    hideActions();
  }

  function postToIde(redirectUri, state, idToken, refreshToken) {
    return fetch(redirectUri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        state: state,
        id_token: idToken,
        refresh_token: refreshToken,
      }),
      mode: 'cors',
      cache: 'no-store',
    }).then(function (res) {
      if (!res.ok) {
        throw new Error('IDE callback returned ' + res.status);
      }
      return res.json().catch(function () {
        return { ok: true };
      });
    });
  }

  function completeToIde(user) {
    var state = qs('state');
    var redirectUri = qs('redirect_uri');

    if (!state) {
      setStatus('Signed in. Your profile is ready on OLKIL.', false);
      hideActions();
      var lead = document.getElementById('olkil-auth-lead');
      if (lead) {
        lead.textContent = 'Welcome back — open your profile or return home.';
      }
      // Soft redirect to profile for website-only sign-in
      setTimeout(function () {
        var profileUrl = (window.olkilData && olkilData.profileUrl) || '/profile/';
        window.location.href = profileUrl;
      }, 700);
      return;
    }

    Promise.all([user.getIdToken(true), Promise.resolve(user.refreshToken)])
      .then(function (parts) {
        var idToken = parts[0];
        var refreshToken = parts[1];
        if (!idToken || !refreshToken) {
          setStatus('Could not read Firebase tokens.', true);
          return;
        }

        // 1) Preferred: localhost loopback POST (no System32 / protocol issues)
        if (isLoopbackRedirect(redirectUri)) {
          setStatus('Connecting back to OLKIL…', false);
          return postToIde(redirectUri, state, idToken, refreshToken)
            .then(function () {
              showSuccessStayOnPage();
            })
            .catch(function (err) {
              console.warn('[olkil-auth] loopback failed, trying GET navigation', err);
              // 2) GET navigation to loopback (still avoids custom protocol)
              window.location.href = redirectUri +
                (redirectUri.indexOf('?') >= 0 ? '&' : '?') +
                'state=' + encodeURIComponent(state) +
                '&id_token=' + encodeURIComponent(idToken) +
                '&refresh_token=' + encodeURIComponent(refreshToken);
            });
        }

        // 3) No loopback URI — web-only session (IDE must start Sign in itself)
        setStatus(
          'Signed in in the browser. Keep OLKIL open and use Sign in from the IDE so it can receive the session.',
          true
        );
        hideActions();
      })
      .catch(function (err) {
        setStatus((err && err.message) || 'Token error', true);
      });
  }

  function boot() {
    if (!document.getElementById('olkil-auth-ide')) return;
    if (typeof firebase === 'undefined') {
      setStatus('Firebase SDK failed to load.', true);
      return;
    }

    if (!firebase.apps.length) {
      firebase.initializeApp(firebaseConfig);
    }
    var auth = firebase.auth();

    var client = qs('client');
    if (client === 'olkil-ide') {
      var lead = document.getElementById('olkil-auth-lead');
      if (lead) {
        lead.textContent = 'Authorize this browser session to unlock OLKIL on your desktop.';
      }
    }

    auth.onAuthStateChanged(function (user) {
      if (user && qs('state')) {
        completeToIde(user);
      }
    });

    var googleBtn = document.getElementById('olkil-auth-google');
    if (googleBtn) {
      googleBtn.addEventListener('click', function () {
        setBusy(true);
        setStatus('Redirecting to Google…');
        var provider = new firebase.auth.GoogleAuthProvider();
        provider.setCustomParameters({ prompt: 'select_account' });
        auth
          .signInWithPopup(provider)
          .then(function (cred) {
            completeToIde(cred.user);
          })
          .catch(function (err) {
            if (err && (err.code === 'auth/popup-blocked' || err.code === 'auth/cancelled-popup-request')) {
              return auth.signInWithRedirect(provider);
            }
            setBusy(false);
            setStatus((err && err.message) || 'Google sign-in failed', true);
          });
      });
    }

    var githubBtn = document.getElementById('olkil-auth-github');
    if (githubBtn) {
      githubBtn.addEventListener('click', function () {
        setBusy(true);
        setStatus('Redirecting to GitHub…');
        var provider = new firebase.auth.GithubAuthProvider();
        auth
          .signInWithPopup(provider)
          .then(function (cred) {
            completeToIde(cred.user);
          })
          .catch(function (err) {
            if (err && err.code === 'auth/popup-blocked') {
              return auth.signInWithRedirect(provider);
            }
            setBusy(false);
            setStatus((err && err.message) || 'GitHub sign-in failed', true);
          });
      });
    }

    var form = document.getElementById('olkil-auth-email-form');
    if (form) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var email = form.email.value.trim();
        var password = form.password.value;
        setBusy(true);
        setStatus('Signing in…');
        auth
          .signInWithEmailAndPassword(email, password)
          .then(function (cred) {
            completeToIde(cred.user);
          })
          .catch(function (err) {
            setBusy(false);
            setStatus((err && err.message) || 'Email sign-in failed', true);
          });
      });
    }

    var signupBtn = document.getElementById('olkil-auth-signup');
    if (signupBtn && form) {
      signupBtn.addEventListener('click', function () {
        var email = form.email.value.trim();
        var password = form.password.value;
        if (!email || !password) {
          setStatus('Enter email and password first.', true);
          return;
        }
        setBusy(true);
        setStatus('Creating account…');
        auth
          .createUserWithEmailAndPassword(email, password)
          .then(function (cred) {
            completeToIde(cred.user);
          })
          .catch(function (err) {
            setBusy(false);
            setStatus((err && err.message) || 'Sign-up failed', true);
          });
      });
    }

    auth.getRedirectResult().then(function (result) {
      if (result && result.user) {
        completeToIde(result.user);
      }
    }).catch(function (err) {
      if (err) setStatus(err.message || 'Redirect sign-in failed', true);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
