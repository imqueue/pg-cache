/*!
 * I'm Queue Software Project
 * Copyright (C) 2025  imqueue.com <support@imqueue.com>
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 *
 * If you want to use this code in a closed source (commercial) project, you can
 * purchase a proprietary commercial license. Please contact us at
 * <support@imqueue.com> to get commercial licensing options.
 */
import {
    type AnyJson,
    IMQService,
    type JsonObject,
    RedisCache,
} from '@imqueue/rpc';
import { signature } from './signature.js';
import { TagCache } from '@imqueue/tag-cache';
import { PgPubSub } from '@imqueue/pg-pubsub';
import { Client } from 'pg';
import {
    type ClassDecorator,
    type ILogger,
    awaitInvalidation,
    DEFAULT_INVALIDATION_TIMEOUT,
    PG_CACHE_DEBUG,
    PG_CACHE_TRIGGER,
} from './env.js';

/**
 * Options for the {@link PgCache} class decorator: where PostgreSQL and redis
 * live, and how the change-notify triggers behave.
 *
 * Exactly one of `redis` or `redisCache` must be supplied — `redis` to let the
 * decorator build its own connection, `redisCache` to reuse one the service
 * already owns.
 */
export interface PgCacheOptions {
    /**
     * Redis cache key prefix to use. If not specified, decorated service
     * class name will be used as prefix by default.
     *
     */
    prefix?: string;

    /**
     * PostgreSQL database connection string
     *
     */
    postgres: string;

    /**
     * Redis connection options
     *
     */
    redis?: {
        host: string;
        port: number;
        username?: string;
        password?: string;
    };

    /**
     * Initialized redis cache instance. One of redis option or this redisCache
     * option is required to be provided
     *
     */
    redisCache?: RedisCache;

    /**
     * Pass false, if database channel event should not be published by service
     * to connected clients. By default is enabled = true.
     *
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
     */
    triggerDefinition?: string;

    /**
     * Pass true to refuse to cache at all when invalidation could not be
     * established. Off by default.
     *
     * @remarks
     * Regardless of this option, `start()` does not resolve until the triggers
     * and channel subscriptions are confirmed, so a row changed right after
     * start-up is always noticed. This option covers what happens when that
     * setup *fails* — or when no channels were registered, so nothing could ever
     * invalidate the entries.
     *
     * By default such a service still caches, and its entries then expire by ttl
     * alone; the ttl defaults to 24 hours ({@link DEFAULT_CACHE_TTL}), so that is
     * how stale a value can get. Pass true where that is the wrong trade and the
     * service should run uncached instead, paying latency to avoid serving
     * something nothing will ever invalidate.
     */
    requireInvalidation?: boolean;

    /**
     * How long `start()` waits for the change-notify triggers and the channel
     * subscriptions to be confirmed, in milliseconds. Defaults to
     * {@link DEFAULT_INVALIDATION_TIMEOUT}; a non-positive value falls back to
     * the same.
     *
     * @remarks
     * On expiry `start()` resolves with a warning rather than hanging: a database
     * that accepts a connection but never confirms the subscription is a broken
     * deployment, and a service that cannot invalidate is still a service that
     * works. Whether it then caches is
     * {@link PgCacheOptions.requireInvalidation}.
     */
    invalidationTimeout?: number;
}

/**
 * What the {@link PgCache} decorator adds to the class it is applied to. A
 * decorated service gains these three members, so code inside the service can
 * reach the cache and the subscription directly.
 */
export interface PgCacheable {
    /**
     * Tagged redis cache holding the memoised method results. Each entry is
     * tagged with the tables it depends on, which is how a change notification
     * invalidates exactly the right entries.
     *
     * @remarks
     * Absent until invalidation is live: `start()` publishes it once the triggers
     * are installed and the channels subscribed, and does not resolve before
     * then. If that setup fails it is published anyway, so behaviour is
     * unchanged for a service that cannot subscribe — unless
     * {@link PgCacheOptions.requireInvalidation} says otherwise, in which case it
     * stays absent and the method decorators simply run the method, uncached.
     */
    taggedCache: TagCache;

