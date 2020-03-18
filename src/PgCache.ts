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
import { Client } from 'pg';

export interface PgCacheOptions {
    prefix?: string;
    postgres: string;
    redis?: { host: string; port: number; };
    redisCache?: RedisCache;
}

export interface PgCacheable {
    taggedCache: TagCache;
    pubSub: PgPubSub;
    pgCacheChannels: PgChannels;
}

export interface PgChannels {
    [name: string]: string[];
}

export type PgCacheDecorator = <T extends new(...args: any[]) => {}>(
    constructor: T,
) => T & PgCacheable;

async function install(channels: string[], pg: Client): Promise<void> {
    try {
        await pg.query(`
            CREATE FUNCTION post_change_notify_trigger()
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
        `);

        await Promise.all(channels.map(channel => pg.query(`
            CREATE TRIGGER "post_change_notify"
                AFTER INSERT OR UPDATE OR DELETE
                ON "$1"
                FOR EACH ROW
            EXECUTE PROCEDURE post_change_notify_trigger();
        `, [channel])));
    } catch (err) {
        return ; // ignore
    }
}

// noinspection JSUnusedGlobalSymbols
export function PgCache(options: PgCacheOptions): PgCacheDecorator {
    return <T extends new(...args: any[]) => {}>(
        constructor: T,
    ): T & PgCacheable => {
        class CachedService {
            private taggedCache: TagCache;
            private pgCacheChannels: PgChannels;
            private pubSub: PgPubSub = new PgPubSub({
                connectionString: options.postgres,
            } as any);

            // noinspection JSUnusedGlobalSymbols
            public async start(...args: any[]): Promise<void> {
                const init = constructor.prototype.start;

                if (init && typeof init === 'function') {
                    await init.apply(this, args);
                }

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

                const channels = Object.keys(this.pgCacheChannels);
                const className = constructor.name;

                for (const channel of channels) {
                    this.pubSub.channels.on(channel, () => {
                        const methods = this.pgCacheChannels[channel] || [];

                        for (const method of methods) {
                            this.taggedCache.invalidate(
                                `${ className }:${ method }`,
                            );
                        }
                    });
                }

                this.pubSub.on('connect', async () => {
                    await install(
                        Object.keys(this.pgCacheChannels),
                        this.pubSub.pgClient,
                    );

                    await Promise.all(channels.map(async channel =>
                        await this.pubSub.listen(channel)),
                    );
                });

                await this.pubSub.connect();
            }
        }

        Object.assign(constructor.prototype, new CachedService());

        return constructor as unknown as T & PgCacheable;
    };
}
