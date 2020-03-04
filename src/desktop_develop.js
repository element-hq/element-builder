/*
Copyright 2020 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

const fsProm = require('fs').promises;
const path = require('path');

const rimraf = require('rimraf');

const getSecret = require('./get_secret');
const GitRepo = require('./gitrepo');
const logger = require('./logger');

const Runner = require('./runner');
const DockerRunner = require('./docker_runner');

const WindowsBuilder = require('./windows_builder');

const TYPES = ['win64', 'mac', 'linux'];

const DESKTOP_GIT_REPO = 'https://github.com/vector-im/riot-desktop.git';
const ELECTRON_BUILDER_CFG_FILE = 'electron-builder.json';

// take a date object and advance it to 9am the next morning
function getNextBuildTime(d) {
    const next = new Date(d.getTime());
    next.setHours(9);
    next.setMinutes(0);
    next.setSeconds(0);
    next.setMilliseconds(0);

    if (next.getTime() < d.getTime()) {
        next.setDate(next.getDate() + 1);
    }

    return next;
}

async function getLastBuildTime(type) {
    try {
        return await fsProm.readFile('desktop_develop_lastBuilt_' + type, 'utf8');
    } catch (e) {
        return 0;
    }
}

async function putLastBuildTime(type, t) {
    try {
        return await fsProm.writeFile('desktop_develop_lastBuilt_' + type, t);
    } catch (e) {
        return 0;
    }
}

function getBuildVersion() {
    // YYYYMMDDNN where NN is in case we need to do multiple versions in a day
    // NB. on windows, squirrel will try to parse the versiopn number parts,
    // including this string, into 32 bit integers, which is fine as long
    // as we only add two digits to the end...
    const now = new Date();
    const month = (now.getMonth() + 1).toString().padStart(2, '0');
    const date = now.getDate().toString().padStart(2, '0');
    const buildNum = '01';
    return now.getFullYear() + month + date + buildNum;
}

class DesktopDevelopBuilder {
    constructor(winVmName, winUsername, winPassword) {
        this.winVmName = winVmName;
        this.winUsername = winUsername;
        this.winPassword = winPassword;
    }

    async start() {
        logger.info("Starting Desktop/develop builder...");
        this.building = false;

        this.lastBuildTimes = {};
        this.lastFailTimes = {};
        for (const type of TYPES) {
            this.lastBuildTimes[type] = parseInt(await getLastBuildTime(type));
            this.lastFailTimes[type] = 0;
        }

        setInterval(this.poll, 30 * 1000);
        this.poll();
    }

    poll = async () => {
        if (this.building) return;

        for (const type of TYPES) {
            const nextBuildDue = getNextBuildTime(new Date(Math.max(
                this.lastBuildTimes[type], this.lastFailTimes[type],
            )));
            //logger.debug("Next build due at " + nextBuildDue);
            if (nextBuildDue.getTime() < Date.now()) {
                try {
                    this.building = true;
                    logger.info("Starting build of " + type);
                    const thisBuildVersion = getBuildVersion();
                    await this.build(type, thisBuildVersion);
                    this.lastBuildTimes[type] = Date.now();
                    await putLastBuildTime(type, this.lastBuildTimes[type]);
                } catch (e) {
                    logger.error("Build failed!", e);
                    this.lastFailTimes[type] = Date.now();
                } finally {
                    this.building = false;
                }
            }
        }
    }

    async writeElectronBuilderConfigFile(repoDir, buildVersion) {
        // Electron builder doesn't overlay with the config in package.json,
        // so load it here
        const cfg = JSON.parse(await fsProm.readFile(path.join(repoDir, 'package.json'))).build;

        Object.assign(cfg, {
            // We override a lot of the metadata for the nightly build
            extraMetadata: {
                name: "riot-desktop-nightly",
                productName: "Riot Nightly",
                // the windows packager relies on parsing this as semver :(
                version: '0.0.0-nightly.' + buildVersion,
            },
            appId: "im.riot.nightly",
            win: Object.assign({
                // We keep this in here so the riot-desktop repo will build
                // for windows unsigned by default and not error if you don't
                // have our cert installed, which means others can build it
                // without having to patch package.json
                certificateSubjectName: "New Vector Ltd",
            }, cfg.win),
        });
        await fsProm.writeFile(
            path.join(repoDir, ELECTRON_BUILDER_CFG_FILE),
            JSON.stringify(cfg, null, 4),
        );
    }

    async build(type, buildVersion) {
        if (type.startsWith('win')) {
            return this.buildWin(type, buildVersion);
        } else {
            return this.buildLocal(type, buildVersion);
        }
    }

    async buildLocal(type, buildVersion) {
        const repoDir = 'riot-desktop-' + type + '-' + buildVersion;
        await new Promise((resolve, reject) => {
            rimraf(repoDir, (err) => {
                err ? reject(err) : resolve();
            });
        });
        logger.info("Cloning riot-desktop into " + repoDir);
        const repo = new GitRepo(repoDir);
        await repo.clone(DESKTOP_GIT_REPO, repoDir);
        // NB. we stay on the 'master' branch of the riot-desktop
        // repo (and fetch the develop version of riot-web later)
        logger.info("...checked out 'develop' branch, starting build for " + type);

        await this.writeElectronBuilderConfigFile(repoDir, buildVersion);

        let runner;
        switch (type) {
            case 'mac':
                runner = this.makeMacRunner(repoDir);
                break;
            case 'linux':
                runner = this.makeLinuxRunner(repoDir);
                break;
        }

        await this.buildWithRunner(runner, buildVersion, type);
        logger.info("Build completed!");
    }

    makeMacRunner(cwd) {
        return new Runner(cwd);
    }

    makeLinuxRunner(cwd) {
        return new DockerRunner(cwd, path.join('scripts', 'in-docker.sh'));
    }

    async buildWithRunner(runner, buildVersion, type) {
        await runner.run('yarn', 'install');
        await runner.run('yarn', 'run', 'hak', 'check');
        await runner.run('yarn', 'run', 'build:native');
        await runner.run('yarn', 'run', 'fetch', 'develop', '-d', 'riot.im');
        // This part only actually necessary for the Debian package
        if (type == 'linux') {
            await runner.run('scripts/set-version.js', '--deb', buildVersion);
        }
        await runner.run('yarn', 'build', '--config', ELECTRON_BUILDER_CFG_FILE);
    }

    async buildWin(type, buildVersion) {
        // get the token passphrase now so we fail early if it's not in the keychain
        // NB. We supply the passphrase via a barely-documented feature of signtool
        // where it can parse it out of the name of the key container, so this
        // is actually the key container in the format [{{passphrase}}]=container
        const riotSigningKeyContainer = await getSecret('riot_key_container');

        const repoDir = 'riot-desktop-' + type + '-' + buildVersion;
        await new Promise((resolve, reject) => {
            rimraf(repoDir, (err) => {
                err ? reject(err) : resolve();
            });
        });

        // we still check out the repo locally because we need package.json
        // to write the electron builder config file, so we check out the
        // repo twice for windows: once locally and once on the VM...
        const repo = new GitRepo(repoDir);
        await repo.clone(DESKTOP_GIT_REPO, repoDir);
        //await fsProm.mkdir(repoDir);
        await this.writeElectronBuilderConfigFile(repoDir, buildVersion);

        const builder = new WindowsBuilder(
            repoDir, type, this.winVmName, this.winUsername, this.winPassword, riotSigningKeyContainer,
        );

        console.log("Starting Windows builder for " + type);
        await builder.start();

        const electronBuilderArchFlag = type === 'win64' ? '--x64' : '--ia32';

        try {
            builder.appendScript('rd', repoDir, '/s', '/q');
            builder.appendScript('git', 'clone', DESKTOP_GIT_REPO, repoDir);
        await repo.checkout('dbkr/winsign');
            builder.appendScript('git', 'checkout', 'dbkr/winsign');
            builder.appendScript('copy', 'z:\\' + ELECTRON_BUILDER_CFG_FILE, ELECTRON_BUILDER_CFG_FILE);
            builder.appendScript('call', 'yarn', 'install');
            builder.appendScript('call', 'yarn', 'run', 'hak', 'check');
            builder.appendScript('call', 'yarn', 'run', 'build:native');
            builder.appendScript('call', 'yarn', 'run', 'fetch', 'develop', '-d', 'riot.im');
            builder.appendScript(
                'call', 'yarn', 'build', electronBuilderArchFlag, '--config', ELECTRON_BUILDER_CFG_FILE,
            );
            builder.appendScript('xcopy dist z:\\dist /S /I /Y');
            builder.appendScript('cd', '..');
            builder.appendScript('rd', repoDir, '/s', '/q');

            console.log("Starting build...");
            await builder.runScript();
            console.log("Build complete!");
        } finally {
            await builder.stop();
        }
    }
}

module.exports = DesktopDevelopBuilder;