    /**
     * PostgreSQL LISTEN/NOTIFY subscription the triggers publish to. One channel
     * per watched table.
     */
    pubSub: PgPubSub;

    /**
     * Table-to-method registry built by the {@link cacheWith} and
     * {@link cacheBy} method decorators at class-definition time, and read when
     * a notification arrives to decide what to invalidate.
     */
    pgCacheChannels: PgCacheChannels;
}

/**
 * One registered dependency of a cached method: the method to invalidate, and an
 * optional filter narrowing which changes should trigger it.
 *
 * Position 0 is the decorated method name; position 1 is the filter, or
 * `undefined` to invalidate on every change to the table.
 */
export type PgCacheChannel = [
    string, // called method name
    ChannelFilter | undefined, // filter used to decide of invalidation
];

/**
 * Registry of cached methods keyed by the PostgreSQL notification channel that
 * invalidates them. The key is a table name: the installed trigger uses the
 * table name as its NOTIFY channel, so the two are the same string.
 */
export interface PgCacheChannels {
    // key is actually a table name - which is pg notify channel
    [name: string]: PgCacheChannel[];
}

const RX_TRIGGER = new RegExp(
    'create\\s+(or\\s+replace)?function\\s+' +
        'post_change_notify_trigger\\s+\\([^)]*\\).*?returns\\s+trigger',
    'i',
);

/**
 * Checks if a given definition valid. If not - will return default trigger
 * definition.
 *
 * @see {@link PG_CACHE_TRIGGER}
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

    await Promise.all(
        channels.map(async channel => {
            try {
                await pg.query(
                    `CREATE TRIGGER "post_change_notify"
                    AFTER INSERT OR UPDATE OR DELETE
                    ON "${channel}"
                    FOR EACH ROW
                EXECUTE PROCEDURE post_change_notify_trigger()`,
                );

                if (PG_CACHE_DEBUG) {
                    logger.info(`PgCache: trigger created on ${channel}!`);
                }
            } catch (err) {
                // 42P01 (undefined_table) means the channel does not name a
                // real table, so no NOTIFY will ever be emitted for it - a
                // silent dead end. Every other failure here is expected on a
                // warm database (42723: trigger already exists).
                if ((err as { code?: string })?.code === '42P01') {
                    logger.warn(
                        `PgCache: channel "${channel}" is not an existing ` +
                            'table - no trigger installed, this channel will ' +
                            'never fire',
                    );
                } else if (PG_CACHE_DEBUG) {
                    logger.info(
                        `PgCache: create trigger on ${channel} errored:`,
                        err,
                    );
                }
            }
        }),
    );
}

/**
 * The row-level operation that produced a change notification. Matches the
 * PostgreSQL trigger's `TG_OP`.
 */
export enum ChannelOperation {
    // noinspection JSUnusedGlobalSymbols

    /** A row was inserted. */
    INSERT = 'INSERT',

    /** A row was updated. */
    UPDATE = 'UPDATE',

    /** A row was deleted. */
    DELETE = 'DELETE',
}

/**
 * Payload delivered on a table's notification channel by the installed trigger,
 * describing a single row change.
 */
export interface ChannelPayload {
    /**
     * When the change occurred. Arrives JSON-encoded and is revived into a
     * `Date` before a {@link ChannelPayloadFilter} sees it.
     */
    timestamp: Date;

    /** Which row-level operation fired the trigger. */
    operation: ChannelOperation;

    /** PostgreSQL schema of the changed table. */
    schema: string;

    /** Name of the changed table — also the notification channel name. */
    table: string;

    /**
     * The changed row. `NEW` for inserts and updates, `OLD` for deletes, so this
     * is always the row the change is about.
     */
    record: JsonObject;
}

/**
 * Predicate deciding whether one change should invalidate the cached method.
 *
 * Returning `true` invalidates. Unlike the array form of {@link ChannelFilter},
 * this reads the way you expect — see that type for the inversion.
 */
export type ChannelPayloadFilter = (payload: ChannelPayload) => boolean;

