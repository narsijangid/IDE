<?php
/**
 * Pricing — Dazzlone → Ultra (USD display)
 *
 * @package OLKIL
 */
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

$plans = array(
	array(
		'slug'     => 'dazzlone',
		'name'     => 'Dazzlone',
		'price'    => '0',
		'period'   => __( 'forever', 'olkil' ),
		'badge'    => __( 'Free', 'olkil' ),
		'blurb'    => __( 'Start shipping with local AI.', 'olkil' ),
		'includes' => '',
		'features' => array(
			__( 'Local models on your machine', 'olkil' ),
			__( 'Unlimited browser testing', 'olkil' ),
			__( 'Basic autocomplete', 'olkil' ),
			__( 'Basic AI chat', 'olkil' ),
			__( 'Basic code assistance', 'olkil' ),
		),
		'cta'      => __( 'Start free', 'olkil' ),
		'href'     => home_url( '/download/' ),
		'featured' => false,
		'accent'   => 'free',
	),
	array(
		'slug'     => 'lite',
		'name'     => 'Lite',
		'price'    => '3',
		'period'   => __( '/ mo', 'olkil' ),
		'badge'    => __( 'Starter', 'olkil' ),
		'blurb'    => __( 'Everyday AI coding, unlocked.', 'olkil' ),
		'includes' => __( 'Everything in Dazzlone, plus:', 'olkil' ),
		'features' => array(
			__( 'Cloud coding agent', 'olkil' ),
			__( 'Access to frontier models', 'olkil' ),
			__( 'Unlimited autocomplete', 'olkil' ),
			__( 'Project context', 'olkil' ),
			__( 'MCPs, skills, and hooks', 'olkil' ),
		),
		'cta'      => __( 'Get Lite', 'olkil' ),
		'href'     => home_url( '/checkout/?plan=lite' ),
		'featured' => false,
		'accent'   => 'lite',
	),
	array(
		'slug'     => 'pro',
		'name'     => 'Pro',
		'price'    => '10',
		'period'   => __( '/ mo', 'olkil' ),
		'badge'    => __( 'Popular', 'olkil' ),
		'blurb'    => __( 'Full project power for builders.', 'olkil' ),
		'includes' => __( 'Everything in Lite, plus:', 'olkil' ),
		'features' => array(
			__( 'Extended limits on Agent', 'olkil' ),
			__( 'Full project context', 'olkil' ),
			__( 'Longer cloud sessions', 'olkil' ),
			__( 'Priority on cloud models', 'olkil' ),
		),
		'cta'      => __( 'Get Pro', 'olkil' ),
		'href'     => home_url( '/checkout/?plan=pro' ),
		'featured' => true,
		'accent'   => 'pro',
	),
	array(
		'slug'     => 'ultra',
		'name'     => 'Ultra',
		'price'    => '49',
		'period'   => __( '/ mo', 'olkil' ),
		'badge'    => __( 'Flagship', 'olkil' ),
		'blurb'    => __( 'Ship faster with parallel agents.', 'olkil' ),
		'includes' => __( 'Everything in Pro, plus:', 'olkil' ),
		'features' => array(
			__( 'Highest included Agent usage', 'olkil' ),
			__( 'Parallel agents', 'olkil' ),
			__( 'Maximum context', 'olkil' ),
			__( 'Priority compute', 'olkil' ),
		),
		'cta'      => __( 'Get Ultra', 'olkil' ),
		'href'     => home_url( '/checkout/?plan=ultra' ),
		'featured' => false,
		'accent'   => 'ultra',
	),
);
?>
<section class="olkil-section olkil-pricing" id="pricing" aria-labelledby="olkil-pricing-title">
	<div class="olkil-wrap">
		<div class="olkil-section__head olkil-reveal">
			<p class="olkil-pricing__kicker"><?php esc_html_e( 'Plans · Prices in USD', 'olkil' ); ?></p>
			<h2 id="olkil-pricing-title"><?php esc_html_e( 'Choose your velocity.', 'olkil' ); ?></h2>
			<p><?php esc_html_e( 'Digital AI coding subscriptions priced in US dollars (USD). Unlimited browser testing on every plan. No physical shipping.', 'olkil' ); ?></p>
		</div>

		<div class="olkil-price-grid olkil-reveal" role="list">
			<?php foreach ( $plans as $plan ) : ?>
				<article
					class="olkil-price-card olkil-price-card--<?php echo esc_attr( $plan['accent'] ); ?><?php echo ! empty( $plan['featured'] ) ? ' is-featured' : ''; ?>"
					role="listitem"
					id="plan-<?php echo esc_attr( $plan['slug'] ); ?>"
				>
					<?php if ( ! empty( $plan['badge'] ) ) : ?>
						<span class="olkil-price-card__badge"><?php echo esc_html( $plan['badge'] ); ?></span>
					<?php endif; ?>
					<h3 class="olkil-price-card__name"><?php echo esc_html( $plan['name'] ); ?></h3>
					<p class="olkil-price-card__amount">
						<span class="olkil-price-card__currency">$</span><?php echo esc_html( $plan['price'] ); ?>
						<span class="olkil-price-card__period"><?php echo esc_html( $plan['period'] ); ?></span>
					</p>
					<p class="olkil-price-card__blurb"><?php echo esc_html( $plan['blurb'] ); ?></p>
					<?php if ( ! empty( $plan['includes'] ) ) : ?>
						<p class="olkil-price-card__includes"><?php echo esc_html( $plan['includes'] ); ?></p>
					<?php endif; ?>
					<ul class="olkil-price-card__features">
						<?php foreach ( $plan['features'] as $feature ) : ?>
							<li><?php echo esc_html( $feature ); ?></li>
						<?php endforeach; ?>
					</ul>
					<a
						class="olkil-btn <?php echo ! empty( $plan['featured'] ) || 'ultra' === $plan['slug'] ? 'olkil-btn--primary' : 'olkil-btn--ghost'; ?> olkil-btn--block"
						href="<?php echo esc_url( $plan['href'] ); ?>"
						<?php echo '0' === $plan['price'] ? 'data-olkil-download="auto"' : ''; ?>
					>
						<span class="olkil-btn-label"><?php echo esc_html( $plan['cta'] ); ?></span>
					</a>
				</article>
			<?php endforeach; ?>
		</div>
		<p class="olkil-pricing__footnote olkil-reveal"><?php esc_html_e( 'Included cloud usage is billed against your plan this period. Prices in USD. Cancel anytime.', 'olkil' ); ?></p>
	</div>
</section>
