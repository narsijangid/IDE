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

const NATIVE_MODULE_NAMES = ['node-pty', '@parcel/watcher', 'spdlog', 'nsfw', 'keytar'];

function resolvePackAppDir(context) {
  return (
    (context && (context.appDir || (context.packager && context.packager.appDir))) ||
    path.join(__dirname, '../app')
  );
}

function copyNativeBuildsIntoApp(appDir) {
  const rootNm = path.join(__dirname, '../node_modules');
  const appNm = path.join(appDir, 'node_modules');
  if (!fs.existsSync(appNm)) {
    fs.mkdirSync(appNm, { recursive: true });
  }
  for (const name of NATIVE_MODULE_NAMES) {
    const src = path.join(rootNm, name);
    const dest = path.join(appNm, name);
    if (!fs.existsSync(path.join(src, 'build'))) {
      continue;
    }
    fs.cpSync(src, dest, { recursive: true, dereference: true });
    console.log('[pack] copied rebuilt native module', name);
  }
}

function assertWindowsConpty(appDir) {
  if (!targetPlatforms.includes('win32')) {
    return;
  }
  const candidates = [
    path.join(__dirname, '../node_modules/node-pty/build/Release/conpty.node'),
    appDir && path.join(appDir, 'node_modules/node-pty/build/Release/conpty.node'),
  ].filter(Boolean);
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) {
    throw new Error(
      '[pack] node-pty is missing build/Release/conpty.node.\n' +
        'Run `yarn rebuild-native` on Windows before packing.\n' +
        'Without it, installed OLKIL shows: Cannot find module conpty.node',
    );
  }
}

const targetPlatforms = (process.env.TARGET_PLATFORMS || DEFAULT_TARGET_PLATFORM).split(',').map((str) => str.trim());
const targetArches = TARGET_ARCH.split(',').map((str) => str.trim());

assertWindowsConpty();

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

// Bake DeepSeek / Dazzlone keys into extraResources (gitignored olkil.env).
require('../scripts/stage-olkil-env');
const olkilEnvFile = path.join(__dirname, 'olkil.env');
const requireCloud = process.env.OLKIL_REQUIRE_CLOUD_KEYS === '1' || process.env.GITHUB_ACTIONS === 'true';
if (fs.existsSync(olkilEnvFile)) {
  extraResources.push({
    from: path.join(__dirname),
    to: '.',
    filter: ['olkil.env'],
  });
  const envText = fs.readFileSync(olkilEnvFile, 'utf8');
  const hasDeepseek = /^DEEPSEEK_API_KEY=.+$/m.test(envText);
  console.log(`[pack] Bundling olkil.env (deepseek=${hasDeepseek ? 'yes' : 'NO'})`);
  if (requireCloud && !hasDeepseek) {
    throw new Error('[pack] olkil.env has no DEEPSEEK_API_KEY — installers would 401 in chat.');
  }
} else if (requireCloud) {
  throw new Error('[pack] build/olkil.env missing — set DEEPSEEK_API_KEY before pack');
} else {
  console.warn('[pack] build/olkil.env missing — cloud chat will 401 in this installer');
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

const opencodeDir = path.join(__dirname, 'opencode');
const opencodeBin = path.join(opencodeDir, process.platform === 'win32' ? 'opencode.exe' : 'opencode');
if (!fs.existsSync(opencodeBin)) {
  throw new Error(
    '[pack] OpenCode sidecar missing at ' +
      opencodeBin +
      '. Run `yarn stage-opencode` before packing — without it DeepSeek/agent chat cannot start.',
  );
}
extraResources.push({
  from: opencodeDir,
  to: 'opencode',
  filter: ['**/*'],
});
console.log('[pack] Bundling OpenCode sidecar from', opencodeDir);

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
      asarUnpack: [
        'bin/**',
        'node_modules/@opensumi/ripgrep/**',
        'node_modules/@opensumi/vscode-ripgrep/**',
        'node_modules/node-pty/**',
        'node_modules/@parcel/watcher/**',
        'node_modules/spdlog/**',
        '**/*.node',
      ],
      // Native modules are rebuilt via `yarn rebuild-native` then copied in beforePack.
      npmRebuild: process.env.OLKIL_NPM_REBUILD === '1',
      beforePack: async (context) => {
        const appDir = resolvePackAppDir(context);
        copyNativeBuildsIntoApp(appDir);
        assertWindowsConpty(appDir);
      },
      publish: publishProviders,
      mac: {
        icon: 'build/icon/olkilmainlogo.png',
        artifactName: '${productName}-${version}-${arch}.${ext}',
        target: 'dmg',
      },
      win: {
        artifactName: '${productName}-${version}.${ext}',
        icon: 'build/icon/olkilmainlogo.png',
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
        icon: 'build/icon/olkilmainlogo.png',
        category: 'Development',
        maintainer: 'OLKIL <hello@olkil.com>',
        vendor: 'OLKIL',
        synopsis: 'OLKIL AI Code Editor',
        description: 'Free AI-powered IDE for Windows, macOS, and Linux.',
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
