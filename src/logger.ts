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
    private eventIdPromise = Promise.resolve("");
    private context = new MatrixLogContext(this.eventIdPromise);

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
        return; // XXX for now disable the file logger due to potential for leaks
        const response = await this.request(
            `${this.baseUrl}/_matrix/media/v3/upload`,
            "POST",
            "text/plain",
            new Buffer(log),
        );
        const url = JSON.parse(response).content_uri;

        await this.sendEvent(() => this.context.getContent({
            msgtype: "m.file",
            body: "log.txt",
            url,
        }));
    }

    protected getContent(body: string): object {
        return this.context.getContent({
            msgtype: 'm.notice',
            body,
        });
    }

    private request(url: string, method: string, type: string, data: any): Promise<string> {
        return new Promise((resolve, reject) => {
            const req = https.request(url, {
                method: method,
                headers: {
                    'Content-Type': type,
                    'Authorization': 'Bearer ' + this.mxAccessToken,
                },
            }, (res) => {
                const chunks: Uint8Array[] = [];
                res.on("data", chunk => {
                    chunks.push(chunk);
                });

                res.on("end", () => {
                    resolve(Buffer.concat(chunks).toString("utf-8"));
                });
            });

            // Set an error handler even though it's ignored to avoid Node exiting
            // on unhandled errors.
            req.on('error', e => {
                // just ignore for now
                reject(e);
            });
            if (data) req.write(data);
            req.end();
        });
    }

    private sendEvent(fn: () => object, type = "m.room.message"): Promise<string> {
        const url = `${this.baseUrl}/_matrix/client/r0/rooms/${encodeURIComponent(this.mxRoomId)}/send/${type}`;
        // Make all events send sequentially
        const prom = this.eventIdPromise.then(lastEventId => (
            this.request(url, "POST", "application/json", JSON.stringify(fn()))
                .then(data => JSON.parse(data).event_id, () => lastEventId)
        ));
        this.eventIdPromise = prom;
        return prom;
    }

    protected async log(level: Level, ...args: any[]): Promise<string> {
        console[level](...args);

        if (this.baseUrl === undefined) return;

        // log to matrix in the simplest possible way: If it fails, forget it, and we lose the log message,
        // and we wait while it completes, so if the server is slow, the build goes slower.
        return this.sendEvent(() => this.getContent(args[0]), this.context.type);
    }

    private clone(context = this.context): Logger {
        const logger = new Logger();
        logger.context = context;
        logger.eventIdPromise = logger.context.ready().then(() => "");
        logger.setup(this.baseUrl, this.mxRoomId, this.mxAccessToken);
        return logger;
    }

    // Grab a new logger with a context to a thread around the latest event which was sent
    public threadLogger(): Logger {
        return this.clone(new ThreadLogContext(this.eventIdPromise));
    }

    // Grab a new logger with a context to editing the latest event which was sent
    public editLogger(): Logger {
        return this.clone(new EditLogContext(this.eventIdPromise));
    }

    // Grab a new logger with a context to reacting to the latest event which was sent
    public reactionLogger(): Logger {
        return this.clone(new ReactionLogContext(this.eventIdPromise));
    }
}

class MatrixLogContext {
    constructor(private readonly prom: Promise<unknown>) {}

    public getContent(content: object): object {
        return content;
    }

    public get type(): string {
        return "m.room.message";
    }

    public ready(): Promise<unknown> {
        return this.prom;
    }
}

class ThreadLogContext extends MatrixLogContext {
    private threadId: string;

    constructor(private readonly threadIdPromise: Promise<string>) {
        super(threadIdPromise);
        threadIdPromise.then(threadId => {
            this.threadId = threadId;
        });
    }

    public getContent(content: object): object {
        return {
            ...content,
            "m.relates_to": {
                event_id: this.threadId,
                rel_type: "m.thread",
            },
        };
    }
}

class EditLogContext extends MatrixLogContext {
    private eventId: string;

    constructor(private readonly eventIdPromise: Promise<string>) {
        super(eventIdPromise);
        eventIdPromise.then(threadId => {
            this.eventId = threadId;
        });
    }

    public getContent(content: object): object {
        return {
            ...content,
            "m.relates_to": {
                event_id: this.eventId,
                rel_type: "m.replace",
            },
            "m.new_content": content,
        };
    }
}

class ReactionLogContext extends MatrixLogContext {
    private eventId: string;

    constructor(private readonly eventIdPromise: Promise<string>) {
        super(eventIdPromise);
        eventIdPromise.then(threadId => {
            this.eventId = threadId;
        });
    }

    public getContent(content: object): object {
        return {
            "m.relates_to": {
                event_id: this.eventId,
                rel_type: "m.annotation",
                key: content["body"],
            },
        };
    }

    public get type(): string {
        return "m.reaction";
    }
}

export class LoggableError extends Error {
    constructor(public readonly code: number, public readonly log: string) {
        super(code.toString());
    }
}

export default new Logger();
