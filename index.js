#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const os = require('os');
const util = require('util');
const VError = require('verror');
const zlib = require('zlib');
const { spawn } = require('child_process');
const yargs = require('yargs');

const execFile = util.promisify(require('child_process').execFile);

const unlink = util.promisify(fs.unlink);
const shell = require('shelljs');

const writeFile = util.promisify(fs.writeFile);
const readFile = util.promisify(fs.readFile);
const fetch = require('make-fetch-happen').defaults({
  cacheManager: path.resolve(os.homedir(), '.node-bin-gen-cache')
});
const rimraf = util.promisify(require('rimraf'));
const pump = util.promisify(require('pump'));
const debug = require('util').debuglog('node-bin-gen');
const eos = util.promisify(require('end-of-stream'));

yargs.option('skip-binaries', {
  describe: 'Skip downloading the binaries',
  boolean: true
});
yargs.option('only', { describe: 'Only download this binary package' });
yargs.option('scope', {
  alias: 's',
  describe: 'The scope the package will be published under',
  default: undefined
});
yargs.option('package-name', {
  alias: 'n',
  describe: 'Use this as the main package name',
  default: 'node'
});
yargs.version();
yargs.demandCommand(
  1,
  2,
  'You must specify version, and optionally a prerelease'
);
yargs.help('help').wrap(76);

const {argv} = yargs;

const versionprime = argv._[0];
const pre = argv._[1];
const suffixedScope = argv.scope ? `${argv.scope}/` : '';

if (!versionprime) {
  console.warn(`Use: ${  argv.$0  } version [pre]`);
  process.exit(1);
  return;
}

const version = versionprime[0] !== 'v' ? `v${  versionprime}` : version;

async function buildArchPackage(os, cpu, version, pre) {
  debug('building architecture specific package', os, cpu, version, pre);

  const platform = os === 'win' ? 'win32' : os;
  const arch = os === 'win' && cpu === 'ia32' ? 'x86' : cpu;
  const executable = os === 'win' ? 'bin/node.exe' : 'bin/node';

  const dir = path.join(__dirname, 'packages', `node-${os}-${cpu}`);
  const base = `node-${version}-${os}-${cpu}`;
  const filename = base + (os === 'win' ? '.zip' : '.tar.gz');
  const pkg = {
    name: [`${suffixedScope}${argv['package-name']}`, os, cpu].join('-'),
    version: version + (pre != null ? `-${pre}` : ''),
    description: 'node',
    bin: {
      node: executable
    },
    files: [
      os === 'win' ? 'bin/node.exe' : 'bin/node',
      'share',
      'include',
      '*.md',
      'LICENSE'
    ],
    os: platform,
    cpu: arch,
    publishConfig: {
      access: 'public'
    },
    license: 'MIT'
  };

  debug('removing', dir);
  await rimraf(dir, { glob: false });
  shell.mkdir('-p', dir);

  const url =
    `https://nodejs.org${ 
    /rc/.test(version)
      ? '/download/rc/'
      : /test/.test(version)
        ? '/download/test/'
        : '/dist/' 
    }${version 
    }/${ 
    filename}`;

  debug('Fetching', url);

  const res = await fetch(url);

  if (res.status !== 200 && res.status !== 304) {
    throw new VError('not ok: fetching %j got status code %s', url, res.status);
  }

  debug('Unpacking into', dir);

  if (os === 'win') {
    const f = fs.createWriteStream(filename);
    const written = pump(res.body, f);
    const closed = eos(f);

    await Promise.all([written, closed]);
    await execFile('unzip', [
      '-d',
      `${dir}/bin`,
      '-o',
      '-j',
      filename,
      `${base}/node.exe`
    ]);
    await unlink(filename);
  } else {
    const c = spawn('tar', ['--strip-components=1', '-C', dir, '-x'], {
      stdio: ['pipe', process.stdout, process.stderr]
    });
    await pump(res.body, zlib.createGunzip(), c.stdin);
  }

  await writeFile(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
  return pkg;
}

async function fetchManifest(version) {
  const base = 'http://nodejs.org';
  const url = (function() {
    if (/rc/.test(version)) {
      return `${base}/download/rc/index.json`;
    } if (/test/.test(version)) {
      return `${base}/download/test/index.json`;
    } 
      return `${base}/dist/index.json`;
    
  })();
  const res = await fetch(url);
  return res.json();
}

function buildMetapackage(version) {
  console.log([suffixedScope, argv['package-name']].join(''))
  const pkg = {
    name: [suffixedScope, argv['package-name']].join(''),
    version: version.replace(/^v/, ''),
    description: 'node',
    main: 'index.js',
    keywords: ['runtime'],
    repository: require('./package.json').repository,
    scripts: {
      install: 'node installArchSpecificPackage'
    },
    bin: {
      node: 'bin/node'
    },
    license: 'MIT',
    author: '',
    engines: {
      npm: '>=5.0.0'
    },
    publishConfig: {
      access: 'public'
    }
  };

  return pkg;
}

async function main() {
  const manifest = argv['skip-binaries'] ? [] : await fetchManifest(version);

  const v = manifest
    .filter((ver) => ver.version === version)
    .shift();

  if (!v) {
    throw new VError("No such version '%s'", version);
  }
  debug('manifest', v);

  if (!v.files || !v.files.length) {
    debug('No files, defaulting');
    v.files = [
      'darwin-x64',
      'linux-arm64',
      'linux-armv7l',
      'linux-ppc64',
      'linux-ppc64le',
      'linux-s390x',
      'linux-x64',
      'linux-x86',
      'sunos-x64',
      'win-x64',
      'win-x86'
    ];
  }

  const files = argv.only ? [argv.only] : v.files;

  const binaries = files
    .filter((f) => (
        !/^headers|^src/.test(f) &&
        !/pkg$/.test(f) &&
        !/^win-...-(exe|msi|7z)/.test(f)
      ))
    .map((f) => {
      const bits = f.split('-');
      return {
        os: bits[0].replace(/^osx$/, 'darwin'),
        cpu: bits[1],
        format: bits[2] || 'tar.gz'
      };
    });

  await Promise.all(
    binaries.map(v => buildArchPackage(v.os, v.cpu, version, pre))
  );

  const pkg = buildMetapackage(version + (pre != null ? `-${  pre}` : ''));

  const nodePkgDir = path.join(__dirname, 'packages', argv['package-name']);
  shell.mkdir('-p',  nodePkgDir);

  const script = `require('./node-bin-setup')(${suffixedScope}, ${argv['package-name']}, '${pkg.version}', require)`;
  const nodeBinSetupScript = fs.readFileSync(require.resolve('./node-bin-setup')).toString();

  await Promise.all([
    readFile(path.join(__dirname, 'node-bin-README.md'), 'utf8').then(
      readme =>
        writeFile(
          path.join(nodePkgDir, 'README.md'),
          readme.replace(/\$\{packagename\}/g, pkg.name)
        )
    ),
    writeFile(
      path.join(nodePkgDir, 'package.json'),
      JSON.stringify(pkg, null, 2)
    ),
    writeFile(path.join(nodePkgDir, 'installArchSpecificPackage.js'), script),
    writeFile(path.join(nodePkgDir, 'node-bin-setup.js'), nodeBinSetupScript)
  ]);
}

main().catch(err => {
  console.warn(err.stack);
  process.exit(1);
});
