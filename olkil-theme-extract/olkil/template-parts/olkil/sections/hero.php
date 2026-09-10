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

			<?php
			$hero_webm = OLKIL_URI . 'assets/olkil/video/hero-agent.webm';
			$hero_mp4  = OLKIL_URI . 'assets/olkil/video/hero-agent.mp4';
			?>
			<div class="olkil-hero-agent" aria-hidden="true">
				<div class="olkil-hero-agent__stage">
					<video
						class="olkil-hero-agent__video"
						muted
						autoplay
						loop
						playsinline
						webkit-playsinline
						preload="auto"
						disablePictureInPicture
					>
						<source src="<?php echo esc_url( $hero_webm ); ?>" type="video/webm" />
						<source src="<?php echo esc_url( $hero_mp4 ); ?>" type="video/mp4" />
					</video>
				</div>
			</div>
		</div>
	</div>
</section>
