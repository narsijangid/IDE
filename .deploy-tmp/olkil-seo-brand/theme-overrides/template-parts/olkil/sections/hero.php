<?php
/**
 * Hero section
 *
 * @package OLKIL
 */
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}
?>
<section class="olkil-hero" aria-labelledby="olkil-brand">
	<div class="olkil-hero__glow" aria-hidden="true"></div>
	<div class="olkil-wrap">
		<div class="olkil-hero__grid">
			<div>
				<p class="olkil-eyebrow">
					<span class="olkil-eyebrow__dot" aria-hidden="true"></span>
					<?php esc_html_e( 'Collaborate with Intelligence', 'olkil' ); ?>
				</p>

				<p class="olkil-hero__kicker"><?php esc_html_e( 'Ship faster with', 'olkil' ); ?></p>

				<div class="olkil-brand-lockup" id="olkil-brand">
					<span class="olkil-brand-hero">OLKIL</span>
				</div>

				<h1 class="olkil-headline">
					<?php esc_html_e( 'Your free AI coding agent for building ambitious software.', 'olkil' ); ?>
				</h1>

				<p class="olkil-hero__lead">
					<?php esc_html_e( 'Agents, smart autocomplete, multi-model chat, and a full IDE — free on Windows, macOS, and Linux.', 'olkil' ); ?>
				</p>

				<div class="olkil-hero__ctas">
					<a class="olkil-btn olkil-btn--primary olkil-btn--lg" data-olkil-download="auto" href="<?php echo esc_url( home_url( '/download/' ) ); ?>">
						<span class="olkil-btn-label"><?php esc_html_e( 'Download free', 'olkil' ); ?></span>
					</a>
					<a class="olkil-btn olkil-btn--ghost olkil-btn--lg" href="<?php echo esc_url( home_url( '/features/' ) ); ?>">
						<?php esc_html_e( 'Explore features', 'olkil' ); ?>
					</a>
				</div>

				<div class="olkil-hero__meta">
					<span>
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg>
						<?php esc_html_e( 'Windows · macOS · Linux', 'olkil' ); ?>
					</span>
					<span>
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg>
						<?php esc_html_e( 'Fully free', 'olkil' ); ?>
					</span>
				</div>
			</div>

			<div class="olkil-ide" aria-hidden="true">
				<div class="olkil-ide__titlebar">
					<div class="olkil-ide__dots"><i></i><i></i><i></i></div>
					<span class="olkil-ide__path">olkil · agent · main.ts</span>
				</div>
				<div class="olkil-ide__body">
					<div class="olkil-ide__rail">
						<span class="is-active"></span>
						<span></span>
						<span></span>
						<span></span>
					</div>
					<pre class="olkil-ide__code"><span class="c-muted">// OLKIL Agent</span>
<span class="c-pink">async</span> <span class="c-white">function</span> <span class="c-pink">shipFeature</span>() {
  <span class="c-white">const</span> plan = <span class="c-pink">await</span> agent.plan({
    goal: <span class="c-pink">"build dashboard"</span>
  });
  <span class="c-pink">await</span> agent.run(plan);
  <span class="c-muted">// done — review &amp; merge</span>
  <span class="cursor-line"></span>
}</pre>
				</div>
				<div class="olkil-ide__chat">
					<strong>OLKIL</strong> — Built the dashboard, wired data, and opened a PR. Ready when you are.
				</div>
			</div>
		</div>
	</div>
</section>
