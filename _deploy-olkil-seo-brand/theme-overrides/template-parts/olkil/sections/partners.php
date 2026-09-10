<?php
/**
 * Works with leading AI companies — logo marquee under the hero.
 *
 * @package OLKIL
 */
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

if ( ! function_exists( 'olkil_ai_company_logos' ) ) {
/**
 * Parent companies of models OLKIL routes (OpenRouter + local).
 *
 * @return array<int, array{name:string,bg:string,svg:string}>
 */
function olkil_ai_company_logos() {
	return array(
		array(
			'name' => 'Google',
			'bg'   => '#ffffff',
			'svg'  => '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>',
		),
		array(
			'name' => 'OpenAI',
			'bg'   => '#10A37F',
			'svg'  => '<svg viewBox="0 0 24 24" fill="#fff" aria-hidden="true"><path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A6.066 6.066 0 0 0 19.018 19.82a5.989 5.989 0 0 0 4.002-2.9 6.056 6.056 0 0 0-.746-7.1zM13.44 22.43a4.476 4.476 0 0 1-2.866-.98l.141-.08 4.779-2.76a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.504 4.435zM3.958 18.293a4.45 4.45 0 0 1-.535-3.014l.142.085 4.783 2.761a.771.771 0 0 0 .78 0l5.843-3.374v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-5.783-1.657zm-.514-9.58a4.476 4.476 0 0 1 2.365-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 3.444 8.712zm16.32 2.24-5.833-3.387 2.018-1.162a.076.076 0 0 1 .071 0l4.83 2.787a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.41-.678zm2.058-3.046-.142-.085-4.773-2.782a.776.776 0 0 0-.785 0L9.409 9.4V7.068a.083.083 0 0 1 .033-.062l4.859-2.807a4.5 4.5 0 0 1 6.507 4.627zM8.51 12.637l-2.02-1.163a.08.08 0 0 1-.038-.057V5.83a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.97 5.218a.795.795 0 0 0-.393.681zm1.097-2.365 2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z"/></svg>',
		),
		array(
			'name' => 'Anthropic',
			'bg'   => '#191919',
			'svg'  => '<svg viewBox="0 0 24 24" fill="#D4A27F" aria-hidden="true"><path d="M17.304 3.541h-3.674L22.634 20.46h3.673L17.304 3.54zm-10.608 0L0 20.46h3.744l1.86-4.36h7.65l1.852 4.36H19L10.303 3.54h-3.607zm1.254 9.935 2.528-6.385 2.534 6.385H7.95z"/></svg>',
		),
		array(
			'name' => 'xAI',
			'bg'   => '#000000',
			'svg'  => '<svg viewBox="0 0 24 24" fill="#fff" aria-hidden="true"><path d="M3.1 3.2h4.7L12 9.4l4.2-6.2h4.7L14.4 12l6.6 8.8h-4.7L12 14.6 8.1 20.8H3.4L10 12 3.1 3.2z"/></svg>',
		),
		array(
			'name' => 'DeepSeek',
			'bg'   => '#4D6BFE',
			'svg'  => '<svg viewBox="0 0 24 24" fill="#fff" aria-hidden="true"><path d="M12 2c3.2 0 5.9 1.4 7.6 3.7C21.4 8 22 10.8 22 12c0 4.4-3.1 8.4-7.4 9.5-1 .3-2 .5-2.6.5s-1.6-.2-2.6-.5C5.1 20.4 2 16.4 2 12c0-1.2.6-4 2.4-6.3C6.1 3.4 8.8 2 12 2zm0 3.2c-2.3 0-4.3 1-5.5 2.7C5.3 9.5 4.8 11.4 4.8 12c0 3.2 2.3 6.1 5.4 6.9.8.2 1.4.3 1.8.3s1-.1 1.8-.3c3.1-.8 5.4-3.7 5.4-6.9 0-.6-.5-2.5-1.7-4.1C16.3 6.2 14.3 5.2 12 5.2zm-1.3 3.4 4.6 3.4-4.6 3.4V8.6z"/></svg>',
		),
		array(
			'name' => 'Meta',
			'bg'   => '#0082FB',
			'svg'  => '<svg viewBox="0 0 24 24" fill="#fff" aria-hidden="true"><path d="M6.915 4.03c-1.968 0-3.683 1.28-4.394 3.105C1.736 9.14 1.5 10.81 1.5 12.5c0 3.77 1.89 6.86 4.71 8.37 1.2.64 2.54.98 3.94.98 1.97 0 3.68-1.28 4.39-3.11.79-2 .99-3.67.99-5.36 0-3.77-1.89-6.86-4.71-8.37A7.86 7.86 0 0 0 6.915 4.03zm10.17 0c-1.4 0-2.74.34-3.94.98 2.82 1.51 4.71 4.6 4.71 8.37 0 1.69-.2 3.36-.99 5.36.71 1.83 2.42 3.11 4.39 3.11 1.4 0 2.74-.34 3.94-.98 2.82-1.51 4.71-4.6 4.71-8.37 0-1.69-.24-3.36-1.02-5.365C20.768 5.31 19.053 4.03 17.085 4.03zM12 8.2c1.55 0 2.8 1.9 2.8 4.25S13.55 16.7 12 16.7 9.2 14.8 9.2 12.45 10.45 8.2 12 8.2z"/></svg>',
		),
		array(
			'name' => 'Mistral',
			'bg'   => '#FA520F',
			'svg'  => '<svg viewBox="0 0 24 24" fill="#fff" aria-hidden="true"><path d="M3 4h4.2l1.8 4.4L12 4h4.2L12 14.2 7.8 8.4 12 20H7.8L3 8.4V4zm13.8 0H21v4.4h-4.2L12 14.2 16.8 4z"/></svg>',
		),
		array(
			'name' => 'Alibaba',
			'bg'   => '#FF6A00',
			'svg'  => '<svg viewBox="0 0 24 24" fill="#fff" aria-hidden="true"><path d="M3.2 8.4c2.4-1.2 5-1.9 8.8-1.9s6.4.7 8.8 1.9c.3.16.4.4.3.7l-.8 2.1c-.1.3-.4.4-.7.3-2-.9-4.2-1.4-7.6-1.4s-5.6.5-7.6 1.4c-.3.1-.6 0-.7-.3l-.8-2.1c-.1-.3 0-.54.3-.7zm1.3 5.2c1.9-.9 4.1-1.3 7.5-1.3s5.6.4 7.5 1.3c.3.14.4.4.3.7l-.6 1.7c-.1.3-.4.4-.7.3-1.6-.7-3.4-1-6.5-1s-4.9.3-6.5 1c-.3.1-.6 0-.7-.3l-.6-1.7c-.1-.3 0-.56.3-.7zM12 16.6c1.7 0 3.1.2 4.4.6.3.1.4.4.3.7l-.4 1.1c-.1.3-.4.4-.7.3-1.1-.3-2.2-.4-3.6-.4s-2.5.1-3.6.4c-.3.1-.6 0-.7-.3l-.4-1.1c-.1-.3 0-.6.3-.7 1.3-.4 2.7-.6 4.4-.6z"/></svg>',
		),
		array(
			'name' => 'Qwen',
			'bg'   => '#5B4DFF',
			'svg'  => '<svg viewBox="0 0 24 24" fill="#fff" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="#fff" stroke-width="1.7"/><path d="M8.2 14.6c.9 1.2 2.2 1.9 3.8 1.9 2.6 0 4.6-1.9 4.6-4.5S14.6 7.5 12 7.5c-1.6 0-2.9.7-3.8 1.9"/><circle cx="12" cy="12" r="2.1"/></svg>',
		),
		array(
			'name' => 'Poolside',
			'bg'   => '#7C3AED',
			'svg'  => '<svg viewBox="0 0 24 24" fill="#fff" aria-hidden="true"><path d="M4 7.5h6.2c2.9 0 4.8 1.7 4.8 4.5S13.1 16.5 10.2 16.5H4V7.5zm3.1 2.5v3.9h3c1.3 0 2-.7 2-1.95S11.4 10 10.1 10H7.1zM16.2 16.5V7.5H21v2.4h-2.7v1.2H20.7v2.2h-2.4v3.2h-2.1z"/></svg>',
		),
	);
}
}

