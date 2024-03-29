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

import { IRunner } from './runner';
import { Logger } from "./logger";
import { spawn } from "./spawn";

/**
 * Actually this isn't really a Docker runner: all the docker logic is
 * handled by the in-docker script which is passed in, but for now it's
 * probably least confusing to name it after the thing we use it for.
 */
export default class DockerRunner implements IRunner {
    private readonly env: NodeJS.ProcessEnv;

    constructor(
        private readonly cwd: string,
        private readonly wrapper: string,
        private readonly imageName: string,
        private readonly logger: Logger,
        env: NodeJS.ProcessEnv = {},
    ) {
        this.env = {
            ...process.env,
            DOCKER_IMAGE_NAME: imageName,
        };
        // Prefix any env vars passed with INDOCKER_ for the in-docker.sh script to forward them
        Object.keys(env).forEach(k => {
            this.env["INDOCKER_" + k] = env[k];
        });
    }

    public async setup(): Promise<void> {
        this.logger.info("Updating Docker image");
        // Based on element-desktop yarn docker:setup but with a custom image name
        return spawn("docker", [
            "build",
            "-t", this.imageName,
            "dockerbuild",
        ], {
            cwd: this.cwd,
            env: this.env,
        });
    }

    public run(cmd: string, ...args: string[]): Promise<void> {
        this.logger.info([cmd, ...args].join(' '));
        return spawn(this.wrapper, [cmd].concat(...args), {
            cwd: this.cwd,
            env: this.env,
        });
    }
}
