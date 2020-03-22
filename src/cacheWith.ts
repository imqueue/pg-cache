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
import { FilteredChannels, PgCacheable, PgCacheChannel } from './PgCache';
import {
    MethodDecorator,
    DEFAULT_CACHE_TTL,
    fetchError,
    initError,
    setError,
    setInfo,
} from './env';

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

    /**
     * Tag to use for this cache when set a value
     *
     * @type {string}
     */
    tag?: string;
}

/**
 * Makes channel entry from a given channel name, class method name and options.
 *
 * @access private
 * @param {string} name
 * @param {string} method
 * @param {CacheWithOptions} options
 * @return {PgCacheChannel}
 */
export function makeChannel(
    name: string,
    method: string,
    options: CacheWithOptions,
): PgCacheChannel {
    return [method, !Array.isArray(options.channels)
        ? (options.channels)[name]
        : undefined,
    ] as PgCacheChannel;
}

/**
 * Decorator factory @cacheWith(CacheWithOptions)
 * This decorator should be used on a service methods, to set the caching
 * rules for a method.
 *
 * @param {CacheWithOptions} options
 * @return {MethodDecorator}
 */
export function cacheWith(options: CacheWithOptions): MethodDecorator {
    return (
        target: any & PgCacheable,
        methodName: string | symbol,
        descriptor: TypedPropertyDescriptor<(...args: any[]) => any>,
    ): void => {
        const original: Function = descriptor.value as any;
        const className = typeof target === 'function'
            ? target.name
            : target.constructor.name;
        const ttl = options.ttl || DEFAULT_CACHE_TTL;
        const isFiltered = !Array.isArray(options.channels);
        const channels: string[] = isFiltered
            ? Object.keys(options.channels)
            : options.channels as string[];

        target.pgCacheChannels = target.pgCacheChannels || {};

        for (const channel of channels) {
            const pgChannel = target.pgCacheChannels[channel] =
                target.pgCacheChannels[channel] || [];

            pgChannel.push(makeChannel(channel, String(methodName), options));
        }

        descriptor.value = async function<T>(...args: any[]): Promise<T> {
            const self = this || target;
            const cache: TagCache = self.taggedCache;
            const logger = (self.logger || console);

            if (!cache) {
                initError(logger, className, String(methodName), cacheWith);

                return original.apply(self, args);
            }

            const key = signature(className, methodName, args);

            try {
                let result: any = await cache.get(key);

                if (result === null || result === undefined) {
                    result = original.apply(self, args);

                    if (result && result.then) {
                        result = await result;
                    }

                    const tags = [signature(className, methodName, [])];

                    cache.set(key, result, tags, ttl)
                        .then(res => setInfo(logger, res, key, cacheWith))
                        .catch(err => setError(logger, err, key, cacheWith));
                }

                return result;
            }

            catch (err) {
                fetchError(logger, err, key, cacheWith);

                return original.apply(self, args);
            }
        };
    };
}
