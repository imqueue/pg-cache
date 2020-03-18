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
import { RedisCache } from '@imqueue/rpc';
import { TagCache } from '@imqueue/tag-cache';
import { PgPubSub } from '@imqueue/pg-pubsub';

export interface PgCacheOptions {
    prefix?: string;
    postgres: string;
    redis?: { host: string; port: number; };
    redisCache?: RedisCache;
}

export interface PgCacheable {
    taggedCache: TagCache;
    pubSub: PgPubSub;
    pgCacheChannels: string[];
}

export type PgCacheDecorator = <T extends new(...args: any[]) => {}>(
    constructor: T,
) => T & PgCacheable;

// noinspection JSUnusedGlobalSymbols
export function PgCache(options: PgCacheOptions): PgCacheDecorator {
    return <T extends new(...args: any[]) => {}>(
        constructor: T,
    ): T & PgCacheable => {
        return class extends constructor {
            private taggedCache: TagCache;
            private pubSub: PgPubSub = new PgPubSub({
                connectionString: options.postgres,
            } as any);
            // noinspection JSMismatchedCollectionQueryUpdate
            private pgCacheChannels: string[] = [];

            // noinspection JSUnusedGlobalSymbols
            public async init(...args: any[]): Promise<void> {
                const init = constructor.prototype.init;
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
                await this.pubSub.connect();

                await Promise.all(this.pgCacheChannels
                    .map(async channel => await this.pubSub.listen(channel)));

                if (init && typeof init === 'function') {
                    await init.apply(this, args);
                }
            }
        } as unknown as T & PgCacheable;
    };
}
