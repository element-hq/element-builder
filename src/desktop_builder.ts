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
import { Target, UniversalTarget, WindowsTarget } from "element-desktop/scripts/hak/target";

import { Logger } from "./logger";
import Runner, { IRunner } from "./runner";
import DockerRunner from "./docker_runner";
import WindowsBuilder from "./windows_builder";
import getSecret from "./get_secret";
import { rm } from "./artifacts";
import GitRepo from "./gitrepo";

export const DESKTOP_GIT_REPO = 'https://github.com/vector-im/element-desktop.git';
export const ELECTRON_BUILDER_CFG_FILE = 'electron-builder.json';

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

export default abstract class DesktopBuilder {
    protected readonly pubDir = path.join(process.cwd(), 'packages.riot.im');
    // This should be a reprepro dir with a config redirecting  the output to pub/debian
    protected readonly debDir = path.join(process.cwd(), 'debian');
    protected signingKeyContainer: string;
    protected building = false;

    constructor(
        protected readonly targets: Target[],
        protected readonly winVmName: string,
        protected readonly winUsername: string,
        protected readonly winPassword: string,
        protected readonly rsyncRoot: string,
    ) { }

    public abstract start(): Promise<void>;

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

    protected getDockerImageName(): string {
        return "element-desktop-dockerbuild";
    }

    protected makeMacRunner(cwd: string, logger: Logger): IRunner {
        return new Runner(cwd, logger, this.getBuildEnv());
    }

    protected makeLinuxRunner(cwd: string, logger: Logger): IRunner {
        const wrapper = path.join('scripts', 'in-docker.sh');
        return new DockerRunner(cwd, wrapper, this.getDockerImageName(), logger, this.getBuildEnv());
    }

    protected makeWindowsBuilder(repoDir: string, target: WindowsTarget, logger: Logger): WindowsBuilder {
        return new WindowsBuilder(
            repoDir,
            target,
            this.winVmName,
            this.winUsername,
            this.winPassword,
            this.signingKeyContainer,
            logger,
            this.getBuildEnv(),
        );
    }

    protected getProductName(pkg: Package): string {
        return pkg.productName;
    }

    protected getElectronBuilderConfig(
        pkg: Package,
        target: Target,
        buildVersion: string,
    ): PackageBuild {
        return {
            ...pkg.build,
            extraMetadata: {
                productName: this.getProductName(pkg),
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
            cfg.extraMetadata.productName = cfg.extraMetadata.productName.replace(/ /g, "-");
        }

        await fsProm.writeFile(
            path.join(repoDir, ELECTRON_BUILDER_CFG_FILE),
            JSON.stringify(cfg, null, 4),
        );
    }

    protected abstract fetchArgs(): string[];

    protected async buildWithRunner(
        runner: IRunner,
        buildVersion: string,
        target: Target,
    ): Promise<void> {
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
        await runner.run('yarn', 'run', 'fetch', ...this.fetchArgs());
        await runner.run('yarn', 'build', `--${target.arch}`, '--config', ELECTRON_BUILDER_CFG_FILE);
    }

    protected async cloneRepo(target: Target, buildVersion: string, logger: Logger, branch = "develop"): Promise<{
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
        await repo.clone(DESKTOP_GIT_REPO, repoDir, "-b", branch);
        logger.info(`...checked out '${branch}' branch, starting build for ${target.id}`);

        return {
            repo,
            repoDir,
            buildDirName,
        };
    }
}

