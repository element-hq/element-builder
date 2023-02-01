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
import { Target, TargetId, WindowsTarget } from 'element-desktop/scripts/hak/target';

import rootLogger, { LoggableError, Logger } from './logger';
import WindowsBuilder from './windows_builder';
import { setDebVersion, addDeb } from './debian';
import { getMatchingFilesInDir, copyMatchingFiles, copyMatchingFile, rm } from './artifacts';
import DesktopBuilder, { ELECTRON_BUILDER_CFG_FILE, Options, Package, PackageBuild } from "./desktop_builder";

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

interface IBuild {
    time: number;
    number: number;
}

async function getLastBuild(target: Target, logger: Logger): Promise<IBuild> {
    try {
        return JSON.parse(await fsProm.readFile('desktop_develop_lastBuilt_' + target.id, 'utf8'));
    } catch (e) {
        logger.error(`Unable to read last build time for ${target.id}`, e);
        return {
            time: 0,
            number: 0,
        };
    }
}

async function putLastBuild(target: Target, build: IBuild, logger: Logger): Promise<void> {
    try {
        await fsProm.writeFile('desktop_develop_lastBuilt_' + target.id, JSON.stringify(build));
    } catch (e) {
        logger.error(`Unable to write last build time for ${target.id}`, e);
    }
}

