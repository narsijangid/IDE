<?php
/**
 * Plugin Name: OLKIL PayU Compliance
 * Description: Creates/updates PayU-required legal pages, About/Contact, INR pricing labels, and footer policy links.
 * Version: 2.0.1
 * Author: OLKIL
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'OLKIL_PAYU_VERSION', '2.0.1' );
define( 'OLKIL_PAYU_DIR', plugin_dir_path( __FILE__ ) );

/** Business details — update mobile/full address if GST docs differ. */
function olkil_payu_biz() {
	return array(
		'legal_name'  => 'NARSI RAM JANGID',
		'trade_name'  => 'OLKIL',
		'address'     => 'Lochhbo ki Basthi, Merasi, Beenthwaliya, Nagaur, Rajasthan, India - 341503',
		'email'       => 'narsi@olkil.com',
		// IMPORTANT: must match PayU / GST registered mobile. Update via WP option `olkil_business_mobile`.
		'mobile'      => get_option( 'olkil_business_mobile', '' ),
		'website'     => 'https://olkil.com',
		'country'     => 'India',
	);
}

/**
 * Upsert a page by slug.
 *
 * @param string $slug    Page slug.
 * @param string $title   Page title.
 * @param string $content HTML content.
 * @return int Page ID.
 */
function olkil_payu_upsert_page( $slug, $title, $content ) {
	$existing = get_page_by_path( $slug );
	$args     = array(
		'post_title'   => $title,
		'post_name'    => $slug,
		'post_content' => $content,
		'post_status'  => 'publish',
		'post_type'    => 'page',
		'post_author'  => 1,
		'comment_status' => 'closed',
		'ping_status'    => 'closed',
	);

	if ( $existing && ! empty( $existing->ID ) ) {
		$args['ID'] = (int) $existing->ID;
		return (int) wp_update_post( $args, true );
	}

	return (int) wp_insert_post( $args, true );
}

