<?php
/**
 * Features grid
 *
 * @package OLKIL
 */
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

$features = array(
	array(
		'icon'  => '⌘',
		'title' => __( 'AI Agents', 'olkil' ),
		'desc'  => __( 'Hand off multi-step tasks. OLKIL plans, edits, and iterates while you stay in control.', 'olkil' ),
	),
	array(
		'icon'  => '✦',
		'title' => __( 'Smart Autocomplete', 'olkil' ),
		'desc'  => __( 'Context-aware suggestions that feel native — fast, accurate, and free.', 'olkil' ),
	),
	array(
		'icon'  => '◈',
		'title' => __( 'Multi-model Chat', 'olkil' ),
		'desc'  => __( 'Talk to your codebase. Ask, refactor, explain, and ship without leaving the editor.', 'olkil' ),
	),
	array(
		'icon'  => '⬡',
		'title' => __( 'Full IDE', 'olkil' ),
		'desc'  => __( 'Extensions, terminal, Git, debugging — a complete IDE, not a thin wrapper.', 'olkil' ),
	),
	array(
		'icon'  => '◎',
		'title' => __( 'Privacy-minded', 'olkil' ),
		'desc'  => __( 'Work the way you want with clear controls over context and what leaves your machine.', 'olkil' ),
	),
	array(
		'icon'  => '∇',
		'title' => __( 'Cross-platform', 'olkil' ),
		'desc'  => __( 'One free experience on Windows, macOS, and Linux. Same power everywhere.', 'olkil' ),
	),
);
?>
<section class="olkil-section" id="features" aria-labelledby="olkil-features-title">
	<div class="olkil-wrap">
		<div class="olkil-section__head olkil-reveal">
			<h2 id="olkil-features-title"><?php esc_html_e( 'Everything you need to ship.', 'olkil' ); ?></h2>
			<p><?php esc_html_e( 'Cursor-class AI tooling in a free IDE — agents, autocomplete, chat, and a full editor.', 'olkil' ); ?></p>
		</div>

		<div class="olkil-features">
			<?php foreach ( $features as $feature ) : ?>
				<article class="olkil-feature olkil-reveal">
					<div class="olkil-feature__icon" aria-hidden="true"><?php echo esc_html( $feature['icon'] ); ?></div>
					<h3><?php echo esc_html( $feature['title'] ); ?></h3>
					<p><?php echo esc_html( $feature['desc'] ); ?></p>
				</article>
			<?php endforeach; ?>
		</div>
	</div>
</section>
