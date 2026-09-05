<?php
/**
 * Template Name: OLKIL CLI
 * Description: Install OLKIL CLI — Google login, then the agent in your terminal.
 *
 * @package Astra
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

get_header();

$ps  = 'irm https://olkil.com/downloads/cli/install.ps1 | iex';
$sh  = 'curl -fsSL https://olkil.com/downloads/cli/install.sh | bash';
$run = 'olkil';
?>
<main id="content" class="olkil-cli-page">
	<header class="olkil-page-hero olkil-cli-hero">
		<div class="olkil-wrap">
			<p class="olkil-eyebrow" style="justify-content:center;">
				<span class="olkil-eyebrow__dot" aria-hidden="true"></span>
				<?php esc_html_e( 'Product · CLI', 'olkil' ); ?>
			</p>
			<h1><?php esc_html_e( 'OLKIL in your terminal.', 'olkil' ); ?></h1>
			<p><?php esc_html_e( 'Install once. Run olkil. Sign in with Google in the browser. Pick a project. The agent works from there — same account and plan as the desktop app.', 'olkil' ); ?></p>
		</div>
	</header>

	<section class="olkil-section olkil-cli-preview" aria-label="<?php esc_attr_e( 'OLKIL CLI in the terminal', 'olkil' ); ?>">
		<div class="olkil-wrap olkil-cli-preview__wrap">
			<div class="olkil-cli-preview__glow" aria-hidden="true"></div>
			<figure class="olkil-cli-preview__window">
				<div class="olkil-cli-preview__bar" aria-hidden="true">
					<span class="olkil-cli-term__dot"></span>
					<span class="olkil-cli-term__dot"></span>
					<span class="olkil-cli-term__dot"></span>
					<span class="olkil-cli-preview__title">OLKIL CLI</span>
				</div>
				<img
					class="olkil-cli-preview__img"
					src="<?php echo esc_url( OLKIL_URI . 'assets/olkil/img/cli-preview.png' ); ?>"
					width="1280"
					height="720"
					alt="<?php esc_attr_e( 'OLKIL CLI in PowerShell — ask, edit, and ship from the terminal', 'olkil' ); ?>"
					loading="lazy"
					decoding="async"
				>
			</figure>
			<p class="olkil-cli-preview__caption"><?php esc_html_e( 'Same OLKIL agent as the desktop app — in your terminal.', 'olkil' ); ?></p>
		</div>
	</section>

	<section class="olkil-section olkil-cli-install" aria-labelledby="olkil-cli-install-title">
		<div class="olkil-wrap olkil-cli-wrap">
			<div class="olkil-cli-card">
				<div class="olkil-cli-tabs" role="tablist" aria-label="<?php esc_attr_e( 'Install for your OS', 'olkil' ); ?>">
					<button type="button" class="olkil-cli-tab is-active" role="tab" aria-selected="true" data-olkil-cli-tab="windows"><?php esc_html_e( 'Windows', 'olkil' ); ?></button>
					<button type="button" class="olkil-cli-tab" role="tab" aria-selected="false" data-olkil-cli-tab="macos"><?php esc_html_e( 'macOS', 'olkil' ); ?></button>
					<button type="button" class="olkil-cli-tab" role="tab" aria-selected="false" data-olkil-cli-tab="linux"><?php esc_html_e( 'Linux', 'olkil' ); ?></button>
				</div>

				<div class="olkil-cli-panel is-active" data-olkil-cli-panel="windows">
					<p class="olkil-cli-panel__label"><?php esc_html_e( 'PowerShell', 'olkil' ); ?></p>
					<div class="olkil-cli-term">
						<div class="olkil-cli-term__bar" aria-hidden="true">
							<span class="olkil-cli-term__dot"></span>
							<span class="olkil-cli-term__dot"></span>
							<span class="olkil-cli-term__dot"></span>
							<span class="olkil-cli-term__title">powershell</span>
						</div>
						<div class="olkil-cli-code">
							<code id="olkil-cli-cmd-win"><?php echo esc_html( $ps ); ?></code>
							<button type="button" class="olkil-cli-copy" data-olkil-copy="olkil-cli-cmd-win"><?php esc_html_e( 'Copy', 'olkil' ); ?></button>
						</div>
					</div>
				</div>
				<div class="olkil-cli-panel" data-olkil-cli-panel="macos" hidden>
					<p class="olkil-cli-panel__label"><?php esc_html_e( 'Terminal', 'olkil' ); ?></p>
					<div class="olkil-cli-term">
						<div class="olkil-cli-term__bar" aria-hidden="true">
							<span class="olkil-cli-term__dot"></span>
							<span class="olkil-cli-term__dot"></span>
							<span class="olkil-cli-term__dot"></span>
							<span class="olkil-cli-term__title">zsh</span>
						</div>
						<div class="olkil-cli-code">
							<code id="olkil-cli-cmd-mac"><?php echo esc_html( $sh ); ?></code>
							<button type="button" class="olkil-cli-copy" data-olkil-copy="olkil-cli-cmd-mac"><?php esc_html_e( 'Copy', 'olkil' ); ?></button>
						</div>
					</div>
				</div>
				<div class="olkil-cli-panel" data-olkil-cli-panel="linux" hidden>
					<p class="olkil-cli-panel__label"><?php esc_html_e( 'Terminal', 'olkil' ); ?></p>
					<div class="olkil-cli-term">
						<div class="olkil-cli-term__bar" aria-hidden="true">
							<span class="olkil-cli-term__dot"></span>
							<span class="olkil-cli-term__dot"></span>
							<span class="olkil-cli-term__dot"></span>
							<span class="olkil-cli-term__title">bash</span>
						</div>
						<div class="olkil-cli-code">
							<code id="olkil-cli-cmd-linux"><?php echo esc_html( $sh ); ?></code>
							<button type="button" class="olkil-cli-copy" data-olkil-copy="olkil-cli-cmd-linux"><?php esc_html_e( 'Copy', 'olkil' ); ?></button>
						</div>
					</div>
				</div>

				<p class="olkil-cli-note"><?php esc_html_e( 'Needs Node.js 18+. After install, open a new terminal and run:', 'olkil' ); ?></p>
				<div class="olkil-cli-term olkil-cli-run">
					<div class="olkil-cli-term__bar" aria-hidden="true">
						<span class="olkil-cli-term__dot"></span>
						<span class="olkil-cli-term__dot"></span>
						<span class="olkil-cli-term__dot"></span>
						<span class="olkil-cli-term__title">olkil</span>
					</div>
					<div class="olkil-cli-code">
						<code id="olkil-cli-cmd-run"><?php echo esc_html( $run ); ?></code>
						<button type="button" class="olkil-cli-copy" data-olkil-copy="olkil-cli-cmd-run"><?php esc_html_e( 'Copy', 'olkil' ); ?></button>
					</div>
				</div>
			</div>
		</div>
	</section>

	<section class="olkil-section olkil-cli-steps" aria-labelledby="olkil-cli-flow-title">
		<div class="olkil-wrap olkil-cli-wrap">
			<h2 id="olkil-cli-flow-title"><?php esc_html_e( 'How it works', 'olkil' ); ?></h2>
			<ol class="olkil-cli-flow">
				<li>
					<strong><?php esc_html_e( 'Install', 'olkil' ); ?></strong>
					<span><?php esc_html_e( 'One command in PowerShell or Terminal puts olkil on your PATH.', 'olkil' ); ?></span>
				</li>
				<li>
					<strong><?php esc_html_e( 'Google sign-in', 'olkil' ); ?></strong>
					<span><?php esc_html_e( 'The CLI opens olkil.com. Continue with Google. Your plan loads automatically.', 'olkil' ); ?></span>
				</li>
				<li>
					<strong><?php esc_html_e( 'Trust a project', 'olkil' ); ?></strong>
					<span><?php esc_html_e( 'Pick the folder you want the agent to work in — same idea as workspace trust in the desktop app.', 'olkil' ); ?></span>
				</li>
				<li>
					<strong><?php esc_html_e( 'Ship from the terminal', 'olkil' ); ?></strong>
					<span><?php esc_html_e( 'OLKIL runs in the foreground. Type a task and ship from the terminal.', 'olkil' ); ?></span>
				</li>
			</ol>
			<p class="olkil-cli-footnote"><?php esc_html_e( 'Free (Dazzlone) uses local models. Lite, Pro, and Ultra unlock cloud agents with the same quota as the IDE.', 'olkil' ); ?></p>
		</div>
	</section>
</main>
<?php
get_footer();
