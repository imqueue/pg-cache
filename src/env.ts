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
import { ILogger } from '@imqueue/core';
import { PgCacheable } from './PgCache';

export type ClassDecorator = <T extends new(...args: any[]) => {}>(
    constructor: T,
) => T & PgCacheable;

export type MethodDecorator = (
    target: any,
    methodName: string | symbol,
    descriptor: TypedPropertyDescriptor<(...args: any[]) => any>,
) => void;

export const DEFAULT_CACHE_TTL = 86400000; // 24 hrs in milliseconds
export const PG_CACHE_DEBUG = !!+(process.env.PG_CACHE_DEBUG || 0);

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

export function setInfo(
    logger: ILogger,
    res: any,
    key: string,
    decorator: Function,
): any {
    PG_CACHE_DEBUG && logger.info(
        `PgCache:${ decorator.name }: cache key '${ key }' saved!`,
    );

    return res;
}

export function setError(
    logger: ILogger,
    err: any,
    key: string,
    decorator: Function,
): void {
    logger.warn(
        `PgCache:${ decorator.name }: saving cache key '${ key }' error:`,
        err,
    );
}

export function fetchError(
    logger: ILogger,
    err: any,
    key: string,
    decorator: Function,
): void {
    logger.warn(
        `PgCache:${ decorator.name }: fetching cache key '${ key }' error:`,
        err,
    );
}

export function initError(
    logger: ILogger,
    className: string,
    methodName: string,
    decorator: Function,
): void {
    logger.warn(`PgCache:${ decorator.name }: cache is not initialized on ${
        className }, called in ${ methodName }`,
    );
}
