/**
 * OLKIL website ↔ IDE auth bridge (Firebase).
 *
 * Primary (Cursor/Trae style): POST tokens to http://127.0.0.1:<port>/callback
 * Fallback: GET navigation to loopback (shows IDE success page)
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

  var completing = false;
  var completed = false;

  function qs(name) {
    return new URLSearchParams(window.location.search).get(name);
  }

  function isLoopbackRedirect(uri) {
    if (!uri) return false;
    try {
      var u = new URL(uri);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
      if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') return false;
      return u.pathname.indexOf('/callback') === 0 || u.pathname === '/';
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
    completed = true;
    setBusy(false);
    hideActions();

    var lead = document.getElementById('olkil-auth-lead');
    if (lead) {
      lead.textContent = 'Authentication complete. Return to the OLKIL app — you can close this tab.';
    }

    var title = document.querySelector('.olkil-auth-card h1');
    if (title) {
      title.textContent = "You're signed in";
    }

    setStatus('Connected to OLKIL successfully.', false);

    var done = document.getElementById('olkil-auth-done');
    if (done) {
      done.hidden = false;
    } else {
      // Fallback if template not yet updated
      var card = document.querySelector('.olkil-auth-card');
      if (card && !document.getElementById('olkil-auth-done-fallback')) {
        var wrap = document.createElement('div');
        wrap.id = 'olkil-auth-done-fallback';
        wrap.className = 'olkil-auth-done';
        wrap.innerHTML =
          '<a class="olkil-btn olkil-btn--primary olkil-btn--lg" href="olkil://auth/done">Open OLKIL</a>' +
          '<button type="button" class="olkil-btn olkil-btn--ghost olkil-btn--lg" id="olkil-auth-close-fallback">Close this tab</button>';
        card.appendChild(wrap);
        var closeBtn = document.getElementById('olkil-auth-close-fallback');
        if (closeBtn) {
          closeBtn.addEventListener('click', function () {
            try {
              window.close();
            } catch (e) {}
          });
        }
      }
    }
  }

  function postToIde(redirectUri, state, idToken, refreshToken) {
    return fetch(redirectUri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
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
    if (!user || completing || completed) {
      return;
    }

    var state = qs('state');
    var redirectUri = qs('redirect_uri');

    if (!state) {
      setStatus('Signed in. Your profile is ready on OLKIL.', false);
      hideActions();
      var lead = document.getElementById('olkil-auth-lead');
      if (lead) {
        lead.textContent = 'Welcome back — open your profile or return home.';
      }
      setTimeout(function () {
        var profileUrl = (window.olkilData && olkilData.profileUrl) || '/profile/';
        window.location.href = profileUrl;
      }, 700);
      return;
    }

    completing = true;
    setBusy(true);

    Promise.all([user.getIdToken(true), Promise.resolve(user.refreshToken)])
      .then(function (parts) {
        var idToken = parts[0];
        var refreshToken = parts[1];
        if (!idToken || !refreshToken) {
          completing = false;
          setBusy(false);
          setStatus('Could not read Firebase tokens.', true);
          return;
        }

        // 1) Preferred: localhost loopback POST (stay on olkil.com success UI)
        if (isLoopbackRedirect(redirectUri)) {
          setStatus('Connecting back to OLKIL…', false);
          return postToIde(redirectUri, state, idToken, refreshToken)
            .then(function () {
              showSuccessStayOnPage();
            })
            .catch(function (err) {
              console.warn('[olkil-auth] loopback POST failed, opening IDE success page via GET', err);
              // 2) GET navigation — IDE serves a Cursor-style success page
              // (server stays open briefly after accepting tokens)
              window.location.replace(
                redirectUri +
                  (redirectUri.indexOf('?') >= 0 ? '&' : '?') +
                  'state=' +
                  encodeURIComponent(state) +
                  '&id_token=' +
                  encodeURIComponent(idToken) +
                  '&refresh_token=' +
                  encodeURIComponent(refreshToken),
              );
            });
        }

        // 3) No loopback URI — web-only session
        completing = false;
        setBusy(false);
        setStatus(
          'Signed in in the browser. Keep OLKIL open and use Sign in from the IDE so it can receive the session.',
          true,
        );
        hideActions();
      })
      .catch(function (err) {
        completing = false;
        setBusy(false);
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

    var closeBtn = document.getElementById('olkil-auth-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', function () {
        try {
          window.close();
        } catch (e) {}
      });
    }

    // Only auto-complete from existing session once (avoid double fire with popup handlers).
    var autoHandled = false;
    auth.onAuthStateChanged(function (user) {
      if (user && qs('state') && !autoHandled && !completing && !completed) {
        autoHandled = true;
        // Small delay so popup/redirect handlers can claim first if they fire.
        setTimeout(function () {
          if (!completing && !completed) {
            completeToIde(user);
          }
        }, 250);
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

    auth
      .getRedirectResult()
      .then(function (result) {
        if (result && result.user) {
          completeToIde(result.user);
        }
      })
      .catch(function (err) {
        if (err) setStatus(err.message || 'Redirect sign-in failed', true);
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
