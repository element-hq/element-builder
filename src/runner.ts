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

import { Logger } from "./logger";
import { spawn } from "./spawn";

export interface IRunner {
    setup(): Promise<void>;
    run(cmd: string, ...args: string[]): Promise<void>;
}

export default class Runner implements IRunner {
    private readonly env: NodeJS.ProcessEnv;

    constructor(
        private readonly cwd: string,
        private readonly logger: Logger,
        env: NodeJS.ProcessEnv = {},
    ) {
        this.env = {
            ...process.env,
            ...env,
        };
    }

    public async setup(): Promise<void> {
        // nothing to do
    }

    public run(cmd: string, ...args: string[]): Promise<void> {
        this.logger.info([cmd, ...args].join(' '));
        return spawn(cmd, args, {
            cwd: this.cwd,
            env: this.env,
        });
    }
}