function olkil_payu_pages_content() {
	$b = olkil_payu_biz();
	$n = esc_html( $b['legal_name'] );
	$t = esc_html( $b['trade_name'] );
	$a = esc_html( $b['address'] );
	$e = esc_html( $b['email'] );
	$m_raw = trim( (string) $b['mobile'] );
	$m     = $m_raw !== '' ? esc_html( $m_raw ) : 'Contact via email (mobile will be published once registered number is confirmed)';
	$m_tel = $m_raw !== '' ? esc_attr( preg_replace( '/\s+/', '', $m_raw ) ) : '';
	$m_html = $m_tel !== ''
		? '<a href="tel:' . $m_tel . '">' . $m . '</a>'
		: esc_html( $m );
	$w = esc_url( $b['website'] );

	$biz_block = "<ul>
<li><strong>Legal Name:</strong> {$n}</li>
<li><strong>Trade / Brand Name:</strong> {$t}</li>
<li><strong>Operating Address:</strong> {$a}</li>
<li><strong>Email:</strong> <a href=\"mailto:{$e}\">{$e}</a></li>
<li><strong>Mobile:</strong> {$m_html}</li>
<li><strong>Website:</strong> <a href=\"{$w}\">{$w}</a></li>
</ul>";

	$pages = array();

	$pages['about-us'] = array(
		'title'   => 'About Us',
		'content' => "<p><strong>{$t}</strong> is an AI-powered code editor and IDE product operated in India.</p>
<p><strong>This website is operated by {$n}.</strong></p>
<p>We build free and paid software tools for developers — including AI agents, autocomplete, multi-model chat, browser testing, and desktop apps for Windows, macOS, and Linux.</p>
<h2>Legal / Business Details</h2>
{$biz_block}
<h2>What We Offer</h2>
<p>OLKIL provides digital software subscriptions (token-based AI coding plans) and a free local-model tier (Dazzlone). All paid services are delivered digitally online after successful payment.</p>
<h2>Our Mission</h2>
<p>Make professional AI coding tools accessible, transparent, and affordable for builders worldwide, with clear pricing in INR for Indian customers.</p>
<h2>Contact</h2>
<p>For support or business queries, email <a href=\"mailto:{$e}\">{$e}</a>" . ( $m_tel !== '' ? " or call {$m_html}" : '' ) . ".</p>",
	);

	$pages['contact'] = array(
		'title'   => 'Contact Us',
		'content' => "<p>Contact the operator of <strong>{$t}</strong> for product, billing, refund, cancellation, or partnership queries.</p>
<h2>Registered Business Details</h2>
{$biz_block}
<h2>Customer Support</h2>
<p>Email: <a href=\"mailto:{$e}\">{$e}</a><br>
Mobile: {$m_html}<br>
Address: {$a}</p>
<p>We typically respond within <strong>1–3 business days</strong>.</p>
<h2>Policy Links</h2>
<ul>
<li><a href=\"" . esc_url( home_url( '/about-us/' ) ) . "\">About Us</a></li>
<li><a href=\"" . esc_url( home_url( '/privacy-policy/' ) ) . "\">Privacy Policy</a></li>
<li><a href=\"" . esc_url( home_url( '/terms-and-conditions/' ) ) . "\">Terms &amp; Conditions</a></li>
<li><a href=\"" . esc_url( home_url( '/refund-policy/' ) ) . "\">Return &amp; Refund Policy</a></li>
<li><a href=\"" . esc_url( home_url( '/cancellation-policy/' ) ) . "\">Cancellation Policy</a></li>
<li><a href=\"" . esc_url( home_url( '/shipping-policy/' ) ) . "\">Shipping / Delivery Policy</a></li>
<li><a href=\"" . esc_url( home_url( '/pricing/' ) ) . "\">Pricing (INR)</a></li>
</ul>",
	);

	$pages['privacy-policy'] = array(
		'title'   => 'Privacy Policy',
		'content' => "<p><strong>Effective Date:</strong> August 14, 2026<br><strong>Last Updated:</strong> August 14, 2026</p>
<p><strong>This website is operated by {$n}</strong> under the trade name <strong>{$t}</strong>.</p>
<p>This Privacy Policy explains how we collect, use, store, and protect personal information when you use {$w} and the OLKIL software/services.</p>
<h2>1. Business Information</h2>
{$biz_block}
<h2>2. Information We Collect</h2>
<ul>
<li>Name, email, account credentials</li>
<li>Billing/payment confirmation details via payment gateway (we do not store full card numbers)</li>
<li>Device/browser/IP and usage logs</li>
<li>Support communications</li>
</ul>
<h2>3. How We Use Information</h2>
<ul>
<li>Provide and improve OLKIL services</li>
<li>Process subscriptions, renewals, refunds, and cancellations</li>
<li>Send transactional emails and support replies</li>
<li>Prevent fraud/abuse and comply with law</li>
</ul>
<h2>4. Sharing</h2>
<p>We do not sell personal data. We may share limited data with payment gateways (e.g. PayU), hosting/email providers, and authorities when legally required.</p>
<h2>5. Retention &amp; Security</h2>
<p>We retain data only as long as needed for service, legal, tax, and dispute purposes. We use reasonable security measures; no online transmission is 100% secure.</p>
<h2>6. Your Rights</h2>
<p>You may request access, correction, or deletion of your data by emailing <a href=\"mailto:{$e}\">{$e}</a>.</p>
<h2>7. Contact</h2>
<p>{$n}<br>{$t}<br>{$a}<br>Email: <a href=\"mailto:{$e}\">{$e}</a><br>Mobile: {$m}</p>",
	);

	$pages['terms-and-conditions'] = array(
		'title'   => 'Terms and Conditions',
		'content' => "<p><strong>Effective Date:</strong> August 14, 2026<br><strong>Last Updated:</strong> August 14, 2026</p>
<p><strong>This website is operated by {$n}.</strong> Trade / brand name: <strong>{$t}</strong>.</p>
<p>By using {$w}, creating an account, downloading OLKIL, or purchasing a plan, you agree to these Terms.</p>
<h2>1. Operator / Trade Details</h2>
{$biz_block}
<h2>2. Services</h2>
<p>OLKIL provides a digital AI code editor/IDE and related online subscription services (plans such as Dazzlone Free, Lite, Pro, Max, Ultra). Features and pricing may change; current INR prices are listed on the <a href=\"" . esc_url( home_url( '/pricing/' ) ) . "\">Pricing</a> page.</p>
<h2>3. Accounts</h2>
<p>You are responsible for account credentials and activity under your account. Contact us immediately at <a href=\"mailto:{$e}\">{$e}</a> if you suspect unauthorized access.</p>
<h2>4. Payments</h2>
<p>Paid plans are charged in <strong>INR (Indian Rupees)</strong> as displayed at checkout via our payment gateway. Taxes may apply as required by law.</p>
<h2>5. Refunds, Returns, Cancellation &amp; Delivery</h2>
<p>Governed by our:
<a href=\"" . esc_url( home_url( '/refund-policy/' ) ) . "\">Return &amp; Refund Policy</a>,
<a href=\"" . esc_url( home_url( '/cancellation-policy/' ) ) . "\">Cancellation Policy</a>, and
<a href=\"" . esc_url( home_url( '/shipping-policy/' ) ) . "\">Shipping / Delivery Policy</a>.</p>
<h2>6. Acceptable Use</h2>
<p>Do not use the Services for unlawful, abusive, fraudulent, or infringing activities, or to attack/disrupt systems.</p>
<h2>7. Intellectual Property</h2>
<p>OLKIL software, branding, and website content are owned by or licensed to {$n} / {$t}. You retain ownership of your own code.</p>
<h2>8. AI Output Disclaimer</h2>
<p>AI outputs may be inaccurate. You must review and validate before relying on them.</p>
<h2>9. Limitation of Liability</h2>
<p>To the maximum extent permitted by law, {$n} / {$t} is not liable for indirect or consequential damages. Total liability is limited to amounts paid by you in the 3 months before the claim.</p>
<h2>10. Governing Law</h2>
<p>These Terms are governed by the laws of India. Courts in Rajasthan, India shall have jurisdiction, subject to applicable consumer rights.</p>
<h2>11. Contact</h2>
<p>{$n}<br>{$t}<br>{$a}<br>Email: <a href=\"mailto:{$e}\">{$e}</a><br>Mobile: {$m}</p>",
	);

	$pages['refund-policy'] = array(
		'title'   => 'Return and Refund Policy',
		'content' => "<p><strong>Effective Date:</strong> August 14, 2026<br><strong>Last Updated:</strong> August 14, 2026</p>
<p><strong>This website is operated by {$n}</strong> (trade name {$t}).</p>
<p>OLKIL sells <strong>digital software subscriptions</strong>. There is no physical product to return. This policy covers returns/refunds for digital purchases.</p>
<h2>1. Business Details</h2>
{$biz_block}
<h2>2. Refund Request Duration</h2>
<p>You may request a refund within <strong>7 (seven) days</strong> from the date of successful payment.</p>
<h2>3. When Refunds May Be Approved</h2>
<ul>
<li>Duplicate / accidental payment</li>
<li>Charged after a confirmed cancellation that should have stopped renewal</li>
<li>Verified service failure on our side that we cannot fix within a reasonable time</li>
<li>Unused access verified shortly after an erroneous purchase</li>
</ul>
<h2>4. Non-Refundable Cases</h2>
<ul>
<li>Change of mind after substantial use</li>
<li>Unused token balance at period end</li>
<li>Failure to cancel before auto-renewal</li>
<li>Dissatisfaction with AI output quality alone</li>
<li>Account suspended for Terms violations</li>
</ul>
<h2>5. Refund Mode</h2>
<p>Approved refunds are processed to the <strong>original payment method</strong> through the payment gateway (e.g. PayU / card / UPI / netbanking used at checkout).</p>
<h2>6. Refund Timeline</h2>
<p>After approval, refunds typically reflect within <strong>5–10 business days</strong> (bank/UPI timelines may vary).</p>
<h2>7. How to Request</h2>
<p>Email <a href=\"mailto:{$e}\">{$e}</a>" . ( $m_tel !== '' ? " or call {$m_html}" : '' ) . " within 7 days with: full name, registered email, payment/order ID, plan name, and reason.</p>
<p>We aim to respond within <strong>3–7 business days</strong>.</p>
<h2>8. Contact</h2>
<p>{$n}<br>{$a}<br>{$e} | {$m}</p>",
	);

	$pages['cancellation-policy'] = array(
		'title'   => 'Cancellation Policy',
		'content' => "<p><strong>Effective Date:</strong> August 14, 2026<br><strong>Last Updated:</strong> August 14, 2026</p>
<p><strong>This website is operated by {$n}</strong> (trade name {$t}).</p>
<h2>1. Business Details</h2>
{$biz_block}
<h2>2. How to Cancel</h2>
<p>You may cancel a recurring OLKIL subscription at any time before the next billing date via your account settings (where available) or by emailing <a href=\"mailto:{$e}\">{$e}</a>" . ( $m_tel !== '' ? " / calling {$m_html}" : '' ) . " from your registered email/number.</p>
<h2>3. Cancellation Duration / Effect</h2>
<ul>
<li><strong>Immediate effect on renewals:</strong> Future auto-renewals stop after cancellation is confirmed.</li>
<li><strong>Access duration:</strong> You keep paid features until the end of the already-paid billing period.</li>
<li><strong>No automatic mid-cycle refund:</strong> Cancellation alone does not refund the current period unless approved under the Return &amp; Refund Policy (7-day window).</li>
</ul>
<h2>4. Confirmation Timeline</h2>
<p>Cancellation requests are usually confirmed within <strong>1–3 business days</strong>.</p>
<h2>5. Free Plan</h2>
<p>The free Dazzlone plan has no charge and needs no cancellation for billing.</p>
<h2>6. Contact</h2>
<p>{$n}<br>{$a}<br>{$e} | {$m}</p>",
	);

	$pages['shipping-policy'] = array(
		'title'   => 'Shipping and Delivery Policy',
		'content' => "<p><strong>Effective Date:</strong> August 14, 2026<br><strong>Last Updated:</strong> August 14, 2026</p>
<p><strong>This website is operated by {$n}</strong> (trade name {$t}).</p>
<p>OLKIL provides <strong>digital products/services only</strong>. No physical goods are shipped.</p>
<h2>1. Business Details</h2>
{$biz_block}
<h2>2. Delivery Method</h2>
<p>After successful online payment, access is delivered digitally by activating/upgrading your OLKIL account and/or enabling paid plan features online.</p>
<h2>3. Delivery Duration</h2>
<ul>
<li><strong>Standard digital delivery:</strong> Instant to within <strong>24 hours</strong> after successful payment confirmation.</li>
<li>In rare gateway/settlement delays, delivery may take up to <strong>48 hours</strong>.</li>
</ul>
<h2>4. Downloadable Software</h2>
<p>Desktop installers (Windows / macOS / Linux) are available from the Download page anytime. Paid AI token plans are account-based digital entitlements, not physical shipments.</p>
<h2>5. Failed Delivery</h2>
<p>If access is not enabled within 48 hours of successful payment, contact <a href=\"mailto:{$e}\">{$e}</a>" . ( $m_tel !== '' ? " or {$m_html}" : '' ) . " with your payment reference for priority resolution / refund eligibility review.</p>
<h2>6. Shipping Charges</h2>
<p><strong>₹0</strong> — no physical shipping charges apply.</p>
<h2>7. Contact</h2>
<p>{$n}<br>{$a}<br>{$e} | {$m}</p>",
	);

	return $pages;
}

