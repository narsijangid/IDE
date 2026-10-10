(function () {
	'use strict';
	if (window.olkilCookies) return;

	var KEY = 'olkil-cookie-consent';
	var VER = 1;
	var cfg = window.olkilCookieCfg || {};
	var root = null;
	var view = 'banner';

	function read() {
		try {
			var c = JSON.parse(localStorage.getItem(KEY) || 'null');
			return c && c.v === VER ? c : null;
		} catch (e) {
			return null;
		}
	}

	function save(analytics, marketing) {
		var c = { v: VER, necessary: true, analytics: !!analytics, marketing: !!marketing, ts: Date.now() };
		try { localStorage.setItem(KEY, JSON.stringify(c)); } catch (e) {}
		window.olkilConsent = c;
		try { document.dispatchEvent(new CustomEvent('olkil:consent', { detail: c })); } catch (e) {}
		close();
	}

	function esc(s) {
		return String(s).replace(/[&<>"]/g, function (ch) {
			return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch];
		});
	}

	function row(id, title, desc, checked) {
		return '<div class="olkck__row"><div class="olkck__row-txt"><b id="olkck-' + id + '-l">' + title + '</b><span>' + desc + '</span></div>' +
			'<label class="olkck__sw"><input type="checkbox" role="switch" data-ck="' + id + '" aria-labelledby="olkck-' + id + '-l"' + (checked ? ' checked' : '') + '><i></i></label></div>';
	}

	function build() {
		var cur = read() || {};
		var link = function (href, label) { return '<a href="' + esc(href) + '">' + label + '</a>'; };
		var el = document.createElement('div');
		el.className = 'olkck';
		el.setAttribute('role', 'dialog');
		el.setAttribute('aria-modal', 'false');
		el.setAttribute('aria-labelledby', 'olkck-title');
		el.setAttribute('aria-describedby', 'olkck-text');
		el.innerHTML =
			'<div class="olkck__card">' +
				'<button type="button" class="olkck__x" data-a="close" aria-label="Close and reject optional cookies">&times;</button>' +
				'<div class="olkck__head">' +
					'<span class="olkck__icon" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a10 10 0 1 0 10 10 4 4 0 0 1-5-5 4 4 0 0 1-5-5"/><path d="M8.5 8.5v.01M16 15.5v.01M12 12v.01M11 17v.01M7 14v.01"/></svg></span>' +
					'<p class="olkck__title" id="olkck-title">We value your privacy</p>' +
				'</div>' +
				'<p class="olkck__text" id="olkck-text">We use essential cookies to run OLKIL and, with your consent, optional ones for analytics and marketing. See our ' +
					link(cfg.cookie || '/cookie-policy/', 'Cookie Policy') + ' and ' +
					link(cfg.privacy || '/privacy-policy/', 'Privacy Policy') + ', or manage ' +
					'<button type="button" class="olkck__link" data-a="settings" aria-expanded="false">Cookie settings</button>.</p>' +
				'<div class="olkck__prefs" hidden>' +
					'<div class="olkck__row"><div class="olkck__row-txt"><b>Essential</b><span>Sign-in, checkout, security and preferences.</span></div><span class="olkck__always">Always on</span></div>' +
					row('analytics', 'Analytics', 'Helps us understand how the site is used.', cur.analytics) +
					row('marketing', 'Marketing', 'Helps us measure campaigns and show relevant content.', cur.marketing) +
				'</div>' +
				'<div class="olkck__actions"></div>' +
			'</div>';
		el.addEventListener('click', onClick);
		el.addEventListener('keydown', function (e) {
			if (e.key === 'Escape') {
				if (view === 'settings' && !read()) setView('banner');
				else if (read()) close();
			}
		});
		document.body.appendChild(el);
		return el;
	}

	function setView(v) {
		view = v;
		var acts = root.querySelector('.olkck__actions');
		var prefs = root.querySelector('.olkck__prefs');
		var toggle = root.querySelector('.olkck__link');
		if (v === 'settings') {
			prefs.hidden = false;
			toggle.setAttribute('aria-expanded', 'true');
			acts.innerHTML =
				'<button type="button" class="olkck__btn olkck__btn--dark" data-a="save">Save preferences</button>' +
				'<button type="button" class="olkck__btn olkck__btn--pink" data-a="accept">Accept All Cookies</button>';
			var first = prefs.querySelector('input');
			if (first) first.focus({ preventScroll: true });
		} else {
			prefs.hidden = true;
			toggle.setAttribute('aria-expanded', 'false');
			acts.innerHTML =
				'<button type="button" class="olkck__btn olkck__btn--dark" data-a="reject">Reject All</button>' +
				'<button type="button" class="olkck__btn olkck__btn--pink" data-a="accept">Accept All Cookies</button>';
		}
	}

	function onClick(e) {
		var b = e.target.closest('[data-a]');
		if (!b) return;
		var a = b.getAttribute('data-a');
		if (a === 'accept') save(true, true);
		else if (a === 'reject' || a === 'close') save(false, false);
		else if (a === 'settings') setView(view === 'settings' ? 'banner' : 'settings');
		else if (a === 'save') {
			save(root.querySelector('[data-ck="analytics"]').checked, root.querySelector('[data-ck="marketing"]').checked);
		}
	}

	function open(mode) {
		if (root) { root.remove(); root = null; }
		root = build();
		setView(mode === 'settings' ? 'settings' : 'banner');
		requestAnimationFrame(function () {
			requestAnimationFrame(function () { root && root.classList.add('is-in'); });
		});
	}

	function close() {
		if (!root) return;
		var el = root;
		root = null;
		el.classList.remove('is-in');
		setTimeout(function () { el.remove(); }, 400);
	}

	window.olkilConsent = read();
	window.olkilCookies = { open: open, get: read };

	var want = window.olkilCookiesOpen;
	if (want === 'settings') open('settings');
	else if (!read()) open('banner');
})();
