<?php
/**
 * Template Name: OLKIL Product
 * Description: Product landing pages (Desktop, Community, Cloud, Live Test, Autocomplete, Marketplace).
 *
 * @package Astra
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

get_header();

$queried = get_queried_object();
$slug    = ( $queried && ! empty( $queried->post_name ) ) ? $queried->post_name : '';
$catalog = function_exists( 'olkil_product_catalog' ) ? olkil_product_catalog() : array();
$page    = isset( $catalog[ $slug ] ) ? $catalog[ $slug ] : null;

if ( ! $page ) {
	$page = array(
		'eyebrow' => __( 'Product', 'olkil' ),
		'title'   => get_the_title(),
		'lead'    => '',
		'cta'     => array(
			'label' => __( 'Download free', 'olkil' ),
			'url'   => olkil_page_url( 'download' ),
		),
		'points'  => array(),
		'steps'   => array(),
	);
}

$nav_items = function_exists( 'olkil_product_nav_items' ) ? olkil_product_nav_items() : array();
?>
<main id="content" class="olkil-product-page">
	<header class="olkil-page-hero olkil-product-hero">
		<div class="olkil-wrap">
			<p class="olkil-eyebrow" style="justify-content:center;">
				<span class="olkil-eyebrow__dot" aria-hidden="true"></span>
				<?php echo esc_html( $page['eyebrow'] ); ?>
			</p>
			<h1><?php echo esc_html( $page['title'] ); ?></h1>
			<?php if ( ! empty( $page['lead'] ) ) : ?>
				<p><?php echo esc_html( $page['lead'] ); ?></p>
			<?php endif; ?>
			<?php if ( ! empty( $page['cta']['url'] ) ) : ?>
				<?php
				$cta_ext  = ! empty( $page['cta']['external'] );
				$cta2_ext = ! empty( $page['cta2']['external'] );
				?>
				<p class="olkil-product-hero__ctas">
					<a class="olkil-btn olkil-btn--primary olkil-btn--lg" href="<?php echo esc_url( $page['cta']['url'] ); ?>"<?php echo $cta_ext ? ' target="_blank" rel="noopener noreferrer"' : ''; ?>>
						<span class="olkil-btn-label"><?php echo esc_html( $page['cta']['label'] ); ?></span>
					</a>
					<?php if ( ! empty( $page['cta2']['url'] ) ) : ?>
						<a class="olkil-btn olkil-btn--ghost olkil-btn--lg" href="<?php echo esc_url( $page['cta2']['url'] ); ?>"<?php echo $cta2_ext ? ' target="_blank" rel="noopener noreferrer"' : ''; ?>>
							<?php echo esc_html( $page['cta2']['label'] ); ?>
						</a>
					<?php endif; ?>
				</p>
			<?php endif; ?>
		</div>
	</header>

	<?php if ( ! empty( $page['preview']['src'] ) ) : ?>
		<?php
		$preview     = $page['preview'];
		$preview_src = ( 0 === strpos( $preview['src'], 'http' ) ) ? $preview['src'] : ( OLKIL_URI . ltrim( $preview['src'], '/' ) );
		$preview_url = ! empty( $preview['url'] ) ? $preview['url'] : '';
		?>
		<section class="olkil-section olkil-community-stage" aria-label="<?php esc_attr_e( 'OLKIL Community preview', 'olkil' ); ?>">
			<div class="olkil-wrap">
				<figure class="olkil-community-frame">
					<div class="olkil-community-chrome" aria-hidden="true">
						<span></span><span></span><span></span>
						<em>forum.olkil.com</em>
					</div>
					<?php if ( $preview_url ) : ?>
						<a class="olkil-community-shot" href="<?php echo esc_url( $preview_url ); ?>" target="_blank" rel="noopener noreferrer">
							<img src="<?php echo esc_url( $preview_src ); ?>" alt="<?php echo esc_attr( ! empty( $preview['alt'] ) ? $preview['alt'] : '' ); ?>" width="1440" height="900" loading="lazy">
						</a>
					<?php else : ?>
						<div class="olkil-community-shot">
							<img src="<?php echo esc_url( $preview_src ); ?>" alt="<?php echo esc_attr( ! empty( $preview['alt'] ) ? $preview['alt'] : '' ); ?>" width="1440" height="900" loading="lazy">
						</div>
					<?php endif; ?>
				</figure>
				<?php if ( $preview_url ) : ?>
					<p class="olkil-community-cta">
						<a class="olkil-btn olkil-btn--primary olkil-btn--lg" href="<?php echo esc_url( $preview_url ); ?>" target="_blank" rel="noopener noreferrer">
							<span class="olkil-btn-label"><?php esc_html_e( 'Open OLKIL Community', 'olkil' ); ?></span>
						</a>
					</p>
				<?php endif; ?>
			</div>
		</section>
	<?php endif; ?>

	<?php if ( ! empty( $page['points'] ) ) : ?>
		<section class="olkil-section olkil-product-points" aria-labelledby="olkil-product-points-title">
			<div class="olkil-wrap">
				<div class="olkil-section__head">
					<h2 id="olkil-product-points-title"><?php esc_html_e( 'Why it ships faster.', 'olkil' ); ?></h2>
				</div>
				<div class="olkil-features">
					<?php foreach ( $page['points'] as $point ) : ?>
						<article class="olkil-feature olkil-reveal">
							<div class="olkil-feature__icon" aria-hidden="true"><?php echo esc_html( $point['icon'] ); ?></div>
							<h3><?php echo esc_html( $point['title'] ); ?></h3>
							<p><?php echo esc_html( $point['desc'] ); ?></p>
						</article>
					<?php endforeach; ?>
				</div>
			</div>
		</section>
	<?php endif; ?>

	<?php if ( ! empty( $page['steps'] ) ) : ?>
		<section class="olkil-section olkil-cli-steps" aria-labelledby="olkil-product-flow-title">
			<div class="olkil-wrap olkil-cli-wrap">
				<h2 id="olkil-product-flow-title"><?php esc_html_e( 'How it works', 'olkil' ); ?></h2>
				<ol class="olkil-cli-flow">
					<?php foreach ( $page['steps'] as $step ) : ?>
						<li>
							<strong><?php echo esc_html( $step[0] ); ?></strong>
							<span><?php echo esc_html( $step[1] ); ?></span>
						</li>
					<?php endforeach; ?>
				</ol>
			</div>
		</section>
	<?php endif; ?>

	<?php if ( $nav_items ) : ?>
		<nav class="olkil-section olkil-product-more" aria-label="<?php esc_attr_e( 'More product', 'olkil' ); ?>">
			<div class="olkil-wrap">
				<h2><?php esc_html_e( 'More in Product', 'olkil' ); ?></h2>
				<div class="olkil-product-more__grid">
					<?php foreach ( $nav_items as $item_slug => $label ) : ?>
						<?php
						if ( $item_slug === $slug ) {
							continue;
						}
						?>
						<a class="olkil-product-more__card" href="<?php echo esc_url( olkil_page_url( $item_slug ) ); ?>">
							<span><?php echo esc_html( $label ); ?></span>
						</a>
					<?php endforeach; ?>
				</div>
			</div>
		</nav>
	<?php endif; ?>

	<?php olkil_section( 'cta' ); ?>
</main>
<?php
get_footer();