/**
 * Create/update all PayU-required pages once per version.
 */
function olkil_payu_sync_pages() {
	if ( get_option( 'olkil_payu_pages_sync' ) === OLKIL_PAYU_VERSION ) {
		return;
	}

	foreach ( olkil_payu_pages_content() as $slug => $page ) {
		olkil_payu_upsert_page( $slug, $page['title'], $page['content'] );
	}

	update_option( 'olkil_payu_pages_sync', OLKIL_PAYU_VERSION, false );
}
add_action( 'init', 'olkil_payu_sync_pages', 5 );

/**
 * Sync footer template into theme when writable.
 */
function olkil_payu_sync_footer() {
	if ( get_option( 'olkil_payu_footer_sync' ) === OLKIL_PAYU_VERSION ) {
		return;
	}
	$src  = OLKIL_PAYU_DIR . 'footer.php';
	$dest = trailingslashit( get_theme_root() ) . 'olkil/template-parts/olkil/footer.php';
	if ( file_exists( $src ) && is_dir( dirname( $dest ) ) ) {
		if ( @copy( $src, $dest ) ) {
			update_option( 'olkil_payu_footer_sync', OLKIL_PAYU_VERSION, false );
		}
	}
}
add_action( 'init', 'olkil_payu_sync_footer', 6 );

