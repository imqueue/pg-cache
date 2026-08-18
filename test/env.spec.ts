/*!
 * I'm Queue Software Project
 * Copyright (C) 2026  imqueue.com <support@imqueue.com>
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
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
    awaitInvalidation,
    DEFAULT_CACHE_TTL,
    DEFAULT_INVALIDATION_TIMEOUT,
    envBool,
    fetchError,
    initError,
    setError,
    setInfo,
} from '../src/env.js';
import { cacheWith } from '../src/cacheWith.js';
import { cacheBy } from '../src/cacheBy.js';
import { PgCache } from '../src/PgCache.js';

const VAR = 'PG_CACHE_ENV_BOOL_TEST';

function fakeLogger() {
    const calls: { info: any[][]; warn: any[][] } = { info: [], warn: [] };

    return {
        calls,
        log: () => undefined,
        info: (...args: any[]) => calls.info.push(args),
        warn: (...args: any[]) => calls.warn.push(args),
        error: () => undefined,
    };
}

describe('env', () => {
    afterEach(() => {
        delete process.env[VAR];
    });

    describe('envBool()', () => {
        it('should accept truthy spellings case-insensitively', () => {
            for (const value of ['1', 'true', 'TRUE', 'Yes', 'on']) {
                process.env[VAR] = value;
                assert.equal(envBool(VAR), true, `value: ${value}`);
            }
        });

        it('should accept falsy spellings case-insensitively', () => {
            for (const value of ['0', 'false', 'No', 'off', '']) {
                process.env[VAR] = value;
                assert.equal(envBool(VAR, true), false, `value: ${value}`);
            }
        });

        it('should fall back to default when unset or unrecognized', () => {
            assert.equal(envBool(VAR), false);
            assert.equal(envBool(VAR, true), true);
            process.env[VAR] = 'whatever';
            assert.equal(envBool(VAR), false);
            assert.equal(envBool(VAR, true), true);
        });
    });

    it('should define default cache ttl of 24 hours', () => {
        assert.equal(DEFAULT_CACHE_TTL, 86400000);
    });

    describe('setInfo()', () => {
        it('should pass result through', () => {
            const logger = fakeLogger();
            const res = { a: 1 };

            assert.equal(setInfo(logger, res, 'key', cacheWith), res);
        });
    });

    it('should define default invalidation timeout of 30 seconds', () => {
        assert.equal(DEFAULT_INVALIDATION_TIMEOUT, 30000);
    });

    describe('awaitInvalidation()', () => {
        it('should report confirmation without reporting a timeout', async () => {
            let timedOut = false;
            const confirmed = await awaitInvalidation(
                Promise.resolve(),
                1000,
                () => (timedOut = true),
            );

            assert.equal(confirmed, true);
            assert.equal(timedOut, false);
        });

        it('should report a timeout when confirmation never comes', async () => {
            let timedOut = false;
            const confirmed = await awaitInvalidation(
                new Promise<void>(() => undefined),
                10,
                () => (timedOut = true),
            );

            assert.equal(confirmed, false);
            assert.equal(timedOut, true);
        });

        it('should wait for a slow confirmation rather than return early', async () => {
            const order: string[] = [];
            const ready = new Promise<void>(resolve =>
                setTimeout(() => {
                    order.push('confirmed');
                    resolve();
                }, 30),
            );

            const confirmed = await awaitInvalidation(ready, 1000, () =>
                order.push('timeout'),
            );

            order.push('returned');
            assert.equal(confirmed, true);
            assert.deepEqual(order, ['confirmed', 'returned']);
        });

        it('should not report a timeout after confirmation', async () => {
            let timedOut = false;

            assert.equal(
                await awaitInvalidation(
                    Promise.resolve(),
                    5,
                    () => (timedOut = true),
                ),
                true,
            );

            // the timer must have been cleared: nothing fires later
            await new Promise(resolve => setTimeout(resolve, 25));
            assert.equal(timedOut, false);
        });

        it('should fall back to the default timeout when non-positive', async () => {
            let timedOut = false;

            // a zero or negative timeout must not degrade to "do not wait":
            // confirmation still wins here, and no timeout is reported
            for (const timeout of [0, -1]) {
                assert.equal(
                    await awaitInvalidation(
                        Promise.resolve(),
                        timeout,
                        () => (timedOut = true),
                    ),
                    true,
                );
            }

            assert.equal(timedOut, false);
        });
    });

    describe('log helpers', () => {
        it('should warn with decorator and key context', () => {
            const logger = fakeLogger();

            setError(logger, new Error('x'), 'key', cacheWith);
            fetchError(logger, new Error('x'), 'key', cacheWith);
            initError(logger, 'Klass', 'method', cacheWith);

            assert.equal(logger.calls.warn.length, 3);
            assert.ok(
                logger.calls.warn.every(args =>
                    String(args[0]).includes('PgCache:'),
                ),
            );
        });
    });
});

describe('decorators', () => {
    it('should expose decorator factories', () => {
        assert.equal(typeof cacheWith, 'function');
        assert.equal(typeof cacheBy, 'function');
        assert.equal(typeof PgCache, 'function');
        assert.equal(typeof PgCache({} as any), 'function');
        assert.equal(typeof cacheWith({} as any), 'function');
    });
});