function getBuildVersion(lastBuild: IBuild): [version: string, number: number] {
    // YYYYMMDDNN where NN is in case we need to do multiple versions in a day
    // NB. on windows, squirrel will try to parse the versiopn number parts,
    // including this string, into 32 bit integers, which is fine as long
    // as we only add two digits to the end...
    const now = new Date();
    const month = (now.getMonth() + 1).toString().padStart(2, '0');
    const date = now.getDate().toString().padStart(2, '0');
    let buildNum = 1;
    if (new Date(lastBuild.time).getDate().toString().padStart(2, '0') === date) {
        buildNum = lastBuild.number + 1;
    }

    return [now.getFullYear() + month + date + buildNum.toString().padStart(2, '0'), buildNum];
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

export default class DesktopDevelopBuilder extends DesktopBuilder {
    private appPubDir = path.join(this.pubDir, 'nightly');
    private lastBuildTimes: Partial<Record<TargetId, IBuild>> = {};
    private lastFailTimes: Partial<Record<TargetId, number>> = {};

    constructor(
        options: Options,
        private force = false,
    ) {
        super(options, {
            fetchArgs: ["develop", "-d", "element.io/nightly"],
            dockerImage: "element-desktop-dockerbuild-develop",
        });
    }

    protected printInfo(): void {
        console.log("Warming up Nightly builder");
        super.printInfo();
        if (this.force) {
            console.log("Forcing an extra Nightly build");
        }
        console.warn("This process will not exit, continuing to produce Nightly builds");
    }

    public async startBuild(): Promise<void> {
        rootLogger.info("Starting Element Desktop nightly builder...");
        const logger = rootLogger.threadLogger();
        this.building = false;

        await WindowsBuilder.setDonglePower(false);
        await this.loadSigningKeyContainer();

        this.lastBuildTimes = {};
        this.lastFailTimes = {};
        for (const target of this.options.targets) {
            this.lastBuildTimes[target.id] = await getLastBuild(target, logger);
            this.lastFailTimes[target.id] = 0;
        }

        setInterval(this.poll, 30 * 1000);
        await this.poll();
    }

    private poll = async (): Promise<void> => {
        if (this.building) return;

        const toBuild: Target[] = [];
        for (const target of this.options.targets) {
            const nextBuildDue = getNextBuildTime(new Date(Math.max(
                this.lastBuildTimes[target.id]!.time,
                this.lastFailTimes[target.id]!,
            )));
            //logger.debug("Next build due at " + nextBuildDue);
            if (this.force || (nextBuildDue.getTime() < Date.now())) {
                toBuild.push(target);
            }
        }
        this.force = false; // clear force flag

        if (toBuild.length === 0) return;

        try {
            this.building = true;

            for (const target of toBuild) {
                rootLogger.info("Starting build of " + target.id);
                const jobReactionLogger = rootLogger.reactionLogger();
                const logger = rootLogger.threadLogger();
                try {
                    const [thisBuildVersion, buildNumber] = getBuildVersion(this.lastBuildTimes[target.id]!);
                    await this.build(target, thisBuildVersion, logger);
                    this.lastBuildTimes[target.id]!.time = Date.now();
                    this.lastBuildTimes[target.id]!.number = buildNumber;
                    await putLastBuild(target, this.lastBuildTimes[target.id]!, logger);
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

            await this.pushArtifacts(toBuild);
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

    protected getElectronBuilderConfig(pkg: Package, target: Target, buildVersion: string): PackageBuild {
        // The windows packager relies on parsing this as semver, so we have to make it look like one.
        // This will give our update packages really stupid names, but we probably can't change that either
        // because squirrel windows parses them for the version too. We don't really care: nobody  sees them.
        // We just give the installer a static name, so you'll just see this in the 'about' dialog.
        // Turns out if you use 0.0.0 here it makes Squirrel windows crash, so we use 0.0.1.
        const version = target.platform === 'win32' ? '0.0.1-nightly.' + buildVersion : buildVersion;

        const cfg = super.getElectronBuilderConfig(pkg, target, buildVersion);
        return {
            ...cfg,
            // We override a lot of the metadata for the nightly build
            extraMetadata: {
                ...cfg.extraMetadata,
                productName: cfg.extraMetadata!.productName + " Nightly",
                name: "element-desktop-nightly",
                version,
            },
            linux: {
                ...cfg.linux,
                desktop: {
                    ...cfg.linux.desktop,
                    StartupWMClass: cfg.linux.desktop.StartupWMClass + "-nightly",
                },
            } 
            appId: "im.riot.nightly",
        };
    }

    private async build(target: Target, buildVersion: string, logger: Logger): Promise<void> {
        if (target.platform === 'win32') {
            return this.buildWin(target as WindowsTarget, buildVersion, logger);
        } else {
            return this.buildLocal(target, buildVersion, logger);
        }
    }

    private async buildLocal(target: Target, buildVersion: string, logger: Logger): Promise<void> {
        const { repoDir } = await this.cloneRepo(target, buildVersion, logger);

        await this.writeElectronBuilderConfigFile(target, repoDir, buildVersion);
        if (target.platform === 'linux') {
            await setDebVersion(
                buildVersion,
                this.options.debianVersion,
                path.join(repoDir, 'element.io', 'nightly', 'control.template'),
                path.join(repoDir, 'debcontrol'),
                logger,
            );
        }

        await this.buildWithRunner(target, repoDir, buildVersion, logger);

        if (target.platform === 'darwin') {
            const distPath = path.join(repoDir, 'dist');
            const targetInstallPath = path.join(this.appPubDir, 'install', 'macos');
            const targetUpdatePath = path.join(this.appPubDir, 'update', 'macos');

            await fsProm.mkdir(targetInstallPath, { recursive: true });
            await fsProm.mkdir(targetUpdatePath, { recursive: true });

            // Be consistent with windows and don't bother putting the version number in the installer
            await copyMatchingFile(distPath, targetInstallPath, /\.dmg$/, logger, 'Element Nightly.dmg');
            await copyMatchingFile(distPath, targetUpdatePath, /-mac.zip$/, logger).then(async f => {
                const updateUrl = `https://packages.element.io/nightly/update/macos/${encodeURIComponent(f)}`;
                await this.writeDarwinReleaseFile(targetUpdatePath, buildVersion, updateUrl);
            });

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

    protected getBuildEnv(): NodeJS.ProcessEnv {
        return {
            ...super.getBuildEnv(),
            // Develop build needs the buildkite api key to fetch the web build
            BUILDKITE_API_KEY: process.env['BUILDKITE_API_KEY'],
        };
    }

    private async buildWin(target: WindowsTarget, buildVersion: string, logger: Logger): Promise<void> {
        // We still check out the repo locally because we need package.json to write the electron builder config file,
        // so we check out the repo twice for windows: once locally and once on the VM...
        const { repoDir, buildDirName } = await this.cloneRepo(target, buildVersion, logger);

        await this.writeElectronBuilderConfigFile(target, repoDir, buildVersion);

        const builder = this.makeWindowsBuilder(repoDir, target, logger);

        logger.info("Starting Windows builder for " + target.id + '...');
        await builder.start();
        logger.info("...builder started");

        try {
            builder.appendScript('rd', buildDirName, '/s', '/q');
            builder.appendScript('git', 'clone', this.options.gitRepo, buildDirName);
            builder.appendScript('cd', buildDirName);
            builder.appendScript('copy', 'z:\\' + ELECTRON_BUILDER_CFG_FILE, ELECTRON_BUILDER_CFG_FILE);
            builder.appendScript('call', 'yarn', 'install');
            builder.appendScript('call', 'yarn', 'run', 'hak', 'check', '--target', target.id);
            builder.appendScript('call', 'yarn', 'run', 'build:native', '--target', target.id);
            const fetchArgs = this.fetchArgs.map(a => a.replace(/\//g, "\\"));
            builder.appendScript('call', 'yarn', 'run', 'fetch', ...fetchArgs);
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

            const distPath = path.join(repoDir, 'dist');
            const squirrelPath = path.join(distPath, squirrelDir);
            const targetInstallPath = path.join(this.appPubDir, 'install', 'win32', archDir);
            const targetUpdatePath = path.join(this.appPubDir, 'update', 'win32', archDir);

            await fsProm.mkdir(path.join(targetInstallPath, 'msi'), { recursive: true });
            await fsProm.mkdir(targetUpdatePath, { recursive: true });

            await copyMatchingFile(
                squirrelPath,
                targetInstallPath,
                /\.exe$/,
                logger,
                'Element Nightly Setup.exe',
            );
            await copyMatchingFile(
                distPath,
                path.join(targetInstallPath, 'msi'),
                /\.msi$/,
                logger,
                'Element Nightly Setup.msi',
            );
            await copyMatchingFiles(squirrelPath, targetUpdatePath, /\.nupkg$/, logger);
            await copyMatchingFiles(squirrelPath, targetUpdatePath, /^RELEASES$/, logger);

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
