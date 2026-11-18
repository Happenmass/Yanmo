const { execFileSync } = require('node:child_process');
const { join } = require('node:path');

module.exports = async function signMacBridge(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const bridge = join(context.appOutDir, context.packager.appInfo.productFilename + '.app',
    'Contents', 'Resources', 'native', 'YanmoBridge');
  // A standalone Swift binary otherwise picks up an identifier derived from its build.
  const identity = 'Developer ID Application: ' + context.packager.platformSpecificBuildOptions.identity;
  execFileSync('/usr/bin/codesign', ['--force', '--sign', identity, '--timestamp', '--options', 'runtime',
    '--identifier', 'org.yanmo.desktop.bridge', '--entitlements', join(context.packager.projectDir, 'runtime/macos/entitlements.plist'),
    bridge], { stdio: 'inherit' });
};
