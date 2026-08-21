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
		initReveal();
		initOsDownload();
		initSmoothAnchors();
		initDemoVideo();
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

	function initDemoVideo() {
		var video = document.querySelector('.olkil-demo__video');
		if (!video) return;

		video.muted = true;
		video.setAttribute('playsinline', '');

		function tryPlay() {
			var p = video.play();
			if (p && typeof p.catch === 'function') {
				p.catch(function () {
					/* Autoplay blocked until user gesture — muted loop still fine on most browsers */
				});
			}
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
})();
