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

import rootLogger, { LoggableError, Logger } from './logger';
import { setDebVersion, addDeb } from './debian';
import {
    getMatchingFilesInDir,
    copyAndLog,
    rm,
    updateSymlink,
    copyMatchingFiles,
    copyMatchingFile,
} from './artifacts';
import DesktopBuilder, { Options } from "./desktop_builder";

const ELECTRON_BUILDER_CFG_FILE = 'electron-builder.json';

export default class DesktopReleaseBuilder extends DesktopBuilder {
    private appPubDir = path.join(this.pubDir, 'desktop');
    private gnupgDir = path.join(process.cwd(), 'gnupg');

    constructor(options: Options, branch: string) {
        super(options, {
            // This will fetch the Element release from GitHub that matches the version in element-desktop's package.json.
            fetchArgs: ['-d', 'element.io/release'],
            dockerImage: "element-desktop-dockerbuild-release",
            branch,
        });
    }

    protected printInfo(): void {
        console.log("Warming up Release builder");
        if (this.options.fetchArgs?.includes("://")) {
            const url = this.fetchArgs.find(a => a.includes("://"));
            console.log(`This looks like a custom build using tarball url ${url}`);
        }
        super.printInfo();
    }

    public async startBuild(): Promise<void> {
        rootLogger.info(`Starting Element Desktop ${this.gitBranch} release builder...`);
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

        const toBuild = this.options.targets;
        if (toBuild.length === 0) return;

        try {
            this.building = true;

            for (const target of toBuild) {
                rootLogger.info(`Starting build of ${target.id} for ${this.gitBranch}`);
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

            await this.pushArtifacts(toBuild);
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
        const { repoDir } = await this.cloneRepo(target, this.gitBranch, logger);
        const buildVersion = JSON.parse(await fsProm.readFile(path.join(repoDir, 'package.json'), 'utf8')).version;

        await this.writeElectronBuilderConfigFile(target, repoDir, buildVersion);
        if (target.platform == 'linux') {
            await setDebVersion(
                buildVersion,
                this.options.debianVersion,
                path.join(repoDir, 'element.io', 'release', 'control.template'),
                path.join(repoDir, 'debcontrol'),
                logger,
            );
        }

        await this.copyGnupgDir(repoDir, logger);
        await this.buildWithRunner(target, repoDir, buildVersion, logger);

        if (target.platform === 'darwin') {
            const distPath = path.join(repoDir, 'dist');
            const targetInstallPath = path.join(this.appPubDir, 'install', 'macos');
            const targetUpdatePath = path.join(this.appPubDir, 'update', 'macos');

            await fsProm.mkdir(targetInstallPath, { recursive: true });
            await fsProm.mkdir(targetUpdatePath, { recursive: true });

            // Be consistent with windows and don't bother putting the version number in the installer
            await copyMatchingFile(distPath, targetInstallPath, /\.dmg$/, logger, 'Element.dmg');
            await copyMatchingFiles(distPath, targetUpdatePath, /-mac.zip$/, logger);

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

    private async buildWin(target: WindowsTarget, logger: Logger): Promise<void> {
        // We still check out the repo locally because we need package.json to write the electron builder config file,
        // so we check out the repo twice for windows: once locally and once on the VM...
        const { repoDir, buildDirName } = await this.cloneRepo(target, this.gitBranch, logger);

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
            builder.appendScript('git', 'clone', this.options.gitRepo, buildDirName, '-b', this.gitBranch);
            builder.appendScript('cd', buildDirName);
            builder.appendScript('copy', 'z:\\' + ELECTRON_BUILDER_CFG_FILE, ELECTRON_BUILDER_CFG_FILE);
            builder.appendScript('xcopy', 'z:\\gnupg', 'gnupg', '/S', '/I', '/Y');
            builder.appendScript('call', 'yarn', 'install');
            builder.appendScript('call', 'yarn', 'run', 'hak', 'check', '--target', target.id);
            builder.appendScript('call', 'yarn', 'run', 'build:native', '--target', target.id);
            // This will fetch the Element release from GitHub that matches the
            // version in element-desktop's package.json.
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

            await copyMatchingFile(squirrelPath, targetInstallPath, /\.exe$/, logger).then(f => (
                updateSymlink(f, path.join(targetInstallPath, 'Element Setup.exe'), logger)
            ));
            await copyMatchingFile(distPath, path.join(targetInstallPath, 'msi'), /\.msi$/, logger);
            await copyMatchingFiles(squirrelPath, targetUpdatePath, /\.nupkg$/, logger);
            await copyMatchingFiles(squirrelPath, targetUpdatePath, /^RELEASES$/, logger);
        } finally {
            await builder.stop();
        }

        logger.info("Removing build dir");
        await rm(repoDir);
    }
}
