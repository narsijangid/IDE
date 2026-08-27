const { writeFileSync } = require('fs');
const path = require('path');

function saveJson(jsonPath, jsonContent) {
  writeFileSync(jsonPath, JSON.stringify(jsonContent, null, 2) + '\n');
}

function saveProductJson() {
  const productJson = require('../product.json');
  if (process.env.SUMI_VERSION) {
    productJson['sumiVersion'] = String(process.env.SUMI_VERSION).trim();
  }
  if (process.env.PRODUCT_VERSION) {
    let _version = String(process.env.PRODUCT_VERSION).trim();
    if (_version.startsWith('v')) {
      _version = _version.substring(1);
    }
    productJson['version'] = _version;
  }
  saveJson(path.join(__dirname, '../product.json'), productJson);
}

function applySumiVersion() {
  const { sumiVersion } = require('../product.json');
  if (!sumiVersion) {
    return;
  }

  const pkg = require('../package.json');
  const devDependencies = pkg['devDependencies'];

  for (const [k] of Object.entries(devDependencies)) {
    if (k === '@opensumi/di') {
      continue;
    }
    if (!k.startsWith('@opensumi/')) {
      continue;
    }
    devDependencies[k] = sumiVersion;
  }

  saveJson(path.join(__dirname, '../package.json'), pkg);
}

function applyVersion() {
  delete require.cache[require.resolve('../product.json')];
  const { version: productVersion } = require('../product.json');
  const buildPackage = require('../build/package.json');
  buildPackage['version'] = productVersion;
  saveJson(path.join(__dirname, '../build/package.json'), buildPackage);
}

saveProductJson();
applySumiVersion();
applyVersion();
