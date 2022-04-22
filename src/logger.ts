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

/* eslint-disable @typescript-eslint/no-explicit-any */

import * as https from 'https';

type Level = 'error' | 'warn' | 'info' | 'debug';

export class Logger {
    protected baseUrl: string;
    protected mxAccessToken: string;
    protected mxRoomId: string;
    private context = new MatrixLogContext();
    private eventIdPromise: Promise<string>;

    public setup(matrixServer: string, roomId: string, accessToken: string): void {
        this.baseUrl = matrixServer;
        this.mxRoomId = roomId;
        this.mxAccessToken = accessToken;
    }

    public error(...args: any[]): void {
        this.log('error', ...args);
    }

    public warn(...args: any[]): void {
        this.log('warn', ...args);
    }

    public info(...args: any[]): void {
        this.log('info', ...args);
    }

    public debug(...args: any[]): void {
        this.log('debug', ...args);
    }

    public async file(log: string): Promise<void> {
        const url = await new Promise((resolve) => {
            const req = https.request(`${this.baseUrl}/_matrix/media/v3/upload`, {
                method: "POST",
                headers: {
                    "Content-Type": "text/plain",
                    'Authorization': 'Bearer ' + this.mxAccessToken,
                },
            }, (res) => {
                const chunks: Uint8Array[] = [];
                req.on("data", chunk => {
                    chunks.push(chunk);
                });

                req.on("end", () => {
                    const response = Buffer.concat(chunks).toString("utf-8");
                    resolve(JSON.parse(response).content_uri);
                });
            });

            // Set an error handler even though it's ignored to avoid Node exiting
            // on unhandled errors.
            req.on('error', e => {
                // just ignore for now
            });
            req.write(new Buffer(log));
            req.end();
        });

        await this.sendEvent({
            msgtype: "m.file",
            body: "Log file",
            url,
        });
    }

    protected async getContent(body: string): Promise<object> {
        return {
            msgtype: 'm.notice',
            body,
            ...this.context.mixin(body),
        };
    }

    private sendEvent(content: object): Promise<string> {
        const url = `${this.baseUrl}/_matrix/client/r0/rooms/${encodeURIComponent(this.mxRoomId)}/send/m.room.message`;
        return this.eventIdPromise = new Promise((resolve) => {
            const req = https.request(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + this.mxAccessToken,
                },
            }, (res) => {
                const chunks: Uint8Array[] = [];
                req.on("data", chunk => {
                    chunks.push(chunk);
                });

                req.on("end", () => {
                    const response = Buffer.concat(chunks).toString("utf-8");
                    resolve(JSON.parse(response).event_id);
                });
            });

            // Set an error handler even though it's ignored to avoid Node exiting
            // on unhandled errors.
            req.on('error', e => {
                // just ignore for now
            });
            req.write(JSON.stringify(content));
            req.end();
        });
    }

    protected async log(level: Level, ...args: any[]): Promise<string> {
        console[level](...args);

        if (this.baseUrl === undefined) return;

        // log to matrix in the simplest possible way: If it fails, forget it, and we lose the log message,
        // and we wait while it completes, so if the server is slow, the build goes slower.
        const evData = await this.getContent(args[0]);
        return this.sendEvent(evData);
    }

    private clone(): Logger {
        const logger = new Logger();
        logger.setup(this.baseUrl, this.mxRoomId, this.mxAccessToken);
        return logger;
    }

    // Grab a new logger with a context to a thread around the latest event which was sent
    public async threadLogger(): Promise<Logger> {
        const logger = this.clone();
        logger.context = new ThreadLogContext(await this.eventIdPromise);
        return logger;
    }

    // Grab a new logger with a context to editing the latest event which was sent
    public async editLogger(): Promise<Logger> {
        const logger = this.clone();
        logger.context = new EditLogContext(await this.eventIdPromise);
        return logger;
    }

    // Grab a new logger with a context to reacting to the latest event which was sent
    public async reactionLogger(): Promise<Logger> {
        const logger = this.clone();
        logger.context = new ReactionLogContext(await this.eventIdPromise);
        return logger;
    }
}

class MatrixLogContext {
    public mixin(body: string): object {
        return {};
    }
}

class ThreadLogContext extends MatrixLogContext {
    constructor(private readonly threadId: string) {
        super();
    }

    public mixin(): object {
        return {
            "m.relates_to": {
                event_id: this.threadId,
                rel_type: "m.thread",
            },
        };
    }
}

class EditLogContext extends MatrixLogContext {
    constructor(private readonly eventId: string) {
        super();
    }

    public mixin(body: string): object {
        return {
            "m.relates_to": {
                event_id: this.eventId,
                rel_type: "m.replace",
            },
            "m.new_content": {
                body,
            },
        };
    }
}

class ReactionLogContext extends MatrixLogContext {
    constructor(private readonly eventId: string) {
        super();
    }

    public mixin(body: string): object {
        return {
            "m.relates_to": {
                event_id: this.eventId,
                rel_type: "m.annotation",
                key: body,
            },
            // clobber body & msgtype
            "body": undefined,
            "msgtype": undefined,
        };
    }
}

export class LoggableError extends Error {
    constructor(public readonly code: number, public readonly log: string) {
        super(code.toString());
    }
}

export default new Logger();
