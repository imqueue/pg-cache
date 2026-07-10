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
import { Model } from 'sequelize-typescript';
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
import { signature } from './signature.js';
import { TagCache } from '@imqueue/tag-cache';

/**
 * Options expected by @cacheBy() decorator factory
 */
export interface CacheByOptions {
    /**
     * Time to live for cached values. If not specified - default is used.
     * Default is equivalent of 24 hours. Must be specified in milliseconds.
     *
     * @type {number | undefined}
     */
    ttl?: number;

    /**
     * Zero-index based position of fields argument in a method arguments,
     * which are passed at runtime. Fields argument are usually passed from
     * a client to specify a query map to be extracted and returned from
     * a service method. For example, fields map can be built from an
     * incoming GraphQL request using fieldsMap() function from
     * graphql-fields-list package.
     *
     * Usually pg-based @imqueue services, which utilize @imqueue/sequelize
     * package passing fields as a second argument to service methods,
     * so if this option is omitted, it will try to check for the second
     * passed argument. If you need to explicitly disable it, pass -1.
     *
     * @see https://github.com/Mikhus/graphql-fields-list
     *
     * @type {number}
     */
    fieldsArg?: number;
}

/**
 * Retrieves table names as channels from the given model and filter them by
 * a given fields map, if passed. Returns result as list of table names.
 *
 * @access private
 * @param {typeof Model} model
 * @param {any} [fields]
 * @param {string[]} [tables]
 * @return {string[]}
 */
export function channelsOf(
    model: typeof Model,
    fields?: any,
    tables: string[] = [],
): string[] {
    const modelRels = model.associations;
    const relsMap = fields ? fields : model.associations;
    const rels = Object.keys(relsMap);
    const table = model.tableName;

    tables.push(table);

    for (const field of rels) {
        if (!modelRels[field]) {
            continue;
        }

        const relation = modelRels[field] as any;
        const { target, options } = relation;
        const through = options && options.through && options.through.model;
        const subFields = (fields || {})[field];

        if (through && !~tables.indexOf(through.tableName)) {
            channelsOf(through, subFields, tables);
        }

        if (target && !~tables.indexOf(target.tableName)) {
            channelsOf(target, subFields, tables);
        }
    }

    return tables;
}

/**
 * Decorator factory @cacheBy(Model, CacheByOptions)
 * This decorator should be used on a service methods, to set the caching
 * rules for a method. Caching rules within this decorator are defined by a
 * passed model, which is treated as a root model of the call and it analyzes
 * cache invalidation based on passed runtime fields arguments, which
 * prevents unnecessary cache invalidations. So it is more intellectual way
 * to invalidate cache instead of any changes on described list of tables.
 */
export function cacheBy(
    model: typeof Model,
    options?: CacheByOptions,
): MethodDecorator {
    const opts = options || ({} as CacheByOptions);
    const ttl = opts.ttl || DEFAULT_CACHE_TTL;
    const channels: string[] = channelsOf(model);

    // registers this method's channel entries on the declaring prototype
    const register = (proto: any, methodName: string): void =>
        registerChannelsOnce(proto, methodName, pgCacheChannels => {
            for (const channel of channels) {
                const pgChannel = (pgCacheChannels[channel] =
                    pgCacheChannels[channel] || []);

                pgChannel.push([methodName]);
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
                initError(logger, className, methodName, cacheBy);

                return original.apply(self, args);
            }

            const fields = args[opts.fieldsArg as number];
            const key = signature(className, methodName, args);

            try {
                let result: any = await cache.get(key);

                if (result === null || result === undefined) {
                    result = original.apply(self, args);

                    if (result && result.then) {
                        result = await result;
                    }

                    const tags = channelsOf(model, fields).map(table =>
                        signature(className, methodName, [table]),
                    );

                    cache
                        .set(key, result, tags, ttl)
                        .then(res => setInfo(logger, res, key, cacheBy))
                        .catch(err => setError(logger, err, key, cacheBy));
                }

                return result;
            } catch (err) {
                fetchError(logger, err, key, cacheBy);

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
