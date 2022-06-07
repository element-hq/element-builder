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
import { Target, WindowsTarget } from "element-desktop/scripts/hak/target";

import { Logger } from "./logger";
import Runner, { IRunner } from "./runner";
import DockerRunner from "./docker_runner";
import WindowsBuilder from "./windows_builder";
import getSecret from "./get_secret";

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

    constructor(
        protected readonly targets: Target[],
        protected readonly winVmName: string,
        protected readonly winUsername: string,
        protected readonly winPassword: string,
        protected readonly rsyncRoot: string,
    ) { }

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
        const pkg = JSON.parse(await fsProm.readFile(path.join(repoDir, 'package.json'), 'utf8'));

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
}

