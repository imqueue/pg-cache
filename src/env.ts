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