/**
 * Narrows which changes to a table invalidate a cached method.
 *
 * The two forms behave in OPPOSITE directions, which is easy to get wrong:
 *
 * - A {@link ChannelOperation} array is an **exclusion** list. Operations named
 *   in it do NOT invalidate; everything else does. So `[ChannelOperation.DELETE]`
 *   means "invalidate on inserts and updates, ignore deletes" — not "invalidate
 *   on deletes".
 * - A {@link ChannelPayloadFilter} is an **inclusion** predicate: it invalidates
 *   when it returns `true`.
 *
 * Omitting the filter invalidates on every change to the table.
 */
export type ChannelFilter = ChannelOperation[] | ChannelPayloadFilter;

/**
 * Map of table name to the filter that decides which of its changes matter,
 * for method decorators that watch several tables with different rules.
 */
export interface FilteredChannels {
    [channel: string]: ChannelFilter;
}

function needInvalidate(
    payload: ChannelPayload,
    filter?: ChannelFilter,
): boolean {
    if (Array.isArray(filter)) {
        return !~filter.indexOf(payload.operation);
    } else if (typeof filter === 'function') {
        payload.timestamp = new Date(payload.timestamp);

        return !!filter(payload);
    }

    return true;
}

function publish(
    self: any & PgCacheable,
    channel: string,
    payload: AnyJson,
    tag: string,
): void {
    if (typeof self.publish !== 'function') {
        if (PG_CACHE_DEBUG) {
            self.logger.info(
                `PgCache: publish method does not exist on ${
                    self.constructor.name
                }`,
            );
        }

        return;
    }

    (self as IMQService)
        .publish({ channel, payload, tag })
        .then((result: any) => {
            if (PG_CACHE_DEBUG) {
                self.logger.info(
                    `PgCache: tag '${tag}' published to client with:`,
                    channel,
                );
            }

            return result;
        })
        .catch((err: any) =>
            self.logger.warn(`PgCache: error publishing '${tag}':`, err),
        );
}

function invalidate(self: any & PgCacheable, tag: string): void {
    self.taggedCache
        .invalidate(tag)
        .then((result: any) => {
            if (PG_CACHE_DEBUG) {
                self.logger.info(`PgCache: key '${tag}' invalidated!`);
            }

            return result;
        })
        .catch((err: any) =>
            self.logger.warn(`PgCache: error invalidating '${tag}':`, err),
        );
}

// noinspection JSUnusedGlobalSymbols
/**
 * Class decorator turning an `@imqueue` service into a PostgreSQL-invalidated
 * cache: method results are memoised in redis, and PostgreSQL itself tells the
 * service when to drop them.
 *
 * It installs a change-notify trigger on every table the service's
 * {@link cacheWith} and {@link cacheBy} decorators declare a dependency on, and
 * subscribes to one LISTEN/NOTIFY channel per table. When a row changes, the
 * matching cached results are invalidated by tag — so a cache entry lives exactly
 * as long as the data behind it is unchanged, rather than for a guessed TTL.
 *
 * ```typescript
 * import { PgCache, cacheWith } from '@imqueue/pg-cache';
 *
 * @PgCache({
 *     postgres: process.env.DB_URL!,
 *     redis: { host: 'localhost', port: 6379 },
 * })
 * class UserService extends IMQService {
 *     @cacheWith({ channels: ['users'] })
 *     public async list(): Promise<User[]> { ... }
 * }
 * ```
 *
 * Applied to the class, it wraps `start()`: the subscription and the triggers are
 * established there, after any existing `start()` implementation has run. So the
 * cache is inert until the service is started, and a service that never calls
 * `start()` is never cached.
 *
 * Awaiting `start()` is enough — it does not resolve until the triggers exist and
 * the channels are subscribed, so a row changed immediately afterwards cannot go
 * unnoticed. That costs a few tens of milliseconds at boot. If the setup fails,
 * or is not confirmed within {@link PgCacheOptions.invalidationTimeout}, the
 * service still caches and reports the failure loudly; pass
 * {@link PgCacheOptions.requireInvalidation} to have it run uncached instead.
 *
 * Works both as a standard (TC39) decorator and as a legacy
 * (`experimentalDecorators`) one, matching `@imqueue/rpc`, so it can be applied in
 * either compilation mode.
 *
 * Redis is resolved in order: `options.redisCache`, then `options.redis`, then a
 * `cache` property already on the service. If none is available `start()` throws.
 *
 * @param options - PostgreSQL and redis connection details, plus the cache-key
 *                  prefix, publication and trigger-definition overrides
 * @returns the class decorator to apply, which augments the class with
 *          {@link PgCacheable}
 */
