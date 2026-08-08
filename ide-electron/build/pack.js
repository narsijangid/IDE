require('../scripts/apply-product');

const { productName } = require('../product.json');
const useNpmMirror = Boolean(process.env.USE_NPM_MIRROR);

const fs = require('fs');
const path = require('path');
const electronBuilder = require('electron-builder');
const rootPackage = require('../package.json');
const rimraf = require('rimraf');
const DEFAULT_TARGET_PLATFORM = process.platform;
// x64 arm64 全部值见 {electronBuilder.Arch}
const TARGET_ARCH = process.env.TARGET_ARCHES || 'x64';

// disable code sign
process.env.CSC_IDENTITY_AUTO_DISCOVERY = false;

// use double package.json structure, auto handle node_modules
fs.copyFileSync(path.join(__dirname, '../build/package.json'), path.join(__dirname, '../app/package.json'));

const targetPlatforms = (process.env.TARGET_PLATFORMS || DEFAULT_TARGET_PLATFORM).split(',').map((str) => str.trim());
const targetArches = TARGET_ARCH.split(',').map((str) => str.trim());

const targets = new Map();
if (targetPlatforms.includes('win32')) {
  targets.set(electronBuilder.Platform.WINDOWS, new Map([[electronBuilder.Arch.x64, ['nsis']]]));
}

if (targetPlatforms.includes('darwin')) {
  const archMap = new Map(targetArches.map((v) => [electronBuilder.Arch[v], ['dmg']]));
  targets.set(electronBuilder.Platform.MAC, archMap);
}

if (targetPlatforms.includes('linux')) {
  const archMap = new Map(
    targetArches.map((v) => [electronBuilder.Arch[v], ['deb', 'AppImage']]),
  );
  targets.set(electronBuilder.Platform.LINUX, archMap);
}

const outputPath = path.join(__dirname, '../out');
rimraf.sync(outputPath);

// Bundle the local AI engine (Ollama) so downloaded OLKIL works out-of-the-box.
// Populate build/ollama first: `node scripts/stage-ollama.js`
const ollamaDir = path.join(__dirname, 'ollama');
const extraResources = [
  {
    from: path.join(__dirname, '../extensions'),
    to: 'extensions',
    filter: ['**/*'],
  },
  {
    from: path.join(__dirname, '../resources'),
    to: 'resources',
    filter: ['**/*'],
  },
];

// Ship Dazzlone (Poolside) API key from local .env into packaged resources (gitignored).
try {
  require('../scripts/stage-olkil-env');
} catch (e) {
  console.warn('[pack] stage-olkil-env failed', e?.message || e);
}
const olkilEnvFile = path.join(__dirname, 'olkil.env');
if (fs.existsSync(olkilEnvFile)) {
  extraResources.push({
    from: path.join(__dirname),
    to: '.',
    filter: ['olkil.env'],
  });
  console.log('[pack] Bundling olkil.env for Dazzlone (from local .env)');
} else {
  console.warn('[pack] build/olkil.env missing — set POOLSIDE_API_KEY in ide-electron/.env before pack');
}

if (fs.existsSync(ollamaDir)) {
  extraResources.push({
    from: ollamaDir,
    to: 'ollama',
    filter: ['**/*'],
  });
  console.log('[pack] Bundling local AI engine from', ollamaDir);
} else {
  console.warn(
    '[pack] build/ollama not found — packaged app will fall back to a system Ollama install.\n' +
      '       Run `node scripts/stage-ollama.js` to bundle it for zero-setup users.',
  );
}

// Auto-update publish targets:
// - generic → Hostinger feed at updates.olkil.com (primary for installed apps)
// - github  → Releases mirror / backup (set GH_TOKEN to enable upload)
const updateFeedUrl = process.env.OLKIL_UPDATE_URL || 'https://updates.olkil.com';
const publishProviders = [
  {
    provider: 'generic',
    url: updateFeedUrl,
  },
];
if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) {
  publishProviders.push({
    provider: 'github',
    owner: process.env.OLKIL_GH_OWNER || 'narsijangid',
    repo: process.env.OLKIL_GH_REPO || 'IDE',
    releaseType: 'release',
  });
}

const shouldPublish = process.env.OLKIL_PUBLISH === '1' || process.env.OLKIL_PUBLISH === 'true';

electronBuilder
  .build({
    // 'never' still writes latest.yml locally; 'always' also uploads when tokens exist
    publish: shouldPublish ? 'always' : 'never',
    targets: targets.size ? targets : undefined,
    config: {
      productName,
      appId: 'com.olkil.ide',
      npmArgs: useNpmMirror ? ['--registry=https://registry.npmmirror.com'] : [],
      electronVersion: rootPackage.devDependencies.electron,
      // Register olkil:// so website auth can deep-link back into the IDE
      protocols: [
        {
          name: 'OLKIL',
          schemes: ['olkil'],
        },
      ],
      extraResources,
      directories: {
        output: outputPath,
      },
      asar: true,
      asarUnpack: ['node_modules/@opensumi/ripgrep'],
      // Native modules are rebuilt via `yarn rebuild-native` (Spectre libs may be missing on some VS installs)
      npmRebuild: process.env.OLKIL_NPM_REBUILD === '1',
      publish: publishProviders,
      mac: {
        icon: 'build/icon/sumi.png',
        artifactName: '${productName}-${version}-${arch}.${ext}',
        target: 'dmg',
      },
      win: {
        artifactName: '${productName}-${version}.${ext}',
        icon: 'build/icon/sumi.png',
        target: [
          {
            target: 'nsis',
            arch: ['x64'],
          },
        ],
      },
      nsis: {
        // oneClick + per-user makes silent background updates reliable
        // (electron-updater quitAndInstall /S works without wizard UI)
        oneClick: true,
        perMachine: false,
        allowToChangeInstallationDirectory: false,
        deleteAppDataOnUninstall: false,
        runAfterFinish: true,
        // Required so electron-updater can patch installed builds
        differentialPackage: true,
      },
      linux: {
        artifactName: '${productName}-${version}.${ext}',
        icon: 'build/icon/sumi.png',
        category: 'Development',
        target: [
          {
            target: 'deb',
            arch: ['x64'],
          },
          {
            target: 'AppImage',
            arch: ['x64'],
          },
        ],
      },
    },
  })
  .then(() => {
    console.log('[pack] done. Update feed URL:', updateFeedUrl);
    console.log('[pack] Next: node scripts/publish-update.js  (uploads out/ → Hostinger updates feed)');
  })
  .catch((err) => {
    console.error('[pack] failed', err);
    process.exit(1);
  });
