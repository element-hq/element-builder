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
import { Target, WindowsTarget } from 'element-desktop/scripts/hak/target';

import GitRepo from './gitrepo';
import rootLogger, { LoggableError, Logger } from './logger';
import { IRunner } from './runner';
import { setDebVersion, addDeb } from './debian';
import { getMatchingFilesInDir, pushArtifacts, copyAndLog, rm } from './artifacts';
import DesktopBuilder, { DESKTOP_GIT_REPO, ELECTRON_BUILDER_CFG_FILE } from "./desktop_builder";

export default class DesktopReleaseBuilder extends DesktopBuilder {
    private appPubDir = path.join(this.pubDir, 'desktop');
    private gnupgDir = path.join(process.cwd(), 'gnupg');
    private building = false;

    constructor(
        targets: Target[],
        winVmName: string,
        winUsername: string,
        winPassword: string,
        rsyncRoot: string,
        private readonly desktopBranch: string,
    ) {
        super(targets, winVmName, winUsername, winPassword, rsyncRoot);
    }

    public async start(): Promise<void> {
        rootLogger.info(`Starting Element Desktop ${this.desktopBranch} release builder...`);
        const introLogger = rootLogger.threadLogger();
        this.building = false;

        try {
            await fsProm.stat(this.gnupgDir);
        } catch (e) {
            introLogger.error("No 'gnupg' directory found");
            introLogger.error(
                "This should be a separate gpg home directory that trusts the element release " +
                "public key (without any private keys) that will be passed into the builders to",
                "verify the package they download",
            );
            introLogger.error("You can create this by running:\n");
            introLogger.error(
                "> mkdir gnupg && curl -s https://packages.riot.im/element-release-key.asc | " +
                "gpg --homedir gnupg --import",
            );
            return;
        }

        introLogger.info("Using gnupg homedir " + this.gnupgDir);

        await this.loadSigningKeyContainer();

        if (this.building) return;

        const toBuild = this.targets;
        if (toBuild.length === 0) return;

        try {
            this.building = true;

            for (const target of toBuild) {
                rootLogger.info(`Starting build of ${target.id} for ${this.desktopBranch}`);
                const jobReactionLogger = rootLogger.reactionLogger();
                const logger = rootLogger.threadLogger();
                try {
                    await this.build(target, logger);
                    jobReactionLogger.info("✅ Done!");
                } catch (e) {
                    logger.error("Build failed!", e);
                    jobReactionLogger.info("🚨 Failed!");
                    // if one fails, bail out of the whole process: probably better
                    // to have all platforms not updating than just one

                    if (e instanceof LoggableError) {
                        logger.file(e.log);
                    }

                    return;
                }
            }

            rootLogger.info(`Built packages for: ${toBuild.map(t => t.id).join(', ')} : pushing packages...`);
            const reactionLogger = rootLogger.reactionLogger();
            await pushArtifacts(this.pubDir, this.rsyncRoot, rootLogger);
            reactionLogger.info("✅ Done!");
        } catch (e) {
            rootLogger.error("Artifact sync failed!", e);
            if (e instanceof LoggableError) {
                rootLogger.file(e.log);
            }
        } finally {
            this.building = false;
        }
    }

    private async copyGnupgDir(repoDir: string, logger: Logger) {
        const dest = path.join(repoDir, 'gnupg');
        // We copy rather than symlink so an individual builder can't
        // overwrite the cert used for all the other ones, however
        // a) node doesn't have a recursive copy and b) the gpg
        // home directory contains sockets which can't just be
        // copied, so just copy specific files.
        await fsProm.mkdir(dest);

        // XXX: The docker image we use has gnupg 1 so uses pubring.gpg rather than pubring.kbx.
        // If we use the old gpg format, that works with both.
        for (const f of ['pubring.gpg', 'trustdb.gpg']) {
            await copyAndLog(
                path.join(this.gnupgDir, f),
                path.join(dest, f),
                logger,
            );
        }
    }

    private async build(target: Target, logger: Logger): Promise<void> {
        if (target.platform === 'win32') {
            return this.buildWin(target as WindowsTarget, logger);
        } else {
            return this.buildLocal(target, logger);
        }
    }

