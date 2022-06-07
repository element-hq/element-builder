/*
Copyright 2020-2022 The Matrix.org Foundation C.I.C.

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

import * as path from 'path';
import { Target } from "element-desktop/scripts/hak/target";

export const DESKTOP_GIT_REPO = 'https://github.com/vector-im/element-desktop.git';
export const ELECTRON_BUILDER_CFG_FILE = 'electron-builder.json';

export default abstract class DesktopBuilder {
    protected readonly pubDir = path.join(process.cwd(), 'packages.riot.im');
    // This should be a reprepro dir with a config redirecting  the output to pub/debian
    protected readonly debDir = path.join(process.cwd(), 'debian');

    constructor(
        protected readonly targets: Target[],
        protected readonly winVmName: string,
        protected readonly winUsername: string,
        protected readonly winPassword: string,
        protected readonly rsyncRoot: string,
    ) { }
}