/**
 * Force INR currency labels on pricing cards (PayU wants INR).
 */
function olkil_payu_inr_pricing_script() {
	?>
	<script id="olkil-payu-inr">
	(function () {
		var map = { '0': '0', '3': '249', '10': '849', '30': '2,499', '50': '4,199' };
		function convert() {
			document.querySelectorAll('.olkil-price-card').forEach(function (card) {
				var cur = card.querySelector('.olkil-price-card__currency');
				var amt = card.querySelector('.olkil-price-card__amount, .olkil-price-card__price, [class*="price"]');
				// Common structure: currency span + text/number sibling
				var currencyEls = card.querySelectorAll('.olkil-price-card__currency');
				currencyEls.forEach(function (el) {
					el.textContent = '₹';
				});
				card.querySelectorAll('.olkil-price-card__amount, .olkil-price-card__value').forEach(function (el) {
					var raw = (el.getAttribute('data-usd') || el.textContent || '').replace(/[^0-9.]/g, '');
					if (map[raw]) el.textContent = map[raw];
				});
				// Fallback: replace "$X" patterns inside card
				card.querySelectorAll('span, strong, p').forEach(function (el) {
					if (el.children.length) return;
					var t = el.textContent.trim();
					if (/^\$?\s*0$/.test(t)) { el.textContent = '0'; }
					else if (t === '3' || t === '$3') { el.textContent = '249'; }
					else if (t === '10' || t === '$10') { el.textContent = '849'; }
					else if (t === '30' || t === '$30') { el.textContent = '2,499'; }
					else if (t === '50' || t === '$50') { el.textContent = '4,199'; }
					if (el.classList.contains('olkil-price-card__currency') || t === '$') el.textContent = '₹';
				});
			});
			document.querySelectorAll('.olkil-price-card__currency').forEach(function (el) { el.textContent = '₹'; });
		}
		if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', convert);
		else convert();
		window.addEventListener('load', convert);
	})();
	</script>
	<style id="olkil-payu-inr-css">
		.olkil-price-card__currency{font-weight:700}
		.olkil-payu-inr-note{text-align:center;color:var(--olkil-text-muted,#a1a1aa);margin:0 0 1.25rem;font-size:.95rem}
	</style>
	<?php
}
add_action( 'wp_footer', 'olkil_payu_inr_pricing_script', 20 );

/**
 * Add INR note near pricing section head via footer JS.
 */
function olkil_payu_inr_note_js() {
	?>
	<script>
	(function(){
		function addNote(){
			var head = document.querySelector('.olkil-pricing .olkil-section__head, #pricing .olkil-section__head, .olkil-price-grid');
			if(!head || document.querySelector('.olkil-payu-inr-note')) return;
			var note = document.createElement('p');
			note.className = 'olkil-payu-inr-note';
			note.textContent = 'All plan prices are shown in INR (Indian Rupees). Digital software subscriptions — no physical shipping.';
			if (head.classList.contains('olkil-price-grid')) head.parentNode.insertBefore(note, head);
			else head.appendChild(note);
		}
		if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', addNote); else addNote();
	})();
	</script>
	<?php
}
add_action( 'wp_footer', 'olkil_payu_inr_note_js', 21 );

/**
 * Keep long articles visible (from earlier reveal bug).
 */
function olkil_payu_visibility_css() {
	echo '<style id="olkil-payu-visibility">.olkil-article.olkil-reveal,.olkil-article,.olkil-article .entry-content{opacity:1!important;transform:none!important;visibility:visible!important}</style>';
}
add_action( 'wp_head', 'olkil_payu_visibility_css', 99 );

register_activation_hook( __FILE__, function () {
	delete_option( 'olkil_payu_pages_sync' );
	delete_option( 'olkil_payu_footer_sync' );
	olkil_payu_sync_pages();
	olkil_payu_sync_footer();
} );
