<?php
/**
 * Pricing — Dazzlone → Ultra
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
		'tokens'   => '',
		'requests' => '',
		'features' => array(
			__( 'Free Local Models', 'olkil' ),
			__( 'Unlimited Browser Testing', 'olkil' ),
			__( 'Basic Autocomplete', 'olkil' ),
			__( 'Basic AI Chat', 'olkil' ),
			__( 'Basic Code Assistance', 'olkil' ),
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
		'tokens'   => '100M',
		'requests' => '~3,500',
		'features' => array(
			__( '100M tokens / mo', 'olkil' ),
			__( '~3,500 approx requests', 'olkil' ),
			__( 'Unlimited Autocomplete', 'olkil' ),
			__( 'Unlimited Browser Testing', 'olkil' ),
			__( 'AI Coding Agent', 'olkil' ),
			__( 'Project Context', 'olkil' ),
		),
		'cta'      => __( 'Get Lite', 'olkil' ),
		'href'     => home_url( '/login/?plan=lite' ),
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
		'tokens'   => '350M',
		'requests' => '~12,180',
		'features' => array(
			__( '350M tokens / mo', 'olkil' ),
			__( '~12,180 approx requests', 'olkil' ),
			__( 'Unlimited Autocomplete', 'olkil' ),
			__( 'Unlimited Browser Testing', 'olkil' ),
			__( 'AI Coding Agent', 'olkil' ),
			__( 'Full Project Context', 'olkil' ),
		),
		'cta'      => __( 'Get Pro', 'olkil' ),
		'href'     => home_url( '/login/?plan=pro' ),
		'featured' => true,
		'accent'   => 'pro',
	),
	array(
		'slug'     => 'max',
		'name'     => 'Max',
		'price'    => '30',
		'period'   => __( '/ mo', 'olkil' ),
		'badge'    => __( 'Power', 'olkil' ),
		'blurb'    => __( 'Advanced agents. Priority speed.', 'olkil' ),
		'tokens'   => '1B',
		'requests' => '~34,230',
		'features' => array(
			__( '1B tokens / mo', 'olkil' ),
			__( '~34,230 approx requests', 'olkil' ),
			__( 'Unlimited Autocomplete', 'olkil' ),
			__( 'Unlimited Browser Testing', 'olkil' ),
			__( 'Advanced Agent', 'olkil' ),
			__( 'Large Context', 'olkil' ),
			__( 'Priority Compute', 'olkil' ),
		),
		'cta'      => __( 'Get Max', 'olkil' ),
		'href'     => home_url( '/login/?plan=max' ),
		'featured' => false,
		'accent'   => 'max',
	),
	array(
		'slug'     => 'ultra',
		'name'     => 'Ultra',
		'price'    => '50',
		'period'   => __( '/ mo', 'olkil' ),
		'badge'    => __( 'Flagship', 'olkil' ),
		'blurb'    => __( 'Unlimited ceiling. Parallel agents.', 'olkil' ),
		'tokens'   => '2B',
		'requests' => '~68,460',
		'features' => array(
			__( '2B tokens / mo', 'olkil' ),
			__( '~68,460 approx requests', 'olkil' ),
			__( 'Unlimited Autocomplete', 'olkil' ),
			__( 'Unlimited Browser Testing', 'olkil' ),
			__( 'Unlimited Agent Usage*', 'olkil' ),
			__( 'Maximum Context', 'olkil' ),
			__( 'Parallel Agents', 'olkil' ),
			__( 'Priority Compute', 'olkil' ),
		),
		'cta'      => __( 'Get Ultra', 'olkil' ),
		'href'     => home_url( '/login/?plan=ultra' ),
		'featured' => false,
		'accent'   => 'ultra',
	),
);
?>
<section class="olkil-section olkil-pricing" id="pricing" aria-labelledby="olkil-pricing-title">
	<div class="olkil-wrap">
		<div class="olkil-section__head olkil-reveal">
			<p class="olkil-pricing__kicker"><?php esc_html_e( 'Plans', 'olkil' ); ?></p>
			<h2 id="olkil-pricing-title"><?php esc_html_e( 'Choose your velocity.', 'olkil' ); ?></h2>
			<p><?php esc_html_e( 'From free local models to 2B tokens — pick the plan that matches how you ship. Unlimited Browser Testing on every plan.', 'olkil' ); ?></p>
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
					<?php if ( ! empty( $plan['tokens'] ) ) : ?>
						<p class="olkil-price-card__tokens">
							<strong><?php echo esc_html( $plan['tokens'] ); ?></strong>
							<span><?php esc_html_e( 'tokens / mo', 'olkil' ); ?></span>
							<span class="olkil-price-card__req"><?php echo esc_html( $plan['requests'] ); ?> <?php esc_html_e( 'requests', 'olkil' ); ?></span>
						</p>
					<?php else : ?>
						<p class="olkil-price-card__tokens olkil-price-card__tokens--free">
							<strong><?php esc_html_e( 'Local', 'olkil' ); ?></strong>
							<span><?php esc_html_e( 'models · no cloud token cap', 'olkil' ); ?></span>
						</p>
					<?php endif; ?>
					<p class="olkil-price-card__blurb"><?php echo esc_html( $plan['blurb'] ); ?></p>
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
		<p class="olkil-pricing__footnote olkil-reveal"><?php esc_html_e( '* Fair-use limits may apply on Unlimited Agent Usage. Token estimates are approximate. Cancel anytime.', 'olkil' ); ?></p>
	</div>
</section>