    private async buildLocal(target: Target, logger: Logger): Promise<void> {
        await fsProm.mkdir('builds', { recursive: true });
        const repoDir = path.join('builds', 'element-desktop-' + target.id + '-' + this.desktopBranch);
        await rm(repoDir);
        logger.info("Cloning element-desktop into " + repoDir);
        const repo = new GitRepo(repoDir);
        // Clone element-desktop at tag / branch to build from, e.g. v1.6.0
        await repo.clone(DESKTOP_GIT_REPO, repoDir, '-b', this.desktopBranch);
        logger.info(`...checked out '${this.desktopBranch}' branch, starting build for ${target.id}`);

        const buildVersion = JSON.parse(await fsProm.readFile(path.join(repoDir, 'package.json'), 'utf8')).version;

        await this.writeElectronBuilderConfigFile(target, repoDir, buildVersion);
        if (target.platform == 'linux') {
            await setDebVersion(
                buildVersion,
                path.join(repoDir, 'element.io', 'release', 'control.template'),
                path.join(repoDir, 'debcontrol'),
                logger,
            );
        }

        await this.copyGnupgDir(repoDir, logger);

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
                    path.join(this.appPubDir, 'install', 'macos', f),
                    logger,
                );

                const latestInstallPath = path.join(this.appPubDir, 'install', 'macos', 'Element.dmg');
                logger.info('Update latest symlink ' + latestInstallPath + ' -> ' + f);
                try {
                    await fsProm.unlink(latestInstallPath);
                } catch (e) {
                    // probably just didn't exist
                    logger.info("Failed to remove latest symlink", e);
                }
                await fsProm.symlink(f, latestInstallPath, 'file');
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
            GNUPGHOME: 'gnupg',
        };
    }

    protected getDockerImageName(): string {
        return "element-desktop-dockerbuild-release";
    }

    protected fetchArgs(): string[] {
        // This will fetch the Element release from GitHub that matches the version in element-desktop's package.json.
        return ['-d', 'element.io/release'];
    }

    private async buildWin(target: WindowsTarget, logger: Logger): Promise<void> {
        await fsProm.mkdir('builds', { recursive: true });
        // Windows long paths (see desktop_develop.ts)
        //const buildDirName = 'element-desktop-' + target.id + '-' + this.desktopBranch;
        const buildDirName = 'ed' + target.arch + this.desktopBranch;
        const repoDir = path.join('builds', buildDirName);
        await rm(repoDir);

        // we still check out the repo locally because we need package.json
        // to write the electron builder config file, so we check out the
        // repo twice for windows: once locally and once on the VM...
        logger.info("Cloning element-desktop into " + repoDir);
        const repo = new GitRepo(repoDir);
        // Clone element-desktop at tag / branch to build from, e.g. v1.6.0
        await repo.clone(DESKTOP_GIT_REPO, repoDir, '-b', this.desktopBranch);
        logger.info(`...checked out '${this.desktopBranch}' branch, starting build for ${target.id}`);

        const buildVersion = JSON.parse(await fsProm.readFile(path.join(repoDir, 'package.json'), 'utf8')).version;

        await this.writeElectronBuilderConfigFile(target, repoDir, buildVersion);

        await this.copyGnupgDir(repoDir, logger);

        const builder = this.makeWindowsBuilder(repoDir, target, logger);

        logger.info("Starting Windows builder for " + target.id + '...');
        await builder.start();
        logger.info("...builder started");

        try {
            builder.appendScript('rd', buildDirName, '/s', '/q');
            // Clone element-desktop at tag / branch to build from, e.g. v1.6.0
            builder.appendScript('git', 'clone', DESKTOP_GIT_REPO, buildDirName, '-b', this.desktopBranch);
            builder.appendScript('cd', buildDirName);
            builder.appendScript('copy', 'z:\\' + ELECTRON_BUILDER_CFG_FILE, ELECTRON_BUILDER_CFG_FILE);
            builder.appendScript('xcopy', 'z:\\gnupg', 'gnupg', '/S', '/I', '/Y');
            builder.appendScript('call', 'yarn', 'install');
            builder.appendScript('call', 'yarn', 'run', 'hak', 'check', '--target', target.id);
            builder.appendScript('call', 'yarn', 'run', 'build:native', '--target', target.id);
            // This will fetch the Element release from GitHub that matches the
            // version in element-desktop's package.json.
            builder.appendScript('call', 'yarn', 'run', 'fetch', '-d', 'element.io\\release');
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
                    path.join(this.appPubDir, 'install', 'win32', archDir, f),
                    logger,
                );

                const latestInstallPath = path.join(this.appPubDir, 'install', 'win32', archDir, 'Element Setup.exe');
                logger.info('Update latest symlink ' + latestInstallPath + ' -> ' + f);
                await fsProm.unlink(latestInstallPath);
                await fsProm.symlink(f, latestInstallPath, 'file');
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
        } finally {
            await builder.stop();
        }

        logger.info("Removing build dir");
        await rm(repoDir);
    }
}
