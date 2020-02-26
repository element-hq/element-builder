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

const https = require('https');

let mxAccessToken;
let mxRoomId;

function setup(accessToken, roomId) {
    mxAccessToken = accessToken;
    mxRoomId = roomId;
}

function error(...args) {
    return log('error', ...args);
}

function warn(...args) {
    return log('warn', ...args);
}

function info(...args) {
    return log('info', ...args);
}

function debug(...args) {
    return log('debug', ...args);
}

async function log(level, ...args) {
    console[level](...args);
}

module.exports = {setup, error, warn, info, debug};
