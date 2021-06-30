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
import * as path from 'path';

import logger from './logger';

async function getRepoTargets(repoDir: string): Promise<string[]> {
    const confDistributions = await fsProm.readFile(path.join(repoDir, 'conf', 'distributions'), 'utf8');
    const ret = [];
    for (const line of confDistributions.split('\n')) {
        if (line.startsWith('Codename')) {
            ret.push(line.split(': ')[1]);
        }
    }
    return ret;
}

export async function setDebVersion(ver: string, templateFile: string, outFile: string): Promise<void> {
    // Create a debian package control file with the version.
    // We use a custom control file so we need to do this ourselves
    let contents = await fsProm.readFile(templateFile, 'utf8');
    contents += 'Version: ' + ver + "\n";
    await fsProm.writeFile(outFile, contents);

    logger.info("Version set to " + ver);
}

export function pullDebDatabase(debDir: string, rsyncRoot: string): Promise<void> {
    logger.info("Pulling debian database...", rsyncRoot + 'debian/', debDir);
    return new Promise((resolve, reject) => {
        const proc = childProcess.spawn('rsync', [
            '-av', '--delete', rsyncRoot + 'debian/', debDir,
        ], {
            stdio: 'inherit',
        });
        proc.on('exit', code => {
            code ? reject(code) : resolve();
        });
    });
}

export function pushDebDatabase(debDir: string, rsyncRoot: string): Promise<void> {
    logger.info("Pushing debian database...");
    return new Promise((resolve, reject) => {
        const proc = childProcess.spawn('rsync', [
            '-av', '--delete', debDir + '/', rsyncRoot + 'debian',
        ], {
            stdio: 'inherit',
        });
        proc.on('exit', code => {
            code ? reject(code) : resolve();
        });
    });
}

export async function addDeb(debDir: string, deb: string): Promise<void> {
    const targets = await getRepoTargets(debDir);
    logger.info("Adding " + deb + " for " + targets.join(', ') + "...");
    for (const target of targets) {
        await new Promise<void>((resolve, reject) => {
            const proc = childProcess.spawn('reprepro', [
                'includedeb', target, deb,
            ], {
                stdio: 'inherit',
                cwd: debDir,
            });
            proc.on('exit', code => {
                code ? reject(code) : resolve();
            });
        });
    }
}
