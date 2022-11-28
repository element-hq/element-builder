/*
Copyright 2020-2022 The Matrix.org Foundation C.I.C.

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
import * as readline from "readline";
import { Target, UniversalTarget, WindowsTarget } from "element-desktop/scripts/hak/target";

import rootLogger, { Logger } from "./logger";
import Runner, { IRunner } from "./runner";
import DockerRunner from "./docker_runner";
import WindowsBuilder from "./windows_builder";
import getSecret from "./get_secret";
import { syncArtifacts, rm } from "./artifacts";
import GitRepo from "./gitrepo";

export const ELECTRON_BUILDER_CFG_FILE = 'electron-builder.json';
const SQUIRREL_MAC_RELEASE_JSON = "releases.json";
const SQUIRREL_MAC_LEGACY_JSON = "releases-legacy.json";

interface File {
    from: string;
    to: string;
}

export interface PackageBuild {
    appId: string;
    asarUnpack: string;
    files: Array<string | File>;
    extraResources: Array<string | File>;
    linux: {
        target: string;
        category: string;
        maintainer: string;
        desktop: {
            StartupWMClass: string;
        };
    };
    mac: {
        category: string;
        darkModeSupport: boolean;
    };
    win: {
        target: {
            target: string;
        };
        sign: string;
    };
    deb?: {
        fpm?: string[];
    };
    directories: {
        output: string;
    };
    afterPack: string;
    afterSign: string;
    protocols: Array<{
        name: string;
        schemes: string[];
    }>;
    extraMetadata?: {
        productName?: string;
        name?: string;
        version?: string;
    };
}

export interface Package {
    build: PackageBuild;
    productName: string;
}

export interface Options {
    targets: Target[];
    debianVersion?: string;
    winVmName: string;
    winUsername: string;
    winPassword: string;
    rsyncRoot?: string;
    s3Bucket?: string;
    s3EndpointUrl?: string;
    gitRepo: string;
}

export interface BuildConfig {
    fetchArgs: string[];
    dockerImage?: string;
    branch?: string;
}

export default abstract class DesktopBuilder {
    protected readonly pubDir = path.join(process.cwd(), 'packages.riot.im');
    // This should be a reprepro dir with a config redirecting  the output to pub/debian
    protected readonly debDir = path.join(process.cwd(), 'debian');
    protected signingKeyContainer?: string;
    protected building = false;
    protected readonly fetchArgs: string[];
    protected readonly dockerImage: string;
    protected readonly gitBranch: string;

    protected constructor(
        protected readonly options: Options,
        buildConfig: BuildConfig,
    ) {
        this.dockerImage = buildConfig.dockerImage ?? "element-desktop-dockerbuild";
        this.fetchArgs = buildConfig.fetchArgs;
        this.gitBranch = buildConfig.branch ?? "develop";
    }

    protected printInfo(): void {
        console.log(`Using ${this.options.gitRepo} on branch ${this.gitBranch}`);
        console.log(`Using fetch args: ${this.fetchArgs.join(" ")}`);
        console.log(`Using docker image '${this.dockerImage}'`);

        if (this.options.debianVersion) {
            console.log(`Overriding debian version with ${this.options.debianVersion}`);
        }

        console.log("Building these targets: ");
        this.options.targets.forEach(target => {
            console.log("\t" + target.id);
        });

        if (!this.options.rsyncRoot && !this.options.s3Bucket) {
            console.log("Syncing artifacts has been disabled");
        }
        if (this.options.rsyncRoot) {
            console.log(`Syncing artifacts to ${this.options.rsyncRoot}`);
        }
        if (this.options.s3Bucket) {
            console.log(`Syncing artifacts to s3://${this.options.s3Bucket}`);
        }
    }

    protected abstract startBuild(): Promise<void>;

    public async start(): Promise<void> {
        console.log("");
        await this.printInfo();
        console.log("");

        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
        });

        await new Promise(resolve => rl.question("Press any key to continue...", resolve));
        rl.close();

        await this.startBuild();
    }

    protected async loadSigningKeyContainer() {
        // get the token passphrase now so
        //   a) we fail early if it's not in the keychain
        //   b) we know the keychain is unlocked because someone's sitting at the computer to start the builder.
        // NB. We supply the passphrase via a barely-documented feature of signtool
        // where it can parse it out of the name of the key container, so this
        // is actually the key container in the format [{{passphrase}}]=container
        this.signingKeyContainer = await getSecret('riot_key_container');
    }

    protected getBuildEnv(): NodeJS.ProcessEnv {
        return {};
    }

    protected makeMacRunner(cwd: string, logger: Logger): IRunner {
        return new Runner(cwd, logger, this.getBuildEnv());
    }

    protected makeLinuxRunner(cwd: string, logger: Logger): IRunner {
        const wrapper = path.join('scripts', 'in-docker.sh');
        return new DockerRunner(cwd, wrapper, this.dockerImage, logger, this.getBuildEnv());
    }

    protected makeWindowsBuilder(repoDir: string, target: WindowsTarget, logger: Logger): WindowsBuilder {
        return new WindowsBuilder(
            repoDir,
            target,
            this.options.winVmName,
            this.options.winUsername,
            this.options.winPassword,
            this.signingKeyContainer!,
            logger,
            this.getBuildEnv(),
        );
    }

    protected getElectronBuilderConfig(
        pkg: Package,
        target: Target,
        buildVersion: string,
    ): PackageBuild {
        return {
            ...pkg.build,
            extraMetadata: {
                productName: pkg.productName,
            },
            deb: {
                fpm: ["--deb-custom-control=debcontrol"],
            },
        };
    }

    protected async writeElectronBuilderConfigFile(
        target: Target,
        repoDir: string,
        buildVersion: string,
    ): Promise<void> {
        // Electron builder doesn't overlay with the config in package.json, so load it here
        const pkg: Package = JSON.parse(await fsProm.readFile(path.join(repoDir, 'package.json'), 'utf8'));

        const cfg = this.getElectronBuilderConfig(pkg, target, buildVersion);
        if (target.platform === "linux") {
            // Electron crashes on debian if there's a space in the path.
            // https://github.com/vector-im/element-web/issues/13171
            cfg.extraMetadata!.productName = cfg.extraMetadata!.productName!.replace(/ /g, "-");
        }

        await fsProm.writeFile(
            path.join(repoDir, ELECTRON_BUILDER_CFG_FILE),
            JSON.stringify(cfg, null, 4),
        );
    }

    protected async writeDarwinReleaseFile(updatePath: string, version: string, url: string): Promise<void> {
        await fsProm.writeFile(
            path.join(updatePath, SQUIRREL_MAC_RELEASE_JSON),
            JSON.stringify({
                currentRelease: version,
                releases: [{
                    version,
                    updateTo: {
                        version,
                        url,
                    },
                }],
            }, null, 4),
        );
        await fsProm.writeFile(
            path.join(updatePath, SQUIRREL_MAC_LEGACY_JSON),
            JSON.stringify({ url }, null, 4),
        );
    }

    protected async buildWithRunner(
        target: Target,
        repoDir: string,
        buildVersion: string,
        logger: Logger,
    ): Promise<void> {
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

        await runner.run('yarn', 'install');
        if (target.arch == 'universal') {
            const subtargets = (target as UniversalTarget).subtargets;
            for (const subTarget of subtargets) {
                await runner.run('yarn', 'run', 'hak', 'check', '--target', subTarget.id);
            }
            for (const subTarget of subtargets) {
                await runner.run('yarn', 'run', 'build:native', '--target', subTarget.id);
            }
            const targetArgs = [];
            for (const st of subtargets) {
                targetArgs.push('--target');
                targetArgs.push(st.id);
            }
            await runner.run('yarn', 'run', 'hak', 'copy', ...targetArgs);
        } else {
            await runner.run('yarn', 'run', 'hak', 'check', '--target', target.id);
            await runner.run('yarn', 'run', 'build:native', '--target', target.id);
        }
        await runner.run('yarn', 'run', 'fetch', ...this.fetchArgs);
        await runner.run('yarn', 'build', `--${target.arch}`, '--config', ELECTRON_BUILDER_CFG_FILE);

        logger.info("Build completed!");
    }

    protected async cloneRepo(target: Target, buildVersion: string, logger: Logger): Promise<{
        buildDirName: string;
        repoDir: string;
        repo: GitRepo;
    }> {
        await fsProm.mkdir('builds', { recursive: true });

        let buildDirName = `element-desktop-${target.id}-${buildVersion}`;
        if (target.platform === "win32") {
            // We're now running into Window's 260 character path limit. Adding a step of 'faff about in the registry
            // enabling NTFS long paths' to the list of things to do when setting up a build box seems undesirable:
            // this is an easy place to save some characters: abbreviate element-desktop, omit the hyphens and just use
            // the arch (because, at least at the moment, the only vaguely supported variations on Windows is the arch).
            buildDirName = `ed${target.arch}${buildVersion}`;
        }

        const repoDir = path.join('builds', buildDirName);
        await rm(repoDir);
        logger.info("Cloning element-desktop into " + repoDir);

        const repo = new GitRepo(repoDir);
        await repo.clone(this.options.gitRepo, repoDir, "-b", this.gitBranch);
        logger.info(`...checked out '${this.gitBranch}' branch, starting build for ${target.id}`);

        return { repo, repoDir, buildDirName };
    }

    protected async pushArtifacts(targets: Target[]): Promise<void> {
        if (this.options.rsyncRoot || this.options.s3Bucket) {
            rootLogger.info(`Built packages for: ${targets.map(t => t.id).join(', ')} : pushing packages...`);
            const reactionLogger = rootLogger.reactionLogger();
            await this.syncArtifacts(rootLogger.threadLogger());
            reactionLogger.info("✅ Done!");
        } else {
            rootLogger.info(`Built packages for: ${targets.map(t => t.id).join(', ')} : not syncing packages.`);
        }
    }

    public async syncArtifacts(logger: Logger): Promise<void> {
        await syncArtifacts(this.pubDir, this.options, logger);
    }
}

