/*
Copyright 2022 New Vector Ltd

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

import * as childProcess from 'child_process';

import { LoggableError } from './logger';

export async function spawn(
    command: string,
    args: ReadonlyArray<string>,
    options: childProcess.SpawnOptions = {},
    captureLog = true,
): Promise<void> {
    return new Promise((resolve, reject) => {
        const proc = childProcess.spawn(command, args, {
            ...options,
            stdio: captureLog ? ["inherit", "pipe", "pipe"] : "inherit",
        });

        let log = `# Running command "${command} ${args.join(" ")}"\n`;
        console.log(log);

        if (captureLog) {
            proc.stdout.pipe(process.stdout);
            proc.stderr.pipe(process.stderr);

            proc.stdout.on('data', (chunk) => {
                log += chunk.toString();
            });
            proc.stderr.on('data', (chunk) => {
                log += chunk.toString();
            });
        }

        proc.on('exit', (code?: number) => {
            if (!code) {
                resolve();
                return;
            }

            log += "\nExit code: "+ code;
            reject(new LoggableError(code, log));
        });
    });
}
