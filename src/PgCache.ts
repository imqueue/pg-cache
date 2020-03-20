/*!
 * Copyright (c) 2018, imqueue.com <support@imqueue.com>
 *
 * Permission to use, copy, modify, and/or distribute this software for any
 * purpose with or without fee is hereby granted, provided that the above
 * copyright notice and this permission notice appear in all copies.
 *
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
 * REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
 * AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
 * INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
 * LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
 * OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
 * PERFORMANCE OF THIS SOFTWARE.
 */
import {
    AnyJson,
    ILogger,
    IMQService,
    JsonObject,
    RedisCache,
} from '@imqueue/rpc';
import { TagCache } from '@imqueue/tag-cache';
import { PgPubSub } from '@imqueue/pg-pubsub';
import { Client } from 'pg';
import { PG_CACHE_DEBUG, PG_CACHE_TRIGGER } from './env';

export interface PgCacheOptions {
    /**
     * Redis cache key prefix to use. If not specified, decorated service
     * class name will be used as prefix by default.
     *
     * @type {string}
     */
    prefix?: string;

    /**
     * PostgreSQL database connection string
     *
     * @type {string}
     */
    postgres: string;

    /**
     * Redis connection options
     *
     * @type {{ host: string, port: number }}
     */
    redis?: { host: string; port: number; };

    /**
     * Initialized redis cache instance. One of redis option or this redisCache
     * option is required to be provided
     *
     * @type {RedisCache}
     */
    redisCache?: RedisCache;

    /**
     * Pass false, if database channel event should not be published by service
     * to connected clients. By default is enabled = true.
     *
     * @type {boolean}
     */
    publish?: boolean;

    /**
     * SQL definition of the trigger function, in case default which is used
     * by this lib is not satisfying for some reason. Expected string
     * starting with
     * 'create function post_change_notify_trigger() returns trigger'
     * or will fall back to a default trigger definition. Spaces and case is
     * ignored, 'or replace statement is allowed', if needed.
     *
     * @type {string}
     */
    triggerDefinition?: string;
}

export interface PgCacheable {
    taggedCache: TagCache;
    pubSub: PgPubSub;
    pgCacheChannels: PgChannels;
}

export interface PgChannels {
    [name: string]: [string, ChannelFilter | undefined][];
}

export type PgCacheDecorator = <T extends new(...args: any[]) => {}>(
    constructor: T,
) => T & PgCacheable;

const RX_TRIGGER = new RegExp(
    'create\\s+(or\\s+replace)?function\\s+' +
    'post_change_notify_trigger\\s+\\([^)]*\\).*?returns\\s+trigger',
    'i',
);

/**
 * Checks if a given definition valid. If not - will return default trigger
 * definition.
 *
 * @see PG_CACHE_TRIGGER
 * @access private
 * @param {string} [definition]
 * @return {string}
 */
function triggerDef(definition?: string): string {
    if (!RX_TRIGGER.test(definition + '')) {
        return PG_CACHE_TRIGGER;
    }

    return definition as string;
}

/**
 * Installs database triggers
 *
 * @access private
 * @param {string[]} channels
 * @param {Client} pg
 * @param {string} triggerDefinition
 * @param {ILogger} logger
 * @return {Promise<void>}
 */
async function install(
    channels: string[],
    pg: Client,
    triggerDefinition: string,
    logger: ILogger,
): Promise<void> {
    try {
        await pg.query(triggerDefinition);
    } catch (err) {
        if (PG_CACHE_DEBUG) {
            logger.info('PgCache: create trigger function errored:', err);
        }
    }

    await Promise.all(channels.map(async channel => {
        try {
            await pg.query(
                `CREATE TRIGGER "post_change_notify"
                    AFTER INSERT OR UPDATE OR DELETE
                    ON "${channel}"
                    FOR EACH ROW
                EXECUTE PROCEDURE post_change_notify_trigger()`,
            );

            if (PG_CACHE_DEBUG) {
                logger.info(`PgCache: trigger created on ${ channel }!`);
            }
        } catch (err) {
            if (PG_CACHE_DEBUG) {
                logger.info(`PgCache: create trigger on ${ channel } errored:`,
                    err,
                );
            }
        }
    }));
}

export enum ChannelOperation {
    // noinspection JSUnusedGlobalSymbols
    INSERT = 'INSERT',
    UPDATE = 'UPDATE',
    DELETE = 'DELETE',
}

export interface ChannelPayload {
    timestamp: Date;
    operation: ChannelOperation;
    schema: string;
    table: string;
    record: JsonObject;
}

export type ChannelPayloadFilter = (
    payload: ChannelPayload,
    args: any[],
) => boolean;

export type ChannelFilter = ChannelOperation[] | ChannelPayloadFilter;

export interface FilteredChannels {
    [channel: string]: ChannelFilter;
}

