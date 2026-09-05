/**
 * OLKIL front-end interactions
 */
(function () {
	'use strict';

	function ready(fn) {
		if (document.readyState !== 'loading') fn();
		else document.addEventListener('DOMContentLoaded', fn);
	}

	ready(function () {
		initMobileNav();
		initProductNav();
		initReveal();
		initOsDownload();
		initSmoothAnchors();
		initDemoVideo();
		initLoopVideos();
		initCliPage();
		initThemeToggle();
	});

	function initMobileNav() {
		var toggle = document.querySelector('.olkil-menu-toggle');
		var nav = document.querySelector('.olkil-nav');
		if (!toggle || !nav) return;

		toggle.addEventListener('click', function () {
			var open = nav.classList.toggle('is-open');
			toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
		});

		nav.querySelectorAll('a').forEach(function (link) {
			link.addEventListener('click', function () {
				nav.classList.remove('is-open');
				toggle.setAttribute('aria-expanded', 'false');
			});
		});
	}

	function initProductNav() {
		var item = document.querySelector('.olkil-nav-item--has-sub');
		if (!item) return;
		var trigger = item.querySelector('.olkil-nav-trigger');
		if (!trigger) return;
		function close() {
			item.classList.remove('is-open');
			trigger.setAttribute('aria-expanded', 'false');
		}
		function isDesktop() {
			return window.matchMedia && window.matchMedia('(min-width: 861px)').matches;
		}
		trigger.addEventListener('click', function (e) {
			e.preventDefault();
			e.stopPropagation();
			var open = item.classList.toggle('is-open');
			trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
		});
		item.addEventListener('mouseenter', function () {
			if (!isDesktop()) return;
			item.classList.add('is-open');
			trigger.setAttribute('aria-expanded', 'true');
		});
		item.addEventListener('mouseleave', function () {
			if (!isDesktop()) return;
			close();
		});
		document.addEventListener('click', function (e) {
			if (!item.contains(e.target)) close();
		});
		document.addEventListener('keydown', function (e) {
			if (e.key === 'Escape') close();
		});
	}

	function initCliPage() {
		var tabs = document.querySelectorAll('[data-olkil-cli-tab]');
		if (!tabs.length) return;
		var os = detectOS();
		function show(id) {
			tabs.forEach(function (tab) {
				var on = tab.getAttribute('data-olkil-cli-tab') === id;
				tab.classList.toggle('is-active', on);
				tab.setAttribute('aria-selected', on ? 'true' : 'false');
			});
			document.querySelectorAll('[data-olkil-cli-panel]').forEach(function (panel) {
				var on = panel.getAttribute('data-olkil-cli-panel') === id;
				panel.hidden = !on;
				panel.classList.toggle('is-active', on);
			});
		}
		if (os === 'macos' || os === 'linux' || os === 'windows') show(os);
		tabs.forEach(function (tab) {
			tab.addEventListener('click', function () {
				show(tab.getAttribute('data-olkil-cli-tab'));
			});
		});
		document.querySelectorAll('[data-olkil-copy]').forEach(function (btn) {
			btn.addEventListener('click', function () {
				var el = document.getElementById(btn.getAttribute('data-olkil-copy'));
				if (!el) return;
				var text = (el.textContent || '').trim();
				if (navigator.clipboard && navigator.clipboard.writeText) {
					navigator.clipboard.writeText(text).catch(function () {});
				}
				btn.textContent = 'Copied';
				setTimeout(function () { btn.textContent = 'Copy'; }, 1400);
			});
		});
	}

	function initReveal() {
		var nodes = document.querySelectorAll('.olkil-reveal');
		if (!nodes.length) return;

		function show(n) {
			n.classList.add('is-visible');
		}

		// Tall pages/posts can never hit a high threshold ratio — keep this at 0.
		if (!('IntersectionObserver' in window)) {
			nodes.forEach(show);
			return;
		}

		var io = new IntersectionObserver(
			function (entries) {
				entries.forEach(function (entry) {
					if (entry.isIntersecting || entry.intersectionRatio > 0) {
						show(entry.target);
						io.unobserve(entry.target);
					}
				});
			},
			{ threshold: 0, rootMargin: '0px 0px -8px 0px' }
		);

		nodes.forEach(function (n) {
			var rect = n.getBoundingClientRect();
			var vh = window.innerHeight || document.documentElement.clientHeight || 0;
			// Already on-screen (or partially) — show immediately so long articles never stay blank.
			if (rect.top < vh && rect.bottom > 0) {
				show(n);
				return;
			}
			io.observe(n);
		});
	}

	function detectOS() {
		var ua = navigator.userAgent || navigator.platform || '';
		if (/Win/i.test(ua)) return 'windows';
		if (/Mac/i.test(ua)) return 'macos';
		if (/Linux|X11|Ubuntu|Fedora/i.test(ua)) return 'linux';
		return 'windows';
	}

	function isAppleSilicon() {
		try {
			// Chromium on Apple Silicon reports arm in some builds; Safari often does not.
			var ua = navigator.userAgent || '';
			var platform = navigator.platform || '';
			if (/arm64|aarch64/i.test(ua) || /arm64|aarch64/i.test(platform)) return true;
			// Fall back: modern Macs are mostly Apple Silicon.
			if (typeof navigator.userAgentData === 'object' && navigator.userAgentData) {
				var arch = (navigator.userAgentData.architecture || '').toLowerCase();
				if (arch === 'arm') return true;
				if (arch === 'x86') return false;
			}
		} catch (e) {
			/* ignore */
		}
		return true;
	}

	function resolveDownloadHref(downloads, os) {
		if (!downloads) return '#';
		if (os === 'macos') {
			if (isAppleSilicon()) {
				return downloads.macos || downloads.macos_intel || '#';
			}
			return downloads.macos_intel || downloads.macos || '#';
		}
		return downloads[os] || '#';
	}

	function initOsDownload() {
		var data = window.olkilData || {};
		var downloads = data.downloads || {};
		var os = detectOS();
		var labels = {
			windows: 'Download for Windows',
			macos: 'Download for macOS',
			linux: 'Download for Linux',
		};

		document.querySelectorAll('[data-olkil-download="auto"]').forEach(function (el) {
			var href = resolveDownloadHref(downloads, os);
			el.setAttribute('href', href);
			if (href && href !== '#') {
				el.removeAttribute('aria-disabled');
			}
			if (el.dataset.olkilLabel !== 'keep') {
				var textNode = el.querySelector('.olkil-btn-label') || el;
				if (el.querySelector('.olkil-btn-label')) {
					el.querySelector('.olkil-btn-label').textContent = labels[os];
				} else if (el.childNodes.length === 1 && el.childNodes[0].nodeType === 3) {
					el.textContent = labels[os];
				}
			}
		});

		document.querySelectorAll('[data-olkil-os]').forEach(function (el) {
			var key = el.getAttribute('data-olkil-os');
			var href = resolveDownloadHref(downloads, key);
			if (href && href !== '#') {
				el.setAttribute('href', href);
			}
			if (key === os) {
				el.classList.add('is-recommended');
			}
		});
	}

	function initSmoothAnchors() {
		document.querySelectorAll('a[href^="#"]').forEach(function (a) {
			a.addEventListener('click', function (e) {
				var id = a.getAttribute('href');
				if (!id || id === '#') return;
				var target = document.querySelector(id);
				if (!target) return;
				e.preventDefault();
				target.scrollIntoView({ behavior: 'smooth', block: 'start' });
			});
		});
	}

	function playSafe(video) {
		var p = video.play();
		if (p && typeof p.catch === 'function') {
			p.catch(function () {});
		}
	}

	function prefersReducedMotion() {
		try {
			return window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
		} catch (e) {
			return false;
		}
	}

	function initDemoVideo() {
		var video = document.querySelector('.olkil-demo__video');
		if (!video) return;

		video.muted = true;
		video.setAttribute('playsinline', '');

		function tryPlay() {
			playSafe(video);
		}

		if (video.readyState >= 2) {
			tryPlay();
		} else {
			video.addEventListener('loadeddata', tryPlay, { once: true });
		}

		document.addEventListener(
			'visibilitychange',
			function () {
				if (!document.hidden && video.paused) tryPlay();
			},
			false
		);
	}

	function initLoopVideos() {
		var stages = document.querySelectorAll('[data-olkil-loop-video]');
		if (!stages.length) return;
		var reduced = prefersReducedMotion();

		stages.forEach(function (stage) {
			var videos = Array.prototype.slice.call(stage.querySelectorAll('video'));
			if (!videos.length) return;

			videos.forEach(function (v) {
				v.muted = true;
				v.defaultMuted = true;
				v.playsInline = true;
				v.setAttribute('playsinline', '');
				v.setAttribute('webkit-playsinline', '');
				try { v.disablePictureInPicture = true; } catch (e) {}
			});

			if (reduced) {
				videos.forEach(function (v) {
					v.pause();
					v.loop = false;
					v.removeAttribute('autoplay');
				});
				try { videos[0].currentTime = 0; } catch (e) {}
				videos[0].classList.add('is-active');
				return;
			}

			var primary = videos[0];
			var secondary = videos[1];

			if (!secondary) {
				primary.loop = true;
				playSafe(primary);
				return;
			}

			var active = 0;
			var switching = false;
			var raf = 0;
			var lead = 0.14;

			function current() {
				return videos[active];
			}

			function next() {
				return videos[1 - active];
			}

			function switchToNext() {
				if (switching) return;
				var cur = current();
				var nxt = next();
				if (!nxt) return;
				switching = true;
				try { nxt.currentTime = 0; } catch (e) {}
				playSafe(nxt);
				nxt.classList.add('is-active');
				cur.classList.remove('is-active');
				active = 1 - active;
				window.setTimeout(function () {
					try {
						cur.pause();
						cur.currentTime = 0;
					} catch (e) {}
					switching = false;
				}, 70);
			}

			function tick() {
				var cur = current();
				if (!switching && cur.duration && isFinite(cur.duration) && cur.currentTime >= Math.max(0, cur.duration - lead)) {
					switchToNext();
				}
				raf = window.requestAnimationFrame(tick);
			}

			primary.loop = false;
			secondary.loop = false;
			primary.removeAttribute('loop');
			secondary.removeAttribute('loop');

			primary.addEventListener('ended', function () {
				if (!switching) switchToNext();
			});
			secondary.addEventListener('ended', function () {
				if (!switching) switchToNext();
			});

			function start() {
				playSafe(primary);
				if (raf) window.cancelAnimationFrame(raf);
				raf = window.requestAnimationFrame(tick);
			}

			if (primary.readyState >= 2) start();
			else primary.addEventListener('loadeddata', start, { once: true });

			document.addEventListener('visibilitychange', function () {
				if (document.hidden) {
					if (raf) window.cancelAnimationFrame(raf);
					raf = 0;
					return;
				}
				if (current().paused) playSafe(current());
				if (!raf) raf = window.requestAnimationFrame(tick);
			});
		});
	}

	function resolveTheme(pref) {
		if (pref === 'light' || pref === 'dark') return pref;
		try {
			return window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
		} catch (e) {
			return 'dark';
		}
	}

	function applyTheme(pref) {
		var mode = pref === 'light' || pref === 'dark' || pref === 'system' ? pref : 'dark';
		var resolved = resolveTheme(mode);
		document.documentElement.setAttribute('data-olkil-theme', resolved);
		document.documentElement.setAttribute('data-olkil-theme-pref', mode);
		try { localStorage.setItem('olkil-theme', mode); } catch (e) {}
		document.querySelectorAll('.olkil-theme-toggle [data-olkil-theme]').forEach(function (btn) {
			var on = btn.getAttribute('data-olkil-theme') === mode;
			btn.classList.toggle('is-active', on);
			btn.setAttribute('aria-checked', on ? 'true' : 'false');
		});
	}

	function initThemeToggle() {
		var root = document.querySelector('.olkil-theme-toggle');
		var saved = 'dark';
		try { saved = localStorage.getItem('olkil-theme') || 'dark'; } catch (e) {}
		applyTheme(saved);
		if (!root) return;
		root.querySelectorAll('[data-olkil-theme]').forEach(function (btn) {
			btn.addEventListener('click', function () {
				applyTheme(btn.getAttribute('data-olkil-theme'));
			});
		});
		if (window.matchMedia) {
			var mq = matchMedia('(prefers-color-scheme: light)');
			var onChange = function () {
				var pref = document.documentElement.getAttribute('data-olkil-theme-pref') || 'dark';
				if (pref === 'system') applyTheme('system');
			};
			if (mq.addEventListener) mq.addEventListener('change', onChange);
			else if (mq.addListener) mq.addListener(onChange);
		}
	}
})();