export function PgCache(options: PgCacheOptions): ClassDecorator {
    // Dual-mode: standard (TC39) class decorators pass (value, context); legacy
    // ones pass just the constructor. In both cases the first argument is the
    // class, and the body augments its prototype in place. In standard mode the
    // per-method channel metadata is registered by initializers at construction
    // time, so it is read at runtime (see start(): `this.pgCacheChannels`)
    // rather than captured here at decoration time.
    return ((constructor: any, _context?: any): any => {
        const init = constructor.prototype.start;
        const pgCacheChannels = constructor.prototype.pgCacheChannels;

        class CachedService {
            private taggedCache: TagCache;
            private pgCacheChannels: PgCacheChannels;
            private pubSub: PgPubSub;

            public async start(...args: any[]): Promise<void> {
                this.pubSub = new PgPubSub({
                    connectionString: options.postgres,
                });

                if (init && typeof init === 'function') {
                    await init.apply(this, args);
                }

                const logger = (this as any).logger || console;
                const prefix = options.prefix || constructor.name;
                let cache: RedisCache;

                if (options.redisCache) {
                    cache = options.redisCache;
                } else if (options.redis) {
                    cache = await new RedisCache().init({
                        ...options.redis,
                        prefix,
                        logger,
                    });
                } else if ((this as any).cache) {
                    cache = (this as any).cache;
                } else {
                    throw new TypeError(
                        'PgCache: either one of redisCache or ' +
                            'redisConnectionString option must be provided!',
                    );
                }

                // built here, but deliberately NOT published on the instance
                // yet: the method decorators treat a missing taggedCache as
                // "not cacheable" and run the method, so withholding it is how
                // caching stays off until invalidation is live. start() does not
                // resolve until it is published one way or the other, so no
                // caller ever observes the gap
                const taggedCache = new TagCache(cache);

                // when invalidation cannot be established at all, caching still
                // happens unless the service asked for the stricter trade
                const cacheAnyway = options.requireInvalidation !== true;

                const className = constructor.name;
                const pgChannels =
                    this.pgCacheChannels || pgCacheChannels || {};
                const channels = Object.keys(pgChannels);

                if (!(channels && channels.length)) {
                    logger.warn(
                        `PgCache: ${className}: no channels registered - ` +
                            'nothing can ever invalidate this cache, so ' +
                            (cacheAnyway
                                ? 'cached reads will only expire by ttl'
                                : 'caching stays OFF ' +
                                  '(requireInvalidation is on)'),
                    );

                    if (cacheAnyway) {
                        this.taggedCache = taggedCache;
                    }

                    return;
                }

                // a channel name is a table name; anything else (undefined,
                // empty, non-string) can only come from broken registration
                // and guarantees notifications will never arrive
                const invalidChannels = channels.filter(
                    channel =>
                        !channel ||
                        channel === 'undefined' ||
                        channel === 'null',
                );

                if (invalidChannels.length) {
                    logger.warn(
                        `PgCache: ${className}: ${invalidChannels.length} ` +
                            'invalid channel name(s) registered: ' +
                            `${invalidChannels.join(', ')} - these are not ` +
                            'table names, so their notifications will never ' +
                            'fire. Usually means table names were read before ' +
                            'the models were initialized',
                    );
                }
                const maxListeners = channels.length * 2;

                this.pubSub.channels.setMaxListeners(maxListeners);
                this.pubSub.setMaxListeners(maxListeners);
                this.pubSub.pgClient.setMaxListeners(maxListeners);

                for (const channel of channels) {
                    this.pubSub.channels.on(channel, payload => {
                        if (PG_CACHE_DEBUG) {
                            logger.info(
                                'PgCache: database event caught:',
                                channel,
                                payload,
                            );
                        }

                        const methods = pgChannels[channel] || [];
                        const data = payload as unknown as ChannelPayload;

                        for (const [method, filter] of methods) {
                            const useTag = signature(className, method, []);

                            if (needInvalidate(data, filter)) {
                                invalidate(this, useTag);

                                if (options.publish !== false) {
                                    publish(
                                        this,
                                        channel,
                                        payload as AnyJson,
                                        useTag,
                                    );
                                }
                            }
                        }
                    });
                }

                // PgPubSub.listen() stays silent when it decides not to
                // subscribe, so track the channels it actually confirmed
                const listened = new Set<string>();

                this.pubSub.on('listen', (channel: string) =>
                    listened.add(channel),
                );

                // installs the triggers and subscribes, then publishes the tag
                // cache: caching becomes live exactly when invalidation does
                const establish = async (): Promise<void> => {
                    try {
                        await install(
                            Object.keys(pgChannels),
                            this.pubSub.pgClient,
                            triggerDef(options.triggerDefinition),
                            logger,
                        );

                        if (PG_CACHE_DEBUG) {
                            logger.info(
                                `PgCache: triggers installed for ${className}`,
                            );
                        }

                        await Promise.all(
                            channels.map(
                                async channel =>
                                    await this.pubSub.listen(channel),
                            ),
                        );

                        const missed = channels.filter(
                            channel => !listened.has(channel),
                        );

                        logger.info(
                            `PgCache: ${className}: listening ` +
                                `${listened.size}/${channels.length} ` +
                                `channels: ${[...listened].join(', ')}`,
                        );

                        if (missed.length) {
                            logger.warn(
                                `PgCache: ${className}: NOT listening on ` +
                                    `${missed.length} channel(s): ` +
                                    `${missed.join(', ')} - writes to them ` +
                                    'will not invalidate the cache in this ' +
                                    'process',
                            );
                        }

                        this.taggedCache = taggedCache;
                    } catch (err) {
                        logger.error(
                            `PgCache: ${className}: failed to set up ` +
                                'invalidation - ' +
                                (cacheAnyway
                                    ? 'caching is ENABLED but invalidation is ' +
                                      'DISABLED'
                                    : 'caching stays OFF') +
                                ':',
                            err,
                        );

                        if (cacheAnyway) {
                            this.taggedCache = taggedCache;
                        }
                    }
                };

                // this work runs from a `connect` handler, which an event
                // emitter cannot await, so it is captured for start() to await
                // below. The promise is created before connect() so it cannot
                // matter whether 'connect' is emitted before or after that call
                // resolves; an escaping rejection would be an unhandled one and
                // vanish without a trace, leaving cache on and invalidation off,
                // so establish() never rejects.
                let markReady: () => void = () => undefined;
                const invalidationReady = new Promise<void>(
                    resolve => (markReady = resolve),
                );

                this.pubSub.on('connect', () => {
                    void establish().then(markReady);
                });

                await this.pubSub.connect();

                // without this, start() resolves while the cache is live and
                // nothing can invalidate it yet, and a row changed in that
                // window is never noticed - the entry then stands until the
                // next change to one of its tables, or the ttl
                const confirmed = await awaitInvalidation(
                    invalidationReady,
                    options.invalidationTimeout ?? DEFAULT_INVALIDATION_TIMEOUT,
                    () =>
                        logger.warn(
                            `PgCache: ${className}: invalidation was not ` +
                                'confirmed in time - ' +
                                (cacheAnyway
                                    ? 'caching is ENABLED but invalidation is ' +
                                      'DISABLED'
                                    : 'caching stays OFF'),
                        ),
                );

                if (!confirmed && cacheAnyway) {
                    this.taggedCache = taggedCache;
                }
            }
        }

        const proto: any = new CachedService();

        for (const prop of Object.keys(proto)) {
            constructor.prototype[prop] = proto[prop];
        }

        constructor.prototype.start = CachedService.prototype.start;

        return constructor;
    }) as ClassDecorator;
}
