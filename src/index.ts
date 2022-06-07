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

import { Target, TARGETS } from 'element-desktop/scripts/hak/target';

import logger from './logger';
import DesktopDevelopBuilder from './desktop_develop';
import DesktopReleaseBuilder from './desktop_release';
import DesktopBuilder from "./desktop_builder";

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

// For a release build, this is the tag / branch of element-desktop to build from.
let desktopBranch: string = null;

while (process.argv.length > 2) {
    switch (process.argv[2]) {
        case '--version':
        case '-v':
            process.argv.shift();
            desktopBranch = process.argv[2];
            break;
        default:
            console.error(`Unknown option ${process.argv[2]}`);
            process.exit(1);
    }
    process.argv.shift();
}

// The set of targets we build by default, sorted by increasing complexity so
// that we fail fast when the native host target fails.
const targets: Target[] = [
    TARGETS['universal-apple-darwin'],
    TARGETS['x86_64-unknown-linux-gnu'],
    TARGETS['x86_64-pc-windows-msvc'],
    TARGETS['i686-pc-windows-msvc'],
];

let builder: DesktopBuilder;
if (desktopBranch) {
    builder = new DesktopReleaseBuilder(targets, winVmName, winUsername, winPassword, rsyncServer, desktopBranch);
} else {
    builder = new DesktopDevelopBuilder(targets, winVmName, winUsername, winPassword, rsyncServer);
}
builder.start();
