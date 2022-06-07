/*
Copyright 2020-2021 The Matrix.org Foundation C.I.C.

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

import { promises as fsProm } from 'fs';
import * as path from 'path';
import { Target, TargetId, UniversalTarget, WindowsTarget } from 'element-desktop/scripts/hak/target';

import getSecret from './get_secret';
import GitRepo from './gitrepo';
import rootLogger, { LoggableError, Logger } from './logger';
import Runner, { IRunner } from './runner';
import DockerRunner from './docker_runner';
import WindowsBuilder from './windows_builder';
import { setDebVersion, addDeb } from './debian';
import { getMatchingFilesInDir, pushArtifacts, copyAndLog, rm } from './artifacts';
import { DESKTOP_GIT_REPO, ELECTRON_BUILDER_CFG_FILE } from "./desktop_builder";

const KEEP_BUILDS_NUM = 14; // we keep two week's worth of nightly builds

// take a date object and advance it to 9am the next morning
function getNextBuildTime(d: Date): Date {
    const next = new Date(d.getTime());
    next.setHours(8);
    next.setMinutes(0);
    next.setSeconds(0);
    next.setMilliseconds(0);

    if (next.getTime() < d.getTime()) {
        next.setDate(next.getDate() + 1);
    }

    return next;
}

async function getLastBuildTime(target: Target, logger: Logger): Promise<number> {
    try {
        return parseInt(await fsProm.readFile('desktop_develop_lastBuilt_' + target.id, 'utf8'));
    } catch (e) {
        logger.error(`Unable to read last build time for ${target.id}`, e);
        return 0;
    }
}

async function putLastBuildTime(target: Target, t: number, logger: Logger): Promise<void> {
    try {
        await fsProm.writeFile('desktop_develop_lastBuilt_' + target.id, t.toString());
    } catch (e) {
        logger.error(`Unable to write last build time for ${target.id}`, e);
    }
}

function getBuildVersion(): string {
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

async function pruneBuilds(dir: string, exp: RegExp, logger: Logger): Promise<void> {
    const builds = await getMatchingFilesInDir(dir, exp);
    builds.sort();
    const toDelete = builds.slice(0, 0 - KEEP_BUILDS_NUM);
    if (toDelete.length) {
        logger.info("Pruning old builds: " + toDelete.join(', '));
    }
    for (const f of toDelete) {
        await fsProm.unlink(path.join(dir, f));
    }
}

export default class DesktopDevelopBuilder {
    private pubDir = path.join(process.cwd(), 'packages.riot.im');
    // This should be a reprepro dir with a config redirecting
    // the output to pub/debian
    private debDir = path.join(process.cwd(), 'debian');
    private appPubDir = path.join(this.pubDir, 'nightly');
    private building = false;
    private riotSigningKeyContainer: string;
    private lastBuildTimes: Partial<Record<TargetId, number>> = {};
    private lastFailTimes: Partial<Record<TargetId, number>> = {};

    constructor(
        private readonly targets: Target[],
        private winVmName: string,
        private winUsername: string,
        private winPassword: string,
        private rsyncRoot: string,
    ) { }

    public async start(): Promise<void> {
        rootLogger.info("Starting Element Desktop nightly builder...");
        const logger = rootLogger.threadLogger();
        this.building = false;

        await WindowsBuilder.setDonglePower(false);

        // get the token passphrase now so a) we fail early if it's not in the keychain
        // and b) we know the keychain is unlocked because someone's sitting at the
        // computer to start the builder.
        // NB. We supply the passphrase via a barely-documented feature of signtool
        // where it can parse it out of the name of the key container, so this
        // is actually the key container in the format [{{passphrase}}]=container
        this.riotSigningKeyContainer = await getSecret('riot_key_container');

        this.lastBuildTimes = {};
        this.lastFailTimes = {};
        for (const target of this.targets) {
            this.lastBuildTimes[target.id] = await getLastBuildTime(target, logger);
            this.lastFailTimes[target.id] = 0;
        }

        setInterval(this.poll, 30 * 1000);
        await this.poll();
    }

    private poll = async (): Promise<void> => {
        if (this.building) return;

        const toBuild: Target[] = [];
        for (const target of this.targets) {
            const nextBuildDue = getNextBuildTime(new Date(Math.max(
                this.lastBuildTimes[target.id], this.lastFailTimes[target.id],
            )));
            //logger.debug("Next build due at " + nextBuildDue);
            if (nextBuildDue.getTime() < Date.now()) {
                toBuild.push(target);
            }
        }

        if (toBuild.length === 0) return;

        try {
            this.building = true;

            for (const target of toBuild) {
                rootLogger.info("Starting build of " + target.id);
                const jobReactionLogger = rootLogger.reactionLogger();
                const logger = rootLogger.threadLogger();
                try {
                    const thisBuildVersion = getBuildVersion();
                    await this.build(target, thisBuildVersion, logger);
                    this.lastBuildTimes[target.id] = Date.now();
                    await putLastBuildTime(target, this.lastBuildTimes[target.id], logger);
                    jobReactionLogger.info("✅ Done!");
                } catch (e) {
                    logger.error("Build failed!", e);
                    jobReactionLogger.info("🚨 Failed!");
                    this.lastFailTimes[target.id] = Date.now();

                    if (e instanceof LoggableError) {
                        logger.file(e.log);
                    }

                    // if one fails, bail out of the whole process: probably better
                    // to have all platforms not updating than just one
                    return;
                }
            }

            rootLogger.info(`Built packages for: ${toBuild.map(t => t.id).join(', ')} : pushing packages...`);
            const reactionLogger = rootLogger.reactionLogger();
            await pushArtifacts(this.pubDir, this.rsyncRoot, rootLogger);
            reactionLogger.info("✅ Done!");
        } catch (e) {
            rootLogger.error("Artifact sync failed!", e);
            // Mark all types as failed if artifact sync fails
            for (const target of toBuild) {
                this.lastFailTimes[target.id] = Date.now();
            }
        } finally {
            this.building = false;
        }
    };

    private async writeElectronBuilderConfigFile(
        target: Target,
        repoDir: string,
        buildVersion: string,
    ): Promise<void> {
        // Electron builder doesn't overlay with the config in package.json,
        // so load it here
        const pkg = JSON.parse(await fsProm.readFile(path.join(repoDir, 'package.json'), 'utf8'));
        const cfg = pkg.build;

        // Electron crashes on debian if there's a space in the path.
        // https://github.com/vector-im/element-web/issues/13171
        const productName = target.platform === 'linux' ? 'Element-Nightly' : 'Element Nightly';

        // the windows packager relies on parsing this as semver, so we have
        // to make it look like one. This will give our update packages really
        // stupid names but we probably can't change that either because squirrel
        // windows parses them for the version too. We don't really care: nobody
        // sees them. We just give the installer a static name, so you'll just
        // see this in the 'about' dialog.
        // Turns out if you use 0.0.0 here it makes Squirrel windows crash, so we use 0.0.1.
        const version = target.platform === 'win32' ? '0.0.1-nightly.' + buildVersion : buildVersion;

        Object.assign(cfg, {
            // We override a lot of the metadata for the nightly build
            extraMetadata: {
                name: "element-desktop-nightly",
                productName,
                version,
            },
            appId: "im.riot.nightly",
            deb: {
                fpm: [
                    "--deb-custom-control=debcontrol",
                ],
            },
        });
        await fsProm.writeFile(
            path.join(repoDir, ELECTRON_BUILDER_CFG_FILE),
            JSON.stringify(cfg, null, 4),
        );
    }

    private async build(target: Target, buildVersion: string, logger: Logger): Promise<void> {
        if (target.platform === 'win32') {
            return this.buildWin(target as WindowsTarget, buildVersion, logger);
        } else {
            return this.buildLocal(target, buildVersion, logger);
        }
    }

    private async buildLocal(target: Target, buildVersion: string, logger: Logger): Promise<void> {
        await fsProm.mkdir('builds', { recursive: true });
        const repoDir = path.join('builds', 'element-desktop-' + target.id + '-' + buildVersion);
        await rm(repoDir);
        logger.info("Cloning element-desktop into " + repoDir);
        const repo = new GitRepo(repoDir);
        await repo.clone(DESKTOP_GIT_REPO, repoDir);
        logger.info("...checked out 'develop' branch, starting build for " + target.id);

        await this.writeElectronBuilderConfigFile(target, repoDir, buildVersion);
        if (target.platform === 'linux') {
            await setDebVersion(
                buildVersion,
                path.join(repoDir, 'element.io', 'nightly', 'control.template'),
                path.join(repoDir, 'debcontrol'),
                logger,
            );
        }

        let runner: IRunner;
        switch (target.platform) {
            case 'darwin':
                runner = this.makeMacRunner(repoDir, logger);
                break;
            case 'linux':
                runner = this.makeLinuxRunner(repoDir, logger);
                break;
            default:
                throw new Error(`Unexpected local target ${target.id}`);
        }

        await runner.setup();
        await this.buildWithRunner(runner, buildVersion, target);
        logger.info("Build completed!");

        if (target.platform === 'darwin') {
            await fsProm.mkdir(path.join(this.appPubDir, 'install', 'macos'), { recursive: true });
            await fsProm.mkdir(path.join(this.appPubDir, 'update', 'macos'), { recursive: true });

            for (const f of await getMatchingFilesInDir(path.join(repoDir, 'dist'), /\.dmg$/)) {
                await copyAndLog(
                    path.join(repoDir, 'dist', f),
                    // be consistent with windows and don't bother putting the version number
                    // in the installer
                    path.join(this.appPubDir, 'install', 'macos', 'Element Nightly.dmg'),
                    logger,
                );
            }
            for (const f of await getMatchingFilesInDir(path.join(repoDir, 'dist'), /-mac.zip$/)) {
                await copyAndLog(
                    path.join(repoDir, 'dist', f),
                    path.join(this.appPubDir, 'update', 'macos', f),
                    logger,
                );
            }

            const latestPath = path.join(this.appPubDir, 'update', 'macos', 'latest');
            logger.info('Write ' + buildVersion + ' -> ' + latestPath);
            await fsProm.writeFile(latestPath, buildVersion);

            // prune update packages (the installer will just overwrite each time)
            await pruneBuilds(path.join(this.appPubDir, 'update', 'macos'), /-mac.zip$/, logger);
        } else if (target.platform === 'linux') {
            for (const f of await getMatchingFilesInDir(path.join(repoDir, 'dist'), /\.deb$/)) {
                await addDeb(this.debDir, path.resolve(repoDir, 'dist', f), logger);
            }
        }

        logger.info("Removing build dir");
        await rm(repoDir);
    }

    private makeMacRunner(cwd: string, logger: Logger): IRunner {
        return new Runner(cwd, logger);
    }

    private makeLinuxRunner(cwd: string, logger: Logger): IRunner {
        const wrapper = path.join('scripts', 'in-docker.sh');
        return new DockerRunner(cwd, wrapper, "element-desktop-dockerbuild-develop", logger, {
            // Develop build needs the buildkite api key to fetch the web build
            INDOCKER_BUILDKITE_API_KEY: process.env['BUILDKITE_API_KEY'],
        });
    }

    private async buildWithRunner(
        runner: IRunner,
        buildVersion: string,
        target: Target,
    ): Promise<void> {
        await runner.run('yarn', 'install');
        if (target.arch == 'universal') {
            for (const subTarget of (target as UniversalTarget).subtargets) {
                await runner.run('yarn', 'run', 'hak', 'check', '--target', subTarget.id);
            }
            for (const subTarget of (target as UniversalTarget).subtargets) {
                await runner.run('yarn', 'run', 'build:native', '--target', subTarget.id);
            }
            const targetArgs = [];
            for (const st of (target as UniversalTarget).subtargets) {
                targetArgs.push('--target');
                targetArgs.push(st.id);
            }
            await runner.run('yarn', 'run', 'hak', 'copy', ...targetArgs);
        } else {
            await runner.run('yarn', 'run', 'hak', 'check', '--target', target.id);
            await runner.run('yarn', 'run', 'build:native', '--target', target.id);
        }
        await runner.run('yarn', 'run', 'fetch', 'develop', '-d', 'element.io/nightly');
        await runner.run('yarn', 'build', `--${target.arch}`, '--config', ELECTRON_BUILDER_CFG_FILE);
    }

    private async buildWin(target: WindowsTarget, buildVersion: string, logger: Logger): Promise<void> {
        await fsProm.mkdir('builds', { recursive: true });
        // We're now running into Window's 260 character path limit. Adding a step
        // of 'faff about in the registry enabling NTFS long paths' to the list of
        // things to do when setting up a build box seems undesirable: this is an easy
        // place to save some characters: abbreviate element-desktop, omit the hyphens
        // and just use the arch (becuse, at least at the moment, the only vaguely
        // supported variations on windows is the arch).
        //const buildDirName = 'element-desktop-' + target.id + '-' + buildVersion;
        const buildDirName = 'ed' + target.arch + buildVersion;
        const repoDir = path.join('builds', buildDirName);
        await rm(repoDir);

        // we still check out the repo locally because we need package.json
        // to write the electron builder config file, so we check out the
        // repo twice for windows: once locally and once on the VM...
        const repo = new GitRepo(repoDir);
        await repo.clone(DESKTOP_GIT_REPO, repoDir);
        //await fsProm.mkdir(repoDir);
        await this.writeElectronBuilderConfigFile(target, repoDir, buildVersion);

        const builder = new WindowsBuilder(
            repoDir,
            target,
            this.winVmName,
            this.winUsername,
            this.winPassword,
            this.riotSigningKeyContainer,
            logger,
        );

        logger.info("Starting Windows builder for " + target.id + '...');
        await builder.start();
        logger.info("...builder started");

        try {
            builder.appendScript('rd', buildDirName, '/s', '/q');
            builder.appendScript('git', 'clone', DESKTOP_GIT_REPO, buildDirName);
            builder.appendScript('cd', buildDirName);
            builder.appendScript('copy', 'z:\\' + ELECTRON_BUILDER_CFG_FILE, ELECTRON_BUILDER_CFG_FILE);
            builder.appendScript('call', 'yarn', 'install');
            builder.appendScript('call', 'yarn', 'run', 'hak', 'check', '--target', target.id);
            builder.appendScript('call', 'yarn', 'run', 'build:native', '--target', target.id);
            builder.appendScript('call', 'yarn', 'run', 'fetch', 'develop', '-d', 'element.io\\nightly');
            builder.appendScript(
                'call', 'yarn', 'build', `--${target.arch}`, '--config', ELECTRON_BUILDER_CFG_FILE,
            );
            builder.appendScript('xcopy dist z:\\dist /S /I /Y');
            builder.appendScript('cd', '..');
            builder.appendScript('rd', buildDirName, '/s', '/q');

            logger.info("Starting build...");
            await builder.runScript();
            logger.info("Build complete!");

            const squirrelDir = 'squirrel-windows' + (target.arch === 'ia32' ? '-ia32' : '');
            const archDir = target.arch;

            await fsProm.mkdir(path.join(this.appPubDir, 'install', 'win32', archDir), { recursive: true });
            await fsProm.mkdir(path.join(this.appPubDir, 'update', 'win32', archDir), { recursive: true });

            for (const f of await getMatchingFilesInDir(path.join(repoDir, 'dist', squirrelDir), /\.exe$/)) {
                await copyAndLog(
                    path.join(repoDir, 'dist', squirrelDir, f),
                    path.join(this.appPubDir, 'install', 'win32', archDir, 'Element Nightly Setup.exe'),
                    logger,
                );
            }
            for (const f of await getMatchingFilesInDir(path.join(repoDir, 'dist', squirrelDir), /\.nupkg$/)) {
                await copyAndLog(
                    path.join(repoDir, 'dist', squirrelDir, f),
                    path.join(this.appPubDir, 'update', 'win32', archDir, f),
                    logger,
                );
            }
            for (const f of await getMatchingFilesInDir(path.join(repoDir, 'dist', squirrelDir), /^RELEASES$/)) {
                await copyAndLog(
                    path.join(repoDir, 'dist', squirrelDir, f),
                    path.join(this.appPubDir, 'update', 'win32', archDir, f),
                    logger,
                );
            }

            // prune update packages (installers are overwritten each time)
            await pruneBuilds(path.join(this.appPubDir, 'update', 'win32', archDir), /\.nupkg$/, logger);
        } catch (e) {
            if (e instanceof LoggableError) {
                logger.file(e.log);
            }
        } finally {
            await builder.stop();
        }

        logger.info("Removing build dir");
        await rm(repoDir);
    }
}
