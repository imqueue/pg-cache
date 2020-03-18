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
import { PgPubSub } from '@imqueue/pg-pubsub';
import { PgCacheable } from './PgCache';

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
     * @type {string[]}
     */
    channels: string[];
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

        for (const channel of options.channels) {
            if (!target.pgCacheChannels[channel]) {
                target.pgCacheChannels[channel] = [];
            }

            target.pgCacheChannels[channel].push(String(methodName));
        }

        // tslint:disable-next-line:only-arrow-functions
        descriptor.value = async function<T>(...args: any[]): Promise<T> {
            const cache: TagCache = target.taggedCache;

            if (!cache) {
                return original.apply(target, args);
            }

            try {
                const key = `${ className }:${ String(methodName) }:${
                    signature(className, methodName, args)
                }`;
                let result: any = await cache.get(key);

                // eslint-disable-next-line id-blacklist
                if (result === null || result === undefined) {
                    result = original.apply(target, args);

                    if (result && result.then) {
                        result = await result;
                    }

                    cache.set(key, result, [
                        `${ className }:${ String(methodName) }`,
                    ], ttl).catch(err => (target.logger || console).warn(`${
                        className}:${
                        String(methodName)} cache save error:`,
                        err,
                    ));
                }

                return result;
            }

            catch (err) {
                // istanbul ignore next
                (target.logger || console).warn(`${
                    className}:${
                    String(methodName)} cache fetch error:`,
                    err,
                );

                // istanbul ignore next
                return original.apply(target, args);
            }
        };
    };
}
