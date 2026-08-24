(function () {
	'use strict';

	function b64(buf) {
		var bytes = new Uint8Array(buf);
		var s = '';
		for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
		return btoa(s);
	}

	function parseJson(res) {
		return res.json().then(function (data) {
			if (!res.ok) throw new Error((data && data.error) || 'crypto_unavailable');
			return data;
		});
	}

	async function encryptFields(publicJwk, obj) {
		var pub = await crypto.subtle.importKey(
			'jwk',
			publicJwk,
			{ name: 'RSA-OAEP', hash: 'SHA-256' },
			false,
			['encrypt']
		);
		var aesKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
		var iv = crypto.getRandomValues(new Uint8Array(12));
		var packed = await crypto.subtle.encrypt(
			{ name: 'AES-GCM', iv: iv },
			aesKey,
			new TextEncoder().encode(JSON.stringify(obj))
		);
		var packedBytes = new Uint8Array(packed);
		var tag = packedBytes.slice(packedBytes.length - 16);
		var data = packedBytes.slice(0, packedBytes.length - 16);
		var rawAes = await crypto.subtle.exportKey('raw', aesKey);
		var wrapped = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, pub, rawAes);
		return {
			alg: 'RSA-OAEP-256+AES-GCM',
			wrappedKey: b64(wrapped),
			iv: b64(iv),
			tag: b64(tag),
			data: b64(data),
			ts: Date.now(),
		};
	}

	function ready(fn) {
		if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
		else fn();
	}

	function guessCountry(form) {
		var hidden = form.querySelector('[name="olkil_country"]');
		if (hidden && hidden.value && /^[A-Za-z]{2}$/.test(hidden.value)) {
			return String(hidden.value).toUpperCase();
		}
		try {
			var loc = Intl.DateTimeFormat().resolvedOptions().locale || '';
			var parts = loc.split(/[-_]/);
			for (var i = parts.length - 1; i >= 0; i--) {
				if (/^[A-Za-z]{2}$/.test(parts[i]) && parts[i].toUpperCase() !== 'EN') {
					return parts[i].toUpperCase();
				}
			}
		} catch (e) {}
		return 'IN';
	}

	ready(function () {
		var cfg = window.olkilPayuCheckout;
		var form = document.querySelector('form.olkil-payu__form');
		if (!cfg || !cfg.cryptoUrl || !form || !window.crypto || !crypto.subtle) return;

		var btn = form.querySelector('button[type="submit"]');
		var errBox = form.parentNode.querySelector('.olkil-payu__error--crypto');

		form.addEventListener('submit', function (ev) {
			if (form.getAttribute('data-olkil-enc') === '1') return;
			ev.preventDefault();

			var firstname = (form.querySelector('[name="firstname"]') || {}).value || '';
			var email = (form.querySelector('[name="email"]') || {}).value || '';
			var phone = String((form.querySelector('[name="phone"]') || {}).value || '').replace(/\D+/g, '');
			var plan = (form.querySelector('[name="plan"]') || {}).value || '';
			var country = guessCountry(form);
			var countryField = form.querySelector('[name="olkil_country"]');
			if (countryField) countryField.value = country;

			if (firstname.trim().length < 2 || email.indexOf('@') < 1 || phone.length < 8) {
				form.submit();
				return;
			}

			if (btn) {
				btn.disabled = true;
				btn.setAttribute('data-label', btn.textContent);
				btn.textContent = 'Encrypting…';
			}

			fetch(cfg.cryptoUrl, { method: 'GET', credentials: 'omit', cache: 'no-store' })
				.then(parseJson)
				.then(function (pub) {
					if (!pub || !pub.publicJwk) throw new Error('crypto_unavailable');
					return encryptFields(pub.publicJwk, {
						plan: plan,
						firstname: firstname.trim(),
						email: email.trim(),
						phone: phone,
						country: country,
					});
				})
				.then(function (enc) {
					var hidden = form.querySelector('[name="olkil_payu_enc"]');
					if (!hidden) {
						hidden = document.createElement('input');
						hidden.type = 'hidden';
						hidden.name = 'olkil_payu_enc';
						form.appendChild(hidden);
					}
					hidden.value = JSON.stringify(enc);
					['firstname', 'email', 'phone'].forEach(function (name) {
						var el = form.querySelector('[name="' + name + '"]');
						if (el) el.value = '';
					});
					form.setAttribute('data-olkil-enc', '1');
					if (btn) btn.textContent = 'Redirecting to PayU…';
					form.submit();
				})
				.catch(function () {
					if (btn) {
						btn.disabled = false;
						btn.textContent = btn.getAttribute('data-label') || 'Pay securely';
					}
					form.submit();
				});
		});
	});
})();
