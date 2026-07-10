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
import { signature } from './signature.js';
import { TagCache } from '@imqueue/tag-cache';
import { type FilteredChannels, type PgCacheChannel } from './PgCache.js';
import {
    type MethodDecorator,
    DEFAULT_CACHE_TTL,
    declaringPrototype,
    fetchError,
    initError,
    isStandardDecorator,
    registerChannelsOnce,
    setError,
    setInfo,
} from './env.js';

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
    return [
        method,
        !Array.isArray(options.channels) ? options.channels[name] : undefined,
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
    const ttl = options.ttl || DEFAULT_CACHE_TTL;
    const isFiltered = !Array.isArray(options.channels);
    const channels: string[] = isFiltered
        ? Object.keys(options.channels || {})
        : (options.channels as string[]);

    // registers this method's channel entries on the declaring prototype
    const register = (proto: any, methodName: string): void =>
        registerChannelsOnce(proto, methodName, pgCacheChannels => {
            for (const channel of channels) {
                const pgChannel = (pgCacheChannels[channel] =
                    pgCacheChannels[channel] || []);

                pgChannel.push(makeChannel(channel, methodName, options));
            }
        });

    // builds the caching wrapper; `getClassName` is resolved lazily so it
    // works in standard mode where the class is unknown at decoration time
    const wrap = (
        original: Function,
        methodName: string,
        getClassName: () => string,
        fallback?: any,
    ) =>
        async function <T>(this: any, ...args: any[]): Promise<T> {
            const self: any = this || fallback;
            const cache: TagCache = self.taggedCache;
            const logger = self.logger || console;
            const className = getClassName();

            if (!cache) {
                initError(logger, className, methodName, cacheWith);

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

                    cache
                        .set(key, result, tags, ttl)
                        .then(res => setInfo(logger, res, key, cacheWith))
                        .catch(err => setError(logger, err, key, cacheWith));
                }

                return result;
            } catch (err) {
                fetchError(logger, err, key, cacheWith);

                return original.apply(self, args);
            }
        };

    return (target: any, context: any, descriptor?: any): any => {
        if (isStandardDecorator(context)) {
            const methodName = String(context.name);
            let className = '';

            context.addInitializer(function (this: any): void {
                const proto = declaringPrototype(this, methodName);

                className = proto.constructor.name;
                register(proto, methodName);
            });

            return wrap(target as Function, methodName, () => className);
        }

        const methodName = String(context);
        const className =
            typeof target === 'function'
                ? target.name
                : target.constructor.name;

        register(target, methodName);
        descriptor.value = wrap(
            descriptor.value as Function,
            methodName,
            () => className,
            target,
        );

        return descriptor;
    };
}
