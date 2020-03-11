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

const path = require('path');
const fsProm = require('fs').promises;
const childProcess = require('child_process');

const logger = require('./logger');

const STARTVM_TIMEOUT = 60 * 1000;
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
class WindowsBuilder {
    constructor(cwd, arch, vmName, username, password, keyContainer) {
        this.cwd = cwd;
        this.arch = arch;
        this.vmName = vmName;
        this.username = username;
        this.password = password;
        this.keyContainer = keyContainer;
        this.script = '';
    }

    async start() {
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

        logger.info("Starting VM: " + this.vmName);
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
    }

    async pingVm() {
        try {
            await this._run('ping -n 1 127.0.0.1');
            return true;
        } catch (e) {
            return false;
        }
    }

    async mapBuildDir() {
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
                    await this._run('net use z: /delete /y');
                } catch (e) {
                }
                await this._run('net use z: \\\\vboxsvr\\builddir /y');
                await new Promise(resolve => setTimeout(resolve, 4000));
                await this._run('z:');
                logger.info("Mapped network drive in " + attempts + " attempts");
                return;
            } catch (e) {
                logger.info("Failed to map network drive");
                await new Promise(resolve => setTimeout(resolve, 4000));
            }
        }

        logger.error("Giving up trying to map network drive");
        throw new Error("Unable to map network drive");
    }

    async stop() {
        logger.info("Shutting down VM...");
        this.vboxManage('controlvm', this.vmName, 'acpipowerbutton');
        const waitUntil = Date.now() + POWEROFF_TIMEOUT;

        let isRunning = true;
        while (isRunning && Date.now() < waitUntil) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            isRunning = await this.isRunning();
        }

        if (isRunning) {
            logger.info("VM still hasn't shut down: pulling the plug");
            try {
                await this.vboxManage('controlvm', this.vmName, 'poweroff');
            } catch (e) {}
        } else {
            logger.info("VM shut down cleanly");
        }
    }

    async isRunning() {
        // run() doesn't care about the output from VBoxManage but we do
        const runningList = await new Promise((resolve, reject) => {
            childProcess.execFile('VBoxManage', ['list', 'runningvms'], {
                stdio: 'inherit',
            }, (err, output) => {
                err ? reject(err) : resolve(output);
            });
        });
        return runningList.includes(this.vmName);
    }

    appendScript(...args) {
        this.script += args.filter((x) => {
            return x.includes(' ') ? '"' + x + '"' : x;
        }).join(' ') + "\r\n";
        // we want to bail of any part of the script fails, which is
        // really clunky in a windows batch file
        this.script += 'if %errorlevel% neq 0 exit /b %errorlevel%\r\n';
    }

    async runScript(script) {
        const tmpCmdFile = path.join(this.cwd, 'tmp.cmd');
        const vcvarsArch = this.arch === 'win64' ? 'amd64' : 'x86';
        const fileContents = (
            "echo on\r\n" +
            "call \"" + VCVARSALL + '" ' + vcvarsArch + '\r\n' +
            "cd /D %userprofile%\r\n" +
            this.script
        );

        await fsProm.writeFile(tmpCmdFile, fileContents);

        const startTime = Date.now();
        const timer = setInterval(() => {
            const runningForMins = Math.round((Date.now() - startTime) / (60 * 1000));
            logger.info("Windows build running for " + runningForMins + " mins");
        }, 60 * 1000);

        try {
            const ret = await this._run('z:\\tmp.cmd');
            return ret;
        } finally {
            clearInterval(timer);
            await fsProm.unlink(tmpCmdFile);
        }
    }

    async _run(runStr) {
        console.log("running "+runStr);

        const gustCtlArgs = [
            this.vmName,
            '--username', this.username,
            '--password', this.password,
            'run',
            '-E', 'BUILDKITE_API_KEY='+process.env.BUILDKITE_API_KEY,
            '-E', 'SIGNING_KEY_CONTAINER='+this.keyContainer,
            '--exe', 'cmd.exe', // The executable file to run
            '--', // Tell virtualbox to pass everything else through
            // The name of the program (basically arg0) (unsure why
            // both this and --exe are necessary, but they are).
            'cmd',
            '/C',
            runStr,
        ];

        return this.vboxManage('guestcontrol', ...gustCtlArgs);
    }

    async vboxManage(cmd, ...args) {
        return new Promise((resolve, reject) => {
            const proc = childProcess.spawn('VBoxManage', [cmd].concat(args), {
                stdio: 'inherit',
            });
            proc.on('exit', (code) => {
                code ? reject(code) : resolve();
            });
        });
    }
}

module.exports = WindowsBuilder;
