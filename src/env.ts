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
import { type PgCacheable } from './PgCache.js';

/**
 * Minimal logger interface accepted by this package. Structurally
 * compatible with the console object and with `@imqueue` loggers, so any of
 * them can be passed without depending on `@imqueue/core.`
 */
export interface ILogger {
    /** General-purpose message, equivalent to `console.log`. */
    log(...args: unknown[]): void;

    /**
     * Informational message. Used for cache hits, misses and trigger
     * installation, and only emitted when `PG_CACHE_DEBUG` is on.
     */
    info(...args: unknown[]): void;

    /**
     * Recoverable problem. Every swallowed cache error is reported at this
     * level, so a redis outage shows up here rather than as a thrown error.
     */
    warn(...args: unknown[]): void;

    /** Unrecoverable problem. */
    error(...args: unknown[]): void;
}

// The decorators in this package are dual-mode: they work both as standard
// (TC39, stage-3) decorators and as legacy (experimentalDecorators) ones,
// so they can be applied to @imqueue services compiled in either mode - the
// same way @imqueue/rpc and @imqueue/core decorators behave. A standard
// invocation passes a context object with a `kind` property, a legacy one
// passes (target, propertyKey, descriptor).

/**
 * A dual-mode class decorator: called as `(constructor)` by legacy
 * (`experimentalDecorators`) TypeScript and as `(value, context)` by standard
 * (TC39) decorators. In both forms the first argument is the class, and the
 * result is the class augmented with {@link PgCacheable}.
 *
 * Supporting both is what lets this package decorate `@imqueue` services compiled
 * in either mode, the same way `@imqueue/rpc` and `@imqueue/core` decorators do.
 */
export type ClassDecorator = <T extends new (...args: any[]) => {}>(
    constructor: T,
    context?: unknown,
) => T & PgCacheable;

/**
 * A dual-mode method decorator: called as `(target, propertyKey, descriptor)` by
 * legacy (`experimentalDecorators`) TypeScript and as `(value, context)` by
 * standard (TC39) decorators.
 *
 * Use {@link isStandardDecorator} on the second argument to tell the two apart.
 */
export type MethodDecorator = (
    target: any,
    context: any,
    descriptor?: TypedPropertyDescriptor<(...args: any[]) => any>,
) => any;

/**
 * Returns true if the decorator was invoked in standard (TC39) mode, i.e.
 * its second argument is a decorator context object carrying a `kind`.
 *
 * @param context - the decorator's second argument
 */
export function isStandardDecorator(context: unknown): boolean {
    return (
        !!context && typeof context === 'object' && 'kind' in (context as any)
    );
}

/**
 * Walks up from a constructed instance to the prototype that actually
 * declares the given method, mirroring legacy decoration where the decorator
 * target is the declaring prototype. Falls back to the instance's own
 * prototype.
 *
 * @param instance - `this` inside a standard decorator initializer
 * @param methodName - method to locate on the prototype chain
 * @returns the declaring prototype
 */
export function declaringPrototype(instance: any, methodName: string): any {
    let proto = instance.constructor.prototype;

    while (proto && !Object.prototype.hasOwnProperty.call(proto, methodName)) {
        proto = Object.getPrototypeOf(proto);
    }

    return proto || instance.constructor.prototype;
}

/**
 * Registers pg-cache channel entries for a method on the given prototype
 * exactly once, even when called from a per-construction initializer.
 *
 * @param proto - declaring prototype to attach channel metadata to
 * @param methodName - decorated method name (dedup key)
 * @param register - pushes entries
 */
export function registerChannelsOnce(
    proto: any,
    methodName: string,
    register: (channels: Record<string, unknown[]>) => void,
): void {
    const marker = `__pgCacheRegistered$${methodName}`;

    if (proto[marker]) {
        return;
    }

    Object.defineProperty(proto, marker, {
        value: true,
        enumerable: false,
        configurable: true,
    });

    proto.pgCacheChannels = proto.pgCacheChannels || {};
    register(proto.pgCacheChannels);
}

/**
 * Default lifetime of a cached entry, in milliseconds — 24 hours.
 *
 * A TTL is a backstop, not the primary invalidation mechanism: entries are
 * normally dropped by a PostgreSQL change notification long before it expires.
 * It exists so an entry cannot outlive its data indefinitely if a notification
 * is ever missed.
 */
export const DEFAULT_CACHE_TTL = 86400000; // 24 hrs in milliseconds
/**
 * Reads a boolean environment variable, accepting the human-friendly
 * spellings 1/true/yes/on and 0/false/no/off (case-insensitive). The
 * previous `!!+value` idiom parsed values like `true` as NaN, i.e. `false`.
 *
 * @param name - environment variable name
 * @param defaultValue - used when unset or unrecognized
 */
export function envBool(name: string, defaultValue = false): boolean {
    const value = process.env[name];

    if (typeof value !== 'string') {
        return defaultValue;
    }

    const normalized = value.trim().toLowerCase();

    if (['1', 'true', 'yes', 'on'].includes(normalized)) {
        return true;
    }

    if (['0', 'false', 'no', 'off', ''].includes(normalized)) {
        return false;
    }

    return defaultValue;
}

