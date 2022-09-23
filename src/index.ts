#!/usr/bin/env node

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

import { Target, TargetId, TARGETS } from 'element-desktop/scripts/hak/target';
import yargs from "yargs";
import path from "path";
import fs from "fs";

import logger from './logger';
import DesktopDevelopBuilder from './desktop_develop';
import DesktopReleaseBuilder from './desktop_release';
import DesktopBuilder, { Options } from "./desktop_builder";

if (process.env.RIOTBUILD_BASEURL && process.env.RIOTBUILD_ROOMID && process.env.RIOTBUILD_ACCESS_TOKEN) {
    console.log("Logging to console + Matrix");
    logger.setup(process.env.RIOTBUILD_BASEURL, process.env.RIOTBUILD_ROOMID, process.env.RIOTBUILD_ACCESS_TOKEN);
} else {
    console.log("No Matrix credentials in environment: logging to console only");
}

const winVmName = process.env.RIOTBUILD_WIN_VMNAME;
const winUsername = process.env.RIOTBUILD_WIN_USERNAME;
const winPassword = process.env.RIOTBUILD_WIN_PASSWORD;

const rsyncServer = process.env.RIOTBUILD_RSYNC_ROOT;

if (
    winVmName === undefined ||
    winUsername === undefined ||
    winPassword === undefined
) {
    console.error(
        "No windows credentials set: define RIOTBUILD_WIN_VMNAME, " +
        "RIOTBUILD_WIN_USERNAME and RIOTBUILD_WIN_PASSWORD",
    );
    process.exit(1);
}

if (rsyncServer === undefined) {
    console.error("rsync server not set: define RIOTBUILD_RSYNC_ROOT");
    process.exit(1);
}

const args = yargs(process.argv).version(false).options({
    "version": {
        alias: "v",
        type: "string",
        description: "Specifies the release version (branch/tag) to build",
        requiresArg: true,
        demandOption: false,
    },
    "force": {
        alias: "f",
        type: "boolean",
        description: "Force a build, currently only supported for Nightlies," +
            "creates a new one with an incremented version",
        conflicts: ["version"],
        requiresArg: false,
        demandOption: false,
    },
    "targets": {
        alias: "t",
        type: "array",
        description: "The list of targets to build, in rust platform id format",
        choices: Object.keys(TARGETS),
        requiresArg: true,
        demandOption: false,
        default: [
            // The set of targets we build by default, sorted by increasing complexity so
            // that we fail fast when the native host target fails.
            'universal-apple-darwin',
            'x86_64-unknown-linux-gnu',
            'x86_64-pc-windows-msvc',
            'i686-pc-windows-msvc',
        ],
    },
    "debian-version": {
        type: "string",
        description: "The debian-version override string to use",
        requiresArg: true,
        demandOption: false,
    },
    "git-repo": {
        type: "string",
        description: "The git URL to clone element-desktop from",
        default: "https://github.com/vector-im/element-desktop.git",
        requiresArg: true,
        demandOption: false,
    },
    "skip-rsync": {
        type: "boolean",
        description: "Whether to skip the rsync publishing step",
        requiresArg: false,
        demandOption: false,
    },
    "rsync-only": {
        type: "boolean",
        description: "",
        requiresArg: false,
        demandOption: false,
        conflicts: ["version", "force", "targets", "debian-version", "skip-rsync"],
    },
}).parseSync();

const lockFile = path.join(process.cwd(), "element-builder.lock");
if (fs.existsSync(lockFile)) {
    console.error("Lock file found, other instance likely already running!");
    process.exit(1);
}
process.on("beforeExit", () => {
    fs.rmSync(lockFile);
});
fs.writeFileSync(lockFile, process.pid?.toString());

const options: Options = {
    targets: args.targets.map(target => TARGETS[target as TargetId]) as Target[],
    debianVersion: args.debianVersion,
    winVmName,
    winUsername,
    winPassword,
    rsyncRoot: args.skipRsync ? undefined : rsyncServer,
    gitRepo: args.gitRepo,
};

let builder: DesktopBuilder;
if (args.version) {
    builder = new DesktopReleaseBuilder(options, args.version);
} else {
    builder = new DesktopDevelopBuilder(options, args.force);
}

if (args.rsyncOnly) {
    builder.syncArtifacts(logger);
} else {
    builder.start();
}
