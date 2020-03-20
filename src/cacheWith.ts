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
import { signature } from '@imqueue/rpc';
import { TagCache } from '@imqueue/tag-cache';
import { FilteredChannels, PgCacheable } from './PgCache';
import { PG_CACHE_DEBUG } from './env';

const defaultTtl = 86400000; // 24 hrs in milliseconds

export type CachedWithDecorator = (
    target: any,
    methodName: string | symbol,
    descriptor: TypedPropertyDescriptor<(...args: any[]) => any>,
) => void;

export interface CacheWithOptions {
    /**
     * Time to live in milliseconds. By default is equivalent to 24 hours
     *
     * @type {number}
     */
    ttl?: number;

    /**
     * PgBubSub channels to listen for invalidation. Usually channels are
     * table names.
     *
     * @type {string[] | FilteredChannels}
     */
    channels: string[] | FilteredChannels;
}

// noinspection JSUnusedGlobalSymbols
export function cacheWith(options: CacheWithOptions): CachedWithDecorator {
    return (
        target: any & PgCacheable,
        methodName: string | symbol,
        descriptor: TypedPropertyDescriptor<(...args: any[]) => any>,
    ): void => {
        const original: (...args: any[]) => any = descriptor.value as any;
        const className = typeof target === 'function'
            ? target.name
            : target.constructor.name;
        const ttl = options.ttl || defaultTtl;

        if (!target.pgCacheChannels) {
            target.pgCacheChannels = {};
        }

        const isFiltered = !Array.isArray(options.channels);
        const channels: string[] = isFiltered
            ? Object.keys(options.channels)
            : options.channels as string[];

        for (const channel of channels) {
            if (!target.pgCacheChannels[channel]) {
                target.pgCacheChannels[channel] = [];
            }

            target.pgCacheChannels[channel].push(isFiltered ? [
                String(methodName),
                (options.channels as FilteredChannels)[channel]
            ] : [String(methodName)]);
        }

        // tslint:disable-next-line:only-arrow-functions
        descriptor.value = async function<T>(...args: any[]): Promise<T> {
            const self = this || target;
            const cache: TagCache = self.taggedCache;
            const logger = (self.logger || console);

            if (!cache) {
                logger.warn(
                    `PgCache:cacheWith: cache is not initialized on ${
                        className
                    }, called in ${
                        String(methodName)
                    }`,
                );
                return original.apply(self, args);
            }

            try {
                const key = `${ className }:${ String(methodName) }:${
                    signature(className, methodName, args)
                }`;
                let result: any = await cache.get(key);

                // eslint-disable-next-line id-blacklist
                if (result === null || result === undefined) {
                    result = original.apply(self, args);

                    if (result && result.then) {
                        result = await result;
                    }

                    cache.set(
                        key,
                        result,
                        [`${ className }:${ String(methodName) }`],
                        ttl,
                    ).then((res: any) => {
                        if (!PG_CACHE_DEBUG) {
                            return res;
                        }

                        logger.info(
                            `PgCache:cacheWith: data saved to cache key ${
                                key
                            }`,
                        );

                        return res;
                    }).catch(err => logger.warn(
                        `PgCache:cacheWith: saving cache key '${
                            className }:${ String(methodName)
                        }' error:`,
                        err,
                    ));
                }

                return result;
            }

            catch (err) {
                // istanbul ignore next
                logger.warn(
                    `PgCache:cacheWith: fetching cache key '${
                        className}:${ String(methodName)
                    }' error:`,
                    err,
                );

                // istanbul ignore next
                return original.apply(self, args);
            }
        };
    };
}