/**
 * Whether verbose cache tracing is on, read once from the `PG_CACHE_DEBUG`
 * environment variable at import time.
 *
 * When enabled, cache saves, fetches and trigger installation are logged at info
 * level. Warnings are logged regardless. Because it is read at import time,
 * changing the variable afterwards has no effect.
 *
 * @see {@link envBool} for the accepted spellings
 */
export const PG_CACHE_DEBUG = envBool('PG_CACHE_DEBUG');

/**
 * Default PL/pgSQL trigger function installed on every watched table.
 *
 * It builds a JSON payload of the changed row and issues `PG_NOTIFY` on a channel
 * named after the table. The payload shape is {@link ChannelPayload}: timestamp,
 * operation, schema, table and the row itself — `NEW` for inserts and updates,
 * `OLD` for deletes.
 *
 * Column values are read out of `information_schema` and cast to TEXT, so every
 * field arrives as a string regardless of its SQL type.
 *
 * Note PostgreSQL caps a NOTIFY payload at 8000 bytes; a change to a very wide
 * row can exceed that and the notification will be rejected. Override with
 * `PgCacheOptions.triggerDefinition` if the default does not suit — see
 * {@link PgCacheOptions}.
 */
export const PG_CACHE_TRIGGER = `CREATE FUNCTION post_change_notify_trigger()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    rec RECORD;
    payload TEXT;
    payload_items TEXT[];
    column_names TEXT[];
    column_name TEXT;
    column_value TEXT;
    channel CHARACTER VARYING(255);
BEGIN
    channel := TG_TABLE_NAME;

    CASE TG_OP
        WHEN 'INSERT', 'UPDATE' THEN rec := NEW;
        WHEN 'DELETE' THEN rec := OLD;
        ELSE RAISE EXCEPTION 'NOTIFY: Invalid operation "%"!',
            TG_OP;
    END CASE;

    SELECT array_agg("c"."column_name"::TEXT)
    INTO column_names
    FROM "information_schema"."columns" AS "c"
    WHERE "c"."table_name" = TG_TABLE_NAME;

    FOREACH column_name IN ARRAY column_names
    LOOP
        EXECUTE FORMAT('SELECT $1.%I::TEXT', column_name)
            INTO column_value
            USING rec;

        payload_items := ARRAY_CAT(
            payload_items,
            ARRAY [column_name, column_value]
        );
    END LOOP;

    payload := json_build_object(
        'timestamp', CURRENT_TIMESTAMP,
        'operation', TG_OP,
        'schema', TG_TABLE_SCHEMA,
        'table', TG_TABLE_NAME,
        'record', TO_JSON(JSON_OBJECT(payload_items))
    );

    PERFORM PG_NOTIFY(channel, payload);

    RETURN rec;
END;
$$;
`;

/**
 * Reports a successful cache write and passes the value straight through, so it
 * can be used inline in a return position. Logs only when
 * {@link PG_CACHE_DEBUG} is on.
 *
 * @param logger - logger to report through
 * @param res - value that was cached; returned unchanged
 * @param key - redis key it was stored under
 * @param decorator - decorator that performed the write, named in the message
 * @returns `res`, unchanged
 */
export function setInfo(
    logger: ILogger,
    res: any,
    key: string,
    decorator: Function,
): any {
    if (PG_CACHE_DEBUG) {
        logger.info(`PgCache:${decorator.name}: cache key '${key}' saved!`);
    }

    return res;
}

/**
 * Reports a failed cache write at warning level. Always logs: a write failure
 * matters even when tracing is off.
 *
 * @param logger - logger to report through
 * @param err - error redis raised
 * @param key - redis key the write targeted
 * @param decorator - decorator that attempted the write
 */
export function setError(
    logger: ILogger,
    err: any,
    key: string,
    decorator: Function,
): void {
    logger.warn(
        `PgCache:${decorator.name}: saving cache key '${key}' error:`,
        err,
    );
}

/**
 * Reports a failed cache read at warning level. The caller then falls through to
 * the real method, so a read failure costs latency rather than correctness.
 *
 * @param logger - logger to report through
 * @param err - error redis raised
 * @param key - redis key the read targeted
 * @param decorator - decorator that attempted the read
 */
export function fetchError(
    logger: ILogger,
    err: any,
    key: string,
    decorator: Function,
): void {
    logger.warn(
        `PgCache:${decorator.name}: fetching cache key '${key}' error:`,
        err,
    );
}

/**
 * Reports that a cached method ran before the cache existed — the service was
 * decorated but `start()` has not completed, so there is nothing to read or
 * write. The method still executes; it is simply not cached.
 *
 * @param logger - logger to report through
 * @param className - service class whose cache is missing
 * @param methodName - cached method that was called too early
 * @param decorator - decorator that found the cache absent
 */
export function initError(
    logger: ILogger,
    className: string,
    methodName: string,
    decorator: Function,
): void {
    logger.warn(
        `PgCache:${decorator.name}: cache is not initialized on ${
            className
        }, called in ${methodName}`,
    );
}
