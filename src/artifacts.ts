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

import { promises as fsProm } from 'fs';
import path from "path";
import rimraf from 'rimraf';

import { Logger } from './logger';
import { spawn } from "./spawn";
import { Options } from "./desktop_builder";

export async function getMatchingFilesInDir(dir: string, exp: RegExp): Promise<string[]> {
    const ret: string[] = [];
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

export async function syncArtifacts(pubDir: string, options: Options, logger: Logger): Promise<void> {
    logger.info("Syncing artifacts...");

    if (options.rsyncRoot) {
        await spawn('rsync', [
            '-av', '--delete', '--delay-updates', `${pubDir}/`, options.rsyncRoot + 'packages.riot.im',
        ]);
    }

    if (options.s3Bucket) {
        const args = [
            's3', 'sync', `${pubDir}/`, `s3://${options.s3Bucket}/`, '--delete', '--region=auto',
        ];
        if (options.s3EndpointUrl) {
            args.push('--endpoint-url', options.s3EndpointUrl);
        }
        await spawn('aws', args);
    }
}

export function copyAndLog(src: string, dest: string, logger: Logger): Promise<void> {
    logger.info('Copy ' + src + ' -> ' + dest);
    return fsProm.copyFile(src, dest);
}

export async function copyMatchingFile(
    sourceDir: string,
    targetDir: string,
    exp: RegExp,
    logger: Logger,
    overrideFileName?: string,
): Promise<string> {
    const matches = await getMatchingFilesInDir(sourceDir, exp);
    if (matches.length !== 1) {
        throw new Error("Expected 1 file, found " + matches.length);
    }

    await copyAndLog(
        path.join(sourceDir, matches[0]),
        path.join(targetDir, overrideFileName ?? matches[0]),
        logger,
    );
    return matches[0];
}

export async function copyMatchingFiles(
    sourceDir: string,
    targetDir: string,
    exp: RegExp,
    logger: Logger,
): Promise<void> {
    const files = await getMatchingFilesInDir(sourceDir, exp);
    await Promise.all(files.map(f => copyAndLog(path.join(sourceDir, f), path.join(targetDir, f), logger)));
}

export function rm(path: string): Promise<void> {
    return new Promise((resolve, reject) => {
        rimraf(path, (err) => {
            err ? reject(err) : resolve();
        });
    });
}

export async function updateSymlink(target: string, symlink: string, logger: Logger): Promise<void> {
    logger.info(`Update latest symlink ${symlink} -> ${target}`);
    try {
        await fsProm.unlink(symlink);
    } catch (e) {
        // probably just didn't exist
        logger.info("Failed to remove latest symlink", e);
    }
    await fsProm.symlink(target, symlink, 'file');
}
