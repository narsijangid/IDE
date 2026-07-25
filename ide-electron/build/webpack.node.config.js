const TsconfigPathsPlugin = require('tsconfig-paths-webpack-plugin');
const CopyPlugin = require('copy-webpack-plugin');
const path = require('path');
const { createConfig } = require('./webpack.base.config');

const tsConfigPath = path.join(__dirname, '../tsconfig.json');
const srcDir = path.join(__dirname, '../src/node');
const distDir = path.join(__dirname, '../app/node');

// `rgPath` resolves relative to the bundle's __dirname, so ripgrep must sit
// next to app/node as app/bin.
const rgBinDir = path.join(__dirname, '../node_modules/@opensumi/vscode-ripgrep/bin');

module.exports = createConfig({
  entry: path.join(srcDir, './index.ts'),
  target: 'node',
  output: {
    filename: 'index.js',
    path: distDir,
  },
  plugins: [
    new CopyPlugin({
      patterns: [{ from: rgBinDir, to: path.join(__dirname, '../app/bin'), noErrorOnMissing: true }],
    }),
  ],
  resolve: {
    extensions: ['.ts', '.tsx', '.mjs', '.js', '.json', '.less'],
    mainFields: ['main'],
    plugins: [
      new TsconfigPathsPlugin({
        configFile: tsConfigPath,
      }),
    ],
  },

  module: {
    // https://github.com/webpack/webpack/issues/196#issuecomment-397606728
    exprContextCritical: false,
    rules: [
      {
        test: /\.tsx?$/,
        loader: 'ts-loader',
        options: {
          configFile: tsConfigPath,
          transpileOnly: true,
        },
      },
      {
        test: /\.mjs$/,
        include: /node_modules/,
        type: 'javascript/auto',
      },
    ],
  },
  externals: [
    {
      nsfw: 'nsfw',
    },
    ({ context, request }, callback) => {
      if (
        ['node-pty', '@parcel/watcher', 'spdlog', '@opensumi/ripgrep', 'vm2', 'keytar', 'vertx'].indexOf(request) !== -1
      ) {
        return callback(null, 'commonjs ' + request);
      }
      callback();
    },
  ],
  resolveLoader: {
    modules: [path.join(__dirname, '../node_modules')],
    extensions: ['.ts', '.tsx', '.js', '.json', '.less'],
    mainFields: ['loader', 'main'],
  },
});
