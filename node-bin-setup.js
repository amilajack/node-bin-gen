const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

function linkSync(src, dest) {
  try {
    fs.unlinkSync(dest);
  } catch (e) {
    if (e.code !== 'ENOENT') {
      throw e;
    }
  }
  return fs.linkSync(src, dest);
}

function installArchSpecificPackage(scope = undefined, packageName = 'node', version, require) {
  process.env.npm_config_global = 'false';

  const platform = process.platform === 'win32' ? 'win' : process.platform;
  const arch =
    platform === 'win' && process.arch === 'ia32' ? 'x86' : process.arch;
  const suffixedScope = scope ? `${scope}/` : '';

  const cp = spawn(
    platform === 'win' ? 'yarn.cmd' : 'yarn',
    [
      'add',
      '--no-save',
      `${suffixedScope}${[packageName, platform, arch].join('-')}@${version}`
    ],
    {
      stdio: 'inherit',
      shell: true
    }
  );

  cp.on('close', code => {
    const pkgJson = require.resolve(
      `${suffixedScope}${[packageName, platform, arch].join('-')}/package.json`
    );
    const subpkg = JSON.parse(fs.readFileSync(pkgJson, 'utf8'));
    const executable = subpkg.bin.node;
    const bin = path.resolve(path.dirname(pkgJson), executable);

    try {
      fs.mkdirSync(path.resolve(process.cwd(), 'bin'));
    } catch (e) {
      if (e.code !== 'EEXIST') {
        throw e;
      }
    }

    linkSync(bin, path.resolve(process.cwd(), executable));

    if (platform === 'win') {
      const pkg = JSON.parse(
        fs.readFileSync(path.resolve(process.cwd(), 'package.json'))
      );
      fs.writeFileSync(
        path.resolve(process.cwd(), 'bin/node'),
        'This file intentionally left blank'
      );
      pkg.bin.node = 'bin/node.exe';
      fs.writeFileSync(
        path.resolve(process.cwd(), 'package.json'),
        JSON.stringify(pkg, null, 2)
      );
    }

    return process.exit(code);
  });
}

module.exports = installArchSpecificPackage;
