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

import * as childProcess from 'child_process';

export default class GitRepo {
    constructor(path) {
        this.path = path;
    }

    fetch() {
        return this.gitCmd('fetch');
    }

    clone(...args) {
        return new Promise((resolve, reject) => {
            childProcess.execFile('git', ['clone', ...args], {}, (err, stdout) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(stdout.trim());
                }
            });
        });
    }

    checkout(...args) {
        return this.gitCmd('checkout', ...args);
    }

    getHeadRev() {
        return this.gitCmd('rev-parse', 'HEAD');
    }

    gitCmd(cmd, ...args) {
        return new Promise((resolve, reject) => {
            childProcess.execFile('git', [cmd, ...args], {
                cwd: this.path,
            }, (err, stdout) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(stdout.trim());
                }
            });
        });
    }
}
