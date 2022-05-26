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

import * as path from 'path';
import { promises as fsProm } from 'fs';
import * as childProcess from 'child_process';
import { WindowsTarget } from 'element-desktop/scripts/hak/target';

import { Logger } from "./logger";
import { spawn } from "./spawn";

const STARTVM_TIMEOUT = 90 * 1000;
const POWEROFF_TIMEOUT = 20 * 1000;

// You could install Visual Studio to a different location but not worrying about
// that for now.
const VCVARSALL = (
    'C:\\Program Files (x86)\\Microsoft Visual Studio\\2019\\BuildTools\\VC\\Auxiliary\\Build\\vcvarsall.bat'
);

/*
 * Windows builder doesn't fit the pattern of the Mac & Linux as we can't check out
 * the source ourselves and then run some commands to build it in Windows: the build
 * fails with I/O errors if you try to build on a shared drive (plus running a command
 * takes quite a long time).
 */
export default class WindowsBuilder {
    private script = "";

    constructor(
        private cwd: string,
        private target: WindowsTarget,
        private vmName: string,
        private username: string,
        private password: string,
        private keyContainer: string,
        private readonly logger: Logger,
        private readonly env: NodeJS.ProcessEnv = {},
    ) {}

    public async start(): Promise<void> {
        await WindowsBuilder.setDonglePower(false);

        const isRunning = await this.isRunning();
        if (isRunning) {
            console.log("VM currently running: stopping");
            await this.stop();
        }

        // virtualbox isn't very good at making sure the VM is actually
        // stopped and unlocked before the manage process exits, so
        // fix it with sleeps...
        await new Promise(resolve => setTimeout(resolve, 2000));

        console.log("Resetting to snapshot...");
        await this.vboxManage('snapshot', this.vmName, 'restorecurrent');
        console.log("Snapshot restored.");

        this.logger.info("Starting VM: " + this.vmName);
        await this.vboxManage('startvm', this.vmName);
        await new Promise(resolve => setTimeout(resolve, 5000));
        const waitUntil = Date.now() + STARTVM_TIMEOUT;
        let success = false;
        while (!success && Date.now() < waitUntil) {
            success = await this.pingVm();
            if (success) break;
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
        if (!success) {
            throw new Error("Failed to start VM: " + this.vmName);
        }
        await this.mapBuildDir();
        await WindowsBuilder.setDonglePower(true);
    }

    private async pingVm(): Promise<boolean> {
        try {
            await this.run('ping -n 1 127.0.0.1');
            return true;
        } catch (e) {
            return false;
        }
    }

    private async mapBuildDir(): Promise<void> {
        await this.vboxManage(
            'sharedfolder', 'add',
            this.vmName,
            '--hostpath', path.resolve(this.cwd),
            '--name', 'builddir',
            '--transient',
        );

        let attempts = 0;
        while (attempts < 5) {
            try {
                attempts++;
                try {
                    await this.run('net use z: /delete /y');
                } catch (e) {
                }
                await this.run('net use z: \\\\vboxsvr\\builddir /y');
                await new Promise(resolve => setTimeout(resolve, 4000));
                await this.run('z:');
                this.logger.info("Mapped network drive in " + attempts + " attempts");
                return;
            } catch (e) {
                this.logger.info("Failed to map network drive");
                await new Promise(resolve => setTimeout(resolve, 4000));
            }
        }

        this.logger.error("Giving up trying to map network drive");
        throw new Error("Unable to map network drive");
    }

    public async stop(): Promise<void> {
        await WindowsBuilder.setDonglePower(false);

        this.logger.info("Shutting down VM...");
        this.vboxManage('controlvm', this.vmName, 'acpipowerbutton');
        const waitUntil = Date.now() + POWEROFF_TIMEOUT;

        let isRunning = true;
        while (isRunning && Date.now() < waitUntil) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            isRunning = await this.isRunning();
        }

        if (isRunning) {
            this.logger.info("VM still hasn't shut down: pulling the plug");
            try {
                await this.vboxManage('controlvm', this.vmName, 'poweroff');
            } catch (e) {}
        } else {
            this.logger.info("VM shut down cleanly");
        }
    }

    public async isRunning(): Promise<boolean> {
        // run() doesn't care about the output from VBoxManage but we do
        const runningList = await new Promise<string>((resolve, reject) => {
            childProcess.execFile('VBoxManage', ['list', 'runningvms'], (err, output) => {
                err ? reject(err) : resolve(output);
            });
        });
        return runningList.includes(this.vmName);
    }

    public appendScript(...args: string[]) {
        this.script += args.filter((x) => {
            return x.includes(' ') ? '"' + x + '"' : x;
        }).join(' ') + "\r\n";
        // we want to bail of any part of the script fails, which is
        // really clunky in a windows batch file
        this.script += 'if %errorlevel% neq 0 exit /b %errorlevel%\r\n';
    }

    public async runScript(): Promise<void> {
        const tmpCmdFile = path.join(this.cwd, 'tmp.cmd');
        const vcvarsArch = this.target.vcVarsArch;
        const fileContents = (
            "echo on\r\n" +
            "call \"" + VCVARSALL + '" ' + vcvarsArch + '\r\n' +
            "cd /D %userprofile%\r\n" +
            this.script
        );

        await fsProm.writeFile(tmpCmdFile, fileContents);

        const startTime = Date.now();
        this.logger.info("Windows build starting!");
        const timeLogger = this.logger.editLogger();
        const timer = setInterval(() => {
            const runningForMins = Math.round((Date.now() - startTime) / (60 * 1000));
            timeLogger.info("Windows build running for " + runningForMins + " mins");
        }, 60 * 1000);

        try {
            const ret = await this.run('z:\\tmp.cmd');
            return ret;
        } finally {
            clearInterval(timer);
            await fsProm.unlink(tmpCmdFile);
        }
    }

    private async run(runStr: string): Promise<void> {
        console.log("running " + runStr);

        const guestCtlArgs = [
            this.vmName,
            '--username', this.username,
            '--password', this.password,
            'run',
            '-E', 'BUILDKITE_API_KEY=' + process.env.BUILDKITE_API_KEY,
            '-E', 'SIGNING_KEY_CONTAINER=' + this.keyContainer,
        ];

        for (const [k, v] of Object.entries(this.env)) {
            guestCtlArgs.push('-E', k + '=' + v);
        }

        guestCtlArgs.push(...[
            '--exe', 'cmd.exe', // The executable file to run
            '--', // Tell virtualbox to pass everything else through
            // The name of the program (basically arg0) (unsure why
            // both this and --exe are necessary, but they are).
            'cmd',
            '/C',
            runStr,
        ]);

        return this.vboxManage('guestcontrol', ...guestCtlArgs);
    }

    private async vboxManage(cmd: string, ...args: string[]): Promise<void> {
        return spawn('VBoxManage', [cmd].concat(args));
    }

    public static async setDonglePower(on: boolean): Promise<void> {
        if (!process.env.UHUBCTL_DONGLE_POWER_LOCATION || !process.env.UHUBCTL_DONGLE_POWER_PORT_NUMBER) return;

        return new Promise((resolve, reject) => {
            const proc = childProcess.spawn('uhubctl', [
                '-l', process.env.UHUBCTL_DONGLE_POWER_LOCATION, // location
                '-e', // exact location
                '-p', process.env.UHUBCTL_DONGLE_POWER_PORT_NUMBER, // port number
                '-a', on ? 'on' : 'off', // action
            ], {
                stdio: 'ignore',
            });
            proc.on('exit', (code) => {
                code ? reject(code) : resolve();
            });
        });
    }
}
