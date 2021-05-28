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

let baseUrl;
let mxAccessToken;
let mxRoomId;

function setup(matrixServer, roomId, accessToken) {
    baseUrl = matrixServer;
    mxRoomId = roomId;
    mxAccessToken = accessToken;
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

    if (baseUrl === undefined) return;

    // log to matrix in the simplest possible way: If it fails, forget it and we lose
    // the log message, and we wait while it completes, so if the server is slow, the
    // build goes slower.
    const ev = {
        msgtype: 'm.notice',
        body: args[0],
    };
    const evData = JSON.stringify(ev);

    const url = baseUrl + "/_matrix/client/r0/rooms/" + encodeURIComponent(mxRoomId) + "/send/m.room.message";
    return new Promise((resolve) => {
        const req = https.request(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + mxAccessToken,
            },
        }, (res) => {
            res.on('end', resolve);
        });
        // Set an error handler even though it's ignored to avoid Node exiting
        // on unhandled errors.
        req.on('error', e => {
            // just ignore for now
        });
        req.write(evData);
        req.end();
    });
}

module.exports = { setup, error, warn, info, debug };
