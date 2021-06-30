/*
Copyright 2021 New Vector Ltd

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
import { promises as fsProm } from 'fs';

import * as rimraf from 'rimraf';

import logger from './logger';

export async function getMatchingFilesInDir(dir: string, exp: RegExp): Promise<string[]> {
    const ret = [];
    for (const f of await fsProm.readdir(dir)) {
        if (exp.test(f)) {
            ret.push(f);
        }
    }
    if (ret.length === 0) {
        throw new Error("No files found matching " + exp.toString() + "!");
    }
    return ret;
}

export function pullArtifacts(pubDir: string, rsyncRoot: string): Promise<void> {
    logger.info("Pulling artifacts...");
    return new Promise((resolve, reject) => {
        const proc = childProcess.spawn('rsync', [
            // NB. We don't pass --delete here so if we want to delete any files from the packaging server,
            // we need to do so by deleting them on the build box copy and then letting the delete sync
            // over, rather than deleting directly on the server, else they'll just sync back again.
            // This is because we copy built artifacts directly into our copy of the repo after each
            // one is built, so if a build fails, we'd delete the built artifact when we pulled the
            // artifacts at next startup.
            '-av', rsyncRoot + 'packages.riot.im/', pubDir,
        ], {
            stdio: 'inherit',
        });
        proc.on('exit', code => {
            code ? reject(code) : resolve();
        });
    });
}

export function pushArtifacts(pubDir: string, rsyncRoot: string): Promise<void> {
    logger.info("Uploading artifacts...");
    return new Promise((resolve, reject) => {
        const proc = childProcess.spawn('rsync', [
            '-av', '--delete', '--delay-updates', pubDir + '/', rsyncRoot + 'packages.riot.im',
        ], {
            stdio: 'inherit',
        });
        proc.on('exit', code => {
            code ? reject(code) : resolve();
        });
    });
}

export function copyAndLog(src: string, dest: string): Promise<void> {
    logger.info('Copy ' + src + ' -> ' + dest);
    return fsProm.copyFile(src, dest);
}

export function rm(path: string): Promise<void> {
    return new Promise((resolve, reject) => {
        rimraf(path, (err) => {
            err ? reject(err) : resolve();
        });
    });
}
