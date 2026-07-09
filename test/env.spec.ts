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
    DEFAULT_CACHE_TTL,
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
