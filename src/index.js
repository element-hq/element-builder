#!/usr/bin/env node

/*
Copyright 2020 The Matrix.org Foundation C.I.C.

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

const logger = require('./logger');
const DesktopDevelopBuilder = require('./desktop_develop');

if (process.env.RIOTBUILD_BASEURL && process.env.RIOTBUILD_ROOMID && process.env.RIOTBUILD_ACCESS_TOKEN) {
    console.log("Logging to console + Matrix");
    logger.setup(process.env.RIOTBUILD_BASEURL, process.env.RIOTBUILD_ROOMID, process.env.RIOTBUILD_ACCESS_TOKEN);
} else {
    console.log("No Matrix credentials in environment: logging to console only");
}

const winVmName = process.env.RIOTBUILD_WIN_VMNAME;
const winUsername = process.env.RIOTBUILD_WIN_USERNAME;
const winPassword = process.env.RIOTBUILD_WIN_PASSWORD;

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

const desktopDevelopBuilder = new DesktopDevelopBuilder(winVmName, winUsername, winPassword);
desktopDevelopBuilder.start();
