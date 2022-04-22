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
    private baseUrl: string;
    private mxAccessToken: string;
    private mxRoomId: string;

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

    protected getContent(body: string): object {
        return {
            msgtype: 'm.notice',
            body,
        };
    }

    protected async log(level: Level, ...args: any[]): Promise<string> {
        console[level](...args);

        if (this.baseUrl === undefined) return;

        // log to matrix in the simplest possible way: If it fails, forget it, and we lose the log message,
        // and we wait while it completes, so if the server is slow, the build goes slower.
        const evData = JSON.stringify(this.getContent(args[0]));

        const url = `${this.baseUrl}/_matrix/client/r0/rooms/${encodeURIComponent(this.mxRoomId)}/send/m.room.message`;
        return new Promise((resolve) => {
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
            req.write(evData);
            req.end();
        });
    }

    public threadLogger(): ThreadLogger {
        const logger = new ThreadLogger();
        logger.setup(this.baseUrl, this.mxRoomId, this.mxAccessToken);
        return logger;
    }

    public editLogger(): EditLogger {
        const logger = new EditLogger();
        logger.setup(this.baseUrl, this.mxRoomId, this.mxAccessToken);
        return logger;
    }

    public reactionLogger(): ReactionLogger {
        const logger = new ReactionLogger();
        logger.setup(this.baseUrl, this.mxRoomId, this.mxAccessToken);
        return logger;
    }
}

abstract class RelatedLogger extends Logger {
    protected relatedEventId: string;

    protected async log(level: Level, ...args: any[]): Promise<string> {
        const eventId = await super.log(level, ...args);
        if (!this.relatedEventId) {
            this.relatedEventId = eventId;
        }
        return eventId;
    }

    protected abstract getMixin(body: string): object;

    protected getContent(body: string): object {
        if (!this.relatedEventId) return super.getContent(body);

        return {
            ...super.getContent(body),
            ...this.getMixin(body),
        };
    }

    public threadLogger(): ThreadLogger {
        const logger = super.threadLogger();
        logger.relatedEventId = this.relatedEventId;
        return logger;
    }

    public editLogger(): EditLogger {
        const logger = super.editLogger();
        logger.relatedEventId = this.relatedEventId;
        return logger;
    }

    public reactionLogger(): ReactionLogger {
        const logger = super.reactionLogger();
        logger.relatedEventId = this.relatedEventId;
        return logger;
    }
}

class ThreadLogger extends RelatedLogger {
    protected getMixin(): object {
        return {
            "m.relates_to": {
                event_id: this.relatedEventId,
                rel_type: "m.thread",
            },
        };
    }
}

// First log is sent as a notice, the following logs as edits to the original message
class EditLogger extends RelatedLogger {
    protected getMixin(body: string): object {
        return {
            "m.relates_to": {
                event_id: this.relatedEventId,
                rel_type: "m.replace",
            },
            "m.new_content": {
                body,
            },
        };
    }
}

// First log is sent as a notice, the following logs as reactions to the original message
class ReactionLogger extends RelatedLogger {
    protected getMixin(body: string): object {
        return {
            "m.relates_to": {
                event_id: this.relatedEventId,
                rel_type: "m.annotation",
                key: body,
            },
        };
    }

    protected getContent(body: string): object {
        if (!this.relatedEventId) return super.getContent(body);

        return this.getMixin(body);
    }
}

export default new Logger();