function invalidate(
    self: any & PgCacheable,
    channel: string,
    className: string,
    method: string,
    payload: ChannelPayload,
    args: any[],
    filter?: ChannelFilter,
    publish?: boolean,
): void {
    let needInvalidate = true;

    if (Array.isArray(filter)) {
        if (!~filter.indexOf(payload.operation)) {
            needInvalidate = false;
        }
    } else if (typeof filter === 'function') {
        payload.timestamp = new Date(payload.timestamp);
        needInvalidate = !!filter(payload, args);
    }

    if (!needInvalidate) {
        return ;
    }

    self.taggedCache.invalidate(`${ className }:${ method }`)
        .then((result: any) => {
            if (!PG_CACHE_DEBUG) {
                return result;
            }

            self.logger.info(
                `PgCache: key '${ className }:${ method }' invalidated!`,
            );

            return result;
        })
        .catch((err: any) => self.logger.warn(
            `PgCache: error invalidating '${ className }:${ method }':`,
            err,
        ));

    if (typeof self.publish === 'function') {
        if (!publish) {
            return ;
        }

        (self as IMQService)
            .publish({
                channel,
                payload: payload as unknown as AnyJson,
                tag: `${ className }:${ method }`,
            })
            .then((result: any) => {
                if (!PG_CACHE_DEBUG) {
                    return result;
                }

                self.logger.info(
                    `PgCache: tag '${
                        className }:${ method
                    }' published to client with:`,
                    channel,
                    payload,
                );

                return result;
            })
            .catch((err: any) => self.logger.warn(
                `PgCache: error publishing '${
                    className }:${ method }':`,
                err,
            ));
    } else if (PG_CACHE_DEBUG) {
        self.logger.info(`PgCache: publish method does not exist on ${
            self.constructor.name
        }`);
    }
}

// noinspection JSUnusedGlobalSymbols
export function PgCache(options: PgCacheOptions): PgCacheDecorator {
    return <T extends new(...args: any[]) => {}>(
        constructor: T,
    ): T & PgCacheable => {
        const init = constructor.prototype.start;

        class CachedService {
            private taggedCache: TagCache;
            private pgCacheChannels: PgChannels;
            private pubSub: PgPubSub = new PgPubSub({
                connectionString: options.postgres,
            } as any);

            // noinspection JSUnusedGlobalSymbols
            public async start(...args: any[]): Promise<void> {
                if (init && typeof init === 'function') {
                    await init.apply(this, args);
                }

                let cache: RedisCache;

                if (options.redisCache) {
                    cache = options.redisCache;
                } else if (options.redis) {
                    cache = new RedisCache();

                    // noinspection TypeScriptUnresolvedFunction
                    await cache.init({
                        ...options.redis,
                        prefix: options.prefix || constructor.name,
                        logger: ((this as any).logger || console),
                    } as any);
                } else if ((this as any).cache) {
                    cache = (this as any).cache;
                } else {
                    throw new TypeError(
                        'Either one of redisCache or redisConnectionString ' +
                        'option must be provided!',
                    );
                }

                // noinspection TypeScriptUnresolvedVariable
                this.taggedCache = new TagCache(cache);

                const channels = Object.keys(this.pgCacheChannels);
                const className = constructor.name;
                const logger = ((this as any).logger || console);

                this.pubSub.channels.setMaxListeners(channels.length + 1);

                for (const channel of channels) {
                    this.pubSub.channels.on(channel, payload => {
                        if (PG_CACHE_DEBUG) {
                            logger.info(
                                'PgCache: database event caught:',
                                channel, payload,
                            );
                        }

                        const methods = this.pgCacheChannels[channel] || [];

                        for (const [method, filter] of methods) {
                            invalidate(
                                this,
                                channel,
                                className,
                                method,
                                payload as unknown as ChannelPayload,
                                args,
                                filter,
                                options.publish !== false,
                            );
                        }
                    });
                }

                this.pubSub.on('connect', async () => {
                    await install(
                        Object.keys(this.pgCacheChannels),
                        this.pubSub.pgClient,
                        triggerDef(options.triggerDefinition),
                        logger,
                    );

                    if (PG_CACHE_DEBUG) {
                        logger.info(`PgCache: triggers installed for ${
                            this.constructor.name
                        }`);
                    }

                    await Promise.all(channels.map(async channel =>
                        await this.pubSub.listen(channel)),
                    );

                    if (PG_CACHE_DEBUG) {
                        logger.info(`PgCache: listening channels ${
                            channels.join(', ')
                        } on  ${ this.constructor.name }`);
                    }
                });

                await this.pubSub.connect();
            }
        }

        const proto: any = new CachedService();

        for (const prop of Object.keys(proto)) {
            constructor.prototype[prop] = proto[prop];
        }

        constructor.prototype.start = CachedService.prototype.start;

        return constructor as unknown as T & PgCacheable;
    };
}