$olkil_ai_logos = olkil_ai_company_logos();
$olkil_ai_loop  = array_merge( $olkil_ai_logos, $olkil_ai_logos );
?>
<section class="olkil-ai-cos" aria-labelledby="olkil-ai-cos-title">
	<div class="olkil-wrap">
		<header class="olkil-ai-cos__head">
			<p class="olkil-ai-cos__kicker" id="olkil-ai-cos-title"><?php esc_html_e( 'Works with leading AI companies', 'olkil' ); ?></p>
			<p class="olkil-ai-cos__sub"><?php esc_html_e( "Access the world's leading AI models from a single IDE.", 'olkil' ); ?></p>
		</header>
	</div>
	<div class="olkil-ai-cos__viewport">
		<div class="olkil-ai-cos__track" aria-hidden="true">
			<?php foreach ( $olkil_ai_loop as $co ) : ?>
				<div class="olkil-ai-cos__chip">
					<span class="olkil-ai-cos__mark" style="background: <?php echo esc_attr( $co['bg'] ); ?>">
						<?php echo $co['svg']; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped — static SVG markup ?>
					</span>
					<span class="olkil-ai-cos__name"><?php echo esc_html( $co['name'] ); ?></span>
				</div>
			<?php endforeach; ?>
		</div>
	</div>
</section>
